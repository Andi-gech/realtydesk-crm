const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { connectDb } = require('./config/db');
const { createApp } = require('./app');
const { validateTokenSecrets } = require('./services/tokenService');
const TelegramAccount = require('./models/TelegramAccount');

process.on('unhandledRejection', (reason) => {
  console.warn('[server] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.warn('[server] Caught exception:', err.message || err);
});

/**
 * Removes any session material stored by older builds. The current schema
 * has no sessionString field; this keeps existing databases compliant with
 * the security boundary in docs/BUILD_SPEC.md §2.
 */
async function purgeLegacyTelegramSessions() {
  try {
    const result = await TelegramAccount.collection.updateMany(
      { sessionString: { $exists: true } },
      { $unset: { sessionString: '' } }
    );
    if (result.modifiedCount > 0) {
      console.log(`[server] Removed legacy Telegram session material from ${result.modifiedCount} account(s)`);
    }
  } catch (err) {
    console.warn('[server] Could not purge legacy Telegram sessions:', err.message);
  }
}

async function main() {
  validateTokenSecrets();

  const app = createApp();
  const port = process.env.PORT || 4000;

  app.listen(port, () => {
    console.log(`[server] RealtyDesk API listening on port ${port}`);
  });

  console.log('[server] Connecting to database...');
  try {
    await connectDb();
    await purgeLegacyTelegramSessions();
  } catch (err) {
    console.warn('[server] Initial DB connect error (will auto-retry):', err.message);
  }
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err.message || err);
  process.exit(1);
});
