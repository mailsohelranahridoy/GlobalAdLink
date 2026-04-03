const express = require('express');
const { db } = require('../utils/db');
const { WALLETS } = require('../config/wallets');
const router = express.Router();

/**
 * Get deposit wallet address
 */
router.get('/wallet', (req, res) => {
    const blockchain = (req.query.blockchain || 'trc20').toLowerCase();
    const address = WALLETS[blockchain];
    
    if (!address) {
        return res.status(400).json({ 
            error: 'Unsupported blockchain', 
            supported: Object.keys(WALLETS) 
        });
    }
    
    res.json({ blockchain, address });
});

/**
 * Get advertiser wallet balance and transactions
 */
router.get('/wallet/balance', async (req, res) => {
    try {
        const wallet = await db.query(
            'SELECT balance_usdt FROM wallets WHERE user_id = $1',
            [req.user.id]
        );
        
        const transactions = await db.query(`
            SELECT * FROM transaction_logs 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 50
        `, [req.user.id]);
        
        res.json({
            balance: parseFloat(wallet.rows[0]?.balance_usdt || 0),
            transactions: transactions.rows
        });
    } catch (err) {
        console.error('Wallet balance error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Create campaign
 */
router.post('/campaigns', async (req, res) => {
    try {
        const {
            name, creative_url, destination_url, ad_type, action_button_type,
            action_button_data, targeting, bid_type, bid_amount, daily_budget, total_budget
        } = req.body;
        
        if (!name || !creative_url || !destination_url || !ad_type || !bid_type || !bid_amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const result = await db.query(
            `INSERT INTO ad_campaigns (
                advertiser_id, name, creative_url, destination_url, ad_type,
                action_button_type, action_button_data, targeting, bid_type, bid_amount,
                daily_budget, total_budget
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id`,
            [req.user.id, name, creative_url, destination_url, ad_type, action_button_type,
             action_button_data, targeting, bid_type, bid_amount, daily_budget, total_budget]
        );
        
        res.status(201).json({ id: result.rows[0].id, message: 'Campaign created successfully' });
    } catch (err) {
        console.error('Create campaign error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get all campaigns
 */
router.get('/campaigns', async (req, res) => {
    try {
        const campaigns = await db.query(`
            SELECT ac.*, 
                   (SELECT COUNT(*) FROM clicks_log WHERE ad_campaign_id = ac.id) as clicks,
                   (SELECT COUNT(*) FROM clicks_log WHERE ad_campaign_id = ac.id AND is_fraud = FALSE) as valid_clicks,
                   (SELECT COALESCE(SUM(revenue_usdt), 0) FROM clicks_log WHERE ad_campaign_id = ac.id) as spent
            FROM ad_campaigns ac
            WHERE ac.advertiser_id = $1
            ORDER BY ac.created_at DESC
        `, [req.user.id]);
        
        res.json(campaigns.rows);
    } catch (err) {
        console.error('Get campaigns error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get single campaign
 */
router.get('/campaigns/:id', async (req, res) => {
    try {
        const campaign = await db.query(
            'SELECT * FROM ad_campaigns WHERE id = $1 AND advertiser_id = $2',
            [req.params.id, req.user.id]
        );
        
        if (!campaign.rows.length) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        res.json(campaign.rows[0]);
    } catch (err) {
        console.error('Get campaign error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Update campaign
 */
router.put('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        
        // Remove fields that shouldn't be updated
        delete updates.id;
        delete updates.advertiser_id;
        delete updates.created_at;
        
        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }
        
        const setClause = Object.keys(updates)
            .map((key, i) => `${key} = $${i + 3}`)
            .join(', ');
        
        const values = [id, req.user.id, ...Object.values(updates)];
        
        await db.query(
            `UPDATE ad_campaigns SET ${setClause} WHERE id = $1 AND advertiser_id = $2`,
            values
        );
        
        res.json({ success: true, message: 'Campaign updated' });
    } catch (err) {
        console.error('Update campaign error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Delete campaign
 */
router.delete('/campaigns/:id', async (req, res) => {
    try {
        await db.query(
            'DELETE FROM ad_campaigns WHERE id = $1 AND advertiser_id = $2',
            [req.params.id, req.user.id]
        );
        res.json({ success: true, message: 'Campaign deleted' });
    } catch (err) {
        console.error('Delete campaign error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Pause/resume campaign
 */
router.patch('/campaigns/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        if (!['active', 'paused'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        await db.query(
            'UPDATE ad_campaigns SET status = $1 WHERE id = $2 AND advertiser_id = $3',
            [status, id, req.user.id]
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error('Campaign status error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get campaign stats
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await db.query(`
            SELECT 
                COUNT(DISTINCT ac.id) as total_campaigns,
                COALESCE(SUM(cl.revenue_usdt), 0) as total_spend,
                COUNT(cl.id) as total_clicks,
                COUNT(DISTINCT cl.device_id) as unique_clicks,
                AVG(CASE WHEN cl.is_fraud = FALSE THEN cl.time_to_click_ms END) as avg_click_time
            FROM ad_campaigns ac
            LEFT JOIN clicks_log cl ON cl.ad_campaign_id = ac.id
            WHERE ac.advertiser_id = $1
        `, [req.user.id]);
        
        // Daily stats for chart
        const dailyStats = await db.query(`
            SELECT DATE(cl.click_timestamp) as date, 
                   COUNT(cl.id) as clicks,
                   COALESCE(SUM(cl.revenue_usdt), 0) as spend
            FROM ad_campaigns ac
            LEFT JOIN clicks_log cl ON cl.ad_campaign_id = ac.id
            WHERE ac.advertiser_id = $1 AND cl.click_timestamp > NOW() - INTERVAL '30 days'
            GROUP BY DATE(cl.click_timestamp)
            ORDER BY date DESC
        `, [req.user.id]);
        
        res.json({
            ...stats.rows[0],
            daily_stats: dailyStats.rows
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Create retargeting campaign
 */
router.post('/retargeting', async (req, res) => {
    try {
        const {
            original_campaign_id,
            target_device_ids,
            ad_creative_url,
            destination_url,
            action_button_type,
            action_button_data,
            bid_amount,
            end_time
        } = req.body;
        
        if (!target_device_ids || !Array.isArray(target_device_ids) || target_device_ids.length === 0) {
            return res.status(400).json({ error: 'At least one device ID required' });
        }
        
        if (!ad_creative_url || !bid_amount) {
            return res.status(400).json({ error: 'Creative URL and bid amount required' });
        }
        
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            const inserted = [];
            for (const device_id of target_device_ids) {
                const result = await client.query(
                    `INSERT INTO retargeting_campaigns (
                        advertiser_id, original_campaign_id, target_device_id, 
                        ad_creative_url, destination_url, action_button_type, 
                        action_button_data, bid_amount, end_time
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING id`,
                    [req.user.id, original_campaign_id, device_id, ad_creative_url,
                     destination_url, action_button_type, action_button_data, bid_amount, end_time || null]
                );
                inserted.push({ device_id, id: result.rows[0].id });
            }
            
            await client.query('COMMIT');
            res.status(201).json({ success: true, inserted: inserted.length, campaigns: inserted });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Create retargeting error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get retargeting campaigns
 */
router.get('/retargeting', async (req, res) => {
    try {
        const campaigns = await db.query(`
            SELECT rc.*, ac.name as original_campaign_name
            FROM retargeting_campaigns rc
            LEFT JOIN ad_campaigns ac ON rc.original_campaign_id = ac.id
            WHERE rc.advertiser_id = $1
            ORDER BY rc.created_at DESC
        `, [req.user.id]);
        
        res.json(campaigns.rows);
    } catch (err) {
        console.error('Get retargeting error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Delete retargeting campaign
 */
router.delete('/retargeting/:id', async (req, res) => {
    try {
        await db.query(
            'DELETE FROM retargeting_campaigns WHERE id = $1 AND advertiser_id = $2',
            [req.params.id, req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Delete retargeting error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
