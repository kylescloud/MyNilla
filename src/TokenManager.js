const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const axios = require('axios');
const config = require('../config/config.json');
const RPCManager = require('./rpcManager');
const RateLimiter = require('./rateLimiter');
const { Logger } = require('./utils');

class TokenManager {
    constructor() {
        this.tokens = new Map();
        this.tokenMetadata = new Map();
        this.pools = new Map();
        this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
        this.scamCheckCache = new NodeCache({ stdTTL: 3600 });
        this.initialized = false;
        
        this.initializeBaseTokens();
    }

    async initialize() {
        if (this.initialized) return;
        
        Logger.logInfo('Initializing Token Manager...');
        
        await this.loadTokenList();
        await this.discoverNewTokens();
        await this.updateTokenMetadata();
        
        this.startAutoDiscovery();
        this.initialized = true;
        
        Logger.logSuccess(`Token Manager initialized with ${this.tokens.size} tokens`);
    }

    initializeBaseTokens() {
        const baseTokens = [
            {
                address: '0x4200000000000000000000000000000000000006',
                symbol: 'WETH',
                name: 'Wrapped Ether',
                decimals: 18,
                isStable: false,
                isBase: true
            },
            {
                address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                symbol: 'USDC',
                name: 'USD Coin',
                decimals: 6,
                isStable: true,
                isBase: true
            },
            {
                address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
                symbol: 'cbETH',
                name: 'Coinbase Wrapped Staked ETH',
                decimals: 18,
                isStable: false,
                isBase: true
            }
        ];
        
        baseTokens.forEach(token => {
            this.tokens.set(token.address.toLowerCase(), token);
        });
    }

    async loadTokenList() {
        try {
            const cacheKey = 'token_list';
            const cached = this.cache.get(cacheKey);
            if (cached) {
                cached.forEach(token => {
                    if (!this.tokens.has(token.address.toLowerCase())) {
                        this.tokens.set(token.address.toLowerCase(), token);
                    }
                });
                return;
            }
            
            const sources = [
                this.loadCoinGeckoTokens(),
                this.loadDexScreenerTopTokens(),
                this.loadAerodromeTokens()
            ];
            
            const results = await Promise.allSettled(sources);
            
            const allTokens = new Map();
            
            results.forEach(result => {
                if (result.status === 'fulfilled') {
                    result.value.forEach(token => {
                        const key = token.address.toLowerCase();
                        if (!allTokens.has(key)) {
                            allTokens.set(key, token);
                        }
                    });
                }
            });
            
            const filteredTokens = await this.filterScamTokens(Array.from(allTokens.values()));
            
            filteredTokens.forEach(token => {
                if (!this.tokens.has(token.address.toLowerCase())) {
                    this.tokens.set(token.address.toLowerCase(), token);
                }
            });
            
            this.cache.set(cacheKey, filteredTokens);
            
            Logger.logInfo(`Loaded ${filteredTokens.length} tokens from external sources`);
        } catch (error) {
            Logger.logError('Failed to load token list', error);
        }
    }

    async loadCoinGeckoTokens() {
        try {
            const response = await axios.get(
                'https://api.coingecko.com/api/v3/coins/markets',
                {
                    params: {
                        vs_currency: 'usd',
                        order: 'market_cap_desc',
                        per_page: 100,
                        page: 1
                    },
                    timeout: 10000
                }
            );
            
            return response.data
                .filter(token => token.platforms && token.platforms['base'])
                .map(token => ({
                    address: token.platforms['base'].toLowerCase(),
                    symbol: token.symbol.toUpperCase(),
                    name: token.name,
                    decimals: 18,
                    isStable: false,
                    isBase: false,
                    coingeckoId: token.id,
                    marketCap: token.market_cap
                }));
        } catch (error) {
            return [];
        }
    }

