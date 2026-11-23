const express = require('express');
const Contact = require('../models/Contact');
const Note = require('../models/Note');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/:id', async (req, res) => {
  const contact = await Contact.findOne({ _id: req.params.id, orgId: req.auth.orgId }).populate(
    'linkedAgents firstSeenByAgentId'
  );
  if (!contact) return res.status(404).json({ error: 'Not found' });
  return res.json({ contact });
});

router.get('/:id/notes', async (req, res) => {
  const notes = await Note.find({ contactId: req.params.id, orgId: req.auth.orgId }).sort({ createdAt: -1 });
  return res.json({ notes });
});

router.post('/:id/notes', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  const note = await Note.create({
    orgId: req.auth.orgId,
    contactId: req.params.id,
    authorId: req.auth.sub,
    authorType: req.auth.role,
    text,
  });
  return res.status(201).json({ note });
});

module.exports = router;
