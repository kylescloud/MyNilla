const { ethers } = require('ethers');
const math = require('mathjs');
const config = require('../config/config.json');
const RPCManager = require('./rpcManager');
const TokenManager = require('./tokenManager');
const { Logger } = require('./utils');

class ProfitCalculator {
    constructor() {
        this.tokenManager = new TokenManager();
        this.slippageModel = new SlippageModel();
        this.gasModel = new GasModel();
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;
        
        await this.tokenManager.initialize();
        this.initialized = true;
        
        Logger.logSuccess('Profit Calculator initialized');
    }

    async calculateNetProfit(opportunity, simulatedGasUsed = null) {
        try {
            if (!this.initialized) await this.initialize();
            
            const {
                amount,
                path,
                expectedProfit,
                profitPercent,
                type
            } = opportunity;
            
            const inputAmount = ethers.getBigInt(amount);
            
            const tokenPrices = await this.getTokenPrices(path);
            const inputValueUSD = this.calculateUSDValue(
                inputAmount,
                path[0].fromToken,
                tokenPrices[path[0].fromToken]
            );
            
            const outputAmount = path[path.length - 1].outputAmount;
            const outputToken = path[path.length - 1].toToken;
            const outputValueUSD = this.calculateUSDValue(
                outputAmount,
                outputToken,
                tokenPrices[outputToken]
            );
            
            const grossProfitUSD = outputValueUSD - inputValueUSD;
            
            const gasCost = await this.estimateGasCost(
                opportunity,
                simulatedGasUsed
            );
            
            const flashLoanCost = this.calculateFlashLoanCost(
                inputAmount,
                path[0].fromToken,
                tokenPrices[path[0].fromToken]
            );
            
            const slippageBuffer = await this.calculateSlippageBuffer(
                path,
                tokenPrices
            );
            
            const netProfitUSD = grossProfitUSD - gasCost - flashLoanCost - slippageBuffer;
            const netProfitPercent = (netProfitUSD / inputValueUSD) * 100;
            
            const breakdown = {
                grossProfitUSD,
                gasCost,
                flashLoanCost,
                slippageBuffer,
                netProfitUSD,
                netProfitPercent,
                inputValueUSD,
                outputValueUSD,
                meetsThreshold: netProfitUSD >= config.minProfitThresholdUSD
            };
            
            await this.logProfitBreakdown(opportunity, breakdown);
            
            return breakdown;
        } catch (error) {
            Logger.logError('Profit calculation failed', error);
            throw error;
        }
    }

    async getTokenPrices(path) {
        const prices = {};
        const uniqueTokens = new Set();
        
        path.forEach(hop => {
            uniqueTokens.add(hop.fromToken);
            uniqueTokens.add(hop.toToken);
        });
        
        for (const token of uniqueTokens) {
            prices[token] = await this.tokenManager.getTokenPriceWithFallback(token);
        }
        
        return prices;
    }

    calculateUSDValue(amount, tokenAddress, priceUSD) {
        if (!priceUSD || priceUSD <= 0) return 0;
        
        const token = this.tokenManager.getTokenByAddress(tokenAddress);
        const decimals = token ? token.decimals : 18;
        
        const amountNumber = Number(ethers.formatUnits(amount, decimals));
        return amountNumber * priceUSD;
    }

    async estimateGasCost(opportunity, simulatedGasUsed = null) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const feeData = await provider.getFeeData();
            
            const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
            
            let totalGas = simulatedGasUsed ? 
                ethers.getBigInt(simulatedGasUsed) : 
                this.estimateTransactionGas(opportunity);
            
            const gasCostWei = gasPrice * totalGas;
            const gasCostETH = Number(ethers.formatUnits(gasCostWei, 18));
            
            const ethPrice = await this.tokenManager.getTokenPriceWithFallback(config.baseTokens[0]);
            const gasCostUSD = gasCostETH * (ethPrice || 1800);
            
