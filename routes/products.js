const express = require('express');
const Product = require('../models/Product');
const { redisClient } = require('../db/redisClient');
const { logAccess } = require('../scripts/accessLogger');
const { singleFlight } = require('../services/queryRouter');

const router = express.Router();
const CACHE_TTL_SECONDS = Number(process.env.CACHE_ASIDE_TTL_SECONDS || 300);

// CREATE
router.post('/', async (req, res) => {
  const { _id, name, category, price, stock, attributes, tags } = req.body;
  if (!_id || typeof _id !== 'string' || !name || typeof name !== 'string') {
    return res.status(400).json({ error: '_id and name are required and must be strings' });
  }
  if (!category || typeof category !== 'string') {
    return res.status(400).json({ error: 'category is required and must be a string' });
  }
  if (price == null || isNaN(Number(price)) || Number(price) < 0) {
    return res.status(400).json({ error: 'price must be a non-negative number' });
  }

  try {
    const product = await Product.create({
      _id: _id.trim(),
      name: name.trim(),
      category: category.trim().toLowerCase(),
      price: Number(price),
      stock: stock != null ? Math.max(0, Number(stock) || 0) : 0,
      attributes: attributes && typeof attributes === 'object' ? attributes : {},
      tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : [],
    });
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// READ (list, with optional category filter + pagination)
router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const skip = Math.max(0, Number(req.query.skip) || 0);

    const filter = {};
    if (category && typeof category === 'string') {
      filter.category = category.trim().toLowerCase();
    }

    const products = await Product.find(filter).limit(limit).skip(skip).lean();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// READ (single, cache-aside / adaptive pattern)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const start = Date.now();
  const cacheKey = `cache:product:${id}`;
  const strategy = req.query.strategy || process.env.CACHE_STRATEGY || 'adaptive';

  try {
    // Strategy 'none' bypasses cache
    if (strategy !== 'none') {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        await logAccess({ productId: id, source: 'redis-cache', latencyMs: Date.now() - start });
        return res.json({ source: 'cache', ...JSON.parse(cached) });
      }
    }

    // Cache miss / bypass: single-flight lookup against MongoDB
    const product = await singleFlight(`mongo:${id}`, () => Product.findById(id));
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const plain = product.toObject ? product.toObject() : product;

    // Conventional cache-aside populates Redis on miss
    if (strategy === 'cache-aside') {
      await redisClient.set(cacheKey, JSON.stringify(plain), { EX: CACHE_TTL_SECONDS });
    }

    await logAccess({ productId: id, source: 'mongodb', latencyMs: Date.now() - start });
    res.json({ source: 'mongodb', ...plain });
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

    // Invalidate cached copy on write
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

