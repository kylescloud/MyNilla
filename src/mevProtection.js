const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const axios = require('axios');
const config = require('../config/config.json');
const RPCManager = require('./rpcManager');
const { Logger } = require('./utils');

class MEVProtection {
    constructor() {
        this.sandwichCache = new NodeCache({ stdTTL: 10, checkperiod: 1 });
        this.frontrunCache = new NodeCache({ stdTTL: 30 });
        this.pendingTransactions = new Map();
        this.knownBots = new Set();
        this.initialized = false;
        
        this.initializeKnownBots();
    }

    async initialize() {
        if (this.initialized) return;
        
        Logger.logInfo('Initializing MEV Protection...');
        await this.loadMEVBlacklist();
        this.startMempoolMonitoring();
        this.initialized = true;
        
        Logger.logSuccess('MEV Protection initialized');
    }

    async loadMEVBlacklist() {
        try {
            const response = await axios.get(
                'https://raw.githubusercontent.com/mevcheb/mev-blacklist/main/blacklist.json',
                { timeout: 10000 }
            );
            
            response.data.addresses.forEach(address => {
                this.knownBots.add(address.toLowerCase());
            });
            
            Logger.logInfo(`Loaded ${this.knownBots.size} known MEV bots`);
        } catch (error) {
            Logger.logWarning('Failed to load MEV blacklist', error.message);
        }
    }

    initializeKnownBots() {
        const commonMEVBots = [
            '0x0000000000000000000000000000000000000000',
            '0x6d6da847d3c1f2b6b2b7a6e8f6a9c8e7c6b5a4f3',
            '0x0000000000000000000000000000000000000001'
        ];
        
        commonMEVBots.forEach(bot => {
            this.knownBots.add(bot.toLowerCase());
        });
    }

    startMempoolMonitoring() {
        setInterval(async () => {
            try {
                await this.monitorMempool();
            } catch (error) {
                Logger.logWarning('Mempool monitoring failed', error.message);
            }
        }, 1000);
        
        setInterval(async () => {
            try {
                await this.cleanupOldTransactions();
            } catch (error) {
                Logger.logWarning('Transaction cleanup failed', error.message);
            }
        }, 60000);
    }

