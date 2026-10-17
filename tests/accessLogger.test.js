const test = require('node:test');
const assert = require('node:assert/strict');
const { connectRedis, redisClient } = require('../db/redisClient');
const {
  logAccess,
  getProductAccessHistory,
  getRecentWindowCount,
  getProductLifetimeCount,
  pruneAccessHistory,
} = require('../scripts/accessLogger');

test('Access Logger Telemetry, Retention, and Recent-Demand Tests', async (t) => {
  await connectRedis();

  const testProduct = 'TEST_LOG_PROD_1';
  const historyKey = `access:history:${testProduct}`;

  // Cleanup before suite
  await redisClient.del(historyKey);
  await redisClient.hDel('access:count', testProduct);

  t.after(async () => {
    await redisClient.del(historyKey);
    await redisClient.hDel('access:count', testProduct);
    await redisClient.quit();
  });

  await t.test('Empty history returns zero counts and empty array', async () => {
    const history = await getProductAccessHistory('NON_EXISTENT_PROD');
    assert.deepEqual(history, []);
    const recent = await getRecentWindowCount('NON_EXISTENT_PROD', 5);
    assert.equal(recent, 0);
    const lifetime = await getProductLifetimeCount('NON_EXISTENT_PROD');
    assert.equal(lifetime, 0);
  });

  await t.test('Aggregates multiple requests in the same minute bucket', async () => {
    const fixedNow = 1700000000000; // fixed timestamp ms
    await logAccess({ productId: testProduct, source: 'mongodb', latencyMs: 10, timestampMs: fixedNow });
    await logAccess({ productId: testProduct, source: 'cache', latencyMs: 2, timestampMs: fixedNow + 5000 });
    await logAccess({ productId: testProduct, source: 'cache', latencyMs: 3, timestampMs: fixedNow + 12000 });

    const history = await getProductAccessHistory(testProduct);
    assert.equal(history.length, 1);
    assert.equal(history[0].count, 3);
    assert.equal(history[0].timestamp, Math.floor(fixedNow / 60000) * 60);

    const lifetime = await getProductLifetimeCount(testProduct);
    assert.equal(lifetime, 3);
  });

  await t.test('Maintains chronological order across multiple minute buckets', async () => {
    const baseMs = 1700000000000;
    // Log at minute 0, minute 2, minute 1 (out of order insertion)
    await logAccess({ productId: testProduct, source: 'cache', latencyMs: 2, timestampMs: baseMs });
    await logAccess({ productId: testProduct, source: 'cache', latencyMs: 2, timestampMs: baseMs + 120000 });
    await logAccess({ productId: testProduct, source: 'cache', latencyMs: 2, timestampMs: baseMs + 60000 });

    const history = await getProductAccessHistory(testProduct);
    assert.ok(history.length >= 3);
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].timestamp > history[i - 1].timestamp, 'Must be ordered chronologically ascending');
    }
  });

  await t.test('Correctly computes recent-window demand decoupled from lifetime count', async () => {
    const nowMs = 1700010000000;
    const testDecoupleProd = 'TEST_DECOUPLE_PROD';
    await redisClient.del(`access:history:${testDecoupleProd}`);
    await redisClient.hDel('access:count', testDecoupleProd);

    // 100 requests 30 minutes ago (old burst)
    const thirtyMinsAgo = nowMs - 30 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      await logAccess({ productId: testDecoupleProd, source: 'cache', latencyMs: 1, timestampMs: thirtyMinsAgo });
    }

    // 2 requests in the last 2 minutes
    const twoMinsAgo = nowMs - 2 * 60 * 1000;
    await logAccess({ productId: testDecoupleProd, source: 'cache', latencyMs: 1, timestampMs: twoMinsAgo });
    await logAccess({ productId: testDecoupleProd, source: 'cache', latencyMs: 1, timestampMs: twoMinsAgo + 30000 });

    const lifetime = await getProductLifetimeCount(testDecoupleProd);
    assert.equal(lifetime, 12, 'Lifetime count includes all historical traffic');

    const recent5Min = await getRecentWindowCount(testDecoupleProd, 5, nowMs);
    assert.equal(recent5Min, 2, '5-minute recent window must only reflect recent 2 requests');

    const recent60Min = await getRecentWindowCount(testDecoupleProd, 60, nowMs);
    assert.equal(recent60Min, 12, '60-minute window encompasses both traffic bursts');

    await redisClient.del(`access:history:${testDecoupleProd}`);
    await redisClient.hDel('access:count', testDecoupleProd);
  });

  await t.test('Score-based retention pruning removes old buckets and preserves recent history', async () => {
    const testPruneProd = 'TEST_PRUNE_PROD';
    const key = `access:history:${testPruneProd}`;
    await redisClient.del(key);

    const nowBucket = Math.floor(1700000000 / 60) * 60; // 1699999980
    const nowMs = nowBucket * 1000;
    const retentionSeconds = 3600; // 1 hour retention

    // Insert an old entry from 2 hours ago
    await logAccess({ productId: testPruneProd, source: 'mongodb', latencyMs: 5, timestampMs: (nowBucket - 7200) * 1000 });
    // Insert a recent entry from 10 minutes ago
    await logAccess({ productId: testPruneProd, source: 'cache', latencyMs: 2, timestampMs: (nowBucket - 600) * 1000 });
    // Insert current entry
    await logAccess({ productId: testPruneProd, source: 'cache', latencyMs: 2, timestampMs: nowMs });

    // Prune with 1 hour retention window
    await pruneAccessHistory(testPruneProd, retentionSeconds, nowMs);

    const history = await getProductAccessHistory(testPruneProd);
    assert.equal(history.length, 2, 'Old 2-hour entry must be pruned, leaving 10-min and current entries');
    assert.equal(history[0].timestamp, nowBucket - 600);
    assert.equal(history[1].timestamp, nowBucket);

    await redisClient.del(key);
  });

  await t.test('Handles concurrent log requests atomically without lost updates', async () => {
    const testConcurrentProd = 'TEST_CONCURRENT_LOGGER';
    const key = `access:history:${testConcurrentProd}`;
    await redisClient.del(key);
    await redisClient.hDel('access:count', testConcurrentProd);

    const fixedMs = 1700000500000;
    const concurrency = 30;

    await Promise.all(
      Array.from({ length: concurrency }, () =>
        logAccess({ productId: testConcurrentProd, source: 'cache', latencyMs: 1, timestampMs: fixedMs })
      )
    );

    const history = await getProductAccessHistory(testConcurrentProd);
    assert.equal(history.length, 1);
    assert.equal(history[0].count, concurrency, `Sorted set bucket count must equal ${concurrency}`);

    const lifetime = await getProductLifetimeCount(testConcurrentProd);
    assert.equal(lifetime, concurrency, `Lifetime count must equal ${concurrency}`);

    await redisClient.del(key);
    await redisClient.hDel('access:count', testConcurrentProd);
  });
});
