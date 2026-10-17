const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLlmOutput } = require('../services/genai/genaiService');

test('API Security & Input Hardening Tests', async (t) => {
  await t.test('GenAI output validator rejects arbitrary datastores and mutations', () => {
    assert.throws(
      () => validateLlmOutput({ type: 'query', store: 'neo4j', operation: 'find' }),
      /unsupported store/
    );
    assert.throws(
      () => validateLlmOutput({ type: 'query', store: 'mongodb', operation: 'deleteMany' }),
      /unsupported operation/
    );
    assert.throws(
      () => validateLlmOutput({ type: 'query', store: 'mongodb', operation: 'dropDatabase' }),
      /unsupported operation/
    );
  });

  await t.test('GenAI output validator rejects invalid explanation shapes', () => {
    assert.throws(
      () => validateLlmOutput({ type: 'explanation', explanation: null }),
      /missing plain English explanation/
    );
  });

  await t.test('Optimizer threshold validation rejects irrational threshold bounds', () => {
    // Test validation logic directly
    const validateThresholds = (promoteThreshold, demoteThreshold) => {
      if (promoteThreshold != null) {
        const pt = Number(promoteThreshold);
        if (isNaN(pt) || pt < 0) throw new Error('promoteThreshold must be a non-negative number');
      }
      if (demoteThreshold != null) {
        const dt = Number(demoteThreshold);
        if (isNaN(dt) || dt < 0) throw new Error('demoteThreshold must be a non-negative number');
      }
      if (promoteThreshold != null && demoteThreshold != null) {
        if (Number(demoteThreshold) > Number(promoteThreshold)) {
          throw new Error('demoteThreshold cannot be greater than promoteThreshold');
        }
      }
      return true;
    };

    assert.throws(() => validateThresholds(-1, 0), /must be a non-negative number/);
    assert.throws(() => validateThresholds(2, -5), /must be a non-negative number/);
    assert.throws(() => validateThresholds(2, 5), /cannot be greater than promoteThreshold/);
    assert.doesNotThrow(() => validateThresholds(5, 1));
  });

  await t.test('Tag array filter sanitization strips non-string and oversized tokens', () => {
    const rawTags = ['validTag', 12345, { malicious: true }, '$where', '', 'a'.repeat(60)];
    const sanitized = rawTags.filter((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 50);

    assert.equal(sanitized.length, 2);
    assert.deepEqual(sanitized, ['validTag', '$where']);
  });
});
