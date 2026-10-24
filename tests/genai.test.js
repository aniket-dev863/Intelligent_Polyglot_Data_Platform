const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLlmOutput } = require('../services/genai/genaiService');

test('GenAI Layer Validation Tests', async (t) => {
  await t.test('accepts valid MongoDB query output shape', () => {
    const valid = {
      type: 'query',
      store: 'mongodb',
      operation: 'find',
      filter: { category: 'electronics', maxPrice: 70 },
      explanation: 'Filtered products',
    };
    assert.doesNotThrow(() => validateLlmOutput(valid));
  });

  await t.test('accepts valid Neo4j recommendations query shape', () => {
    const valid = {
      type: 'query',
      store: 'neo4j',
      operation: 'recommendations',
      params: { productId: 'P1001' },
      explanation: 'Co-purchased graph traversal',
    };
    assert.doesNotThrow(() => validateLlmOutput(valid));
  });

  await t.test('accepts valid Neo4j customer purchases query shape', () => {
    const valid = {
      type: 'query',
      store: 'neo4j',
      operation: 'customer_purchases',
      params: { customerId: 'U001' },
      explanation: 'Customer purchases traversal',
    };
    assert.doesNotThrow(() => validateLlmOutput(valid));
  });

  await t.test('accepts valid Redis cache status and cart query shapes', () => {
    assert.doesNotThrow(() =>
      validateLlmOutput({
        type: 'query',
        store: 'redis',
        operation: 'cache_status',
        params: { productId: 'P1001' },
        explanation: 'Hot cache inspection',
      })
    );
    assert.doesNotThrow(() =>
      validateLlmOutput({
        type: 'query',
        store: 'redis',
        operation: 'cart',
        params: { cartId: 'cart_1' },
        explanation: 'Cart hash inspection',
      })
    );
  });

  await t.test('accepts valid explanation output shape', () => {
    const valid = {
      type: 'explanation',
      target: 'optimizer_decision',
      productId: 'P1001',
      explanation: 'Promoted due to high predicted demand',
    };
    assert.doesNotThrow(() => validateLlmOutput(valid));
  });

  await t.test('rejects non-object or null outputs', () => {
    assert.throws(() => validateLlmOutput(null), /Malformed LLM output/);
    assert.throws(() => validateLlmOutput('not an object'), /Malformed LLM output/);
    assert.throws(() => validateLlmOutput([1, 2, 3]), /Malformed LLM output/);
  });

  await t.test('rejects unsupported target stores or operations', () => {
    assert.throws(
      () =>
        validateLlmOutput({
          type: 'query',
          store: 'redis',
          operation: 'find',
        }),
      /unsupported store/
    );

    assert.throws(
      () =>
        validateLlmOutput({
          type: 'query',
          store: 'neo4j',
          operation: 'find',
        }),
      /unsupported store/
    );

    assert.throws(
      () =>
        validateLlmOutput({
          type: 'query',
          store: 'mongodb',
          operation: 'delete',
        }),
      /unsupported operation/
    );

    assert.throws(
      () =>
        validateLlmOutput({
          type: 'query',
          store: 'postgres',
          operation: 'select',
        }),
      /unsupported store/
    );
  });

  await t.test('rejects explanation missing plain English explanation string', () => {
    assert.throws(
      () =>
        validateLlmOutput({
          type: 'explanation',
          target: 'optimizer_decision',
        }),
      /missing plain English explanation string/
    );
  });
});
