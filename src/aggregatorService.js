const axios = require('axios');
const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const config = require('../config/config.json');
const RPCManager = require('./rpcManager');
const { Logger } = require('./utils');

class AggregatorService {
    constructor(rateLimiter) {
        this.rateLimiter = rateLimiter;
        this.cache = new NodeCache({ stdTTL: 10, checkperiod: 5 });
        this.aggregatorConfigs = {
            odos: {
                baseUrl: 'https://api.odos.xyz',
                endpoints: {
                    quote: '/sor/quote/v2',
                    assemble: '/sor/assemble',
                    swap: '/sor/swap'
                },
                chainId: 8453,
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.ODOS_API_KEY && { 'Authorization': `Bearer ${process.env.ODOS_API_KEY}` })
                },
                timeout: 15000,
                maxSlippage: 0.5, // 0.5%
                disableRFQs: true
            },
            oneInch: {
                baseUrl: 'https://api.1inch.io',
                endpoints: {
                    quote: '/v5.0/8453/quote',
                    swap: '/v5.0/8453/swap',
                    tokens: '/v5.0/8453/tokens',
                    protocols: '/v5.0/8453/protocols'
                },
                chainId: 8453,
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.ONE_INCH_API_KEY && { 'Authorization': `Bearer ${process.env.ONE_INCH_API_KEY}` })
                },
                timeout: 15000,
                maxSlippage: 0.5,
                protocols: config.monitoredDexes.join(',')
            },
            cow: {
                baseUrl: 'https://api.cow.fi',
                endpoints: {
                    quote: '/mainnet/api/v1/quote',
                    orders: '/mainnet/api/v1/orders',
                    tokens: '/mainnet/api/v1/tokens'
                },
                chainId: 8453,
                headers: {
                    'Content-Type': 'application/json',
                    ...(process.env.COW_API_KEY && { 'Authorization': `Bearer ${process.env.COW_API_KEY}` })
                },
                timeout: 20000,
                maxSlippage: 0.3, // 0.3% for CoW
                signingScheme: 'eip712',
                partiallyFillable: false
            }
        };
        
        this.directDexes = {
            'Aerodrome': {
                router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
                factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
                feeTiers: [100, 500, 2500, 10000]
            },
            'PancakeSwap': {
                router: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',
                factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
                feeTiers: [100, 500, 2500, 10000]
            },
            'Uniswap V3': {
                router: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
                factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
                feeTiers: [100, 500, 3000, 10000]
            },
            'Baseswap': {
                router: '0x327Df1E6de05895d2ab08513aA9319310cE3a516',
                factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
                feeTiers: [200, 500, 3000]
            }
        };
        
        this.initialize();
    }

    async initialize() {
        Logger.logInfo('Initializing Aggregator Service...');
        
        // Test aggregator connectivity
        await this.testAggregatorConnectivity();
        
        Logger.logSuccess('Aggregator Service initialized');
    }

    async testAggregatorConnectivity() {
        for (const [name, config] of Object.entries(this.aggregatorConfigs)) {
            try {
                const response = await axios.get(`${config.baseUrl}/health`, {
                    timeout: 5000,
                    headers: config.headers
                }).catch(() => ({ status: 'unknown' }));
                
                Logger.logInfo(`Aggregator ${name}: ${response.status === 200 ? '✅ Healthy' : '⚠️ Limited'}`);
            } catch (error) {
                Logger.logWarning(`Aggregator ${name} connectivity test failed: ${error.message}`);
            }
        }
    }

    async getRoute(aggregator, fromToken, toToken, amount, options = {}) {
        const cacheKey = `route_${aggregator}_${fromToken}_${toToken}_${amount}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        try {
            const route = await this.rateLimiter.schedule(aggregator, async () => {
                switch (aggregator) {
                    case 'odos':
                        return this.getOdosRoute(fromToken, toToken, amount, options);
                    case 'oneInch':
                        return this.getOneInchRoute(fromToken, toToken, amount, options);
                    case 'cow':
                        return this.getCowRoute(fromToken, toToken, amount, options);
                    case 'aerodrome':
                    case 'pancakeswap':
                    case 'uniswap_v3':
                    case 'baseswap':
                        return this.getDirectDexRoute(aggregator, fromToken, toToken, amount, options);
                    default:
                        throw new Error(`Unsupported aggregator: ${aggregator}`);
                }
            });

            // Validate route response
            this.validateRouteResponse(route, aggregator);

            // Cache successful route
            this.cache.set(cacheKey, route, 5); // 5 second TTL for routes
            return route;

        } catch (error) {
            Logger.logError(`Failed to get route from ${aggregator}`, {
                fromToken,
                toToken,
                amount: amount.toString(),
                error: error.message
            });
            throw error;
        }
    }

    async getOdosRoute(fromToken, toToken, amount, options = {}) {
        try {
            const config = this.aggregatorConfigs.odos;
            const slippage = options.slippage || config.maxSlippage;
            const recipient = options.recipient || config.botWallet || process.env.BOT_WALLET_ADDRESS;

            const requestBody = {
                chainId: config.chainId,
                inputTokens: [{
                    tokenAddress: fromToken,
                    amount: amount.toString()
                }],
                outputTokens: [{
                    tokenAddress: toToken,
                    proportion: 1
                }],
                userAddr: recipient,
                slippageLimitPercent: slippage,
                disableRFQs: config.disableRFQs,
                referralCode: process.env.ODOS_REFERRAL_CODE || 0,
                compact: true
            };

            // Add source DEX preference if specified
            if (options.sourceDex) {
                requestBody.sourceDex = options.sourceDex;
            }

            const response = await axios.post(
                config.baseUrl + config.endpoints.quote,
                requestBody,
                {
                    headers: config.headers,
                    timeout: config.timeout
                }
            );

            // Parse response according to Odos API specification
            if (!response.data || !response.data.outAmounts || response.data.outAmounts.length === 0) {
                throw new Error('Invalid response from Odos API');
            }

            const gasEstimate = response.data.gasEstimate || 0;
            const path = this.parseOdosPath(response.data.path);

            // Get transaction data for assembly
            let transactionData = null;
            if (options.assemble) {
                transactionData = await this.assembleOdosTransaction(response.data.pathId);
            }

            return {
                aggregator: 'odos',
                returnAmount: BigInt(response.data.outAmounts[0]),
                path: path,
                gasEstimate: gasEstimate,
                priceImpact: response.data.priceImpact || 0,
                data: response.data,
                transactionData: transactionData,
                metadata: {
                    pathId: response.data.pathId,
                    assembled: !!transactionData,
                    timestamp: Date.now()
                }
            };

        } catch (error) {
            if (error.response) {
                Logger.logWarning('Odos API error', {
                    status: error.response.status,
                    data: error.response.data,
                    endpoint: 'quote'
                });
            }
            throw new Error(`Odos route failed: ${error.message}`);
        }
    }

    async assembleOdosTransaction(pathId) {
        try {
            const config = this.aggregatorConfigs.odos;
            
            const response = await axios.post(
                config.baseUrl + config.endpoints.assemble,
                {
                    pathId,
                    userAddr: process.env.BOT_WALLET_ADDRESS,
                    simulate: true,
                    disableRFQs: config.disableRFQs
                },
                {
                    headers: config.headers,
                    timeout: config.timeout
                }
            );

            if (!response.data || !response.data.transaction) {
                throw new Error('Invalid assembly response from Odos');
            }

            return {
                to: response.data.transaction.to,
                data: response.data.transaction.data,
                value: response.data.transaction.value || '0',
                gas: response.data.transaction.gas || 0,
                gasPrice: response.data.transaction.gasPrice || null
            };

        } catch (error) {
            Logger.logError('Odos transaction assembly failed', error.message);
            return null;
        }
    }

    parseOdosPath(pathData) {
        if (!pathData || !Array.isArray(pathData)) {
            return [];
        }

        const path = [];
        for (const step of pathData) {
            if (step.pool) {
                path.push({
                    type: 'swap',
                    pool: step.pool,
                    tokenIn: step.tokenIn,
                    tokenOut: step.tokenOut,
                    amountIn: step.amountIn,
                    amountOut: step.amountOut
                });
            }
        }

        return path;
    }

    async getOneInchRoute(fromToken, toToken, amount, options = {}) {
        try {
            const config = this.aggregatorConfigs.oneInch;
            const slippage = options.slippage || config.maxSlippage;
            const recipient = options.recipient || config.botWallet || process.env.BOT_WALLET_ADDRESS;

            // First get quote
            const quoteParams = {
                src: fromToken,
                dst: toToken,
                amount: amount.toString(),
                from: recipient,
                slippage: slippage,
                disableEstimate: false,
                allowPartialFill: false,
                protocols: config.protocols
            };

            const quoteResponse = await axios.get(
                config.baseUrl + config.endpoints.quote,
                {
                    params: quoteParams,
                    headers: config.headers,
                    timeout: config.timeout
                }
            );

            if (!quoteResponse.data || !quoteResponse.data.toAmount) {
                throw new Error('Invalid quote response from 1inch');
            }

            // Then get swap data
            const swapParams = {
                src: fromToken,
                dst: toToken,
                amount: amount.toString(),
                from: recipient,
                slippage: slippage,
                disableEstimate: true,
                allowPartialFill: false,
                protocols: config.protocols
            };

            const swapResponse = await axios.get(
                config.baseUrl + config.endpoints.swap,
                {
                    params: swapParams,
                    headers: config.headers,
                    timeout: config.timeout
                }
            );

            if (!swapResponse.data || !swapResponse.data.tx) {
                throw new Error('Invalid swap response from 1inch');
            }

            const gasEstimate = quoteResponse.data.estimatedGas || swapResponse.data.tx.gas || 0;
            const path = this.parseOneInchPath(swapResponse.data.protocols || []);

            return {
                aggregator: 'oneInch',
                returnAmount: BigInt(quoteResponse.data.toAmount),
                path: path,
                gasEstimate: gasEstimate,
                priceImpact: this.calculateOneInchPriceImpact(quoteResponse.data),
                data: swapResponse.data,
                transactionData: {
                    to: swapResponse.data.tx.to,
                    data: swapResponse.data.tx.data,
                    value: swapResponse.data.tx.value || '0',
                    gas: swapResponse.data.tx.gas || gasEstimate,
                    gasPrice: null // EIP-1559
                },
                metadata: {
                    protocols: swapResponse.data.protocols,
                    fromTokenAmount: quoteResponse.data.fromTokenAmount,
                    toTokenAmount: quoteResponse.data.toTokenAmount,
                    timestamp: Date.now()
                }
            };

        } catch (error) {
            if (error.response) {
                Logger.logWarning('1inch API error', {
                    status: error.response.status,
                    data: error.response.data,
                    endpoint: error.config.url
                });
            }
            throw new Error(`1inch route failed: ${error.message}`);
        }
    }

    parseOneInchPath(protocols) {
        if (!Array.isArray(protocols)) {
            return [];
        }

        const path = [];
        for (const protocol of protocols) {
            if (protocol.name && protocol.fromTokenAddress && protocol.toTokenAddress) {
                path.push({
                    dex: protocol.name,
                    fromToken: protocol.fromTokenAddress,
                    toToken: protocol.toTokenAddress,
                    part: protocol.part || 100
                });
            }
        }

        return path;
    }

    calculateOneInchPriceImpact(quoteData) {
        if (!quoteData || !quoteData.fromToken || !quoteData.toToken) {
            return 0;
        }

        try {
            const fromAmount = parseFloat(quoteData.fromTokenAmount) / Math.pow(10, quoteData.fromToken.decimals);
            const toAmount = parseFloat(quoteData.toTokenAmount) / Math.pow(10, quoteData.toToken.decimals);
            
            // Get market price from other sources (simplified)
            const marketPrice = 1; // This should come from price oracle
            const executionPrice = toAmount / fromAmount;
            
            return ((executionPrice - marketPrice) / marketPrice) * 100;
        } catch (error) {
            return 0;
        }
    }

    async getCowRoute(fromToken, toToken, amount, options = {}) {
        try {
            const config = this.aggregatorConfigs.cow;
            const slippage = options.slippage || config.maxSlippage;
            const recipient = options.recipient || config.botWallet || process.env.BOT_WALLET_ADDRESS;

            const validTo = this.validateCowToken(toToken);
            if (!validTo) {
                throw new Error(`Token ${toToken} not supported by CoW Swap`);
            }

            const quoteBody = {
                sellToken: fromToken,
                buyToken: toToken,
                receiver: recipient,
                appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
                partiallyFillable: config.partiallyFillable,
                from: recipient,
                priceQuality: 'optimal',
                signingScheme: config.signingScheme,
                sellAmountBeforeFee: amount.toString(),
                kind: 'sell'
            };

            const response = await axios.post(
                config.baseUrl + config.endpoints.quote,
                quoteBody,
                {
                    headers: config.headers,
                    timeout: config.timeout
                }
            );

            if (!response.data || !response.data.quote) {
                throw new Error('Invalid quote response from CoW Swap');
            }

            const quote = response.data.quote;
            const gasEstimate = quote.feeAmount || 0;

            return {
                aggregator: 'cow',
                returnAmount: BigInt(quote.buyAmount),
                path: [{ fromToken, toToken, dex: 'CoW Swap' }],
                gasEstimate: gasEstimate,
                priceImpact: this.calculateCowPriceImpact(quote),
                data: response.data,
                transactionData: {
                    to: quote.settlementContract,
                    data: quote.interactionData || '0x',
                    value: '0',
                    gas: quote.feeAmount,
                    validTo: quote.validTo,
                    appData: quote.appData
                },
                metadata: {
                    orderUid: response.data.orderUid,
                    validTo: quote.validTo,
                    feeAmount: quote.feeAmount,
                    timestamp: Date.now()
                }
            };

        } catch (error) {
            if (error.response) {
                Logger.logWarning('CoW Swap API error', {
                    status: error.response.status,
                    data: error.response.data,
                    endpoint: 'quote'
                });
            }
            throw new Error(`CoW Swap route failed: ${error.message}`);
        }
    }

    validateCowToken(tokenAddress) {
        // CoW Swap has specific token requirements (must be on their token list)
        // This is a simplified check
        const supportedTokens = [
            '0x4200000000000000000000000000000000000006', // WETH
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
            '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22'  // cbETH
        ];
        
        return supportedTokens.includes(tokenAddress.toLowerCase());
    }

    calculateCowPriceImpact(quote) {
        if (!quote || !quote.sellAmount || !quote.buyAmount) {
            return 0;
        }

        try {
            // CoW Swap uses batch auctions, price impact is different
            // Simplified calculation
            const sellValue = Number(quote.sellAmount) / 1e18;
            const buyValue = Number(quote.buyAmount) / 1e18;
            
            if (sellValue === 0) return 0;
            
            return ((buyValue - sellValue) / sellValue) * 100;
        } catch (error) {
            return 0;
        }
    }

    async getDirectDexRoute(dexName, fromToken, toToken, amount, options = {}) {
        try {
            const dexConfig = this.directDexes[dexName];
            if (!dexConfig) {
                throw new Error(`Unsupported DEX: ${dexName}`);
            }

            const { provider } = await RPCManager.getHealthyProvider();
            
            // Get best pool for the pair
            const pool = await this.findBestPool(dexName, fromToken, toToken, amount);
            if (!pool) {
                throw new Error(`No pool found for ${fromToken} -> ${toToken} on ${dexName}`);
            }

            // Get quote from router
            const routerABI = [
                'function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint[] memory amounts)',
                'function getAmountsIn(uint256 amountOut, address[] memory path) view returns (uint[] memory amounts)'
            ];

            const router = new ethers.Contract(dexConfig.router, routerABI, provider);
            const path = [fromToken, toToken];
            
            const amounts = await router.getAmountsOut(amount, path);
            if (!amounts || amounts.length < 2) {
                throw new Error('Invalid quote from DEX router');
            }

            const returnAmount = amounts[1];
            
            // Estimate gas
            const gasEstimate = await this.estimateDexSwapGas(
                dexName,
                fromToken,
                toToken,
                amount,
                returnAmount
            );

            // Calculate price impact
            const priceImpact = await this.calculateDexPriceImpact(
                dexName,
                fromToken,
                toToken,
                amount,
                returnAmount,
                pool
            );

            return {
                aggregator: dexName.toLowerCase(),
                returnAmount: returnAmount,
                path: [{
                    fromToken,
                    toToken,
                    dex: dexName,
                    pool: pool.address,
                    fee: pool.fee
                }],
                gasEstimate: gasEstimate,
                priceImpact: priceImpact,
                data: {
                    router: dexConfig.router,
                    path,
                    amounts: amounts.map(a => a.toString())
                },
                transactionData: {
                    to: dexConfig.router,
                    data: this.encodeDexSwap(dexName, fromToken, toToken, amount, returnAmount, options),
                    value: fromToken === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' ? amount : '0',
                    gas: gasEstimate
                },
                metadata: {
                    dex: dexName,
                    pool: pool.address,
                    fee: pool.fee,
                    liquidity: pool.liquidity,
                    timestamp: Date.now()
                }
            };

        } catch (error) {
            Logger.logError(`Direct DEX route failed for ${dexName}`, error.message);
            throw error;
        }
    }

    async findBestPool(dexName, fromToken, toToken, amount) {
        const dexConfig = this.directDexes[dexName];
        const { provider } = await RPCManager.getHealthyProvider();

        for (const fee of dexConfig.feeTiers) {
            try {
                const factoryABI = [
                    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
                ];

                const factory = new ethers.Contract(dexConfig.factory, factoryABI, provider);
                const poolAddress = await factory.getPool(fromToken, toToken, fee);

                if (poolAddress !== ethers.ZeroAddress) {
                    // Check pool liquidity
                    const poolABI = [
                        'function liquidity() view returns (uint128)',
                        'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
                    ];

                    const pool = new ethers.Contract(poolAddress, poolABI, provider);
                    const [liquidity, slot0] = await Promise.all([
                        pool.liquidity(),
                        pool.slot0()
                    ]);

                    if (liquidity > 0n) {
                        return {
                            address: poolAddress,
                            fee: fee,
                            liquidity: liquidity,
                            sqrtPriceX96: slot0.sqrtPriceX96,
                            tick: slot0.tick
                        };
                    }
                }
            } catch (error) {
                continue;
            }
        }

        return null;
    }

    async estimateDexSwapGas(dexName, fromToken, toToken, amountIn, amountOut) {
        const gasEstimates = {
            'Aerodrome': 180000n,
            'PancakeSwap': 160000n,
            'Uniswap V3': 200000n,
            'Baseswap': 170000n
        };

        return gasEstimates[dexName] || 200000n;
    }

    async calculateDexPriceImpact(dexName, fromToken, toToken, amountIn, amountOut, pool) {
        try {
            // Simplified price impact calculation
            // Real implementation would use pool reserves and bonding curves
            
            const amountInNum = Number(amountIn);
            const amountOutNum = Number(amountOut);
            
            if (amountInNum === 0) return 0;
            
            // This is a placeholder - real calculation requires pool math
            const impact = (amountOutNum - amountInNum) / amountInNum * 100;
            return Math.max(impact, -100); // Cap at -100%
            
        } catch (error) {
            return 0;
        }
    }

    encodeDexSwap(dexName, fromToken, toToken, amountIn, amountOutMin, options = {}) {
        const routerABI = [
            'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint[] memory amounts)',
            'function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) payable returns (uint[] memory amounts)',
            'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) returns (uint[] memory amounts)'
        ];

        const iface = new ethers.Interface(routerABI);
        const path = [fromToken, toToken];
        const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
        const recipient = options.recipient || process.env.BOT_WALLET_ADDRESS;

        // Handle ETH wrapping
        const isETH = fromToken === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
        const toETH = toToken === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

        if (isETH) {
            return iface.encodeFunctionData('swapExactETHForTokens', [
                amountOutMin,
                path,
                recipient,
                deadline
            ]);
        } else if (toETH) {
            return iface.encodeFunctionData('swapExactTokensForETH', [
                amountIn,
                amountOutMin,
                path,
                recipient,
                deadline
            ]);
        } else {
            return iface.encodeFunctionData('swapExactTokensForTokens', [
                amountIn,
                amountOutMin,
                path,
                recipient,
                deadline
            ]);
        }
    }

    validateRouteResponse(route, aggregator) {
        if (!route) {
            throw new Error(`Empty response from ${aggregator}`);
        }

        if (!route.returnAmount || route.returnAmount <= 0n) {
            throw new Error(`Invalid return amount from ${aggregator}: ${route.returnAmount}`);
        }

        if (!route.path || !Array.isArray(route.path) || route.path.length === 0) {
            throw new Error(`Invalid path from ${aggregator}`);
        }

        // Check for minimum output (prevent zero-value trades)
        const minReturn = BigInt(100); // Minimum 100 wei
        if (route.returnAmount < minReturn) {
            throw new Error(`Return amount too small from ${aggregator}: ${route.returnAmount}`);
        }

        return true;
    }

    async getBestRoute(fromToken, toToken, amount, options = {}) {
        const aggregators = config.aggregatorPriority || ['odos', 'oneInch', 'cow'];
        const routes = [];
        const errors = [];

        for (const aggregator of aggregators) {
            try {
                const route = await this.getRoute(aggregator, fromToken, toToken, amount, options);
                if (route && route.returnAmount > 0n) {
                    routes.push(route);
                }
            } catch (error) {
                errors.push({ aggregator, error: error.message });
                continue;
            }
        }

        if (routes.length === 0) {
            Logger.logWarning('No routes found from any aggregator', { errors });
            return null;
        }

        // Sort by return amount (highest first)
        routes.sort((a, b) => {
            if (b.returnAmount > a.returnAmount) return 1;
            if (b.returnAmount < a.returnAmount) return -1;
            return 0;
        });

        const bestRoute = routes[0];
        
        // Log route comparison
        Logger.logInfo('Route comparison:', {
            best: bestRoute.aggregator,
            returnAmount: bestRoute.returnAmount.toString(),
            priceImpact: bestRoute.priceImpact,
            alternatives: routes.slice(1).map(r => ({
                aggregator: r.aggregator,
                returnAmount: r.returnAmount.toString(),
                difference: ((Number(bestRoute.returnAmount - r.returnAmount) / Number(bestRoute.returnAmount)) * 100).toFixed(4) + '%'
            }))
        });

        return bestRoute;
    }

    async getPriceComparison(tokenAddress, amount = ethers.parseUnits('1', 18)) {
        const comparisons = {};
        const baseToken = config.baseTokens[0];

        for (const [dex, config] of Object.entries(this.directDexes)) {
            try {
                const route = await this.getDirectDexRoute(dex, baseToken, tokenAddress, amount, {
                    recipient: ethers.ZeroAddress // Just for quote
                });
                
                if (route && route.returnAmount > 0n) {
                    comparisons[dex] = {
                        price: Number(route.returnAmount) / 1e18,
                        liquidity: route.metadata?.liquidity || 0n,
                        fee: route.metadata?.fee || 0
                    };
                }
            } catch (error) {
                // Silent fail for price comparisons
                continue;
            }
        }

        return comparisons;
    }

    getAggregatorStats() {
        const stats = {};
        
        for (const [name, config] of Object.entries(this.aggregatorConfigs)) {
            const cacheKeys = this.cache.keys().filter(k => k.startsWith(`route_${name}_`));
            stats[name] = {
                cacheEntries: cacheKeys.length,
                configured: true,
                hasApiKey: !!process.env[`${name.toUpperCase()}_API_KEY`],
                baseUrl: config.baseUrl
            };
        }

        return stats;
    }

    clearCache() {
        this.cache.flushAll();
        Logger.logInfo('Aggregator cache cleared');
    }
}

module.exports = AggregatorService;
