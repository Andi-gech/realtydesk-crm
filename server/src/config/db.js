const dns = require('dns');
const mongoose = require('mongoose');

// Configure public DNS servers to resolve MongoDB Atlas SRV records reliably on Windows
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  // fallback to system resolver
}

let cachedPromise = null;

async function connectDb() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (cachedPromise) return cachedPromise;

  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<username>') || uri.includes('<password>')) {
    throw new Error(
      'Invalid MONGO_URI. Set MONGO_URI in your environment (e.g. Vercel project settings).'
    );
  }

  mongoose.set('strictQuery', true);

  cachedPromise = mongoose.connect(uri, {
    family: 4,
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
  }).then((conn) => {
    console.log(`[db] Connected to MongoDB: ${mongoose.connection.host || 'remote cluster'}`);
    return conn;
  }).catch((err) => {
    cachedPromise = null;
    throw err;
  });

  return cachedPromise;
}

module.exports = { connectDb };
