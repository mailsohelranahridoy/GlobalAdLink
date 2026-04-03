const express = require('express');
const { db } = require('../utils/db');
const { getRedis } = require('../utils/redisClient');
const { logThreat } = require('../utils/logger');
const { verifyTransaction } = require('../services/blockchain');
const router = express.Router();

/**
 * Get dashboard stats
 */
router.get('/stats', async (req, res) => {
    try {
        const [totalPublishers, totalAdvertisers, totalSpend, totalEarnings, pendingWithdrawals] = await Promise.all([
            db.query('SELECT COUNT(*) FROM users WHERE role = $1', ['publisher']),
            db.query('SELECT COUNT(*) FROM users WHERE role = $1', ['advertiser']),
            db.query('SELECT COALESCE(SUM(amount_usdt), 0) FROM transaction_logs WHERE change_type = $1', ['ad_spend']),
            db.query('SELECT COALESCE(SUM(amount_usdt), 0) FROM transaction_logs WHERE change_type = $1', ['earnings']),
            db.query('SELECT COALESCE(SUM(amount_usdt), 0) FROM withdrawal_requests WHERE status = $1', ['pending'])
        ]);
        
        // Daily revenue for last 30 days
        const dailyRevenue = await db.query(`
            SELECT DATE(created_at) as date, COALESCE(SUM(amount_usdt), 0) as total
            FROM transaction_logs
            WHERE change_type = 'earnings' AND created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);
        
        res.json({
            total_publishers: parseInt(totalPublishers.rows[0].count),
            total_advertisers: parseInt(totalAdvertisers.rows[0].count),
            total_spend: parseFloat(totalSpend.rows[0].coalesce),
            total_earnings: parseFloat(totalEarnings.rows[0].coalesce),
            pending_withdrawals: parseFloat(pendingWithdrawals.rows[0].coalesce),
            daily_revenue: dailyRevenue.rows
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * List pending deposits
 */
router.get('/deposits', async (req, res) => {
    // In this system, deposits are verified manually by admin
    // We return an empty array as there's no pending deposit table
    // Deposits are created when admin verifies a transaction
    res.json([]);
});

/**
 * Verify a deposit (admin only)
 */
router.post('/deposits/verify', async (req, res) => {
    const { user_id, tx_hash, blockchain = 'trc20', expected_amount } = req.body;
    const adminIp = req.headers['cf-connecting-ip'] || req.ip;
    
    if (!user_id || !tx_hash || !expected_amount) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    try {
        // 1. Verify transaction on blockchain
        const { isValid, platformAddress } = await verifyTransaction(blockchain, tx_hash, parseFloat(expected_amount));
        
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid transaction or amount mismatch' });
        }
        
        // 2. Check if transaction already processed
        const existing = await db.query('SELECT id FROM transaction_logs WHERE tx_hash = $1', [tx_hash]);
        if (existing.rows.length) {
            return res.status(409).json({ error: 'Transaction already processed' });
        }
        
        // 3. Credit user balance with atomic lock
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            // Lock wallet row
            const wallet = await client.query('SELECT balance_usdt, version FROM wallets WHERE user_id = $1 FOR UPDATE', [user_id]);
            const oldBalance = parseFloat(wallet.rows[0].balance_usdt);
            const newBalance = oldBalance + parseFloat(expected_amount);
            
            await client.query(
                'UPDATE wallets SET balance_usdt = $1, version = version + 1 WHERE user_id = $2',
                [newBalance, user_id]
            );
            
            // Log transaction
            await client.query(
                `INSERT INTO transaction_logs (user_id, tx_hash, change_type, old_balance, new_balance, amount_usdt, reason, admin_ip)
                 VALUES ($1, $2, 'deposit', $3, $4, $5, 'Blockchain verified deposit', $6)`,
                [user_id, tx_hash, oldBalance, newBalance, expected_amount, adminIp]
            );
            
            await client.query('COMMIT');
            
            res.json({ success: true, message: 'Deposit verified and credited' });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Deposit verification error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

/**
 * Get threat feed (real-time threats)
 */
router.get('/threat-feed', async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const type = req.query.type;
    
    let query = `
        SELECT tf.*, u.email as publisher_email, u.company_name as publisher_company
        FROM threat_feed tf
        LEFT JOIN users u ON tf.publisher_id = u.id
    `;
    const params = [];
    
    if (type) {
        query += ` WHERE tf.threat_type = $${params.length + 1}`;
        params.push(type);
    }
    
    query += ` ORDER BY tf.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await db.query(query, params);
    res.json(result.rows);
});

/**
 * Get pending withdrawals
 */
router.get('/withdrawals', async (req, res) => {
    const result = await db.query(`
        SELECT wr.*, u.email, u.company_name, u.wallet_address
        FROM withdrawal_requests wr
        JOIN users u ON wr.user_id = u.id
        WHERE wr.status = 'pending'
        ORDER BY wr.requested_at ASC
    `);
    res.json(result.rows);
});

/**
 * Approve withdrawal
 */
router.post('/withdrawals/:id/approve', async (req, res) => {
    const { id } = req.params;
    const { tx_hash } = req.body;
    const adminIp = req.headers['cf-connecting-ip'] || req.ip;
    
    if (!tx_hash) {
        return res.status(400).json({ error: 'Transaction hash required' });
    }
    
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        
        // Lock and get withdrawal request
        const withdrawal = await client.query(
            'SELECT * FROM withdrawal_requests WHERE id = $1 FOR UPDATE',
            [id]
        );
        
        if (!withdrawal.rows.length || withdrawal.rows[0].status !== 'pending') {
            throw new Error('Invalid withdrawal request');
        }
        
        const request = withdrawal.rows[0];
        
        // Lock wallet and deduct balance
        const wallet = await client.query(
            'SELECT balance_usdt, version FROM wallets WHERE user_id = $1 FOR UPDATE',
            [request.user_id]
        );
        
        const oldBalance = parseFloat(wallet.rows[0].balance_usdt);
        const amount = parseFloat(request.amount_usdt);
        
        if (oldBalance < amount) {
            throw new Error('Insufficient balance');
        }
        
        const newBalance = oldBalance - amount;
        
        await client.query(
            'UPDATE wallets SET balance_usdt = $1, version = version + 1 WHERE user_id = $2',
            [newBalance, request.user_id]
        );
        
        // Log withdrawal
        await client.query(
            `INSERT INTO transaction_logs (user_id, tx_hash, change_type, old_balance, new_balance, amount_usdt, reason, admin_ip)
             VALUES ($1, $2, 'withdraw', $3, $4, $5, 'Withdrawal approved', $6)`,
            [request.user_id, tx_hash, oldBalance, newBalance, amount, adminIp]
        );
        
        // Update withdrawal request
        await client.query(
            `UPDATE withdrawal_requests 
             SET status = 'processed', processed_by = $1, tx_hash = $2, processed_at = NOW()
             WHERE id = $3`,
            [req.user.id, tx_hash, id]
        );
        
        await client.query('COMMIT');
        res.json({ success: true, message: 'Withdrawal approved' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Withdrawal approval error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * Reject withdrawal
 */
router.post('/withdrawals/:id/reject', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    
    const result = await db.query(
        `UPDATE withdrawal_requests 
         SET status = 'rejected', processed_by = $1, processed_at = NOW(), reason = $2
         WHERE id = $3 RETURNING *`,
        [req.user.id, reason || 'Rejected by admin', id]
    );
    
    if (!result.rows.length) {
        return res.status(404).json({ error: 'Withdrawal request not found' });
    }
    
    res.json({ success: true });
});

/**
 * Get all publishers
 */
router.get('/publishers', async (req, res) => {
    const result = await db.query(`
        SELECT u.id, u.email, u.company_name, u.wallet_address, u.created_at,
               w.balance_usdt,
               (SELECT COUNT(*) FROM ad_units WHERE publisher_id = u.id) as ad_units_count,
               (SELECT COUNT(*) FROM clicks_log WHERE publisher_id = u.id) as total_clicks
        FROM users u
        JOIN wallets w ON u.id = w.user_id
        WHERE u.role = 'publisher'
        ORDER BY u.created_at DESC
    `);
    res.json(result.rows);
});

/**
 * Suspend/activate publisher
 */
router.put('/publishers/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['active', 'suspended'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    
    await db.query('UPDATE users SET status = $1 WHERE id = $2 AND role = $3', [status, id, 'publisher']);
    res.json({ success: true });
});

/**
 * Get audit trail (immutable transaction logs)
 */
router.get('/audit', async (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.query.user_id;
    
    let query = `
        SELECT tl.*, u.email, u.role
        FROM transaction_logs tl
        JOIN users u ON tl.user_id = u.id
    `;
    const params = [];
    
    if (userId) {
        query += ` WHERE tl.user_id = $${params.length + 1}`;
        params.push(userId);
    }
    
    query += ` ORDER BY tl.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await db.query(query, params);
    res.json(result.rows);
});

/**
 * Broadcast message to all users (admin only)
 */
router.post('/broadcast', async (req, res) => {
    const { message, user_role } = req.body;
    
    if (!message) {
        return res.status(400).json({ error: 'Message required' });
    }
    
    // This would integrate with a notification service
    // For now, just log it
    console.log('Broadcast message:', { message, user_role, admin: req.user.id });
    
    res.json({ success: true, message: 'Broadcast sent' });
});

/**
 * Get platform settings
 */
router.get('/settings', async (req, res) => {
    const settings = {
        min_payout: process.env.MIN_PAYOUT_USDT || 10,
        payout_day: process.env.PAYOUT_DAY || 5,
        payout_window_end: process.env.PAYOUT_WINDOW_END || 10,
        rate_limit_max: process.env.RATE_LIMIT_MAX || 100,
        maintenance_mode: process.env.MAINTENANCE_MODE === 'true'
    };
    res.json(settings);
});

/**
 * Update platform settings
 */
router.put('/settings', async (req, res) => {
    const { min_payout, payout_day, maintenance_mode } = req.body;
    
    // In production, these would be stored in a settings table
    // For now, just return success
    res.json({ success: true });
});

module.exports = router;
