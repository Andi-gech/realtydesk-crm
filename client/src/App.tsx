import { useState, useEffect } from 'react';
import Login from './screens/Login';
import AddTelegram from './screens/AddTelegram';
import Inbox from './screens/Inbox';
import OwnerAdmin from './screens/OwnerAdmin';
import { loadAuthTokens, clearAuthTokens } from './lib/secureStorage';
import { api, tryRefresh, registerAuthFailureHandler } from './api/client';
import { SettingsIcon } from './components/Icons';
import BrandMark from './components/BrandMark';
import { check as checkForUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { sendTestNotification, forceTestNotification } from './lib/notifications';
import { invoke } from '@tauri-apps/api/core';

type Role = 'agent' | 'owner';
type View = 'inbox' | 'add_telegram' | 'owner_admin';

/** The three real things boot does, in order. Nothing decorative. */
const BOOT_STAGES = ['Reading local keychain', 'Refreshing session', 'Loading workspace'];
const BOOT_PROGRESS = [0.16, 0.52, 0.86];

/**
 * Last known session shape. Lets a returning user land straight in the app
 * while the token refresh and account check finish in the background, instead
 * of staring at the splash for several seconds.
 */
const BOOT_CACHE_KEY = 'rd_boot_cache';

type BootCache = {
  role: Role;
  view: View;
  hasLinkedTelegram: boolean;
};

function readBootCache(): BootCache | null {
  try {
    const raw = localStorage.getItem(BOOT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.role === 'agent' || parsed.role === 'owner')) {
      return {
        role: parsed.role,
        view:
          parsed.view === 'add_telegram' || parsed.view === 'owner_admin'
            ? parsed.view
            : 'inbox',
        hasLinkedTelegram: Boolean(parsed.hasLinkedTelegram),
      };
    }
  } catch {}
  return null;
}

