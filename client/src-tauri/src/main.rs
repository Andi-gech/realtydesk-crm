// RealtyDesk desktop shell.
//
// This process's only security-relevant job is to back the three
// `keyring_*` commands below with the real Windows Credential Manager
// (via the `keyring` crate), so that Telegram session strings and JWTs
// never touch a plain file or get sent to the server. See
// docs/BUILD_SPEC.md §2 and client/src/lib/secureStorage.ts, which is the
// only frontend module allowed to call these commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use keyring::Entry;
use rusqlite::{params, Connection};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    http::Response,
    ipc::Channel,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// When the user chooses "Quit" from the tray we allow the window to close.
/// A normal close (X) just hides the window so reopening is instant.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn keyring_set(service: String, account: String, secret: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

#[tauri::command]
fn keyring_get(service: String, account: String) -> Result<String, String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

#[tauri::command]
fn keyring_delete(service: String, account: String) -> Result<(), String> {
    let entry = Entry::new(&service, &account).map_err(|e| e.to_string())?;
    entry.delete_password().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Local-first SQLite cache (WAL + FTS5)
//
// This database lives only on the user's machine. MongoDB on the server stays
// the source of truth; SQLite is a read cache so the inbox and message threads
// can paint instantly and search locally without waiting for the network.
// ---------------------------------------------------------------------------

struct DbState {
    conn: Mutex<Connection>,
    has_fts: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatCacheRow {
    key: String,
    account_id: Option<String>,
    name: String,
    preview: String,
    username: String,
    phone: String,
    payload: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageCacheRow {
    chat_key: String,
    msg_id: String,
    sent_at: i64,
    text: String,
    payload: String,
}

const SCHEMA_SQL: &str = "PRAGMA journal_mode=WAL;
     PRAGMA synchronous=NORMAL;
     PRAGMA temp_store=MEMORY;
     PRAGMA busy_timeout=5000;
     CREATE TABLE IF NOT EXISTS chats (
         key TEXT PRIMARY KEY,
         account_id TEXT,
         name TEXT NOT NULL,
         preview TEXT NOT NULL,
         username TEXT NOT NULL,
         phone TEXT NOT NULL,
         payload TEXT NOT NULL,
         updated_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);
     CREATE TABLE IF NOT EXISTS messages (
         chat_key TEXT NOT NULL,
         msg_id TEXT NOT NULL,
         sent_at INTEGER NOT NULL,
         text TEXT NOT NULL,
         payload TEXT NOT NULL,
         PRIMARY KEY (chat_key, msg_id)
     );
     CREATE INDEX IF NOT EXISTS idx_messages_chat_sent ON messages(chat_key, sent_at DESC);
     CREATE TABLE IF NOT EXISTS kv (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
     );";

const FTS_SQL: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
         key UNINDEXED,
         name,
         preview,
         username,
         phone,
         tokenize='unicode61'
     );
     CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
         chat_key UNINDEXED,
         msg_id UNINDEXED,
         text,
         tokenize='unicode61'
     );";

fn open_local_db(app: &tauri::App) -> Result<DbState, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("realtydesk.db"))?;

    conn.execute_batch(SCHEMA_SQL)?;

    // FTS5 is optional: if the bundled SQLite was built without it, the app
    // still works (local search just falls back to the in-memory list).
    let has_fts = conn.execute_batch(FTS_SQL).is_ok();

    Ok(DbState {
        conn: Mutex::new(conn),
        has_fts,
    })
}

/// Convert a user query into a safe FTS5 prefix query, or `None` if empty.
fn fts_query(raw: &str) -> Option<String> {
    let terms: Vec<String> = raw
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric() && c != '@' && c != '_' && c != '-'))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "")))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" AND "))
    }
}

