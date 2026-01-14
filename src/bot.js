require('dotenv').config();
const { ethers } = require('ethers');
const RPCManager = require('./rpcManager');
const RateLimiter = require('./rateLimiter');
const OpportunityScanner = require('./opportunityScanner');
const ProfitCalculator = require('./profitCalculator');
const AggregatorService = require('./aggregatorService');
const TokenManager = require('./tokenManager');
const ZScoreEngine = require('./zScoreEngine');
const MEVProtection = require('./mevProtection');
const TransactionBuilder = require('./transactionBuilder');
const GasOptimizer = require('./gasOptimizer');
const MetricsCollector = require('./metrics');
const ConfigValidator = require('./configValidator');
const AlertingSystem = require('./alerting');
const { Logger } = require('./utils');
const config = require('../config/config.json');

class BaseAlphaArbBot {
    constructor() {
        this.isRunning = false;
        this.isInitialized = false;
        this.cycleCount = 0;
        this.lastOpportunity = null;
        this.startTime = Date.now();
        this.totalProfitUSD = 0;
        
        // Critical state management
        this.pendingTransactions = new Map();
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 10;
        this.emergencyShutdown = false;
        
        // Performance tracking
        this.metrics = {
            opportunitiesScanned: 0,
            opportunitiesExecuted: 0,
            totalGasSpent: 0,
            totalErrors: 0,
            totalRPCRequests: 0
        };
    }
    
    async initialize() {
        if (this.isInitialized) {
            Logger.logWarning('Bot already initialized');
            return;
        }
        
        try {
            Logger.logInfo('🚀 Initializing BaseAlphaArb Bot...');
            
            // 1. Validate configuration FIRST
            this.configValidator = new ConfigValidator();
            const validationResult = await this.configValidator.validateFullConfig();
            
            if (!validationResult.isValid) {
                Logger.logError('Configuration validation failed:', validationResult.errors);
                await AlertingSystem.sendCriticalError(
                    new Error('Configuration validation failed'),
                    { errors: validationResult.errors }
                );
                process.exit(1);
            }
            
            Logger.logSuccess('Configuration validation passed');
            
            // 2. Initialize core infrastructure
            await this.initializeInfrastructure();
            
            // 3. Initialize all services with proper dependency injection
            await this.initializeServices();
            
            // 4. Start monitoring and alerting
            await this.startMonitoring();
            
            // 5. Run health checks
            await this.performHealthChecks();
            
            this.isInitialized = true;
            
            await AlertingSystem.sendAlert('success', 'Bot Initialized', 
                'BaseAlphaArb Bot initialized successfully and ready to start',
                {
                    rpcNodes: this.rpcManager.getNodeStats().filter(n => n.isHealthy).length,
                    tokensLoaded: this.tokenManager.getAllTokens().length,
                    version: require('../package.json').version
                }
            );
            
            Logger.logSuccess('✅ BaseAlphaArb Bot initialized successfully');
            
        } catch (error) {
            Logger.logError('Bot initialization failed', error);
            await AlertingSystem.sendCriticalError(error, { phase: 'initialization' });
            process.exit(1);
        }
    }
    
    async initializeInfrastructure() {
        Logger.logInfo('Initializing infrastructure...');
        
        // Initialize metrics FIRST (for tracking initialization)
        this.metricsCollector = new MetricsCollector();
        
        // Initialize alerting system
        await AlertingSystem.initialize();
        
        // Initialize RPC manager with metrics integration
        this.rpcManager = RPCManager;
        this.rpcManager.startHealthChecks();
        
        // Initialize rate limiter
        this.rateLimiter = RateLimiter;
        
        // Initialize gas optimizer
        this.gasOptimizer = new GasOptimizer();
        
        Logger.logSuccess('Infrastructure initialized');
    }
    
