const express = require('express');
const { runQuery } = require('../db/neo4jClient');

const router = express.Router();

// CREATE a purchase relationship (also creates Customer/Product nodes if new)
router.post('/purchases', async (req, res) => {
  const { customerId, customerName, productId, quantity = 1 } = req.body;
  if (!customerId || !productId) {
    return res.status(400).json({ error: 'customerId and productId are required' });
  }
  try {
    const result = await runQuery(
      `MERGE (c:Customer {id: $customerId})
         ON CREATE SET c.name = $customerName
       MERGE (p:Product {id: $productId})
       CREATE (c)-[r:PURCHASED {timestamp: datetime(), quantity: $quantity}]->(p)
       RETURN c.id AS customerId, p.id AS productId, r.quantity AS quantity`,
      { customerId, customerName: customerName || customerId, productId, quantity: Number(quantity) }
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
       RETURN p.id AS productId, r.quantity AS quantity, toString(r.timestamp) AS timestamp
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
  try {
    const result = await runQuery(
      `MATCH (p1:Product {id: $productId})<-[:PURCHASED]-(c:Customer)-[:PURCHASED]->(p2:Product)
       WHERE p1 <> p2
       RETURN p2.id AS productId, count(DISTINCT c) AS coPurchaseStrength
       ORDER BY coPurchaseStrength DESC
       LIMIT 5`,
      { productId: req.params.productId }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE a purchase's quantity (matches the most recent purchase edge between the pair)
router.put('/purchases', async (req, res) => {
  const { customerId, productId, quantity } = req.body;
  try {
    const result = await runQuery(
      `MATCH (c:Customer {id: $customerId})-[r:PURCHASED]->(p:Product {id: $productId})
       SET r.quantity = $quantity
       RETURN c.id AS customerId, p.id AS productId, r.quantity AS quantity`,
      { customerId, productId, quantity: Number(quantity) }
    );
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
