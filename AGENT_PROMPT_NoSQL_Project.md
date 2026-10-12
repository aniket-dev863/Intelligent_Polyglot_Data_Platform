# Task: Complete the Intelligent Polyglot Data Platform

## Project Context

This is a BCSE406 (NoSQL Databases) course project. The repository already
contains a working backend prototype (Review 2 deliverable) implementing
basic polyglot persistence across three databases. Your job is to build the
remaining ~60% of the system: adaptive query routing, a forecasting-driven
storage optimizer, a GenAI natural-language layer, and a minimal stats
dashboard — the parts that were explicitly deferred in Review 2.

**Do not rewrite or restructure what already exists.** Extend it. Read the
existing code first and match its conventions (file layout, error-handling
style, naming) before writing anything new.

## What Already Exists (read these first)

```
server.js                      Express app entrypoint, wires all routes
db/mongoClient.js              Mongoose connection, 5s fail-fast timeout
db/redisClient.js              Redis client (node-redis v4 API)
db/neo4jClient.js              Neo4j driver connection + runQuery helper
models/Product.js              Mongoose schema: category/tags/price indexes, Mixed attributes
models/User.js                 Mongoose schema: unique email index
routes/products.js             MongoDB CRUD + cache-aside read pattern (checks Redis first)
routes/cart.js                 Redis hash-based cart CRUD (cart:{cartId})
routes/graph.js                Neo4j CRUD: purchases, recommendations, customer deletion
routes/stats.js                Returns recent access log + per-product access counts
scripts/accessLogger.js        Logs every product read to Redis (access:log list, access:count hash)
scripts/seed.js                Seeds sample dataset into MongoDB + Neo4j
scripts/sample-data.json       12 products, 5 users, 14 purchases
docker-compose.yml             Redis + MongoDB + Neo4j + API, networked together
Dockerfile                     API container build
API_DOCUMENTATION.md           Full existing endpoint reference
PROGRESS_REPORT.md             What was built and verified in Review 2
```

