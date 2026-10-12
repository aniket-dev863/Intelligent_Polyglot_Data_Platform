require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectMongo } = require('../db/mongoClient');
const { runQuery, getDriver } = require('../db/neo4jClient');
const Product = require('../models/Product');
const User = require('../models/User');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-data.json'), 'utf-8'));

async function seedMongo() {
  await Product.deleteMany({});
  await User.deleteMany({});
  await Product.insertMany(data.products);
  await User.insertMany(data.users);
  console.log(`[Seed] MongoDB: inserted ${data.products.length} products, ${data.users.length} users`);
}

async function seedNeo4j() {
  await runQuery('MATCH (n) DETACH DELETE n');
  for (const u of data.users) {
    await runQuery('MERGE (c:Customer {id: $id}) SET c.name = $name', { id: u._id, name: u.name });
  }
  for (const p of data.products) {
    await runQuery('MERGE (p:Product {id: $id}) SET p.name = $name, p.category = $category', {
      id: p._id, name: p.name, category: p.category,
    });
  }
  for (const pur of data.purchases) {
    await runQuery(
      `MATCH (c:Customer {id: $customerId}), (p:Product {id: $productId})
       CREATE (c)-[:PURCHASED {timestamp: datetime(), quantity: $quantity}]->(p)`,
      pur
    );
  }
  console.log(`[Seed] Neo4j: created ${data.users.length} customers, ${data.products.length} products, ${data.purchases.length} purchase edges`);
}

async function main() {
  await connectMongo();
  await seedMongo();

  try {
    await seedNeo4j();
  } catch (err) {
    console.warn('[Seed] Neo4j seeding skipped (not reachable):', err.message);
  }

  console.log('[Seed] Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[Seed] Failed:', err);
  process.exit(1);
});
