require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');

const { connectMongo } = require('./db/mongoClient');
const { connectRedis, redisClient } = require('./db/redisClient');
const { verifyConnection: verifyNeo4j, getDriver } = require('./db/neo4jClient');
const { checkForecastingHealth } = require('./services/forecastingClient');

const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const graphRoutes = require('./routes/graph');
const statsRoutes = require('./routes/stats');
const routerRoutes = require('./routes/router');
const optimizerRoutes = require('./routes/optimizer');
const askRoutes = require('./routes/ask');
const simulatorRoutes = require('./routes/simulator');
const { startOptimizer } = require('./services/storageOptimizer');
const path = require('path');

const app = express();
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin.split(',').map((s) => s.trim()) } : {}));
app.use(express.json());

app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', async (req, res) => {
  const [redisOk, mongoOk, neo4jOk, forecastingOk] = await Promise.all([
    redisClient.ping().then(() => true).catch(() => false),
    Promise.resolve(mongoose.connection.readyState === 1),
    getDriver() ? getDriver().verifyConnectivity().then(() => true).catch(() => false) : Promise.resolve(false),
    checkForecastingHealth(),
  ]);

  const checks = {
    redis: redisOk ? 'online' : 'offline',
    mongodb: mongoOk ? 'online' : 'offline',
    neo4j: neo4jOk ? 'online' : 'offline',
    forecasting: forecastingOk ? 'online' : 'offline',
  };

  const isHealthy = redisOk && mongoOk;
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/query', routerRoutes);
app.use('/api/optimizer', optimizerRoutes);
app.use('/api/ask', askRoutes);
app.use('/api/simulator', simulatorRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;

async function start() {
  await connectRedis();
  try {
    await connectMongo();
  } catch (err) {
    console.warn('[MongoDB] connection failed — product routes will error until it is reachable:', err.message);
  }
  try {
    await verifyNeo4j();
  } catch (err) {
    console.warn('[Neo4j] connection failed — graph routes will error until it is reachable:', err.message);
  }

  // Start background storage optimizer
  startOptimizer();

  app.listen(PORT, () => console.log(`[Server] Listening on port ${PORT}`));
}

start();

module.exports = app;
