const express = require('express');
const { getRecentOptimizerDecisions, runOptimizationCycle } = require('../services/storageOptimizer');

const router = express.Router();

// GET /api/optimizer/decisions - Returns recent optimizer decisions
router.get('/decisions', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 20;
    const decisions = await getRecentOptimizerDecisions(limit);
    res.json(decisions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/optimizer/run - Manually trigger an optimization cycle (useful for demo/testing)
router.post('/run', async (req, res) => {
  try {
    const results = await runOptimizationCycle(req.body);
    res.json({ status: 'completed', results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
