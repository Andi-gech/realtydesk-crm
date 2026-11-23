import { useState } from 'react';
import { api } from '../api/client';
import { saveAuthTokens } from '../lib/secureStorage';

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
      const { accessToken, refreshToken } = await api.ownerLogin(email.trim(), password);
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
      <div className="card login-card">
        <div className="login-brand">
          <div className="brand-logo">🏢</div>
          <h1>RealtyDesk CRM</h1>
          <p className="subtitle">Real Estate Team Communications on Telegram</p>
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
            Sub-User / Agent
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
                  {loading ? 'Signing in…' : 'Sign in as Sub-User'}
                </button>
                <div style={{ marginTop: '0.8rem', textAlign: 'center', fontSize: '0.82rem' }}>
                  <button
                    type="button"
                    className="text-btn"
                    style={{ color: 'var(--primary, #3b82f6)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}
                    onClick={() => {
                      setUseCodeMode(true);
                      setError(null);
                    }}
                  >
                    Have an activation code instead? Click here
                  </button>
                </div>
                <p className="form-hint" style={{ marginTop: '0.5rem' }}>
                  Sub-user credentials are created by your Brokerage Admin in the Owner dashboard.
                </p>
              </>
            ) : (
              <>
                <label>
                  Brokerage Activation Code
                  <input
                    placeholder="Enter 10-character code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  Your Full Name
                  <input
                    placeholder="e.g. Sarah Jenkins"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                  />
                </label>
                <button type="submit" className="primary-btn" disabled={loading}>
                  {loading ? 'Validating Code…' : 'Join with Code'}
                </button>
                <div style={{ marginTop: '0.8rem', textAlign: 'center', fontSize: '0.82rem' }}>
                  <button
                    type="button"
                    className="text-btn"
                    style={{ color: 'var(--primary, #3b82f6)', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}
                    onClick={() => {
                      setUseCodeMode(false);
                      setError(null);
                    }}
                  >
                    ← Back to Username & Password
                  </button>
                </div>
              </>
            )}
          </form>
        ) : (
          <form onSubmit={submitOwner}>
            <label>
              Owner / Admin Email
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
              {loading ? 'Authenticating…' : 'Sign in as Owner / Admin'}
            </button>
          </form>
        )}

        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}
