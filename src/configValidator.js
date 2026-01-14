const { ethers } = require('ethers');
const config = require('../config/config.json');
const RPCManager = require('./rpcManager');
const { Logger } = require('./utils');

class ConfigValidator {
    constructor() {
        this.errors = [];
        this.warnings = [];
    }

    async validateFullConfig() {
        Logger.logInfo('Starting configuration validation...');
        
        await this.validateRPCConfig();
        await this.validateWalletConfig();
        await this.validateContractConfig();
        await this.validateTokenConfig();
        await this.validateAggregatorConfig();
        await this.validateGasConfig();
        await this.validateRateLimitConfig();
        
        this.printValidationResults();
        
        return {
            isValid: this.errors.length === 0,
            errors: this.errors,
            warnings: this.warnings
        };
    }

    async validateRPCConfig() {
        Logger.logInfo('Validating RPC configuration...');
        
        if (!config.rpcNodes || config.rpcNodes.length === 0) {
            this.errors.push('No RPC nodes configured');
            return;
        }

        if (config.rpcNodes.length < 3) {
            this.warnings.push('Fewer than 3 RPC nodes configured - recommend at least 3 for redundancy');
        }

        for (const [index, url] of config.rpcNodes.entries()) {
            try {
                const provider = new ethers.JsonRpcProvider(url, config.chainId, {
                    staticNetwork: true,
                    batchMaxCount: 1
                });

                const network = await provider.getNetwork();
                if (network.chainId !== BigInt(config.chainId)) {
                    this.errors.push(`RPC ${url} returned chain ID ${network.chainId}, expected ${config.chainId}`);
                }

                const blockNumber = await provider.getBlockNumber();
                if (blockNumber < 1) {
                    this.warnings.push(`RPC ${url} returned invalid block number: ${blockNumber}`);
                }

                const latency = await this.measureLatency(provider);
                if (latency > 5000) {
                    this.warnings.push(`RPC ${url} has high latency: ${latency}ms`);
                }

                Logger.logInfo(`RPC ${url}: Chain ID ${network.chainId}, Block ${blockNumber}, Latency ${latency}ms`);
            } catch (error) {
                this.errors.push(`RPC ${url} failed: ${error.message}`);
            }
        }

        if (!config.rpcSettings) {
            this.errors.push('Missing rpcSettings configuration');
        } else {
            if (config.rpcSettings.maxRequestsPerSecond > 20) {
                this.warnings.push('High RPC rate limit may lead to bans from public nodes');
            }
        }
    }

    async measureLatency(provider) {
        const start = Date.now();
        try {
            await provider.getBlockNumber();
            return Date.now() - start;
        } catch (error) {
            return Infinity;
        }
    }

    async validateWalletConfig() {
        Logger.logInfo('Validating wallet configuration...');
        
        if (!process.env.PRIVATE_KEY) {
            this.errors.push('PRIVATE_KEY environment variable not set');
            return;
        }

        try {
            const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
            
            if (!ethers.isHexString(process.env.PRIVATE_KEY, 32)) {
                this.errors.push('PRIVATE_KEY is not a valid 32-byte hex string');
            }

            Logger.logInfo(`Wallet address: ${wallet.address}`);
            
            const { provider } = await RPCManager.getHealthyProvider();
            const balance = await provider.getBalance(wallet.address);
            const balanceETH = ethers.formatEther(balance);
            
            Logger.logInfo(`Wallet balance: ${balanceETH} ETH`);
            
            if (balance < ethers.parseEther('0.01')) {
                this.warnings.push(`Low wallet balance: ${balanceETH} ETH. Need at least 0.01 ETH for gas`);
            }

            const nonce = await provider.getTransactionCount(wallet.address);
            Logger.logInfo(`Wallet nonce: ${nonce}`);
            
        } catch (error) {
            this.errors.push(`Wallet validation failed: ${error.message}`);
        }
    }

