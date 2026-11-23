require('dotenv').config();
const bcrypt = require('bcryptjs');
const { connectDb } = require('../config/db');
const Owner = require('../models/Owner');
const Organization = require('../models/Organization');

async function main() {
  await connectDb();

  const email = (process.env.SEED_OWNER_EMAIL || '').toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD;
  const orgName = process.env.SEED_ORG_NAME || 'My Brokerage';

  if (!email || !password) {
    throw new Error('Set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD in .env before seeding.');
  }

  let owner = await Owner.findOne({ email });
  if (owner) {
    console.log(`[seed] owner ${email} already exists, skipping creation`);
  } else {
    if (password.length < 12 || /replace|change[-_ ]?me|placeholder|example/i.test(password)) {
      throw new Error(
        'SEED_OWNER_PASSWORD must be at least 12 characters and must not be a placeholder value.'
      );
    }
    const passwordHash = await bcrypt.hash(password, 12);
    owner = await Owner.create({ email, passwordHash, displayName: 'Owner' });
    console.log(`[seed] created owner ${email}`);
  }

  let org = await Organization.findOne({ ownerId: owner._id });
  if (org) {
    console.log(`[seed] organization already exists: ${org.name}`);
  } else {
    org = await Organization.create({ name: orgName, ownerId: owner._id });
    console.log(`[seed] created organization "${org.name}" (${org._id})`);
  }

  console.log('[seed] done. You can now POST /api/v1/auth/owner/login with these credentials.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
