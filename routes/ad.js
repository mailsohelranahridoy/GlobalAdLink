const express = require('express');
const { db } = require('../utils/db');
const { getRedis } = require('../utils/redisClient');
const { detectVPNProxy } = require('../middleware/vpnDetect');
const { validateRecaptcha } = require('../middleware/recaptcha');
const { logThreat } = require('../utils/logger');
const crypto = require('crypto');
const router = express.Router();

/**
 * Get geo data from Cloudflare headers
 */
function getGeoData(req) {
    return {
        country: req.headers['cf-ipcountry'] || req.headers['cf-country'] || 'XX',
        city: req.headers['cf-ipcity'] || req.headers['cf-city'] || '',
        isp: req.headers['cf-isp'] || req.headers['cf-asn'] || '',
        continent: req.headers['cf-ipcontinent'] || '',
        latitude: req.headers['cf-iplatitude'],
        longitude: req.headers['cf-iplongitude']
    };
}

/**
 * Validate device fingerprint
 */
function validateFingerprint(deviceId, fingerprintHash) {
    if (!fingerprintHash) return true; // Skip if no hash provided
    const expectedHash = crypto
        .createHmac('sha256', process.env.FINGERPRINT_SECRET_SALT)
        .update(deviceId)
        .digest('hex');
    return fingerprintHash === expectedHash;
}

/**
 * Get personalized ad based on 80/20 rule
 */
async function getPersonalizedAd(deviceId, adUnitId, geo, userAgent) {
    const redis = getRedis();
    
    // 1. Check retargeting campaigns (highest priority)
    const retargeting = await db.query(`
        SELECT rc.*, ac.bid_amount as original_bid
        FROM retargeting_campaigns rc
        LEFT JOIN ad_campaigns ac ON rc.original_campaign_id = ac.id
        WHERE rc.target_device_id = $1 
          AND rc.status = 'active'
          AND (rc.end_time IS NULL OR rc.end_time > NOW())
        ORDER BY rc.bid_amount DESC
        LIMIT 1
    `, [deviceId]);
    
    if (retargeting.rows.length > 0) {
        const camp = retargeting.rows[0];
        return {
            type: 'retargeting',
            campaign: camp,
            ad_id: camp.id,
            creative_url: camp.ad_creative_url,
            destination_url: camp.destination_url,
            action_button: {
                type: camp.action_button_type || 'visit',
                data: camp.action_button_data || {}
            }
        };
    }
    
    // 2. Get active campaigns with targeting
    const campaigns = await db.query(`
        SELECT ac.*, w.balance_usdt as advertiser_balance
        FROM ad_campaigns ac
        JOIN wallets w ON w.user_id = ac.advertiser_id
        WHERE ac.status = 'active'
          AND ac.daily_budget > 0
          AND w.balance_usdt >= ac.bid_amount
        ORDER BY ac.bid_amount DESC
    `);
    
    if (campaigns.rows.length === 0) {
        return null;
    }
    
    // 3. Get user preferences for this ad unit
    const preferences = await db.query(`
        SELECT ad_campaign_id, click_count
        FROM user_ad_preferences
        WHERE device_id = $1 AND ad_unit_id = $2
    `, [deviceId, adUnitId]);
    
    const prefMap = new Map();
    preferences.rows.forEach(p => prefMap.set(p.ad_campaign_id, p.click_count));
    
    // 4. Filter campaigns by targeting
    const eligible = campaigns.rows.filter(campaign => {
        const targeting = campaign.targeting || {};
        
        // Country targeting
        if (targeting.countries && targeting.countries.length > 0) {
            if (!targeting.countries.includes(geo.country)) return false;
        }
        
        // City targeting
        if (targeting.cities && targeting.cities.length > 0 && geo.city) {
            if (!targeting.cities.includes(geo.city)) return false;
        }
        
        // OS targeting (from user agent)
        if (targeting.os && targeting.os.length > 0) {
            const os = userAgent.toLowerCase();
            const matches = targeting.os.some(o => os.includes(o.toLowerCase()));
            if (!matches) return false;
        }
        
        return true;
    });
    
    if (eligible.length === 0) return null;
    
    // 5. Calculate scores based on click history
    const scored = eligible.map(camp => ({
        ...camp,
        user_clicks: prefMap.get(camp.id) || 0,
        score: (prefMap.get(camp.id) || 0) * 10
    }));
    
    scored.sort((a, b) => b.score - a.score);
    const favorite = scored[0];
    
    // 6. 80/20 rule: 80% chance to show favorite, 20% chance to show another
    let selected = favorite;
    if (scored.length > 1 && Math.random() < 0.2) {
        const others = scored.filter(c => c.id !== favorite.id);
        const randomIndex = Math.floor(Math.random() * others.length);
        selected = others[randomIndex];
    }
    
    // 7. Frequency capping (don't show same ad twice in 1 hour)
    const freqKey = `freq:${deviceId}:${selected.id}`;
    const lastShown = await redis.get(freqKey);
    if (lastShown) {
        // Try another ad
        const others = scored.filter(c => c.id !== selected.id);
        if (others.length > 0) {
            selected = others[0];
        } else {
            return null;
        }
    }
    
    // Set frequency cap
    await redis.setex(freqKey, 3600, Date.now());
    
    return {
        type: 'standard',
        campaign: selected,
        ad_id: selected.id,
        creative_url: selected.creative_url,
        destination_url: selected.destination_url,
        action_button: {
            type: selected.action_button_type || 'visit',
            data: selected.action_button_data || {}
        }
    };
}

