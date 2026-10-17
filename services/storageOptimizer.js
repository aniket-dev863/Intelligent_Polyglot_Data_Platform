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
const { getRecentWindowCount, getAccessCounts } = require('../scripts/accessLogger');
const forecastingClient = require('./forecastingClient');

const OPTIMIZER_DECISIONS_KEY = 'optimizer:decisions';
const MAX_DECISIONS = 500;
const DEFAULT_TTL_SECONDS = 300; // 5 mins cache TTL
const DEFAULT_RECENT_WINDOW_MINUTES = 5;
const DEFAULT_MAX_ACTIONS_PER_CYCLE = 25;
const DEFAULT_MIN_RESIDENCE_MS = 15000; // 15s before eligible for eviction

let optimizerIntervalId = null;
const promotionTimestamps = new Map();

/**
 * Concurrency runner to execute async tasks with bounded concurrency.
 */
async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    if (concurrency <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

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
 * Decouples lifetime cumulative counters from recent observation window demand.
 */
async function runOptimizationCycle(options = {}) {
  const promoteThreshold = Number(options.promoteThreshold ?? process.env.OPTIMIZER_PROMOTE_THRESHOLD ?? 3);
  const demoteThreshold = Number(options.demoteThreshold ?? process.env.OPTIMIZER_DEMOTE_THRESHOLD ?? 1);
  const cacheTtl = Number(options.cacheTtl ?? process.env.OPTIMIZER_CACHE_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  const recentWindowMinutes = Number(options.recentWindowMinutes ?? process.env.OPTIMIZER_RECENT_WINDOW_MINUTES ?? DEFAULT_RECENT_WINDOW_MINUTES);
  const maxActions = Number(options.maxActionsPerCycle ?? DEFAULT_MAX_ACTIONS_PER_CYCLE);
  const nowMs = options.nowMs != null ? Number(options.nowMs) : Date.now();
  const force = Boolean(options.force);
  const concurrency = Number(options.concurrency ?? 5);

  const results = {
    promotions: [],
    demotions: [],
    evaluations: [],
  };

  try {
    // 1. Get all known products from MongoDB
    const products = await Product.find({}, '_id name category price stock attributes tags').lean();
    if (!products || products.length === 0) return results;

    // 2. Get lifetime access counts
    const accessCounts = await getAccessCounts();

    // 3. Evaluate products under bounded concurrency
    await mapConcurrent(products, concurrency, async (prod) => {
      const productId = prod._id;
      const lifetimeCount = Number(accessCounts[productId] || 0);
      const recentCount = await getRecentWindowCount(productId, recentWindowMinutes, nowMs);
      const cacheKey = `cache:product:${productId}`;
      const isCurrentlyCached = Boolean(await redisClient.exists(cacheKey));

      // Get forecast for next window
      const forecast = await forecastingClient.getForecast(productId, recentWindowMinutes);
      const predictedDemand = Number(forecast.predictedDemand || 0);

      results.evaluations.push({
        productId,
        lifetimeCount,
        recentCount,
        currentCount: recentCount, // backwards-compatible alias
        predictedDemand,
        isCurrentlyCached,
      });

      // Promotion check: predicted demand exceeds promote threshold (or recent demand burst) and not yet cached
      const shouldPromote = (predictedDemand >= promoteThreshold || recentCount >= promoteThreshold) && !isCurrentlyCached;
      if (shouldPromote && results.promotions.length < maxActions) {
        await redisClient.set(cacheKey, JSON.stringify(prod), { EX: cacheTtl });
        promotionTimestamps.set(productId, nowMs);

        const decision = {
          action: 'PROMOTE',
          productId,
          productName: prod.name,
          forecastValue: predictedDemand,
          currentAccessCount: lifetimeCount,
          recentAccessCount: recentCount,
          threshold: promoteThreshold,
          reason: `High predicted demand (${predictedDemand} >= ${promoteThreshold}) or recent burst (${recentCount}) promoted to Redis with TTL ${cacheTtl}s`,
        };
        await logOptimizerDecision(decision);
        results.promotions.push(decision);
        console.log(`[StorageOptimizer] PROMOTED ${productId} (${prod.name}) — forecast: ${predictedDemand}, recent: ${recentCount}`);
        return;
      }

      // Demotion check: currently cached, recent demand has cooled, and predicted demand is below threshold
      const promotedAt = promotionTimestamps.get(productId) || 0;
      const residenceTimeOk = force || (nowMs - promotedAt >= DEFAULT_MIN_RESIDENCE_MS);
      const shouldDemote = isCurrentlyCached && (recentCount <= demoteThreshold && predictedDemand < promoteThreshold) && residenceTimeOk;

      if (shouldDemote && results.demotions.length < maxActions) {
        await redisClient.del(cacheKey);
        promotionTimestamps.delete(productId);

        const decision = {
          action: 'DEMOTE',
          productId,
          productName: prod.name,
          forecastValue: predictedDemand,
          currentAccessCount: lifetimeCount,
          recentAccessCount: recentCount,
          threshold: demoteThreshold,
          reason: `Recent access (${recentCount} <= ${demoteThreshold}) and low forecast (${predictedDemand} < ${promoteThreshold}) evicted from Redis`,
        };
        await logOptimizerDecision(decision);
        results.demotions.push(decision);
        console.log(`[StorageOptimizer] DEMOTED ${productId} (${prod.name}) — recentCount: ${recentCount}, forecast: ${predictedDemand}`);
      }
    });
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
