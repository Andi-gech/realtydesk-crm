const express = require('express');
const Template = require('../models/Template');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const templates = await Template.find({ orgId: req.auth.orgId }).sort({ createdAt: -1 });
  return res.json({ templates });
});

router.post('/', async (req, res) => {
  const { title, body, media, savedMessageIds } = req.body || {};
  const cleanBody = typeof body === 'string' ? body : '';
  const cleanMedia = Array.isArray(media) ? media.slice(0, 10).map((m) => ({
    kind: m?.kind === 'document' ? 'document' : 'photo',
    id: m?.id ? String(m.id) : undefined,
    accessHash: m?.accessHash ? String(m.accessHash) : undefined,
    fileReference: m?.fileReference ? String(m.fileReference) : undefined,
    dcId: m?.dcId ? Number(m.dcId) : undefined,
    mimeType: m?.mimeType ? String(m.mimeType) : undefined,
    fileName: m?.fileName ? String(m.fileName) : undefined,
    size: m?.size ? Number(m.size) : undefined,
    dataUrl: m?.dataUrl ? String(m.dataUrl) : undefined,
  })) : [];
  const cleanSavedMessageIds = Array.isArray(savedMessageIds)
    ? savedMessageIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0).slice(0, 10)
    : [];
  if (!title || (!cleanBody.trim() && cleanMedia.length === 0 && cleanSavedMessageIds.length === 0)) {
    return res.status(400).json({ error: 'title and body or media are required' });
  }
  const template = await Template.create({
    orgId: req.auth.orgId,
    title: String(title).trim(),
    body: cleanBody,
    media: cleanMedia,
    savedMessageIds: cleanSavedMessageIds,
    createdBy: req.auth.sub,
  });
  return res.status(201).json({ template });
});

router.delete('/:id', async (req, res) => {
  await Template.deleteOne({ _id: req.params.id, orgId: req.auth.orgId });
  return res.json({ ok: true });
});

module.exports = router;
