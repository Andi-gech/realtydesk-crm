const dns = require('dns');
const mongoose = require('mongoose');

// Configure public DNS servers to resolve MongoDB Atlas SRV records reliably on Windows
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  // fallback to system resolver
}

async function connectDb() {
  const uri = process.env.MONGO_URI;
  if (!uri || uri.includes('<username>') || uri.includes('<password>')) {
    throw new Error(
      'Invalid MONGO_URI in server/.env.\n' +
      'Please open server/.env and replace MONGO_URI with your MongoDB Atlas connection string.'
    );
  }

  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    console.log('[db] MongoDB connection established');
  });

  mongoose.connection.on('error', (err) => {
    console.error('[db] MongoDB connection error:', err.message || err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB disconnected, attempting auto-reconnect...');
  });

  try {
    await mongoose.connect(uri, {
      family: 4,
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
    });
    console.log(`[db] Connected to MongoDB: ${mongoose.connection.host || 'remote cluster'}`);
    return mongoose.connection;
  } catch (err) {
    console.error(`[db] MongoDB connection error: ${err.message}`);
    throw err;
  }
}

module.exports = { connectDb };