function writeBootCache(cache: BootCache): void {
  try {
    localStorage.setItem(BOOT_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function parseJwtPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const jsonPayload = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

export default function App() {
  const [role, setRole] = useState<Role | null>(null);
  const [currentView, setCurrentView] = useState<View>('inbox');
  const [hasLinkedTelegram, setHasLinkedTelegram] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [bootStage, setBootStage] = useState(0);
  const [bootStalled, setBootStalled] = useState(false);
  const [bootSeconds, setBootSeconds] = useState(0);
  const [pendingUpdate, setPendingUpdate] = useState<any>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('rd_theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  // Settings header action: verify OS notifications are reachable.
  const [notifyTest, setNotifyTest] = useState<
    'idle' | 'sending' | 'ok' | 'fail'
  >('idle');

  const runNotifyTest = async () => {
    if (notifyTest === 'sending') return;
    setNotifyTest('sending');
    const ok = await forceTestNotification();
    setNotifyTest(ok ? 'ok' : 'fail');
    window.setTimeout(() => setNotifyTest('idle'), 3000);
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('rd_theme', theme);
    } catch {}
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  // Remember the last known session shape so the next launch can paint the app
  // immediately instead of waiting on the network.
  useEffect(() => {
    if (!role) return;
    writeBootCache({ role, view: currentView, hasLinkedTelegram });
  }, [role, currentView, hasLinkedTelegram]);

  // Live elapsed counter on the splash so a slow start never looks frozen.
  useEffect(() => {
    if (!checkingAuth) return;
    setBootSeconds(0);
    const timer = setInterval(() => setBootSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [checkingAuth]);

  useEffect(() => {
    // Diagnostic: confirm the frontend reached App and can talk to Rust.
    invoke('debug_log', { message: 'App mounted' }).catch((e: unknown) => {
      console.error('[diag] App mounted log failed', e);
    });
    const t = setTimeout(() => {
      sendTestNotification().catch(() => {});
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  // Force logout if the server rejects our session (e.g. admin deleted the account).
  useEffect(() => {
    registerAuthFailureHandler(() => {
      clearAuthTokens().finally(() => {
        setRole(null);
        setHasLinkedTelegram(false);
        setCurrentView('inbox');
      });
    });
    return () => registerAuthFailureHandler(() => {});
  }, []);

  // Check for app updates (desktop only). Non-blocking; failures are silent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
        const update = await checkForUpdate();
        if (!cancelled && update) setPendingUpdate(update);
      } catch (err) {
        console.warn('[App] Update check failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-restore session on boot with reliable token refresh.
  // Fast path: if we have a token + cached role, render the app shell at once
  // and finish refresh/account checks in the background.
  useEffect(() => {
    let active = true;

    // Honest escape hatch if the keychain/network hangs — offer a way out.
    const stallTimer = setTimeout(() => {
      if (active) setBootStalled(true);
    }, 8000);

    // Safety watchdog: ensure splash never hangs indefinitely.
    const watchdog = setTimeout(() => {
      if (active) {
        console.warn('[App] Session restoration watchdog fired, proceeding to UI');
        setCheckingAuth(false);
      }
    }, 20000);

    async function initAuth() {
      let painted = false;
      try {
        const { accessToken: initialAccessToken, refreshToken } = await loadAuthTokens();
        let accessToken = initialAccessToken;
        if (active) setBootStage(1);

        const cached = readBootCache();
        const initialPayload = accessToken ? parseJwtPayload(accessToken) : null;

        // Paint immediately from the last known session. The token may still be
        // valid; if it is not, the background refresh or the auth-failure
        // handler signs the user out.
        if (active && cached && initialPayload && initialPayload.role) {
          setRole(initialPayload.role);
          setCurrentView(cached.view);
          setHasLinkedTelegram(cached.hasLinkedTelegram);
          setCheckingAuth(false);
          painted = true;
        }

        // Auto-refresh access token if expired or about to expire within 30s.
        if (refreshToken) {
          let isExpired = true;
          if (accessToken) {
            const p = parseJwtPayload(accessToken);
            if (p && p.exp && p.exp * 1000 > Date.now() + 30000) {
              isExpired = false;
            }
          }
          if (isExpired) {
            const ok = await tryRefresh();
            if (ok) {
              const tokens = await loadAuthTokens();
              accessToken = tokens.accessToken;
            }
          }
        }

        if (active) setBootStage(2);

        if (accessToken && active) {
          const payload = parseJwtPayload(accessToken);
          if (payload && payload.role) {
            setRole(payload.role);
            if (payload.role === 'owner') {
              // Owners start in the Inbox and can link an account from there.
              setCurrentView('inbox');
            } else {
              // Agent / Sub-user: check if they have connected accounts.
              try {
                const accountsRes = await api.myTelegramAccounts();
                if (active) {
                  if (accountsRes.telegramAccounts && accountsRes.telegramAccounts.length > 0) {
                    setHasLinkedTelegram(true);
                    setCurrentView('inbox');
                  } else if (!painted) {
                    setCurrentView('add_telegram');
                  }
                }
              } catch (err) {
                console.warn('[App] Accounts fetch non-fatal notice:', err);
                if (active && !painted) setCurrentView('inbox');
              }
            }
          }
        }
      } catch (err) {
        console.warn('[App] Session restoration failed:', err);
      } finally {
        clearTimeout(watchdog);
        clearTimeout(stallTimer);
        if (active && !painted) {
          setCheckingAuth(false);
        }
      }
    }

    initAuth();

    return () => {
      active = false;
      clearTimeout(watchdog);
      clearTimeout(stallTimer);
    };
  }, []);

  async function handleLogout() {
    // Keep Telegram sessions and synced chats intact across CRM sign-out;
    // sessions are only removed when explicitly disconnected in the profile drawer.
    await clearAuthTokens();
    setRole(null);
    setHasLinkedTelegram(false);
    setCurrentView('inbox');
  }

  function handleLoginSuccess(userRole: Role) {
    setRole(userRole);
    if (userRole === 'owner') {
      // Owners start in the Inbox and can link an account from there.
      setCurrentView('inbox');
      return;
    }

    // Agent / Sub-user: show Add Telegram if first time (0 accounts), else straight to inbox
    api
      .myTelegramAccounts()
      .then((res) => {
        if (res.telegramAccounts && res.telegramAccounts.length > 0) {
          setHasLinkedTelegram(true);
          setCurrentView('inbox');
        } else {
          setCurrentView('add_telegram');
        }
      })
      .catch(() => {
        setCurrentView('add_telegram');
      });
  }

  if (checkingAuth) {
    return (
      <div className="loading-screen" role="status" aria-live="polite">
        <BrandMark size={46} className="boot-mark" title="RealtyDesk" />
        <div className="boot-copy">
          <div className="boot-wordmark">RealtyDesk</div>
          <p className="boot-stage">{BOOT_STAGES[bootStage]}</p>
          {bootSeconds >= 2 && (
            <p className="boot-elapsed">Still connecting… {bootSeconds}s</p>
          )}
        </div>
        <div className="boot-progress" aria-hidden="true">
          <div
            className="boot-progress-fill"
            style={{ '--boot-progress': String(BOOT_PROGRESS[bootStage]) } as React.CSSProperties}
          />
        </div>
        {bootStalled && (
          <button
            onClick={() => {
              clearAuthTokens().finally(() => {
                setRole(null);
                setCheckingAuth(false);
              });
            }}
            className="boot-reset"
          >
            Taking longer than usual? Reset session
          </button>
        )}
      </div>
    );
  }

  if (!role) {
    return <Login onLoggedIn={handleLoginSuccess} />;
  }

  return (
    <div className="app-shell">
      {pendingUpdate && (
        <div className="update-banner" role="status">
          <span>
            Update <strong>{pendingUpdate.version}</strong> is available.
          </span>
          <button
            className="update-btn"
            disabled={installingUpdate}
            onClick={async () => {
              try {
                setInstallingUpdate(true);
                await pendingUpdate.downloadAndInstall();
                await relaunch();
              } catch (err) {
                console.error('[App] Update install failed:', err);
                setInstallingUpdate(false);
              }
            }}
          >
            {installingUpdate ? 'Installing…' : 'Update now'}
          </button>
          <button
            className="update-dismiss"
            disabled={installingUpdate}
            onClick={() => setPendingUpdate(null)}
            aria-label="Dismiss update"
          >
            Later
          </button>
        </div>
      )}
      <header className="app-header">
        <button
          type="button"
          className="brand"
          onClick={() => setCurrentView('inbox')}
          title={role === 'owner' ? 'RealtyDesk - Click to return to Inbox' : 'RealtyDesk'}
        >
          <BrandMark size={20} className="brand-mark" />
          <span className="brand-name">RealtyDesk</span>
        </button>
        <span className={`role-badge ${role}`}>{role === 'owner' ? 'Owner' : 'Agent'}</span>

        <nav className="header-nav">
          {role === 'owner' && (
            <button
              className={`nav-btn ${currentView === 'owner_admin' ? 'active' : ''}`}
              onClick={() => setCurrentView(currentView === 'owner_admin' ? 'inbox' : 'owner_admin')}
            >
              <SettingsIcon size={15} />
              <span>{currentView === 'owner_admin' ? 'Back to inbox' : 'Organization admin'}</span>
            </button>
          )}
        </nav>

        <div className="header-actions">
          <button
            type="button"
            className="logout-btn"
            onClick={runNotifyTest}
            disabled={notifyTest === 'sending'}
            title="Send a test push notification"
          >
            {notifyTest === 'sending'
              ? 'Testing\u2026'
              : notifyTest === 'ok'
                ? 'Notification sent'
                : notifyTest === 'fail'
                  ? 'Blocked \u2014 check Windows settings'
                  : 'Test notification'}
          </button>
          <button
            type="button"
            className="logout-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button className="logout-btn" onClick={handleLogout} title="Log out">
            Sign out
          </button>
        </div>
      </header>

      <main className="app-body">
        {currentView === 'add_telegram' && (
          <AddTelegram
            onLinked={() => {
              setHasLinkedTelegram(true);
              setCurrentView('inbox');
            }}
            onCancel={
              role === 'owner' || hasLinkedTelegram ? () => setCurrentView('inbox') : undefined
            }
          />
        )}

        {currentView === 'inbox' && (
          <Inbox role={role} onAddTelegram={() => setCurrentView('add_telegram')} />
        )}

        {currentView === 'owner_admin' && role === 'owner' && (
          <OwnerAdmin />
        )}
      </main>
    </div>
  );
}
