const axios = require('axios');
const NodeCache = require('node-cache');
const { Logger } = require('./utils');

class AlertingSystem {
    constructor() {
        this.cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
        this.alertCooldowns = new Map();
        this.initialized = false;
        
        this.alertChannels = {
            telegram: this.sendTelegramAlert.bind(this),
            discord: this.sendDiscordAlert.bind(this),
            slack: this.sendSlackAlert.bind(this),
            email: this.sendEmailAlert.bind(this),
            webhook: this.sendWebhookAlert.bind(this)
        };
    }

    async initialize() {
        Logger.logInfo('Initializing alerting system...');
        
        this.config = {
            telegram: {
                enabled: !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID,
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID
            },
            discord: {
                enabled: !!process.env.DISCORD_WEBHOOK_URL,
                webhookUrl: process.env.DISCORD_WEBHOOK_URL
            },
            slack: {
                enabled: !!process.env.SLACK_WEBHOOK_URL,
                webhookUrl: process.env.SLACK_WEBHOOK_URL
            },
            email: {
                enabled: !!process.env.EMAIL_SMTP_HOST && !!process.env.EMAIL_TO,
                smtpHost: process.env.EMAIL_SMTP_HOST,
                smtpPort: process.env.EMAIL_SMTP_PORT || 587,
                smtpUser: process.env.EMAIL_SMTP_USER,
                smtpPass: process.env.EMAIL_SMTP_PASS,
                emailTo: process.env.EMAIL_TO,
                emailFrom: process.env.EMAIL_FROM || 'bot@basealpha.com'
            },
            webhook: {
                enabled: !!process.env.ALERT_WEBHOOK_URL,
                webhookUrl: process.env.ALERT_WEBHOOK_URL
            }
        };

        this.initialized = true;
        Logger.logSuccess('Alerting system initialized');
    }

    async sendAlert(level, title, message, data = null, options = {}) {
        if (!this.initialized) {
            await this.initialize();
        }

        const alertKey = `${level}:${title}:${JSON.stringify(data)}`;
        const now = Date.now();
        const lastAlert = this.alertCooldowns.get(alertKey) || 0;

        const cooldown = this.getCooldownForLevel(level);
        if (now - lastAlert < cooldown * 1000) {
            return { sent: false, reason: 'Cooldown active' };
        }

        const formattedMessage = this.formatMessage(level, title, message, data);
        
        const results = [];
        for (const [channel, config] of Object.entries(this.config)) {
            if (config.enabled && this.shouldSendToChannel(channel, level)) {
                try {
                    const result = await this.alertChannels[channel](level, title, formattedMessage, data, options);
                    results.push({ channel, success: true, result });
                } catch (error) {
                    results.push({ channel, success: false, error: error.message });
                    Logger.logError(`Failed to send alert via ${channel}`, error);
                }
            }
        }

        this.alertCooldowns.set(alertKey, now);
        this.cache.set(`alert_${alertKey}`, { level, title, message, timestamp: now });

        return {
            sent: results.some(r => r.success),
            results,
            message: formattedMessage
        };
    }

    getCooldownForLevel(level) {
        const cooldowns = {
            'critical': 60,     // 1 minute
            'error': 300,       // 5 minutes
            'warning': 900,     // 15 minutes
            'info': 1800,       // 30 minutes
            'success': 3600     // 1 hour
        };
        return cooldowns[level] || 300;
    }

    shouldSendToChannel(channel, level) {
        const channelLevels = {
            'telegram': ['critical', 'error', 'warning', 'success'],
            'discord': ['critical', 'error', 'warning'],
            'slack': ['critical', 'error'],
            'email': ['critical'],
            'webhook': ['critical', 'error', 'warning']
        };

        return channelLevels[channel]?.includes(level) || false;
    }

    formatMessage(level, title, message, data) {
        const timestamp = new Date().toISOString();
        const levelEmoji = this.getLevelEmoji(level);
        
        let formatted = `${levelEmoji} **${title.toUpperCase()}**\n`;
        formatted += `*Time:* ${timestamp}\n`;
        formatted += `*Level:* ${level}\n\n`;
        formatted += `${message}\n`;

        if (data) {
            formatted += '\n**Details:**\n';
            
            if (typeof data === 'object') {
                for (const [key, value] of Object.entries(data)) {
                    if (value !== undefined && value !== null) {
                        formatted += `• ${key}: ${this.formatValue(value)}\n`;
                    }
                }
            } else {
                formatted += `• ${data}\n`;
            }
        }

        return formatted;
    }

