const axios = require('axios');

/**
 * Validate Google reCAPTCHA v3 token
 */
async function validateRecaptchaToken(token, remoteIp = null) {
    if (!token) {
        return { success: false, score: 0, error: 'reCAPTCHA token missing' };
    }
    
    try {
        const params = new URLSearchParams();
        params.append('secret', process.env.RECAPTCHA_SECRET);
        params.append('response', token);
        if (remoteIp) {
            params.append('remoteip', remoteIp);
        }
        
        const response = await axios.post(
            'https://www.google.com/recaptcha/api/siteverify',
            params,
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        
        const data = response.data;
        
        if (!data.success) {
            return { success: false, score: 0, error: 'reCAPTCHA verification failed' };
        }
        
        // Score threshold: 0.5 (adjustable)
        const isValid = data.score >= 0.5;
        
        return {
            success: isValid,
            score: data.score,
            action: data.action,
            error: isValid ? null : 'Score too low'
        };
    } catch (err) {
        console.error('reCAPTCHA error:', err.message);
        return { success: false, score: 0, error: 'Verification service error' };
    }
}

/**
 * Express middleware for reCAPTCHA validation
 */
function validateRecaptcha(req, res, next) {
    const token = req.headers['x-recaptcha-token'] || req.body.recaptcha_token;
    const ip = req.headers['cf-connecting-ip'] || req.ip;
    
    if (!token) {
        return res.status(400).json({ error: 'reCAPTCHA token required' });
    }
    
    validateRecaptchaToken(token, ip).then(result => {
        if (!result.success) {
            return res.status(403).json({ error: `reCAPTCHA validation failed: ${result.error}` });
        }
        req.recaptcha_score = result.score;
        next();
    }).catch(err => {
        console.error('reCAPTCHA middleware error:', err);
        res.status(500).json({ error: 'Internal server error' });
    });
}

module.exports = { validateRecaptcha, validateRecaptchaToken };
