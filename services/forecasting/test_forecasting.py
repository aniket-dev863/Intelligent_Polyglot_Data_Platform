import os
import sys
import unittest
from unittest.mock import patch, MagicMock
from fastapi import HTTPException
from pydantic import ValidationError

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import (
    app,
    compute_forecast,
    forecast,
    health,
    ForecastRequest,
    ForecastResponse,
)


class TestForecastingService(unittest.TestCase):
    def setUp(self):
        # Default mock client
        self.mock_redis = MagicMock()
        self.mock_redis.hget.return_value = None
        self.mock_redis.zrange.return_value = []
        self.mock_redis.ping.return_value = True

    @patch("app.get_redis")
    def test_cold_start_zero_baseline(self, mock_get_redis):
        mock_get_redis.return_value = self.mock_redis
        self.mock_redis.hget.return_value = None
        self.mock_redis.zrange.return_value = []

        res = compute_forecast("PROD_COLD_1", window_minutes=2)

        self.assertEqual(res["productId"], "PROD_COLD_1")
        self.assertEqual(res["predictedDemand"], 0.0)
        self.assertEqual(res["modelUsed"], "zero-baseline")
        self.assertEqual(res["confidence"], 0.90)
        self.assertEqual(res["historicalPoints"], 0)
        self.assertEqual(res["details"]["totalPredictedDemand"], 0.0)

    @patch("app.get_redis")
    def test_cold_start_aggregate_heuristic(self, mock_get_redis):
        mock_get_redis.return_value = self.mock_redis
        self.mock_redis.hget.return_value = "20"
        self.mock_redis.zrange.return_value = []

        res = compute_forecast("PROD_COLD_HEURISTIC", window_minutes=3)

        self.assertEqual(res["productId"], "PROD_COLD_HEURISTIC")
        self.assertGreater(res["predictedDemand"], 0.0)
        self.assertEqual(res["modelUsed"], "cold-start-aggregate-heuristic")
        self.assertEqual(res["confidence"], 0.35)
        self.assertEqual(res["currentAccessCount"], 20)
        self.assertAlmostEqual(res["details"]["totalPredictedDemand"], res["predictedDemand"] * 3, places=2)

    @patch("app.get_redis")
    def test_constant_series_extrapolation(self, mock_get_redis):
        mock_get_redis.return_value = self.mock_redis
        self.mock_redis.hget.return_value = "15"
        # 3 points with constant score 4.0
        now_bucket = 1700000040
        z_data = [
            (f"{now_bucket}:4", float(now_bucket)),
            (f"{now_bucket + 60}:4", float(now_bucket + 60)),
            (f"{now_bucket + 120}:4", float(now_bucket + 120)),
        ]
        self.mock_redis.zrange.return_value = z_data

        res = compute_forecast("PROD_CONSTANT", window_minutes=2)

        self.assertEqual(res["productId"], "PROD_CONSTANT")
        self.assertEqual(res["predictedDemand"], 4.0)
        self.assertEqual(res["modelUsed"], "constant-extrapolation")
        self.assertEqual(res["confidence"], 0.90)
        self.assertEqual(res["details"]["totalPredictedDemand"], 8.0)

    @patch("app.get_redis")
    def test_simple_moving_average_few_points(self, mock_get_redis):
        mock_get_redis.return_value = self.mock_redis
        self.mock_redis.hget.return_value = "12"
        now_bucket = 1700000040
        z_data = [
            (f"{now_bucket}:2", float(now_bucket)),
            (f"{now_bucket + 60}:4", float(now_bucket + 60)),
            (f"{now_bucket + 120}:6", float(now_bucket + 120)),
        ]
        self.mock_redis.zrange.return_value = z_data

        res = compute_forecast("PROD_SMA", window_minutes=1)

        self.assertEqual(res["productId"], "PROD_SMA")
        self.assertEqual(res["modelUsed"], "simple-moving-average")
        self.assertGreater(res["predictedDemand"], 0.0)
        self.assertGreaterEqual(res["confidence"], 0.3)
        self.assertLessEqual(res["confidence"], 0.95)

    @patch("app.get_redis")
    def test_arima_sufficient_points_multi_step(self, mock_get_redis):
        mock_get_redis.return_value = self.mock_redis
        self.mock_redis.hget.return_value = "60"
        now_bucket = 1700000040
        # 8 data points with variation
        counts = [3, 5, 4, 6, 7, 5, 8, 9]
        z_data = [
            (f"{now_bucket + i * 60}:{cnt}", float(now_bucket + i * 60))
            for i, cnt in enumerate(counts)
        ]
        self.mock_redis.zrange.return_value = z_data

        res = compute_forecast("PROD_ARIMA", window_minutes=3)


        self.assertEqual(res["productId"], "PROD_ARIMA")
        self.assertIn("arima", res["modelUsed"])
        self.assertGreater(res["predictedDemand"], 0.0)
        self.assertEqual(len(res["details"]["stepsForecast"]), 3)
        self.assertGreater(res["details"]["totalPredictedDemand"], 0.0)
        self.assertIn("confidenceInterval95", res["details"])
        self.assertGreater(res["confidence"], 0.0)

    def test_request_validation(self):
        # Empty productId raises HTTPException
        with self.assertRaises(HTTPException):
            forecast(ForecastRequest(productId="   ", windowMinutes=1))

        # Invalid windowMinutes raises HTTPException or ValidationError
        with self.assertRaises((HTTPException, ValidationError)):
            forecast(ForecastRequest(productId="P1001", windowMinutes=0))

        with self.assertRaises((HTTPException, ValidationError)):
            forecast(ForecastRequest(productId="P1001", windowMinutes=200))

    @patch("app.get_redis")
    def test_health_endpoint(self, mock_get_redis):
        mock_get_redis.return_value = self.mock_redis
        h = health()
        self.assertEqual(h["status"], "ok")
        self.assertTrue(h["redis"])


if __name__ == "__main__":
    unittest.main()
