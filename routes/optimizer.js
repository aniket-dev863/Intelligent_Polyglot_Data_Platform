const express = require('express');
const { getRecentOptimizerDecisions, runOptimizationCycle } = require('../services/storageOptimizer');

const router = express.Router();

// Middleware: Protect administrative actions if ADMIN_API_KEY is configured
function requireAdminKey(req, res, next) {
  const configuredKey = process.env.ADMIN_API_KEY;
  if (!configuredKey) {
    return next(); // Default local development mode
  }
  const providedKey = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ error: 'Unauthorized: valid X-Admin-Key header required' });
  }
  next();
}

// GET /api/optimizer/decisions - Returns recent optimizer decisions
router.get('/decisions', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20));
    const decisions = await getRecentOptimizerDecisions(limit);
    res.json(decisions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/optimizer/run - Manually trigger an optimization cycle
router.post('/run', requireAdminKey, async (req, res) => {
  const { promoteThreshold, demoteThreshold } = req.body || {};

  if (promoteThreshold != null) {
    const pt = Number(promoteThreshold);
    if (isNaN(pt) || pt < 0) {
      return res.status(400).json({ error: 'promoteThreshold must be a non-negative number' });
    }
  }

  if (demoteThreshold != null) {
    const dt = Number(demoteThreshold);
    if (isNaN(dt) || dt < 0) {
      return res.status(400).json({ error: 'demoteThreshold must be a non-negative number' });
    }
  }

  if (promoteThreshold != null && demoteThreshold != null) {
    if (Number(demoteThreshold) > Number(promoteThreshold)) {
      return res.status(400).json({ error: 'demoteThreshold cannot be greater than promoteThreshold' });
    }
  }

  try {
    const results = await runOptimizationCycle(req.body);
    res.json({ status: 'completed', results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