    getLevelEmoji(level) {
        const emojis = {
            'critical': '🚨',
            'error': '❌',
            'warning': '⚠️',
            'info': 'ℹ️',
            'success': '✅'
        };
        return emojis[level] || '📝';
    }

    formatValue(value) {
        if (typeof value === 'number') {
            if (value > 1000000) {
                return `$${(value / 1000000).toFixed(2)}M`;
            } else if (value > 1000) {
                return `$${(value / 1000).toFixed(2)}K`;
            } else {
                return `$${value.toFixed(2)}`;
            }
        } else if (typeof value === 'boolean') {
            return value ? 'Yes' : 'No';
        } else if (Array.isArray(value)) {
            return `[${value.slice(0, 3).join(', ')}${value.length > 3 ? '...' : ''}]`;
        } else {
            return String(value);
        }
    }

    async sendTelegramAlert(level, title, message, data) {
        const url = `https://api.telegram.org/bot${this.config.telegram.botToken}/sendMessage`;
        
        const response = await axios.post(url, {
            chat_id: this.config.telegram.chatId,
            text: message,
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });

        return response.data;
    }

    async sendDiscordAlert(level, title, message, data) {
        const color = this.getDiscordColor(level);
        
        const embed = {
            title: `${this.getLevelEmoji(level)} ${title}`,
            description: message,
            color: color,
            timestamp: new Date().toISOString(),
            fields: []
        };

        if (data && typeof data === 'object') {
            for (const [key, value] of Object.entries(data)) {
                if (value !== undefined && value !== null) {
                    embed.fields.push({
                        name: key,
                        value: this.formatValue(value),
                        inline: true
                    });
                }
            }
        }

        const payload = {
            embeds: [embed]
        };

        const response = await axios.post(this.config.discord.webhookUrl, payload);
        return response.data;
    }

    getDiscordColor(level) {
        const colors = {
            'critical': 0xff0000,    // Red
            'error': 0xff3300,       // Orange-red
            'warning': 0xff9900,     // Orange
            'info': 0x0099ff,        // Blue
            'success': 0x00ff00      // Green
        };
        return colors[level] || 0x808080; // Gray
    }

