/**
 * Swappable LLM Provider Client
 * Supports OpenAI, Anthropic, or Mock provider (fallback when no API key is supplied).
 */

const SYSTEM_PROMPT = `
You are the natural language query translation and routing assistant for an Intelligent Polyglot Data Platform.
You NEVER execute database commands directly.
You MUST output ONLY a valid single JSON object matching one of the schemas below without markdown ticks, code blocks, or preamble.

Schema 1: Product Catalog Search (Target: MongoDB)
{
  "type": "query",
  "store": "mongodb",
  "operation": "find",
  "filter": {
    "category": "<optional lowercase string, e.g. 'electronics' | 'fitness' | 'fashion' | 'home'>",
    "maxPrice": "<optional number>",
    "minPrice": "<optional number>",
    "tags": "<optional array of strings>",
    "keyword": "<optional search term string>"
  },
  "explanation": "<short explanation of the filter applied>"
}

Schema 2: Graph Analysis & Recommendations (Target: Neo4j)
For "bought together", "recommendations", or "co-purchased":
{
  "type": "query",
  "store": "neo4j",
  "operation": "recommendations",
  "params": {
    "productId": "<extracted product id string, e.g. 'P1001'>"
  },
  "explanation": "<short explanation of the graph traversal>"
}
For "what did customer X buy" or "customer purchase history":
{
  "type": "query",
  "store": "neo4j",
  "operation": "customer_purchases",
  "params": {
    "customerId": "<extracted customer id string, e.g. 'U001'>"
  },
  "explanation": "<short explanation of customer purchase query>"
}

Schema 3: In-Memory Hot Cache & Cart Inspection (Target: Redis)
For "is product cached" or "check hot cache status":
{
  "type": "query",
  "store": "redis",
  "operation": "cache_status",
  "params": {
    "productId": "<extracted product id string, e.g. 'P1001'>"
  },
  "explanation": "<short explanation>"
}
For "what is in cart" or "view cart items":
{
  "type": "query",
  "store": "redis",
  "operation": "cart",
  "params": {
    "cartId": "<extracted cart id string, e.g. 'cart_1'>"
  },
  "explanation": "<short explanation>"
}

Schema 4: System Decision Explanation
{
  "type": "explanation",
  "target": "optimizer_decision" | "routing_decision",
  "productId": "<extracted product id or null>",
  "explanation": "<plain English explanation summarizing why the product was cached, promoted, or routed>"
}

Schema 5: Unsupported / Error Query
{
  "type": "error",
  "error": "<reason why this query cannot be translated>"
}
`;

/**
 * Call OpenAI API
 */
