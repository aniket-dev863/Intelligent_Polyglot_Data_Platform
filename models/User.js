const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // e.g. "U001"
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: 'lastUpdated' }, versionKey: false }
);

module.exports = mongoose.model('User', userSchema);
