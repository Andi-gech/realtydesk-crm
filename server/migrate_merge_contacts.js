const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');

async function runFastMerge() {
  await mongoose.connect(process.env.MONGO_URI, { family: 4, serverSelectionTimeoutMS: 15000 });
  const Contact = mongoose.model('Contact', new mongoose.Schema({}, { strict: false }));
  const Chat = mongoose.model('Chat', new mongoose.Schema({}, { strict: false }));
  const Note = mongoose.model('Note', new mongoose.Schema({}, { strict: false }));

  console.log('--- STARTING FAST CONTACT DEDUPLICATION & MERGE ---');
  const allContacts = await Contact.find({}).lean();
  console.log(`Contacts currently in DB: ${allContacts.length}`);

  const tgMap = new Map();
  const phoneMap = new Map();
  const userMap = new Map();

  for (const c of allContacts) {
    const id = String(c._id);
    const tgId = c.telegramUserId ? String(c.telegramUserId).trim() : null;
    const phone = c.phoneNumber ? String(c.phoneNumber).trim().replace(/[\s\-\(\)]/g, '') : null;
    const user = c.username ? String(c.username).trim().toLowerCase().replace(/^@/, '') : null;

    if (tgId) {
      if (!tgMap.has(tgId)) tgMap.set(tgId, []);
      tgMap.get(tgId).push(id);
    }
    if (phone) {
      if (!phoneMap.has(phone)) phoneMap.set(phone, []);
      phoneMap.get(phone).push(id);
    }
    if (user) {
      if (!userMap.has(user)) userMap.set(user, []);
      userMap.get(user).push(id);
    }
  }

  // Disjoint Set (Union-Find)
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) === x) return x;
    const root = find(parent.get(x));
    parent.set(x, root);
    return root;
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  for (const list of tgMap.values()) {
    for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  }
  for (const list of phoneMap.values()) {
    for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  }
  for (const list of userMap.values()) {
    for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  }

  const clusters = new Map();
  for (const c of allContacts) {
    const id = String(c._id);
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(c);
  }

  console.log(`Clustered into ${clusters.size} unique client identities.`);

  const contactBulkOps = [];
  const secondaryIdsToDelete = [];
  const chatBulkOps = [];
  const noteBulkOps = [];

  for (const [rootId, group] of clusters.entries()) {
    if (group.length <= 1) continue;

    let canonical = group[0];
    let maxScore = -1;
    for (const c of group) {
      let score = 0;
      if (c.telegramUserId) score += 5;
      if (c.phoneNumber) score += 4;
      if (c.username) score += 3;
      if (c.displayName) score += 2;
      if (c.avatarUrl) score += 2;
      if (c.linkedAccounts && c.linkedAccounts.length > 0) score += 10;
      if (score > maxScore) {
        maxScore = score;
        canonical = c;
      }
    }

    const canonicalId = canonical._id;
    const secondaryList = group.filter(c => String(c._id) !== String(canonicalId));

    const mergedFields = {
      telegramUserId: canonical.telegramUserId || group.find(c => c.telegramUserId)?.telegramUserId,
      phoneNumber: canonical.phoneNumber || group.find(c => c.phoneNumber)?.phoneNumber,
      username: canonical.username || group.find(c => c.username)?.username,
      displayName: canonical.displayName || group.find(c => c.displayName)?.displayName,
      savedName: canonical.savedName || group.find(c => c.savedName)?.savedName,
      firstName: canonical.firstName || group.find(c => c.firstName)?.firstName,
      lastName: canonical.lastName || group.find(c => c.lastName)?.lastName,
      avatarUrl: canonical.avatarUrl || group.find(c => c.avatarUrl)?.avatarUrl,
    };

    contactBulkOps.push({
      updateOne: {
        filter: { _id: canonicalId },
        update: { $set: mergedFields },
      },
    });

    const secIds = secondaryList.map(s => s._id);
    secondaryIdsToDelete.push(...secIds);

    chatBulkOps.push({
      updateMany: {
        filter: { contactId: { $in: secIds } },
        update: { $set: { contactId: canonicalId } },
      },
    });

    noteBulkOps.push({
      updateMany: {
        filter: { contactId: { $in: secIds } },
        update: { $set: { contactId: canonicalId } },
      },
    });
  }

  if (contactBulkOps.length > 0) {
    console.log(`Writing ${contactBulkOps.length} canonical contact updates in bulk...`);
    await Contact.bulkWrite(contactBulkOps);
  }

  if (chatBulkOps.length > 0) {
    console.log(`Remapping chats for secondary contacts in bulk...`);
    await Chat.bulkWrite(chatBulkOps);
    await Note.bulkWrite(noteBulkOps);
  }

  if (secondaryIdsToDelete.length > 0) {
    console.log(`Deleting ${secondaryIdsToDelete.length} redundant secondary contacts...`);
    await Contact.deleteMany({ _id: { $in: secondaryIdsToDelete } });
  }

  // Bulk recompute of duplicateFlag & linkedAccounts
  console.log('Recomputing duplicateFlag & linkedAccounts for all contacts in bulk...');
  const allActiveChats = await Chat.find({ isArchived: { $ne: true } })
    .select('contactId telegramAccountId agentId')
    .lean();

  const contactAccsMap = new Map();
  const contactAgentsMap = new Map();

  for (const ch of allActiveChats) {
    if (!ch.contactId) continue;
    const cid = String(ch.contactId);
    if (!contactAccsMap.has(cid)) contactAccsMap.set(cid, new Set());
    if (!contactAgentsMap.has(cid)) contactAgentsMap.set(cid, new Set());

    if (ch.telegramAccountId) contactAccsMap.get(cid).add(String(ch.telegramAccountId));
    if (ch.agentId) contactAgentsMap.get(cid).add(`agent_${String(ch.agentId)}`);
  }

  const remainingContacts = await Contact.find({}).select('_id').lean();
  const updateFlagOps = [];
  let dupCount = 0;

  for (const rc of remainingContacts) {
    const cid = String(rc._id);
    const accSet = contactAccsMap.get(cid) || new Set();
    const agentSet = contactAgentsMap.get(cid) || new Set();

    const isDup = accSet.size > 1 || agentSet.size > 1;
    if (isDup) dupCount++;

    updateFlagOps.push({
      updateOne: {
        filter: { _id: rc._id },
        update: {
          $set: {
            linkedAccounts: Array.from(accSet).map(id => new mongoose.Types.ObjectId(id)),
            duplicateFlag: isDup,
          },
        },
      },
    });
  }

  console.log(`Writing flags in bulk for ${updateFlagOps.length} contacts (${dupCount} duplicates)...`);
  if (updateFlagOps.length > 0) {
    await Contact.bulkWrite(updateFlagOps);
  }

  console.log(`--- DEDUPLICATION COMPLETE! ---`);
  console.log(`Final total contacts: ${remainingContacts.length}`);
  console.log(`Total duplicate contacts: ${dupCount}`);

  process.exit(0);
}

runFastMerge().catch(err => {
  console.error(err);
  process.exit(1);
});
