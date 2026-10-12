# Progress Report — Review 2

## Summary

Since Review 1 (design phase), the following has been implemented as working
source code: database connection modules for Redis, MongoDB, and Neo4j; full
CRUD route handlers for each of the three databases; a sample dataset (12
products, 5 users, 14 purchase relationships); a seed script; a Docker
Compose configuration orchestrating all four services (Redis, MongoDB, Neo4j,
API gateway); and an access-logging module that records per-request latency
and source database, laying the groundwork for the adaptive routing and
forecasting layer planned for later phases.

## What was verified live

The build environment used for development does not have Docker available,
so MongoDB and Neo4j (which require their own server binaries) could not be
installed directly in this environment. Redis, however, is installable via
the standard Ubuntu package repository, so the full Redis-backed cart CRUD
flow was run live end-to-end against a real Redis instance:

```
POST /api/cart/CART001/items {"productId":"P1001","quantity":2}
  -> {"cartId":"CART001","items":{"P1001":"2"}}

POST /api/cart/CART001/items {"productId":"P1002","quantity":1}
  -> {"cartId":"CART001","items":{"P1001":"2","P1002":"1"}}

GET /api/cart/CART001
  -> {"cartId":"CART001","items":{"P1001":"2","P1002":"1"}}

PUT /api/cart/CART001/items/P1001 {"quantity":5}
  -> {"cartId":"CART001","items":{"P1001":"5","P1002":"1"}}

DELETE /api/cart/CART001/items/P1002
  -> {"deleted":true,"productId":"P1002"}

GET /api/cart/CART001
  -> {"cartId":"CART001","items":{"P1001":"5"}}

DELETE /api/cart/CART001
  -> {"deleted":true,"cartId":"CART001"}

GET /api/cart/CART001
  -> {"cartId":"CART001","items":{}}
```

This confirms Create, Read, Update, and Delete all function correctly against
a real Redis instance, including TTL-based expiry and hash-field deletion
behaviour.

The server's startup sequence was also verified to degrade gracefully when
MongoDB and Neo4j are unreachable: it logs a clear warning per database and
continues serving the routes that do not depend on them, rather than
crashing outright — confirmed by the following real startup log:

```
[Redis] Connected
[MongoDB] connection failed — product routes will error until it is reachable: connect ECONNREFUSED 127.0.0.1:27017
[Neo4j] connection failed — graph routes will error until it is reachable: connect ECONNREFUSED 127.0.0.1:7687
[Server] Listening on port 4000
```

## What is implemented but requires Docker for live verification

The MongoDB product routes (Mongoose schema, CRUD handlers, cache-aside
read-through logic) and the Neo4j graph routes (Cypher queries for purchase
recording, recommendation lookup, and customer deletion) are complete and
were checked for syntactic and logical correctness against the Mongoose and
neo4j-driver APIs, but full live execution requires `docker compose up`,
which needs to be run in an environment with Docker installed (the
student's own machine). This is disclosed here rather than presented as
already verified, in keeping with an accurate progress record.

## Data Modeling Decisions Applied

- **MongoDB**: the `Product` schema uses a `Mixed`-type `attributes`
  subdocument so that category-specific fields (e.g. `batteryLifeHrs` for
  electronics, `size` for apparel) do not require a rigid shared schema
  across all products — embedding rather than referencing, since attributes
  are always read together with the parent product.
- **Indexing**: `category`, `tags`, and a compound `(category, price)` index
  were added to `Product` to support the catalog's most common query shape
  (browse by category, sorted/filtered by price) without a full collection
  scan.
- **Redis**: cart data uses Redis hashes (`cart:{cartId}` → field-per-product)
  rather than one key per item, since a cart's items are always read and
  written together — this is a referencing-vs-embedding decision translated
  to the key-value model. TTL is applied at the whole-hash level (24h) to
  avoid orphaned abandoned carts.
- **Neo4j**: purchases are modelled as a relationship (`PURCHASED`) with
  properties (`timestamp`, `quantity`) rather than as separate Purchase
  nodes, since no query in this application needs to address a purchase
  event independently of the customer-product pair it connects — this keeps
  the "bought together" traversal a single-hop pattern match rather than a
  two-hop one.

## Remaining Work (Next Phase)

- Wire the existing access-logger data into an actual forecasting/routing
  decision layer (Review 1's adaptive-routing design).
- Add the GenAI natural-language query layer on top of the existing REST
  routes.
- Expand the seed dataset and add basic integration tests.
