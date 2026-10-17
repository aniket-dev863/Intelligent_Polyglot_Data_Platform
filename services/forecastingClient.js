/**
 * Thin HTTP client for the Python forecasting microservice.
 * Degrades gracefully if the forecasting service is unreachable or errors.
 */

const FORECASTING_SERVICE_URL = process.env.FORECASTING_SERVICE_URL || 'http://localhost:5001';
const FORECAST_CACHE_TTL_MS = Number(process.env.FORECAST_CACHE_TTL_MS || 15000); // 15s in-memory cache

const forecastCache = new Map();

function clearForecastCache() {
  forecastCache.clear();
}

/**
 * Predict next-window demand for a product.
 * @param {string} productId 
 * @param {number} [windowMinutes=1]
 * @param {object} [options]
 * @param {boolean} [options.bypassCache=false]
 * @returns {Promise<{ productId: string, predictedDemand: number, modelUsed: string, confidence: number, historicalPoints: number, currentAccessCount: number, details?: object }>}
 */
async function getForecast(productId, windowMinutes = 1, options = {}) {
  if (!productId || typeof productId !== 'string') {
    throw new Error('productId must be a non-empty string');
  }

  const validWindow = Math.min(120, Math.max(1, Number(windowMinutes) || 1));
  const cacheKey = `${productId}:${validWindow}`;

  if (!options.bypassCache) {
    const cached = forecastCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(`${FORECASTING_SERVICE_URL}/forecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, windowMinutes: validWindow }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Forecasting service returned HTTP ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    if (typeof data.predictedDemand !== 'number') {
      throw new Error('Malformed forecast response: missing predictedDemand number');
    }

    forecastCache.set(cacheKey, {
      data,
      expiresAt: Date.now() + FORECAST_CACHE_TTL_MS,
    });

    return data;
  } catch (err) {
    console.warn(`[ForecastingClient] Call failed for ${productId} (${err.message}) — using heuristic fallback`);
    // Graceful in-process fallback
    return {
      productId,
      predictedDemand: 0.0,
      modelUsed: 'client-offline-fallback',
      confidence: 0.20,
      historicalPoints: 0,
      currentAccessCount: 0,
      details: { error: err.message },
    };
  }
}

/**
 * Check forecasting service health.
 */
async function checkForecastingHealth() {
  try {
    const response = await fetch(`${FORECASTING_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch (err) {
    return false;
  }
}

module.exports = {
  getForecast,
  checkForecastingHealth,
  clearForecastCache,
  FORECASTING_SERVICE_URL,
};

