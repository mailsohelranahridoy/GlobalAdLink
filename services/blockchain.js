const { WALLETS, BLOCKCHAIN_CONFIG } = require('../config/wallets');

/**
 * Verify a blockchain transaction
 * @param {string} blockchain - 'trc20', 'erc20', 'bep20', 'sol'
 * @param {string} txHash - Transaction hash
 * @param {number} expectedAmount - Expected USDT amount
 * @returns {Promise<{isValid: boolean, platformAddress: string}>}
 */
async function verifyTransaction(blockchain, txHash, expectedAmount) {
    const config = BLOCKCHAIN_CONFIG[blockchain];
    if (!config) {
        throw new Error(`Unsupported blockchain: ${blockchain}. Supported: trc20, erc20, bep20, sol`);
    }
    
    const platformAddress = WALLETS[blockchain];
    if (!platformAddress) {
        throw new Error(`Platform wallet not configured for ${blockchain}`);
    }
    
    const isValid = await config.verify(txHash, expectedAmount, platformAddress);
    return { isValid, platformAddress };
}

module.exports = { verifyTransaction };
