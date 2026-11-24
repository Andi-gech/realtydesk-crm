import { useState, useEffect } from 'react';
import Login from './screens/Login';
import AddTelegram from './screens/AddTelegram';
import Inbox from './screens/Inbox';
import OwnerAdmin from './screens/OwnerAdmin';
import { loadAuthTokens, clearAuthTokens, deleteSession } from './lib/secureStorage';
import { api, tryRefresh } from './api/client';
import { SettingsIcon } from './components/Icons';

type Role = 'agent' | 'owner';
type View = 'inbox' | 'add_telegram' | 'owner_admin';

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

  // Auto-restore session on boot with reliable token refresh
  useEffect(() => {
    let active = true;

    // Safety watchdog: ensure splash never hangs indefinitely
    const watchdog = setTimeout(() => {
      if (active) {
        console.warn('[App] Session restoration watchdog fired, proceeding to UI');
        setCheckingAuth(false);
      }
    }, 6000);

    async function initAuth() {
      try {
        const { accessToken: initialAccessToken, refreshToken } = await loadAuthTokens();
        let accessToken = initialAccessToken;

        // Auto-refresh access token if expired or about to expire within 30s
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

        if (accessToken && active) {
          const payload = parseJwtPayload(accessToken);
          if (payload && payload.role) {
            setRole(payload.role);
            if (payload.role === 'owner') {
              // Owners start in the Inbox and can link an account from there.
              setCurrentView('inbox');
            } else {
              // Agent / Sub-user: check if they have connected accounts
              try {
                const accountsRes = await api.myTelegramAccounts();
                if (active) {
                  if (accountsRes.telegramAccounts && accountsRes.telegramAccounts.length > 0) {
                    setHasLinkedTelegram(true);
                    setCurrentView('inbox');
                  } else {
                    setCurrentView('add_telegram');
                  }
                }
              } catch (err) {
                console.warn('[App] Accounts fetch non-fatal notice:', err);
                if (active) setCurrentView('inbox');
              }
            }
          }
        }
      } catch (err) {
        console.warn('[App] Session restoration failed:', err);
      } finally {
        clearTimeout(watchdog);
        if (active) {
          setCheckingAuth(false);
        }
      }
    }

    initAuth();

    return () => {
      active = false;
      clearTimeout(watchdog);
    };
  }, []);

  async function handleLogout() {
    // Drop local MTProto sessions so the disconnected accounts are gone.
    try {
      const { telegramAccounts } = await api.myTelegramAccounts();
      await Promise.all((telegramAccounts || []).map((a: any) => deleteSession(a._id)));
    } catch {
      // Not signed in / no accounts — nothing to clean.
    }
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
      <div className="loading-screen">
        <div className="spinner"></div>
        <p>Initializing RealtyDesk…</p>
        <button
          onClick={() => {
            clearAuthTokens().finally(() => {
              setRole(null);
              setCheckingAuth(false);
            });
          }}
          className="reset-session-btn"
        >
          Taking longer than usual? Click to reset session
        </button>
      </div>
    );
  }

  if (!role) {
    return <Login onLoggedIn={handleLoginSuccess} />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div
          className="brand"
          onClick={() => setCurrentView('inbox')}
          style={{ cursor: role === 'owner' ? 'pointer' : 'default' }}
          title={role === 'owner' ? 'RealtyDesk - Click to return to Inbox' : 'RealtyDesk'}
        >
          <span className="brand-icon">🏢</span>
          <span className="brand-name">RealtyDesk</span>
          <span className={`role-badge ${role}`}>{role === 'owner' ? 'Owner Mode' : 'Agent Mode'}</span>
        </div>

        <nav className="header-nav">
          {role === 'owner' && (
            <button
              className={`nav-btn ${currentView === 'owner_admin' ? 'active' : ''}`}
              onClick={() => setCurrentView(currentView === 'owner_admin' ? 'inbox' : 'owner_admin')}
            >
              <SettingsIcon size={16} />
              <span>{currentView === 'owner_admin' ? '← Back to Chats' : 'Organization Admin'}</span>
            </button>
          )}
        </nav>

        <div className="header-actions">
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
