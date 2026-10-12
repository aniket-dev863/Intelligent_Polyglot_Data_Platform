const mongoose = require('mongoose');

// Document schema: flexible "attributes" subdocument allows category-specific
// fields (e.g. batteryLifeHrs for electronics, size for apparel) without a
// rigid shared column set — the core justification for a document store here.
const productSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // e.g. "P1023"
    name: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true, min: 0 },
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
    tags: { type: [String], default: [], index: true },
    stock: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'lastUpdated' },
    versionKey: false,
  }
);

// Compound index supporting the common "browse by category, sorted by price" query
productSchema.index({ category: 1, price: 1 });

module.exports = mongoose.model('Product', productSchema);
