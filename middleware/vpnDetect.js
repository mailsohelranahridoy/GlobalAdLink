const axios = require('axios');
const { logThreat } = require('../utils/logger');

exports.detectVPNProxy = async (req, res, next) => {
    const ip = req.headers['cf-connecting-ip'] || req.ip;
    try {
        // Simple check: IP quality score via free service (example)
        const geo = await axios.get(`http://ip-api.com/json/${ip}?fields=status,proxy,isp`);
        if (geo.data.proxy === true || geo.data.isp?.toLowerCase().includes('vpn')) {
            await logThreat('vpn_proxy', 3, null, req.body.device_id, ip, { isp: geo.data.isp });
            return res.status(403).json({ error: 'VPN/Proxy not allowed' });
        }
        next();
    } catch (err) {
        next();
    }
};
