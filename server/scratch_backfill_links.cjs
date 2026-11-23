const mongoose = require('mongoose');
require('dotenv').config();

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  
  const Contact = require('./src/models/Contact');
  const Chat = require('./src/models/Chat');

  const chats = await Chat.find({ contactId: { $exists: true } });
  console.log(`Checking ${chats.length} chats to backfill linkedAccounts...`);

  let updatedCount = 0;
  for (const ch of chats) {
    if (!ch.contactId || !ch.telegramAccountId) continue;
    const res = await Contact.updateOne(
      { _id: ch.contactId },
      {
        $addToSet: {
          linkedAccounts: ch.telegramAccountId,
          linkedAgents: ch.agentId
        }
      }
    );
    if (res.modifiedCount > 0) updatedCount++;
  }

  console.log(`Updated ${updatedCount} contacts with linkedAccounts.`);

  // Verify contact 777000
  const c = await Contact.findOne({ telegramUserId: '777000' }).populate('linkedAccounts').populate('linkedAgents');
  console.log('Contact 777000 linked accounts:', c.linkedAccounts.map(a => ({
    _id: a._id,
    displayName: a.displayName,
    phoneMasked: a.phoneMasked
  })));
  console.log('Contact 777000 linked agents:', c.linkedAgents.map(a => a.displayName));

  await mongoose.disconnect();
}

run().catch(console.error);
