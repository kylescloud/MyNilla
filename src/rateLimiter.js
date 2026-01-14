const Bottleneck = require('bottleneck');
const config = require('../config/config.json');

class RateLimiter {
    constructor() {
        this.limiters = {};
        this.initializeLimiters();
    }

    initializeLimiters() {
        Object.entries(config.apiRateLimits).forEach(([service, limits]) => {
            this.limiters[service] = new Bottleneck({
                reservoir: limits.requestsPerMinute,
                reservoirRefreshAmount: limits.requestsPerMinute,
                reservoirRefreshInterval: 60 * 1000,
                maxConcurrent: 1,
                minTime: (60 * 1000) / limits.requestsPerMinute
            });

            this.limiters[service].on('depleted', (empty) => {
                if (empty) {
                    console.warn(`Rate limit depleted for ${service}`);
                }
            });
        });
    }

    async schedule(service, fn) {
        if (!this.limiters[service]) {
            console.warn(`No rate limiter found for ${service}, executing directly`);
            return fn();
        }

        try {
            const result = await this.limiters[service].schedule(fn);
            const remaining = this.limiters[service].reservoir;
            
            if (remaining < 5) {
                console.warn(`Rate limit low for ${service}: ${remaining} requests remaining`);
            }
            
            return result;
        } catch (error) {
            if (error.message && error.message.includes('rate limited')) {
                console.error(`Rate limit exceeded for ${service}, waiting...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                return this.schedule(service, fn);
            }
            throw error;
        }
    }

    getLimiterStats(service) {
        if (!this.limiters[service]) return null;
        
        return {
            remaining: this.limiters[service].reservoir,
            queueSize: this.limiters[service].queued(),
            nextRequest: this.limiters[service]._nextRequest
        };
    }

    getAllStats() {
        const stats = {};
        Object.keys(this.limiters).forEach(service => {
            stats[service] = this.getLimiterStats(service);
        });
        return stats;
    }
}

module.exports = new RateLimiter();
