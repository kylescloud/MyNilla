const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const axios = require('axios');
const math = require('mathjs');
const config = require('../config/config.json');
const RPCManager = require('./rpcManager');
const RateLimiter = require('./rateLimiter');
const { Logger } = require('./utils');

class ZScoreEngine {
    constructor() {
        this.pairs = new Map();
        this.priceHistory = new Map();
        this.zScoreCache = new NodeCache({ stdTTL: 30, checkperiod: 10 });
        this.cointegrationCache = new NodeCache({ stdTTL: 300 });
        this.windowSize = config.zScoreSettings.windowSize || 100;
        this.entryThreshold = config.zScoreSettings.entryThreshold || 2.0;
        this.exitThreshold = config.zScoreSettings.exitThreshold || 0.5;
        this.halfLifeThreshold = 20;
        
        this.initializePairs();
    }

    async initialize() {
        Logger.logInfo('Initializing ZScore Engine...');
        await this.loadHistoricalData();
        this.startPriceUpdateListener();
        Logger.logSuccess('ZScore Engine initialized');
    }

    async initializePairs() {
        const baseTokens = config.baseTokens;
        const topTokens = await this.getTopMarketCapTokens(50);
        
        for (let i = 0; i < baseTokens.length; i++) {
            for (let j = i + 1; j < baseTokens.length; j++) {
                const pair = {
                    tokenA: baseTokens[i],
                    tokenB: baseTokens[j],
                    type: 'base-base'
                };
                this.pairs.set(`${baseTokens[i]}-${baseTokens[j]}`, pair);
            }
        }
        
        for (const baseToken of baseTokens.slice(0, 2)) {
            for (const token of topTokens.slice(0, 15)) {
                if (token.address === baseToken) continue;
                
                const pair = {
                    tokenA: baseToken,
                    tokenB: token.address,
                    type: 'base-alt',
                    liquidity: token.liquidity
                };
                this.pairs.set(`${baseToken}-${token.address}`, pair);
            }
        }
        
        await this.performCointegrationTests();
    }

    async getTopMarketCapTokens(limit = 50) {
        try {
            const response = await RateLimiter.schedule('dexScreener', () =>
                axios.get('https://api.dexscreener.com/latest/dex/tokens/8453', {
                    params: { limit, sort: 'liquidity', order: 'desc' }
                })
            );
            
            return response.data.pairs
                .filter(pair => pair.chainId === 'base' && pair.liquidity && pair.liquidity.usd > 100000)
                .map(pair => ({
                    address: pair.baseToken.address,
                    symbol: pair.baseToken.symbol,
                    liquidity: pair.liquidity.usd,
                    volume24h: pair.volume.h24
                }))
                .filter((token, index, self) =>
                    index === self.findIndex(t => t.address === token.address)
                )
                .slice(0, limit);
        } catch (error) {
            Logger.logWarning('Failed to fetch top tokens', error.message);
            return [];
        }
    }

