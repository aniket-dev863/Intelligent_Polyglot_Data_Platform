/**
 * Validator and Executor for GenAI Natural Language Layer
 * 
 * CRITICAL CONSTRAINT:
 * The LLM must NEVER execute a database operation directly.
 * All outputs are strictly validated against JSON schema rules before Express
 * code touches MongoDB, Redis, or Neo4j.
 */

const Product = require('../../models/Product');
const { redisClient } = require('../../db/redisClient');
const { runQuery: runNeo4j } = require('../../db/neo4jClient');
const { getRecentOptimizerDecisions } = require('../storageOptimizer');
const { getRecentRoutingDecisions } = require('../queryRouter');
const { generateStructuredResponse } = require('./llmProvider');

const ALLOWED_STORE_OPERATIONS = {
  mongodb: ['find'],
  neo4j: ['recommendations', 'customer_purchases'],
  redis: ['cart', 'cache_status'],
};

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
    if (!output.store || !ALLOWED_STORE_OPERATIONS[output.store]) {
      throw new Error(`Malformed query output: unsupported store "${output.store}"`);
    }

    // Only MongoDB supports generic 'find'
    if (output.operation === 'find' && output.store !== 'mongodb') {
      throw new Error(`Malformed query output: unsupported store "${output.store}"`);
    }

    const allowedOps = ALLOWED_STORE_OPERATIONS[output.store];
    if (!output.operation || !allowedOps.includes(output.operation)) {
      throw new Error(`Malformed query output: unsupported operation "${output.operation}"`);
    }

    if (output.filter && typeof output.filter !== 'object') {
      throw new Error('Malformed query output: filter must be an object');
    }
    if (output.params && typeof output.params !== 'object') {
      throw new Error('Malformed query output: params must be an object');
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
 * Handle natural language query end-to-end across MongoDB, Neo4j, and Redis.
 * @param {string} naturalQuery 
 */
async function processNaturalLanguageQuery(naturalQuery) {
  if (!naturalQuery || typeof naturalQuery !== 'string' || naturalQuery.trim() === '') {
    const error = new Error('query parameter must be a non-empty string');
    error.status = 400;
    throw error;
  }

  const cleanQuery = naturalQuery.trim();
  const startTime = Date.now();

  // 1. Gather context data to assist the LLM
  const idMatch = cleanQuery.match(/\b(P[0-9]{4})\b/i);
  const targetProductId = idMatch ? idMatch[1].toUpperCase() : null;

  const custMatch = cleanQuery.match(/\b(U[0-9]{3,4})\b/i);
  const targetCustomerId = custMatch ? custMatch[1].toUpperCase() : null;

  const cartMatch = cleanQuery.match(/\b(cart_[a-zA-Z0-9_-]+)\b/i);
  const targetCartId = cartMatch ? cartMatch[1] : null;

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
    for (const d of optDecisions) {
      if (d.productName && cleanQuery.toLowerCase().includes(d.productName.toLowerCase())) {
        matchingDecision = d;
        break;
      }
    }
  }

  const contextData = {
    productId: targetProductId,
    customerId: targetCustomerId,
    cartId: targetCartId,
    matchingDecision,
    recentOptimizerDecisions: optDecisions.slice(0, 5),
    recentRoutingDecisions: routeDecisions.slice(0, 5),
  };

  // 2. Call LLM provider
  const llmResponse = await generateStructuredResponse(cleanQuery, contextData);

  // 3. Strictly validate output shape against allowable AST schema
  validateLlmOutput(llmResponse);

  // 4. Safely execute based on validated shape
  if (llmResponse.type === 'error') {
    return {
      intent: 'unsupported',
      message: llmResponse.error,
      query: cleanQuery,
      latencyMs: Date.now() - startTime,
    };
  }

  if (llmResponse.type === 'explanation') {
    return {
      intent: 'explanation',
      store: 'telemetry',
      target: llmResponse.target || 'optimizer_decision',
      productId: llmResponse.productId || targetProductId,
      explanation: llmResponse.explanation,
      matchedRecord: matchingDecision || null,
      queryPlan: {
        targetStore: 'Redis Telemetry & Optimization Event Bus',
        engine: 'Time-Series Decision Log (optimizer:decisions)',
        security: 'In-Memory Read-Only Audit Inspection',
      },
      latencyMs: Date.now() - startTime,
      rawQuery: cleanQuery,
    };
  }

  if (llmResponse.type === 'query') {
    // ----------------------------------------------------
    // STORE 1: MONGODB (Product Catalog & Documents)
    // ----------------------------------------------------
    if (llmResponse.store === 'mongodb' && llmResponse.operation === 'find') {
      const mongoFilter = {};
      const { category, maxPrice, minPrice, tags, keyword } = llmResponse.filter || {};

      if (category && typeof category === 'string') {
        mongoFilter.category = category.toLowerCase().trim();
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
        const sanitizedTags = tags.filter((t) => typeof t === 'string' && t.trim().length > 0 && t.length <= 50);
        if (sanitizedTags.length > 0) {
          mongoFilter.tags = { $in: sanitizedTags };
        }
      }

      if (keyword && typeof keyword === 'string' && keyword.trim().length > 0) {
        const escaped = keyword.trim().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        mongoFilter.name = { $regex: escaped, $options: 'i' };
      }

      const products = await Product.find(mongoFilter).limit(20).lean();

      return {
        intent: 'product_search',
        store: 'mongodb',
        operation: 'find',
        filterApplied: mongoFilter,
        explanation: llmResponse.explanation || `Filtered MongoDB catalog with ${JSON.stringify(mongoFilter)}`,
        resultCount: products.length,
        products,
        queryPlan: {
          targetStore: 'MongoDB (Catalog & Flexible Document Attributes)',
          collection: 'products',
          filter: mongoFilter,
          limit: 20,
          security: 'Strict Schema Filter Whitelist (No Raw Script / Injection)',
        },
        latencyMs: Date.now() - startTime,
        rawQuery: cleanQuery,
      };
    }

    // ----------------------------------------------------
    // STORE 2: NEO4J (Graph Analytics & Traversal)
    // ----------------------------------------------------
    if (llmResponse.store === 'neo4j') {
      if (llmResponse.operation === 'recommendations') {
        const pid = (llmResponse.params?.productId || targetProductId || 'P1001').toUpperCase();
        let recommendations = [];
        try {
          const cypher = `
            MATCH (p1:Product {id: $productId})<-[:PURCHASED]-(c:Customer)-[:PURCHASED]->(p2:Product)
            WHERE p1 <> p2
            RETURN p2.id AS productId, count(DISTINCT c) AS coPurchaseStrength
            ORDER BY coPurchaseStrength DESC
            LIMIT 5
          `;
          const raw = await runNeo4j(cypher, { productId: pid });
          
          // Enrich with product name and category from MongoDB
          const ids = raw.map((r) => r.productId);
          const metaProducts = await Product.find({ _id: { $in: ids } }).lean();
          const metaMap = new Map(metaProducts.map((p) => [p._id, p]));

          recommendations = raw.map((r) => {
            const strVal = r.coPurchaseStrength;
            const strength = typeof strVal === 'object' && strVal !== null && 'toNumber' in strVal
              ? strVal.toNumber()
              : Number(strVal);
            const meta = metaMap.get(r.productId) || {};
            return {
              productId: r.productId,
              name: meta.name || r.productId,
              category: meta.category || 'General',
              price: meta.price || 0,
              coPurchaseStrength: strength,
            };
          });
        } catch (err) {
          console.warn('[GenAI Neo4j] Query fallback:', err.message);
        }

        return {
          intent: 'graph_recommendations',
          store: 'neo4j',
          operation: 'recommendations',
          productId: pid,
          explanation: llmResponse.explanation || `Graph traversal found ${recommendations.length} items co-purchased with ${pid}`,
          resultCount: recommendations.length,
          recommendations,
          queryPlan: {
            targetStore: 'Neo4j (Customer-Product Knowledge Graph)',
            cypherPattern: '(Product {id})<-[:PURCHASED]-(Customer)-[:PURCHASED]->(Product)',
            parameters: { productId: pid },
            security: 'Parameterized Cypher Query (Guarded against injection)',
          },
          latencyMs: Date.now() - startTime,
          rawQuery: cleanQuery,
        };
      }

      if (llmResponse.operation === 'customer_purchases') {
        const cid = (llmResponse.params?.customerId || targetCustomerId || 'U001').toUpperCase();
        let purchases = [];
        try {
          const cypher = `
            MATCH (c:Customer {id: $customerId})-[r:PURCHASED]->(p:Product)
            RETURN p.id AS productId, r.quantity AS quantity, toString(r.timestamp) AS timestamp
            ORDER BY r.timestamp DESC
            LIMIT 10
          `;
          const raw = await runNeo4j(cypher, { customerId: cid });
          purchases = raw.map((r) => {
            const qty = typeof r.quantity === 'object' && r.quantity !== null && 'toNumber' in r.quantity
              ? r.quantity.toNumber()
              : Number(r.quantity);
            return {
              productId: r.productId,
              quantity: qty,
              timestamp: r.timestamp,
            };
          });
        } catch (err) {
          console.warn('[GenAI Neo4j] Purchase history query fallback:', err.message);
        }

        return {
          intent: 'customer_history',
          store: 'neo4j',
          operation: 'customer_purchases',
          customerId: cid,
          explanation: llmResponse.explanation || `Found ${purchases.length} purchases for customer ${cid}`,
          resultCount: purchases.length,
          purchases,
          queryPlan: {
            targetStore: 'Neo4j (Customer Purchase Graph)',
            cypherPattern: '(Customer {id})-[PURCHASED]->(Product)',
            parameters: { customerId: cid },
            security: 'Parameterized Traversal Query',
          },
          latencyMs: Date.now() - startTime,
          rawQuery: cleanQuery,
        };
      }
    }

    // ----------------------------------------------------
    // STORE 3: REDIS (Hot Cache, Telemetry & Session Cart)
    // ----------------------------------------------------
    if (llmResponse.store === 'redis') {
      if (llmResponse.operation === 'cart') {
        const cartId = llmResponse.params?.cartId || targetCartId || 'cart_1';
        let cartItems = {};
        try {
          cartItems = await redisClient.hGetAll(`cart:${cartId}`);
        } catch (err) {
          console.warn('[GenAI Redis] Cart read error:', err.message);
        }

        return {
          intent: 'cart_inspection',
          store: 'redis',
          operation: 'cart',
          cartId,
          explanation: llmResponse.explanation || `Inspected active session items in cart "${cartId}"`,
          resultCount: Object.keys(cartItems).length,
          cart: cartItems,
          queryPlan: {
            targetStore: 'Redis (In-Memory Key-Value / Session Hash)',
            command: `HGETALL cart:${cartId}`,
            security: 'Namespace-Restricted Hash Read',
          },
          latencyMs: Date.now() - startTime,
          rawQuery: cleanQuery,
        };
      }

      if (llmResponse.operation === 'cache_status') {
        const pid = (llmResponse.params?.productId || targetProductId || 'P1001').toUpperCase();
        let isCached = false;
        let ttlSeconds = null;
        let lifetimeRequests = 0;
        let cachedPayload = null;

        try {
          const [cachedRaw, ttl, lifetime] = await Promise.all([
            redisClient.get(`cache:product:${pid}`),
            redisClient.ttl(`cache:product:${pid}`),
            redisClient.get(`access:count:${pid}`),
          ]);
          isCached = !!cachedRaw;
          ttlSeconds = ttl > 0 ? ttl : null;
          lifetimeRequests = Number(lifetime) || 0;
          if (cachedRaw) {
            try { cachedPayload = JSON.parse(cachedRaw); } catch { cachedPayload = cachedRaw; }
          }
        } catch (err) {
          console.warn('[GenAI Redis] Cache inspect error:', err.message);
        }

        return {
          intent: 'cache_inspection',
          store: 'redis',
          operation: 'cache_status',
          productId: pid,
          isCached,
          ttlSeconds,
          lifetimeRequests,
          cachedPayload,
          explanation: llmResponse.explanation || `Product ${pid} is currently ${isCached ? `HOT in Redis cache (TTL: ${ttlSeconds}s)` : 'COLD (Not stored in Redis cache tier)'}`,
          queryPlan: {
            targetStore: 'Redis (In-Memory Hot Cache & Telemetry)',
            commands: [`GET cache:product:${pid}`, `TTL cache:product:${pid}`, `GET access:count:${pid}`],
            security: 'Read-Only Key Query',
          },
          latencyMs: Date.now() - startTime,
          rawQuery: cleanQuery,
        };
      }
    }
  }

  throw new Error('Unhandled response type from GenAI layer');
}

module.exports = {
  validateLlmOutput,
  processNaturalLanguageQuery,
  ALLOWED_STORE_OPERATIONS,
};
