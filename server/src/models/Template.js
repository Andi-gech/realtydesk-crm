const { Schema, model } = require('mongoose');

const templateMediaSchema = new Schema(
  {
    kind: { type: String, enum: ['photo', 'document'], default: 'photo' },
    id: { type: String },
    accessHash: { type: String },
    fileReference: { type: String }, // base64
    dcId: { type: Number },
    mimeType: { type: String },
    fileName: { type: String },
    size: { type: Number },
    // Fallback for re-upload if Telegram file reference expires
    dataUrl: { type: String },
  },
  { _id: false }
);

const templateSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, default: '' },
    media: { type: [templateMediaSchema], default: [] },
    savedMessageIds: { type: [Number], default: [] },
    createdBy: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true }
);

module.exports = model('Template', templateSchema);