    async validateContractConfig() {
        Logger.logInfo('Validating contract configuration...');
        
        if (!process.env.ARB_CONTRACT_ADDRESS) {
            this.errors.push('ARB_CONTRACT_ADDRESS environment variable not set');
            return;
        }

        try {
            const { provider } = await RPCManager.getHealthyProvider();
            
            if (!ethers.isAddress(process.env.ARB_CONTRACT_ADDRESS)) {
                this.errors.push(`Invalid contract address: ${process.env.ARB_CONTRACT_ADDRESS}`);
                return;
            }

            const code = await provider.getCode(process.env.ARB_CONTRACT_ADDRESS);
            
            if (code === '0x') {
                this.errors.push(`No contract deployed at ${process.env.ARB_CONTRACT_ADDRESS}`);
                return;
            }

            Logger.logInfo(`Contract verified at ${process.env.ARB_CONTRACT_ADDRESS}, code size: ${code.length} bytes`);
            
            const arbContract = new ethers.Contract(
                process.env.ARB_CONTRACT_ADDRESS,
                ['function owner() view returns (address)'],
                provider
            );

            try {
                const owner = await arbContract.owner();
                const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
                
                if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
                    this.errors.push(`Contract owner (${owner}) does not match wallet address (${wallet.address})`);
                } else {
                    Logger.logInfo(`Contract ownership verified`);
                }
            } catch (error) {
                this.warnings.push(`Could not verify contract ownership: ${error.message}`);
            }
        } catch (error) {
            this.errors.push(`Contract validation failed: ${error.message}`);
        }
    }

    async validateTokenConfig() {
        Logger.logInfo('Validating token configuration...');
        
        if (!config.baseTokens || config.baseTokens.length === 0) {
            this.errors.push('No base tokens configured');
            return;
        }

        for (const tokenAddress of config.baseTokens) {
            try {
                if (!ethers.isAddress(tokenAddress)) {
                    this.errors.push(`Invalid token address: ${tokenAddress}`);
                    continue;
                }

                const { provider } = await RPCManager.getHealthyProvider();
                
                const tokenABI = [
                    'function symbol() view returns (string)',
                    'function decimals() view returns (uint8)',
                    'function balanceOf(address) view returns (uint256)'
                ];
                
                const token = new ethers.Contract(tokenAddress, tokenABI, provider);
                
                const [symbol, decimals] = await Promise.all([
                    token.symbol(),
                    token.decimals()
                ]);
                
                Logger.logInfo(`Token ${symbol}: ${tokenAddress}, decimals: ${decimals}`);
                
            } catch (error) {
                this.errors.push(`Token ${tokenAddress} validation failed: ${error.message}`);
            }
        }

        if (!config.monitoredDexes || config.monitoredDexes.length === 0) {
            this.warnings.push('No DEXes configured for monitoring');
        }
    }

    async validateAggregatorConfig() {
        Logger.logInfo('Validating aggregator configuration...');
        
        if (!config.aggregatorPriority || config.aggregatorPriority.length === 0) {
            this.errors.push('No aggregators configured');
            return;
        }

        const validAggregators = ['odos', 'oneInch', 'cow'];
        
        for (const aggregator of config.aggregatorPriority) {
            if (!validAggregators.includes(aggregator)) {
                this.errors.push(`Invalid aggregator: ${aggregator}`);
            }
        }

        if (config.apiRateLimits) {
            for (const [aggregator, limits] of Object.entries(config.apiRateLimits)) {
                if (limits.requestsPerMinute <= 0) {
                    this.errors.push(`Invalid rate limit for ${aggregator}: ${limits.requestsPerMinute}`);
                }
            }
        } else {
            this.warnings.push('No API rate limits configured');
        }
    }

    async validateGasConfig() {
        Logger.logInfo('Validating gas configuration...');
        
        if (!config.maxGasPriceGwei || config.maxGasPriceGwei <= 0) {
            this.errors.push('Invalid maxGasPriceGwei configuration');
        }

        if (config.maxGasPriceGwei > 100) {
            this.warnings.push(`High max gas price: ${config.maxGasPriceGwei} Gwei`);
        }

        if (!config.minProfitThresholdUSD || config.minProfitThresholdUSD <= 0) {
            this.errors.push('Invalid minProfitThresholdUSD configuration');
        }

        if (config.minProfitThresholdUSD < 5) {
            this.warnings.push(`Low profit threshold: $${config.minProfitThresholdUSD} - may lead to unprofitable trades after gas`);
        }

        if (!config.flashLoanPremiumBps) {
            this.warnings.push('flashLoanPremiumBps not configured, using default 9 (0.09%)');
        } else if (config.flashLoanPremiumBps > 50) {
            this.warnings.push(`High flash loan premium: ${config.flashLoanPremiumBps} bps (${config.flashLoanPremiumBps/100}%)`);
        }
    }

    async validateRateLimitConfig() {
        Logger.logInfo('Validating rate limit configuration...');
        
        if (!config.rpcSettings) {
            this.errors.push('Missing rpcSettings configuration');
            return;
        }

        const requiredSettings = [
            'maxRequestsPerSecond',
            'maxRequestsPerMinute',
            'requestTimeoutMs',
            'healthCheckIntervalMs',
            'unhealthyTimeoutMs'
        ];

        for (const setting of requiredSettings) {
            if (!config.rpcSettings[setting]) {
                this.errors.push(`Missing rpcSettings.${setting}`);
            }
        }

        if (config.rpcSettings.maxRequestsPerSecond > 15) {
            this.warnings.push(`High RPS limit: ${config.rpcSettings.maxRequestsPerSecond} - public RPCs may ban`);
        }

        if (config.rpcSettings.requestTimeoutMs < 1000) {
            this.warnings.push(`Low RPC timeout: ${config.rpcSettings.requestTimeoutMs}ms - may cause false failures`);
        }
    }

    printValidationResults() {
        if (this.errors.length === 0 && this.warnings.length === 0) {
            Logger.logSuccess('Configuration validation passed with no issues');
            return;
        }

        if (this.errors.length > 0) {
            Logger.logError('Configuration validation failed with errors:');
            this.errors.forEach((error, index) => {
                console.error(`  ${index + 1}. ${error}`);
            });
        }

        if (this.warnings.length > 0) {
            Logger.logWarning('Configuration validation warnings:');
            this.warnings.forEach((warning, index) => {
                console.warn(`  ${index + 1}. ${warning}`);
            });
        }
    }

    async validateOpportunity(opportunity) {
        const errors = [];
        const warnings = [];

        if (!opportunity.path || opportunity.path.length === 0) {
            errors.push('Opportunity has no path');
            return { isValid: false, errors, warnings };
        }

        if (opportunity.path.length > config.maxHops || opportunity.path.length > 6) {
            warnings.push(`Path has ${opportunity.path.length} hops, maximum recommended is 6`);
        }

        let totalSlippage = 0;
        for (const hop of opportunity.path) {
            if (!hop.fromToken || !hop.toToken) {
                errors.push('Hop missing token addresses');
                continue;
            }

            if (!ethers.isAddress(hop.fromToken) || !ethers.isAddress(hop.toToken)) {
                errors.push(`Invalid token address in hop: ${hop.fromToken} -> ${hop.toToken}`);
            }

            if (!hop.amount || hop.amount <= 0) {
                errors.push(`Invalid amount in hop: ${hop.amount}`);
            }

            if (hop.priceImpact && hop.priceImpact > 0.05) {
                warnings.push(`High price impact in hop: ${(hop.priceImpact * 100).toFixed(2)}%`);
            }

            if (hop.slippage) {
                totalSlippage += hop.slippage;
            }
        }

        if (totalSlippage > 0.1) {
            warnings.push(`Total slippage estimate high: ${(totalSlippage * 100).toFixed(2)}%`);
        }

        if (!opportunity.netProfitUSD || opportunity.netProfitUSD < config.minProfitThresholdUSD) {
            errors.push(`Net profit $${opportunity.netProfitUSD} below threshold $${config.minProfitThresholdUSD}`);
        }

        if (opportunity.netProfitPercent && opportunity.netProfitPercent < 0.1) {
            warnings.push(`Low profit percentage: ${opportunity.netProfitPercent.toFixed(4)}%`);
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    async validateTransaction(txData) {
        const errors = [];
        const warnings = [];

        if (!txData.to || !ethers.isAddress(txData.to)) {
            errors.push('Invalid transaction recipient');
        }

        if (!txData.data || txData.data === '0x') {
            errors.push('Transaction has no data');
        }

        if (txData.gasLimit && txData.gasLimit > 3000000n) {
            warnings.push(`High gas limit: ${txData.gasLimit}`);
        }

        if (txData.maxFeePerGas) {
            const maxFeeGwei = Number(ethers.formatUnits(txData.maxFeePerGas, 'gwei'));
            if (maxFeeGwei > config.maxGasPriceGwei) {
                errors.push(`Gas price ${maxFeeGwei} Gwei exceeds maximum ${config.maxGasPriceGwei} Gwei`);
            }
        }

        const { provider } = await RPCManager.getHealthyProvider();
        const block = await provider.getBlock('latest');

        if (txData.gasLimit && block.gasLimit < txData.gasLimit) {
            errors.push(`Gas limit ${txData.gasLimit} exceeds block gas limit ${block.gasLimit}`);
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        };
    }

    getValidationReport() {
        return {
            timestamp: new Date().toISOString(),
            errors: this.errors,
            warnings: this.warnings,
            errorCount: this.errors.length,
            warningCount: this.warnings.length,
            isValid: this.errors.length === 0,
            recommendations: this.generateRecommendations()
        };
    }

    generateRecommendations() {
        const recommendations = [];

        if (this.warnings.some(w => w.includes('Low wallet balance'))) {
            recommendations.push('Fund your wallet with at least 0.1 ETH for gas');
        }

        if (this.warnings.some(w => w.includes('High RPC rate limit'))) {
            recommendations.push('Reduce RPC rate limits to avoid bans from public nodes');
        }

        if (this.errors.some(e => e.includes('RPC failed'))) {
            recommendations.push('Check RPC endpoint URLs and network connectivity');
        }

        if (this.errors.some(e => e.includes('Contract owner'))) {
            recommendations.push('Deploy contract with correct owner address or transfer ownership');
        }

        return recommendations;
    }
}

module.exports = ConfigValidator;
