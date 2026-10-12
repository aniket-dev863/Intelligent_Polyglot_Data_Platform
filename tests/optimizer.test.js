const test = require('node:test');
const assert = require('node:assert/strict');
const { connectRedis, redisClient } = require('../db/redisClient');
const { connectMongo } = require('../db/mongoClient');
const { runOptimizationCycle, getRecentOptimizerDecisions } = require('../services/storageOptimizer');
const Product = require('../models/Product');
const forecastingClient = require('../services/forecastingClient');

test('Storage Optimizer Promote/Demote Decision Logic with Mocked Forecasting', async (t) => {
  await connectRedis();
  await connectMongo();

  const promoteId = 'TEST_OPT_PROMOTE';
  const demoteId = 'TEST_OPT_DEMOTE';

  // Seed two temporary products
  await Product.deleteMany({ _id: { $in: [promoteId, demoteId] } });
  await redisClient.del(`cache:product:${promoteId}`);
  await redisClient.del(`cache:product:${demoteId}`);

  await Product.create([
    {
      _id: promoteId,
      name: 'Promote Candidate',
      category: 'test',
      price: 25.0,
      stock: 50,
      tags: [],
      attributes: {},
    },
    {
      _id: demoteId,
      name: 'Demote Candidate',
      category: 'test',
      price: 30.0,
      stock: 50,
      tags: [],
      attributes: {},
    },
  ]);

  // Pre-seed demoteId into Redis cache with low access count
  await redisClient.set(`cache:product:${demoteId}`, JSON.stringify({ _id: demoteId, name: 'Demote Candidate' }));
  await redisClient.hSet('access:count', demoteId, '0');
  await redisClient.hSet('access:count', promoteId, '20');

  // Mock getForecast
  const originalGetForecast = forecastingClient.getForecast;
  forecastingClient.getForecast = async (id) => {
    if (id === promoteId) {
      return { productId: id, predictedDemand: 8.5, modelUsed: 'mock-arima' };
    }
    if (id === demoteId) {
      return { productId: id, predictedDemand: 0.2, modelUsed: 'mock-arima' };
    }
    return { productId: id, predictedDemand: 1.0, modelUsed: 'mock-baseline' };
  };

  t.after(async () => {
    forecastingClient.getForecast = originalGetForecast;
    await Product.deleteMany({ _id: { $in: [promoteId, demoteId] } });
    await redisClient.del(`cache:product:${promoteId}`);
    await redisClient.del(`cache:product:${demoteId}`);
    await redisClient.quit();
    const mongoose = require('mongoose');
    await mongoose.disconnect();
  });


  await t.test('Promotes high predicted demand items and evicts cold items', async () => {
    const cycle = await runOptimizationCycle({
      promoteThreshold: 5.0,
      demoteThreshold: 1.0,
    });

    // Check promoteId was promoted
    const promotedDecision = cycle.promotions.find((p) => p.productId === promoteId);
    assert.ok(promotedDecision, 'Should have promoted high demand item');
    assert.equal(promotedDecision.action, 'PROMOTE');

    const inCachePromote = await redisClient.exists(`cache:product:${promoteId}`);
    assert.equal(inCachePromote, 1, 'Promoted product must now exist in Redis');

    // Check demoteId was demoted
    const demotedDecision = cycle.demotions.find((d) => d.productId === demoteId);
    assert.ok(demotedDecision, 'Should have demoted low demand item');
    assert.equal(demotedDecision.action, 'DEMOTE');

    const inCacheDemote = await redisClient.exists(`cache:product:${demoteId}`);
    assert.equal(inCacheDemote, 0, 'Demoted product must be evicted from Redis');
  });
});
