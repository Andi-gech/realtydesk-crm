const { Schema, model } = require('mongoose');

const agentSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    displayName: { type: String, required: true, trim: true },
    username: { type: String, trim: true, lowercase: true, unique: true, sparse: true, index: true },
    passwordHash: { type: String },
    role: { type: String, default: 'agent' },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    activationCodeUsed: { type: String },
    lastSeenAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = model('Agent', agentSchema);
