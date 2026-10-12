const express = require('express');
const { routeProductQuery, getRecentRoutingDecisions } = require('../services/queryRouter');

const router = express.Router();

// GET /api/query/product/:id - Adaptive routing query
router.get('/product/:id', async (req, res) => {
  try {
    const result = await routeProductQuery(req.params.id);
    res.json({
      source: result.source,
      reason: result.reason,
      latencyMs: result.latencyMs,
      ...result.product,
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/query/decisions - Inspect recent routing decisions
router.get('/decisions', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const decisions = await getRecentRoutingDecisions(limit);
    res.json(decisions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
