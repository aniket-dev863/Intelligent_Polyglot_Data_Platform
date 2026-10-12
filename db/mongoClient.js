const mongoose = require('mongoose');

async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/polyglot_platform';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log('[MongoDB] Connected:', uri);
  return mongoose.connection;
}

module.exports = { connectMongo };
