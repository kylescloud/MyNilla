const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const config = require('../config/config.json');
const RPCManager = require('./rpcManager');
const { Logger } = require('./utils');

class GasOptimizer {
    constructor() {
        this.gasHistory = [];
        this.maxHistorySize = 1000;
        this.cache = new NodeCache({ stdTTL: 30, checkperiod: 10 });
        this.blockGasLimit = 30000000n;
        this.baseFeeTrend = [];
        this.priorityFeeTrend = [];
        
        this.startGasMonitoring();
    }

    async startGasMonitoring() {
        setInterval(async () => {
            try {
                await this.updateGasData();
            } catch (error) {
                Logger.logWarning('Gas monitoring update failed', error.message);
            }
        }, 15000);
    }

    async updateGasData() {
        const { provider } = await RPCManager.getHealthyProvider();
        
        try {
            const [block, feeHistory] = await Promise.all([
                provider.getBlock('latest'),
                provider.send('eth_feeHistory', ['0x5', 'latest', [10, 20, 30, 40, 50, 60, 70, 80, 90]])
            ]);

            if (!block || !feeHistory) return;

            const currentGasData = {
                timestamp: Date.now(),
                blockNumber: block.number,
                baseFeePerGas: BigInt(feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1]),
                gasUsedRatio: feeHistory.gasUsedRatio,
                reward: feeHistory.reward ? feeHistory.reward.map(arr => arr.map(r => BigInt(r))) : null
            };

            this.gasHistory.push(currentGasData);
            
            if (this.gasHistory.length > this.maxHistorySize) {
                this.gasHistory.shift();
            }

            this.updateTrends(currentGasData);
            this.cache.set('current_gas_data', currentGasData, 15);

        } catch (error) {
            throw error;
        }
    }

    updateTrends(gasData) {
        this.baseFeeTrend.push({
            timestamp: gasData.timestamp,
            value: Number(ethers.formatUnits(gasData.baseFeePerGas, 'gwei'))
        });

        if (this.baseFeeTrend.length > 100) {
            this.baseFeeTrend.shift();
        }

        if (gasData.reward && gasData.reward.length > 0) {
            const latestRewards = gasData.reward[gasData.reward.length - 1];
            const avgPriority = latestRewards.reduce((a, b) => a + b, 0n) / BigInt(latestRewards.length);
            
            this.priorityFeeTrend.push({
                timestamp: gasData.timestamp,
                value: Number(ethers.formatUnits(avgPriority, 'gwei'))
            });

            if (this.priorityFeeTrend.length > 100) {
                this.priorityFeeTrend.shift();
            }
        }
    }

    async getOptimalGasParameters(txComplexity = 'medium', urgency = 'normal') {
        const cacheKey = `gas_params_${txComplexity}_${urgency}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const { provider } = await RPCManager.getHealthyProvider();
        
        try {
            const [feeData, feeHistory] = await Promise.all([
                provider.getFeeData(),
                provider.send('eth_feeHistory', ['0x4', 'latest', [25, 50, 75]])
            ]);

            const baseFee = feeData.gasPrice || 0n;
            
            let maxPriorityFeePerGas;
            if (feeHistory && feeHistory.reward && feeHistory.reward.length > 0) {
                const recentRewards = feeHistory.reward.flat().map(r => BigInt(r));
                const sortedRewards = recentRewards.sort((a, b) => a - b);
                
                const percentileIndex = Math.floor(sortedRewards.length * 0.6);
                maxPriorityFeePerGas = sortedRewards[percentileIndex];
            } else {
                maxPriorityFeePerGas = ethers.parseUnits('1.5', 'gwei');
            }

            const urgencyMultipliers = {
                'low': 1.0,
                'normal': 1.1,
                'high': 1.3,
                'urgent': 1.5
            };

            const complexityMultipliers = {
                'simple': 1.0,
                'medium': 1.05,
                'complex': 1.1,
                'flash_loan': 1.15
            };

            const multiplier = urgencyMultipliers[urgency] * complexityMultipliers[txComplexity];
            
            maxPriorityFeePerGas = maxPriorityFeePerGas * BigInt(Math.floor(multiplier * 100)) / 100n;

            const maxFeePerGas = baseFee + maxPriorityFeePerGas;
            const maxAllowedFee = ethers.parseUnits(config.maxGasPriceGwei.toString(), 'gwei');

            const finalMaxFeePerGas = maxFeePerGas > maxAllowedFee ? maxAllowedFee : maxFeePerGas;
            const finalMaxPriorityFeePerGas = maxPriorityFeePerGas > maxAllowedFee ? 
                maxAllowedFee / 2n : maxPriorityFeePerGas;

            const gasLimit = this.estimateGasLimit(txComplexity);

            const result = {
                maxFeePerGas: finalMaxFeePerGas,
                maxPriorityFeePerGas: finalMaxPriorityFeePerGas,
                gasLimit,
                baseFee: baseFee,
                estimatedTotalCost: this.estimateGasCost(finalMaxFeePerGas, gasLimit)
            };

            this.cache.set(cacheKey, result, 10);
            return result;

        } catch (error) {
            Logger.logError('Failed to get optimal gas parameters', error);
            
            return {
                maxFeePerGas: ethers.parseUnits('0.05', 'gwei'),
                maxPriorityFeePerGas: ethers.parseUnits('0.01', 'gwei'),
                gasLimit: 300000n,
                baseFee: ethers.parseUnits('0.04', 'gwei'),
                estimatedTotalCost: 0n
            };
        }
    }

    estimateGasLimit(complexity) {
        const baseGas = 21000n;
        
        const complexityGas = {
            'simple': 100000n,
            'medium': 200000n,
            'complex': 350000n,
            'flash_loan': 500000n
        };

        const gas = baseGas + (complexityGas[complexity] || 200000n);
        const safetyBuffer = 130n;

        return gas * safetyBuffer / 100n;
    }

    estimateGasCost(gasPrice, gasLimit) {
        return gasPrice * gasLimit;
    }

    async shouldWaitForBetterGas(opportunity) {
        const currentGas = await this.getOptimalGasParameters('complex', 'normal');
        const ethPrice = await this.getETHPrice();
        
        const currentCostUSD = Number(ethers.formatUnits(currentGas.estimatedTotalCost, 18)) * ethPrice;
        const opportunityProfitUSD = opportunity.netProfitUSD || 0;
        
        if (currentCostUSD > opportunityProfitUSD * 0.3) {
            return { wait: true, reason: 'Gas cost > 30% of profit' };
        }

        const baseFeeTrend = this.analyzeBaseFeeTrend();
        
        if (baseFeeTrend.direction === 'decreasing' && baseFeeTrend.rate > 0.05) {
            return { 
                wait: true, 
                reason: `Base fee decreasing at ${(baseFeeTrend.rate * 100).toFixed(2)}% per block`,
                estimatedWaitBlocks: Math.ceil(1 / baseFeeTrend.rate)
            };
        }

        const blockUtilization = await this.getBlockUtilization();
        
        if (blockUtilization > 0.9) {
            return { wait: true, reason: `High block utilization: ${(blockUtilization * 100).toFixed(1)}%` };
        }

        return { wait: false, reason: 'Gas conditions optimal' };
    }

    analyzeBaseFeeTrend() {
        if (this.baseFeeTrend.length < 10) {
            return { direction: 'stable', rate: 0 };
        }

        const recent = this.baseFeeTrend.slice(-10);
        const first = recent[0].value;
        const last = recent[recent.length - 1].value;
        
        const change = (last - first) / first;
        
        if (Math.abs(change) < 0.01) {
            return { direction: 'stable', rate: 0 };
        } else if (change > 0) {
            return { direction: 'increasing', rate: change / 10 };
        } else {
            return { direction: 'decreasing', rate: -change / 10 };
        }
    }

    async getBlockUtilization() {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const feeHistory = await provider.send('eth_feeHistory', ['0x5', 'latest', []]);
            
            if (!feeHistory || !feeHistory.gasUsedRatio) {
                return 0.5;
            }

            const recentUtilization = feeHistory.gasUsedRatio.slice(-5);
            const avgUtilization = recentUtilization.reduce((a, b) => a + parseFloat(b), 0) / recentUtilization.length;
            
            return avgUtilization;
        } catch (error) {
            return 0.5;
        }
    }

    async getETHPrice() {
        const cacheKey = 'eth_price';
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        try {
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
            const data = await response.json();
            const price = data.ethereum.usd;
            
            this.cache.set(cacheKey, price, 60);
            return price;
        } catch (error) {
            return 1800;
        }
    }

    async simulateBundle(transactions) {
        const totalGas = transactions.reduce((sum, tx) => sum + tx.gasLimit, 0n);
        
        if (totalGas > this.blockGasLimit) {
            return { 
                feasible: false, 
                reason: `Total gas ${totalGas} exceeds block limit ${this.blockGasLimit}` 
            };
        }

        const gasCosts = await Promise.all(
            transactions.map(async tx => {
                const gasParams = await this.getOptimalGasParameters(tx.complexity, tx.urgency);
                return {
                    tx,
                    cost: gasParams.estimatedTotalCost,
                    params: gasParams
                };
            })
        );

        const totalCost = gasCosts.reduce((sum, item) => sum + item.cost, 0n);
        const ethPrice = await this.getETHPrice();
        const totalCostUSD = Number(ethers.formatUnits(totalCost, 18)) * ethPrice;

        const totalProfit = transactions.reduce((sum, tx) => sum + (tx.expectedProfitUSD || 0), 0);

        return {
            feasible: totalProfit > totalCostUSD * 1.5,
            totalGas,
            totalCostUSD,
            totalProfitUSD: totalProfit,
            netProfitUSD: totalProfit - totalCostUSD,
            gasCosts
        };
    }

    getGasStats() {
        if (this.gasHistory.length === 0) {
            return { message: 'No gas data available' };
        }

        const recent = this.gasHistory.slice(-20);
        
        const baseFees = recent.map(d => Number(ethers.formatUnits(d.baseFeePerGas, 'gwei')));
        const avgBaseFee = baseFees.reduce((a, b) => a + b, 0) / baseFees.length;
        
        const utilizations = recent.map(d => d.gasUsedRatio).filter(r => r !== undefined);
        const avgUtilization = utilizations.length > 0 ? 
            utilizations.reduce((a, b) => a + b, 0) / utilizations.length : 0;

        const trend = this.analyzeBaseFeeTrend();

        return {
            currentBaseFeeGwei: avgBaseFee.toFixed(2),
            blockUtilization: (avgUtilization * 100).toFixed(1) + '%',
            trendDirection: trend.direction,
            trendRate: (trend.rate * 100).toFixed(2) + '% per block',
            samples: this.gasHistory.length,
            cacheSize: this.cache.keys().length
        };
    }
}

module.exports = GasOptimizer;