    async initializeServices() {
        Logger.logInfo('Initializing services...');
        
        try {
            // Initialize token management FIRST (needed by many services)
            this.tokenManager = new TokenManager();
            await this.tokenManager.initialize();
            
            // Initialize Z-Score engine
            this.zScoreEngine = new ZScoreEngine();
            await this.zScoreEngine.initialize();
            
            // Initialize MEV protection
            this.mevProtection = new MEVProtection();
            await this.mevProtection.initialize();
            
            // Initialize aggregator service with rate limiting
            this.aggregatorService = new AggregatorService(this.rateLimiter);
            
            // Initialize profit calculator with slippage modeling
            this.profitCalculator = new ProfitCalculator();
            await this.profitCalculator.initialize();
            
            // Initialize opportunity scanner with all dependencies
            this.opportunityScanner = new OpportunityScanner({
                tokenManager: this.tokenManager,
                zScoreEngine: this.zScoreEngine,
                aggregatorService: this.aggregatorService,
                profitCalculator: this.profitCalculator
            });
            await this.opportunityScanner.initialize();
            
            // Initialize transaction builder with wallet
            this.transactionBuilder = new TransactionBuilder();
            await this.transactionBuilder.init();
            
            // Log service status
            Logger.logSuccess('All services initialized');
            
            // Record metrics
            this.metricsCollector.setGauge('services_initialized', 1);
            this.metricsCollector.setGauge('tokens_loaded', this.tokenManager.getAllTokens().length);
            
        } catch (error) {
            Logger.logError('Service initialization failed', error);
            throw error;
        }
    }
    
    async startMonitoring() {
        Logger.logInfo('Starting monitoring systems...');
        
        // Start metrics collection
        this.metricsCollector.startExporting();
        
        // Start periodic health reporting
        this.healthCheckInterval = setInterval(async () => {
            await this.reportHealthStatus();
        }, 60000); // Every minute
        
        // Start performance monitoring
        this.performanceMonitor = setInterval(async () => {
            await this.monitorPerformance();
        }, 30000); // Every 30 seconds
        
        Logger.logSuccess('Monitoring systems started');
    }
    
    async performHealthChecks() {
        Logger.logInfo('Performing health checks...');
        
        const checks = [
            this.checkRPCHealth(),
            this.checkWalletHealth(),
            this.checkContractHealth(),
            this.checkTokenHealth(),
            this.checkGasHealth()
        ];
        
        const results = await Promise.allSettled(checks);
        
        let allHealthy = true;
        const failedChecks = [];
        
        results.forEach((result, index) => {
            if (result.status === 'rejected' || 
                (result.status === 'fulfilled' && !result.value.healthy)) {
                allHealthy = false;
                failedChecks.push({ check: index, error: result.reason || result.value?.error });
            }
        });
        
        if (!allHealthy) {
            Logger.logError('Health checks failed', { failedChecks });
            await AlertingSystem.sendAlert('warning', 'Health Check Failed',
                'Some health checks failed during initialization',
                { failedChecks: failedChecks.length }
            );
        } else {
            Logger.logSuccess('All health checks passed');
        }
        
        return allHealthy;
    }
    
    async checkRPCHealth() {
        const stats = this.rpcManager.getNodeStats();
        const healthyNodes = stats.filter(node => node.isHealthy).length;
        const totalNodes = stats.length;
        
        if (healthyNodes < totalNodes * 0.5) {
            return {
                healthy: false,
                error: `Only ${healthyNodes}/${totalNodes} RPC nodes healthy`
            };
        }
        
        return { healthy: true };
    }
    
    async checkWalletHealth() {
        try {
            const { provider } = await this.rpcManager.getHealthyProvider();
            const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
            const balance = await provider.getBalance(wallet.address);
            const balanceETH = Number(ethers.formatUnits(balance, 18));
            
            const minBalance = 0.01; // 0.01 ETH minimum
            
            if (balanceETH < minBalance) {
                return {
                    healthy: false,
                    error: `Low wallet balance: ${balanceETH} ETH (min: ${minBalance} ETH)`
                };
            }
            
            return { healthy: true, balance: balanceETH };
        } catch (error) {
            return { healthy: false, error: error.message };
        }
    }
    
    async checkContractHealth() {
        try {
            const { provider } = await this.rpcManager.getHealthyProvider();
            
            if (!process.env.ARB_CONTRACT_ADDRESS) {
                return { healthy: false, error: 'Contract address not configured' };
            }
            
            const code = await provider.getCode(process.env.ARB_CONTRACT_ADDRESS);
            
            if (code === '0x') {
                return { healthy: false, error: 'No contract deployed at configured address' };
            }
            
            return { healthy: true };
        } catch (error) {
            return { healthy: false, error: error.message };
        }
    }
    
