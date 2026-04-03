const { getDb } = require('../utils/db');

async function monthlyPayoutGenerator() {
    const db = getDb();
    const now = new Date();
    const minPayout = parseFloat(process.env.MIN_PAYOUT_USDT || 10);
    const payoutDay = parseInt(process.env.PAYOUT_DAY || 5);
    
    // Expected clear date: next month, day = payoutDay
    const expectedDate = new Date(now.getFullYear(), now.getMonth() + 1, payoutDay);
    
    // Find publishers with sufficient balance
    const publishers = await db.query(`
        SELECT u.id, u.wallet_address, w.balance_usdt
        FROM users u
        JOIN wallets w ON u.id = w.user_id
        WHERE u.role = 'publisher' 
          AND w.balance_usdt >= $1
          AND u.wallet_address IS NOT NULL
          AND u.wallet_address != ''
    `, [minPayout]);
    
    let generated = 0;
    for (const pub of publishers.rows) {
        // Check if there's already a pending withdrawal for this user
        const existing = await db.query(`
            SELECT id FROM withdrawal_requests
            WHERE user_id = $1 AND status = 'pending'
        `, [pub.id]);
        
        if (existing.rows.length === 0) {
            await db.query(`
                INSERT INTO withdrawal_requests (user_id, amount_usdt, wallet_address, expected_clear_date, status)
                VALUES ($1, $2, $3, $4, 'pending')
            `, [pub.id, pub.balance_usdt, pub.wallet_address, expectedDate]);
            generated++;
        }
    }
    
    console.log(`Generated ${generated} payout requests for ${publishers.rows.length} eligible publishers`);
    return { generated, total: publishers.rows.length };
}

module.exports = { monthlyPayoutGenerator };
