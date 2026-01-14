const chalk = require('chalk');

class Logger {
    static logOpportunity(opportunity) {
        console.log('\n' + chalk.cyan('='.repeat(80)));
        console.log(chalk.bold.green('💰 ARBITRAGE OPPORTUNITY DETECTED'));
        console.log(chalk.cyan('='.repeat(80)));
        
        console.log(chalk.bold('📊 Profit Analysis:'));
        console.log(`  Gross Output: $${opportunity.grossProfitUSD.toFixed(4)}`);
        console.log(`  Net Profit: $${opportunity.netProfitUSD.toFixed(4)} (${opportunity.netProfitPercent.toFixed(4)}%)`);
        console.log(`  Gas Cost: $${opportunity.gasCostUSD.toFixed(4)}`);
        console.log(`  Slippage Buffer: $${opportunity.slippageBufferUSD.toFixed(4)}`);
        
        console.log(chalk.bold('\n🔄 Transaction Path:'));
        opportunity.path.forEach((hop, index) => {
            console.log(`  ${chalk.bold(`Hop ${index + 1}:`)} ${hop.inputAmount} ${hop.fromToken} → ${hop.outputAmount} ${hop.toToken}`);
            console.log(`      DEX: ${hop.dex || 'Unknown'}`);
            console.log(`      Price Impact: ${(hop.priceImpact * 100).toFixed(4)}%`);
        });
        
        if (opportunity.zScore) {
            console.log(chalk.bold('\n📈 Statistical Arbitrage:'));
            console.log(`  Pair: ${opportunity.zScore.pair}`);
            console.log(`  Current Z-Score: ${opportunity.zScore.value.toFixed(4)}`);
            console.log(`  Window: ${opportunity.zScore.window} blocks`);
            console.log(`  Conviction: ${opportunity.zScore.convictionLevel}`);
        }
        
        console.log(chalk.bold('\n💱 Price Comparisons:'));
        Object.entries(opportunity.priceComparisons || {}).forEach(([token, prices]) => {
            console.log(`  ${token}:`);
            Object.entries(prices).forEach(([dex, price]) => {
                console.log(`    ${dex}: $${price.toFixed(6)}`);
            });
        });
        
        console.log(chalk.bold('\n⚡ Execution Decision:'));
        console.log(`  Threshold: $${opportunity.minProfitThresholdUSD}`);
        console.log(`  Meets Threshold: ${opportunity.meetsThreshold ? chalk.green('YES') : chalk.red('NO')}`);
        console.log(`  Max Gas Price: ${opportunity.maxGasPriceGwei} Gwei`);
        console.log(`  Current Gas Price: ${opportunity.currentGasPriceGwei} Gwei`);
        
        if (opportunity.decision) {
            console.log(`  Final Decision: ${opportunity.decision.executed ? chalk.green('EXECUTED') : chalk.yellow('SKIPPED')}`);
            if (opportunity.decision.reason) {
                console.log(`  Reason: ${opportunity.decision.reason}`);
            }
        }
        
        console.log(chalk.cyan('='.repeat(80)) + '\n');
    }
    
    static logError(context, error) {
        console.error(chalk.red('\n❌ ERROR:'), chalk.bold(context));
        console.error(chalk.red('Message:'), error.message);
        console.error(chalk.red('Stack:'), error.stack);
        if (error.code) console.error(chalk.red('Code:'), error.code);
    }
    
    static logWarning(message, data = null) {
        console.warn(chalk.yellow('⚠️  WARNING:'), message);
        if (data) console.warn(chalk.yellow('Details:'), JSON.stringify(data, null, 2));
    }
    
    static logInfo(message, data = null) {
        console.log(chalk.blue('ℹ️  INFO:'), message);
        if (data) console.log(chalk.blue('Details:'), data);
    }
    
    static logSuccess(message, data = null) {
        console.log(chalk.green('✅ SUCCESS:'), message);
        if (data) console.log(chalk.green('Result:'), data);
    }
    
    static logRPCStats(stats) {
        console.log(chalk.magenta('\n📡 RPC Node Statistics:'));
        stats.forEach((node, index) => {
            const status = node.isHealthy ? chalk.green('✓ Healthy') : chalk.red('✗ Unhealthy');
            console.log(`  ${index + 1}. ${node.url}`);
            console.log(`     Status: ${status}, Failures: ${node.failureCount}`);
        });
    }
}

module.exports = { Logger };