    async checkTokenHealth() {
        try {
            const tokens = this.tokenManager.getAllTokens();
            
            if (tokens.length < 10) {
                return { 
                    healthy: false, 
                    error: `Only ${tokens.length} tokens loaded (min: 10)` 
                };
            }
            
            const baseTokens = config.baseTokens;
            let missingBaseTokens = [];
            
            for (const baseToken of baseTokens) {
                const token = this.tokenManager.getTokenByAddress(baseToken);
                if (!token) {
                    missingBaseTokens.push(baseToken);
                }
            }
            
            if (missingBaseTokens.length > 0) {
                return {
                    healthy: false,
                    error: `Missing base tokens: ${missingBaseTokens.join(', ')}`
                };
            }
            
            return { healthy: true, tokenCount: tokens.length };
        } catch (error) {
            return { healthy: false, error: error.message };
        }
    }
    
    async checkGasHealth() {
        try {
            const gasParams = await this.gasOptimizer.getOptimalGasParameters('medium', 'normal');
            const maxGasGwei = config.maxGasPriceGwei || 50;
            const currentGasGwei = Number(ethers.formatUnits(gasParams.maxFeePerGas, 'gwei'));
            
            if (currentGasGwei > maxGasGwei * 0.8) {
                return {
                    healthy: false,
                    error: `High gas price: ${currentGasGwei.toFixed(2)} Gwei (max: ${maxGasGwei} Gwei)`
                };
            }
            
            return { healthy: true, currentGas: currentGasGwei };
        } catch (error) {
            return { healthy: false, error: error.message };
        }
    }
    
    async start() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        
        if (this.isRunning) {
            Logger.logWarning('Bot is already running');
            return;
        }
        
        if (this.emergencyShutdown) {
            Logger.logError('Bot is in emergency shutdown state. Manual intervention required.');
            await AlertingSystem.sendAlert('critical', 'Emergency Shutdown', 
                'Bot cannot start due to emergency shutdown state',
                { consecutiveErrors: this.consecutiveErrors }
            );
            return;
        }
        
        this.isRunning = true;
        this.cycleCount = 0;
        
        await AlertingSystem.sendAlert('success', 'Bot Started', 
            'BaseAlphaArb Bot started successfully',
            {
                startTime: new Date().toISOString(),
                config: {
                    minProfit: config.minProfitThresholdUSD,
                    maxGas: config.maxGasPriceGwei,
                    chainId: config.chainId
                }
            }
        );
        
        Logger.logSuccess('BaseAlphaArb Bot started successfully');
        
