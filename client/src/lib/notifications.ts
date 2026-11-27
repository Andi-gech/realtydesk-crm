/**
 * Desktop push notifications for new incoming messages.
 *
 * Uses the Tauri notification plugin (OS-native toast). Degrades to a no-op
 * outside Tauri (browser/dev preview) and when permission is denied.
 */

import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  onAction,
} from '@tauri-apps/plugin-notification';

function log(msg: string) {
  if (!isTauri()) return;
  invoke('debug_log', { message: msg }).catch(() => {});
}

let permission: boolean | null = null;
let actionRegistered = false;
let lastNotificationChatId: string | null = null;

export function getLastNotificationChatId(): string | null {
  return lastNotificationChatId;
}

async function ensurePermission(): Promise<boolean> {
  if (!isTauri()) return false;
  if (permission !== null) return permission;
  try {
    let granted = await isPermissionGranted();
    log(`isPermissionGranted = ${granted}`);
    if (!granted) {
      const result = await requestPermission();
      log(`requestPermission = ${result}`);
      granted = result === 'granted';
    }
    permission = granted;
    log(`permission final = ${granted}`);
    return granted;
  } catch (err) {
    console.warn('[notifications] permission check failed:', err);
    log(`permission check threw: ${err}`);
    permission = false;
    return false;
  }
}

/** Register a click handler that focuses the app. Call once per Inbox mount. */
export async function registerNotificationClickHandler(
  onFocus: (chatId: string | null) => void
): Promise<() => void> {
  if (!isTauri() || actionRegistered) return () => {};
  actionRegistered = true;
  try {
    const unlisten = await onAction((event) => {
      try {
        const win = getCurrentWindow();
        win.show().catch(() => {});
        win.unminimize().catch(() => {});
        win.setFocus().catch(() => {});
      } catch {}
      const chatId =
        (event as any)?.notification?.extra?.chatId ??
        lastNotificationChatId ??
        null;
      onFocus(chatId);
    });
    return () => {
      try {
        unlisten?.unregister?.();
      } catch {}
      actionRegistered = false;
    };
  } catch (err) {
    console.warn('[notifications] onAction registration failed:', err);
    actionRegistered = false;
    return () => {};
  }
}

export async function notifyNewMessage(opts: {
  title: string;
  body: string;
  chatId?: string;
}): Promise<void> {
  if (!(await ensurePermission())) return;
  lastNotificationChatId = opts.chatId ?? null;
  try {
    await invoke('toast_show', { title: opts.title, body: opts.body });
    log(`toast_show OK: ${opts.title}`);
  } catch (err) {
    console.warn('[notifications] toast_show failed:', err);
    log(`toast_show FAILED: ${err}`);
    // Fallback to the plugin path so we never silently lose a notification.
    try {
      sendNotification({ title: opts.title, body: opts.body, group: 'realtydesk-messages' });
      log(`plugin fallback OK: ${opts.title}`);
    } catch (err2) {
      console.warn('[notifications] plugin fallback failed:', err2);
      log(`plugin fallback FAILED: ${err2}`);
    }
  }
}

/** Fires once per profile to confirm OS notification plumbing works. */
export async function sendTestNotification(): Promise<boolean> {
  if (!isTauri()) {
    log('sendTestNotification: not tauri');
    return false;
  }
  try {
    if (localStorage.getItem('rd_notify_tested') === '1') {
      log('sendTestNotification: already tested, skipping');
      return true;
    }
  } catch {}
  const ok = await ensurePermission();
  if (!ok) return false;
  try {
    await invoke('toast_show', { title: 'RealtyDesk', body: 'Notifications are working.' });
    try {
      localStorage.setItem('rd_notify_tested', '1');
    } catch {}
    log('test notification sent OK');
    return true;
  } catch (err) {
    console.warn('[notifications] test send failed:', err);
    log(`test notification FAILED: ${err}`);
    return false;
  }
}

/** Ignores the once-per-profile guard; use from devtools via window.__notifyTest(). */
export async function forceTestNotification(): Promise<boolean> {
  if (!isTauri()) return false;
  const ok = await ensurePermission();
  if (!ok) return false;
  try {
    await invoke('toast_show', { title: 'RealtyDesk', body: 'Notifications are working.' });
    return true;
  } catch (err) {
    console.warn('[notifications] test send failed:', err);
    log(`test notification FAILED: ${err}`);
    return false;
  }
}