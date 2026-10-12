const express = require('express');
const { getRecentAccess, getAccessCounts } = require('../scripts/accessLogger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [recent, counts] = await Promise.all([getRecentAccess(20), getAccessCounts()]);
    res.json({ recentAccess: recent, accessCounts: counts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