        // Main bot loop
        while (this.isRunning && !this.emergencyShutdown) {
            try {
                await this.scanCycle();
                this.cycleCount++;
                
                // Reset consecutive errors on successful cycle
                this.consecutiveErrors = 0;
                
                // Dynamic sleep based on network conditions
                const sleepTime = await this.calculateSleepTime();
                await this.sleep(sleepTime);
                
            } catch (error) {
                await this.handleCycleError(error);
                
                // Check for emergency shutdown
                if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
                    await this.emergencyStop('Too many consecutive errors');
                    break;
                }
                
                // Exponential backoff on errors
                const backoffTime = Math.min(30000, 1000 * Math.pow(2, this.consecutiveErrors));
                await this.sleep(backoffTime);
            }
        }
    }
    
    async scanCycle() {
        const startTime = Date.now();
        
        try {
            // Check if we should wait for better gas conditions
            const gasCheck = await this.gasOptimizer.shouldWaitForBetterGas();
            if (gasCheck.wait) {
                Logger.logInfo(`Waiting for better gas: ${gasCheck.reason}`);
                await this.sleep(gasCheck.estimatedWaitBlocks * 2000 || 5000);
                return;
            }
            
            Logger.logInfo(`Starting scan cycle ${this.cycleCount + 1}`);
            
            // Scan for opportunities
            const opportunities = await this.opportunityScanner.scan();
            this.metrics.opportunitiesScanned += opportunities.length;
            this.metricsCollector.incrementCounter('opportunities_scanned_total', opportunities.length);
            
            if (opportunities.length > 0) {
                Logger.logInfo(`Found ${opportunities.length} potential opportunities`);
                
                // Sort opportunities by profit score
                const sortedOpportunities = opportunities.sort((a, b) => 
                    (b.netProfitUSD || 0) - (a.netProfitUSD || 0)
                );
                
                // Process opportunities in order of profitability
                for (const opportunity of sortedOpportunities.slice(0, 5)) { // Limit to top 5
                    try {
                        // Validate opportunity
                        const validation = await this.configValidator.validateOpportunity(opportunity);
                        
                        if (!validation.isValid) {
                            Logger.logWarning('Opportunity validation failed', validation.errors);
                            continue;
                        }
                        
                        // Record opportunity metrics
                        this.metricsCollector.recordOpportunity(opportunity);
                        
                        // Evaluate and execute
                        const shouldExecute = await this.evaluateOpportunity(opportunity);
                        
                        if (shouldExecute) {
                            const executionResult = await this.executeOpportunity(opportunity);
                            
                            if (executionResult.success) {
                                // Stop after successful execution (optional)
                                break;
                            }
                        }
                        
                    } catch (error) {
                        Logger.logError('Opportunity processing failed', error);
                        this.metricsCollector.recordError('opportunity_processing', {
                            opportunity: opportunity.type,
                            error: error.message
                        });
                        continue;
                    }
                }
            } else {
                Logger.logInfo('No opportunities found this cycle');
            }
            
            const cycleTime = Date.now() - startTime;
            this.metricsCollector.recordScanCycle(cycleTime);
            
            Logger.logInfo(`Cycle ${this.cycleCount + 1} completed in ${cycleTime}ms`);
            
        } catch (error) {
            this.metricsCollector.recordError('scan_cycle', {
                cycle: this.cycleCount,
                error: error.message
            });
            throw error;
        }
    }
    
    async evaluateOpportunity(opportunity) {
        const startTime = Date.now();
        
        try {
            // 1. Profit validation
            const profitable = await this.profitCalculator.calculateNetProfit(opportunity);
            
            if (!profitable.meetsThreshold) {
                Logger.logInfo(`Opportunity below threshold: $${profitable.netProfitUSD.toFixed(2)} < $${config.minProfitThresholdUSD}`);
                return false;
            }
            
            // 2. MEV protection check
            const mevSafe = await this.mevProtection.checkOpportunity(opportunity);
            
            if (!mevSafe.safe) {
                Logger.logWarning('MEV protection blocked opportunity', mevSafe.reasons);
                await AlertingSystem.sendOpportunityMissed(opportunity, `MEV: ${mevSafe.reasons.join(', ')}`);
                return false;
            }
            
            // 3. Gas price safety check
            const currentGas = await this.gasOptimizer.getOptimalGasParameters('complex', 'high');
            const gasPriceGwei = Number(ethers.formatUnits(currentGas.maxFeePerGas, 'gwei'));
            
            if (gasPriceGwei > config.maxGasPriceGwei) {
                Logger.logWarning('Gas price too high', {
                    current: gasPriceGwei,
                    max: config.maxGasPriceGwei
                });
                await AlertingSystem.sendGasPriceAlert(gasPriceGwei, config.maxGasPriceGwei);
                return false;
            }
            
            opportunity.currentGasPriceGwei = gasPriceGwei;
            opportunity.maxGasPriceGwei = config.maxGasPriceGwei;
            opportunity.minProfitThresholdUSD = config.minProfitThresholdUSD;
            
            // 4. Transaction simulation
            const simulated = await this.profitCalculator.simulateTransaction(opportunity);
            
            if (!simulated.success) {
                Logger.logWarning('Simulation failed', simulated.error);
                this.metricsCollector.recordSimulationFailure(simulated.error);
                return false;
            }
            
            // Update profit with simulation results
            opportunity.simulationResult = simulated;
            opportunity.netProfitUSD = simulated.netProfitUSD;
            opportunity.netProfitPercent = simulated.netProfitPercent;
            
            // 5. Final validation
            if (opportunity.netProfitUSD < config.minProfitThresholdUSD * 1.5) {
                // Require higher profit margin for borderline cases
                Logger.logInfo('Borderline profit, requiring higher margin');
                return false;
            }
            
            // Log detailed opportunity analysis
            Logger.logOpportunity(opportunity);
            
            return true;
            
        } catch (error) {
            Logger.logError('Opportunity evaluation failed', error);
            this.metricsCollector.recordError('opportunity_evaluation', {
                opportunity: opportunity.type,
                error: error.message
            });
            return false;
        } finally {
            const evalTime = Date.now() - startTime;
            this.metricsCollector.observeHistogram('opportunity_evaluation_time_ms', evalTime);
        }
    }
    
    async executeOpportunity(opportunity) {
        const startTime = Date.now();
        let txHash = null;
        
        try {
            Logger.logInfo('🚀 Executing arbitrage opportunity...');
            
            // 1. Build transaction
            const txData = await this.transactionBuilder.buildArbitrageTransaction(opportunity);
            
            // 2. Validate transaction
            const txValidation = await this.configValidator.validateTransaction(txData.txData);
            
            if (!txValidation.isValid) {
                throw new Error(`Transaction validation failed: ${txValidation.errors.join(', ')}`);
            }
            
            // 3. Send transaction
            const txResponse = await this.transactionBuilder.sendTransaction(txData.signedTx);
            txHash = txResponse.hash;
            
            this.pendingTransactions.set(txHash, {
                opportunity,
                txData,
                timestamp: Date.now()
            });
            
            Logger.logSuccess('Transaction submitted', { hash: txHash });
            
            // 4. Wait for confirmation
            const { provider } = await this.rpcManager.getHealthyProvider();
            const receipt = await provider.waitForTransaction(txHash, 1, 60000); // 1 confirmation, 60s timeout
            
            const confirmationTime = Date.now() - startTime;
            this.metricsCollector.recordTransactionConfirmation(confirmationTime);
            
            if (receipt.status === 1) {
                // Success!
                this.metrics.opportunitiesExecuted++;
                this.totalProfitUSD += opportunity.netProfitUSD;
                
                // Record metrics
                this.metricsCollector.recordExecution(opportunity, {
                    success: true,
                    executionTime: confirmationTime,
                    gasUsed: receipt.gasUsed.toString(),
                    txHash
                });
                
                this.metricsCollector.recordGasMetrics(
                    txData.txData.maxFeePerGas,
                    opportunity.simulationResult.gasCostUSD
                );
                
                // Send success alert
                await AlertingSystem.sendOpportunityExecuted(
                    opportunity,
                    txHash,
                    {
                        netProfitUSD: opportunity.netProfitUSD,
                        netProfitPercent: opportunity.netProfitPercent,
                        gasCostUSD: opportunity.simulationResult.gasCostUSD
                    }
                );
                
                Logger.logSuccess('✅ Arbitrage executed successfully', {
                    hash: txHash,
                    gasUsed: receipt.gasUsed.toString(),
                    profit: opportunity.netProfitUSD.toFixed(4),
                    confirmationTime: `${confirmationTime}ms`
                });
                
                return {
                    success: true,
                    txHash,
                    receipt,
                    profit: opportunity.netProfitUSD
                };
                
            } else {
                // Transaction failed
                throw new Error('Transaction reverted');
            }
            
        } catch (error) {
            Logger.logError('Execution failed', error);
            
            this.metricsCollector.recordExecution(opportunity, {
                success: false,
                error: error.message,
                txHash
            });
            
            await AlertingSystem.sendAlert('error', 'Execution Failed',
                `Arbitrage execution failed: ${error.message}`,
                {
                    txHash: txHash,
                    opportunity: opportunity.type,
                    estimatedProfit: opportunity.netProfitUSD
                }
            );
            
            return {
                success: false,
                error: error.message,
                txHash
            };
        } finally {
            // Clean up pending transaction
            if (txHash) {
                this.pendingTransactions.delete(txHash);
            }
            
            const executionTime = Date.now() - startTime;
            this.metricsCollector.observeHistogram('opportunity_execution_time_ms', executionTime);
        }
    }
    
    async calculateSleepTime() {
        // Base sleep time
        let sleepTime = 2000;
        
        // Adjust based on network conditions
        try {
            const gasParams = await this.gasOptimizer.getOptimalGasParameters('medium', 'normal');
            const gasGwei = Number(ethers.formatUnits(gasParams.maxFeePerGas, 'gwei'));
            
            // Longer sleep when gas is high
            if (gasGwei > config.maxGasPriceGwei * 0.7) {
                sleepTime += 5000;
            }
            
            // Check recent activity
            const recentExecutions = this.metrics.opportunitiesExecutedLastHour || 0;
            if (recentExecutions > 10) {
                sleepTime += 3000; // Slow down if we're executing a lot
            }
            
        } catch (error) {
            // Use default sleep time on error
        }
        
        // Ensure minimum sleep time
        return Math.max(1000, Math.min(sleepTime, 30000));
    }
    
    async handleCycleError(error) {
        this.consecutiveErrors++;
        this.metrics.totalErrors++;
        
        Logger.logError(`Scan cycle error (${this.consecutiveErrors}/${this.maxConsecutiveErrors})`, error);
        
        // Record error metrics
        this.metricsCollector.recordError('scan_cycle_error', {
            consecutiveErrors: this.consecutiveErrors,
            error: error.message
        });
        
        // Send alert on first error in a series
        if (this.consecutiveErrors === 1) {
            await AlertingSystem.sendAlert('error', 'Scan Cycle Error',
                `Scan cycle failed: ${error.message}`,
                {
                    cycle: this.cycleCount,
                    consecutiveErrors: this.consecutiveErrors
                }
            );
        }
        
        // Send critical alert if approaching shutdown
        if (this.consecutiveErrors >= this.maxConsecutiveErrors - 2) {
            await AlertingSystem.sendAlert('critical', 'Approaching Emergency Shutdown',
                `Multiple consecutive errors detected. Emergency shutdown imminent.`,
                {
                    currentErrors: this.consecutiveErrors,
                    maxErrors: this.maxConsecutiveErrors
                }
            );
        }
    }
    
    async emergencyStop(reason) {
        this.isRunning = false;
        this.emergencyShutdown = true;
        
        Logger.logError(`🛑 EMERGENCY STOP: ${reason}`);
        
        await AlertingSystem.sendAlert('critical', 'Emergency Stop',
            `Bot has entered emergency shutdown state: ${reason}`,
            {
                reason,
                consecutiveErrors: this.consecutiveErrors,
                totalCycles: this.cycleCount,
                uptime: Date.now() - this.startTime
            }
        );
        
        // Clean up resources
        this.cleanup();
    }
    
    async stop(graceful = true) {
        this.isRunning = false;
        
        if (graceful) {
            Logger.logInfo('Stopping bot gracefully...');
            
            // Wait for pending transactions
            const maxWaitTime = 30000; // 30 seconds
            const startWait = Date.now();
            
            while (this.pendingTransactions.size > 0 && 
                   Date.now() - startWait < maxWaitTime) {
                Logger.logInfo(`Waiting for ${this.pendingTransactions.size} pending transactions...`);
                await this.sleep(5000);
            }
            
            // Send stop alert
            await AlertingSystem.sendAlert('info', 'Bot Stopped',
                'Bot stopped gracefully by user request',
                {
                    totalCycles: this.cycleCount,
                    totalProfit: this.totalProfitUSD,
                    uptime: Date.now() - this.startTime
                }
            );
        }
        
        this.cleanup();
        Logger.logSuccess('Bot stopped successfully');
    }
    
    cleanup() {
        // Clear intervals
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        if (this.performanceMonitor) {
            clearInterval(this.performanceMonitor);
        }
        
        // Clear pending transactions
        this.pendingTransactions.clear();
        
        // Export final metrics
        if (this.metricsCollector) {
            this.metricsCollector.exportMetrics();
        }
    }
    
    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    async reportHealthStatus() {
        try {
            const stats = {
                uptime: Date.now() - this.startTime,
                cycles: this.cycleCount,
                opportunitiesScanned: this.metrics.opportunitiesScanned,
                opportunitiesExecuted: this.metrics.opportunitiesExecuted,
                totalProfit: this.totalProfitUSD,
                consecutiveErrors: this.consecutiveErrors,
                pendingTransactions: this.pendingTransactions.size,
                rpcHealth: this.rpcManager.getNodeStats().filter(n => n.isHealthy).length
            };
            
            // Update metrics gauges
            this.metricsCollector.setGauge('bot_uptime', stats.uptime);
            this.metricsCollector.setGauge('bot_cycles', stats.cycles);
            this.metricsCollector.setGauge('bot_profit_total', stats.totalProfit);
            
            // Send hourly status report
            const now = new Date();
            if (now.getMinutes() === 0) {
                await AlertingSystem.sendDailySummary(stats);
            }
            
        } catch (error) {
            Logger.logWarning('Health status report failed', error.message);
        }
    }
    
    async monitorPerformance() {
        try {
            // Check RPC performance
            const rpcStats = this.rpcManager.getNodeStats();
            const unhealthyNodes = rpcStats.filter(node => !node.isHealthy).length;
            
            if (unhealthyNodes > rpcStats.length * 0.3) {
                await AlertingSystem.sendRPCHealthAlert(unhealthyNodes, rpcStats.length);
            }
            
            // Check wallet balance
            const { provider } = await this.rpcManager.getHealthyProvider();
            const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
            const balance = await provider.getBalance(wallet.address);
            const balanceETH = Number(ethers.formatUnits(balance, 18));
            
            if (balanceETH < 0.02) { // 0.02 ETH threshold
                await AlertingSystem.sendBalanceAlert(balanceETH, 0.02);
            }
            
            // Check gas prices
            const gasParams = await this.gasOptimizer.getOptimalGasParameters('medium', 'normal');
            const currentGasGwei = Number(ethers.formatUnits(gasParams.maxFeePerGas, 'gwei'));
            
            if (currentGasGwei > config.maxGasPriceGwei * 0.7) {
                await AlertingSystem.sendGasPriceAlert(currentGasGwei, config.maxGasPriceGwei);
            }
            
        } catch (error) {
            // Silent fail for monitoring
        }
    }
    
    getStatus() {
        return {
            isRunning: this.isRunning,
            isInitialized: this.isInitialized,
            emergencyShutdown: this.emergencyShutdown,
            cycleCount: this.cycleCount,
            consecutiveErrors: this.consecutiveErrors,
            totalProfitUSD: this.totalProfitUSD,
            startTime: this.startTime,
            uptime: Date.now() - this.startTime,
            metrics: this.metrics,
            rpcStats: this.rpcManager.getNodeStats(),
            pendingTransactions: Array.from(this.pendingTransactions.keys()),
            gasStats: this.gasOptimizer ? this.gasOptimizer.getGasStats() : null,
            metricsSummary: this.metricsCollector ? this.metricsCollector.getMetricsSummary() : null
        };
    }
}

const bot = new BaseAlphaArbBot();

process.on('SIGINT', async () => {
    Logger.logInfo('Received SIGINT, stopping bot...');
    await bot.stop(true);
    process.exit(0);
});

process.on('SIGTERM', async () => {
    Logger.logInfo('Received SIGTERM, stopping bot...');
    await bot.stop(true);
    process.exit(0);
});

process.on('uncaughtException', async (error) => {
    Logger.logError('Uncaught exception', error);
    await AlertingSystem.sendCriticalError(error, { type: 'uncaught_exception' });
    await bot.emergencyStop('Uncaught exception');
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    Logger.logError('Unhandled rejection', { reason, promise });
    await AlertingSystem.sendCriticalError(new Error('Unhandled rejection'), { reason });
    await bot.emergencyStop('Unhandled promise rejection');
    process.exit(1);
});

// Export for testing/API access
if (require.main === module) {
    bot.start().catch(async error => {
        Logger.logError('Bot failed to start', error);
        await AlertingSystem.sendCriticalError(error, { phase: 'startup' });
        process.exit(1);
    });
}

module.exports = BaseAlphaArbBot;
