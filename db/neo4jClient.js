const neo4j = require('neo4j-driver');

let driver;

function getDriver() {
  if (!driver) {
    const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
    const user = process.env.NEO4J_USER || 'neo4j';
    const password = process.env.NEO4J_PASSWORD || 'password';
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: 5000,
    });
  }
  return driver;
}

async function runQuery(cypher, params = {}) {
  const session = getDriver().session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((r) => r.toObject());
  } finally {
    await session.close();
  }
}

async function verifyConnection() {
  await getDriver().verifyConnectivity();
  console.log('[Neo4j] Connected');
}

module.exports = { getDriver, runQuery, verifyConnection };
