const { Schema, model } = require('mongoose');

const ownerSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    displayName: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = model('Owner', ownerSchema);
