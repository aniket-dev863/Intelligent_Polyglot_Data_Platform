# API Documentation — Intelligent Polyglot Data Platform

Base URL (local): `http://localhost:4000`

All request/response bodies are JSON. Errors return `{ "error": "<message>" }`
with an appropriate HTTP status code.

---

## Health

### `GET /health`

Returns server liveness status.

**Response 200**

```json
{ "status": "ok", "timestamp": "2026-09-24T07:38:09.912Z" }
```

---

## Products (MongoDB)

### `POST /api/products`

Create a new product.

**Body**

```json
{
  "_id": "P1013",
  "name": "Bluetooth Speaker",
  "category": "electronics",
  "price": 39.99,
  "attributes": { "waterproof": true },
  "tags": ["trending"],
  "stock": 100
}
```

**Response 201** — the created product document.

### `GET /api/products`

List products. Query params: `category` (optional filter), `limit` (default 20), `skip` (default 0).

### `GET /api/products/:id`

Fetch a single product. Uses a cache-aside pattern: checks Redis
(`cache:product:{id}`) first; on a miss, reads MongoDB and logs the access.
Response includes a `source` field: `"cache"` or `"mongodb"`.

### `PUT /api/products/:id`

Update a product. Invalidates any cached copy in Redis on success.

### `DELETE /api/products/:id`

Delete a product and invalidate its Redis cache entry.

---

## Cart (Redis)

### `POST /api/cart/:cartId/items`

Add an item to a cart (increments quantity if the item already exists).

**Body**

```json
{ "productId": "P1001", "quantity": 2 }
```

**Response 201**

```json
{ "cartId": "CART001", "items": { "P1001": "2" } }
```

### `GET /api/cart/:cartId`

Retrieve the full cart contents.

### `PUT /api/cart/:cartId/items/:productId`

Set an item's quantity to an absolute value. A quantity of 0 or less removes
the item.

### `DELETE /api/cart/:cartId/items/:productId`

Remove a single item from the cart.

### `DELETE /api/cart/:cartId`

Delete the entire cart.

---

## Graph — Purchases & Recommendations (Neo4j)

### `POST /api/graph/purchases`

Record a purchase, creating the Customer/Product nodes if they do not yet exist.

**Body**

```json
{
  "customerId": "U001",
  "customerName": "Asha Menon",
  "productId": "P1001",
  "quantity": 1
}
```

### `GET /api/graph/customers/:customerId/purchases`

Returns a customer's purchase history, most recent first.

### `GET /api/graph/products/:productId/recommendations`

Returns up to 5 "bought together" product recommendations, ranked by
co-purchase strength (distinct customers who bought both products).

### `PUT /api/graph/purchases`

Update the quantity on an existing purchase relationship.

**Body**

```json
{ "customerId": "U001", "productId": "P1001", "quantity": 3 }
```

### `DELETE /api/graph/customers/:customerId`

Delete a customer node and all its relationships (`DETACH DELETE`).

---

## Stats

### `GET /api/stats`

Returns recent access-log entries and per-product access counts, sourced
from Redis. This is the data a future forecasting/optimization layer (see
Review 1 design) would consume to decide cache pre-promotion.

**Response 200**

```json
{
  "recentAccess": [
    {
      "productId": "P1001",
      "source": "mongodb",
      "latencyMs": 12,
      "timestamp": "2026-09-24T07:40:00.000Z"
    }
  ],
  "accessCounts": { "P1001": "3", "P1002": "1" }
}
```
