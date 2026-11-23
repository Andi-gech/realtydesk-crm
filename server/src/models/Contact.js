const { Schema, model } = require('mongoose');

const contactSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    telegramUserId: { type: String, index: true },
    username: { type: String, index: true },
    phoneNumber: { type: String, index: true },
    displayName: { type: String },
    savedName: { type: String },
    firstName: { type: String },
    lastName: { type: String },
    isBlocked: { type: Boolean, default: false },
    firstSeenByAgentId: { type: Schema.Types.ObjectId, ref: 'Agent' },
    linkedAgents: [{ type: Schema.Types.ObjectId, ref: 'Agent' }],
    linkedAccounts: [{ type: Schema.Types.ObjectId, ref: 'TelegramAccount' }],
    duplicateFlag: { type: Boolean, default: false },
    avatarUrl: { type: String },
  },
  { timestamps: true }
);

module.exports = model('Contact', contactSchema);
