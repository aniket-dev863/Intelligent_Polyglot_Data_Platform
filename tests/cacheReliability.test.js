const test = require('node:test');
const assert = require('node:assert/strict');
const { connectRedis, redisClient } = require('../db/redisClient');
const { connectMongo } = require('../db/mongoClient');
const { routeProductQuery, singleFlight, inFlightRequests } = require('../services/queryRouter');
const Product = require('../models/Product');

test('Cache Reliability, Stampede Protection & Invalidation Tests', async (t) => {
  await connectRedis();
  await connectMongo();

  const testId = 'TEST_CACHE_RELIABILITY_PROD';
  const cacheKey = `cache:product:${testId}`;

  // Cleanup
  await redisClient.del(cacheKey);
  await Product.deleteOne({ _id: testId });

  await Product.create({
    _id: testId,
    name: 'Reliability Test Product',
    category: 'electronics',
    price: 149.99,
    stock: 50,
    tags: ['reliable'],
    attributes: {},
  });

  t.after(async () => {
    await redisClient.del(cacheKey);
    await Product.deleteOne({ _id: testId });
    await redisClient.quit();
    const mongoose = require('mongoose');
    await mongoose.disconnect();
  });

  await t.test('Single-flight coalesces concurrent misses into a single database read', async () => {
    let dbQueryCount = 0;
    const fetcher = async () => {
      dbQueryCount++;
      // Simulate 20ms database read latency
      await new Promise((res) => setTimeout(res, 20));
      return { id: testId, name: 'Coalesced' };
    };

    // Fire 30 simultaneous requests
    const promises = Array.from({ length: 30 }, () => singleFlight(`test-flight-${testId}`, fetcher));
    const results = await Promise.all(promises);

    assert.equal(results.length, 30);
    assert.equal(dbQueryCount, 1, 'Only one actual database read must occur for 30 concurrent requests');
    for (const r of results) {
      assert.equal(r.name, 'Coalesced');
    }
  });

  await t.test('Conventional cache-aside strategy populates Redis on cache miss with TTL', async () => {
    await redisClient.del(cacheKey);
    const beforeCheck = await redisClient.exists(cacheKey);
    assert.equal(beforeCheck, 0);

    const result = await routeProductQuery(testId, { strategy: 'cache-aside' });
    assert.equal(result.source, 'mongodb');

    const afterCheck = await redisClient.exists(cacheKey);
    assert.equal(afterCheck, 1, 'Cache-aside miss must populate Redis');

    const ttl = await redisClient.ttl(cacheKey);
    assert.ok(ttl > 0 && ttl <= 300, `TTL must be positive and bounded (actual: ${ttl})`);
  });

  await t.test('Subsequent read with populated cache returns cache-hit without MongoDB read', async () => {
    const result = await routeProductQuery(testId, { strategy: 'cache-aside' });
    assert.equal(result.source, 'cache');
    assert.equal(result.product.name, 'Reliability Test Product');
    assert.match(result.reason, /Cache hit/);
  });

  await t.test('Direct MongoDB strategy (strategy=none) bypasses Redis cache even when populated', async () => {
    const result = await routeProductQuery(testId, { strategy: 'none' });
    assert.equal(result.source, 'mongodb');
    assert.match(result.reason, /Direct catalog lookup/);
  });

  await t.test('Cache invalidation properly removes stale Redis entries on mutation', async () => {
    // Prime cache
    await redisClient.set(cacheKey, JSON.stringify({ _id: testId, name: 'Old Version', price: 149.99 }));
    assert.equal(await redisClient.exists(cacheKey), 1);

    // Simulate product update invalidation
    await Product.findByIdAndUpdate(testId, { price: 129.99 });
    await redisClient.del(cacheKey);

    assert.equal(await redisClient.exists(cacheKey), 0, 'Cache must be invalidated after update');

    // Fresh read fetches updated data
    const freshResult = await routeProductQuery(testId, { strategy: 'adaptive' });
    assert.equal(freshResult.source, 'mongodb');
    assert.equal(freshResult.product.price, 129.99);
  });
});
