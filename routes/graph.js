const express = require('express');
const { runQuery } = require('../db/neo4jClient');

const router = express.Router();

/**
 * CREATE a purchase relationship idempotently.
 * Uses a unique orderId / transaction ID to prevent duplicate edges on retries.
 */
router.post('/purchases', async (req, res) => {
  const { customerId, customerName, productId, quantity = 1, orderId } = req.body;
  if (!customerId || typeof customerId !== 'string' || !productId || typeof productId !== 'string') {
    return res.status(400).json({ error: 'customerId and productId are required and must be strings' });
  }

  const parsedQty = Number(quantity);
  if (isNaN(parsedQty) || parsedQty <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  // If orderId is not supplied, generate a deterministic default identifier
  const transactionId = orderId ? String(orderId).trim() : `ORD_${customerId}_${productId}_${Date.now()}`;

  try {
    const result = await runQuery(
      `MERGE (c:Customer {id: $customerId})
         ON CREATE SET c.name = $customerName
       MERGE (p:Product {id: $productId})
       MERGE (c)-[r:PURCHASED {orderId: $transactionId}]->(p)
         ON CREATE SET r.quantity = $quantity, r.timestamp = datetime()
         ON MATCH SET r.quantity = $quantity, r.lastUpdated = datetime()
       RETURN c.id AS customerId, p.id AS productId, r.quantity AS quantity, r.orderId AS orderId, toString(r.timestamp) AS timestamp`,
      {
        customerId,
        customerName: customerName || customerId,
        productId,
        quantity: parsedQty,
        transactionId,
      }
    );
    res.status(201).json(result[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// READ a customer's purchase history
router.get('/customers/:customerId/purchases', async (req, res) => {
  try {
    const result = await runQuery(
      `MATCH (c:Customer {id: $customerId})-[r:PURCHASED]->(p:Product)
       RETURN p.id AS productId, r.quantity AS quantity, r.orderId AS orderId, toString(r.timestamp) AS timestamp
       ORDER BY r.timestamp DESC`,
      { customerId: req.params.customerId }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// READ — "bought together" recommendations for a product
router.get('/products/:productId/recommendations', async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 5));
  try {
    const result = await runQuery(
      `MATCH (p1:Product {id: $productId})<-[:PURCHASED]-(c:Customer)-[:PURCHASED]->(p2:Product)
       WHERE p1 <> p2
       RETURN p2.id AS productId, count(DISTINCT c) AS coPurchaseStrength
       ORDER BY coPurchaseStrength DESC
       LIMIT $limit`,
      { productId: req.params.productId, limit }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * UPDATE a purchase's quantity.
 * If orderId is supplied, updates that specific purchase.
 * Otherwise, accurately updates ONLY the most recent purchase edge between the pair.
 */
router.put('/purchases', async (req, res) => {
  const { customerId, productId, quantity, orderId } = req.body;
  if (!customerId || !productId) {
    return res.status(400).json({ error: 'customerId and productId are required' });
  }

  const parsedQty = Number(quantity);
  if (isNaN(parsedQty) || parsedQty <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  try {
    let result;
    if (orderId) {
      result = await runQuery(
        `MATCH (c:Customer {id: $customerId})-[r:PURCHASED {orderId: $orderId}]->(p:Product {id: $productId})
         SET r.quantity = $quantity, r.lastUpdated = datetime()
         RETURN c.id AS customerId, p.id AS productId, r.quantity AS quantity, r.orderId AS orderId`,
        { customerId, productId, quantity: parsedQty, orderId: String(orderId) }
      );
    } else {
      result = await runQuery(
        `MATCH (c:Customer {id: $customerId})-[r:PURCHASED]->(p:Product {id: $productId})
         WITH r ORDER BY r.timestamp DESC LIMIT 1
         SET r.quantity = $quantity, r.lastUpdated = datetime()
         RETURN c.id AS customerId, p.id AS productId, r.quantity AS quantity, r.orderId AS orderId`,
        { customerId, productId, quantity: parsedQty }
      );
    }

    if (!result.length) return res.status(404).json({ error: 'Purchase relationship not found' });
    res.json(result[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a customer node (and its relationships)
router.delete('/customers/:customerId', async (req, res) => {
  try {
    await runQuery(`MATCH (c:Customer {id: $customerId}) DETACH DELETE c`, {
      customerId: req.params.customerId,
    });
    res.json({ deleted: true, customerId: req.params.customerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

