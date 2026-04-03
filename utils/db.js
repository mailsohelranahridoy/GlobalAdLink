const { Pool } = require('pg');

let pool = null;

async function initDb() {
    const connectionString = process.env.PG_CONN;
    if (!connectionString) {
        throw new Error('PG_CONN environment variable is not set');
    }
    
    pool = new Pool({
        connectionString,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    
    // Test connection
    const client = await pool.connect();
    try {
        await client.query('SELECT NOW()');
        console.log('✅ PostgreSQL connection successful');
    } finally {
        client.release();
    }
    
    return pool;
}

function getDb() {
    if (!pool) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return pool;
}

module.exports = { initDb, getDb, db: { query: (...args) => getDb().query(...args) } };
