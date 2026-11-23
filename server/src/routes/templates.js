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
  const { title, body } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body are required' });
  const template = await Template.create({ orgId: req.auth.orgId, title, body, createdBy: req.auth.sub });
  return res.status(201).json({ template });
});

module.exports = router;
