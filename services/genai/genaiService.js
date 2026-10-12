/**
 * Validator and Executor for GenAI Natural Language Layer
 * 
 * CRITICAL CONSTRAINT:
 * The LLM must NEVER execute a database operation directly.
 * All outputs are strictly validated against JSON schema rules before Express
 * code touches MongoDB, Redis, or Neo4j.
 */

const Product = require('../../models/Product');
const { getRecentOptimizerDecisions } = require('../storageOptimizer');
const { getRecentRoutingDecisions } = require('../queryRouter');
const { generateStructuredResponse } = require('./llmProvider');

/**
 * Validate LLM structured JSON output.
 * Throws an Error with a descriptive message if invalid.
 */
function validateLlmOutput(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('Malformed LLM output: expected a JSON object');
  }

  const { type } = output;
  if (!type || !['query', 'explanation', 'error'].includes(type)) {
    throw new Error(`Malformed LLM output: invalid or missing type "${type}"`);
  }

  if (type === 'query') {
    if (output.store !== 'mongodb') {
      throw new Error(`Malformed query output: unsupported store "${output.store}"`);
    }
    if (output.operation !== 'find') {
      throw new Error(`Malformed query output: unsupported operation "${output.operation}"`);
    }
    if (output.filter && typeof output.filter !== 'object') {
      throw new Error('Malformed query output: filter must be an object');
    }
  }

  if (type === 'explanation') {
    if (!output.explanation || typeof output.explanation !== 'string') {
      throw new Error('Malformed explanation output: missing plain English explanation string');
    }
  }

  if (type === 'error') {
    if (!output.error) {
      throw new Error('Malformed error output: missing error reason string');
    }
  }

  return true;
}

/**
 * Handle natural language query end-to-end.
 * @param {string} naturalQuery 
 */
async function processNaturalLanguageQuery(naturalQuery) {
  if (!naturalQuery || typeof naturalQuery !== 'string' || naturalQuery.trim() === '') {
    const error = new Error('query parameter must be a non-empty string');
    error.status = 400;
    throw error;
  }

  const cleanQuery = naturalQuery.trim();

  // 1. Gather context data to assist the LLM
  // Extract potential product ID tokens (e.g. P1001, P1002)
  const idMatch = cleanQuery.match(/\b(P[0-9]{4})\b/i);
  const targetProductId = idMatch ? idMatch[1].toUpperCase() : null;

  // Fetch recent decisions for context
  const [optDecisions, routeDecisions] = await Promise.all([
    getRecentOptimizerDecisions(30),
    getRecentRoutingDecisions(30),
  ]);

  let matchingDecision = null;
  if (targetProductId) {
    matchingDecision = optDecisions.find((d) => d.productId?.toUpperCase() === targetProductId)
      || routeDecisions.find((d) => d.productId?.toUpperCase() === targetProductId);
  } else {
    // If no explicit product id in query, check if product name is mentioned
    for (const d of optDecisions) {
      if (d.productName && cleanQuery.toLowerCase().includes(d.productName.toLowerCase())) {
        matchingDecision = d;
        break;
      }
    }
  }

  const contextData = {
    productId: targetProductId,
    matchingDecision,
    recentOptimizerDecisions: optDecisions.slice(0, 5),
    recentRoutingDecisions: routeDecisions.slice(0, 5),
  };

  // 2. Call LLM provider
  const llmResponse = await generateStructuredResponse(cleanQuery, contextData);

  // 3. Strictly validate output shape
  validateLlmOutput(llmResponse);

  // 4. Safely execute based on validated shape
  if (llmResponse.type === 'error') {
    return {
      intent: 'unsupported',
      message: llmResponse.error,
      query: cleanQuery,
    };
  }

  if (llmResponse.type === 'explanation') {
    return {
      intent: 'explanation',
      target: llmResponse.target || 'optimizer_decision',
      productId: llmResponse.productId || targetProductId,
      explanation: llmResponse.explanation,
      matchedRecord: matchingDecision || null,
      rawQuery: cleanQuery,
    };
  }

  if (llmResponse.type === 'query') {
    // Safely construct MongoDB query from the validated filter
    const mongoFilter = {};
    const { category, maxPrice, minPrice, tags } = llmResponse.filter || {};

    if (category && typeof category === 'string') {
      mongoFilter.category = category.toLowerCase();
    }

    if (maxPrice != null || minPrice != null) {
      mongoFilter.price = {};
      if (maxPrice != null && !isNaN(maxPrice)) {
        mongoFilter.price.$lte = Number(maxPrice);
      }
      if (minPrice != null && !isNaN(minPrice)) {
        mongoFilter.price.$gte = Number(minPrice);
      }
    }

    if (tags && Array.isArray(tags) && tags.length > 0) {
      mongoFilter.tags = { $in: tags };
    }

    // Execute safe query via Mongoose
    const products = await Product.find(mongoFilter).limit(20).lean();

    return {
      intent: 'product_search',
      filterApplied: mongoFilter,
      explanation: llmResponse.explanation,
      resultCount: products.length,
      products,
      rawQuery: cleanQuery,
    };
  }

  throw new Error('Unhandled response type from GenAI layer');
}

module.exports = {
  validateLlmOutput,
  processNaturalLanguageQuery,
};
