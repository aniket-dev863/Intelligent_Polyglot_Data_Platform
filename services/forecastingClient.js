/**
 * Thin HTTP client for the Python forecasting microservice.
 * Degrades gracefully if the forecasting service is unreachable.
 */

const FORECASTING_SERVICE_URL = process.env.FORECASTING_SERVICE_URL || 'http://localhost:5001';

/**
 * Predict next-window demand for a product.
 * @param {string} productId 
 * @param {number} [windowMinutes=1]
 * @returns {Promise<{ productId: string, predictedDemand: number, modelUsed: string, confidence: number }>}
 */
async function getForecast(productId, windowMinutes = 1) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${FORECASTING_SERVICE_URL}/forecast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, windowMinutes }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Forecasting service returned HTTP ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (err) {
    console.warn(`[ForecastingClient] Call failed for ${productId} (${err.message}) — using heuristic fallback`);
    // Graceful in-process fallback
    return {
      productId,
      predictedDemand: 1.0,
      modelUsed: 'client-offline-fallback',
      confidence: 0.3,
      historicalPoints: 0,
      currentAccessCount: 0,
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
  FORECASTING_SERVICE_URL,
};
