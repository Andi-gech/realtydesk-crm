import { useState } from 'react';
import { api } from '../api/client';
import { saveAuthTokens } from '../lib/secureStorage';
import BrandMark from '../components/BrandMark';

type Props = { onLoggedIn: (role: 'agent' | 'owner') => void };

/**
 * Single entry screen for both roles:
 * - Sub-User / Agent: signs in with username and password created by the owner.
 * - Owner / Broker Admin: signs in with owner email and password.
 */
export default function Login({ onLoggedIn }: Props) {
  const [mode, setMode] = useState<'agent' | 'owner'>('agent');
  const [agentUsername, setAgentUsername] = useState('');
  const [agentPassword, setAgentPassword] = useState('');
  const [useCodeMode, setUseCodeMode] = useState(false);
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submitAgent(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (useCodeMode) {
        const { accessToken, refreshToken } = await api.redeemActivationCode(code.trim(), displayName.trim());
        await saveAuthTokens(accessToken, refreshToken);
        onLoggedIn('agent');
      } else {
        const { accessToken, refreshToken } = await api.agentLogin(agentUsername.trim(), agentPassword);
        await saveAuthTokens(accessToken, refreshToken);
        onLoggedIn('agent');
      }
    } catch (err: any) {
      setError(err.message || (useCodeMode ? 'Failed to redeem activation code' : 'Failed to sign in as agent'));
    } finally {
      setLoading(false);
    }
  }

  async function submitOwner(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { accessToken, refreshToken } = await api.ownerLogin(email.trim(), password.trim());
      await saveAuthTokens(accessToken, refreshToken);
      onLoggedIn('owner');
    } catch (err: any) {
      setError(err.message || 'Failed to sign in as owner');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen-wrapper">
      <section className="login-brand-panel">
        <div className="login-brand-lockup">
          <BrandMark size={26} className="brand-mark" />
          <span className="brand-name">RealtyDesk</span>
        </div>

        <p className="login-statement">
          <span>Every lead,</span>
          <span>one desk.</span>
        </p>

        <ul className="login-notes">
          <li>
            <span>Telegram connection</span>
            <strong>On this device only</strong>
          </li>
          <li>
            <span>Conversations</span>
            <strong>Shared with the team</strong>
          </li>
          <li>
            <span>Lead notes</span>
            <strong>Kept on file</strong>
          </li>
        </ul>
      </section>

      <section className="login-form-panel">
        <div className="login-card">
          <div className="login-brand">
            <h1>{mode === 'agent' ? 'Sign in' : 'Owner sign in'}</h1>
            <p className="subtitle">
              {mode === 'agent'
                ? 'Use the credentials your brokerage admin gave you.'
                : 'Use the email and password for this brokerage.'}
            </p>
          </div>

          <div className="tabs role-tabs">
            <button
              type="button"
              className={mode === 'agent' ? 'active' : ''}
              onClick={() => {
                setMode('agent');
                setError(null);
              }}
            >
              Sub-user / Agent
            </button>
            <button
              type="button"
              className={mode === 'owner' ? 'active' : ''}
              onClick={() => {
                setMode('owner');
                setError(null);
              }}
            >
              Owner / Admin
            </button>
          </div>

          {mode === 'agent' ? (
            <form onSubmit={submitAgent}>
              {!useCodeMode ? (
                <>
                  <label>
                    Username
                    <input
                      placeholder="e.g. sarah_agent"
                      value={agentUsername}
                      onChange={(e) => setAgentUsername(e.target.value)}
                      required
                      autoFocus
                    />
                  </label>
                  <label>
                    Password
                    <input
                      type="password"
                      placeholder="••••••••"
                      value={agentPassword}
                      onChange={(e) => setAgentPassword(e.target.value)}
                      required
                    />
                  </label>
                  <button type="submit" className="primary-btn" disabled={loading}>
                    {loading ? 'Signing in…' : 'Sign in'}
                  </button>
                  <p className="login-alt">
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        setUseCodeMode(true);
                        setError(null);
                      }}
                    >
                      Have an activation code?
                    </button>
                  </p>
                  <p className="form-hint">
                    Sub-user credentials are created by your brokerage admin in Organization admin.
                  </p>
                </>
              ) : (
                <>
                  <label>
                    Brokerage activation code
                    <input
                      placeholder="10-character code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      required
                      autoFocus
                    />
                  </label>
                  <label>
                    Your full name
                    <input
                      placeholder="e.g. Sarah Jenkins"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      required
                    />
                  </label>
                  <button type="submit" className="primary-btn" disabled={loading}>
                    {loading ? 'Validating code…' : 'Join with code'}
                  </button>
                  <p className="login-alt">
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => {
                        setUseCodeMode(false);
                        setError(null);
                      }}
                    >
                      Back to username and password
                    </button>
                  </p>
                </>
              )}
            </form>
          ) : (
            <form onSubmit={submitOwner}>
              <label>
                Owner / admin email
                <input
                  type="email"
                  placeholder="owner@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
              <button type="submit" className="primary-btn" disabled={loading}>
                {loading ? 'Authenticating…' : 'Sign in'}
              </button>
            </form>
          )}

          {error && <div className="error-box">{error}</div>}
        </div>
      </section>
    </div>
  );
}