    async monitorMempool() {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            provider.on('pending', async (txHash) => {
                try {
                    const tx = await provider.getTransaction(txHash);
                    if (tx) {
                        await this.analyzeTransaction(tx);
                    }
                } catch (error) {
                    // Silently ignore errors for pending transactions
                }
            });
        } catch (error) {
            throw error;
        }
    }

    async analyzeTransaction(tx) {
        if (!tx.to || !tx.data || tx.data === '0x') return;
        
        const txKey = `${tx.hash}_${tx.nonce}`;
        
        if (this.pendingTransactions.has(txKey)) return;
        
        this.pendingTransactions.set(txKey, {
            hash: tx.hash,
            from: tx.from.toLowerCase(),
            to: tx.to.toLowerCase(),
            data: tx.data,
            value: tx.value,
            gasPrice: tx.gasPrice,
            timestamp: Date.now()
        });
        
        const isMEV = await this.detectMEVPattern(tx);
        
        if (isMEV.detected) {
            Logger.logWarning('MEV transaction detected', {
                hash: tx.hash.substring(0, 10),
                from: tx.from.substring(0, 10),
                type: isMEV.type,
                confidence: isMEV.confidence
            });
            
            this.frontrunCache.set(tx.hash, isMEV);
        }
        
        if (this.knownBots.has(tx.from.toLowerCase())) {
            Logger.logWarning('Known MEV bot transaction', {
                hash: tx.hash.substring(0, 10),
                bot: tx.from.substring(0, 10)
            });
        }
    }

    async detectMEVPattern(tx) {
        const checks = [
            this.checkSandwichPattern(tx),
            this.checkFrontrunPattern(tx),
            this.checkBackrunPattern(tx),
            this.checkArbitragePattern(tx),
            this.checkLiquidityPattern(tx)
        ];
        
        const results = await Promise.allSettled(checks);
        
        let highestConfidence = 0;
        let detectedType = 'none';
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value.detected) {
                if (result.value.confidence > highestConfidence) {
                    highestConfidence = result.value.confidence;
                    detectedType = result.value.type;
                }
            }
        });
        
        return {
            detected: highestConfidence > 0.5,
            type: detectedType,
            confidence: highestConfidence,
            timestamp: Date.now()
        };
    }

    async checkSandwichPattern(tx) {
        try {
            if (!tx.data || tx.data === '0x') {
                return { detected: false, type: 'sandwich', confidence: 0 };
            }
            
            const { provider } = await RPCManager.getHealthyProvider();
            
            const uniswapRouter = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24';
            const aerodromeRouter = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
            
            const knownRouters = [uniswapRouter, aerodromeRouter];
            
            if (!knownRouters.includes(tx.to.toLowerCase())) {
                return { detected: false, type: 'sandwich', confidence: 0 };
            }
            
            const functionSignature = tx.data.substring(0, 10);
            
            const swapFunctions = [
                '0x7ff36ab5', // swapExactETHForTokens
                '0x18cbafe5', // swapExactTokensForETH
                '0x38ed1739', // swapExactTokensForTokens
                '0x5c11d795', // swapExactTokensForTokensSupportingFeeOnTransferTokens
                '0x8803dbee', // swapTokensForExactTokens
                '0x4a25d94a', // swapETHForExactTokens
                '0xf28c0498'  // swapExactETHForTokensSupportingFeeOnTransferTokens
            ];
            
            if (!swapFunctions.includes(functionSignature)) {
                return { detected: false, type: 'sandwich', confidence: 0 };
            }
            
            const txValue = Number(ethers.formatUnits(tx.value, 'ether'));
            
            if (txValue > 10) {
                return { detected: true, type: 'sandwich', confidence: 0.7 };
            }
            
            const recentTxs = await this.getRecentTransactions(tx.to, 10);
            
            const similarTxs = recentTxs.filter(recentTx => 
                recentTx.from !== tx.from &&
                recentTx.data.substring(0, 10) === functionSignature &&
                Math.abs(Number(ethers.formatUnits(recentTx.value, 'ether')) - txValue) < txValue * 0.1
            );
            
            if (similarTxs.length >= 2) {
                return { detected: true, type: 'sandwich', confidence: 0.8 };
            }
            
            return { detected: false, type: 'sandwich', confidence: 0.3 };
        } catch (error) {
            return { detected: false, type: 'sandwich', confidence: 0 };
        }
    }

    async checkFrontrunPattern(tx) {
        try {
            if (!tx.data || tx.data === '0x') {
                return { detected: false, type: 'frontrun', confidence: 0 };
            }
            
            const currentBlock = await this.getCurrentBlockNumber();
            
            const recentTxs = await this.getRecentTransactions(null, 20);
            
            let similarTxCount = 0;
            
            for (const recentTx of recentTxs) {
                if (recentTx.hash === tx.hash) continue;
                
                if (recentTx.to === tx.to &&
                    recentTx.data.substring(0, 10) === tx.data.substring(0, 10) &&
                    recentTx.gasPrice > tx.gasPrice * 110n / 100n) {
                    similarTxCount++;
                }
            }
            
            if (similarTxCount >= 2) {
                return { detected: true, type: 'frontrun', confidence: 0.75 };
            }
            
            const isHighGas = Number(ethers.formatUnits(tx.gasPrice, 'gwei')) > 100;
            
            if (isHighGas && tx.data.length > 500) {
                return { detected: true, type: 'frontrun', confidence: 0.6 };
            }
            
            return { detected: false, type: 'frontrun', confidence: 0.2 };
        } catch (error) {
            return { detected: false, type: 'frontrun', confidence: 0 };
        }
    }

    async checkBackrunPattern(tx) {
        try {
            const recentBlocks = await this.getRecentBlocks(5);
            
            let arbLikeTxCount = 0;
            
            for (const block of recentBlocks) {
                if (block && block.transactions) {
                    for (const blockTx of block.transactions) {
                        if (await this.isArbitrageLike(blockTx)) {
                            arbLikeTxCount++;
                        }
                    }
                }
            }
            
            const isArbLike = await this.isArbitrageLike(tx);
            
            if (isArbLike && arbLikeTxCount > 3) {
                return { detected: true, type: 'backrun', confidence: 0.7 };
            }
            
            return { detected: false, type: 'backrun', confidence: 0.1 };
        } catch (error) {
            return { detected: false, type: 'backrun', confidence: 0 };
        }
    }

    async checkArbitragePattern(tx) {
        try {
            if (!tx.data || tx.data === '0x') {
                return { detected: false, type: 'arbitrage', confidence: 0 };
            }
            
            const functionSignature = tx.data.substring(0, 10);
            
            const flashLoanFunctions = [
                '0x5cffe9de', // flashLoan
                '0xac9674a0', // flashLoanSimple
                '0x316d3c7c'  // executeOperation
            ];
            
            if (flashLoanFunctions.includes(functionSignature)) {
                return { detected: true, type: 'arbitrage', confidence: 0.9 };
            }
            
            const aggregatorCalls = this.extractAggregatorCalls(tx.data);
            
            if (aggregatorCalls.length >= 2) {
                return { detected: true, type: 'arbitrage', confidence: 0.8 };
            }
            
            const tokenTransfers = this.extractTokenTransfers(tx.data);
            
            if (tokenTransfers.length >= 3) {
                return { detected: true, type: 'arbitrage', confidence: 0.6 };
            }
            
            return { detected: false, type: 'arbitrage', confidence: 0.2 };
        } catch (error) {
            return { detected: false, type: 'arbitrage', confidence: 0 };
        }
    }

    async checkLiquidityPattern(tx) {
        try {
            if (!tx.data || tx.data === '0x') {
                return { detected: false, type: 'liquidity', confidence: 0 };
            }
            
            const functionSignature = tx.data.substring(0, 10);
            
            const liquidityFunctions = [
                '0xe8e33700', // addLiquidity
                '0xf305d719', // addLiquidityETH
                '0xbaa2abde', // removeLiquidity
                '0x02751cec', // removeLiquidityETH
                '0xaf2979eb', // addLiquidityETHSupportingFeeOnTransferTokens
                '0xded9382a'  // removeLiquidityETHSupportingFeeOnTransferTokens
            ];
            
            if (liquidityFunctions.includes(functionSignature)) {
                const txValue = Number(ethers.formatUnits(tx.value, 'ether'));
                
                if (txValue > 5) {
                    return { detected: true, type: 'liquidity_mev', confidence: 0.7 };
                }
            }
            
            return { detected: false, type: 'liquidity', confidence: 0.1 };
        } catch (error) {
            return { detected: false, type: 'liquidity', confidence: 0 };
        }
    }

    extractAggregatorCalls(data) {
        const aggregatorAddresses = [
            '0x1111111254EEB25477B68fb85Ed929f73A960582', // 1inch
            '0xCf5540fFFCdC3d510B18bFcA6d56b9d8C1E6d8b7', // Odos
            '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'  // CoW
        ];
        
        const calls = [];
        
        aggregatorAddresses.forEach(address => {
            if (data.toLowerCase().includes(address.toLowerCase().substring(2))) {
                calls.push(address);
            }
        });
        
        return calls;
    }

    extractTokenTransfers(data) {
        const transferSignature = '0xa9059cbb';
        const transfers = [];
        
        let position = 0;
        
        while (position < data.length) {
            const signature = data.substring(position, position + 10);
            
            if (signature === transferSignature) {
                transfers.push({
                    position,
                    signature
                });
            }
            
            position += 2;
        }
        
        return transfers;
    }

    async isArbitrageLike(tx) {
        if (!tx.data || tx.data === '0x') return false;
        
        const aggregatorCalls = this.extractAggregatorCalls(tx.data);
        
        if (aggregatorCalls.length >= 2) return true;
        
        const transferCount = this.extractTokenTransfers(tx.data).length;
        
        if (transferCount >= 3) return true;
        
        const functionSignature = tx.data.substring(0, 10);
        const flashLoanSigs = [
            '0x5cffe9de', '0xac9674a0', '0x316d3c7c'
        ];
        
        if (flashLoanSigs.includes(functionSignature)) return true;
        
        return false;
    }

    async getRecentTransactions(toAddress = null, limit = 20) {
        const cacheKey = `recent_txs_${toAddress}_${limit}`;
        const cached = this.sandwichCache.get(cacheKey);
        if (cached) return cached;
        
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const currentBlock = await provider.getBlockNumber();
            
            const transactions = [];
            
            for (let i = 0; i < limit; i++) {
                const txKey = Array.from(this.pendingTransactions.keys())[i];
                if (txKey) {
                    const tx = this.pendingTransactions.get(txKey);
                    if (!toAddress || tx.to === toAddress.toLowerCase()) {
                        transactions.push(tx);
                    }
                }
            }
            
            this.sandwichCache.set(cacheKey, transactions, 5);
            return transactions;
        } catch (error) {
            return [];
        }
    }

    async getCurrentBlockNumber() {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            return await provider.getBlockNumber();
        } catch (error) {
            return 0;
        }
    }

    async getRecentBlocks(count) {
        const blocks = [];
        
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const currentBlock = await provider.getBlockNumber();
            
            for (let i = 0; i < count; i++) {
                try {
                    const block = await provider.getBlock(currentBlock - i);
                    if (block) {
                        blocks.push(block);
                    }
                } catch (error) {
                    continue;
                }
            }
        } catch (error) {
            // Silently fail
        }
        
        return blocks;
    }

    async cleanupOldTransactions() {
        const now = Date.now();
        const oneMinuteAgo = now - 60000;
        
        for (const [key, tx] of this.pendingTransactions.entries()) {
            if (tx.timestamp < oneMinuteAgo) {
                this.pendingTransactions.delete(key);
            }
        }
    }

    async checkOpportunity(opportunity) {
        if (!this.initialized) await this.initialize();
        
        const checks = [
            this.checkMempoolCompetition(opportunity),
            this.checkGasPriceSafety(opportunity),
            this.checkSandwichVulnerability(opportunity),
            this.checkTimingSafety(opportunity)
        ];
        
        const results = await Promise.allSettled(checks);
        
        let isSafe = true;
        let reasons = [];
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && !result.value.safe) {
                isSafe = false;
                reasons.push(result.value.reason);
            }
        });
        
        if (reasons.length > 0) {
            Logger.logWarning('MEV Protection blocked opportunity', {
                reasons,
                path: opportunity.path.map(p => p.fromToken.substring(0, 10))
            });
        }
        
        return {
            safe: isSafe,
            reasons: isSafe ? [] : reasons,
            timestamp: Date.now()
        };
    }

    async checkMempoolCompetition(opportunity) {
        try {
            const recentArbTxs = await this.getRecentArbitrageTransactions();
            
            if (recentArbTxs.length > 3) {
                return {
                    safe: false,
                    reason: `High arbitrage competition: ${recentArbTxs.length} recent arb txs`
                };
            }
            
            const similarPaths = recentArbTxs.filter(tx => 
                this.isSimilarPath(tx, opportunity.path)
            );
            
            if (similarPaths.length > 0) {
                return {
                    safe: false,
                    reason: 'Similar path recently executed'
                };
            }
            
            return { safe: true, reason: '' };
        } catch (error) {
            return { safe: true, reason: '' };
        }
    }

    async getRecentArbitrageTransactions() {
        const recentTxs = await this.getRecentTransactions(null, 50);
        
        const arbTxs = [];
        
        for (const tx of recentTxs) {
            if (await this.isArbitrageLike(tx)) {
                arbTxs.push(tx);
            }
        }
        
        return arbTxs;
    }

    isSimilarPath(tx, path) {
        if (!tx.data || tx.data === '0x') return false;
        
        const pathTokens = path.map(hop => hop.fromToken.substring(2, 12).toLowerCase());
        
        for (const token of pathTokens) {
            if (tx.data.toLowerCase().includes(token)) {
                return true;
            }
        }
        
        return false;
    }

    async checkGasPriceSafety(opportunity) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const feeData = await provider.getFeeData();
            
            const currentGasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
            const gasPriceGwei = Number(ethers.formatUnits(currentGasPrice, 'gwei'));
            
            const maxGasPrice = config.maxGasPriceGwei || 50;
            
            if (gasPriceGwei > maxGasPrice) {
                return {
                    safe: false,
                    reason: `Gas price ${gasPriceGwei.toFixed(2)} > max ${maxGasPrice} Gwei`
                };
            }
            
            const pendingTxs = await this.getRecentTransactions(null, 20);
            const highGasTxs = pendingTxs.filter(tx => 
                tx.gasPrice > currentGasPrice * 120n / 100n
            );
            
            if (highGasTxs.length > 5) {
                return {
                    safe: false,
                    reason: 'High gas price competition in mempool'
                };
            }
            
            return { safe: true, reason: '' };
        } catch (error) {
            return { safe: true, reason: '' };
        }
    }

    async checkSandwichVulnerability(opportunity) {
        try {
            const firstHop = opportunity.path[0];
            
            if (!firstHop.dex || firstHop.dex === 'Unknown') {
                return { safe: true, reason: '' };
            }
            
            const recentSwaps = await this.getRecentTransactions(firstHop.to, 10);
            
            const similarSwaps = recentSwaps.filter(tx => 
                tx.data.substring(0, 10) === this.getSwapFunctionSignature(firstHop.dex)
            );
            
            if (similarSwaps.length >= 2) {
                const gasPrices = similarSwaps.map(tx => Number(ethers.formatUnits(tx.gasPrice, 'gwei')));
                const avgGasPrice = gasPrices.reduce((a, b) => a + b, 0) / gasPrices.length;
                
                if (avgGasPrice > 100) {
                    return {
                        safe: false,
                        reason: 'Potential sandwich attack detected on first hop'
                    };
                }
            }
            
            return { safe: true, reason: '' };
        } catch (error) {
            return { safe: true, reason: '' };
        }
    }

    getSwapFunctionSignature(dex) {
        const signatures = {
            'Aerodrome': '0x7ff36ab5',
            'PancakeSwap': '0x7ff36ab5',
            'Uniswap V3': '0x414bf389',
            'Baseswap': '0x7ff36ab5'
        };
        
        return signatures[dex] || '0x';
    }

    async checkTimingSafety(opportunity) {
        const now = Date.now();
        const recentOpportunities = this.getRecentSimilarOpportunities(opportunity);
        
        if (recentOpportunities.length > 2) {
            const timeSinceLast = now - recentOpportunities[0].timestamp;
            
            if (timeSinceLast < 30000) {
                return {
                    safe: false,
                    reason: 'Similar opportunity executed too recently'
                };
            }
        }
        
        const blockTime = await this.getAverageBlockTime();
        
        if (blockTime < 1.5) {
            return {
                safe: false,
                reason: 'Fast block time increases MEV risk'
            };
        }
        
        return { safe: true, reason: '' };
    }

    getRecentSimilarOpportunities(opportunity) {
        const cacheKey = 'recent_opportunities';
        const cached = this.frontrunCache.get(cacheKey) || [];
        
        const similar = cached.filter(opp => 
            Math.abs(opp.profitPercent - opportunity.profitPercent) < 0.1 &&
            opp.path.length === opportunity.path.length
        );
        
        return similar.slice(0, 5);
    }

    async getAverageBlockTime() {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const currentBlock = await provider.getBlockNumber();
            const block = await provider.getBlock(currentBlock);
            const previousBlock = await provider.getBlock(currentBlock - 1);
            
            if (block && previousBlock) {
                return block.timestamp - previousBlock.timestamp;
            }
            
            return 2.0;
        } catch (error) {
            return 2.0;
        }
    }

    async getProtectionStats() {
        return {
            knownBots: this.knownBots.size,
            pendingTransactions: this.pendingTransactions.size,
            recentMEVDetections: Array.from(this.frontrunCache.keys()).length,
            initialized: this.initialized
        };
    }
}

module.exports = MEVProtection;
