const { Schema, model } = require('mongoose');

const messageSchema = new Schema(
  {
    chatId: { type: Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    senderType: { type: String, enum: ['contact', 'agent', 'owner'], required: true },
    senderId: { type: Schema.Types.Mixed }, // Agent._id or Owner._id or telegram user id
    text: { type: String },
    mediaRef: { type: String }, // pointer to media storage, not the file itself
    telegramMessageId: { type: String, required: true },
    sentAt: { type: Date, required: true },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

messageSchema.index({ chatId: 1, telegramMessageId: 1 }, { unique: true });
messageSchema.index({ chatId: 1, sentAt: -1 });

module.exports = model('Message', messageSchema);
