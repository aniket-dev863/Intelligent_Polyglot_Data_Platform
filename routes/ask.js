const express = require('express');
const { processNaturalLanguageQuery } = require('../services/genai/genaiService');

const router = express.Router();

/**
 * POST /api/ask
 * Accepts: { "query": "<natural language>" }
 */
router.post('/', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Body must contain a non-empty "query" string' });
  }

  try {
    const result = await processNaturalLanguageQuery(query);
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
