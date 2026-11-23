const { Schema, model } = require('mongoose');

/**
 * Record of a Telegram account linked by an agent or owner.
 *
 * Metadata only. The MTProto session string lives exclusively in the OS
 * keychain on the device that created it and is keyed by this document's
 * `_id`. See docs/BUILD_SPEC.md §2.
 */
const telegramAccountSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    ownerType: { type: String, enum: ['agent', 'owner'], required: true },
    // Polymorphic reference: Agent._id when ownerType === 'agent', Owner._id when 'owner'
    ownerRefId: { type: Schema.Types.ObjectId, required: true, index: true },
    telegramUserId: { type: String, required: true },
    displayName: { type: String, trim: true },
    username: { type: String, trim: true },
    phoneMasked: { type: String },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    linkedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date },
  },
  { timestamps: true }
);

telegramAccountSchema.index({ orgId: 1, telegramUserId: 1 }, { unique: true });

module.exports = model('TelegramAccount', telegramAccountSchema);
