const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const ActivationCode = require('../models/ActivationCode');
const Agent = require('../models/Agent');
const TelegramAccount = require('../models/TelegramAccount');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('owner'));

/**
 * Creates a new sub-user (Agent) with username, password, and displayName.
 */
router.post('/agents', async (req, res) => {
  const { username, password, displayName } = req.body || {};

  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'Username, password, and display name are required' });
  }

  const cleanUsername = username.trim().toLowerCase();
  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }

  const existing = await Agent.findOne({ username: cleanUsername });
  if (existing) {
    return res.status(409).json({ error: 'An agent with this username already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const agent = await Agent.create({
    orgId: req.auth.orgId,
    displayName: displayName.trim(),
    username: cleanUsername,
    passwordHash,
    role: 'agent',
    status: 'active',
  });

  return res.status(201).json({
    agent: {
      id: agent._id,
      displayName: agent.displayName,
      username: agent.username,
      role: agent.role,
      status: agent.status,
      createdAt: agent.createdAt,
    },
  });
});

/**
 * Lists all sub-users / agents in the organization with their linked Telegram accounts.
 */
router.get('/agents', async (req, res) => {
  const agents = await Agent.find({ orgId: req.auth.orgId }).sort({ createdAt: -1 });
  const accounts = await TelegramAccount.find({ orgId: req.auth.orgId, ownerType: 'agent' });

  const accountsByAgent = new Map();
  for (const acc of accounts) {
    const key = String(acc.ownerRefId);
    if (!accountsByAgent.has(key)) accountsByAgent.set(key, []);
    accountsByAgent.get(key).push({
      id: acc._id,
      displayName: acc.displayName,
      phoneMasked: acc.phoneMasked,
      status: acc.status,
    });
  }

  const results = agents.map((a) => ({
    id: a._id,
    displayName: a.displayName,
    username: a.username,
    role: a.role,
    status: a.status,
    lastSeenAt: a.lastSeenAt,
    createdAt: a.createdAt,
    telegramAccounts: accountsByAgent.get(String(a._id)) || [],
  }));

  return res.json({ agents: results });
});

/**
 * Deletes a sub-user (Agent) from the organization.
 */
router.delete('/agents/:id', async (req, res) => {
  const agent = await Agent.findOne({ _id: req.params.id, orgId: req.auth.orgId });
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  await Agent.deleteOne({ _id: agent._id });
  return res.json({ ok: true, message: 'Agent deleted' });
});

/**
 * Resets a sub-user's password.
 */
router.patch('/agents/:id/password', async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }

  const agent = await Agent.findOne({ _id: req.params.id, orgId: req.auth.orgId });
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  agent.passwordHash = await bcrypt.hash(newPassword, 12);
  await agent.save();

  return res.json({ ok: true, message: 'Password updated successfully' });
});

router.post('/activation-codes', async (req, res) => {
  const { maxUses = 1, expiresAt } = req.body || {};
  const code = nanoid(10).toUpperCase();
  const activation = await ActivationCode.create({
    orgId: req.auth.orgId,
    code,
    maxUses,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
  });
  return res.status(201).json({ activationCode: activation });
});

router.get('/activation-codes', async (req, res) => {
  const codes = await ActivationCode.find({ orgId: req.auth.orgId }).sort({ createdAt: -1 });
  return res.json({ activationCodes: codes });
});

module.exports = router;
