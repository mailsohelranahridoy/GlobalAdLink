const express = require('express');
const { db } = require('../utils/db');
const router = express.Router();

/**
 * Get user transaction history
 */
router.get('/transactions', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        
        const transactions = await db.query(`
            SELECT * FROM transaction_logs
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
        `, [req.user.id, limit, offset]);
        
        const count = await db.query(
            'SELECT COUNT(*) FROM transaction_logs WHERE user_id = $1',
            [req.user.id]
        );
        
        res.json({
            transactions: transactions.rows,
            total: parseInt(count.rows[0].count),
            limit,
            offset
        });
    } catch (err) {
        console.error('Transactions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Get user balance
 */
router.get('/balance', async (req, res) => {
    try {
        const wallet = await db.query(
            'SELECT balance_usdt FROM wallets WHERE user_id = $1',
            [req.user.id]
        );
        
        res.json({ balance: parseFloat(wallet.rows[0]?.balance_usdt || 0) });
    } catch (err) {
        console.error('Balance error:', err);
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
        console.error('Withdrawals error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
