const { redisClient } = require('../db/redisClient');

const LOG_KEY = 'access:log';
const MAX_LOG_ENTRIES = 500;

async function logAccess({ productId, source, latencyMs }) {
  const entry = JSON.stringify({
    productId,
    source,
    latencyMs,
    timestamp: new Date().toISOString(),
  });
  await redisClient.lPush(LOG_KEY, entry);
  await redisClient.lTrim(LOG_KEY, 0, MAX_LOG_ENTRIES - 1);

  // increment per-product hit counter — this is what a future forecasting
  // engine (Review 3+) would read to decide pre-promotion
  await redisClient.hIncrBy('access:count', productId, 1);
}

async function getRecentAccess(limit = 20) {
  const raw = await redisClient.lRange(LOG_KEY, 0, limit - 1);
  return raw.map((r) => JSON.parse(r));
}

async function getAccessCounts() {
  return redisClient.hGetAll('access:count');
}

module.exports = { logAccess, getRecentAccess, getAccessCounts };