async function callOpenAI(userQuery, contextData = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Context:\n${JSON.stringify(contextData, null, 2)}\n\nUser Request: ${userQuery}`,
    },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API failed (HTTP ${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const rawText = data.choices[0].message.content;
  return JSON.parse(rawText);
}

/**
 * Call Anthropic API
 */
async function callAnthropic(userQuery, contextData = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Context:\n${JSON.stringify(contextData, null, 2)}\n\nUser Request: ${userQuery}`,
        },
      ],
      max_tokens: 1000,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API failed (HTTP ${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const rawText = data.content[0].text;
  return JSON.parse(rawText);
}

/**
 * Deterministic Mock LLM Provider (Fallback)
 * Translates natural language queries and builds explanations across MongoDB, Neo4j, and Redis
 * when external LLM API key is not set.
 */
async function callMockProvider(userQuery, contextData = {}) {
  const q = userQuery.toLowerCase().trim();

  // Pattern 1: Why was <product> cached/promoted/evicted/routed?
  if (
    q.includes('why was') ||
    q.includes('why is') ||
    q.includes('how was') ||
    q.includes('reason for') ||
    q.includes('explain decision') ||
    q.includes('why did the optimizer')
  ) {
    const matchedDecision = contextData.matchingDecision;
    const productId = contextData.productId || (matchedDecision ? matchedDecision.productId : 'unknown');

    if (matchedDecision) {
      const reasonStr = matchedDecision.reason || 'Decision recorded in storage optimizer log';
      const actionStr = matchedDecision.action || (matchedDecision.source ? `served from ${matchedDecision.source}` : 'PROMOTED');
      const forecastVal = matchedDecision.forecastValue ?? matchedDecision.latencyMs ?? 'N/A';

      return {
        type: 'explanation',
        target: 'optimizer_decision',
        productId,
        explanation: `Product ${productId} was ${actionStr.toLowerCase()} because: ${reasonStr} (metric value: ${forecastVal}).`,
      };
    }

    return {
      type: 'explanation',
      target: 'optimizer_decision',
      productId,
      explanation: `Product ${productId} currently has no active promotion or eviction decisions recorded in the optimizer log.`,
    };
  }

  // Pattern 2: Neo4j Graph "Bought together" / "Recommendations"
  if (
    q.includes('bought together') ||
    q.includes('co-purchase') ||
    q.includes('frequently bought') ||
    q.includes('recommend') ||
    q.includes('related to product')
  ) {
    const idMatch = userQuery.match(/\b(P[0-9]{4})\b/i);
    const pid = idMatch ? idMatch[1].toUpperCase() : (contextData.productId || 'P1001');

    return {
      type: 'query',
      store: 'neo4j',
      operation: 'recommendations',
      params: { productId: pid },
      explanation: `Traverse Neo4j customer-purchase graph to find items frequently co-purchased with ${pid}`,
    };
  }

  // Pattern 3: Neo4j Customer Purchase History
  if (
    q.includes('customer') &&
    (q.includes('buy') || q.includes('bought') || q.includes('purchase') || q.includes('order'))
  ) {
    const custMatch = userQuery.match(/\b(U[0-9]{3,4})\b/i);
    const cid = custMatch ? custMatch[1].toUpperCase() : (contextData.customerId || 'U001');

    return {
      type: 'query',
      store: 'neo4j',
      operation: 'customer_purchases',
      params: { customerId: cid },
      explanation: `Query Neo4j graph for historical purchase edges connected to customer ${cid}`,
    };
  }

  // Pattern 4: Redis Hot Cache Status Inspection
  if (
    q.includes('is cached') ||
    q.includes('cache status') ||
    q.includes('in cache') ||
    q.includes('hot tier') ||
    q.includes('in redis')
  ) {
    const idMatch = userQuery.match(/\b(P[0-9]{4})\b/i);
    const pid = idMatch ? idMatch[1].toUpperCase() : (contextData.productId || 'P1001');

    return {
      type: 'query',
      store: 'redis',
      operation: 'cache_status',
      params: { productId: pid },
      explanation: `Inspect Redis key cache:product:${pid} for presence, remaining TTL, and access telemetry`,
    };
  }

  // Pattern 5: Redis Cart Inspection
  if (q.includes('cart') && (q.includes('in') || q.includes('show') || q.includes('what') || q.includes('items'))) {
    const cartMatch = userQuery.match(/\b(cart_[a-zA-Z0-9_-]+)\b/i);
    const cartId = cartMatch ? cartMatch[1] : (contextData.cartId || 'cart_1');

    return {
      type: 'query',
      store: 'redis',
      operation: 'cart',
      params: { cartId },
      explanation: `Inspect active session hash cart:${cartId} in Redis in-memory store`,
    };
  }

  // Pattern 6: MongoDB Product Catalog Filter Search
  const categoryMatch = q.match(/in\s+([a-z]+)/i) || q.match(/category\s+([a-z]+)/i);
  const underPriceMatch = q.match(/under\s+\$?([0-9]+(?:\.[0-9]+)?)/i) || q.match(/less than\s+\$?([0-9]+(?:\.[0-9]+)?)/i) || q.match(/below\s+\$?([0-9]+(?:\.[0-9]+)?)/i);
  const overPriceMatch = q.match(/over\s+\$?([0-9]+(?:\.[0-9]+)?)/i) || q.match(/more than\s+\$?([0-9]+(?:\.[0-9]+)?)/i) || q.match(/above\s+\$?([0-9]+(?:\.[0-9]+)?)/i);

  const filter = {};
  if (categoryMatch && categoryMatch[1]) {
    const rawCat = categoryMatch[1].toLowerCase();
    if (!['products', 'catalog', 'stock', 'store', 'cart'].includes(rawCat)) {
      filter.category = rawCat;
    }
  }
  if (underPriceMatch && underPriceMatch[1]) {
    filter.maxPrice = parseFloat(underPriceMatch[1]);
  }
  if (overPriceMatch && overPriceMatch[1]) {
    filter.minPrice = parseFloat(overPriceMatch[1]);
  }

  return {
    type: 'query',
    store: 'mongodb',
    operation: 'find',
    filter,
    explanation: `Constructed MongoDB query filter ${JSON.stringify(filter)} across product catalog collection`,
  };
}

/**
 * Dispatch query to the configured LLM provider
 */
async function generateStructuredResponse(userQuery, contextData = {}) {
  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();

  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    try {
      return await callOpenAI(userQuery, contextData);
    } catch (err) {
      console.warn(`[GenAI] OpenAI call failed: ${err.message}. Falling back to internal engine.`);
    }
  } else if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    try {
      return await callAnthropic(userQuery, contextData);
    } catch (err) {
      console.warn(`[GenAI] Anthropic call failed: ${err.message}. Falling back to internal engine.`);
    }
  }

  // Deterministic polyglot fallback
  return callMockProvider(userQuery, contextData);
}

module.exports = {
  generateStructuredResponse,
  SYSTEM_PROMPT,
};
