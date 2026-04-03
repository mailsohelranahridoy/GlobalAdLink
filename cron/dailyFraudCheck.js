const { getDb } = require('../utils/db');
const { getRedis } = require('../utils/redisClient');
const { logThreat } = require('../utils/logger');

async function dailyFraudCheck() {
    const db = getDb();
    const redis = getRedis();
    const client = await db.connect();
    
    try {
        await client.query('BEGIN');
        
        // 1. Check for high CTR (Click Through Rate > 10% in last 24 hours)
        const highCTR = await client.query(`
            WITH daily_stats AS (
                SELECT 
                    publisher_id,
                    COUNT(*) as total_clicks,
                    COUNT(*) FILTER (WHERE click_timestamp > NOW() - INTERVAL '24 hours') as clicks_24h,
                    (SELECT COUNT(*) FROM clicks_log WHERE publisher_id = cl.publisher_id AND click_timestamp > NOW() - INTERVAL '24 hours') as impressions_24h
                FROM clicks_log cl
                WHERE click_timestamp > NOW() - INTERVAL '24 hours'
                GROUP BY publisher_id
                HAVING (COUNT(*)::float / NULLIF((SELECT COUNT(*) FROM clicks_log WHERE publisher_id = cl.publisher_id AND click_timestamp > NOW() - INTERVAL '24 hours'), 0)) > 0.10
            )
            SELECT * FROM daily_stats
        `);
        
        for (const row of highCTR.rows) {
            await client.query(`
                UPDATE clicks_log SET is_fraud = TRUE, fraud_reason = 'ctr_exceeded_10%'
                WHERE publisher_id = $1 AND click_timestamp > NOW() - INTERVAL '24 hours' AND is_fraud = FALSE
            `, [row.publisher_id]);
            
            await logThreat('high_ctr', 5, row.publisher_id, null, null, { ctr: (row.clicks_24h / row.impressions_24h) * 100 });
        }
        
        // 2. Check for devices with too many clicks (> 10 per day)
        const highDeviceClicks = await client.query(`
            SELECT device_id, COUNT(*) as click_count
            FROM clicks_log
            WHERE click_timestamp > NOW() - INTERVAL '24 hours' AND is_fraud = FALSE
            GROUP BY device_id
            HAVING COUNT(*) > 10
        `);
        
        for (const dev of highDeviceClicks.rows) {
            await client.query(`
                UPDATE clicks_log SET is_fraud = TRUE, fraud_reason = 'rate_limit_exceeded'
                WHERE device_id = $1 AND click_timestamp > NOW() - INTERVAL '24 hours' AND is_fraud = FALSE
            `, [dev.device_id]);
            
            await logThreat('rate_limit_exceeded', 3, null, dev.device_id, null, { click_count: dev.click_count });
        }
        
        // 3. Adjust publisher balances for fraud clicks
        const fraudRevenue = await client.query(`
            SELECT publisher_id, COALESCE(SUM(revenue_usdt), 0) as fraud_revenue
            FROM clicks_log
            WHERE is_fraud = TRUE AND click_timestamp > NOW() - INTERVAL '24 hours'
            GROUP BY publisher_id
        `);
        
        for (const rev of fraudRevenue.rows) {
            if (rev.fraud_revenue > 0) {
                await client.query(`
                    UPDATE wallets SET balance_usdt = balance_usdt - $1
                    WHERE user_id = $2 AND balance_usdt >= $1
                `, [rev.fraud_revenue, rev.publisher_id]);
            }
        }
        
        await client.query('COMMIT');
        console.log(`Fraud check completed: ${highCTR.length} high CTR publishers, ${highDeviceClicks.length} high-click devices`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Fraud check error:', err);
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { dailyFraudCheck };
