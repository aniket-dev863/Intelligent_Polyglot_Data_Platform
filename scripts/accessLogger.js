const { redisClient } = require('../db/redisClient');

const LOG_KEY = 'access:log';
const MAX_LOG_ENTRIES = 500;
const RETENTION_SECONDS = Number(process.env.ACCESS_HISTORY_RETENTION_SECONDS || 86400); // 24 hours default

/**
 * Atomic Lua script to log an access event into a time-windowed sorted set.
 * - Score is the minute bucket timestamp (epoch seconds), ensuring strict chronological ordering.
 * - Member encodes the bucket and count: "<minuteBucket>:<count>".
 * - Old entries strictly older than cutoff timestamp are pruned safely by score without touching recent history.
 */
const LUA_LOG_ACCESS = `
local key = KEYS[1]
local bucket = tonumber(ARGV[1])
local cutoff = tonumber(ARGV[2])
local inc = tonumber(ARGV[3] or 1)

local matches = redis.call('ZRANGEBYSCORE', key, bucket, bucket)
local currentCount = 0
if #matches > 0 then
  local oldMember = matches[1]
  local sep = string.find(oldMember, ':')
  if sep then
    currentCount = tonumber(string.sub(oldMember, sep + 1)) or 0
  else
    currentCount = tonumber(redis.call('ZSCORE', key, oldMember)) or 0
  end
  redis.call('ZREM', key, oldMember)
end

local newCount = currentCount + inc
local newMember = bucket .. ':' .. newCount
redis.call('ZADD', key, bucket, newMember)

if cutoff and cutoff > 0 then
  redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. cutoff)
end

return newCount
`;

/**
 * Log a single access event across telemetry structures:
 * 1. Global rolling log list (access:log)
 * 2. Lifetime product counter (access:count)
 * 3. Chronological minute-bucketed sorted set (access:history:{productId})
 */
async function logAccess({ productId, source, latencyMs, timestampMs = null }) {
  if (!productId) return;

  const nowMs = timestampMs != null ? Number(timestampMs) : Date.now();
  const entry = JSON.stringify({
    productId,
    source,
    latencyMs,
    timestamp: new Date(nowMs).toISOString(),
  });

  try {
    await redisClient.lPush(LOG_KEY, entry);
    await redisClient.lTrim(LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
  } catch (err) {
    console.warn(`[AccessLogger] Failed to push to access:log for ${productId}:`, err.message);
  }

  // Increment lifetime per-product request counter
  try {
    await redisClient.hIncrBy('access:count', productId, 1);
  } catch (err) {
    console.warn(`[AccessLogger] Failed to increment lifetime count for ${productId}:`, err.message);
  }

  // Time-windowed history: bucket by minute timestamp (epoch seconds aligned to 60s)
  const minuteBucket = Math.floor(nowMs / 60000) * 60;
  const cutoff = minuteBucket - RETENTION_SECONDS;
  try {
    await redisClient.eval(LUA_LOG_ACCESS, {
      keys: [`access:history:${productId}`],
      arguments: [String(minuteBucket), String(cutoff), '1'],
    });
  } catch (err) {
    console.warn(`[AccessLogger] Failed to record access history for ${productId}:`, err.message);
  }
}

async function getRecentAccess(limit = 20) {
  try {
    const raw = await redisClient.lRange(LOG_KEY, 0, limit - 1);
    return raw.map((r) => JSON.parse(r));
  } catch (err) {
    console.warn('[AccessLogger] Failed to get recent access:', err.message);
    return [];
  }
}

async function getAccessCounts() {
  try {
    return (await redisClient.hGetAll('access:count')) || {};
  } catch (err) {
    console.warn('[AccessLogger] Failed to get access counts:', err.message);
    return {};
  }
}

async function getProductLifetimeCount(productId) {
  try {
    const countVal = await redisClient.hGet('access:count', productId);
    return countVal ? parseInt(countVal, 10) : 0;
  } catch (err) {
    console.warn(`[AccessLogger] Failed to get lifetime count for ${productId}:`, err.message);
    return 0;
  }
}

/**
 * Get time-windowed history for a product.
 * Returns array of { timestamp: epochSeconds, count: number } ordered chronologically.
 */
async function getProductAccessHistory(productId, { startTimestamp = null, endTimestamp = null } = {}) {
  try {
    const key = `access:history:${productId}`;
    const entries = await redisClient.zRangeWithScores(key, 0, -1);
    if (!entries || entries.length === 0) return [];

    const result = [];
    for (const e of entries) {
      const val = String(e.value);
      const sep = val.indexOf(':');
      const timestamp = sep !== -1 ? Number(val.substring(0, sep)) : Number(e.score);
      const count = sep !== -1 ? Number(val.substring(sep + 1)) : Number(e.score);

      if (startTimestamp != null && timestamp < startTimestamp) continue;
      if (endTimestamp != null && timestamp > endTimestamp) continue;

      result.push({
        timestamp: isNaN(timestamp) ? Number(e.score) : timestamp,
        count: isNaN(count) ? 1 : count,
      });
    }

    return result.sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    console.warn(`[AccessLogger] Failed to get history for ${productId}:`, err.message);
    return [];
  }
}

/**
 * Get aggregated request count within the recent observation window (e.g. last N minutes).
 * This cleanly decouples recent burst/taper demand from cumulative lifetime count.
 */
async function getRecentWindowCount(productId, windowMinutes = 5, nowMs = Date.now()) {
  try {
    const windowSeconds = Math.max(1, windowMinutes) * 60;
    const currentBucket = Math.floor(nowMs / 60000) * 60;
    const cutoff = currentBucket - windowSeconds;

    const history = await getProductAccessHistory(productId, { startTimestamp: cutoff });
    return history.reduce((sum, entry) => sum + entry.count, 0);
  } catch (err) {
    console.warn(`[AccessLogger] Failed to compute recent window count for ${productId}:`, err.message);
    return 0;
  }
}

/**
 * Explicitly prune access history entries older than retentionSeconds.
 */
async function pruneAccessHistory(productId, retentionSeconds = RETENTION_SECONDS, nowMs = Date.now()) {
  try {
    const minuteBucket = Math.floor(nowMs / 60000) * 60;
    const cutoff = minuteBucket - retentionSeconds;
    return await redisClient.zRemRangeByScore(`access:history:${productId}`, '-inf', `(${cutoff}`);
  } catch (err) {
    console.warn(`[AccessLogger] Failed to prune history for ${productId}:`, err.message);
    return 0;
  }
}

module.exports = {
  logAccess,
  getRecentAccess,
  getAccessCounts,
  getProductLifetimeCount,
  getProductAccessHistory,
  getRecentWindowCount,
  pruneAccessHistory,
  RETENTION_SECONDS,
  LUA_LOG_ACCESS,
};


