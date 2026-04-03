const express = require('express');
const { db } = require('../utils/db');
const router = express.Router();

/**
 * Get publisher wallet balance
 */
router.get('/wallet/balance', async (req, res) => {
    try {
        const wallet = await db.query(
            'SELECT balance_usdt FROM wallets WHERE user_id = $1',
            [req.user.id]
        );
        
        res.json({ balance: parseFloat(wallet.rows[0]?.balance_usdt || 0) });
    } catch (err) {
        console.error('Wallet balance error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Create ad unit
 */
router.post('/ad-units', async (req, res) => {
    try {
        const { unit_name, unit_type, dimensions } = req.body;
        
        if (!unit_name || !unit_type) {
            return res.status(400).json({ error: 'Unit name and type required' });
        }
        
        if (!['js_tag', 'json_api'].includes(unit_type)) {
            return res.status(400).json({ error: 'Invalid unit type' });
        }
        
        const apiKey = require('uuid').v4();
        let jsTagCode = null;
        
        if (unit_type === 'js_tag') {
            jsTagCode = `<script src="https://${process.env.API_DOMAIN || 'api.globaladlink.com'}/js/${apiKey}"></script>`;
        }
        
        const result = await db.query(
            `INSERT INTO ad_units (publisher_id, unit_name, unit_type, dimensions, api_key, js_tag_code)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [req.user.id, unit_name, unit_type, dimensions || null, apiKey, jsTagCode]
        );
        
        res.status(201).json({
            id: result.rows[0].id,
            api_key: apiKey,
            js_tag_code: jsTagCode,
            message: 'Ad unit created successfully'
        });
    } catch (err) {
        console.error('Create ad unit error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get all ad units
 */
router.get('/ad-units', async (req, res) => {
    try {
        const units = await db.query(`
            SELECT au.*, 
                   (SELECT COUNT(*) FROM clicks_log WHERE ad_unit_id = au.id) as total_clicks,
                   (SELECT COALESCE(SUM(revenue_usdt), 0) FROM clicks_log WHERE ad_unit_id = au.id) as total_revenue
            FROM ad_units au
            WHERE au.publisher_id = $1
            ORDER BY au.created_at DESC
        `, [req.user.id]);
        
        res.json(units.rows);
    } catch (err) {
        console.error('Get ad units error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get single ad unit
 */
router.get('/ad-units/:id', async (req, res) => {
    try {
        const unit = await db.query(
            'SELECT * FROM ad_units WHERE id = $1 AND publisher_id = $2',
            [req.params.id, req.user.id]
        );
        
        if (!unit.rows.length) {
            return res.status(404).json({ error: 'Ad unit not found' });
        }
        
        res.json(unit.rows[0]);
    } catch (err) {
        console.error('Get ad unit error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Update ad unit
 */
router.put('/ad-units/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { unit_name, dimensions, status } = req.body;
        
        await db.query(
            `UPDATE ad_units 
             SET unit_name = COALESCE($1, unit_name), 
                 dimensions = COALESCE($2, dimensions),
                 status = COALESCE($3, status)
             WHERE id = $4 AND publisher_id = $5`,
            [unit_name, dimensions, status, id, req.user.id]
        );
        
        res.json({ success: true, message: 'Ad unit updated' });
    } catch (err) {
        console.error('Update ad unit error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Delete ad unit
 */
router.delete('/ad-units/:id', async (req, res) => {
    try {
        await db.query(
            'DELETE FROM ad_units WHERE id = $1 AND publisher_id = $2',
            [req.params.id, req.user.id]
        );
        res.json({ success: true, message: 'Ad unit deleted' });
    } catch (err) {
        console.error('Delete ad unit error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get earnings stats
 */
router.get('/earnings', async (req, res) => {
    try {
        const { from, to, ad_unit_id } = req.query;
        
        let query = `
            SELECT 
                DATE(cl.click_timestamp) as date,
                COUNT(*) as clicks,
                COUNT(*) FILTER (WHERE cl.is_fraud = FALSE) as valid_clicks,
                COALESCE(SUM(cl.revenue_usdt), 0) as revenue
            FROM clicks_log cl
            WHERE cl.publisher_id = $1
        `;
        const params = [req.user.id];
        let paramIndex = 2;
        
        if (from) {
            query += ` AND cl.click_timestamp >= $${paramIndex}`;
            params.push(from);
            paramIndex++;
        }
        if (to) {
            query += ` AND cl.click_timestamp <= $${paramIndex}`;
            params.push(to);
            paramIndex++;
        }
        if (ad_unit_id) {
            query += ` AND cl.ad_unit_id = $${paramIndex}`;
            params.push(ad_unit_id);
            paramIndex++;
        }
        
        query += ` GROUP BY DATE(cl.click_timestamp) ORDER BY date DESC`;
        
        const stats = await db.query(query, params);
        
        // Get total stats
        const totalQuery = `
            SELECT 
                COUNT(*) as total_clicks,
                COUNT(*) FILTER (WHERE is_fraud = FALSE) as valid_clicks,
                COALESCE(SUM(revenue_usdt), 0) as total_revenue,
                AVG(CASE WHEN is_fraud = FALSE THEN time_to_click_ms END) as avg_click_time
            FROM clicks_log
            WHERE publisher_id = $1
        `;
        const total = await db.query(totalQuery, [req.user.id]);
        
        res.json({
            daily_stats: stats.rows,
            total: {
                clicks: parseInt(total.rows[0].total_clicks || 0),
                valid_clicks: parseInt(total.rows[0].valid_clicks || 0),
                revenue: parseFloat(total.rows[0].total_revenue || 0),
                avg_click_time: Math.round(total.rows[0].avg_click_time || 0)
            }
        });
    } catch (err) {
        console.error('Earnings error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get trust score
 */
router.get('/trust-score', async (req, res) => {
    try {
        // Calculate trust score based on fraud ratio
        const result = await db.query(`
            SELECT 
                COUNT(*) as total_clicks,
                COUNT(*) FILTER (WHERE is_fraud = TRUE) as fraud_clicks
            FROM clicks_log
            WHERE publisher_id = $1 AND click_timestamp > NOW() - INTERVAL '30 days'
        `, [req.user.id]);
        
        const total = parseInt(result.rows[0].total_clicks) || 0;
        const fraud = parseInt(result.rows[0].fraud_clicks) || 0;
        
        let score = 100;
        if (total > 0) {
            score = Math.max(0, 100 - (fraud / total) * 100);
        }
        
        // Account age bonus
        const accountAge = await db.query(
            'SELECT EXTRACT(DAY FROM NOW() - created_at) as days FROM users WHERE id = $1',
            [req.user.id]
        );
        const days = parseInt(accountAge.rows[0]?.days || 0);
        if (days > 30) score = Math.min(100, score + 10);
        
        res.json({
            trust_score: Math.round(score),
            total_clicks: total,
            fraud_clicks: fraud
        });
    } catch (err) {
        console.error('Trust score error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Request withdrawal
 */
router.post('/withdraw', async (req, res) => {
    try {
        const { amount } = req.body;
        const userId = req.user.id;
        const minPayout = parseFloat(process.env.MIN_PAYOUT_USDT || 10);
        
        if (!amount || amount < minPayout) {
            return res.status(400).json({ error: `Minimum payout is ${minPayout} USDT` });
        }
        
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            // Lock wallet and check balance
            const wallet = await client.query(
                'SELECT balance_usdt FROM wallets WHERE user_id = $1 FOR UPDATE',
                [userId]
            );
            
            const balance = parseFloat(wallet.rows[0].balance_usdt);
            if (amount > balance) {
                return res.status(400).json({ error: 'Insufficient balance' });
            }
            
            // Deduct balance immediately
            await client.query(
                'UPDATE wallets SET balance_usdt = balance_usdt - $1 WHERE user_id = $2',
                [amount, userId]
            );
            
            // Get wallet address
            const user = await client.query(
                'SELECT wallet_address FROM users WHERE id = $1',
                [userId]
            );
            
            if (!user.rows[0].wallet_address) {
                return res.status(400).json({ error: 'Wallet address not set' });
            }
            
            // Calculate expected clear date (5th-10th of next month)
            const now = new Date();
            const expectedDate = new Date(now.getFullYear(), now.getMonth() + 1, parseInt(process.env.PAYOUT_DAY || 5));
            
            // Create withdrawal request
            const result = await client.query(
                `INSERT INTO withdrawal_requests (user_id, amount_usdt, wallet_address, expected_clear_date)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [userId, amount, user.rows[0].wallet_address, expectedDate]
            );
            
            await client.query('COMMIT');
            
            res.json({
                success: true,
                withdrawal_id: result.rows[0].id,
                amount: amount,
                expected_clear_date: expectedDate,
                message: `Withdrawal request submitted. Expected payout between ${expectedDate.getDate()}-${process.env.PAYOUT_WINDOW_END || 10} of ${expectedDate.toLocaleString('default', { month: 'long' })}`
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Withdrawal request error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get withdrawal history
 */
router.get('/withdrawals', async (req, res) => {
    try {
        const withdrawals = await db.query(`
            SELECT * FROM withdrawal_requests
            WHERE user_id = $1
            ORDER BY requested_at DESC
        `, [req.user.id]);
        
        res.json(withdrawals.rows);
    } catch (err) {
        console.error('Withdrawal history error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get fraud alerts for publisher
 */
router.get('/fraud-alerts', async (req, res) => {
    try {
        const alerts = await db.query(`
            SELECT * FROM threat_feed
            WHERE publisher_id = $1
            ORDER BY created_at DESC
            LIMIT 50
        `, [req.user.id]);
        
        res.json(alerts.rows);
    } catch (err) {
        console.error('Fraud alerts error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get ad performance per ad unit
 */
router.get('/performance', async (req, res) => {
    try {
        const performance = await db.query(`
            SELECT 
                au.id,
                au.unit_name,
                au.unit_type,
                COUNT(cl.id) as clicks,
                COUNT(DISTINCT cl.device_id) as unique_clicks,
                COALESCE(SUM(cl.revenue_usdt), 0) as revenue,
                AVG(CASE WHEN cl.is_fraud = FALSE THEN cl.time_to_click_ms END) as avg_click_time
            FROM ad_units au
            LEFT JOIN clicks_log cl ON cl.ad_unit_id = au.id
            WHERE au.publisher_id = $1
            GROUP BY au.id, au.unit_name, au.unit_type
            ORDER BY revenue DESC
        `, [req.user.id]);
        
        res.json(performance.rows);
    } catch (err) {
        console.error('Performance error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get top performing devices (heatmap)
 */
router.get('/top-devices', async (req, res) => {
    try {
        const devices = await db.query(`
            SELECT 
                cl.device_id,
                COUNT(*) as clicks,
                COALESCE(SUM(cl.revenue_usdt), 0) as revenue,
                COUNT(DISTINCT cl.ad_campaign_id) as unique_ads
            FROM clicks_log cl
            WHERE cl.publisher_id = $1 AND cl.click_timestamp > NOW() - INTERVAL '30 days'
            GROUP BY cl.device_id
            ORDER BY revenue DESC
            LIMIT 20
        `, [req.user.id]);
        
        res.json(devices.rows);
    } catch (err) {
        console.error('Top devices error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
