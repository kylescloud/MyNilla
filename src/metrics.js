const NodeCache = require('node-cache');
const { PrometheusExporter } = require('@opentelemetry/exporter-prometheus');
const { MeterProvider } = require('@opentelemetry/sdk-metrics');
const config = require('../config/config.json');
const { Logger } = require('./utils');

class MetricsCollector {
    constructor() {
        this.metrics = new Map();
        this.histograms = new Map();
        this.gauges = new Map();
        this.counters = new Map();
        this.startTime = Date.now();
        this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
        
        this.initializeMetrics();
        this.startExporting();
    }

    initializeMetrics() {
        // Opportunity metrics
        this.createCounter('opportunities_scanned_total', 'Total opportunities scanned');
        this.createCounter('opportunities_executed_total', 'Total opportunities executed');
        this.createCounter('opportunities_failed_total', 'Total opportunities failed');
        this.createGauge('opportunities_active', 'Currently active opportunities being evaluated');
        this.createHistogram('opportunity_profit_usd', 'Profit distribution in USD', [0, 1, 5, 10, 50, 100, 500]);
        this.createHistogram('opportunity_execution_time_ms', 'Execution time distribution', [10, 50, 100, 500, 1000, 5000]);

        // RPC metrics
        this.createCounter('rpc_requests_total', 'Total RPC requests');
        this.createCounter('rpc_errors_total', 'Total RPC errors');
        this.createGauge('rpc_nodes_healthy', 'Number of healthy RPC nodes');
        this.createHistogram('rpc_response_time_ms', 'RPC response time distribution', [10, 50, 100, 500, 1000]);

        // Gas metrics
        this.createGauge('gas_price_gwei', 'Current gas price in Gwei');
        this.createGauge('gas_cost_usd', 'Gas cost in USD for last transaction');
        this.createCounter('gas_spent_total', 'Total gas spent');
        
        // Profit metrics
        this.createGauge('total_profit_usd', 'Total profit in USD');
        this.createGauge('daily_profit_usd', 'Daily profit in USD');
        this.createGauge('hourly_profit_usd', 'Hourly profit in USD');
        
        // Error metrics
        this.createCounter('errors_total', 'Total errors by type');
        this.createCounter('simulation_failures_total', 'Total simulation failures');
        
        // Latency metrics
        this.createHistogram('scan_cycle_time_ms', 'Scan cycle time distribution', [100, 500, 1000, 5000, 10000]);
        this.createHistogram('transaction_confirmation_time_ms', 'Transaction confirmation time', [1000, 5000, 10000, 30000, 60000]);
    }

    createCounter(name, help, labels = []) {
        this.counters.set(name, {
            name,
            help,
            labels,
            value: 0,
            labelValues: new Map()
        });
    }

    createGauge(name, help, labels = []) {
        this.gauges.set(name, {
            name,
            help,
            labels,
            value: 0,
            labelValues: new Map()
        });
    }

