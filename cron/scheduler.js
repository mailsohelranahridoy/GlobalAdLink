const cron = require('node-cron');
const { dailyFraudCheck } = require('./dailyFraudCheck');
const { monthlyPayoutGenerator } = require('./monthlyPayout');

function scheduleCronJobs() {
    // Daily fraud check at 2 AM
    cron.schedule('0 2 * * *', async () => {
        console.log('Running daily fraud check...');
        try {
            await dailyFraudCheck();
            console.log('Daily fraud check completed');
        } catch (err) {
            console.error('Daily fraud check failed:', err);
        }
    });
    
    // Monthly payout generation on 1st at 00:00
    cron.schedule('0 0 1 * *', async () => {
        console.log('Generating monthly payouts...');
        try {
            await monthlyPayoutGenerator();
            console.log('Monthly payouts generated');
        } catch (err) {
            console.error('Monthly payout generation failed:', err);
        }
    });
    
    console.log('✅ Cron jobs scheduled');
}

module.exports = { scheduleCronJobs };
