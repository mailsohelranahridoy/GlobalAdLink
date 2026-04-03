const jwt = require('jsonwebtoken');
const { db } = require('../utils/db');

/**
 * Set httpOnly cookies for authentication
 */
function setAuthCookies(res, userId, role) {
    const accessToken = jwt.sign(
        { userId, role }, 
        process.env.JWT_SECRET, 
        { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '15m' }
    );
    
    const refreshToken = jwt.sign(
        { userId }, 
        process.env.JWT_REFRESH_SECRET, 
        { expiresIn: process.env.REFRESH_TOKEN_EXPIRY || '7d' }
    );
    
    // Access token cookie (15 minutes)
    res.cookie('access_token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 15 * 60 * 1000  // 15 minutes
    });
    
    // Refresh token cookie (7 days)
    res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
    });
    
    return { accessToken, refreshToken };
}

/**
 * Clear auth cookies (logout)
 */
function clearAuthCookies(res) {
    res.clearCookie('access_token');
    res.clearCookie('refresh_token');
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(req, res) {
    const refreshToken = req.cookies.refresh_token;
    if (!refreshToken) {
        return null;
    }
    
    try {
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const user = await db.query('SELECT id, role FROM users WHERE id = $1', [decoded.userId]);
        if (!user.rows.length) return null;
        
        const newAccessToken = jwt.sign(
            { userId: user.rows[0].id, role: user.rows[0].role },
            process.env.JWT_SECRET,
            { expiresIn: process.env.ACCESS_TOKEN_EXPIRY || '15m' }
        );
        
        res.cookie('access_token', newAccessToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 15 * 60 * 1000
        });
        
        return user.rows[0];
    } catch (err) {
        return null;
    }
}

/**
 * Authentication middleware
 */
function authenticate(allowedRoles = []) {
    return async (req, res, next) => {
        let token = req.cookies.access_token;
        
        // Try to refresh if token is missing or expired
        if (!token) {
            const user = await refreshAccessToken(req, res);
            if (user) {
                req.user = user;
                return next();
            }
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await db.query('SELECT id, role FROM users WHERE id = $1', [decoded.userId]);
            
            if (!user.rows.length) {
                return res.status(401).json({ error: 'User not found' });
            }
            
            req.user = user.rows[0];
            
            // Role-based access control
            if (allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
                return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
            }
            
            next();
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                const user = await refreshAccessToken(req, res);
                if (user) {
                    req.user = user;
                    return next();
                }
            }
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
    };
}

module.exports = { authenticate, setAuthCookies, clearAuthCookies, refreshAccessToken };
