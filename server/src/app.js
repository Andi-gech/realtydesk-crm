const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const ownerRoutes = require('./routes/owner');
const telegramAccountRoutes = require('./routes/telegramAccounts');
const syncRoutes = require('./routes/sync');
const chatRoutes = require('./routes/chats');
const contactRoutes = require('./routes/contacts');
const templateRoutes = require('./routes/templates');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('tiny'));

  app.get('/health', (req, res) => res.json({ ok: true, service: 'realtydesk-server' }));

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/owner', ownerRoutes);
  app.use('/api/v1/telegram-accounts', telegramAccountRoutes);
  app.use('/api/v1/sync', syncRoutes);
  app.use('/api/v1/chats', chatRoutes);
  app.use('/api/v1/contacts', contactRoutes);
  app.use('/api/v1/templates', templateRoutes);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
