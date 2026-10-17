/**
 * graphIdempotency.test.js
 *
 * Tests the Neo4j purchase write semantics introduced in routes/graph.js.
 *
 * Two layers:
 *   1. Static / structural — verify the Cypher templates in the route file contain
 *      the MERGE + orderId pattern and the LIMIT 1 guard.  These pass with no services.
 *   2. Live integration — run against a real Neo4j instance.  These are skipped when
 *      Neo4j is unreachable so CI does not fail on environments without Neo4j.
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ────────────────────────────────────────────────────────────────────────────
// 1. Static / structural checks (no services required)
// ────────────────────────────────────────────────────────────────────────────

describe('Neo4j Graph Route — Static Cypher Idempotency Checks', () => {
  let graphSource;

  before(() => {
    graphSource = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'graph.js'),
      'utf8'
    );
  });

  test('POST /purchases uses MERGE (not CREATE) for the PURCHASED relationship', () => {
    // Ensure the edge is created with MERGE so that replaying the same request
    // does not produce a duplicate relationship.
    assert.ok(
      graphSource.includes('MERGE (c)-[r:PURCHASED {orderId: $transactionId}]'),
      'Expected MERGE on PURCHASED with orderId; found CREATE or missing orderId constraint'
    );
  });

  test('POST /purchases uses ON CREATE SET / ON MATCH SET semantics', () => {
    assert.ok(
      graphSource.includes('ON CREATE SET'),
      'Expected ON CREATE SET clause for idempotent creation'
    );
    assert.ok(
      graphSource.includes('ON MATCH SET'),
      'Expected ON MATCH SET clause to handle replayed requests without side-effects'
    );
  });

  test('PUT /purchases without orderId uses ORDER BY + LIMIT 1 to target a single edge', () => {
    // Without this guard the SET clause would fan-out to ALL edges between the
    // customer-product pair, silently corrupting unrelated historical purchases.
    assert.ok(
      graphSource.includes('WITH r ORDER BY r.timestamp DESC LIMIT 1'),
      'Expected "WITH r ORDER BY r.timestamp DESC LIMIT 1" in PUT handler'
    );
  });

  test('PUT /purchases with orderId matches on the specific orderId property', () => {
    assert.ok(
      graphSource.includes('[r:PURCHASED {orderId: $orderId}]'),
      'Expected PUT handler to match relationship by specific orderId'
    );
  });

  test('POST /purchases validates customerId and productId types', () => {
    assert.ok(
      graphSource.includes("typeof customerId !== 'string'"),
      'Expected string-type guard on customerId'
    );
  });

  test('POST /purchases generates a fallback orderId when none is supplied', () => {
    // The generated id uses ORD_<cid>_<pid>_<timestamp> so that it is unique per
    // calendar-millisecond even without an explicit caller-supplied order id.
    assert.ok(
      graphSource.includes('ORD_${customerId}_${productId}'),
      'Expected auto-generated orderId containing ORD_<customerId>_<productId>'
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Live integration checks (skipped when Neo4j is unavailable)
// ────────────────────────────────────────────────────────────────────────────

describe('Neo4j Graph Route — Live Idempotency Integration Tests', () => {
  let neo4jAvailable = false;
  let runQuery, verifyConnection, getDriver;

  const TEST_CUSTOMER = `TEST_CUST_IDEM_${Date.now()}`;
  const TEST_PRODUCT = `TEST_PROD_IDEM_${Date.now()}`;
  const TEST_ORDER = `TEST_ORD_IDEM_${Date.now()}`;

  before(async () => {
    try {
      ({ runQuery, verifyConnection, getDriver } = require('../db/neo4jClient'));
      await verifyConnection();
      neo4jAvailable = true;
    } catch {
      // Neo4j is not reachable — live tests will be skipped via early return guards.
    }
  });

  after(async () => {
    if (!neo4jAvailable) return;
    // Clean up test nodes created during this run.
    try {
      await runQuery(`MATCH (c:Customer {id: $cid}) DETACH DELETE c`, { cid: TEST_CUSTOMER });
      await runQuery(`MATCH (p:Product {id: $pid}) DETACH DELETE p`, { pid: TEST_PRODUCT });
      await getDriver().close();
    } catch {
      // Best-effort cleanup; swallow errors.
    }
  });

  test('Replaying POST /purchases with the same orderId creates exactly one PURCHASED edge', async (t) => {
    if (!neo4jAvailable) {
      t.skip('Neo4j not reachable — skipping live idempotency test');
      return;
    }

    // Submit the same purchase twice (simulates a retry / at-least-once delivery).
    const cypher = `
      MERGE (c:Customer {id: $customerId})
        ON CREATE SET c.name = $customerName
      MERGE (p:Product {id: $productId})
      MERGE (c)-[r:PURCHASED {orderId: $transactionId}]->(p)
        ON CREATE SET r.quantity = $quantity, r.timestamp = datetime()
        ON MATCH SET r.quantity = $quantity, r.lastUpdated = datetime()
      RETURN c.id AS customerId, p.id AS productId, r.quantity AS quantity, r.orderId AS orderId
    `;
    const params = {
      customerId: TEST_CUSTOMER,
      customerName: TEST_CUSTOMER,
      productId: TEST_PRODUCT,
      quantity: 2,
      transactionId: TEST_ORDER,
    };

    await runQuery(cypher, params);
    await runQuery(cypher, params); // intentional retry

    // Count relationships between this specific customer and product.
    const countResult = await runQuery(
      `MATCH (c:Customer {id: $customerId})-[r:PURCHASED]->(p:Product {id: $productId})
       RETURN count(r) AS edgeCount`,
      { customerId: TEST_CUSTOMER, productId: TEST_PRODUCT }
    );

    const edgeCount = countResult[0]?.edgeCount;
    // neo4j-driver returns integers as neo4j Integer objects; normalise to JS number.
    const count =
      typeof edgeCount === 'object' && edgeCount !== null && 'toNumber' in edgeCount
        ? edgeCount.toNumber()
        : Number(edgeCount);

    assert.equal(
      count,
      1,
      `Expected exactly 1 PURCHASED edge after two identical requests; found ${count}`
    );
  });

  test('PUT /purchases without orderId updates only the most-recent edge', async (t) => {
    if (!neo4jAvailable) {
      t.skip('Neo4j not reachable — skipping live PUT idempotency test');
      return;
    }

    // Create two distinct purchase edges for the same customer-product pair.
    const createEdge = async (orderId, quantity) => {
      await runQuery(
        `MERGE (c:Customer {id: $customerId})
         MERGE (p:Product {id: $productId})
         MERGE (c)-[r:PURCHASED {orderId: $orderId}]->(p)
           ON CREATE SET r.quantity = $quantity, r.timestamp = datetime()`,
        {
          customerId: TEST_CUSTOMER,
          productId: TEST_PRODUCT,
          orderId,
          quantity,
        }
      );
    };

    const ORDER_A = `${TEST_ORDER}_A`;
    const ORDER_B = `${TEST_ORDER}_B`;
    await createEdge(ORDER_A, 1);
    // Brief pause so ORDER_B has a strictly later timestamp.
    await new Promise((r) => setTimeout(r, 50));
    await createEdge(ORDER_B, 1);

    // PUT without orderId should only touch ORDER_B (most recent).
    await runQuery(
      `MATCH (c:Customer {id: $customerId})-[r:PURCHASED]->(p:Product {id: $productId})
       WITH r ORDER BY r.timestamp DESC LIMIT 1
       SET r.quantity = $quantity, r.lastUpdated = datetime()`,
      { customerId: TEST_CUSTOMER, productId: TEST_PRODUCT, quantity: 99 }
    );

    const edges = await runQuery(
      `MATCH (c:Customer {id: $customerId})-[r:PURCHASED]->(p:Product {id: $productId})
       RETURN r.orderId AS orderId, r.quantity AS quantity
       ORDER BY r.timestamp ASC`,
      { customerId: TEST_CUSTOMER, productId: TEST_PRODUCT }
    );

    // ORDER_A must remain unchanged.
    const edgeA = edges.find((e) => e.orderId === ORDER_A);
    const edgeB = edges.find((e) => e.orderId === ORDER_B);

    assert.ok(edgeA, 'ORDER_A edge should still exist');
    assert.ok(edgeB, 'ORDER_B edge should still exist');

    const qtyA =
      typeof edgeA.quantity === 'object' ? edgeA.quantity.toNumber() : Number(edgeA.quantity);
    const qtyB =
      typeof edgeB.quantity === 'object' ? edgeB.quantity.toNumber() : Number(edgeB.quantity);

    assert.equal(qtyA, 1, `ORDER_A quantity should be unchanged (1); got ${qtyA}`);
    assert.equal(qtyB, 99, `ORDER_B (most-recent) quantity should be updated to 99; got ${qtyB}`);
  });
});