    async loadDexScreenerTopTokens() {
        try {
            const response = await RateLimiter.schedule('dexScreener', () =>
                axios.get('https://api.dexscreener.com/latest/dex/tokens/8453', {
                    params: {
                        limit: 200,
                        sort: 'liquidity',
                        order: 'desc'
                    },
                    timeout: 10000
                })
            );
            
            const tokens = [];
            const seen = new Set();
            
            response.data.pairs.forEach(pair => {
                if (pair.chainId !== 'base') return;
                
                [pair.baseToken, pair.quoteToken].forEach(token => {
                    const address = token.address.toLowerCase();
                    
                    if (!seen.has(address) && token.address) {
                        seen.add(address);
                        
                        tokens.push({
                            address: address,
                            symbol: token.symbol,
                            name: token.name || token.symbol,
                            decimals: token.decimals || 18,
                            isStable: this.isStableToken(token.symbol),
                            isBase: false,
                            liquidityUSD: pair.liquidity ? pair.liquidity.usd : 0,
                            volume24hUSD: pair.volume ? pair.volume.h24 : 0,
                            dexScreenerData: {
                                pairAddress: pair.pairAddress,
                                dexId: pair.dexId
                            }
                        });
                    }
                });
            });
            
            return tokens;
        } catch (error) {
            Logger.logWarning('Failed to load DexScreener tokens', error.message);
            return [];
        }
    }

