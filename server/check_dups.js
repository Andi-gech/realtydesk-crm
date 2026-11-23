const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');

async function reportDuplicates() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set in server/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { family: 4 });
  const Chat = require('./src/models/Chat');
  const Contact = require('./src/models/Contact');

  const dups = await Contact.find({ duplicateFlag: true }).lean();
  console.log('\n=== DUPLICATE REPORT ===');
  console.log(`Total duplicate contacts in DB: ${dups.length}`);

  for (const contact of dups) {
    const chats = await Chat.find({ contactId: contact._id, isArchived: { $ne: true } }).lean();
    console.log(
      `Contact: ${contact.displayName || contact.firstName || 'Unknown'} ` +
      `(${contact.phoneNumber || contact.username || contact.telegramUserId}) ` +
      `activeChats=${chats.length} accounts=${chats.map((c) => c.telegramAccountId).join(', ')}`
    );
  }

  process.exit(0);
}

reportDuplicates().catch((err) => {
  console.error(err);
  process.exit(1);
});