Key existing conventions to preserve:
- Every route file exports an Express `Router`, mounted in `server.js` under `/api/<name>`.
- Errors are caught per-route and returned as `{ error: message }` with an appropriate status code — no global error-swallowing.
- Each DB connection module degrades gracefully (logs a warning, doesn't crash the server) if its database is unreachable — any new DB-touching code must follow the same pattern.
- `scripts/accessLogger.js`'s `access:count` Redis hash (`productId -> hit count`) is the existing signal; the forecasting engine you build should consume this, not invent a parallel logging mechanism.

## Architecture You're Completing

Reference: Review 1's architecture diagram — Frontend → Express Gateway →
{Query Router, Forecasting Engine, Storage Optimizer} → {Redis, MongoDB,
Neo4j} → Access Log (feedback loop) → GenAI Layer (NL query + explanation).

## Tasks (implement in this order — each should leave the app runnable)

### 1. Adaptive Query Router (`routes/router.js` + `services/queryRouter.js`)
- Add a unified endpoint `GET /api/query/product/:id` that decides whether to
  serve from Redis cache or MongoDB based on the item's current state in
  `access:count` — wrap the existing logic from `routes/products.js`'s
  cache-aside pattern into a reusable `services/queryRouter.js` module so
  both the REST routes and the future GenAI layer can call it.
- Log the routing decision (which DB served it, why) to a new Redis list
  `routing:decisions` so it's inspectable later.

### 2. Forecasting Engine (`services/forecasting/`)
- Build a small Python microservice (`services/forecasting/app.py`, Flask or
  FastAPI) that:
  - Reads `access:count` and a time-windowed history you'll add to
    `accessLogger.js` (bucket access log entries into fixed time windows,
    e.g. per-minute counts per product, stored as a Redis sorted set or list
    per product).
  - Exposes `POST /forecast` accepting a productId and returning a
    predicted next-window request volume, using `statsmodels` (ARIMA) or
    `Prophet`. Fall back to a simple moving average if there isn't enough
    history yet (don't crash on cold-start items).
  - Add this service to `docker-compose.yml` as a new `forecasting` service,
    and add a thin Node client (`services/forecastingClient.js`) that the
    Express app uses to call it over HTTP.
- Write a short `services/forecasting/README.md` explaining the model choice
  and how to retrain/evaluate it (MAE/RMSE against a held-out slice of the
  seeded access log).

### 3. Automatic Storage Optimizer (`services/storageOptimizer.js`)
- A background job (use `node-cron` or a simple `setInterval`, document
  which and why) that, every N seconds:
  - Calls the forecasting service for recently-active products.
  - If predicted demand exceeds a configurable threshold (env var,
    documented in `.env.example`), promotes that product from MongoDB into
    Redis (`cache:product:{id}`) with a TTL — reuse the existing cache key
    pattern from `routes/products.js`.
  - Demotes/evicts cache entries whose actual access has fallen below a
    lower threshold for a sustained period.
  - Logs every promotion/demotion decision (product, reason, forecast value)
    to a new Redis list `optimizer:decisions`.
- Expose `GET /api/optimizer/decisions` returning the recent decision log.

### 4. GenAI Layer (`services/genai/`)
- `POST /api/ask` accepting `{ "query": "<natural language>" }`.
- Use a pretrained LLM API (Anthropic Claude or OpenAI — pick one, make the
  provider swappable via env var) with a system prompt constrained to return
  **structured JSON only** — either a query specification (target
  collection/store + filter) or, for explanation requests, a short plain-English
  explanation string pulled from `routing:decisions` / `optimizer:decisions`.
- **Critical constraint: the LLM must never execute a database operation
  directly.** Your Express code parses its structured JSON output and is the
  only thing that touches Redis/MongoDB/Neo4j. Validate the LLM's output
  shape before acting on it; reject and return an error on malformed output
  rather than guessing.
- Support at least these two query intents end-to-end:
  - "Show me products in <category> under $<price>" → translates to a
    MongoDB filter via `routes/products.js`'s existing list endpoint.
  - "Why was <product> cached?" / "Why was <product> promoted?" → looks up
    the most recent matching entry in `optimizer:decisions` and asks the
    LLM to phrase it in plain English.

### 5. Minimal Stats Dashboard (`public/dashboard.html` or a small React/Vite app)
- A single page, served statically by Express (or a separate lightweight
  dev server — your choice, document which), showing:
  - Recent access log (from existing `GET /api/stats`).
  - Recent routing decisions (`routing:decisions`).
  - Recent optimizer decisions (`optimizer:decisions`).
  - A simple text input hitting `POST /api/ask` for the NL query feature.
- Keep this deliberately simple — plain HTML/JS/fetch is fine, this is not
  the graded centerpiece. Do not introduce a heavy frontend framework unless
  one is already implied by the rest of the stack.

### 6. Tests and Documentation Updates
- Add basic integration tests (Jest or Node's built-in test runner — match
  whichever has lower setup friction) for: the query router's cache-hit vs
  cache-miss paths, the optimizer's promote/demote decision logic (mock the
  forecasting client), and the GenAI layer's JSON-validation/rejection path.
- Update `API_DOCUMENTATION.md` with every new endpoint, matching the
  existing doc's format exactly (same heading style, same request/response
  example style).
- Update `PROGRESS_REPORT.md` with what was added in this phase, and be
  explicit and honest about what was and wasn't live-tested — follow the
  same honesty convention already in that file (see its "Live Verification"
  and "requires Docker" sections for the tone to match).
- Update `docker-compose.yml` and `.env.example` for every new service/env
  var introduced.

## Constraints

- Keep using the existing stack: Node/Express, Mongoose, node-redis,
  neo4j-driver. Python is acceptable only for the forecasting microservice.
- Do not add authentication/authorization — out of scope for this course
  project.
- Do not change the existing CRUD route behavior or response shapes from
  Review 2 — only add to them.
- Every new piece of code should degrade gracefully if its dependency
  (forecasting service, LLM API) is unavailable — log a clear warning,
  don't crash the whole server, matching the existing DB-connection pattern.
- Commit incrementally with clear messages per logical unit (router,
  forecasting service, optimizer, GenAI layer, dashboard, tests/docs) —
  this maps to how the project will be explained in the next review.

## Definition of Done

- `docker compose up --build` brings up all services (Redis, MongoDB,
  Neo4j, forecasting microservice, API) with no manual steps beyond running
  `scripts/seed.js`.
- `/api/query/product/:id`, `/api/optimizer/decisions`, and `/api/ask` all
  return real responses against the seeded dataset.
- The dashboard page loads and shows live data from the running stack.
- `API_DOCUMENTATION.md` and `PROGRESS_REPORT.md` are updated and accurate
  — no claims about functionality that wasn't actually run and checked.
