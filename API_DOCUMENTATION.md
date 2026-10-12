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

## Adaptive Query Router

### `GET /api/query/product/:id`

Intelligently routes a product read request. Serves directly from Redis if active/promoted; otherwise falls back to MongoDB, recording the decision in `routing:decisions`.

**Response 200**

```json
{
  "source": "cache",
  "reason": "Cache hit: active hot item present in Redis",
  "latencyMs": 4,
  "_id": "P1001",
  "name": "Wireless Noise-Cancelling Headphones",
  "category": "electronics",
  "price": 89.99,
  "stock": 214
}
```

### `GET /api/query/decisions`

Returns recent routing decisions logged to Redis (`routing:decisions`). Query params: `limit` (default 20).

**Response 200**

```json
[
  {
    "productId": "P1001",
    "source": "redis-cache",
    "reason": "Cache hit: active hot item present in Redis",
    "latencyMs": 4,
    "timestamp": "2026-10-12T08:21:49.000Z"
  }
]
```

---

## Automatic Storage Optimizer

### `GET /api/optimizer/decisions`

Returns the log of recent cache promotions and demotions from Redis (`optimizer:decisions`). Query params: `limit` (default 20).

**Response 200**

```json
[
  {
    "action": "PROMOTE",
    "productId": "P1001",
    "productName": "Wireless Noise-Cancelling Headphones",
    "forecastValue": 8.5,
    "currentAccessCount": 15,
    "threshold": 3,
    "reason": "High predicted demand (8.5 >= 3) promoted to Redis with TTL 300s",
    "timestamp": "2026-10-12T08:21:49.480Z"
  }
]
```

### `POST /api/optimizer/run`

Triggers an immediate evaluation cycle of the storage optimizer.

**Body** (optional override thresholds):

```json
{ "promoteThreshold": 3, "demoteThreshold": 1 }
```

**Response 200**

```json
{
  "status": "completed",
  "results": {
    "promotions": [...],
    "demotions": [...],
    "evaluations": [...]
  }
}
```

---

## GenAI Natural Language Layer

### `POST /api/ask`

Translates a natural language user query into a safe catalog filter or explains a recent routing/optimizer decision. The LLM produces strictly validated structured JSON; Express executes the datastore operations.

**Body (Product Search):**

```json
{ "query": "Show me products in electronics under $70" }
```

**Response 200 (Product Search):**

```json
{
  "intent": "product_search",
  "filterApplied": { "category": "electronics", "price": { "$lte": 70 } },
  "explanation": "Filtered MongoDB products by {\"category\":\"electronics\",\"maxPrice\":70}",
  "resultCount": 2,
  "products": [
    { "_id": "P1004", "name": "USB-C Hub", "price": 22.99, "category": "electronics" },
    { "_id": "P1002", "name": "Mechanical Keyboard", "price": 64.5, "category": "electronics" }
  ],
  "rawQuery": "Show me products in electronics under $70"
}
```

**Body (Explanation):**

```json
{ "query": "Why was P1001 cached?" }
```

**Response 200 (Explanation):**

```json
{
  "intent": "explanation",
  "target": "optimizer_decision",
  "productId": "P1001",
  "explanation": "Product P1001 was promoted because: High predicted demand (8.5 >= 3) promoted to Redis with TTL 300s.",
  "matchedRecord": { ... },
  "rawQuery": "Why was P1001 cached?"
}
```

---

## Forecasting Microservice (Internal HTTP: 5001)

### `POST /forecast`

Predicts request volume for a product using ARIMA or moving-average fallback.

**Body:**

```json
{ "productId": "P1001", "windowMinutes": 1 }
```

**Response 200:**

```json
{
  "productId": "P1001",
  "predictedDemand": 8.5,
  "modelUsed": "statsmodels-arima(1,0,0)",
  "confidence": 0.85,
  "historicalPoints": 12,
  "currentAccessCount": 15,
  "details": { "aic": 24.1 }
}
```

---

## Stats

### `GET /api/stats`

Returns recent access-log entries and per-product access counts, sourced
from Redis.

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
