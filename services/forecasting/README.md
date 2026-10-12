# Forecasting Service

## Overview

The Forecasting Service is a lightweight Python microservice built using FastAPI that predicts next-window access volume for catalog products. It consumes access signals directly from Redis:
1. `access:count` (aggregate hit counters)
2. `access:history:{productId}` (time-windowed sorted sets containing minute-by-minute hit frequencies)

## Model Selection & Architecture

The service applies an adaptive multi-tier forecasting strategy:

1. **Cold-Start Items (0 history points)**:
   - For unseen or brand-new products with zero recorded history, the service uses a heuristic baseline derived from overall aggregate hits (`cold-start-aggregate-heuristic` or `zero-baseline`).
   - Ensures zero server crashes or unhandled exceptions when encountering newly seeded items.

2. **Early Items (< 5 time-series points)**:
   - Evaluated using a **Simple Moving Average (SMA)** combined with linear trend adjustment:
     $$\hat{y}_{t+1} = \bar{y} + \frac{y_n - y_1}{n}$$
   - Statistical ARIMA models overfit or fail to invert covariance matrices with $< 5$ points.

3. **Active Hot Items ($\ge 5$ time-series points)**:
   - Uses `statsmodels.tsa.arima.model.ARIMA(order=(1, 0, 0))` (Auto-Regressive model) to capture momentum and autoregressive dependency in request spikes.
   - If the time series is flat/constant, an exact constant extrapolation is applied.
   - If convergence fails, an **Exponential Moving Average (EMA)** fallback is triggered gracefully.

## Evaluation & Retraining

### Evaluation Metrics
To benchmark forecast accuracy against real or synthetic access traffic:
- **MAE (Mean Absolute Error)**: $\frac{1}{N}\sum |y_t - \hat{y}_t|$ measures average magnitude of prediction error.
- **RMSE (Root Mean Squared Error)**: $\sqrt{\frac{1}{N}\sum (y_t - \hat{y}_t)^2}$ penalizes severe underpredictions of incoming traffic spikes.

### Training & Offline Evaluation Procedure
1. Seed the test database using `node scripts/seed.js`.
2. Generate synthetic access traces across multiple items:
   ```bash
   node -e '
     const { logAccess } = require("./scripts/accessLogger");
     (async () => {
       for (let i = 0; i < 20; i++) {
         await logAccess({ productId: "P1001", source: "mongodb", latencyMs: 15 });
       }
       process.exit(0);
     })();
   '
   ```
3. Query the forecast endpoint:
   ```bash
   curl -X POST http://localhost:5001/forecast \
     -H "Content-Type: application/json" \
     -d '{"productId": "P1001"}'
   ```
4. Compare the predicted value with ground truth hold-out access volume over the subsequent minute.

## Containerization
Configured in `docker-compose.yml` under the `forecasting` service running on port 5001.
