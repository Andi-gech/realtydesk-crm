const { Schema, model } = require('mongoose');

const activationCodeSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    code: { type: String, required: true, unique: true, index: true },
    maxUses: { type: Number, default: 1 },
    usesCount: { type: Number, default: 0 },
    expiresAt: { type: Date },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

activationCodeSchema.methods.isRedeemable = function isRedeemable() {
  if (!this.active) return false;
  if (this.expiresAt && this.expiresAt.getTime() < Date.now()) return false;
  if (this.usesCount >= this.maxUses) return false;
  return true;
};

module.exports = model('ActivationCode', activationCodeSchema);
