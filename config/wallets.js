require('dotenv').config();

const WALLETS = {
    bep20: process.env.PLATFORM_WALLET_BEP20,
    sol: process.env.PLATFORM_WALLET_SOL,
    erc20: process.env.PLATFORM_WALLET_ERC20,
    trc20: process.env.PLATFORM_WALLET_TRC20,
    optimism: process.env.PLATFORM_WALLET_OPTIMISM,
    arbitrum: process.env.PLATFORM_WALLET_ARBITRUM,
};

const BLOCKCHAIN_CONFIG = {
    trc20: {
        name: 'TRC20',
        verify: async (txHash, expectedAmount, toAddress) => {
            const axios = require('axios');
            const apiKey = process.env.TRONGRID_API_KEY;
            const url = `https://api.trongrid.io/v1/transactions/${txHash}?apikey=${apiKey}`;
            try {
                const response = await axios.get(url);
                const tx = response.data;
                if (!tx || tx.ret?.[0]?.contractRet !== 'SUCCESS') return false;
                const amount = tx.raw_data.contract[0].parameter.value.amount / 1e6;
                const to = tx.raw_data.contract[0].parameter.value.to_address;
                return (Math.abs(amount - expectedAmount) < 0.000001 && to === toAddress);
            } catch (err) {
                console.error('TRC20 verification error:', err.message);
                return false;
            }
        }
    },
    erc20: {
        name: 'ERC20',
        verify: async (txHash, expectedAmount, toAddress) => {
            const axios = require('axios');
            const apiKey = process.env.ETHERSCAN_API_KEY;
            const url = `https://api.etherscan.io/api?module=transaction&action=gettxreceiptstatus&txhash=${txHash}&apikey=${apiKey}`;
            try {
                const response = await axios.get(url);
                return response.data.status === '1';
            } catch (err) {
                console.error('ERC20 verification error:', err.message);
                return false;
            }
        }
    },
    bep20: {
        name: 'BEP20',
        verify: async (txHash, expectedAmount, toAddress) => {
            const axios = require('axios');
            const apiKey = process.env.BSCSCAN_API_KEY;
            const url = `https://api.bscscan.com/api?module=transaction&action=gettxreceiptstatus&txhash=${txHash}&apikey=${apiKey}`;
            try {
                const response = await axios.get(url);
                return response.data.status === '1';
            } catch (err) {
                console.error('BEP20 verification error:', err.message);
                return false;
            }
        }
    },
    sol: {
        name: 'Solana',
        verify: async (txHash, expectedAmount, toAddress) => {
            const axios = require('axios');
            const url = `${process.env.SOLANA_RPC_URL}`;
            try {
                const response = await axios.post(url, {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getTransaction',
                    params: [txHash, { encoding: 'json', maxSupportedTransactionVersion: 0 }]
                });
                const tx = response.data.result;
                if (!tx || tx.meta?.err) return false;
                return true;
            } catch (err) {
                console.error('Solana verification error:', err.message);
                return false;
            }
        }
    }
};

module.exports = { WALLETS, BLOCKCHAIN_CONFIG };
