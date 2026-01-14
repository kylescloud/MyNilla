const { ethers } = require('ethers');
const NodeCache = require('node-cache');
const Bottleneck = require('bottleneck');
const config = require('../config/config.json');

class RPCManager {
    constructor() {
        this.nodes = [];
        this.currentIndex = 0;
        this.healthCache = new NodeCache({ stdTTL: 60 });
        this.initializeNodes();
    }

    initializeNodes() {
        config.rpcNodes.forEach((url, index) => {
            const limiter = new Bottleneck({
                reservoir: config.rpcSettings.maxRequestsPerSecond,
                reservoirRefreshAmount: config.rpcSettings.maxRequestsPerSecond,
                reservoirRefreshInterval: 1000,
                maxConcurrent: 5,
                minTime: 1000 / config.rpcSettings.maxRequestsPerSecond
            });

            const minuteLimiter = new Bottleneck({
                reservoir: config.rpcSettings.maxRequestsPerMinute,
                reservoirRefreshAmount: config.rpcSettings.maxRequestsPerMinute,
                reservoirRefreshInterval: 60 * 1000,
                maxConcurrent: 1
            });

            this.nodes.push({
                id: index,
                url,
                provider: new ethers.JsonRpcProvider(url, config.chainId, {
                    staticNetwork: true,
                    batchMaxCount: 1
                }),
                limiter,
                minuteLimiter,
                isHealthy: true,
                lastChecked: 0,
                failureCount: 0
            });
        });
    }

    async getHealthyProvider() {
        const startIndex = this.currentIndex;
        let attempts = 0;

        while (attempts < this.nodes.length) {
            const node = this.nodes[this.currentIndex];
            this.currentIndex = (this.currentIndex + 1) % this.nodes.length;

            if (node.isHealthy) {
                return {
                    provider: node.provider,
                    execute: (fn) => this.executeWithLimiters(node, fn)
                };
            }

            attempts++;
            
            if (attempts === this.nodes.length) {
                const anyNode = this.nodes.find(n => n.isHealthy) || this.nodes[0];
                console.warn(`All RPC nodes unhealthy, using ${anyNode.url} as fallback`);
                return {
                    provider: anyNode.provider,
                    execute: (fn) => this.executeWithLimiters(anyNode, fn)
                };
            }
        }
    }

    async executeWithLimiters(node, fn) {
        try {
            await node.minuteLimiter.schedule(() => node.limiter.schedule(fn));
            node.failureCount = 0;
            return true;
        } catch (error) {
            node.failureCount++;
            if (node.failureCount >= 3) {
                this.markUnhealthy(node.id);
            }
            throw error;
        }
    }

    markUnhealthy(nodeId) {
        const node = this.nodes[nodeId];
        if (node) {
            node.isHealthy = false;
            node.lastChecked = Date.now();
            console.warn(`Marked RPC ${node.url} as unhealthy`);
            
            setTimeout(() => {
                this.checkNodeHealth(nodeId);
            }, config.rpcSettings.unhealthyTimeoutMs);
        }
    }

    async checkNodeHealth(nodeId) {
        const node = this.nodes[nodeId];
        try {
            const start = Date.now();
            await node.provider.getBlockNumber();
            const latency = Date.now() - start;
            
            node.isHealthy = true;
            console.log(`RPC ${node.url} health restored, latency: ${latency}ms`);
            return true;
        } catch (error) {
            console.warn(`RPC ${node.url} still unhealthy: ${error.message}`);
            node.isHealthy = false;
            
            setTimeout(() => {
                this.checkNodeHealth(nodeId);
            }, config.rpcSettings.unhealthyTimeoutMs);
            return false;
        }
    }

    startHealthChecks() {
        setInterval(() => {
            this.nodes.forEach((node, index) => {
                if (!node.isHealthy && 
                    Date.now() - node.lastChecked > config.rpcSettings.healthCheckIntervalMs) {
                    this.checkNodeHealth(index);
                }
            });
        }, config.rpcSettings.healthCheckIntervalMs);
    }

    getNodeStats() {
        return this.nodes.map(node => ({
            url: node.url,
            isHealthy: node.isHealthy,
            failureCount: node.failureCount,
            queueSize: node.limiter._nextRequestTimestamp
        }));
    }
}

module.exports = new RPCManager();