    async loadAerodromeTokens() {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const aerodromeFactory = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
            const factoryABI = [
                'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
                'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
            ];
            
            const factory = new ethers.Contract(aerodromeFactory, factoryABI, provider);
            
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = currentBlock - 100000;
            
            const filter = factory.filters.PoolCreated();
            const events = await factory.queryFilter(filter, fromBlock, currentBlock);
            
            const tokens = new Map();
            
            for (const event of events) {
                const token0 = event.args.token0.toLowerCase();
                const token1 = event.args.token1.toLowerCase();
                
                if (!tokens.has(token0) && token0 !== ethers.ZeroAddress) {
                    tokens.set(token0, {
                        address: token0,
                        symbol: await this.getTokenSymbol(token0),
                        name: '',
                        decimals: await this.getTokenDecimals(token0),
                        isStable: false,
                        isBase: false,
                        source: 'aerodrome'
                    });
                }
                
                if (!tokens.has(token1) && token1 !== ethers.ZeroAddress) {
                    tokens.set(token1, {
                        address: token1,
                        symbol: await this.getTokenSymbol(token1),
                        name: '',
                        decimals: await this.getTokenDecimals(token1),
                        isStable: false,
                        isBase: false,
                        source: 'aerodrome'
                    });
                }
            }
            
            return Array.from(tokens.values());
        } catch (error) {
            Logger.logWarning('Failed to load Aerodrome tokens', error.message);
            return [];
        }
    }

    isStableToken(symbol) {
        const stableSymbols = ['USDC', 'USDT', 'DAI', 'USDCE', 'USDC.E', 'MAI', 'FRAX', 'LUSD'];
        return stableSymbols.includes(symbol.toUpperCase());
    }

    async getTokenSymbol(address) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const tokenABI = ['function symbol() view returns (string)'];
            const token = new ethers.Contract(address, tokenABI, provider);
            return await token.symbol();
        } catch (error) {
            return 'UNKNOWN';
        }
    }

    async getTokenDecimals(address) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const tokenABI = ['function decimals() view returns (uint8)'];
            const token = new ethers.Contract(address, tokenABI, provider);
            return await token.decimals();
        } catch (error) {
            return 18;
        }
    }

    async discoverNewTokens() {
        Logger.logInfo('Discovering new tokens...');
        
        try {
            const newTokens = await this.scanRecentBlocks();
            
            const filteredTokens = await this.filterScamTokens(newTokens);
            
            let addedCount = 0;
            filteredTokens.forEach(token => {
                const key = token.address.toLowerCase();
                if (!this.tokens.has(key) && this.validateToken(token)) {
                    this.tokens.set(key, token);
                    addedCount++;
                    
                    Logger.logInfo(`Discovered new token: ${token.symbol} (${token.address.substring(0, 10)}...)`);
                }
            });
            
            if (addedCount > 0) {
                Logger.logSuccess(`Discovered ${addedCount} new tokens`);
                await this.updateTokenMetadata();
            }
        } catch (error) {
            Logger.logError('Token discovery failed', error);
        }
    }

    async scanRecentBlocks(blocks = 100) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - blocks);
            
            const topics = [
                ethers.id('Transfer(address,address,uint256)'),
                ethers.id('PairCreated(address,address,address,uint256)'),
                ethers.id('Mint(address,uint256,uint256)')
            ];
            
            const logs = await provider.getLogs({
                fromBlock,
                toBlock: currentBlock,
                topics: [topics]
            });
            
            const tokenAddresses = new Set();
            
            logs.forEach(log => {
                if (log.topics[0] === topics[0]) {
                    const tokenAddress = log.address.toLowerCase();
                    tokenAddresses.add(tokenAddress);
                }
            });
            
            const tokens = [];
            
            for (const address of tokenAddresses) {
                if (this.tokens.has(address)) continue;
                
                try {
                    const token = await this.fetchTokenDetails(address);
                    if (token) {
                        tokens.push(token);
                    }
                } catch (error) {
                    continue;
                }
                
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            return tokens;
        } catch (error) {
            Logger.logWarning('Block scanning failed', error.message);
            return [];
        }
    }

    async fetchTokenDetails(address) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const tokenABI = [
                'function symbol() view returns (string)',
                'function name() view returns (string)',
                'function decimals() view returns (uint8)',
                'function totalSupply() view returns (uint256)'
            ];
            
            const token = new ethers.Contract(address, tokenABI, provider);
            
            const [symbol, name, decimals, totalSupply] = await Promise.all([
                token.symbol().catch(() => 'UNKNOWN'),
                token.name().catch(() => ''),
                token.decimals().catch(() => 18),
                token.totalSupply().catch(() => 0n)
            ]);
            
            const liquidity = await this.estimateLiquidity(address);
            
            return {
                address: address.toLowerCase(),
                symbol: symbol,
                name: name,
                decimals: decimals,
                totalSupply: totalSupply.toString(),
                liquidityUSD: liquidity,
                isStable: this.isStableToken(symbol),
                isBase: false,
                discoveredAt: Date.now()
            };
        } catch (error) {
            return null;
        }
    }

    async estimateLiquidity(tokenAddress) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const aerodromeFactory = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
            const factoryABI = [
                'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'
            ];
            
            const factory = new ethers.Contract(aerodromeFactory, factoryABI, provider);
            
            const baseTokens = config.baseTokens;
            let totalLiquidity = 0;
            
            for (const baseToken of baseTokens) {
                try {
                    const poolAddress = await factory.getPool(tokenAddress, baseToken, 100);
                    if (poolAddress === ethers.ZeroAddress) continue;
                    
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
                        const sqrtPriceX96 = slot0.sqrtPriceX96;
                        const price = (Number(sqrtPriceX96) ** 2) / (2 ** 192);
                        
                        const tokenValue = Number(liquidity) * price;
                        totalLiquidity += tokenValue * 2;
                    }
                } catch (error) {
                    continue;
                }
            }
            
            return totalLiquidity;
        } catch (error) {
            return 0;
        }
    }

    async filterScamTokens(tokens) {
        const filtered = [];
        
        for (const token of tokens) {
            const isScam = await this.checkIfScamToken(token);
            if (!isScam) {
                filtered.push(token);
            }
        }
        
        return filtered;
    }

    async checkIfScamToken(token) {
        const cacheKey = `scam_check_${token.address}`;
        const cached = this.scamCheckCache.get(cacheKey);
        if (cached !== undefined) return cached;
        
        const checks = [
            this.checkHoneypot(token),
            this.checkBlacklist(token),
            this.checkSuspiciousSymbol(token),
            this.checkLowLiquidity(token),
            this.checkRecentCreation(token)
        ];
        
        const results = await Promise.allSettled(checks);
        
        let isScam = false;
        let reasons = [];
        
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value.isScam) {
                isScam = true;
                reasons.push(result.value.reason);
            }
        });
        
        if (reasons.length > 0) {
            Logger.logWarning(`Token ${token.symbol} (${token.address.substring(0, 10)}...) flagged: ${reasons.join(', ')}`);
        }
        
        this.scamCheckCache.set(cacheKey, isScam);
        return isScam;
    }

    async checkHoneypot(token) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const tokenABI = [
                'function balanceOf(address) view returns (uint256)',
                'function approve(address, uint256) returns (bool)'
            ];
            
            const tokenContract = new ethers.Contract(token.address, tokenABI, provider);
            
            const testWallet = '0x000000000000000000000000000000000000dEaD';
            const balance = await tokenContract.balanceOf(testWallet);
            
            if (balance > 0n) {
                return { isScam: false, reason: '' };
            }
            
            const testAmount = ethers.parseUnits('1', token.decimals);
            
            try {
                const estimate = await provider.estimateGas({
                    to: token.address,
                    data: tokenContract.interface.encodeFunctionData('approve', [testWallet, testAmount])
                });
                
                if (estimate > 100000n) {
                    return { isScam: true, reason: 'High gas for approve (possible honeypot)' };
                }
            } catch (error) {
                return { isScam: true, reason: 'Approve function suspicious' };
            }
            
            return { isScam: false, reason: '' };
        } catch (error) {
            return { isScam: false, reason: '' };
        }
    }

    async checkBlacklist(token) {
        try {
            const response = await axios.get(
                `https://api.gopluslabs.io/api/v1/token_security/8453`,
                {
                    params: { contract_addresses: token.address },
                    timeout: 5000
                }
            );
            
            const data = response.data.result[token.address.toLowerCase()];
            if (data) {
                if (data.is_honeypot === '1' || data.is_open_source === '0') {
                    return { isScam: true, reason: 'Blacklisted by GoPlus' };
                }
            }
            
            return { isScam: false, reason: '' };
        } catch (error) {
            return { isScam: false, reason: '' };
        }
    }

    checkSuspiciousSymbol(token) {
        const suspiciousPatterns = [
            /test/i,
            /fake/i,
            /scam/i,
            /honeypot/i,
            /v2/i,
            /v3/i,
            /upgrade/i,
            /migrate/i,
            /airdrop/i
        ];
        
        for (const pattern of suspiciousPatterns) {
            if (pattern.test(token.symbol) || pattern.test(token.name)) {
                return { isScam: true, reason: 'Suspicious name/symbol' };
            }
        }
        
        if (token.symbol.length > 20) {
            return { isScam: true, reason: 'Unusually long symbol' };
        }
        
        return { isScam: false, reason: '' };
    }

    checkLowLiquidity(token) {
        if (token.liquidityUSD < 10000 && token.totalSupply > 1000000) {
            return { isScam: true, reason: 'Low liquidity relative to supply' };
        }
        return { isScam: false, reason: '' };
    }

    checkRecentCreation(token) {
        const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        if (token.discoveredAt && token.discoveredAt > oneWeekAgo) {
            return { isScam: false, reason: '' };
        }
        return { isScam: false, reason: '' };
    }

    validateToken(token) {
        if (!token.address || token.address.length !== 42) return false;
        if (!token.symbol || token.symbol.length === 0) return false;
        if (token.decimals < 0 || token.decimals > 36) return false;
        if (token.liquidityUSD < 1000) return false;
        
        return true;
    }

    async updateTokenMetadata() {
        Logger.logInfo('Updating token metadata...');
        
        const tokens = Array.from(this.tokens.values());
        const batchSize = 10;
        
        for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);
            
            await Promise.allSettled(
                batch.map(token => this.updateSingleTokenMetadata(token))
            );
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        Logger.logSuccess('Token metadata updated');
    }

    async updateSingleTokenMetadata(token) {
        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            const currentPrice = await this.getTokenPrice(token.address);
            const liquidity = await this.estimateLiquidity(token.address);
            
            if (currentPrice !== null) {
                token.priceUSD = currentPrice;
                token.priceUpdatedAt = Date.now();
            }
            
            if (liquidity > 0) {
                token.liquidityUSD = liquidity;
            }
            
            this.tokens.set(token.address.toLowerCase(), token);
        } catch (error) {
            // Silently fail for individual tokens
        }
    }

    async getTokenPrice(tokenAddress) {
        const cacheKey = `price_${tokenAddress}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
        
        try {
            if (tokenAddress === config.baseTokens[0]) return 1;
            
            const { provider } = await RPCManager.getHealthyProvider();
            
            const aerodromeQuoter = '0x7AFdD9d22F966638bD6cC3702E5eB8800e60cA52';
            const quoterABI = [
                'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
            ];
            
            const quoter = new ethers.Contract(aerodromeQuoter, quoterABI, provider);
            const amountIn = ethers.parseUnits('1', 18);
            
            const result = await quoter.quoteExactInputSingle(
                config.baseTokens[0],
                tokenAddress,
                100,
                amountIn,
                0
            );
            
            const price = Number(ethers.formatUnits(result.amountOut, 18));
            
            this.cache.set(cacheKey, price, 30);
            return price;
        } catch (error) {
            try {
                const response = await RateLimiter.schedule('dexScreener', () =>
                    axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
                        timeout: 5000
                    })
                );
                
                if (response.data.pairs && response.data.pairs.length > 0) {
                    const pair = response.data.pairs[0];
                    if (pair.priceUsd) {
                        const price = parseFloat(pair.priceUsd);
                        this.cache.set(cacheKey, price, 30);
                        return price;
                    }
                }
            } catch (error2) {
                return null;
            }
            
            return null;
        }
    }

    startAutoDiscovery() {
        setInterval(async () => {
            try {
                await this.discoverNewTokens();
            } catch (error) {
                Logger.logWarning('Auto-discovery failed', error.message);
            }
        }, 300000);
        
        setInterval(async () => {
            try {
                await this.updateTokenMetadata();
            } catch (error) {
                Logger.logWarning('Metadata update failed', error.message);
            }
        }, 60000);
    }

    getAllTokens() {
        return Array.from(this.tokens.values());
    }

    getActiveTokens() {
        return this.getAllTokens().filter(token => 
            token.liquidityUSD >= 10000 && 
            token.priceUSD > 0 &&
            !token.isStable
        );
    }

    getTokenByAddress(address) {
        return this.tokens.get(address.toLowerCase());
    }

    getTokenSymbol(address) {
        const token = this.getTokenByAddress(address);
        return token ? token.symbol : 'UNKNOWN';
    }

    getTokenDecimalsByAddress(address) {
        const token = this.getTokenByAddress(address);
        return token ? token.decimals : 18;
    }

    async getTokenPriceWithFallback(address) {
        const token = this.getTokenByAddress(address);
        if (token && token.priceUSD) {
            return token.priceUSD;
        }
        
        const price = await this.getTokenPrice(address);
        if (price !== null && token) {
            token.priceUSD = price;
            this.tokens.set(address.toLowerCase(), token);
        }
        
        return price;
    }

    getTokenStats() {
        const tokens = this.getAllTokens();
        
        return {
            totalTokens: tokens.length,
            activeTokens: this.getActiveTokens().length,
            baseTokens: tokens.filter(t => t.isBase).length,
            stableTokens: tokens.filter(t => t.isStable).length,
            totalLiquidityUSD: tokens.reduce((sum, t) => sum + (t.liquidityUSD || 0), 0),
            avgPrice: tokens.filter(t => t.priceUSD).reduce((sum, t) => sum + t.priceUSD, 0) / 
                     tokens.filter(t => t.priceUSD).length
        };
    }
}

module.exports = TokenManager;