            return gasCostUSD;
        } catch (error) {
            Logger.logWarning('Gas estimation failed, using fallback', error.message);
            return 10;
        }
    }

    estimateTransactionGas(opportunity) {
        let baseGas = 21000n;
        let swapGas = 0n;
        
        opportunity.path.forEach((hop, index) => {
            if (index === 0) {
                baseGas += 100000n;
            }
            
            swapGas += this.estimateSwapGas(hop);
        });
        
        const flashLoanGas = 250000n;
        const safetyMultiplier = 150n;
        
        const totalGas = (baseGas + swapGas + flashLoanGas) * safetyMultiplier / 100n;
        
        return totalGas;
    }

    estimateSwapGas(hop) {
        if (hop.dex === 'Aerodrome') {
            return 150000n;
        } else if (hop.dex === 'PancakeSwap') {
            return 120000n;
        } else if (hop.dex.includes('Uniswap')) {
            return 180000n;
        } else if (hop.aggregator === 'odos') {
            return 200000n;
        } else if (hop.aggregator === 'oneInch') {
            return 220000n;
        } else {
            return 150000n;
        }
    }

    calculateFlashLoanCost(amount, tokenAddress, priceUSD) {
        const premiumBps = config.flashLoanPremiumBps || 9;
        const premium = amount * ethers.getBigInt(premiumBps) / 10000n;
        
        const premiumValueUSD = this.calculateUSDValue(premium, tokenAddress, priceUSD);
        
        return premiumValueUSD;
    }

    async calculateSlippageBuffer(path, tokenPrices) {
        let totalSlippageUSD = 0;
        
        for (const hop of path) {
            const slippage = await this.slippageModel.estimateSlippage(
                hop.fromToken,
                hop.toToken,
                hop.amount,
                hop.dex
            );
            
            const hopValueUSD = this.calculateUSDValue(
                hop.amount,
                hop.fromToken,
                tokenPrices[hop.fromToken]
            );
            
            const slippageUSD = hopValueUSD * slippage;
            totalSlippageUSD += slippageUSD;
        }
        
        const safetyBuffer = totalSlippageUSD * 1.5;
        
        return safetyBuffer;
    }

    async simulateTransaction(opportunity) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const simulation = {
                success: false,
                gasUsed: 0,
                error: null,
                logs: [],
                result: null
            };
            
            if (config.testMode) {
                return await this.performLocalSimulation(opportunity, provider);
            }
            
            try {
                const result = await this.performTenderlySimulation(opportunity);
                return result;
            } catch (error) {
                Logger.logWarning('Tenderly simulation failed, using local', error.message);
                return await this.performLocalSimulation(opportunity, provider);
            }
        } catch (error) {
            Logger.logError('Transaction simulation failed', error);
            return {
                success: false,
                error: error.message,
                gasUsed: 0
            };
        }
    }

    async performLocalSimulation(opportunity, provider) {
        const gasEstimates = [];
        
        for (const hop of opportunity.path) {
            const gasEstimate = await this.estimateSwapGasLocal(hop, provider);
            gasEstimates.push(gasEstimate);
        }
        
        const totalGas = gasEstimates.reduce((sum, gas) => sum + gas, 0n);
        
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
        
        const gasCostWei = totalGas * gasPrice;
        const gasCostETH = Number(ethers.formatUnits(gasCostWei, 18));
        
        const ethPrice = await this.tokenManager.getTokenPriceWithFallback(config.baseTokens[0]);
        const gasCostUSD = gasCostETH * (ethPrice || 1800);
        
        const profit = await this.calculateExpectedProfit(opportunity);
        
        const netProfitUSD = profit.grossProfitUSD - gasCostUSD - profit.flashLoanCostUSD;
        
        return {
            success: netProfitUSD > 0,
            gasUsed: totalGas,
            gasCostUSD,
            netProfitUSD,
            profitDetails: profit,
            logs: ['Local simulation completed']
        };
    }

    async estimateSwapGasLocal(hop, provider) {
        const aggregatorABI = [
            'function swap(address caller, tuple(address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags, bytes permit) desc, bytes data) payable returns (uint256 returnAmount)'
        ];
        
        let gasEstimate;
        
        if (hop.aggregator === 'odos') {
            gasEstimate = 200000n;
        } else if (hop.aggregator === 'oneInch') {
            gasEstimate = 180000n;
        } else {
            const dexRouter = this.getDexRouterAddress(hop.dex);
            if (dexRouter) {
                try {
                    const router = new ethers.Contract(dexRouter, aggregatorABI, provider);
                    gasEstimate = await router.swap.estimateGas(
                        config.botWallet,
                        {
                            srcToken: hop.fromToken,
                            dstToken: hop.toToken,
                            srcReceiver: config.botWallet,
                            dstReceiver: config.botWallet,
                            amount: hop.amount,
                            minReturnAmount: 0,
                            flags: 0,
                            permit: '0x'
                        },
                        '0x'
                    );
                } catch (error) {
                    gasEstimate = 150000n;
                }
            } else {
                gasEstimate = 150000n;
            }
        }
        
        return gasEstimate;
    }

    getDexRouterAddress(dexName) {
        const routers = {
            'Aerodrome': '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
            'PancakeSwap': '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',
            'Uniswap V3': '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
            'Baseswap': '0x327Df1E6de05895d2ab08513aA9319310cE3a516'
        };
        
        return routers[dexName] || null;
    }

    async performTenderlySimulation(opportunity) {
        try {
            const tenderlyApiKey = process.env.TENDERLY_API_KEY;
            if (!tenderlyApiKey) {
                throw new Error('Tenderly API key not configured');
            }
            
            const simulationPayload = this.buildTenderlySimulationPayload(opportunity);
            
            const response = await axios.post(
                `https://api.tenderly.co/api/v1/account/${process.env.TENDERLY_USER}/project/${process.env.TENDERLY_PROJECT}/simulate`,
                simulationPayload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Access-Key': tenderlyApiKey
                    },
                    timeout: 30000
                }
            );
            
            const simulation = response.data.simulation;
            
            if (simulation.status === false) {
                return {
                    success: false,
                    error: simulation.error_message || 'Simulation failed',
                    gasUsed: simulation.gas_used,
                    logs: simulation.transaction.transaction_info.logs || []
                };
            }
            
            const gasUsed = ethers.getBigInt(simulation.gas_used);
            const feeData = await this.getFeeData();
            const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;
            
            const gasCostWei = gasUsed * gasPrice;
            const gasCostETH = Number(ethers.formatUnits(gasCostWei, 18));
            const ethPrice = await this.tokenManager.getTokenPriceWithFallback(config.baseTokens[0]);
            const gasCostUSD = gasCostETH * (ethPrice || 1800);
            
            const profit = await this.calculateExpectedProfit(opportunity);
            const netProfitUSD = profit.grossProfitUSD - gasCostUSD - profit.flashLoanCostUSD;
            
            return {
                success: true,
                gasUsed,
                gasCostUSD,
                netProfitUSD,
                profitDetails: profit,
                logs: simulation.transaction.transaction_info.logs || []
            };
        } catch (error) {
            throw error;
        }
    }

    buildTenderlySimulationPayload(opportunity) {
        return {
            network_id: config.chainId.toString(),
            from: config.botWallet,
            to: process.env.ARB_CONTRACT_ADDRESS,
            input: this.encodeArbitrageCall(opportunity),
            gas: 8000000,
            gas_price: '0',
            value: '0',
            save: true,
            save_if_fails: true
        };
    }

    encodeArbitrageCall(opportunity) {
        const iface = new ethers.Interface([
            'function executeArbitrage(tuple(address[] tokens, uint256[] amounts, address[] aggregators, bytes[] swapData) path, uint256 flashLoanAmount, uint256 minProfit)'
        ]);
        
        const encodedPath = {
            tokens: opportunity.path.map(hop => hop.fromToken).concat([opportunity.path[opportunity.path.length - 1].toToken]),
            amounts: opportunity.path.map(hop => hop.amount),
            aggregators: opportunity.path.map(hop => this.getAggregatorAddress(hop.dex)),
            swapData: opportunity.path.map(() => '0x')
        };
        
        return iface.encodeFunctionData('executeArbitrage', [
            encodedPath,
            opportunity.amount,
            opportunity.minProfit || 0
        ]);
    }

    getAggregatorAddress(aggregatorName) {
        const aggregators = {
            'odos': '0xCf5540fFFCdC3d510B18bFcA6d56b9d8C1E6d8b7',
            'oneInch': '0x1111111254EEB25477B68fb85Ed929f73A960582',
            'cow': '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
        };
        
        return aggregators[aggregatorName] || ethers.ZeroAddress;
    }

    async calculateExpectedProfit(opportunity) {
        const tokenPrices = await this.getTokenPrices(opportunity.path);
        
        const inputAmount = ethers.getBigInt(opportunity.amount);
        const inputToken = opportunity.path[0].fromToken;
        const inputValueUSD = this.calculateUSDValue(inputAmount, inputToken, tokenPrices[inputToken]);
        
        const outputAmount = opportunity.path[opportunity.path.length - 1].outputAmount;
        const outputToken = opportunity.path[opportunity.path.length - 1].toToken;
        const outputValueUSD = this.calculateUSDValue(outputAmount, outputToken, tokenPrices[outputToken]);
        
        const grossProfitUSD = outputValueUSD - inputValueUSD;
        
        const flashLoanCostUSD = this.calculateFlashLoanCost(
            inputAmount,
            inputToken,
            tokenPrices[inputToken]
        );
        
        const slippageBufferUSD = await this.calculateSlippageBuffer(
            opportunity.path,
            tokenPrices
        );
        
        return {
            grossProfitUSD,
            flashLoanCostUSD,
            slippageBufferUSD,
            inputValueUSD,
            outputValueUSD
        };
    }

    async logProfitBreakdown(opportunity, breakdown) {
        Logger.logInfo('Profit Breakdown:', {
            type: opportunity.type,
            inputAmount: ethers.formatUnits(opportunity.amount, 18),
            inputValueUSD: breakdown.inputValueUSD.toFixed(2),
            outputValueUSD: breakdown.outputValueUSD.toFixed(2),
            grossProfitUSD: breakdown.grossProfitUSD.toFixed(2),
            gasCostUSD: breakdown.gasCost.toFixed(2),
            flashLoanCostUSD: breakdown.flashLoanCost.toFixed(2),
            slippageBufferUSD: breakdown.slippageBuffer.toFixed(2),
            netProfitUSD: breakdown.netProfitUSD.toFixed(2),
            netProfitPercent: breakdown.netProfitPercent.toFixed(4) + '%',
            meetsThreshold: breakdown.meetsThreshold
        });
    }

    async calculateOptimalTradeSize(path, availableCapitalUSD) {
        const tokenPrices = await this.getTokenPrices(path);
        const inputToken = path[0].fromToken;
        const inputTokenPrice = tokenPrices[inputToken];
        
        if (!inputTokenPrice || inputTokenPrice <= 0) {
            return 0n;
        }
        
        const token = this.tokenManager.getTokenByAddress(inputToken);
        const decimals = token ? token.decimals : 18;
        
        const maxInputUSD = Math.min(availableCapitalUSD, 10000);
        const maxInputTokens = maxInputUSD / inputTokenPrice;
        const maxInputAmount = ethers.parseUnits(maxInputTokens.toString(), decimals);
        
        const liquidity = await this.estimatePathLiquidity(path, maxInputAmount);
        
        if (liquidity.liquidityScore < 0.1) {
            return 0n;
        }
        
        const optimalRatio = Math.min(0.1, liquidity.liquidityScore * 0.3);
        const optimalInputUSD = maxInputUSD * optimalRatio;
        const optimalInputTokens = optimalInputUSD / inputTokenPrice;
        
        return ethers.parseUnits(optimalInputTokens.toString(), decimals);
    }

    async estimatePathLiquidity(path, maxInputAmount) {
        let minLiquidityScore = 1;
        let totalSlippage = 0;
        
        for (const hop of path) {
            const hopLiquidity = await this.estimateHopLiquidity(hop, maxInputAmount);
            minLiquidityScore = Math.min(minLiquidityScore, hopLiquidity.liquidityScore);
            totalSlippage += hopLiquidity.estimatedSlippage;
        }
        
        return {
            liquidityScore: minLiquidityScore,
            estimatedSlippage: totalSlippage,
            viable: minLiquidityScore > 0.05
        };
    }

    async estimateHopLiquidity(hop, inputAmount) {
        const { provider } = await RPCManager.getHealthyProvider();
        
        if (hop.dex === 'Aerodrome') {
            return await this.estimateAerodromeLiquidity(hop, inputAmount, provider);
        }
        
        const baseLiquidity = 1000000;
        const liquidityScore = Math.min(1, Number(inputAmount) / baseLiquidity);
        const estimatedSlippage = this.slippageModel.estimateSlippageForLiquidity(
            Number(inputAmount),
            baseLiquidity
        );
        
        return {
            liquidityScore,
            estimatedSlippage,
            dex: hop.dex
        };
    }

    async estimateAerodromeLiquidity(hop, inputAmount, provider) {
        try {
            const factoryAddress = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
            const factoryABI = [
                'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
            ];
            
            const factory = new ethers.Contract(factoryAddress, factoryABI, provider);
            
            const poolAddress = await factory.getPool(hop.fromToken, hop.toToken, 100);
            if (poolAddress === ethers.ZeroAddress) {
                return { liquidityScore: 0, estimatedSlippage: 1 };
            }
            
            const poolABI = [
                'function liquidity() view returns (uint128)',
                'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
            ];
            
            const pool = new ethers.Contract(poolAddress, poolABI, provider);
            const [liquidity, slot0] = await Promise.all([
                pool.liquidity(),
                pool.slot0()
            ]);
            
            const liquidityNumber = Number(liquidity);
            const sqrtPriceX96 = slot0.sqrtPriceX96;
            const price = (Number(sqrtPriceX96) ** 2) / (2 ** 192);
            
            const liquidityUSD = liquidityNumber * price * 2;
            const inputAmountNumber = Number(inputAmount);
            
            const liquidityScore = Math.min(1, liquidityUSD / (inputAmountNumber * price * 10));
            const estimatedSlippage = this.slippageModel.estimateSlippageForLiquidity(
                inputAmountNumber * price,
                liquidityUSD
            );
            
            return {
                liquidityScore,
                estimatedSlippage,
                dex: hop.dex,
                poolLiquidityUSD: liquidityUSD
            };
        } catch (error) {
            return { liquidityScore: 0.1, estimatedSlippage: 0.05 };
        }
    }
}

