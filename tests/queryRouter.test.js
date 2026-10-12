const test = require('node:test');
const assert = require('node:assert/strict');
const { connectRedis, redisClient } = require('../db/redisClient');
const { connectMongo } = require('../db/mongoClient');
const { routeProductQuery, getRecentRoutingDecisions } = require('../services/queryRouter');
const Product = require('../models/Product');

test('Query Router Cache-Hit vs Cache-Miss Integration Test', async (t) => {
  await connectRedis();
  await connectMongo();

  const testId = 'TEST_PROD_ROUTER';
  // Cleanup
  await redisClient.del(`cache:product:${testId}`);
  await Product.deleteOne({ _id: testId });

  // Create temporary product in MongoDB
  await Product.create({
    _id: testId,
    name: 'Test Router Product',
    category: 'test',
    price: 99.99,
    stock: 10,
    tags: ['test'],
    attributes: {},
  });

  t.after(async () => {
    await redisClient.del(`cache:product:${testId}`);
    await Product.deleteOne({ _id: testId });
    await redisClient.quit();
    const mongoose = require('mongoose');
    await mongoose.disconnect();
  });


  await t.test('Cold item results in cache miss and serves from MongoDB', async () => {
    const result = await routeProductQuery(testId);
    assert.equal(result.source, 'mongodb');
    assert.match(result.reason, /Cache miss/);
    assert.equal(result.product.name, 'Test Router Product');
  });

  await t.test('Hot promoted item results in cache hit and serves from Redis', async () => {
    // Manually prime the cache as optimizer would
    await redisClient.set(`cache:product:${testId}`, JSON.stringify({
      _id: testId,
      name: 'Test Router Product',
      category: 'test',
      price: 99.99,
    }), { EX: 60 });

    const result = await routeProductQuery(testId);
    assert.equal(result.source, 'cache');
    assert.match(result.reason, /Cache hit/);
    assert.equal(result.product.name, 'Test Router Product');
  });

  await t.test('Records routing decisions in Redis list', async () => {
    const decisions = await getRecentRoutingDecisions(5);
    assert.ok(decisions.length > 0);
    const lastDecision = decisions[0];
    assert.equal(lastDecision.productId, testId);
  });
});
