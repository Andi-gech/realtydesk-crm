const { Schema, model } = require('mongoose');

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'Owner', required: true },
    settings: {
      maxAgentsPerCode: { type: Number, default: 10 },
    },
  },
  { timestamps: true }
);

module.exports = model('Organization', organizationSchema);