class SlippageModel {
    constructor() {
        this.history = new Map();
        this.slippageCache = new NodeCache({ stdTTL: 60 });
    }

    async estimateSlippage(fromToken, toToken, amount, dex) {
        const cacheKey = `slippage_${fromToken}_${toToken}_${amount}_${dex}`;
        const cached = this.slippageCache.get(cacheKey);
        if (cached) return cached;
        
        const baseSlippage = this.getBaseSlippage(dex);
        
        const liquidityFactor = await this.getLiquidityFactor(fromToken, toToken, dex);
        const amountFactor = this.getAmountFactor(amount);
        const volatilityFactor = await this.getVolatilityFactor(fromToken);
        
        const totalSlippage = baseSlippage * liquidityFactor * amountFactor * volatilityFactor;
        
        const cappedSlippage = Math.min(Math.max(totalSlippage, 0.0001), 0.1);
        
        this.slippageCache.set(cacheKey, cappedSlippage);
        return cappedSlippage;
    }

    getBaseSlippage(dex) {
        const slippageMap = {
            'Aerodrome': 0.001,
            'PancakeSwap': 0.0015,
            'Uniswap V3': 0.002,
            'Baseswap': 0.002,
            'odos': 0.0005,
            'oneInch': 0.0008,
            'cow': 0.0003
        };
        
        return slippageMap[dex] || 0.005;
    }

