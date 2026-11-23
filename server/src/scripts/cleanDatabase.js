const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {}
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function clean() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('No MONGO_URI in .env');
    process.exit(1);
  }

  console.log('[cleanDatabase] Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('[cleanDatabase] Connected.');

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map((c) => c.name);
  console.log('[cleanDatabase] Existing collections:', collectionNames);

  const toDrop = [
    'chats',
    'messages',
    'contacts',
    'contactnotes',
    'notes',
    'telegramaccounts',
    'activationcodes',
    'agents',
    'templates',
  ];
  for (const name of toDrop) {
    if (collectionNames.includes(name)) {
      await db.collection(name).deleteMany({});
      console.log(`[cleanDatabase] Cleared collection: ${name}`);
    }
  }

  // Ensure fresh seed owner and org exists
  const email = (process.env.SEED_OWNER_EMAIL || 'owner@example.com').toLowerCase();
  const password = process.env.SEED_OWNER_PASSWORD || 'change-me-now';
  const orgName = process.env.SEED_ORG_NAME || 'My Brokerage';

  const ownersCol = db.collection('owners');
  const orgsCol = db.collection('organizations');
  const agentsCol = db.collection('agents');

  await ownersCol.deleteMany({});
  await orgsCol.deleteMany({});
  await agentsCol.deleteMany({});
  console.log('[cleanDatabase] Reset owners, organizations, and agents.');

  const passwordHash = await bcrypt.hash(password, 12);
  const ownerRes = await ownersCol.insertOne({
    email,
    passwordHash,
    displayName: 'Brokerage Owner',
    role: 'owner',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const ownerId = ownerRes.insertedId;
  console.log(`[cleanDatabase] Seeded clean owner: ${email} (${ownerId})`);

  const orgRes = await orgsCol.insertOne({
    name: orgName,
    ownerId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const orgId = orgRes.insertedId;
  console.log(`[cleanDatabase] Seeded clean organization: "${orgName}" (${orgId})`);

  // No dummy agents or dummy data seeded - completely clean database
  console.log('[cleanDatabase] No dummy data created. 0 sub-users/agents, 0 chats, 0 contacts.');

  console.log('[cleanDatabase] Database completely emptied and cleanly re-initialized!');
  process.exit(0);
}

clean().catch((err) => {
  console.error('[cleanDatabase] Error:', err);
  process.exit(1);
});
