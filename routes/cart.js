const express = require('express');
const { redisClient } = require('../db/redisClient');

const router = express.Router();
const CART_TTL_SECONDS = 60 * 60 * 24; // 24h

function cartKey(cartId) {
  return `cart:${cartId}`;
}

// CREATE / ADD item (HSET on a Redis hash: cart:{cartId} -> { productId: quantity })
router.post('/:cartId/items', async (req, res) => {
  const { cartId } = req.params;
  const { productId, quantity = 1 } = req.body;
  if (!productId) return res.status(400).json({ error: 'productId is required' });

  try {
    await redisClient.hIncrBy(cartKey(cartId), productId, Number(quantity));
    await redisClient.expire(cartKey(cartId), CART_TTL_SECONDS);
    const cart = await redisClient.hGetAll(cartKey(cartId));
    res.status(201).json({ cartId, items: cart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// READ full cart
router.get('/:cartId', async (req, res) => {
  try {
    const items = await redisClient.hGetAll(cartKey(req.params.cartId));
    res.json({ cartId: req.params.cartId, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE item quantity (absolute set, not increment)
router.put('/:cartId/items/:productId', async (req, res) => {
  const { cartId, productId } = req.params;
  const { quantity } = req.body;
  if (quantity == null) return res.status(400).json({ error: 'quantity is required' });

  try {
    if (Number(quantity) <= 0) {
      await redisClient.hDel(cartKey(cartId), productId);
    } else {
      await redisClient.hSet(cartKey(cartId), productId, String(quantity));
    }
    const cart = await redisClient.hGetAll(cartKey(cartId));
    res.json({ cartId, items: cart });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE single item
router.delete('/:cartId/items/:productId', async (req, res) => {
  try {
    await redisClient.hDel(cartKey(req.params.cartId), req.params.productId);
    res.json({ deleted: true, productId: req.params.productId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE whole cart
router.delete('/:cartId', async (req, res) => {
  try {
    await redisClient.del(cartKey(req.params.cartId));
    res.json({ deleted: true, cartId: req.params.cartId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
