// Cascading cleanup helpers so deleting an agent / account / logout doesn't leave
// orphaned chats, messages and contacts behind in the admin view.
const TelegramAccount = require('../models/TelegramAccount');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const Note = require('../models/Note');
const Contact = require('../models/Contact');

async function deleteChatsForAccounts(orgId, accountIds) {
  if (!accountIds || accountIds.length === 0) return;
  const chats = await Chat.find({ orgId, telegramAccountId: { $in: accountIds } }).select('_id');
  const chatIds = chats.map((c) => c._id);
  if (chatIds.length > 0) {
    await Message.deleteMany({ orgId, chatId: { $in: chatIds } });
    await Note.deleteMany({ orgId, chatId: { $in: chatIds } });
    await Chat.deleteMany({ _id: { $in: chatIds } });
  }
}

async function deleteAgentData(orgId, agentId) {
  const accounts = await TelegramAccount.find({ orgId, ownerType: 'agent', ownerRefId: agentId });
  const accountIds = accounts.map((a) => a._id);
  await deleteChatsForAccounts(orgId, accountIds);
  await TelegramAccount.deleteMany({ orgId, ownerType: 'agent', ownerRefId: agentId });
  // Contacts owned solely by this agent (no other links)
  await Contact.deleteMany({ orgId, linkedAgents: agentId, linkedAccounts: { $size: 0 } });
}

async function deleteAccountData(orgId, accountId) {
  await deleteChatsForAccounts(orgId, [accountId]);
  // Mark revoked rather than hard-delete so the account can be re-linked later.
  await TelegramAccount.updateOne({ _id: accountId, orgId }, { $set: { status: 'revoked' } });
}

async function deleteAgentChatsOnLogout(orgId, agentId) {
  const accounts = await TelegramAccount.find({ orgId, ownerType: 'agent', ownerRefId: agentId, status: 'active' });
  const accountIds = accounts.map((a) => a._id);
  await deleteChatsForAccounts(orgId, accountIds);
}

module.exports = {
  deleteChatsForAccounts,
  deleteAgentData,
  deleteAccountData,
  deleteAgentChatsOnLogout,
};