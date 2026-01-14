const { ethers } = require('ethers');
const { EIP712Domain, signTypedData } = require('@ethersproject/wallet');
const config = require('../config/config.json');

class TransactionBuilder {
    constructor() {
        this.wallet = null;
        this.nonce = null;
        this.gasEstimationCache = new Map();
        this.pendingTxs = new Map();
        this.init();
    }

    async init() {
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
        await this.updateNonce();
    }

    async buildArbitrageTransaction(opportunity) {
        const txData = {
            to: process.env.ARB_CONTRACT_ADDRESS,
            value: 0,
            data: this.encodeArbitrageCall(opportunity),
            chainId: config.chainId,
            nonce: await this.getNonce(),
            gasLimit: await this.estimateGas(opportunity),
            maxFeePerGas: await this.getOptimalMaxFee(),
            maxPriorityFeePerGas: await this.getOptimalPriorityFee(),
            type: 2
        };

        const signedTx = await this.wallet.signTransaction(txData);
        const txHash = ethers.keccak256(signedTx);

        this.pendingTxs.set(txHash, {
            txData,
            signedTx,
            opportunity,
            timestamp: Date.now()
        });

        return { txHash, signedTx, txData };
    }

    async buildFlashLoanTransaction(flashLoanParams) {
        const aavePoolABI = [
            'function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external'
        ];

        const iface = new ethers.Interface(aavePoolABI);
        
        const txData = {
            to: flashLoanParams.poolAddress,
            value: 0,
            data: iface.encodeFunctionData('flashLoanSimple', [
                flashLoanParams.receiver,
                flashLoanParams.asset,
                flashLoanParams.amount,
                flashLoanParams.params,
                0
            ]),
            chainId: config.chainId,
            nonce: await this.getNonce(),
            gasLimit: 500000n,
            maxFeePerGas: await this.getOptimalMaxFee(),
            maxPriorityFeePerGas: await this.getOptimalPriorityFee(),
            type: 2
        };

        const signedTx = await this.wallet.signTransaction(txData);
        const txHash = ethers.keccak256(signedTx);

        return { txHash, signedTx, txData };
    }

    async estimateGas(opportunity) {
        const cacheKey = JSON.stringify(opportunity.path.map(h => ({
            from: h.fromToken,
            to: h.toToken,
            amount: h.amount
        })));

        if (this.gasEstimationCache.has(cacheKey)) {
            return this.gasEstimationCache.get(cacheKey);
        }

        const baseGas = 21000n;
        let totalGas = baseGas;

        opportunity.path.forEach((hop, index) => {
            const hopGas = this.estimateHopGas(hop, index);
            totalGas += hopGas;
        });

        const flashLoanGas = 250000n;
        const safetyBuffer = 150n;

        totalGas = (totalGas + flashLoanGas) * safetyBuffer / 100n;

        this.gasEstimationCache.set(cacheKey, totalGas);
        return totalGas;
    }

    estimateHopGas(hop, index) {
        const dexGasMap = {
            'Aerodrome': 120000n,
            'PancakeSwap': 110000n,
            'Uniswap V3': 130000n,
            'Baseswap': 115000n,
            'odos': 180000n,
            'oneInch': 170000n,
            'cow': 160000n
        };

        const baseGas = dexGasMap[hop.dex] || 150000n;

        if (index === 0) {
            return baseGas + 50000n;
        }

        return baseGas;
    }

    async getOptimalMaxFee() {
        const { provider } = await require('./rpcManager').getHealthyProvider();
        const feeData = await provider.getFeeData();
        
        const baseFee = feeData.gasPrice || 0n;
        const maxPriorityFee = await this.getOptimalPriorityFee();
        
        const maxFee = baseFee + maxPriorityFee;
        const maxAllowed = ethers.parseUnits(config.maxGasPriceGwei.toString(), 'gwei');
        
        return maxFee > maxAllowed ? maxAllowed : maxFee;
    }

    async getOptimalPriorityFee() {
        const { provider } = await require('./rpcManager').getHealthyProvider();
        
        try {
            const feeHistory = await provider.send('eth_feeHistory', [
                '0x4',
                'latest',
                [25, 50, 75]
            ]);

            const priorityFees = feeHistory.reward.flat();
            const sortedFees = priorityFees
                .map(fee => BigInt(fee))
                .sort((a, b) => a - b);

            const medianIndex = Math.floor(sortedFees.length / 2);
            const medianFee = sortedFees[medianIndex];

            const optimalFee = medianFee * 120n / 100n;
            const maxPriority = ethers.parseUnits('2', 'gwei');

            return optimalFee > maxPriority ? maxPriority : optimalFee;
        } catch (error) {
            return ethers.parseUnits('1.5', 'gwei');
        }
    }