    createHistogram(name, help, buckets = []) {
        this.histograms.set(name, {
            name,
            help,
            buckets: buckets || [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            observations: [],
            sum: 0,
            count: 0
        });
    }

    incrementCounter(name, value = 1, labelValues = {}) {
        const counter = this.counters.get(name);
        if (!counter) {
            Logger.logWarning(`Counter ${name} not found`);
            return;
        }

        counter.value += value;
        
        const labelKey = JSON.stringify(labelValues);
        const current = counter.labelValues.get(labelKey) || 0;
        counter.labelValues.set(labelKey, current + value);
    }

    setGauge(name, value, labelValues = {}) {
        const gauge = this.gauges.get(name);
        if (!gauge) {
            Logger.logWarning(`Gauge ${name} not found`);
            return;
        }

        gauge.value = value;
        gauge.labelValues.set(JSON.stringify(labelValues), value);
    }

    observeHistogram(name, value, labelValues = {}) {
        const histogram = this.histograms.get(name);
        if (!histogram) {
            Logger.logWarning(`Histogram ${name} not found`);
            return;
        }

        histogram.observations.push({
            value,
            timestamp: Date.now(),
            labelValues
        });

        histogram.sum += value;
        histogram.count++;

        if (histogram.observations.length > 1000) {
            histogram.observations = histogram.observations.slice(-1000);
        }
    }

    recordOpportunity(opportunity) {
        this.incrementCounter('opportunities_scanned_total', 1, {
            type: opportunity.type,
            hops: opportunity.path.length
        });

        if (opportunity.netProfitUSD) {
            this.observeHistogram('opportunity_profit_usd', opportunity.netProfitUSD, {
                type: opportunity.type
            });
        }
    }

    recordExecution(opportunity, executionResult) {
        this.incrementCounter('opportunities_executed_total', 1, {
            success: executionResult.success,
            type: opportunity.type
        });

        if (executionResult.success) {
            this.incrementCounter('total_profit_usd', opportunity.netProfitUSD);
            this.setGauge('total_profit_usd', this.getCounterValue('total_profit_usd'));
            
            const now = Date.now();
            const today = new Date().toISOString().split('T')[0];
            const hour = new Date().getHours();
            
            const dailyKey = `daily_profit_${today}`;
            const hourlyKey = `hourly_profit_${today}_${hour}`;
            
            const dailyProfit = (this.cache.get(dailyKey) || 0) + opportunity.netProfitUSD;
            const hourlyProfit = (this.cache.get(hourlyKey) || 0) + opportunity.netProfitUSD;
            
            this.cache.set(dailyKey, dailyProfit, 86400);
            this.cache.set(hourlyKey, hourlyProfit, 3600);
            
            this.setGauge('daily_profit_usd', dailyProfit);
            this.setGauge('hourly_profit_usd', hourlyProfit);
        } else {
            this.incrementCounter('opportunities_failed_total', 1, {
                reason: executionResult.reason
            });
        }

        if (executionResult.executionTime) {
            this.observeHistogram('opportunity_execution_time_ms', executionResult.executionTime);
        }

        if (executionResult.gasUsed) {
            this.incrementCounter('gas_spent_total', executionResult.gasUsed);
        }
    }

    recordRPCRequest(endpoint, duration, success = true) {
        this.incrementCounter('rpc_requests_total', 1, { endpoint, success });
        
        if (!success) {
            this.incrementCounter('rpc_errors_total', 1, { endpoint });
        }
        
        this.observeHistogram('rpc_response_time_ms', duration, { endpoint });
    }

    recordGasMetrics(gasPrice, gasCostUSD) {
        this.setGauge('gas_price_gwei', Number(ethers.formatUnits(gasPrice, 'gwei')));
        this.setGauge('gas_cost_usd', gasCostUSD);
    }

    recordError(errorType, context = {}) {
        this.incrementCounter('errors_total', 1, { type: errorType, ...context });
    }

    recordSimulationFailure(reason) {
        this.incrementCounter('simulation_failures_total', 1, { reason });
    }

    recordScanCycle(duration) {
        this.observeHistogram('scan_cycle_time_ms', duration);
    }

    recordTransactionConfirmation(duration) {
        this.observeHistogram('transaction_confirmation_time_ms', duration);
    }

    getCounterValue(name) {
        const counter = this.counters.get(name);
        return counter ? counter.value : 0;
    }

    getGaugeValue(name) {
        const gauge = this.gauges.get(name);
        return gauge ? gauge.value : 0;
    }

    getHistogramStats(name) {
        const histogram = this.histograms.get(name);
        if (!histogram || histogram.observations.length === 0) {
            return null;
        }

        const observations = histogram.observations.map(o => o.value);
        observations.sort((a, b) => a - b);

        const count = observations.length;
        const sum = observations.reduce((a, b) => a + b, 0);
        const mean = sum / count;
        const min = observations[0];
        const max = observations[count - 1];
        const median = observations[Math.floor(count / 2)];
        const p95 = observations[Math.floor(count * 0.95)];
        const p99 = observations[Math.floor(count * 0.99)];

        return {
            count,
            sum,
            mean,
            min,
            max,
            median,
            p95,
            p99,
            buckets: this.calculateBuckets(observations, histogram.buckets)
        };
    }

    calculateBuckets(observations, bucketLimits) {
        const buckets = new Array(bucketLimits.length + 1).fill(0);
        
        observations.forEach(value => {
            let placed = false;
            for (let i = 0; i < bucketLimits.length; i++) {
                if (value <= bucketLimits[i]) {
                    buckets[i]++;
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                    buckets[bucketLimits.length]++;
            }
        });

        return buckets;
    }

    getMetricsSummary() {
        const summary = {
            uptime: Date.now() - this.startTime,
            opportunities: {
                scanned: this.getCounterValue('opportunities_scanned_total'),
                executed: this.getCounterValue('opportunities_executed_total'),
                failed: this.getCounterValue('opportunities_failed_total'),
                successRate: this.getCounterValue('opportunities_executed_total') / 
                           Math.max(1, this.getCounterValue('opportunities_scanned_total'))
            },
            profit: {
                total: this.getGaugeValue('total_profit_usd'),
                daily: this.getGaugeValue('daily_profit_usd'),
                hourly: this.getGaugeValue('hourly_profit_usd')
            },
            rpc: {
                requests: this.getCounterValue('rpc_requests_total'),
                errors: this.getCounterValue('rpc_errors_total'),
                errorRate: this.getCounterValue('rpc_errors_total') / 
                          Math.max(1, this.getCounterValue('rpc_requests_total'))
            },
            gas: {
                totalSpent: this.getCounterValue('gas_spent_total'),
                currentPrice: this.getGaugeValue('gas_price_gwei')
            },
            performance: {
                scanCycle: this.getHistogramStats('scan_cycle_time_ms'),
                executionTime: this.getHistogramStats('opportunity_execution_time_ms')
            }
        };

        return summary;
    }

    startExporting() {
        const meterProvider = new MeterProvider();
        const exporter = new PrometheusExporter({ port: 9464 }, () => {
            Logger.logSuccess(`Prometheus metrics available on port 9464`);
        });

        meterProvider.addMetricReader(exporter);

        setInterval(() => {
            this.exportMetrics();
        }, 30000);
    }

    exportMetrics() {
        const metrics = this.getMetricsSummary();
        const formatted = this.formatPrometheusMetrics(metrics);
        
        // Write to file for Prometheus to scrape
        const fs = require('fs');
        fs.writeFileSync('/tmp/bot_metrics.prom', formatted);
    }

    formatPrometheusMetrics(metrics) {
        let output = '# TYPE bot_opportunities_scanned_total counter\n';
        output += `bot_opportunities_scanned_total ${metrics.opportunities.scanned}\n\n`;
        
        output += '# TYPE bot_opportunities_executed_total counter\n';
        output += `bot_opportunities_executed_total ${metrics.opportunities.executed}\n\n`;
        
        output += '# TYPE bot_total_profit_usd gauge\n';
        output += `bot_total_profit_usd ${metrics.profit.total}\n\n`;
        
        output += '# TYPE bot_gas_price_gwei gauge\n';
        output += `bot_gas_price_gwei ${metrics.gas.currentPrice}\n\n`;
        
        return output;
    }

    generateReport() {
        const summary = this.getMetricsSummary();
        const report = {
            timestamp: new Date().toISOString(),
            uptime: this.formatUptime(summary.uptime),
            performance: {
                opportunitiesScanned: summary.opportunities.scanned,
                opportunitiesExecuted: summary.opportunities.executed,
                successRate: (summary.opportunities.successRate * 100).toFixed(2) + '%',
                totalProfitUSD: summary.profit.total.toFixed(2),
                dailyProfitUSD: summary.profit.daily.toFixed(2),
                hourlyProfitUSD: summary.profit.hourly.toFixed(2)
            },
            reliability: {
                rpcRequests: summary.rpc.requests,
                rpcErrors: summary.rpc.errors,
                rpcErrorRate: (summary.rpc.errorRate * 100).toFixed(2) + '%',
                gasSpent: summary.gas.totalSpent.toString()
            },
            recommendations: this.generateRecommendations(summary)
        };

        return report;
    }

    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        return `${days}d ${hours}h ${minutes}m`;
    }

    generateRecommendations(summary) {
        const recommendations = [];

        if (summary.opportunities.successRate < 0.1) {
            recommendations.push('Low success rate - consider adjusting profit thresholds or improving opportunity detection');
        }

        if (summary.rpc.errorRate > 0.1) {
            recommendations.push('High RPC error rate - consider adding more RPC endpoints or improving error handling');
        }

        if (summary.profit.total < 0) {
            recommendations.push('Net loss detected - review strategy and consider pausing bot');
        }

        if (summary.performance.scanCycle && summary.performance.scanCycle.p95 > 10000) {
            recommendations.push('Slow scan cycles detected - optimize scanning logic or reduce scan frequency');
        }

        return recommendations;
    }
}

module.exports = MetricsCollector;
