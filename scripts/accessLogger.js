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

  // Time-windowed history: bucket by minute timestamp (seconds aligned to 60s)
  // Stored in a Redis sorted set per product: access:history:{productId}
  // Member: timestamp_in_seconds, Score: timestamp_in_seconds
  // Or we can increment bucket counts: access:history:{productId}:{minuteBucket}
  // To keep it queryable over time windows, we record an access timestamp in a sorted set:
  const nowMs = Date.now();
  const minuteBucket = Math.floor(nowMs / 60000) * 60; // epoch seconds aligned to minute
  await redisClient.zIncrBy(`access:history:${productId}`, 1, String(minuteBucket));
  // Keep last 1440 minutes (24 hours)
  const oneDayAgo = minuteBucket - 86400;
  await redisClient.zRemRangeByScore(`access:history:${productId}`, '-inf', oneDayAgo);
}

async function getRecentAccess(limit = 20) {
  const raw = await redisClient.lRange(LOG_KEY, 0, limit - 1);
  return raw.map((r) => JSON.parse(r));
}

async function getAccessCounts() {
  return redisClient.hGetAll('access:count');
}

/**
 * Get time-windowed history for a product.
 * Returns array of { timestamp: epochSeconds, count: number }
 */
async function getProductAccessHistory(productId) {
  const entries = await redisClient.zRangeWithScores(`access:history:${productId}`, 0, -1);
  return entries.map((e) => ({
    timestamp: Number(e.value),
    count: e.score,
  }));
}

module.exports = { logAccess, getRecentAccess, getAccessCounts, getProductAccessHistory };

