import os
import json
import logging
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import redis
import numpy as np
import pandas as pd
from statsmodels.tsa.arima.model import ARIMA

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("forecasting-service")

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
PORT = int(os.getenv("PORT", "5001"))

app = FastAPI(title="Adaptive Polyglot Forecasting Service", version="1.1.0")

# Redis connection with lazy fallback
r: Optional[redis.Redis] = None

def get_redis() -> Optional[redis.Redis]:
    global r
    if r is None:
        try:
            r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
            r.ping()
        except Exception as e:
            logger.warning(f"[Redis] Could not connect to Redis at {REDIS_URL}: {e}")
            r = None
    return r

class ForecastRequest(BaseModel):
    productId: str = Field(..., description="Unique product identifier (e.g. P1001)")
    windowMinutes: Optional[int] = Field(1, ge=1, le=120, description="Forecast horizon in minutes (1-120)")

class ForecastResponse(BaseModel):
    productId: str
    predictedDemand: float
    modelUsed: str
    confidence: float
    historicalPoints: int
    currentAccessCount: int
    details: Optional[Dict[str, Any]] = None

def compute_forecast(product_id: str, window_minutes: int = 1) -> dict:
    client = get_redis()
    current_count = 0
    raw_history = []

    if client:
        try:
            val = client.hget("access:count", product_id)
            if val:
                current_count = int(val)
        except Exception as e:
            logger.warning(f"Error reading access:count for {product_id}: {e}")

        try:
            # Sorted set access:history:{productId} has score=timestamp, member="<timestamp>:<count>"
            # (or legacy member="<timestamp>", score=<count>)
            z_data = client.zrange(f"access:history:{product_id}", 0, -1, withscores=True)
            if z_data:
                for member, score in z_data:
                    member_str = str(member)
                    if ":" in member_str:
                        parts = member_str.split(":")
                        raw_ts = int(parts[0]) if parts[0].isdigit() else int(score)
                        cnt = float(parts[1]) if parts[1].replace(".", "", 1).isdigit() else 1.0
                    else:
                        # Legacy fallback: score was count, member was timestamp string
                        cnt = float(score) if score < 1000000000 else 1.0
                        raw_ts = int(member_str) if member_str.isdigit() else int(score)
                    ts = (raw_ts // 60) * 60
                    raw_history.append((ts, cnt))

        except Exception as e:
            logger.warning(f"Error reading access:history for {product_id}: {e}")

    # Sort raw history chronologically
    raw_history.sort(key=lambda x: x[0])
    num_points = len(raw_history)

    # 1. Cold start: No historical observations
    if num_points == 0:
        if current_count > 0:
            # Cold-start prior proportional to aggregate lifetime count (conservative rate)
            rate = max(0.5, min(float(current_count) * 0.05, 5.0))
            return {
                "productId": product_id,
                "predictedDemand": round(rate, 2),
                "modelUsed": "cold-start-aggregate-heuristic",
                "confidence": 0.35,
                "historicalPoints": 0,
                "currentAccessCount": current_count,
                "details": {
                    "windowMinutes": window_minutes,
                    "totalPredictedDemand": round(rate * window_minutes, 2),
                    "confidenceMetric": "cold-start-heuristic-prior",
                },
            }
        else:
            return {
                "productId": product_id,
                "predictedDemand": 0.0,
                "modelUsed": "zero-baseline",
                "confidence": 0.90,
                "historicalPoints": 0,
                "currentAccessCount": 0,
                "details": {
                    "windowMinutes": window_minutes,
                    "totalPredictedDemand": 0.0,
                    "confidenceMetric": "prior-absence-of-traffic",
                },
            }

    # Build regular 1-minute time series by imputing missing minutes as 0.0
    first_ts = raw_history[0][0]
    last_ts = raw_history[-1][0]
    # Restrict to last 60 minutes max to avoid huge zero-fill on sparse historical outliers
    min_bound = max(first_ts, last_ts - 3600)

    bucket_map = {ts: cnt for ts, cnt in raw_history if ts >= min_bound}
    imputed_series = []
    # Step through every minute from min_bound to last_ts
    step_ts = (min_bound // 60) * 60
    end_step = (last_ts // 60) * 60

    while step_ts <= end_step:
        imputed_series.append(bucket_map.get(step_ts, 0.0))
        step_ts += 60

    series = np.array(imputed_series, dtype=float)
    active_points = len(series)

    # 2. Constant series (zero variance)
    if active_points >= 2 and np.all(series == series[0]):
        constant_val = float(series[-1])
        return {
            "productId": product_id,
            "predictedDemand": round(constant_val, 2),
            "modelUsed": "constant-extrapolation",
            "confidence": 0.90,
            "historicalPoints": active_points,
            "currentAccessCount": current_count,
            "details": {
                "windowMinutes": window_minutes,
                "totalPredictedDemand": round(constant_val * window_minutes, 2),
                "confidenceMetric": "zero-residual-variance",
            },
        }

    # 3. Few data points (< 5): Simple Moving Average (SMA) with trend
    if active_points < 5:
        sma = float(np.mean(series))
        if active_points >= 2:
            trend = (series[-1] - series[0]) / active_points
            predicted = max(0.0, sma + trend)
        else:
            predicted = sma

        variance = float(np.var(series))
        # Confidence scales with sample size and inversely with coefficient of variation
        cv = variance / max(1.0, predicted)
        calibrated_conf = round(max(0.3, min(0.85, 0.50 + 0.05 * active_points - 0.05 * min(cv, 4.0))), 2)

        return {
            "productId": product_id,
            "predictedDemand": round(predicted, 2),
            "modelUsed": "simple-moving-average",
            "confidence": calibrated_conf,
            "historicalPoints": active_points,
            "currentAccessCount": current_count,
            "details": {
                "windowMinutes": window_minutes,
                "totalPredictedDemand": round(predicted * window_minutes, 2),
                "confidenceMetric": "sample-size-and-variance-calibrated",
            },
        }

    # 4. Sufficient data points (>= 5): ARIMA(1, 0, 0)
    try:
        model = ARIMA(series, order=(1, 0, 0))
        fit_res = model.fit()

        # Multi-step forecast over the requested horizon
        forecast_steps = fit_res.forecast(steps=window_minutes)
        predicted_mean_rate = max(0.0, float(np.mean(forecast_steps)))
        total_predicted = max(0.0, float(np.sum(forecast_steps)))

        # Calibrated statistical confidence from prediction interval / standard error
        pred_obj = fit_res.get_forecast(steps=window_minutes)
        se = float(np.mean(pred_obj.se_mean)) if hasattr(pred_obj, "se_mean") else 1.0
        rse = se / max(1.0, predicted_mean_rate)
        # RSE = 0 -> 1.0, RSE = 1 -> 0.5, RSE = 3 -> 0.25
        calibrated_conf = round(max(0.2, min(0.95, 1.0 / (1.0 + rse))), 2)

        ci = pred_obj.conf_int(alpha=0.05)
        lower_bound = round(max(0.0, float(np.mean(ci[:, 0]))), 2)
        upper_bound = round(max(0.0, float(np.mean(ci[:, 1]))), 2)

        return {
            "productId": product_id,
            "predictedDemand": round(predicted_mean_rate, 2),
            "modelUsed": "statsmodels-arima(1,0,0)",
            "confidence": calibrated_conf,
            "historicalPoints": active_points,
            "currentAccessCount": current_count,
            "details": {
                "windowMinutes": window_minutes,
                "stepsForecast": [round(float(s), 2) for s in forecast_steps],
                "totalPredictedDemand": round(total_predicted, 2),
                "confidenceInterval95": [lower_bound, upper_bound],
                "confidenceMetric": "inverse-relative-standard-error",
                "aic": round(fit_res.aic, 2) if hasattr(fit_res, "aic") and fit_res.aic is not None else None,
            },
        }
    except Exception as e:
        logger.warning(f"ARIMA fit failed for {product_id}, falling back to exponential moving average: {e}")
        span = min(5, active_points)
        ema = float(pd.Series(series).ewm(span=span).mean().iloc[-1])
        predicted_ema = max(0.0, ema)
        return {
            "productId": product_id,
            "predictedDemand": round(predicted_ema, 2),
            "modelUsed": "exponential-moving-average-fallback",
            "confidence": 0.55,
            "historicalPoints": active_points,
            "currentAccessCount": current_count,
            "details": {
                "windowMinutes": window_minutes,
                "totalPredictedDemand": round(predicted_ema * window_minutes, 2),
                "confidenceMetric": "fallback-heuristic",
                "error": str(e),
            },
        }

@app.get("/health")
def health():
    redis_ok = False
    client = get_redis()
    if client:
        try:
            redis_ok = client.ping()
        except Exception:
            redis_ok = False
    return {"status": "ok", "redis": redis_ok}

@app.post("/forecast", response_model=ForecastResponse)
def forecast(req: ForecastRequest):
    if not req.productId or not req.productId.strip():
        raise HTTPException(status_code=400, detail="productId must be a non-empty string")
    if req.windowMinutes is not None and (req.windowMinutes < 1 or req.windowMinutes > 120):
        raise HTTPException(status_code=400, detail="windowMinutes must be between 1 and 120")

    result = compute_forecast(req.productId.strip(), req.windowMinutes or 1)
    return result

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=PORT, reload=False)

