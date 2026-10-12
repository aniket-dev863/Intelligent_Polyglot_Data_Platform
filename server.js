require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const { connectMongo } = require('./db/mongoClient');
const { connectRedis } = require('./db/redisClient');
const { verifyConnection: verifyNeo4j } = require('./db/neo4jClient');

const productRoutes = require('./routes/products');
const cartRoutes = require('./routes/cart');
const graphRoutes = require('./routes/graph');
const statsRoutes = require('./routes/stats');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api/stats', statsRoutes);

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

  app.listen(PORT, () => console.log(`[Server] Listening on port ${PORT}`));
}

start();

module.exports = app;
