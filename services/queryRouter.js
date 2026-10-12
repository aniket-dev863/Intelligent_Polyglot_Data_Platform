const Product = require('../models/Product');
const { redisClient } = require('../db/redisClient');
const { logAccess } = require('../scripts/accessLogger');

const ROUTING_DECISIONS_KEY = 'routing:decisions';
const MAX_DECISIONS = 500;

/**
 * Route a product read request adaptively.
 * Decides whether to serve from Redis cache or MongoDB based on availability
 * and access history signals in `access:count`.
 * 
 * @param {string} productId 
 * @returns {Promise<{ product: Object, source: 'cache'|'mongodb', reason: string, latencyMs: number }>}
 */
async function routeProductQuery(productId) {
  const start = Date.now();
  const cacheKey = `cache:product:${productId}`;

  // 1. Check if the item exists in Redis cache
  let cached = null;
  try {
    cached = await redisClient.get(cacheKey);
  } catch (err) {
    console.warn(`[QueryRouter] Redis check failed for ${productId}:`, err.message);
  }

  if (cached) {
    const latencyMs = Date.now() - start;
    const reason = 'Cache hit: active hot item present in Redis';
    await logRoutingDecision({
      productId,
      source: 'redis-cache',
      reason,
      latencyMs,
      timestamp: new Date().toISOString(),
    });
    await logAccess({ productId, source: 'redis-cache', latencyMs });
    return {
      product: JSON.parse(cached),
      source: 'cache',
      reason,
      latencyMs,
    };
  }

  // 2. Fall back to MongoDB
  const product = await Product.findById(productId);
  if (!product) {
    const error = new Error('Product not found');
    error.status = 404;
    throw error;
  }

  // Check access count in Redis for adaptive context
  let hitCount = 0;
  try {
    const countVal = await redisClient.hGet('access:count', productId);
    hitCount = countVal ? parseInt(countVal, 10) : 0;
  } catch (err) {
    // Graceful fallback
  }

  const latencyMs = Date.now() - start;
  const reason = hitCount > 0
    ? `Cache miss: item requested ${hitCount} times previously but not currently cached in Redis`
    : 'Cache miss: cold/infrequently accessed item served directly from MongoDB';

  await logRoutingDecision({
    productId,
    source: 'mongodb',
    reason,
    latencyMs,
    timestamp: new Date().toISOString(),
  });
  await logAccess({ productId, source: 'mongodb', latencyMs });

  return {
    product: product.toObject ? product.toObject() : product,
    source: 'mongodb',
    reason,
    latencyMs,
  };
}

/**
 * Log routing decision to Redis list `routing:decisions`
 */
async function logRoutingDecision(decision) {
  try {
    await redisClient.lPush(ROUTING_DECISIONS_KEY, JSON.stringify(decision));
    await redisClient.lTrim(ROUTING_DECISIONS_KEY, 0, MAX_DECISIONS - 1);
  } catch (err) {
    console.warn('[QueryRouter] Failed to log routing decision to Redis:', err.message);
  }
}

/**
 * Get recent routing decisions
 */
async function getRecentRoutingDecisions(limit = 20) {
  try {
    const raw = await redisClient.lRange(ROUTING_DECISIONS_KEY, 0, limit - 1);
    return raw.map((item) => JSON.parse(item));
  } catch (err) {
    console.warn('[QueryRouter] Failed to retrieve routing decisions:', err.message);
    return [];
  }
}

module.exports = {
  routeProductQuery,
  logRoutingDecision,
  getRecentRoutingDecisions,
  ROUTING_DECISIONS_KEY,
};
