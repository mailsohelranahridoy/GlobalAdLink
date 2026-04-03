const express = require('express');
const bcrypt = require('bcrypt');
const { db } = require('../utils/db');
const { setAuthCookies, clearAuthCookies, authenticate } = require('../middleware/auth');
const { validateRecaptcha } = require('../middleware/recaptcha');
const router = express.Router();

// Rate limiting for login
const loginAttempts = new Map(); // In production, use Redis

/**
 * Register new user
 */
router.post('/register', validateRecaptcha, async (req, res) => {
    try {
        const { email, password, role, company_name, wallet_address } = req.body;
        
        if (!email || !password || !role) {
            return res.status(400).json({ error: 'Email, password and role are required' });
        }
        
        if (!['admin', 'advertiser', 'publisher'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }
        
        // Check if user exists
        const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length) {
            return res.status(409).json({ error: 'Email already exists' });
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);
        
        // Create user
        const result = await db.query(
            `INSERT INTO users (email, password_hash, role, company_name, wallet_address) 
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [email, hashedPassword, role, company_name || null, wallet_address || null]
        );
        
        const userId = result.rows[0].id;
        
        // Create wallet
        await db.query('INSERT INTO wallets (user_id, balance_usdt) VALUES ($1, 0)', [userId]);
        
        // Set auth cookies
        setAuthCookies(res, userId, role);
        
        res.status(201).json({
            success: true,
            user: { id: userId, email, role }
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Login user
 */
router.post('/login', validateRecaptcha, async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        
        // Rate limiting check (in production, use Redis)
        const ip = req.headers['cf-connecting-ip'] || req.ip;
        const rateKey = `login:${ip}`;
        // ... rate limiting logic here
        
        // Find user
        const user = await db.query(
            'SELECT id, email, password_hash, role FROM users WHERE email = $1',
            [email]
        );
        
        if (!user.rows.length) {
            // Dummy compare to prevent timing attacks
            await bcrypt.compare('dummy', '$2b$10$dummy');
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const valid = await bcrypt.compare(password, user.rows[0].password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        // Set auth cookies
        setAuthCookies(res, user.rows[0].id, user.rows[0].role);
        
        res.json({
            success: true,
            user: {
                id: user.rows[0].id,
                email: user.rows[0].email,
                role: user.rows[0].role
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Logout user
 */
router.post('/logout', (req, res) => {
    clearAuthCookies(res);
    res.json({ success: true, message: 'Logged out successfully' });
});

/**
 * Get current user info
 */
router.get('/me', authenticate(), async (req, res) => {
    try {
        const user = await db.query(
            `SELECT id, email, role, company_name, wallet_address, created_at 
             FROM users WHERE id = $1`,
            [req.user.id]
        );
        
        if (!user.rows.length) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Get wallet balance
        const wallet = await db.query(
            'SELECT balance_usdt FROM wallets WHERE user_id = $1',
            [req.user.id]
        );
        
        res.json({
            ...user.rows[0],
            balance_usdt: wallet.rows[0]?.balance_usdt || 0
        });
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Refresh token endpoint
 */
router.post('/refresh', async (req, res) => {
    const { refreshAccessToken } = require('../middleware/auth');
    const user = await refreshAccessToken(req, res);
    
    if (!user) {
        return res.status(401).json({ error: 'Invalid refresh token' });
    }
    
    res.json({ success: true });
});

module.exports = router;