    async getNonce() {
        if (this.nonce === null) {
            await this.updateNonce();
        }
        const currentNonce = this.nonce;
        this.nonce += 1n;
        return currentNonce;
    }

    async updateNonce() {
        const { provider } = await require('./rpcManager').getHealthyProvider();
        this.nonce = await provider.getTransactionCount(this.wallet.address, 'pending');
    }

    encodeArbitrageCall(opportunity) {
        const iface = new ethers.Interface([
            'function executeArbitrage(tuple(address[] tokens, uint256[] amounts, address[] aggregators, bytes[] swapData) path, uint256 flashLoanAmount, uint256 minProfit)'
        ]);

        const encodedPath = {
            tokens: opportunity.path.map(hop => hop.fromToken)
                .concat([opportunity.path[opportunity.path.length - 1].toToken]),
            amounts: opportunity.path.map(hop => hop.amount),
            aggregators: opportunity.path.map(hop => this.getAggregatorAddress(hop.dex)),
            swapData: opportunity.path.map(hop => hop.swapData || '0x')
        };

        return iface.encodeFunctionData('executeArbitrage', [
            encodedPath,
            opportunity.amount,
            opportunity.minProfit || 0
        ]);
    }

    getAggregatorAddress(dexName) {
        const aggregators = {
            'Aerodrome': '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
            'PancakeSwap': '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',
            'Uniswap V3': '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
            'Baseswap': '0x327Df1E6de05895d2ab08513aA9319310cE3a516',
            'odos': '0x19cEeAd7105607Cd444F5ad10dd51356436095a1',
            'oneInch': '0x1111111254EEB25577B68fb85Ed929f73A960582',
            'cow': '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
        };

        return aggregators[dexName] || ethers.ZeroAddress;
    }

    async signTypedData(domain, types, value) {
        const signature = await this.wallet.signTypedData(domain, types, value);
        return signature;
    }

    async sendTransaction(signedTx) {
        const { provider } = await require('./rpcManager').getHealthyProvider();
        
        try {
            const txResponse = await provider.broadcastTransaction(signedTx);
            return txResponse;
        } catch (error) {
            throw new Error(`Failed to broadcast transaction: ${error.message}`);
        }
    }

    async cancelTransaction(oldTxHash, newGasPriceMultiplier = 1.2) {
        const oldTx = this.pendingTxs.get(oldTxHash);
        if (!oldTx) {
            throw new Error('Transaction not found');
        }

        const cancelTx = {
            to: this.wallet.address,
            value: 0,
            data: '0x',
            chainId: config.chainId,
            nonce: oldTx.txData.nonce,
            gasLimit: 21000n,
            maxFeePerGas: oldTx.txData.maxFeePerGas * newGasPriceMultiplier,
            maxPriorityFeePerGas: oldTx.txData.maxPriorityFeePerGas * newGasPriceMultiplier,
            type: 2
        };

        const signedCancelTx = await this.wallet.signTransaction(cancelTx);
        await this.sendTransaction(signedCancelTx);

        this.pendingTxs.delete(oldTxHash);
        return signedCancelTx;
    }

    async speedUpTransaction(oldTxHash, newGasPriceMultiplier = 1.5) {
        const oldTx = this.pendingTxs.get(oldTxHash);
        if (!oldTx) {
            throw new Error('Transaction not found');
        }

        const spedUpTx = {
            ...oldTx.txData,
            maxFeePerGas: oldTx.txData.maxFeePerGas * newGasPriceMultiplier,
            maxPriorityFeePerGas: oldTx.txData.maxPriorityFeePerGas * newGasPriceMultiplier
        };

        const signedSpedUpTx = await this.wallet.signTransaction(spedUpTx);
        await this.sendTransaction(signedSpedUpTx);

        this.pendingTxs.set(ethers.keccak256(signedSpedUpTx), {
            ...oldTx,
            txData: spedUpTx,
            signedTx: signedSpedUpTx
        });

        return signedSpedUpTx;
    }

    getPendingTransactions() {
        return Array.from(this.pendingTxs.entries()).map(([hash, tx]) => ({
            hash,
            nonce: tx.txData.nonce,
            gasPrice: tx.txData.maxFeePerGas,
            timestamp: tx.timestamp
        }));
    }

    clearPendingTransaction(txHash) {
        this.pendingTxs.delete(txHash);
    }
}

module.exports = TransactionBuilder;