#[tauri::command]
fn cache_chats_replace(
    state: tauri::State<'_, DbState>,
    rows: Vec<ChatCacheRow>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    {
        let mut insert = tx
            .prepare(
                "INSERT OR REPLACE INTO chats
                 (key, account_id, name, preview, username, phone, payload, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| e.to_string())?;
        let mut fts_delete = if state.has_fts {
            Some(
                tx.prepare("DELETE FROM chats_fts WHERE key = ?1")
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        let mut fts_insert = if state.has_fts {
            Some(
                tx.prepare(
                    "INSERT INTO chats_fts (key, name, preview, username, phone)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };

        for (idx, row) in rows.into_iter().enumerate() {
            // `updated_at` doubles as the list sort key. Subtracting the index
            // preserves the caller's ordering (newest chat first) on load.
            let sort_key = now - idx as i64;
            insert
                .execute(params![
                    row.key,
                    row.account_id,
                    row.name,
                    row.preview,
                    row.username,
                    row.phone,
                    row.payload,
                    sort_key
                ])
                .map_err(|e| e.to_string())?;
            if let (Some(del), Some(ins)) = (fts_delete.as_mut(), fts_insert.as_mut()) {
                del.execute(params![row.key]).map_err(|e| e.to_string())?;
                ins.execute(params![row.key, row.name, row.preview, row.username, row.phone])
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn cache_chats_load(
    state: tauri::State<'_, DbState>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT payload FROM chats ORDER BY updated_at DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit.unwrap_or(500) as i64], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn cache_chats_search(
    state: tauri::State<'_, DbState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let Some(match_query) = fts_query(&query) else {
        return Ok(Vec::new());
    };
    if !state.has_fts {
        return Ok(Vec::new());
    }
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT key FROM (
                 SELECT key FROM chats_fts WHERE chats_fts MATCH ?1
                 UNION
                 SELECT chat_key AS key FROM messages_fts WHERE messages_fts MATCH ?1
             ) LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_query, limit.unwrap_or(200) as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn cache_messages_put(
    state: tauri::State<'_, DbState>,
    rows: Vec<MessageCacheRow>,
    replace_all: bool,
) -> Result<(), String> {
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    if replace_all {
        if let Some(first) = rows.first() {
            tx.execute("DELETE FROM messages WHERE chat_key = ?1", params![first.chat_key])
                .map_err(|e| e.to_string())?;
            if state.has_fts {
                tx.execute(
                    "DELETE FROM messages_fts WHERE chat_key = ?1",
                    params![first.chat_key],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    {
        let mut insert = tx
            .prepare(
                "INSERT OR REPLACE INTO messages (chat_key, msg_id, sent_at, text, payload)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| e.to_string())?;
        let mut fts_delete = if state.has_fts {
            Some(
                tx.prepare("DELETE FROM messages_fts WHERE chat_key = ?1 AND msg_id = ?2")
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };
        let mut fts_insert = if state.has_fts {
            Some(
                tx.prepare(
                    "INSERT INTO messages_fts (chat_key, msg_id, text) VALUES (?1, ?2, ?3)",
                )
                .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };

        for row in rows {
            insert
                .execute(params![
                    row.chat_key,
                    row.msg_id,
                    row.sent_at,
                    row.text,
                    row.payload
                ])
                .map_err(|e| e.to_string())?;
            if let (Some(del), Some(ins)) = (fts_delete.as_mut(), fts_insert.as_mut()) {
                del.execute(params![row.chat_key, row.msg_id])
                    .map_err(|e| e.to_string())?;
                ins.execute(params![row.chat_key, row.msg_id, row.text])
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn cache_messages_load(
    state: tauri::State<'_, DbState>,
    chat_key: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT payload FROM (
                 SELECT payload, sent_at FROM messages
                 WHERE chat_key = ?1
                 ORDER BY sent_at DESC
                 LIMIT ?2
             ) ORDER BY sent_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![chat_key, limit.unwrap_or(200) as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn cache_clear(state: tauri::State<'_, DbState>) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut sql = String::from(
        "DELETE FROM chats;
         DELETE FROM messages;
         DELETE FROM kv;",
    );
    if state.has_fts {
        sql.push_str("DELETE FROM chats_fts; DELETE FROM messages_fts;");
    }
    sql.push_str("VACUUM;");
    conn.execute_batch(&sql).map_err(|e| e.to_string())
}

// Media disk cache + custom media protocol support.
fn guess_mime(file_name: &str) -> &'static str {
    let lower = file_name.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    }
}

#[tauri::command]
fn debug_log(app: tauri::AppHandle, message: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("debug.log"))
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    writeln!(f, "[{}] {}", ts, message).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
fn toast_show(title: String, body: String) -> Result<(), String> {
    let app_id = "com.realtydesk.crm";
    let toast = tauri_winrt_notification::Toast::new(app_id)
        .title(&title)
        .text1(&body);
    toast.show().map_err(|e| format!("{e:?}"))
}

#[cfg(not(windows))]
#[tauri::command]
fn toast_show(_title: String, _body: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn media_store(app: tauri::AppHandle, key: String, data: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let media_dir = dir.join("media");
    std::fs::create_dir_all(&media_dir).map_err(|e| e.to_string())?;

    let (mime, b64) = if data.starts_with("data:") {
        let comma = data.find(',').ok_or_else(|| "invalid data url".to_string())?;
        let header = &data[..comma];
        let mime = header
            .split(';')
            .next()
            .unwrap_or("data:image/jpeg")
            .trim_start_matches("data:");
        (&data[comma + 1..], mime)
    } else {
        (data.as_str(), "image/jpeg")
    };

    let bytes = STANDARD.decode(b64.trim()).map_err(|e| e.to_string())?;

    let safe_key: String = key
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe_key.is_empty() {
        return Err("empty media key".to_string());
    }
    let ext = match mime {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "jpg",
    };
    let file_name = format!("{}.{}", safe_key, ext);
    let file_path = media_dir.join(&file_name);
    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
    Ok(file_name)
}

// Channel streaming for large cached payloads.
#[tauri::command]
fn cache_chats_load_stream(
    state: tauri::State<'_, DbState>,
    channel: Channel<String>,
    limit: Option<usize>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT payload FROM chats ORDER BY updated_at DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit.unwrap_or(400) as i64], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let payload = row.map_err(|e| e.to_string())?;
        let _ = channel.send(payload);
    }
    Ok(())
}

#[tauri::command]
fn cache_messages_load_stream(
    state: tauri::State<'_, DbState>,
    channel: Channel<String>,
    chat_key: String,
    limit: Option<usize>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT payload FROM (
                 SELECT payload, sent_at FROM messages
                 WHERE chat_key = ?1
                 ORDER BY sent_at DESC
                 LIMIT ?2
             ) ORDER BY sent_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![chat_key, limit.unwrap_or(400) as i64], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let payload = row.map_err(|e| e.to_string())?;
        let _ = channel.send(payload);
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // In-app updater + process (relaunch) plugins. Desktop only.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle().plugin(tauri_plugin_notification::init())?;
            }

            // Local-first cache: SQLite in WAL mode on this device only.
            // A cache failure must never stop the app from starting.
            match open_local_db(app) {
                Ok(db) => {
                    app.manage(db);
                }
                Err(err) => {
                    eprintln!("[localDb] disabled: {err}");
                }
            }
            // Diagnostic: confirm the Rust shell started.
            let _ = debug_log(app.handle().clone(), "Rust shell started".to_string());

            // System tray: closing the window hides it instead of quitting, so
            // reopening from the tray is instant and the Telegram sockets keep
            // their warm state.
            let show_item = MenuItem::with_id(app, "show", "Show RealtyDesk", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let mut tray = TrayIconBuilder::new()
                .tooltip("RealtyDesk")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            Ok(())
        })
        // Diagnostic: confirm the webview actually loaded the frontend bundle.
        .on_page_load(|webview, payload| {
            let handle = webview.app_handle().clone();
            let _ = debug_log(handle, format!("page loaded: {}", payload.url()));
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            keyring_set,
            keyring_get,
            keyring_delete,
            cache_chats_replace,
            cache_chats_load,
            cache_chats_load_stream,
            cache_chats_search,
            cache_messages_put,
            cache_messages_load,
            cache_messages_load_stream,
            cache_clear,
            media_store,
            debug_log,
            toast_show
        ])
        .register_uri_scheme_protocol("media", |ctx, request| {
            let app = ctx.app_handle();
            let media_dir = match app.path().app_data_dir() {
                Ok(d) => d.join("media"),
                Err(_) => {
                    return Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .unwrap();
                }
            };
            let path = request.uri().path();
            let file_name = path.trim_start_matches('/').rsplit('/').next().unwrap_or("");
            let safe: String = file_name
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
                .collect();
            if safe.is_empty() {
                return Response::builder()
                    .status(400)
                    .body(Vec::new())
                    .unwrap();
            }
            let file_path = media_dir.join(&safe);
            match std::fs::read(&file_path) {
                Ok(bytes) => Response::builder()
                    .header("Content-Type", guess_mime(&safe))
                    .header("Cache-Control", "public, max-age=31536000, immutable")
                    .body(bytes)
                    .unwrap(),
                Err(_) => Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running RealtyDesk");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(SCHEMA_SQL).expect("create schema");
        conn.execute_batch(FTS_SQL).expect("create fts tables");
        conn
    }

    #[test]
    fn fts5_is_available_in_bundled_sqlite() {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        let result = conn.execute_batch(FTS_SQL);
        assert!(result.is_ok(), "FTS5 unavailable: {result:?}");
    }

    #[test]
    fn fts_query_sanitizes_terms() {
        assert_eq!(fts_query("   "), None);
        assert_eq!(
            fts_query("hi there"),
            Some("\"hi\"* AND \"there\"*".to_string())
        );
        // Quotes cannot break the generated FTS5 syntax.
        assert_eq!(
            fts_query("foo \"bar\""),
            Some("\"foo\"* AND \"bar\"*".to_string())
        );
    }

    #[test]
    fn fts_search_unions_chat_and_message_matches() {
        let conn = memory_db();
        conn.execute(
            "INSERT INTO chats_fts (key, name, preview, username, phone)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params!["acc:1", "John Smith", "looking for a villa", "john", ""],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages_fts (chat_key, msg_id, text) VALUES (?1, ?2, ?3)",
            params!["acc:2", "9", "my budget is 500k"],
        )
        .unwrap();

        let search = |raw: &str| -> Vec<String> {
            let q = fts_query(raw).expect("query");
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT key FROM (
                         SELECT key FROM chats_fts WHERE chats_fts MATCH ?1
                         UNION
                         SELECT chat_key AS key FROM messages_fts WHERE messages_fts MATCH ?1
                     ) LIMIT ?2",
                )
                .unwrap();
            let rows = stmt
                .query_map(params![q, 20], |row| row.get::<_, String>(0))
                .unwrap();
            rows.map(|r| r.unwrap()).collect()
        };

        assert_eq!(search("villa"), vec!["acc:1".to_string()]);
        assert_eq!(search("budget"), vec!["acc:2".to_string()]);
        assert!(search("nothing-matches").is_empty());
    }
}
