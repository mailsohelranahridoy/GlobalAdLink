const Redis = require('ioredis');

let redis = null;
let isConnected = false;

async function initRedis() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        throw new Error('REDIS_URL environment variable is not set');
    }
    
    // Configure TLS for Upstash (rediss:// protocol)
    const options = {};
    if (redisUrl.startsWith('rediss://')) {
        options.tls = {
            rejectUnauthorized: false  // Required for Upstash free tier
        };
    }
    
    redis = new Redis(redisUrl, options);
    
    redis.on('connect', () => {
        console.log('✅ Redis connected successfully');
        isConnected = true;
    });
    
    redis.on('error', (err) => {
        console.error('❌ Redis connection error:', err.message);
        isConnected = false;
    });
    
    // Wait for connection
    await new Promise((resolve, reject) => {
        redis.once('ready', resolve);
        redis.once('error', reject);
        setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
    });
    
    return redis;
}

function getRedis() {
    if (!redis) {
        throw new Error('Redis not initialized. Call initRedis() first.');
    }
    return redis;
}

module.exports = { initRedis, getRedis };