    async getLiquidityFactor(fromToken, toToken, dex) {
        try {
            const liquidity = await this.estimatePairLiquidity(fromToken, toToken, dex);
            
            if (liquidity > 1000000) return 1.0;
            if (liquidity > 500000) return 1.2;
            if (liquidity > 100000) return 1.5;
            if (liquidity > 50000) return 2.0;
            return 3.0;
        } catch (error) {
            return 2.0;
        }
    }

    async estimatePairLiquidity(fromToken, toToken, dex) {
        if (dex === 'Aerodrome') {
            return await this.estimateAerodromePairLiquidity(fromToken, toToken);
        }
        
        return 100000;
    }

    async estimateAerodromePairLiquidity(fromToken, toToken) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const factoryAddress = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
            const factoryABI = [
                'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
            ];
            
            const factory = new ethers.Contract(factoryAddress, factoryABI, provider);
            const poolAddress = await factory.getPool(fromToken, toToken, 100);
            
            if (poolAddress === ethers.ZeroAddress) {
                return 0;
            }
            
            const poolABI = ['function liquidity() view returns (uint128)'];
            const pool = new ethers.Contract(poolAddress, poolABI, provider);
            const liquidity = await pool.liquidity();
            
            return Number(liquidity);
        } catch (error) {
            return 0;
        }
    }

    getAmountFactor(amount) {
        const amountNumber = Number(amount);
        
        if (amountNumber < 1000) return 1.0;
        if (amountNumber < 10000) return 1.1;
        if (amountNumber < 50000) return 1.3;
        if (amountNumber < 100000) return 1.6;
        if (amountNumber < 500000) return 2.0;
        return 3.0;
    }

    async getVolatilityFactor(token) {
        const priceHistory = await this.getTokenPriceHistory(token, 20);
        
        if (priceHistory.length < 5) return 1.0;
        
        const returns = [];
        for (let i = 1; i < priceHistory.length; i++) {
            const returnVal = (priceHistory[i] - priceHistory[i-1]) / priceHistory[i-1];
            returns.push(returnVal);
        }
        
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
        const volatility = Math.sqrt(variance);
        
        if (volatility < 0.01) return 1.0;
        if (volatility < 0.03) return 1.2;
        if (volatility < 0.05) return 1.5;
        if (volatility < 0.1) return 2.0;
        return 3.0;
    }

    async getTokenPriceHistory(token, lookback) {
        const cacheKey = `price_history_${token}_${lookback}`;
        const cached = this.slippageCache.get(cacheKey);
        if (cached) return cached;
        
        try {
            const tokenManager = new TokenManager();
            const prices = [];
            
            for (let i = 0; i < lookback; i++) {
                const price = await tokenManager.getTokenPriceWithFallback(token);
                if (price) {
                    prices.push(price);
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            this.slippageCache.set(cacheKey, prices, 300);
            return prices;
        } catch (error) {
            return [];
        }
    }

    estimateSlippageForLiquidity(tradeSizeUSD, liquidityUSD) {
        if (liquidityUSD === 0) return 1.0;
        
        const ratio = tradeSizeUSD / liquidityUSD;
        
        if (ratio < 0.001) return 0.0005;
        if (ratio < 0.005) return 0.001;
        if (ratio < 0.01) return 0.002;
        if (ratio < 0.02) return 0.005;
        if (ratio < 0.05) return 0.01;
        if (ratio < 0.1) return 0.02;
        if (ratio < 0.2) return 0.05;
        return 0.1;
    }
}

class GasModel {
    constructor() {
        this.gasHistory = [];
        this.maxHistorySize = 100;
    }

    async getOptimalGasPrice() {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const feeData = await provider.getFeeData();
            
            const baseFee = feeData.gasPrice || 0n;
            const maxPriorityFee = feeData.maxPriorityFeePerGas || 0n;
            
            const currentGas = baseFee + maxPriorityFee;
            
            this.gasHistory.push({
                timestamp: Date.now(),
                gasPrice: currentGas,
                baseFee,
                maxPriorityFee
            });
            
            if (this.gasHistory.length > this.maxHistorySize) {
                this.gasHistory.shift();
            }
            
            const avgGas = this.calculateAverageGas();
            const optimalGas = this.calculateOptimalGas(currentGas, avgGas);
            
            return optimalGas;
        } catch (error) {
            const fallbackGas = ethers.parseUnits('0.05', 'gwei');
            return fallbackGas;
        }
    }

    calculateAverageGas() {
        if (this.gasHistory.length === 0) return 0n;
        
        const sum = this.gasHistory.reduce((acc, entry) => acc + entry.gasPrice, 0n);
        return sum / BigInt(this.gasHistory.length);
    }

    calculateOptimalGas(currentGas, averageGas) {
        if (this.gasHistory.length < 10) {
            return currentGas * 120n / 100n;
        }
        
        const gasGwei = Number(ethers.formatUnits(currentGas, 'gwei'));
        const avgGwei = Number(ethers.formatUnits(averageGas, 'gwei'));
        
        let optimalGwei;
        
        if (gasGwei < avgGwei * 0.9) {
            optimalGwei = avgGwei * 1.1;
        } else if (gasGwei > avgGwei * 1.5) {
            optimalGwei = avgGwei * 1.3;
        } else {
            optimalGwei = gasGwei * 1.15;
        }
        
        const maxGwei = config.maxGasPriceGwei || 50;
        optimalGwei = Math.min(optimalGwei, maxGwei);
        
        return ethers.parseUnits(optimalGwei.toString(), 'gwei');
    }

    async estimateGasForTransaction(complexity) {
        const baseGas = 21000n;
        
        let additionalGas = 0n;
        
        switch (complexity) {
            case 'simple_swap':
                additionalGas = 100000n;
                break;
            case 'multi_hop':
                additionalGas = 200000n;
                break;
            case 'flash_loan':
                additionalGas = 300000n;
                break;
            case 'complex_arb':
                additionalGas = 500000n;
                break;
            default:
                additionalGas = 150000n;
        }
        
        const safetyBuffer = 150n;
        const totalGas = (baseGas + additionalGas) * safetyBuffer / 100n;
        
        return totalGas;
    }
}

module.exports = ProfitCalculator;