    async performCointegrationTests() {
        Logger.logInfo('Performing cointegration tests on pairs...');
        const cointegratedPairs = [];
        
        const pairsArray = Array.from(this.pairs.values());
        
        for (let i = 0; i < pairsArray.length; i++) {
            const pair = pairsArray[i];
            
            try {
                const isCointegrated = await this.testCointegration(pair.tokenA, pair.tokenB);
                
                if (isCointegrated) {
                    pair.cointegrated = true;
                    pair.halfLife = isCointegrated.halfLife;
                    pair.hurstExponent = isCointegrated.hurstExponent;
                    cointegratedPairs.push(pair);
                    
                    Logger.logInfo(`Pair ${pair.tokenA.substring(0, 10)}...-${pair.tokenB.substring(0, 10)}... is cointegrated (HL: ${isCointegrated.halfLife.toFixed(2)}, H: ${isCointegrated.hurstExponent.toFixed(3)})`);
                }
            } catch (error) {
                continue;
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        Logger.logSuccess(`Found ${cointegratedPairs.length} cointegrated pairs`);
    }

    async testCointegration(tokenA, tokenB, lookback = 500) {
        const cacheKey = `coint_${tokenA}_${tokenB}_${lookback}`;
        const cached = this.cointegrationCache.get(cacheKey);
        if (cached) return cached;
        
        try {
            const pricesA = await this.getHistoricalPrices(tokenA, lookback);
            const pricesB = await this.getHistoricalPrices(tokenB, lookback);
            
            if (pricesA.length < lookback * 0.8 || pricesB.length < lookback * 0.8) {
                return null;
            }
            
            const logPricesA = pricesA.map(p => Math.log(p));
            const logPricesB = pricesB.map(p => Math.log(p));
            
            const regression = this.olsRegression(logPricesA, logPricesB);
            const residuals = logPricesA.map((price, i) => price - (regression.slope * logPricesB[i] + regression.intercept));
            
            const adfResult = this.adfTest(residuals);
            
            if (adfResult.statistic > adfResult.criticalValues['1%']) {
                return null;
            }
            
            const halfLife = this.calculateHalfLife(residuals);
            const hurstExponent = this.calculateHurstExponent(residuals);
            
            if (halfLife > 100 || hurstExponent > 0.7) {
                return null;
            }
            
            const result = {
                cointegrated: true,
                halfLife,
                hurstExponent,
                slope: regression.slope,
                intercept: regression.intercept,
                adfStatistic: adfResult.statistic,
                rSquared: regression.rSquared
            };
            
            this.cointegrationCache.set(cacheKey, result);
            return result;
        } catch (error) {
            return null;
        }
    }

    olsRegression(x, y) {
        const n = x.length;
        const xMean = x.reduce((a, b) => a + b, 0) / n;
        const yMean = y.reduce((a, b) => a + b, 0) / n;
        
        let numerator = 0;
        let denominator = 0;
        
        for (let i = 0; i < n; i++) {
            numerator += (x[i] - xMean) * (y[i] - yMean);
            denominator += Math.pow(x[i] - xMean, 2);
        }
        
        const slope = numerator / denominator;
        const intercept = yMean - slope * xMean;
        
        let ssr = 0;
        let sst = 0;
        
        for (let i = 0; i < n; i++) {
            const yPred = slope * x[i] + intercept;
            ssr += Math.pow(yPred - yMean, 2);
            sst += Math.pow(y[i] - yMean, 2);
        }
        
        const rSquared = ssr / sst;
        
        return { slope, intercept, rSquared };
    }

    adfTest(residuals, lag = 1) {
        const n = residuals.length;
        const diff = [];
        
        for (let i = 1; i < n; i++) {
            diff.push(residuals[i] - residuals[i - 1]);
        }
        
        const lagged = [];
        for (let i = lag; i < n - 1; i++) {
            lagged.push(residuals[i - lag]);
        }
        
        const regression = this.olsRegression(lagged, diff.slice(lag));
        
        const se = Math.sqrt(residuals.reduce((sum, val, idx) => {
            const pred = regression.slope * (idx < lag ? 0 : residuals[idx - lag]) + regression.intercept;
            return sum + Math.pow((idx < lag ? 0 : diff[idx]) - pred, 2);
        }, 0) / (n - lag - 2));
        
        const tStat = regression.slope / se;
        
        return {
            statistic: tStat,
            criticalValues: {
                '1%': -3.43,
                '5%': -2.86,
                '10%': -2.57
            }
        };
    }

    calculateHalfLife(residuals) {
        const n = residuals.length;
        let sum = 0;
        
        for (let i = 1; i < n; i++) {
            const delta = residuals[i] - residuals[i - 1];
            const lag = residuals[i - 1];
            sum += delta * lag;
        }
        
        let sumSq = 0;
        for (let i = 0; i < n - 1; i++) {
            sumSq += Math.pow(residuals[i], 2);
        }
        
        const lambda = sum / sumSq;
        const halfLife = Math.log(2) / Math.abs(lambda);
        
        return halfLife;
    }

    calculateHurstExponent(residuals) {
        const n = residuals.length;
        const mean = residuals.reduce((a, b) => a + b, 0) / n;
        
        const deviations = residuals.map(r => r - mean);
        const cumulative = [];
        let sum = 0;
        
        for (const dev of deviations) {
            sum += dev;
            cumulative.push(sum);
        }
        
        const range = Math.max(...cumulative) - Math.min(...cumulative);
        const stdev = Math.sqrt(deviations.reduce((sum, dev) => sum + dev * dev, 0) / n);
        
        if (stdev === 0) return 0.5;
        
        const rs = range / stdev;
        const hurst = Math.log(rs) / Math.log(n);
        
        return hurst;
    }

    async getHistoricalPrices(tokenAddress, lookback = 500) {
        const cacheKey = `history_${tokenAddress}_${lookback}`;
        const cached = this.priceHistory.get(cacheKey);
        if (cached && cached.timestamp > Date.now() - 300000) {
            return cached.prices;
        }
        
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const currentBlock = await provider.getBlockNumber();
            
            const prices = [];
            const blockStep = Math.max(1, Math.floor(lookback / 100));
            
            for (let i = 0; i < lookback; i += blockStep) {
                const blockNumber = currentBlock - i;
                if (blockNumber < 0) break;
                
                const price = await this.getTokenPriceAtBlock(tokenAddress, blockNumber);
                if (price) {
                    prices.push(price);
                }
            }
            
            if (prices.length > 10) {
                this.priceHistory.set(cacheKey, {
                    prices,
                    timestamp: Date.now()
                });
            }
            
            return prices;
        } catch (error) {
            return [];
        }
    }

    async getTokenPriceAtBlock(tokenAddress, blockNumber) {
        try {
            if (tokenAddress === config.baseTokens[0]) return 1;
            
            const { provider } = await RPCManager.getHealthyProvider();
            
            const aerodromeFactory = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
            const factoryABI = [
                'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
            ];
            
            const factory = new ethers.Contract(aerodromeFactory, factoryABI, provider);
            const stablePool = await factory.getPool(tokenAddress, config.baseTokens[0], 100);
            const volatilePool = await factory.getPool(tokenAddress, config.baseTokens[0], 2000);
            
            const poolABI = [
                'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
                'function liquidity() view returns (uint128)'
            ];
            
            let poolAddress = stablePool !== ethers.ZeroAddress ? stablePool : volatilePool;
            
            if (poolAddress === ethers.ZeroAddress) {
                return null;
            }
            
            const pool = new ethers.Contract(poolAddress, poolABI, provider);
            const [slot0, liquidity] = await Promise.all([
                pool.slot0({ blockTag: blockNumber }),
                pool.liquidity({ blockTag: blockNumber })
            ]);
            
            if (liquidity === 0n) return null;
            
            const sqrtPriceX96 = slot0.sqrtPriceX96;
            const price = (Number(sqrtPriceX96) ** 2) / (2 ** 192);
            
            return price;
        } catch (error) {
            return null;
        }
    }

    async calculateZScore(pair) {
        const cacheKey = `zscore_${pair.tokenA}_${pair.tokenB}`;
        const cached = this.zScoreCache.get(cacheKey);
        if (cached) return cached;
        
        try {
            const [priceA, priceB] = await Promise.all([
                this.getCurrentPrice(pair.tokenA),
                this.getCurrentPrice(pair.tokenB)
            ]);
            
            if (!priceA || !priceB) {
                return null;
            }
            
            const ratio = priceA / priceB;
            
            const historicalRatios = await this.getHistoricalRatios(pair.tokenA, pair.tokenB, this.windowSize);
            
            if (historicalRatios.length < this.windowSize * 0.7) {
                return null;
            }
            
            const mean = historicalRatios.reduce((a, b) => a + b, 0) / historicalRatios.length;
            const variance = historicalRatios.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / historicalRatios.length;
            const stdDev = Math.sqrt(variance);
            
            if (stdDev === 0) {
                return null;
            }
            
            const zScore = (ratio - mean) / stdDev;
            
            const result = {
                value: zScore,
                mean: mean,
                stdDev: stdDev,
                ratio: ratio,
                priceA: priceA,
                priceB: priceB,
                window: historicalRatios.length,
                timestamp: Date.now(),
                pair: `${pair.tokenA}-${pair.tokenB}`,
                halfLife: pair.halfLife,
                hurstExponent: pair.hurstExponent
            };
            
            this.zScoreCache.set(cacheKey, result, 5);
            return result;
        } catch (error) {
            Logger.logWarning(`ZScore calculation failed for ${pair.tokenA}-${pair.tokenB}`, error.message);
            return null;
        }
    }

    async getCurrentPrice(tokenAddress) {
        try {
            if (tokenAddress === config.baseTokens[0]) return 1;
            
            const { provider } = await RPCManager.getHealthyProvider();
            
            const aerodromeQuoter = '0x7AFdD9d22F966638bD6cC3702E5eB8800e60cA52';
            const quoterABI = [
                'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
            ];
            
            const quoter = new ethers.Contract(aerodromeQuoter, quoterABI, provider);
            const amountIn = ethers.parseUnits('1', 18);
            
            try {
                const result = await quoter.quoteExactInputSingle(
                    config.baseTokens[0],
                    tokenAddress,
                    100,
                    amountIn,
                    0
                );
                
                const price = Number(ethers.formatUnits(result.amountOut, 18));
                return price;
            } catch (error) {
                try {
                    const result = await quoter.quoteExactInputSingle(
                        config.baseTokens[0],
                        tokenAddress,
                        2000,
                        amountIn,
                        0
                    );
                    
                    const price = Number(ethers.formatUnits(result.amountOut, 18));
                    return price;
                } catch (error2) {
                    return null;
                }
            }
        } catch (error) {
            return null;
        }
    }

    async getHistoricalRatios(tokenA, tokenB, window) {
        const pricesA = await this.getHistoricalPrices(tokenA, window);
        const pricesB = await this.getHistoricalPrices(tokenB, window);
        
        const minLength = Math.min(pricesA.length, pricesB.length);
        const ratios = [];
        
        for (let i = 0; i < minLength; i++) {
            if (pricesA[i] && pricesB[i] && pricesB[i] > 0) {
                ratios.push(pricesA[i] / pricesB[i]);
            }
        }
        
        return ratios;
    }

    async getMonitoredPairs() {
        const monitored = [];
        
        for (const [key, pair] of this.pairs) {
            if (pair.cointegrated && pair.halfLife < this.halfLifeThreshold) {
                monitored.push(pair);
            }
        }
        
        return monitored.sort((a, b) => (a.halfLife || 100) - (b.halfLife || 100));
    }

    async getTradingSignal(pair) {
        const zScore = await this.calculateZScore(pair);
        
        if (!zScore) {
            return { signal: 'HOLD', confidence: 0 };
        }
        
        const absZScore = Math.abs(zScore.value);
        let signal = 'HOLD';
        let confidence = 0;
        
        if (zScore.value > this.entryThreshold) {
            signal = 'SHORT_A_LONG_B';
            confidence = this.calculateConfidence(absZScore, zScore.hurstExponent, zScore.halfLife);
        } else if (zScore.value < -this.entryThreshold) {
            signal = 'LONG_A_SHORT_B';
            confidence = this.calculateConfidence(absZScore, zScore.hurstExponent, zScore.halfLife);
        } else if (absZScore < this.exitThreshold) {
            signal = 'CLOSE_POSITION';
            confidence = 0.8;
        }
        
        return {
            signal,
            confidence,
            zScore: zScore.value,
            halfLife: zScore.halfLife,
            hurstExponent: zScore.hurstExponent,
            ratio: zScore.ratio,
            mean: zScore.mean,
            entryThreshold: this.entryThreshold
        };
    }

    calculateConfidence(zScore, hurstExponent, halfLife) {
        let confidence = Math.min(zScore / 4, 1);
        
        if (hurstExponent < 0.4) {
            confidence *= 1.2;
        } else if (hurstExponent > 0.6) {
            confidence *= 0.8;
        }
        
        if (halfLife < 10) {
            confidence *= 1.3;
        } else if (halfLife > 30) {
            confidence *= 0.7;
        }
        
        return Math.min(Math.max(confidence, 0), 1);
    }

    startPriceUpdateListener() {
        setInterval(async () => {
            try {
                await this.updatePriceHistory();
            } catch (error) {
                Logger.logWarning('Price history update failed', error.message);
            }
        }, 30000);
    }

    async updatePriceHistory() {
        const tokens = new Set();
        
        for (const pair of this.pairs.values()) {
            tokens.add(pair.tokenA);
            tokens.add(pair.tokenB);
        }
        
        for (const token of tokens) {
            if (this.priceHistory.has(`history_${token}_${this.windowSize}`)) {
                const current = this.priceHistory.get(`history_${token}_${this.windowSize}`);
                const latestPrice = await this.getCurrentPrice(token);
                
                if (latestPrice) {
                    current.prices.unshift(latestPrice);
                    if (current.prices.length > this.windowSize * 1.5) {
                        current.prices = current.prices.slice(0, this.windowSize);
                    }
                    current.timestamp = Date.now();
                }
            }
        }
    }

    async getPairStatistics(pairKey) {
        const pair = this.pairs.get(pairKey);
        if (!pair) return null;
        
        const zScore = await this.calculateZScore(pair);
        if (!zScore) return null;
        
        const signal = await this.getTradingSignal(pair);
        
        return {
            pair: pairKey,
            tokenA: pair.tokenA,
            tokenB: pair.tokenB,
            type: pair.type,
            cointegrated: pair.cointegrated || false,
            halfLife: pair.halfLife,
            hurstExponent: pair.hurstExponent,
            zScore: zScore.value,
            mean: zScore.mean,
            stdDev: zScore.stdDev,
            currentRatio: zScore.ratio,
            signal: signal.signal,
            confidence: signal.confidence,
            entryThreshold: this.entryThreshold,
            exitThreshold: this.exitThreshold,
            priceA: zScore.priceA,
            priceB: zScore.priceB,
            windowSize: zScore.window,
            timestamp: zScore.timestamp
        };
    }

    getAllPairStatistics() {
        const statistics = [];
        
        for (const [key, pair] of this.pairs) {
            if (pair.cointegrated) {
                const stats = this.getPairStatistics(key);
                if (stats) {
                    statistics.push(stats);
                }
            }
        }
        
        return statistics;
    }
}

module.exports = ZScoreEngine;
