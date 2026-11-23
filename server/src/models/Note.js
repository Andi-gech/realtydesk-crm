const { Schema, model } = require('mongoose');

const noteSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true, index: true },
    authorId: { type: Schema.Types.ObjectId, required: true },
    authorType: { type: String, enum: ['agent', 'owner'], required: true },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = model('Note', noteSchema);
