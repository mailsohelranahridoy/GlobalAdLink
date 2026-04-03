const { getDb } = require('./db');

/**
 * Log threat to database
 */
async function logThreat(type, severity, publisherId, deviceId, ip, details = {}) {
    try {
        const db = getDb();
        await db.query(
            `INSERT INTO threat_feed (threat_type, severity, publisher_id, device_id, ip_address, details)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [type, severity, publisherId, deviceId, ip, JSON.stringify(details)]
        );
        console.log(`[THREAT] ${type}:`, { severity, publisherId, deviceId, ip });
    } catch (err) {
        console.error('Failed to log threat:', err);
    }
}

/**
 * Log admin action
 */
async function logAdminAction(adminId, action, targetUserId, oldData, newData, ip) {
    try {
        const db = getDb();
        await db.query(
            `INSERT INTO admin_audit_log (admin_id, action, target_user_id, old_data, new_data, admin_ip)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [adminId, action, targetUserId, JSON.stringify(oldData), JSON.stringify(newData), ip]
        );
    } catch (err) {
        console.error('Failed to log admin action:', err);
    }
}

module.exports = { logThreat, logAdminAction };