    async sendSlackAlert(level, title, message, data) {
        const color = this.getSlackColor(level);
        
        const blocks = [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: `${this.getLevelEmoji(level)} ${title}`
                }
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: message
                }
            }
        ];

        if (data && typeof data === 'object') {
            const fields = [];
            for (const [key, value] of Object.entries(data)) {
                if (value !== undefined && value !== null) {
                    fields.push({
                        type: 'mrkdwn',
                        text: `*${key}:* ${this.formatValue(value)}`
                    });
                }
            }

            if (fields.length > 0) {
                blocks.push({
                    type: 'section',
                    fields: fields.slice(0, 10)
                });
            }
        }

        const payload = {
            blocks,
            attachments: [
                {
                    color: color,
                    ts: Math.floor(Date.now() / 1000)
                }
            ]
        };

        const response = await axios.post(this.config.slack.webhookUrl, payload);
        return response.data;
    }

    getSlackColor(level) {
        const colors = {
            'critical': '#ff0000',
            'error': '#ff3300',
            'warning': '#ff9900',
            'info': '#0099ff',
            'success': '#00ff00'
        };
        return colors[level] || '#808080';
    }

    async sendEmailAlert(level, title, message, data) {
        const nodemailer = require('nodemailer');
        
        const transporter = nodemailer.createTransport({
            host: this.config.email.smtpHost,
            port: this.config.email.smtpPort,
            secure: this.config.email.smtpPort === 465,
            auth: {
                user: this.config.email.smtpUser,
                pass: this.config.email.smtpPass
            }
        });

        let html = `<h2>${this.getLevelEmoji(level)} ${title}</h2>`;
        html += `<p><strong>Time:</strong> ${new Date().toISOString()}</p>`;
        html += `<p><strong>Level:</strong> ${level}</p>`;
        html += `<hr>`;
        html += `<p>${message.replace(/\n/g, '<br>')}</p>`;

        if (data) {
            html += `<h3>Details:</h3><ul>`;
            
            if (typeof data === 'object') {
                for (const [key, value] of Object.entries(data)) {
                    if (value !== undefined && value !== null) {
                        html += `<li><strong>${key}:</strong> ${this.formatValue(value)}</li>`;
                    }
                }
            } else {
                html += `<li>${data}</li>`;
            }
            
            html += `</ul>`;
        }

        const mailOptions = {
            from: this.config.email.emailFrom,
            to: this.config.email.emailTo,
            subject: `[${level.toUpperCase()}] ${title}`,
            html: html
        };

        const info = await transporter.sendMail(mailOptions);
        return info;
    }

    async sendWebhookAlert(level, title, message, data) {
        const payload = {
            level,
            title,
            message,
            data,
            timestamp: new Date().toISOString(),
            botId: process.env.BOT_ID || 'base-alpha-arb'
        };

        const response = await axios.post(this.config.webhook.webhookUrl, payload);
        return response.data;
    }

    // Predefined alert types
    async sendCriticalError(error, context = {}) {
        return this.sendAlert('critical', 'Critical Error', 
            `A critical error occurred that may affect bot operation:\n\n${error.message}`,
            { ...context, stack: error.stack?.split('\n').slice(0, 5) },
            { bypassCooldown: true }
        );
    }

    async sendOpportunityExecuted(opportunity, txHash, profit) {
        return this.sendAlert('success', 'Opportunity Executed',
            `Successfully executed arbitrage opportunity with profit.`,
            {
                profitUSD: profit.netProfitUSD,
                profitPercent: profit.netProfitPercent,
                txHash: txHash,
                path: opportunity.path.map(h => h.fromToken.substring(0, 10)).join(' → '),
                gasCost: profit.gasCostUSD
            }
        );
    }

    async sendOpportunityMissed(opportunity, reason) {
        return this.sendAlert('warning', 'Opportunity Missed',
            `An opportunity was detected but not executed.`,
            {
                reason: reason,
                estimatedProfit: opportunity.netProfitUSD,
                path: opportunity.path.map(h => h.fromToken.substring(0, 10)).join(' → ')
            }
        );
    }

    async sendGasPriceAlert(currentGas, maxGas) {
        return this.sendAlert('warning', 'High Gas Price',
            `Current gas price is approaching maximum configured limit.`,
            {
                currentGas: `${currentGas} Gwei`,
                maxGas: `${maxGas} Gwei`,
                percentage: `${(currentGas / maxGas * 100).toFixed(1)}%`
            }
        );
    }

    async sendBalanceAlert(balance, threshold) {
        return this.sendAlert('error', 'Low Wallet Balance',
            `Wallet balance is below the configured threshold.`,
            {
                currentBalance: `${balance} ETH`,
                threshold: `${threshold} ETH`,
                needed: `${(threshold - balance).toFixed(4)} ETH`
            }
        );
    }

    async sendRPCHealthAlert(unhealthyNodes, totalNodes) {
        return this.sendAlert('warning', 'RPC Health Issue',
            `Some RPC nodes are unhealthy, which may affect bot performance.`,
            {
                unhealthy: unhealthyNodes,
                total: totalNodes,
                percentage: `${(unhealthyNodes / totalNodes * 100).toFixed(1)}%`
            }
        );
    }

    async sendDailySummary(stats) {
        return this.sendAlert('info', 'Daily Summary',
            `Daily performance summary for the arbitrage bot.`,
            {
                opportunitiesScanned: stats.opportunitiesScanned,
                opportunitiesExecuted: stats.opportunitiesExecuted,
                totalProfitUSD: stats.totalProfitUSD,
                successRate: `${(stats.successRate * 100).toFixed(2)}%`,
                gasSpent: stats.gasSpent,
                rpcErrors: stats.rpcErrors
            }
        );
    }

    getRecentAlerts(limit = 20) {
        const keys = this.cache.keys().filter(k => k.startsWith('alert_'));
        const alerts = keys.map(k => this.cache.get(k)).filter(a => a);
        
        return alerts
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }

    clearAlerts() {
        const keys = this.cache.keys().filter(k => k.startsWith('alert_'));
        keys.forEach(k => this.cache.del(k));
        this.alertCooldowns.clear();
    }

    getAlertStats() {
        const alerts = this.getRecentAlerts(1000);
        
        const stats = {
            total: alerts.length,
            byLevel: {},
            last24h: 0,
            lastHour: 0
        };

        const now = Date.now();
        const oneDayAgo = now - 86400000;
        const oneHourAgo = now - 3600000;

        alerts.forEach(alert => {
            stats.byLevel[alert.level] = (stats.byLevel[alert.level] || 0) + 1;
            
            if (alert.timestamp > oneDayAgo) {
                stats.last24h++;
            }
            if (alert.timestamp > oneHourAgo) {
                stats.lastHour++;
            }
        });

        return stats;
    }
}

module.exports = new AlertingSystem();
