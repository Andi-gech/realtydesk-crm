const { Schema, model } = require('mongoose');

const templateSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

module.exports = model('Template', templateSchema);
