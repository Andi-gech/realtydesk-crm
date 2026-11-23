import { useEffect, useState } from 'react';
import { api } from '../api/client';

export default function OwnerAdmin() {
  const [tab, setTab] = useState<'agents' | 'codes' | 'duplicates'>('agents');
  const [agents, setAgents] = useState<any[]>([]);
  const [activationCodes, setActivationCodes] = useState<any[]>([]);
  const [duplicateChats, setDuplicateChats] = useState<any[]>([]);
  const [maxUses, setMaxUses] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // New sub-user form state
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [creatingAgent, setCreatingAgent] = useState(false);

  useEffect(() => {
    loadAgents();
    loadCodes();
    loadDuplicates();
  }, []);

  async function loadAgents() {
    try {
      const res = await api.listAgents();
      setAgents(res.agents || []);
    } catch (err: any) {
      console.warn('Failed to load agents:', err);
    }
  }

  async function loadCodes() {
    try {
      const res = await api.listActivationCodes();
      setActivationCodes(res.activationCodes || []);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadDuplicates() {
    try {
      const res = await api.listChats({ scope: 'all', filter: 'repeated' });
      setDuplicateChats(res.chats || []);
    } catch (err: any) {
      console.warn('Failed to load duplicates:', err);
    }
  }

  async function handleCreateAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!newDisplayName.trim() || !newUsername.trim() || !newPassword) return;

    setCreatingAgent(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await api.createAgent({
        displayName: newDisplayName.trim(),
        username: newUsername.trim().toLowerCase(),
        password: newPassword,
      });
      setSuccess(`Sub-user "${res.agent.displayName}" (@${res.agent.username}) created successfully! They can now sign in.`);
      setNewDisplayName('');
      setNewUsername('');
      setNewPassword('');
      await loadAgents();
    } catch (err: any) {
      setError(err.message || 'Failed to create sub-user');
    } finally {
      setCreatingAgent(false);
    }
  }

  async function handleDeleteAgent(id: string, name: string) {
    if (!window.confirm(`Are you sure you want to delete sub-user "${name}"?`)) return;
    try {
      await api.deleteAgent(id);
      setSuccess(`Sub-user "${name}" deleted.`);
      await loadAgents();
    } catch (err: any) {
      setError(err.message || 'Failed to delete sub-user');
    }
  }

  async function handleCreateCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.createActivationCode(maxUses);
      setSuccess(`Created new activation code: ${res.activationCode.code}`);
      await loadCodes();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="owner-admin">
      <div className="admin-header">
        <h2>Organization Management</h2>
        <div className="admin-tabs">
          <button className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>
            👥 Sub-Users / Agents ({agents.length})
          </button>
          <button className={tab === 'duplicates' ? 'active' : ''} onClick={() => setTab('duplicates')}>
            🔄 Duplicate Leads ({duplicateChats.length})
          </button>
          <button className={tab === 'codes' ? 'active' : ''} onClick={() => setTab('codes')}>
            🔑 Activation Codes ({activationCodes.length})
          </button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {success && <div className="success-box">{success}</div>}

      {/* TAB 1: SUB-USERS / AGENTS */}
      {tab === 'agents' && (
        <div className="admin-content">
          <div className="card code-generator-card">
            <h3>+ Create New Sub-User (Agent)</h3>
            <p className="subtitle">
              Create login credentials for sales agents or team members. Sub-users can only view and manage their own chats, while Admin can access all.
            </p>
            <form onSubmit={handleCreateAgent} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
              <label>
                Agent Full Name
                <input
                  placeholder="e.g. Sarah Jenkins"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  required
                />
              </label>
              <label>
                Username
                <input
                  placeholder="e.g. sarah_agent"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  placeholder="Create password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </label>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button type="submit" className="primary-btn" disabled={creatingAgent} style={{ width: '100%', height: '42px' }}>
                  {creatingAgent ? 'Creating…' : '+ Create Sub-User'}
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <h3>Team Members & Sub-Users</h3>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Agent Name</th>
                  <th>Username</th>
                  <th>Role & Access</th>
                  <th>Linked Telegram Accounts</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="empty-cell">
                      No sub-users created yet. Use the form above to add your first sales agent.
                    </td>
                  </tr>
                ) : (
                  agents.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{a.displayName}</strong>
                      </td>
                      <td>
                        <code className="code-badge">@{a.username || 'code-user'}</code>
                      </td>
                      <td>
                        <span className="status-pill active" style={{ background: 'rgba(59, 130, 246, 0.1)', color: '#2563eb' }}>
                          Own Chats Only
                        </span>
                      </td>
                      <td>
                        {a.telegramAccounts && a.telegramAccounts.length > 0 ? (
                          a.telegramAccounts.map((tg: any) => (
                            <span key={tg.id} style={{ display: 'inline-block', background: '#f1f5f9', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', margin: '2px' }}>
                              📱 {tg.displayName || tg.phoneMasked || 'Telegram'}
                            </span>
                          ))
                        ) : (
                          <span style={{ color: '#94a3b8', fontSize: '12px' }}>None linked yet</span>
                        )}
                      </td>
                      <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary-btn small-btn"
                          style={{ color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.3)' }}
                          onClick={() => handleDeleteAgent(a.id, a.displayName)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: ACTIVATION CODES */}
      {tab === 'codes' && (
        <div className="admin-content">
          <div className="card code-generator-card">
            <h3>Generate Team Activation Code</h3>
            <p className="subtitle">
              Alternative invite option: agents can use this code to self-enroll into your organization.
            </p>
            <form onSubmit={handleCreateCode} className="inline-form">
              <label>
                Max Uses:
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={maxUses}
                  onChange={(e) => setMaxUses(parseInt(e.target.value) || 1)}
                  required
                />
              </label>
              <button type="submit" className="primary-btn" disabled={loading}>
                {loading ? 'Generating…' : 'Generate Code'}
              </button>
            </form>
          </div>

          <div className="card">
            <h3>Active Activation Codes</h3>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Uses</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {activationCodes.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty-cell">
                      No activation codes found. Generate one above to invite agents.
                    </td>
                  </tr>
                ) : (
                  activationCodes.map((c) => {
                    const isExhausted = c.usesCount >= c.maxUses;
                    return (
                      <tr key={c._id}>
                        <td>
                          <code className="code-badge">{c.code}</code>
                        </td>
                        <td>
                          {c.usesCount} / {c.maxUses}
                        </td>
                        <td>
                          <span className={`status-pill ${isExhausted ? 'exhausted' : 'active'}`}>
                            {isExhausted ? 'Used Up' : 'Active'}
                          </span>
                        </td>
                        <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: DUPLICATE LEADS */}
      {tab === 'duplicates' && (
        <div className="admin-content">
          <div className="card">
            <h3>Cross-Agent Duplicate Leads</h3>
            <p className="subtitle">
              Leads that have been contacted by multiple sales agents across your brokerage.
            </p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Contact Identifier</th>
                  <th>Current Agent</th>
                  <th>Last Message</th>
                  <th>Last Active</th>
                </tr>
              </thead>
              <tbody>
                {duplicateChats.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty-cell">
                      No duplicate leads detected. Great work keeping prospect coverage distinct!
                    </td>
                  </tr>
                ) : (
                  duplicateChats.map((c) => (
                    <tr key={c._id}>
                      <td>
                        <strong>{c.contactId?.username || c.contactId?.phoneNumber || 'Contact'}</strong>
                        <span className="dup-badge">Repeated</span>
                      </td>
                      <td>{c.agentId?.displayName || 'Unassigned'}</td>
                      <td>{c.lastMessagePreview || 'No messages'}</td>
                      <td>{c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleString() : '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
