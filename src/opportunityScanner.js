const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const axios = require('axios');
const config = require('../config/config.json');
const RPCManager = require('./rpcManager');
const RateLimiter = require('./rateLimiter');
const TokenManager = require('./tokenManager');
const ZScoreEngine = require('./zScoreEngine');
const AggregatorService = require('./aggregatorService');
const { Logger } = require('./utils');

class OpportunityScanner {
    constructor() {
        this.tokenManager = new TokenManager();
        this.zScoreEngine = new ZScoreEngine();
        this.aggregatorService = new AggregatorService();
        this.pathCache = new NodeCache({ stdTTL: 5, checkperiod: 1 });
        this.opportunityCache = new NodeCache({ stdTTL: 10 });
        this.maxHops = 6;
        this.minLiquidityUSD = 10000;
    }

    async initialize() {
        await this.tokenManager.initialize();
        await this.zScoreEngine.initialize();
        Logger.logInfo('OpportunityScanner initialized');
    }

    async scan() {
        const opportunities = [];
        
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const blockNumber = await provider.getBlockNumber();
            
            const activeTokens = await this.getActiveTokensWithLiquidity();
            const statisticalOpportunities = await this.scanStatisticalArbitrage();
            
            opportunities.push(...statisticalOpportunities);
            
            if (activeTokens.length >= 2) {
                const triangularOpportunities = await this.scanTriangularArbitrage(activeTokens);
                opportunities.push(...triangularOpportunities);
                
                const multiHopOpportunities = await this.scanMultiHopArbitrage(activeTokens);
                opportunities.push(...multiHopOpportunities);
            }
            
            const validatedOpportunities = await this.validateOpportunities(opportunities);
            
            return this.rankOpportunities(validatedOpportunities);
            
        } catch (error) {
            Logger.logError('Scan failed', error);
            return [];
        }
    }

    async getActiveTokensWithLiquidity() {
        const allTokens = await this.tokenManager.getAllTokens();
        const tokensWithLiquidity = [];
        
        for (const token of allTokens) {
            try {
                const liquidity = await this.estimateTokenLiquidity(token.address);
                
                if (liquidity >= this.minLiquidityUSD) {
                    tokensWithLiquidity.push({
                        ...token,
                        liquidityUSD: liquidity
                    });
                }
            } catch (error) {
                continue;
            }
        }
        
        return tokensWithLiquidity
            .sort((a, b) => b.liquidityUSD - a.liquidityUSD)
            .slice(0, 20);
    }

    async estimateTokenLiquidity(tokenAddress) {
        const cacheKey = `liquidity_${tokenAddress}`;
        const cached = this.pathCache.get(cacheKey);
        if (cached) return cached;
        
        try {
            const dexes = config.monitoredDexes;
            let totalLiquidity = 0;
            
            for (const dex of dexes) {
                const liquidity = await this.getDexLiquidity(dex, tokenAddress);
                totalLiquidity += liquidity;
            }
            
            this.pathCache.set(cacheKey, totalLiquidity);
            return totalLiquidity;
        } catch (error) {
            return 0;
        }
    }

    async getDexLiquidity(dexName, tokenAddress) {
        try {
            const baseToken = config.baseTokens[0];
            
            if (dexName === 'Aerodrome') {
                const response = await axios.get(
                    `https://api.uniswap.org/v1/pools?token0=${baseToken}&token1=${tokenAddress}&chainId=8453`
                );
                return response.data.pools.reduce((sum, pool) => sum + pool.liquidityUSD, 0);
            }
            
            return 0;
        } catch (error) {
            return 0;
        }
    }

    async scanStatisticalArbitrage() {
        const opportunities = [];
        const pairs = await this.zScoreEngine.getMonitoredPairs();
        
        for (const pair of pairs) {
            try {
                const zScore = await this.zScoreEngine.calculateZScore(pair);
                
                if (Math.abs(zScore.value) >= config.zScoreSettings.entryThreshold) {
                    const opportunity = await this.buildStatisticalArbitrage(pair, zScore);
                    
                    if (opportunity) {
                        opportunities.push(opportunity);
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        return opportunities;
    }

    async buildStatisticalArbitrage(pair, zScore) {
        const { tokenA, tokenB, poolAddress, dex } = pair;
        
        const priceA = await this.getTokenPrice(tokenA);
        const priceB = await this.getTokenPrice(tokenB);
        
        const expectedRatio = zScore.mean;
        const currentRatio = priceA / priceB;
        
        const deviation = (currentRatio - expectedRatio) / expectedRatio;
        
        const isOvervalued = zScore.value > 0;
        const sellToken = isOvervalued ? tokenA : tokenB;
        const buyToken = isOvervalued ? tokenB : tokenA;
        
        const amount = await this.calculateOptimalTradeSize(sellToken, buyToken, deviation);
        
        if (amount <= 0) return null;
        
        const path = await this.findOptimalPath(sellToken, buyToken, amount);
        
        if (!path || path.outputAmount <= amount) return null;
        
        const returnPath = await this.findOptimalPath(buyToken, sellToken, path.outputAmount);
        
        if (!returnPath) return null;
        
        const roundTripOutput = returnPath.outputAmount;
        const profit = roundTripOutput - amount;
        const profitPercent = (profit / amount) * 100;
        
        return {
            type: 'statistical',
            pair: `${tokenA}/${tokenB}`,
            zScore: {
                value: zScore.value,
                mean: zScore.mean,
                stdDev: zScore.stdDev,
                window: zScore.window,
                convictionLevel: this.getConvictionLevel(Math.abs(zScore.value))
            },
            path: [
                {
                    fromToken: sellToken,
                    toToken: buyToken,
                    amount: amount,
                    outputAmount: path.outputAmount,
                    dex: path.dex,
                    priceImpact: path.priceImpact
                },
                {
                    fromToken: buyToken,
                    toToken: sellToken,
                    amount: path.outputAmount,
                    outputAmount: roundTripOutput,
                    dex: returnPath.dex,
                    priceImpact: returnPath.priceImpact
                }
            ],
            amount: amount,
            expectedProfit: profit,
            profitPercent: profitPercent,
            deviationPercent: deviation * 100,
            timestamp: Date.now()
        };
    }

    async scanTriangularArbitrage(tokens) {
        const opportunities = [];
        const baseToken = config.baseTokens[0];
        
        for (let i = 0; i < tokens.length; i++) {
            for (let j = i + 1; j < tokens.length; j++) {
                const tokenA = tokens[i];
                const tokenB = tokens[j];
                
                if (tokenA.address === tokenB.address) continue;
                
                try {
                    const opportunity = await this.checkTriangularPath(baseToken, tokenA, tokenB);
                    if (opportunity) opportunities.push(opportunity);
                } catch (error) {
                    continue;
                }
            }
        }
        
        return opportunities;
    }

    async checkTriangularPath(baseToken, tokenA, tokenB) {
        const amount = ethers.parseUnits('1', 18);
        
        const path1 = await this.findOptimalPath(baseToken.address, tokenA.address, amount);
        if (!path1) return null;
        
        const path2 = await this.findOptimalPath(tokenA.address, tokenB.address, path1.outputAmount);
        if (!path2) return null;
        
        const path3 = await this.findOptimalPath(tokenB.address, baseToken.address, path2.outputAmount);
        if (!path3) return null;
        
        const finalAmount = path3.outputAmount;
        
        if (finalAmount > amount) {
            const profit = finalAmount - amount;
            const profitPercent = (Number(profit) / Number(amount)) * 100;
            
            return {
                type: 'triangular',
                tokens: [baseToken.address, tokenA.address, tokenB.address],
                path: [path1, path2, path3],
                amount: amount,
                expectedProfit: profit,
                profitPercent: profitPercent,
                timestamp: Date.now()
            };
        }
        
        return null;
    }

    async scanMultiHopArbitrage(tokens) {
        const opportunities = [];
        const maxPathsToCheck = 100;
        let pathsChecked = 0;
        
        for (const startToken of config.baseTokens.slice(0, 2)) {
            const foundPaths = await this.findProfitablePaths(startToken.address, tokens, 2, this.maxHops);
            
            for (const path of foundPaths.slice(0, 10)) {
                if (pathsChecked >= maxPathsToCheck) break;
                
                try {
                    const optimized = await this.optimizePath(path);
                    if (optimized && optimized.profitPercent > 0.1) {
                        opportunities.push(optimized);
                    }
                    pathsChecked++;
                } catch (error) {
                    continue;
                }
            }
        }
        
        return opportunities;
    }

    async findProfitablePaths(startToken, tokens, minHops, maxHops) {
        const profitablePaths = [];
        
        const dfs = async (currentPath, currentToken, currentAmount, hops) => {
            if (hops > maxHops) return;
            
            if (hops >= minHops && currentToken === startToken && currentPath.length > 1) {
                const profit = currentAmount - ethers.parseUnits('1', 18);
                if (profit > 0) {
                    profitablePaths.push({
                        path: [...currentPath],
                        profit: profit,
                        hops: hops
                    });
                }
                return;
            }
            
            const nextTokens = tokens
                .filter(t => t.address !== currentToken)
                .slice(0, 5);
            
            for (const nextToken of nextTokens) {
                try {
                    const nextStep = await this.findOptimalPath(currentToken, nextToken.address, currentAmount);
                    
                    if (nextStep) {
                        await dfs(
                            [...currentPath, nextStep],
                            nextToken.address,
                            nextStep.outputAmount,
                            hops + 1
                        );
                    }
                } catch (error) {
                    continue;
                }
            }
        };
        
        const initialAmount = ethers.parseUnits('1', 18);
        await dfs([], startToken, initialAmount, 0);
        
        return profitablePaths.sort((a, b) => Number(b.profit) - Number(a.profit));
    }

    async findOptimalPath(fromToken, toToken, amount) {
        const cacheKey = `path_${fromToken}_${toToken}_${amount}`;
        const cached = this.pathCache.get(cacheKey);
        if (cached) return cached;
        
        try {
            const routes = [];
            
            for (const aggregator of config.aggregatorPriority) {
                try {
                    const route = await RateLimiter.schedule(aggregator, () =>
                        this.aggregatorService.getRoute(aggregator, fromToken, toToken, amount)
                    );
                    
                    if (route && route.returnAmount > 0) {
                        routes.push({
                            aggregator,
                            returnAmount: route.returnAmount,
                            path: route.path,
                            gasEstimate: route.gasEstimate,
                            priceImpact: this.calculatePriceImpact(amount, route.returnAmount, fromToken, toToken),
                            data: route.data
                        });
                    }
                } catch (error) {
                    continue;
                }
            }
            
            if (routes.length === 0) {
                const directRoute = await this.getDirectDexRoute(fromToken, toToken, amount);
                if (directRoute) routes.push(directRoute);
            }
            
            if (routes.length > 0) {
                const bestRoute = routes.reduce((best, current) =>
                    current.returnAmount > best.returnAmount ? current : best
                );
                
                const result = {
                    fromToken,
                    toToken,
                    amount,
                    outputAmount: bestRoute.returnAmount,
                    dex: bestRoute.aggregator || 'Direct',
                    priceImpact: bestRoute.priceImpact,
                    gasEstimate: bestRoute.gasEstimate,
                    path: bestRoute.path,
                    data: bestRoute.data
                };
                
                this.pathCache.set(cacheKey, result, 5);
                return result;
            }
            
            return null;
        } catch (error) {
            Logger.logWarning(`Path finding failed: ${fromToken}->${toToken}`, error.message);
            return null;
        }
    }

    async getDirectDexRoute(fromToken, toToken, amount) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const aerodromeRouter = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';
            const pancakeRouter = '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86';
            
            const routerABI = [
                'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)'
            ];
            
            const routers = [
                { address: aerodromeRouter, name: 'Aerodrome' },
                { address: pancakeRouter, name: 'PancakeSwap' }
            ];
            
            for (const router of routers) {
                try {
                    const contract = new ethers.Contract(router.address, routerABI, provider);
                    const path = [fromToken, toToken];
                    const amounts = await contract.getAmountsOut(amount, path);
                    
                    if (amounts && amounts.length >= 2) {
                        return {
                            aggregator: router.name,
                            returnAmount: amounts[1],
                            path: path,
                            gasEstimate: 100000,
                            priceImpact: 0
                        };
                    }
                } catch (error) {
                    continue;
                }
            }
            
            return null;
        } catch (error) {
            return null;
        }
    }

    calculatePriceImpact(inputAmount, outputAmount, fromToken, toToken) {
        try {
            const fromPrice = this.tokenManager.getTokenPrice(fromToken) || 1;
            const toPrice = this.tokenManager.getTokenPrice(toToken) || 1;
            
            const inputValue = Number(inputAmount) * fromPrice / 1e18;
            const outputValue = Number(outputAmount) * toPrice / 1e18;
            
            if (inputValue === 0) return 0;
            
            return (outputValue - inputValue) / inputValue;
        } catch (error) {
            return 0;
        }
    }

    async getTokenPrice(tokenAddress) {
        return this.tokenManager.getTokenPrice(tokenAddress);
    }

    async calculateOptimalTradeSize(sellToken, buyToken, deviation) {
        const maxTradeSizeUSD = 1000;
        const sellTokenPrice = await this.getTokenPrice(sellToken);
        
        if (!sellTokenPrice) return 0;
        
        const baseSize = maxTradeSizeUSD / sellTokenPrice;
        const scaledSize = baseSize * Math.min(Math.abs(deviation) * 10, 1);
        
        return ethers.parseUnits(scaledSize.toString(), 18);
    }

    getConvictionLevel(zScore) {
        if (zScore >= 3) return 'Very High';
        if (zScore >= 2.5) return 'High';
        if (zScore >= 2) return 'Medium';
        return 'Low';
    }

    async validateOpportunities(opportunities) {
        const validated = [];
        
        for (const opp of opportunities) {
            try {
                const simulated = await this.simulateOpportunity(opp);
                
                if (simulated.success && simulated.profitPercent > 0.05) {
                    validated.push({
                        ...opp,
                        validated: true,
                        simulationResult: simulated
                    });
                }
            } catch (error) {
                continue;
            }
        }
        
        return validated;
    }

    async simulateOpportunity(opportunity) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const gasPrice = await provider.getFeeData();
            const gasCost = opportunity.path.reduce((sum, hop) => sum + (hop.gasEstimate || 50000), 0);
            
            const gasCostUSD = Number(ethers.formatUnits(gasPrice.gasPrice * BigInt(gasCost), 18)) * 1800;
            
            const profitUSD = Number(opportunity.expectedProfit) / 1e18 * 1800;
            const netProfitUSD = profitUSD - gasCostUSD;
            const netProfitPercent = (netProfitUSD / (Number(opportunity.amount) / 1e18 * 1800)) * 100;
            
            return {
                success: netProfitPercent > 0,
                profitUSD,
                gasCostUSD,
                netProfitUSD,
                netProfitPercent,
                gasUsed: gasCost
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    rankOpportunities(opportunities) {
        return opportunities.sort((a, b) => {
            const aScore = this.calculateOpportunityScore(a);
            const bScore = this.calculateOpportunityScore(b);
            return bScore - aScore;
        });
    }

    calculateOpportunityScore(opportunity) {
        let score = 0;
        
        score += opportunity.profitPercent * 10;
        
        if (opportunity.type === 'statistical') {
            score += Math.abs(opportunity.zScore.value) * 5;
            if (opportunity.zScore.convictionLevel === 'Very High') score += 20;
            if (opportunity.zScore.convictionLevel === 'High') score += 10;
        }
        
        const totalLiquidity = opportunity.path.reduce((sum, hop) => {
            const liquidity = this.estimateTokenLiquidity(hop.fromToken);
            return sum + liquidity;
        }, 0);
        
        score += Math.log10(totalLiquidity) * 5;
        
        score -= opportunity.path.reduce((sum, hop) => sum + (hop.priceImpact || 0), 0) * 100;
        
        return score;
    }

    async optimizePath(path) {
        try {
            const optimizedSteps = [];
            let currentAmount = path.amount;
            
            for (const step of path.path) {
                const optimized = await this.findOptimalPath(step.fromToken, step.toToken, currentAmount);
                
                if (!optimized) return null;
                
                optimizedSteps.push(optimized);
                currentAmount = optimized.outputAmount;
            }
            
            const finalAmount = currentAmount;
            const profit = finalAmount - path.amount;
            const profitPercent = (Number(profit) / Number(path.amount)) * 100;
            
            return {
                ...path,
                path: optimizedSteps,
                expectedProfit: profit,
                profitPercent: profitPercent,
                optimized: true
            };
        } catch (error) {
            return null;
        }
    }

    async getPriceComparison(tokenAddress) {
        const comparisons = {};
        
        for (const dex of config.monitoredDexes) {
            try {
                const price = await this.getDexPrice(dex, tokenAddress);
                if (price > 0) {
                    comparisons[dex] = price;
                }
            } catch (error) {
                continue;
            }
        }
        
        return comparisons;
    }

    async getDexPrice(dex, tokenAddress) {
        try {
            const baseToken = config.baseTokens[0];
            const amount = ethers.parseUnits('1', 18);
            
            const route = await this.findOptimalPath(baseToken, tokenAddress, amount);
            
            if (route && route.outputAmount > 0) {
                return Number(route.outputAmount) / 1e18;
            }
            
            return 0;
        } catch (error) {
            return 0;
        }
    }
}

module.exports = OpportunityScanner;
