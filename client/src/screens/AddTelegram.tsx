import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  requestTelegramPhoneCode,
  submitTelegramCode,
  submitTelegram2FAPassword,
  startTelegramQrLogin,
  isTelegramConfigured,
  normalizePhoneNumber,
  LogEntry,
} from '../lib/telegram';
import { TelegramClient } from 'telegram';
import { syncAccountChats } from '../lib/telegramSync';
import { saveSession } from '../lib/secureStorage';
import { api } from '../api/client';

type Props = {
  onLinked: (telegramAccountId: string) => void;
  onCancel?: () => void;
};

/**
 * `+ Add Telegram` flow (docs/BUILD_SPEC.md §7.2). Works identically for
 * an agent or the owner — whichever role is logged in, the new account
 * gets linked to THAT user, never anyone else's.
 */
export default function AddTelegram({ onLinked, onCancel }: Props) {
  const [authMethod, setAuthMethod] = useState<'phone' | 'qr'>('phone');
  const [step, setStep] = useState<'phone' | 'code' | 'password'>('phone');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [isCodeViaApp, setIsCodeViaApp] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);
  const telegramConfigured = isTelegramConfigured();

  const clientRef = useRef<TelegramClient | null>(null);
  const terminalEndRef = useRef<HTMLDivElement | null>(null);
  const passwordResolverRef = useRef<((pw: string) => void) | null>(null);
  const authDataRef = useRef<{
    phoneCodeHash: string;
    phoneNumber: string;
    isDemo?: boolean;
  } | null>(null);

  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev, entry]);
  }, []);

  useEffect(() => {
    if (showTerminal) {
      terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, showTerminal]);

  function handleCopyLogs() {
    const text = logs.map((l) => `[${l.time}] [${l.type.toUpperCase()}] ${l.text}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopiedLogs(true);
    setTimeout(() => setCopiedLogs(false), 2000);
  }

  // QR Code Login Flow
  const initiateQrLogin = useCallback(async () => {
    if (qrLoading || busy) return;
    setQrLoading(true);
    setQrDataUrl(null);
    setError(null);
    setStatusMessage('Connecting to Telegram...');
    addLog({ time: new Date().toLocaleTimeString(), text: 'Starting Telegram QR Login session...', type: 'info' });

    try {
      const result = await startTelegramQrLogin(
        (dataUrl) => {
          setQrDataUrl(dataUrl);
          setStatusMessage(null);
          setQrLoading(false);
        },
        () => {
          return new Promise<string>((resolve) => {
            setStep('password');
            passwordResolverRef.current = resolve;
          });
        },
        addLog
      );

      clientRef.current = result.client;
      await finalizeLink(result.telegramUserId, result.sessionString);
    } catch (err: any) {
      console.error('[AddTelegram] QR login error:', err);
      setError(err?.errorMessage || err?.message || 'QR login session ended.');
      setQrLoading(false);
      setStatusMessage(null);
    }
  }, [qrLoading, busy, addLog]);

  useEffect(() => {
    if (authMethod === 'qr' && !qrDataUrl && !qrLoading && step === 'phone') {
      initiateQrLogin();
    }
  }, [authMethod, qrDataUrl, qrLoading, step, initiateQrLogin]);

  // Step 1: Request Code
  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    setStatusMessage('Connecting to Telegram...');
    addLog({ time: new Date().toLocaleTimeString(), text: `Initiating code request for ${phoneNumber}...`, type: 'info' });

    try {
      const result = await requestTelegramPhoneCode(phoneNumber, addLog);
      clientRef.current = result.client;
      authDataRef.current = {
        phoneCodeHash: result.phoneCodeHash,
        phoneNumber: result.phoneNumber,
        isDemo: result.isDemo,
      };
      setIsCodeViaApp(result.isCodeViaApp);
      setStep('code');
      setCodeInput('');
      setStatusMessage(null);
    } catch (err: any) {
      console.error('[AddTelegram] Request code failed:', err);
      setError(err?.errorMessage || err?.message || 'Failed to send verification code. Please check the phone number.');
      setStatusMessage(null);
    } finally {
      setBusy(false);
    }
  }

  // Step 2: Submit Code
  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (!authDataRef.current) {
      setError('Session expired. Please re-enter your phone number.');
      setStep('phone');
      return;
    }

    const cleanCode = codeInput.trim().replace(/\D/g, '');
    if (!cleanCode) {
      setError('Please enter the verification code.');
      return;
    }

    setError(null);
    setBusy(true);
    setStatusMessage('Verifying code with Telegram...');

    try {
      const verifyRes = await submitTelegramCode(
        clientRef.current,
        authDataRef.current.phoneNumber,
        authDataRef.current.phoneCodeHash,
        cleanCode,
        authDataRef.current.isDemo,
        addLog
      );

      if (verifyRes.needsPassword) {
        setStep('password');
        setPasswordInput('');
        setStatusMessage(null);
        setBusy(false);
        return;
      }

      await finalizeLink(verifyRes.telegramUserId!, verifyRes.sessionString);
    } catch (err: any) {
      console.error('[AddTelegram] Verify code failed:', err);
      // Stay on 'code' step so user can fix and retry!
      setError(err?.errorMessage || err?.message || 'Invalid verification code. Please check and try again.');
      setStatusMessage(null);
      setBusy(false);
    }
  }

  // Step 3: Submit 2FA Password
  async function handleVerifyPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!passwordInput) {
      setError('Please enter your 2-step verification password.');
      return;
    }

    if (passwordResolverRef.current) {
      const resolver = passwordResolverRef.current;
      passwordResolverRef.current = null;
      resolver(passwordInput);
      setBusy(true);
      setStatusMessage('Verifying 2-step password with Telegram...');
      return;
    }

    setError(null);
    setBusy(true);
    setStatusMessage('Verifying 2-step password with Telegram...');

    try {
      const pwRes = await submitTelegram2FAPassword(clientRef.current, passwordInput, addLog);
      await finalizeLink(pwRes.telegramUserId, pwRes.sessionString);
    } catch (err: any) {
      console.error('[AddTelegram] 2FA password verification failed:', err);
      setError(err?.errorMessage || err?.message || 'Incorrect password. Please try again.');
      setStatusMessage(null);
    } finally {
      setBusy(false);
    }
  }

  // Finalize link & transition to Inbox
  async function finalizeLink(telegramUserId: string, sessionString?: string) {
    setStatusMessage('Linking Telegram account to CRM...');
    addLog({ time: new Date().toLocaleTimeString(), text: `Registering account ${telegramUserId} with CRM server...`, type: 'info' });

    const phoneStr = authDataRef.current?.phoneNumber || phoneNumber;
    let tgUsername: string | undefined;
    let tgDisplayName: string | undefined;
    try {
      if (clientRef.current) {
        const me: any = await clientRef.current.getMe();
        if (me?.username) tgUsername = `@${me.username.replace(/^@/, '')}`;
        const nameParts = [me?.firstName, me?.lastName].filter(Boolean).join(' ').trim();
        if (nameParts) tgDisplayName = nameParts;
      }
    } catch {}

    let linkRes;
    try {
      linkRes = await api.linkTelegramAccount({
        telegramUserId,
        displayName: tgDisplayName || `Account ${maskPhone(phoneStr)}`,
        username: tgUsername,
        phoneMasked: maskPhone(phoneStr),
      });
    } catch (linkErr: any) {
      // e.g. the account is already linked in this org — surface it instead
      // of dumping the user back on the code step.
      setError(linkErr?.message || 'Failed to link Telegram account');
      setStatusMessage(null);
      setBusy(false);
      return;
    }

    const serverAccountId = linkRes.telegramAccount?._id || telegramUserId;
    const accountOwnerType = linkRes.telegramAccount?.ownerType === 'owner' ? 'owner' : 'agent';
    addLog({ time: new Date().toLocaleTimeString(), text: `CRM Account record created: ${serverAccountId}`, type: 'success' });

    if (sessionString) {
      // Session stays local only, keyed by the server-side correlation id.
      await saveSession(serverAccountId, sessionString);

      // Background dialog sync without blocking the UI transition
      if (clientRef.current) {
        addLog({ time: new Date().toLocaleTimeString(), text: `Starting background message and dialog sync...`, type: 'info' });
        syncAccountChats(clientRef.current, serverAccountId, undefined, false, accountOwnerType).catch((syncErr) => {
          console.warn('[AddTelegram] Background dialog sync notice:', syncErr);
        });
      }
    }

    setStatusMessage('Connected successfully!');
    addLog({ time: new Date().toLocaleTimeString(), text: `Account linked! Redirecting to inbox...`, type: 'success' });
    onLinked(serverAccountId);
  }

  function handleBackToPhone() {
    setError(null);
    setStatusMessage(null);
    setStep('phone');
  }

  return (
    <div className="add-telegram">
      <div className="card">
        <h2>+ Add Telegram Account</h2>
        <p className="subtitle">
          Connect your Telegram account directly to sync messages with your team securely.
        </p>

        {!telegramConfigured && (
          <div className="info-banner" style={{ background: 'rgba(59, 130, 246, 0.1)', borderColor: 'rgba(59, 130, 246, 0.3)' }}>
            <strong>Demo Simulation Mode:</strong> Telegram API credentials are not set in <code>client/.env</code>.
            You can enter any phone number and any verification code to connect.
          </div>
        )}

        {/* Method Switcher Tabs (Only on initial step) */}
        {step === 'phone' && (
          <div className="auth-method-tabs" style={{ display: 'flex', gap: '8px', marginBottom: '1.25rem' }}>
            <button
              type="button"
              className={`auth-tab-btn ${authMethod === 'phone' ? 'active' : ''}`}
              onClick={() => setAuthMethod('phone')}
            >
              📱 Phone & Code (Recommended for PC)
            </button>
            <button
              type="button"
              className={`auth-tab-btn ${authMethod === 'qr' ? 'active' : ''}`}
              onClick={() => setAuthMethod('qr')}
            >
              📷 Scan QR Code
            </button>
          </div>
        )}

        {/* OPTION 1: QR Code Login */}
        {step === 'phone' && authMethod === 'qr' && (
          <div className="qr-login-container">
            <div className="qr-code-box">
              {qrDataUrl ? (
                <div className="qr-image-wrapper">
                  <img src={qrDataUrl} alt="Telegram Login QR Code" className="qr-code-img" />
                </div>
              ) : (
                <div className="qr-loading-box">
                  <span className="spinner" style={{ fontSize: '1.5rem', marginBottom: '8px' }}>⏳</span>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                    Generating your Telegram login QR code...
                  </p>
                </div>
              )}
            </div>

            <div className="qr-instructions">
              <h4 style={{ margin: '0 0 8px 0', fontSize: '0.92rem', color: 'var(--text-bright, #fff)' }}>
                How to link via QR Code:
              </h4>
              <ol style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.86rem', lineHeight: '1.6', color: 'var(--text-muted, #94a3b8)' }}>
                <li>Open <strong>Telegram</strong> on your phone</li>
                <li>Go to <strong>Settings ➔ Devices ➔ Link Desktop Device</strong></li>
                <li>Point your phone's camera at this QR code to login instantly</li>
              </ol>
            </div>

            <div className="button-group" style={{ marginTop: '1.25rem', display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className="secondary-btn"
                onClick={initiateQrLogin}
                disabled={qrLoading}
              >
                🔄 Refresh QR Code
              </button>
              {onCancel && (
                <button type="button" className="secondary-btn" onClick={onCancel} disabled={busy}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {/* OPTION 2: Traditional Phone number */}
        {step === 'phone' && authMethod === 'phone' && (
          <form onSubmit={handleRequestCode}>
            <label>
              Telegram Phone Number
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginTop: '2px' }}>
                Include country code (e.g. +1 for US, +251 for Ethiopia, +44 for UK)
              </span>
              <input
                type="tel"
                placeholder="+1 555 123 4567"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                required
                autoFocus
              />
            </label>
            <div className="button-group">
              <button type="submit" className="primary-btn" disabled={busy}>
                {busy ? 'Connecting to Telegram…' : 'Send Code'}
              </button>
              {onCancel && (
                <button type="button" className="secondary-btn" onClick={onCancel} disabled={busy}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}

        {/* STEP 2: Verification Code */}
        {step === 'code' && (
          <form onSubmit={handleVerifyCode}>
            <div
              className="info-banner"
              style={{
                background: isCodeViaApp ? 'rgba(16, 185, 129, 0.1)' : 'rgba(59, 130, 246, 0.1)',
                borderColor: isCodeViaApp ? 'rgba(16, 185, 129, 0.3)' : 'rgba(59, 130, 246, 0.3)',
                padding: '0.85rem 1rem',
                borderRadius: '8px',
                marginBottom: '1rem',
                fontSize: '0.88rem',
                lineHeight: 1.45,
              }}
            >
              {isCodeViaApp ? (
                <>
                  <div style={{ fontWeight: 600, color: 'var(--text-bright, #fff)', marginBottom: '4px' }}>
                    📱 Check your Telegram App
                  </div>
                  <div>
                    Telegram sent the login code to your <strong>Telegram app</strong> on your phone or computer,{' '}
                    <em>not via SMS</em>. Please open Telegram to find the code from the official Telegram service notifications.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontWeight: 600, color: 'var(--text-bright, #fff)', marginBottom: '4px' }}>
                    💬 Check your SMS
                  </div>
                  <div>
                    Telegram sent an SMS with your verification code to{' '}
                    <strong>{maskPhone(authDataRef.current?.phoneNumber || phoneNumber)}</strong>.
                  </div>
                </>
              )}
            </div>

            <label>
              Verification Code
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                placeholder="12345"
                style={{
                  fontSize: '1.25rem',
                  letterSpacing: '4px',
                  fontWeight: 600,
                  textAlign: 'center',
                }}
                required
                autoFocus
              />
            </label>

            <div className="button-group" style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="submit" className="primary-btn" disabled={busy} style={{ flex: 1 }}>
                {busy ? 'Verifying…' : 'Verify & Link'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={handleBackToPhone}
                disabled={busy}
              >
                ← Change Phone
              </button>
            </div>
          </form>
        )}

        {/* STEP 3: 2-Step Cloud Password */}
        {step === 'password' && (
          <form onSubmit={handleVerifyPassword}>
            <div
              className="info-banner"
              style={{
                background: 'rgba(234, 179, 8, 0.1)',
                borderColor: 'rgba(234, 179, 8, 0.3)',
                padding: '0.85rem 1rem',
                borderRadius: '8px',
                marginBottom: '1rem',
                fontSize: '0.88rem',
              }}
            >
              🔒 <strong>Two-Step Verification Enabled:</strong> Your Telegram account is protected by an additional cloud password.
            </div>

            <label>
              2-Step Verification Password
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Enter your cloud password"
                required
                autoFocus
              />
            </label>

            <div className="button-group" style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button type="submit" className="primary-btn" disabled={busy} style={{ flex: 1 }}>
                {busy ? 'Confirming…' : 'Confirm Password'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setStep('code')}
                disabled={busy}
              >
                ← Back
              </button>
            </div>
          </form>
        )}

        {statusMessage && (
          <div className="info-banner" style={{ marginTop: '1rem', textAlign: 'center' }}>
            <span className="spinner" style={{ marginRight: '8px' }}>⏳</span>
            {statusMessage}
          </div>
        )}

        {error && <div className="error-box" style={{ marginTop: '1rem' }}>{error}</div>}

        {/* Connection log (collapsed by default; expand for troubleshooting) */}
        <div className="telegram-live-debug-terminal">
          <div className="debug-terminal-header">
            <div className="debug-terminal-title">
              <strong>Connection log</strong>
              <span className="debug-log-count">{logs.length} events</span>
            </div>
            <div className="debug-terminal-actions">
              <button
                type="button"
                className="debug-terminal-btn"
                onClick={handleCopyLogs}
                disabled={logs.length === 0}
                title="Copy all logs to clipboard"
              >
                {copiedLogs ? '✓ Copied' : 'Copy'}
              </button>
              <button
                type="button"
                className="debug-terminal-btn"
                onClick={() => setLogs([])}
                disabled={logs.length === 0}
                title="Clear logs"
              >
                Clear
              </button>
              <button
                type="button"
                className="debug-terminal-btn"
                onClick={() => setShowTerminal(!showTerminal)}
              >
                {showTerminal ? 'Collapse' : 'Expand'}
              </button>
            </div>
          </div>

          {showTerminal && (
            <div className="debug-terminal-body">
              {logs.length === 0 ? (
                <div className="debug-terminal-placeholder">
                  Waiting for Telegram connection events... Enter your phone and click "Send Code" to see live debug stream.
                </div>
              ) : (
                logs.map((log, index) => (
                  <div key={index} className={`debug-terminal-row debug-row-${log.type}`}>
                    <span className="debug-row-time">[{log.time}]</span>
                    <span className="debug-row-tag">{log.type.toUpperCase()}</span>
                    <span className="debug-row-text">{log.text}</span>
                  </div>
                ))
              )}
              <div ref={terminalEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}
