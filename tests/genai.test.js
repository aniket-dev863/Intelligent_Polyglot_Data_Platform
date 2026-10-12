const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLlmOutput } = require('../services/genai/genaiService');

test('GenAI Layer Validation Tests', async (t) => {
  await t.test('accepts valid query output shape', () => {
    const valid = {
      type: 'query',
      store: 'mongodb',
      operation: 'find',
      filter: { category: 'electronics', maxPrice: 70 },
      explanation: 'Filtered products',
    };
    assert.doesNotThrow(() => validateLlmOutput(valid));
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
    assert.throws(() => validateLlmOutput({
      type: 'query',
      store: 'redis', // not allowed directly
      operation: 'find',
    }), /unsupported store/);

    assert.throws(() => validateLlmOutput({
      type: 'query',
      store: 'mongodb',
      operation: 'delete', // only find is allowed
    }), /unsupported operation/);
  });

  await t.test('rejects explanation missing plain English explanation string', () => {
    assert.throws(() => validateLlmOutput({
      type: 'explanation',
      target: 'optimizer_decision',
    }), /missing plain English explanation string/);
  });
});
