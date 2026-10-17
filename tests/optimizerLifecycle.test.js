const test = require('node:test');
const assert = require('node:assert/strict');
const { connectRedis, redisClient } = require('../db/redisClient');
const { connectMongo } = require('../db/mongoClient');
const { runOptimizationCycle } = require('../services/storageOptimizer');
const { logAccess } = require('../scripts/accessLogger');
const Product = require('../models/Product');
const forecastingClient = require('../services/forecastingClient');

test('Storage Optimizer Full Demand Lifecycle (Promote -> Decline -> Evict -> Return)', async (t) => {
  await connectRedis();
  await connectMongo();

  const lifecycleProdId = 'TEST_LIFECYCLE_PROD';
  const cacheKey = `cache:product:${lifecycleProdId}`;
  const historyKey = `access:history:${lifecycleProdId}`;

  // Clean initial state
  await redisClient.del(cacheKey);
  await redisClient.del(historyKey);
  await redisClient.hDel('access:count', lifecycleProdId);
  await Product.deleteOne({ _id: lifecycleProdId });

  // Seed test product in MongoDB
  await Product.create({
    _id: lifecycleProdId,
    name: 'Lifecycle Dynamic Item',
    category: 'test',
    price: 49.99,
    stock: 20,
    tags: ['dynamic'],
    attributes: {},
  });

  // Injectable mock forecast state
  let simulatedForecast = 0.0;
  const originalGetForecast = forecastingClient.getForecast;
  forecastingClient.getForecast = async (id) => {
    if (id === lifecycleProdId) {
      return { productId: id, predictedDemand: simulatedForecast, modelUsed: 'mock-lifecycle' };
    }
    return { productId: id, predictedDemand: 0.0, modelUsed: 'mock-default' };
  };

  t.after(async () => {
    forecastingClient.getForecast = originalGetForecast;
    await redisClient.del(cacheKey);
    await redisClient.del(historyKey);
    await redisClient.hDel('access:count', lifecycleProdId);
    await Product.deleteOne({ _id: lifecycleProdId });
    await redisClient.quit();
    const mongoose = require('mongoose');
    await mongoose.disconnect();
  });

  const baseMs = 1700000000000;
  const promoteThreshold = 3.0;
  const demoteThreshold = 1.0;
  const recentWindowMinutes = 5;

  await t.test('Step 1: Product receives sustained traffic & predicted demand rises', async () => {
    // 10 requests within the recent 5-minute window
    for (let i = 0; i < 10; i++) {
      await logAccess({
        productId: lifecycleProdId,
        source: 'mongodb',
        latencyMs: 12,
        timestampMs: baseMs + i * 15000,
      });
    }

    simulatedForecast = 8.0; // High predicted demand
    const isCachedBefore = await redisClient.exists(cacheKey);
    assert.equal(isCachedBefore, 0, 'Initially uncached in Redis');
  });

  await t.test('Step 2: Optimizer promotes the high-demand product to Redis', async () => {
    const cycle = await runOptimizationCycle({
      promoteThreshold,
      demoteThreshold,
      recentWindowMinutes,
      nowMs: baseMs + 180000, // 3 mins after start
      force: true,
    });

    const promoted = cycle.promotions.find((p) => p.productId === lifecycleProdId);
    assert.ok(promoted, 'Product must be promoted');
    assert.equal(promoted.action, 'PROMOTE');

    const isCached = await redisClient.exists(cacheKey);
    assert.equal(isCached, 1, 'Product must now exist in Redis cache');
  });

  await t.test('Step 3: Traffic declines (no new requests in the next 15 minutes)', async () => {
    // Time advances 15 minutes ahead; lifetime count remains 10, but recent window count drops to 0
    simulatedForecast = 0.5; // Prediction drops below promote threshold

    const evaluationTime = baseMs + 18 * 60 * 1000;
    // Check that lifetime count remains 10
    const lifetimeCount = Number(await redisClient.hGet('access:count', lifecycleProdId));
    assert.equal(lifetimeCount, 10, 'Lifetime count is permanently recorded');
  });

  await t.test('Step 4 & 5: Product becomes eligible for demotion and is evicted despite high lifetime count', async () => {
    const evaluationTime = baseMs + 18 * 60 * 1000;
    const cycle = await runOptimizationCycle({
      promoteThreshold,
      demoteThreshold,
      recentWindowMinutes,
      nowMs: evaluationTime,
      force: true, // allow eviction past residence window
    });

    const demoted = cycle.demotions.find((d) => d.productId === lifecycleProdId);
    assert.ok(demoted, 'Product must be demoted when recent traffic and forecast drop, regardless of lifetime count');
    assert.equal(demoted.action, 'DEMOTE');

    const isCached = await redisClient.exists(cacheKey);
    assert.equal(isCached, 0, 'Product must be evicted from Redis');
  });

  await t.test('Step 6: Demand returns and the product becomes eligible for promotion again', async () => {
    const returnTime = baseMs + 25 * 60 * 1000;
    // Fresh burst of requests
    for (let i = 0; i < 8; i++) {
      await logAccess({
        productId: lifecycleProdId,
        source: 'mongodb',
        latencyMs: 14,
        timestampMs: returnTime + i * 10000,
      });
    }

    simulatedForecast = 6.5; // High demand forecast returns

    const cycle = await runOptimizationCycle({
      promoteThreshold,
      demoteThreshold,
      recentWindowMinutes,
      nowMs: returnTime + 120000,
      force: true,
    });

    const rePromoted = cycle.promotions.find((p) => p.productId === lifecycleProdId);
    assert.ok(rePromoted, 'Product must be re-promoted when demand surges again');
    assert.equal(rePromoted.action, 'PROMOTE');

    const isCached = await redisClient.exists(cacheKey);
    assert.equal(isCached, 1, 'Product must be back in Redis cache');
  });
});
