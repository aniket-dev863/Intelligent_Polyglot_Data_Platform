/**
 * Automatic Storage Optimizer
 * 
 * Periodically runs in background (setInterval):
 * 1. Checks access counts for recently active products.
 * 2. Calls the forecasting microservice to predict future demand.
 * 3. Promotes products to Redis (cache:product:{id}) if predicted demand >= PROMOTE_THRESHOLD.
 * 4. Demotes/evicts cached products whose actual access falls below DEMOTE_THRESHOLD.
 * 5. Logs every promote/demote decision to Redis list `optimizer:decisions`.
 */

const Product = require('../models/Product');
const { redisClient } = require('../db/redisClient');
const forecastingClient = require('./forecastingClient');


const OPTIMIZER_DECISIONS_KEY = 'optimizer:decisions';
const MAX_DECISIONS = 500;
const DEFAULT_TTL_SECONDS = 300; // 5 mins cache TTL

let optimizerIntervalId = null;

/**
 * Log an optimizer action to Redis.
 */
async function logOptimizerDecision(decision) {
  try {
    const entry = JSON.stringify({
      ...decision,
      timestamp: new Date().toISOString(),
    });
    await redisClient.lPush(OPTIMIZER_DECISIONS_KEY, entry);
    await redisClient.lTrim(OPTIMIZER_DECISIONS_KEY, 0, MAX_DECISIONS - 1);
  } catch (err) {
    console.warn('[StorageOptimizer] Error logging decision to Redis:', err.message);
  }
}

/**
 * Fetch recent optimizer decisions.
 */
async function getRecentOptimizerDecisions(limit = 20) {
  try {
    const raw = await redisClient.lRange(OPTIMIZER_DECISIONS_KEY, 0, limit - 1);
    return raw.map((r) => JSON.parse(r));
  } catch (err) {
    console.warn('[StorageOptimizer] Error fetching decisions from Redis:', err.message);
    return [];
  }
}

/**
 * Execute a single optimization evaluation cycle.
 */
async function runOptimizationCycle(options = {}) {
  const promoteThreshold = Number(options.promoteThreshold ?? process.env.OPTIMIZER_PROMOTE_THRESHOLD ?? 3);
  const demoteThreshold = Number(options.demoteThreshold ?? process.env.OPTIMIZER_DEMOTE_THRESHOLD ?? 1);
  const cacheTtl = Number(process.env.OPTIMIZER_CACHE_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);

  const results = {
    promotions: [],
    demotions: [],
    evaluations: [],
  };

  try {
    // 1. Get all known products from MongoDB
    const products = await Product.find({}, '_id name category price stock attributes tags').lean();
    if (!products || products.length === 0) return results;

    // 2. Get current access counts from Redis
    let accessCounts = {};
    try {
      accessCounts = await redisClient.hGetAll('access:count') || {};
    } catch (err) {
      console.warn('[StorageOptimizer] Failed to read access:count:', err.message);
    }

    for (const prod of products) {
      const productId = prod._id;
      const count = Number(accessCounts[productId] || 0);
      const cacheKey = `cache:product:${productId}`;
      const isCurrentlyCached = Boolean(await redisClient.exists(cacheKey));

      // Get forecast
      const forecast = await forecastingClient.getForecast(productId);
      const predictedDemand = forecast.predictedDemand;


      results.evaluations.push({
        productId,
        currentCount: count,
        predictedDemand,
        isCurrentlyCached,
      });

      // Promotion check: predictedDemand exceeds promote threshold and not yet cached
      if (predictedDemand >= promoteThreshold && !isCurrentlyCached) {
        await redisClient.set(cacheKey, JSON.stringify(prod), { EX: cacheTtl });
        const decision = {
          action: 'PROMOTE',
          productId,
          productName: prod.name,
          forecastValue: predictedDemand,
          currentAccessCount: count,
          threshold: promoteThreshold,
          reason: `High predicted demand (${predictedDemand} >= ${promoteThreshold}) promoted to Redis with TTL ${cacheTtl}s`,
        };
        await logOptimizerDecision(decision);
        results.promotions.push(decision);
        console.log(`[StorageOptimizer] PROMOTED ${productId} (${prod.name}) — forecast: ${predictedDemand}`);
      }
      // Demotion check: currently cached but actual access/forecast has fallen below demote threshold
      else if (isCurrentlyCached && (count <= demoteThreshold && predictedDemand < promoteThreshold)) {
        await redisClient.del(cacheKey);
        const decision = {
          action: 'DEMOTE',
          productId,
          productName: prod.name,
          forecastValue: predictedDemand,
          currentAccessCount: count,
          threshold: demoteThreshold,
          reason: `Access fallen below threshold (${count} <= ${demoteThreshold}) evicted from Redis`,
        };
        await logOptimizerDecision(decision);
        results.demotions.push(decision);
        console.log(`[StorageOptimizer] DEMOTED ${productId} (${prod.name}) — count: ${count}`);
      }
    }
  } catch (err) {
    console.error('[StorageOptimizer] Cycle execution error:', err.message);
  }

  return results;
}

/**
 * Start the optimizer background task.
 * Uses setInterval rather than external cron daemon because:
 * 1. Low operational overhead inside the existing Node container/process.
 * 2. Fine-grained interval configuration down to seconds.
 * 3. Gracefully stoppable via clearInterval during process teardown or unit testing.
 */
function startOptimizer(intervalSeconds = null) {
  if (optimizerIntervalId) {
    clearInterval(optimizerIntervalId);
  }

  const seconds = Number(intervalSeconds ?? process.env.OPTIMIZER_INTERVAL_SECONDS ?? 30);
  console.log(`[StorageOptimizer] Starting background optimizer every ${seconds}s`);

  // Run initial cycle
  runOptimizationCycle().catch((err) => console.error('[StorageOptimizer] Initial run error:', err.message));

  optimizerIntervalId = setInterval(() => {
    runOptimizationCycle().catch((err) => console.error('[StorageOptimizer] Interval run error:', err.message));
  }, seconds * 1000);

  // Unref so it does not block node process exit in tests
  if (optimizerIntervalId.unref) {
    optimizerIntervalId.unref();
  }
}

function stopOptimizer() {
  if (optimizerIntervalId) {
    clearInterval(optimizerIntervalId);
    optimizerIntervalId = null;
    console.log('[StorageOptimizer] Stopped');
  }
}

module.exports = {
  startOptimizer,
  stopOptimizer,
  runOptimizationCycle,
  logOptimizerDecision,
  getRecentOptimizerDecisions,
  OPTIMIZER_DECISIONS_KEY,
};
