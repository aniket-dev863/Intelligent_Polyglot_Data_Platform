const express = require('express');
const Product = require('../models/Product');
const { redisClient } = require('../db/redisClient');
const { logAccess } = require('../scripts/accessLogger');

const router = express.Router();
const CACHE_TTL_SECONDS = 300;

// CREATE
router.post('/', async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// READ (list, with optional category filter + pagination)
router.get('/', async (req, res) => {
  try {
    const { category, limit = 20, skip = 0 } = req.query;
    const filter = category ? { category } : {};
    const products = await Product.find(filter).limit(Number(limit)).skip(Number(skip));
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// READ (single, cache-aside pattern: check Redis first, fall back to MongoDB)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const start = Date.now();
  const cacheKey = `cache:product:${id}`;
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      await logAccess({ productId: id, source: 'redis-cache', latencyMs: Date.now() - start });
      return res.json({ source: 'cache', ...JSON.parse(cached) });
    }

    const product = await Product.findById(id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    await logAccess({ productId: id, source: 'mongodb', latencyMs: Date.now() - start });
    res.json({ source: 'mongodb', ...product.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE
router.put('/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    // invalidate any stale cached copy on write
    await redisClient.del(`cache:product:${req.params.id}`);
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE
router.delete('/:id', async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await redisClient.del(`cache:product:${req.params.id}`);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
