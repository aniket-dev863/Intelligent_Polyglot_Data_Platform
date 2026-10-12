/**
 * Swappable LLM Provider Client
 * Supports OpenAI, Anthropic, or Mock provider (fallback when no API key is supplied).
 */

const SYSTEM_PROMPT = `
You are the natural language query translation and explanation assistant for an Intelligent Polyglot Data Platform.
You NEVER execute database commands directly.
You MUST output ONLY a valid single JSON object matching one of the two schemas below without markdown ticks, code blocks, or preamble.

Schema 1: Query Specification (Product Catalog Query)
{
  "type": "query",
  "store": "mongodb",
  "operation": "find",
  "filter": {
    "category": "<optional string>",
    "maxPrice": "<optional number>",
    "minPrice": "<optional number>",
    "tags": "<optional array of strings>"
  },
  "explanation": "<short explanation of the filter applied>"
}

Schema 2: System Decision Explanation
{
  "type": "explanation",
  "target": "optimizer_decision" | "routing_decision",
  "productId": "<extracted product id or null>",
  "explanation": "<plain English explanation summarizing why the product was cached, promoted, or routed>"
}

Schema 3: Unsupported / Error Query
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
 * Translates natural language queries and builds explanations when external LLM API key is not set.
 */
async function callMockProvider(userQuery, contextData = {}) {
  const q = userQuery.toLowerCase().trim();

  // Pattern 1: Why was <product> cached/promoted?
  if (q.includes('why was') || q.includes('why is') || q.includes('how was') || q.includes('reason for')) {
    const matchedDecision = contextData.matchingDecision;
    const productId = contextData.productId || (matchedDecision ? matchedDecision.productId : 'unknown');

    if (matchedDecision) {
      const reasonStr = matchedDecision.reason || 'Decision recorded in storage optimizer log';
      const actionStr = matchedDecision.action || 'PROMOTED';
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

  // Pattern 2: "Show me products in <category> under $<price>"
  // Or "find products", "search products"
  const categoryMatch = q.match(/in\s+([a-z]+)/i) || q.match(/category\s+([a-z]+)/i);
  const underPriceMatch = q.match(/under\s+\$?([0-9]+(?:\.[0-9]+)?)/i) || q.match(/less than\s+\$?([0-9]+(?:\.[0-9]+)?)/i) || q.match(/below\s+\$?([0-9]+(?:\.[0-9]+)?)/i);
  const overPriceMatch = q.match(/over\s+\$?([0-9]+(?:\.[0-9]+)?)/i) || q.match(/more than\s+\$?([0-9]+(?:\.[0-9]+)?)/i) || q.match(/above\s+\$?([0-9]+(?:\.[0-9]+)?)/i);

  const filter = {};
  if (categoryMatch && categoryMatch[1]) {
    filter.category = categoryMatch[1].toLowerCase();
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
    explanation: `Filtered MongoDB products by ${JSON.stringify(filter)}`,
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

  // Graceful fallback to mock parser
  return callMockProvider(userQuery, contextData);
}

module.exports = {
  generateStructuredResponse,
  SYSTEM_PROMPT,
};
