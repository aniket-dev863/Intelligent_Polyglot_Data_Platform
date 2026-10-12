import os
import json
import logging
from typing import Optional, List
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import redis
import numpy as np
import pandas as pd
from statsmodels.tsa.arima.model import ARIMA

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("forecasting-service")

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
PORT = int(os.getenv("PORT", "5001"))

app = FastAPI(title="Adaptive Polyglot Forecasting Service", version="1.0.0")

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
    productId: str
    windowMinutes: Optional[int] = 1

class ForecastResponse(BaseModel):
    productId: str
    predictedDemand: float
    modelUsed: str
    confidence: float
    historicalPoints: int
    currentAccessCount: int
    details: Optional[dict] = None

def compute_forecast(product_id: str) -> dict:
    client = get_redis()
    current_count = 0
    history_entries = []

    if client:
        try:
            val = client.hget("access:count", product_id)
            if val:
                current_count = int(val)
        except Exception as e:
            logger.warning(f"Error reading access:count for {product_id}: {e}")

        try:
            # Sorted set access:history:{productId} has (member=timestamp_str, score=count)
            # zrange with withscores=True returns list of (member, score)
            z_data = client.zrange(f"access:history:{product_id}", 0, -1, withscores=True)
            if z_data:
                # z_data is [(timestamp_sec_str, count_float), ...]
                history_entries = [float(score) for _, score in z_data]
        except Exception as e:
            logger.warning(f"Error reading access:history for {product_id}: {e}")

    # Fallback logic based on data availability
    num_points = len(history_entries)

    # 1. Cold start: No time-series history
    if num_points == 0:
        if current_count > 0:
            # Cold-start fallback: estimate based on aggregate count
            predicted = max(1.0, float(current_count) * 0.2)
            return {
                "productId": product_id,
                "predictedDemand": round(predicted, 2),
                "modelUsed": "cold-start-aggregate-heuristic",
                "confidence": 0.40,
                "historicalPoints": 0,
                "currentAccessCount": current_count,
            }
        else:
            return {
                "productId": product_id,
                "predictedDemand": 0.0,
                "modelUsed": "zero-baseline",
                "confidence": 0.90,
                "historicalPoints": 0,
                "currentAccessCount": 0,
            }

    # 2. Few data points (< 5): Simple Moving Average (SMA)
    if num_points < 5:
        sma = float(np.mean(history_entries))
        # blend with recent trend if 2+ points
        if num_points >= 2:
            trend_weight = (history_entries[-1] - history_entries[0]) / num_points
            predicted = max(0.0, sma + trend_weight)
        else:
            predicted = sma

        return {
            "productId": product_id,
            "predictedDemand": round(predicted, 2),
            "modelUsed": "simple-moving-average",
            "confidence": 0.65,
            "historicalPoints": num_points,
            "currentAccessCount": current_count,
        }

    # 3. Sufficient data points (>= 5): ARIMA(1, 0, 0) or ARIMA(1, 1, 0)
    try:
        series = np.array(history_entries, dtype=float)
        # Check if series is constant
        if np.all(series == series[0]):
            return {
                "productId": product_id,
                "predictedDemand": round(float(series[-1]), 2),
                "modelUsed": "constant-extrapolation",
                "confidence": 0.85,
                "historicalPoints": num_points,
                "currentAccessCount": current_count,
            }

        # Fit simple auto-regressive ARIMA(1, 0, 0) or fallback
        model = ARIMA(series, order=(1, 0, 0))
        fit_res = model.fit()
        forecast = fit_res.forecast(steps=1)
        predicted = max(0.0, float(forecast[0]))

        return {
            "productId": product_id,
            "predictedDemand": round(predicted, 2),
            "modelUsed": "statsmodels-arima(1,0,0)",
            "confidence": 0.85,
            "historicalPoints": num_points,
            "currentAccessCount": current_count,
            "details": {
                "aic": round(fit_res.aic, 2) if hasattr(fit_res, 'aic') and fit_res.aic is not None else None,
            }
        }
    except Exception as e:
        logger.warning(f"ARIMA fit failed for {product_id}, falling back to exponential moving average: {e}")
        ema = float(pd.Series(history_entries).ewm(span=3).mean().iloc[-1])
        return {
            "productId": product_id,
            "predictedDemand": round(max(0.0, ema), 2),
            "modelUsed": "exponential-moving-average-fallback",
            "confidence": 0.60,
            "historicalPoints": num_points,
            "currentAccessCount": current_count,
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
    if not req.productId:
        raise HTTPException(status_code=400, detail="productId is required")
    result = compute_forecast(req.productId)
    return result

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=PORT, reload=False)
