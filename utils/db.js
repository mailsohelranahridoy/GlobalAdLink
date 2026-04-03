const { Pool } = require('pg');

let pool = null;
let isConnected = false;

// Extract hostname from connection string (remove IPv6)
function extractHostname(connStr) {
    const match = connStr.match(/@([^:]+):/);
    if (!match) return 'localhost';
    
    let host = match[1];
    
    // If it's IPv6 address (contains colons), extract domain name
    if (host.includes(':') && !host.startsWith('[')) {
        const dbMatch = connStr.match(/db\.([^.]+)\.supabase\.co/);
        if (dbMatch) {
            return `db.${dbMatch[1]}.supabase.co`;
        }
        const hostMatch = connStr.match(/@([a-zA-Z0-9\-\.]+)/);
        if (hostMatch) {
            return hostMatch[1];
        }
    }
    return host;
}

async function initDb() {
    const connectionString = process.env.PG_CONN;
    
    if (!connectionString) {
        console.error('PG_CONN environment variable is not set');
        return null;
    }
    
    const host = extractHostname(connectionString);
    
    const config = {
        connectionString: connectionString,
        ssl: {
            rejectUnauthorized: false
        },
        host: host,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 10
    };
    
    pool = new Pool(config);
    
    pool.on('error', (err) => {
        console.error('Unexpected database error:', err.message);
        isConnected = false;
    });
    
    try {
        const client = await pool.connect();
        await client.query('SELECT NOW()');
        console.log('PostgreSQL connected successfully');
        client.release();
        isConnected = true;
    } catch (err) {
        console.error('PostgreSQL connection failed:', err.message);
        isConnected = false;
    }
    
    return pool;
}

function getDb() {
    if (!pool) {
        throw new Error('Database not initialized. Call initDb() first.');
    }
    return pool;
}

async function query(text, params) {
    if (!isConnected) {
        console.error('Database not connected - query skipped');
        return { rows: [] };
    }
    try {
        return await pool.query(text, params);
    } catch (err) {
        console.error('Query error:', err.message);
        return { rows: [] };
    }
}

module.exports = { initDb, getDb, query, db: { query: (...args) => query(...args) } };
