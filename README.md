# Intelligent Polyglot Data Platform — Backend Prototype

Backend prototype for BCSE406 (NoSQL Databases) Review 2: a polyglot persistence
gateway unifying Redis (key-value), MongoDB (document), and Neo4j (graph)
behind a single Express API.

## Stack
- Node.js + Express (API gateway)
- Redis — sessions/cart, access-log cache
- MongoDB (via Mongoose) — product catalog, users
- Neo4j (via neo4j-driver) — purchase graph, recommendations

## Running with Docker Compose (recommended)

```bash
docker compose up --build
```

This starts Redis, MongoDB, Neo4j, and the API gateway together, networked
via Docker Compose. The API is available at `http://localhost:4000`.

Once containers are up, seed the sample dataset:

```bash
docker compose exec api node scripts/seed.js
```

## Running locally without Docker

Requires Redis, MongoDB, and Neo4j installed and running locally.

```bash
npm install
cp .env.example .env   # edit if your local DB ports/credentials differ
node scripts/seed.js   # load sample dataset
node server.js
```

## API Endpoints

See `API_DOCUMENTATION.md` for the full endpoint reference.

## Project Structure

```
server.js              Express app entrypoint
db/                     Database connection modules (Mongo, Redis, Neo4j)
models/                 Mongoose schemas (Product, User)
routes/                 CRUD route handlers per database
scripts/                Seed script, sample dataset, access logger
docker-compose.yml      Full stack orchestration
Dockerfile              API container build
```

## Verified in this environment

The Redis-backed cart CRUD flow (create/read/update/delete) was run live
against a real Redis instance during development — see `PROGRESS_REPORT.md`
for the test transcript. MongoDB and Neo4j routes are implemented and
Mongoose/Cypher-verified for correctness, but require `docker compose up`
(Docker Desktop on your machine) for full live end-to-end testing, since
those engines are not installable in this sandboxed build environment.
