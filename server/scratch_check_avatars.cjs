const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const Chat = require('./src/models/Chat');
const Contact = require('./src/models/Contact');
const Agent = require('./src/models/Agent');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { family: 4 });
  const orgId = new mongoose.Types.ObjectId('6b0356e7418c6dab71074c8e');

  const contacts = await Contact.find({ orgId }).lean();
  console.log('Total contacts:', contacts.length);
  const withAvatar = contacts.filter((c) => c.avatarUrl);
  console.log('Contacts with avatarUrl:', withAvatar.length);
  for (const c of withAvatar.slice(0, 8)) {
    console.log('  ', c._id.toString(), c.telegramUserId, '->', String(c.avatarUrl).slice(0, 60));
  }

  // Chats with contactId populated and how many have avatarUrl
  const chats = await Chat.find({ orgId }).select('contactId').populate('contactId', 'avatarUrl').limit(1000).lean();
  const withContact = chats.filter((c) => c.contactId);
  const withAvatarChat = withContact.filter((c) => c.contactId.avatarUrl);
  console.log('\nChats:', chats.length, 'with contactId:', withContact.length, 'contactId.avatarUrl set:', withAvatarChat.length);

  // sample
  for (const c of withAvatarChat.slice(3)) {
    console.log('  chat', c._id.toString(), 'contact', c.contactId._id.toString(), 'avatarUrl:', String(c.contactId.avatarUrl).slice(0, 60));
  }
  for (const c of withContact.filter((c) => !c.contactId.avatarUrl).slice(3)) {
    console.log('  chat', c._id.toString(), 'contact', c.contactId._id.toString(), 'avatarUrl: (none)');
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