/**
 * Ad request endpoint
 */
router.post('/request', detectVPNProxy, validateRecaptcha, async (req, res) => {
    try {
        const { ad_unit_id, device_id, fingerprint_hash, recaptcha_token } = req.body;
        const geo = getGeoData(req);
        const ip = req.headers['cf-connecting-ip'] || req.ip;
        const userAgent = req.headers['user-agent'] || '';
        
        // Validation
        if (!ad_unit_id || !device_id) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        // Validate fingerprint
        if (!validateFingerprint(device_id, fingerprint_hash)) {
            await logThreat('invalid_fingerprint', 4, null, device_id, ip, { reason: 'Hash mismatch' });
            return res.status(403).json({ error: 'Invalid fingerprint' });
        }
        
        // Check if ad unit exists and is active
        const adUnit = await db.query(
            'SELECT id, publisher_id FROM ad_units WHERE id = $1 AND status = $2',
            [ad_unit_id, 'active']
        );
        if (!adUnit.rows.length) {
            return res.status(404).json({ error: 'Ad unit not found' });
        }
        
        // Get personalized ad
        const adData = await getPersonalizedAd(device_id, ad_unit_id, geo, userAgent);
        if (!adData) {
            return res.status(204).send(); // No ad available
        }
        
        // Log impression (optional)
        const impressionKey = `imp:${adData.ad_id}:${ad_unit_id}:${device_id}`;
        const redis = getRedis();
        await redis.incr(impressionKey);
        await redis.expire(impressionKey, 86400);
        
        // Return ad response
        res.json({
            success: true,
            ad_id: adData.ad_id,
            ad_type: adData.type,
            creative_url: adData.creative_url,
            destination_url: adData.destination_url,
            action_button: adData.action_button,
            click_url: `/api/ad/click`,
            impression_url: `/api/ad/impression/${adData.ad_id}/${ad_unit_id}`
        });
        
    } catch (err) {
        console.error('Ad request error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Click tracking endpoint
 */
router.post('/click', detectVPNProxy, async (req, res) => {
    try {
        const { ad_id, ad_unit_id, device_id, fingerprint_hash, time_to_click_ms, is_retargeting } = req.body;
        const geo = getGeoData(req);
        const ip = req.headers['cf-connecting-ip'] || req.ip;
        const userAgent = req.headers['user-agent'] || '';
        
        // Validation
        if (!ad_id || !device_id || time_to_click_ms === undefined) {
            return res.status(400).json({ error: 'Missing click data' });
        }
        
        // Behavioral analysis: click too fast (<1 second)
        if (time_to_click_ms < 1000) {
            await logThreat('fast_click', 4, null, device_id, ip, { time_to_click_ms });
            return res.status(403).json({ error: 'Suspicious click pattern' });
        }
        
        // Rate limiting per device per ad
        const redis = getRedis();
        const rateKey = `rate:${device_id}:${ad_id}`;
        const clickCount = await redis.incr(rateKey);
        if (clickCount === 1) await redis.expire(rateKey, 86400);
        if (clickCount > 10) {
            await logThreat('rate_limit_exceeded', 3, null, device_id, ip, { clickCount });
            return res.status(429).json({ error: 'Click limit exceeded' });
        }
        
        // Get campaign and publisher
        let campaign, publisherId;
        
        if (is_retargeting) {
            const ret = await db.query('SELECT * FROM retargeting_campaigns WHERE id = $1', [ad_id]);
            if (!ret.rows.length) {
                return res.status(404).json({ error: 'Campaign not found' });
            }
            campaign = ret.rows[0];
            
            const unit = await db.query('SELECT publisher_id FROM ad_units WHERE id = $1', [ad_unit_id]);
            if (!unit.rows.length) {
                return res.status(404).json({ error: 'Ad unit not found' });
            }
            publisherId = unit.rows[0].publisher_id;
        } else {
            const camp = await db.query('SELECT * FROM ad_campaigns WHERE id = $1', [ad_id]);
            if (!camp.rows.length) {
                return res.status(404).json({ error: 'Campaign not found' });
            }
            campaign = camp.rows[0];
            
            const unit = await db.query('SELECT publisher_id FROM ad_units WHERE id = $1', [ad_unit_id]);
            if (!unit.rows.length) {
                return res.status(404).json({ error: 'Ad unit not found' });
            }
            publisherId = unit.rows[0].publisher_id;
        }
        
        // Check CTR guard for publisher
        const ctrCheck = await db.query(`
            WITH stats AS (
                SELECT 
                    COUNT(*) FILTER (WHERE click_timestamp > NOW() - INTERVAL '1 hour') as clicks_1h,
                    COUNT(*) FILTER (WHERE click_timestamp > NOW() - INTERVAL '1 hour' AND is_fraud = FALSE) as valid_clicks_1h,
                    (SELECT COUNT(*) FROM clicks_log WHERE publisher_id = $1 AND click_timestamp > NOW() - INTERVAL '1 hour') as impressions_1h
            )
            SELECT * FROM stats
        `, [publisherId]);
        
        const impressions1h = parseInt(ctrCheck.rows[0]?.impressions_1h) || 1;
        const clicks1h = parseInt(ctrCheck.rows[0]?.clicks_1h) || 0;
        const ctr = (clicks1h / impressions1h) * 100;
        
        if (ctr > 10) {
            await logThreat('high_ctr', 5, publisherId, device_id, ip, { ctr, impressions1h, clicks1h });
            return res.status(403).json({ error: 'Publisher CTR threshold exceeded' });
        }
        
        // Check if this is the first click for this device on this campaign
        const existingClick = await db.query(
            'SELECT COUNT(*) FROM clicks_log WHERE device_id = $1 AND ad_campaign_id = $2',
            [device_id, campaign.id]
        );
        const isFirst = parseInt(existingClick.rows[0].count) === 0;
        
        // Calculate revenue: 70% of bid for first click, negligible for repeats
        const bidAmount = parseFloat(campaign.bid_amount);
        let revenue = 0;
        if (isFirst) {
            revenue = bidAmount * 0.70;
        } else {
            revenue = 0.0001; // Negligible to prevent fraud
        }
        
        // Process transaction with atomic locks
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            
            // Lock and deduct from advertiser wallet
            const advWallet = await client.query(
                'SELECT balance_usdt, version FROM wallets WHERE user_id = $1 FOR UPDATE',
                [campaign.advertiser_id]
            );
            if (advWallet.rows[0].balance_usdt < bidAmount) {
                throw new Error('Insufficient advertiser balance');
            }
            
            await client.query(
                'UPDATE wallets SET balance_usdt = balance_usdt - $1, version = version + 1 WHERE user_id = $2',
                [bidAmount, campaign.advertiser_id]
            );
            
            // Log advertiser spend
            await client.query(
                `INSERT INTO transaction_logs (user_id, change_type, old_balance, new_balance, amount_usdt, reason)
                 VALUES ($1, 'ad_spend', $2, $3, $4, $5)`,
                [campaign.advertiser_id, advWallet.rows[0].balance_usdt, advWallet.rows[0].balance_usdt - bidAmount, bidAmount, `Click on campaign ${campaign.id}`]
            );
            
            // Lock and credit publisher wallet
            const pubWallet = await client.query(
                'SELECT balance_usdt, version FROM wallets WHERE user_id = $1 FOR UPDATE',
                [publisherId]
            );
            
            await client.query(
                'UPDATE wallets SET balance_usdt = balance_usdt + $1, version = version + 1 WHERE user_id = $2',
                [revenue, publisherId]
            );
            
            // Log publisher earnings
            await client.query(
                `INSERT INTO transaction_logs (user_id, change_type, old_balance, new_balance, amount_usdt, reason)
                 VALUES ($1, 'earnings', $2, $3, $4, $5)`,
                [publisherId, pubWallet.rows[0].balance_usdt, pubWallet.rows[0].balance_usdt + revenue, revenue, `Click from campaign ${campaign.id}`]
            );
            
            // Log click
            await client.query(
                `INSERT INTO clicks_log (ad_campaign_id, ad_unit_id, publisher_id, device_id, fingerprint_hash, 
                 ip_address, user_agent, country, city, isp, time_to_click_ms, recaptcha_score, revenue_usdt)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
                [campaign.id, ad_unit_id, publisherId, device_id, fingerprint_hash, ip, userAgent,
                 geo.country, geo.city, geo.isp, time_to_click_ms, req.recaptcha_score || 0, revenue]
            );
            
            // Update user preferences
            await client.query(
                `INSERT INTO user_ad_preferences (device_id, ad_unit_id, ad_campaign_id, click_count, last_click)
                 VALUES ($1, $2, $3, 1, NOW())
                 ON CONFLICT (device_id, ad_unit_id, ad_campaign_id) 
                 DO UPDATE SET click_count = user_ad_preferences.click_count + 1, last_click = NOW()`,
                [device_id, ad_unit_id, campaign.id]
            );
            
            await client.query('COMMIT');
            res.json({ success: true, revenue });
            
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
        
    } catch (err) {
        console.error('Click tracking error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * Impression tracking endpoint
 */
router.get('/impression/:ad_id/:ad_unit_id', async (req, res) => {
    const { ad_id, ad_unit_id } = req.params;
    const device_id = req.query.device_id || req.headers['x-device-id'];
    
    if (device_id) {
        const redis = getRedis();
        const impKey = `imp:${ad_id}:${ad_unit_id}:${device_id}`;
        await redis.incr(impKey);
        await redis.expire(impKey, 86400);
    }
    
    // Return transparent 1x1 pixel
    res.setHeader('Content-Type', 'image/gif');
    res.send(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

module.exports = router;
