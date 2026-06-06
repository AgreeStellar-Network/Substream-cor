#!/usr/bin/env node

const { Command } = require('commander');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

class SubStreamCLI {
  constructor() {
    this.config = this.loadConfig();
    this.baseURL = this.config.baseURL || 'http://localhost:3000';
    this.authToken = this.config.authToken || '';
  }

  loadConfig() {
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE, '.substream-cli.json');
    try {
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch (error) {
      console.warn(chalk.yellow('Warning: Could not load config file'));
    }
    return {};
  }

  saveConfig() {
    const configPath = path.join(process.env.HOME || process.env.USERPROFILE, '.substream-cli.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error(chalk.red('Error: Could not save config file'));
    }
  }

  async makeRequest(method, endpoint, data = null) {
    try {
      const config = {
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: {}
      };

      if (this.authToken) {
        config.headers.Authorization = `Bearer ${this.authToken}`;
      }

      if (data) {
        config.data = data;
        config.headers['Content-Type'] = 'application/json';
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`API Error: ${error.response.status} - ${error.response.data?.error || error.response.statusText}`);
      } else if (error.request) {
        throw new Error('Network Error: Could not connect to the server');
      } else {
        throw new Error(`Error: ${error.message}`);
      }
    }
  }

  async getStatus() {
    try {
      const response = await this.makeRequest('GET', '/api/sandbox/status');
      
      if (response.success) {
        const data = response.data;
        console.log(chalk.blue('🏗️  SubStream Sandbox Status'));
        console.log(chalk.gray('─'.repeat(40)));
        
        console.log(chalk.white('Environment:'));
        console.log(`  Mode: ${data.enabled ? chalk.green(data.mode.toUpperCase()) : chalk.red('PRODUCTION')}`);
        console.log(`  Sandbox: ${data.enabled ? chalk.green('Enabled') : chalk.red('Disabled')}`);
        
        console.log(chalk.white('\nStellar Configuration:'));
        console.log(`  Network: ${data.stellarConfig.networkPassphrase.includes('Test') ? chalk.green('Testnet') : chalk.blue('Mainnet')}`);
        console.log(`  Horizon: ${data.stellarConfig.horizonUrl}`);
        
        console.log(chalk.white('\nFeatures:'));
        console.log(`  Mock Payments: ${data.features.mockPayments ? chalk.green('Enabled') : chalk.red('Disabled')}`);
        console.log(`  Failure Simulation: ${data.features.failureSimulation ? chalk.green('Enabled') : chalk.red('Disabled')}`);
        console.log(`  Zero-Value Tokens: ${data.features.zeroValueTokens ? chalk.green('Enabled') : chalk.red('Disabled')}`);
        
        console.log(chalk.white('\nStatistics:'));
        console.log(`  Mock Events: ${data.mockEventsCount}`);
        console.log(`  Failure Rules: ${data.failureRules.length}`);
        
        return true;
      } else {
        console.error(chalk.red('Error:', response.error));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Error getting status:', error.message));
      return false;
    }
  }

  async createMockPayment(options) {
    try {
      const data = {
        subscriptionId: options.subscriptionId,
        creatorAddress: options.creatorAddress,
        subscriberAddress: options.subscriberAddress,
        amount: parseFloat(options.amount) || 0,
        tier: options.tier || 'bronze',
        metadata: options.metadata ? JSON.parse(options.metadata) : {}
      };

      const response = await this.makeRequest('POST', '/api/sandbox/mock-payment', data);
      
      if (response.success) {
        console.log(chalk.green('✅ Mock payment created successfully!'));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(chalk.white('Payment Details:'));
        console.log(`  Event ID: ${response.data.id}`);
        console.log(`  Type: ${response.data.type}`);
        console.log(`  Subscription: ${response.data.data.subscriptionId}`);
        console.log(`  Amount: ${response.data.data.amount}`);
        console.log(`  Tier: ${response.data.data.tier}`);
        console.log(`  Timestamp: ${new Date(response.data.timestamp).toLocaleString()}`);
        console.log(`  Source: ${response.data.source}`);
        
        return true;
      } else {
        console.error(chalk.red('Error:', response.error));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Error creating mock payment:', error.message));
      return false;
    }
  }

  async simulateFailure(options) {
    try {
      const data = {
        subscriptionId: options.subscriptionId,
        failureType: options.failureType || 'insufficient_funds'
      };

      const response = await this.makeRequest('POST', '/api/sandbox/simulate-failure', data);
      
      if (response.success) {
        console.log(chalk.yellow('⚠️  Payment failure simulated successfully!'));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(chalk.white('Failure Details:'));
        console.log(`  Event ID: ${response.data.id}`);
        console.log(`  Type: ${response.data.type}`);
        console.log(`  Subscription: ${response.data.data.subscriptionId}`);
        console.log(`  Failure Type: ${response.data.data.failureType}`);
        console.log(`  Timestamp: ${new Date(response.data.timestamp).toLocaleString()}`);
        console.log(`  Source: ${response.data.source}`);
        
        return true;
      } else {
        console.error(chalk.red('Error:', response.error));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Error simulating failure:', error.message));
      return false;
    }
  }

  async createTestnetAccount() {
    try {
      const response = await this.makeRequest('POST', '/api/sandbox/testnet-account');
      
      if (response.success) {
        console.log(chalk.green('🔐 Testnet account created successfully!'));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(chalk.white('Account Details:'));
        console.log(`  Public Key: ${chalk.cyan(response.data.publicKey)}`);
        console.log(`  Secret Key: ${chalk.red(response.data.secretKey)} ${chalk.yellow('(Save this securely!)')}`);
        console.log(`  Network: ${response.data.network}`);
        console.log(`  Horizon URL: ${response.data.horizonUrl}`);
        
        console.log(chalk.yellow('\n⚠️  Important: Save the secret key in a secure location!'));
        
        return true;
      } else {
        console.error(chalk.red('Error:', response.error));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Error creating testnet account:', error.message));
      return false;
    }
  }

  async getMockEvents(options) {
    try {
      const limit = options.limit || 50;
      const offset = options.offset || 0;
      
      const response = await this.makeRequest('GET', `/api/sandbox/mock-events?limit=${limit}&offset=${offset}`);
      
      if (response.success) {
        const { events, total, hasMore } = response.data;
        
        console.log(chalk.blue('📋 Mock Events History'));
        console.log(chalk.gray(`─`.repeat(40)));
        console.log(chalk.white(`Showing ${events.length} of ${total} events`));
        
        if (events.length === 0) {
          console.log(chalk.yellow('No mock events found'));
          return true;
        }

        events.forEach((event, index) => {
          console.log(chalk.white(`\n${index + 1}. ${event.type}`));
          console.log(`   ID: ${event.id}`);
          console.log(`   Subscription: ${event.data.subscriptionId || 'N/A'}`);
          console.log(`   Timestamp: ${new Date(event.timestamp).toLocaleString()}`);
          console.log(`   Source: ${event.source}`);
          
          if (event.data.amount !== undefined) {
            console.log(`   Amount: ${event.data.amount}`);
          }
          if (event.data.tier) {
            console.log(`   Tier: ${event.data.tier}`);
          }
          if (event.data.failureType) {
            console.log(`   Failure Type: ${event.data.failureType}`);
          }
        });

        if (hasMore) {
          console.log(chalk.gray(`\n... and ${total - offset - limit} more events`));
        }
        
        return true;
      } else {
        console.error(chalk.red('Error:', response.error));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Error getting mock events:', error.message));
      return false;
    }
  }

  async clearMockEvents() {
    try {
      const response = await this.makeRequest('DELETE', '/api/sandbox/mock-events');
      
      if (response.success) {
        console.log(chalk.green('🗑️  Mock events cleared successfully!'));
        return true;
      } else {
        console.error(chalk.red('Error:', response.error));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Error clearing mock events:', error.message));
      return false;
    }
  }

  async testWebhook(options) {
    try {
      const data = {
        webhookUrl: options.webhookUrl,
        eventType: options.eventType || 'SubscriptionBilled',
        payload: options.payload ? JSON.parse(options.payload) : {
          subscriptionId: 'test_webhook_123',
          amount: 0,
          tier: 'bronze',
          creatorAddress: 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7',
          subscriberAddress: 'GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A'
        }
      };

      const response = await this.makeRequest('POST', '/api/sandbox/webhook-test', data);
      
      if (response.success) {
        console.log(chalk.green('🌐 Webhook test sent successfully!'));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(chalk.white('Webhook Details:'));
        console.log(`  Event ID: ${response.data.eventId}`);
        console.log(`  Webhook URL: ${response.data.webhookUrl}`);
        console.log(`  Event Type: ${response.data.eventType}`);
        console.log(`  Status: ${response.data.status}`);
        
        return true;
      } else {
        console.error(chalk.red('Error:', response.error));
        return false;
      }
    } catch (error) {
      console.error(chalk.red('Error testing webhook:', error.message));
      return false;
    }
  }

  setConfig(key, value) {
    this.config[key] = value;
    this.saveConfig();
    console.log(chalk.green(`✅ Config updated: ${key} = ${value}`));
  }
}

// CLI Setup
const program = new Command();
const cli = new SubStreamCLI();

program
  .name('substream-cli')
  .description('AgreeStellar Sandbox CLI Tool')
  .version('1.0.0');

program
  .command('config')
  .description('Configure CLI settings')
  .argument('<key>', 'Configuration key (baseURL, authToken)')
  .argument('<value>', 'Configuration value')
  .action((key, value) => {
    cli.setConfig(key, value);
  });

program
  .command('status')
  .description('Get sandbox environment status')
  .action(async () => {
    await cli.getStatus();
  });

program
  .command('mock-payment')
  .description('Create a mock payment event')
  .requiredOption('-s, --subscription-id <id>', 'Subscription ID')
  .requiredOption('-c, --creator-address <address>', 'Creator address')
  .requiredOption('-u, --subscriber-address <address>', 'Subscriber address')
  .option('-a, --amount <amount>', 'Payment amount (default: 0)', '0')
  .option('-t, --tier <tier>', 'Subscription tier (bronze, silver, gold)', 'bronze')
  .option('-m, --metadata <metadata>', 'Additional metadata as JSON string')
  .action(async (options) => {
    await cli.createMockPayment(options);
  });

program
  .command('simulate-failure')
  .description('Simulate a payment failure')
  .requiredOption('-s, --subscription-id <id>', 'Subscription ID')
  .option('-f, --failure-type <type>', 'Failure type (insufficient_funds, network_error, timeout)', 'insufficient_funds')
  .action(async (options) => {
    await cli.simulateFailure(options);
  });

program
  .command('create-testnet-account')
  .description('Create a funded testnet account')
  .action(async () => {
    await cli.createTestnetAccount();
  });

program
  .command('events')
  .description('Get mock events history')
  .option('-l, --limit <limit>', 'Number of events to show (default: 50)', '50')
  .option('-o, --offset <offset>', 'Number of events to skip (default: 0)', '0')
  .action(async (options) => {
    await cli.getMockEvents(options);
  });

program
  .command('clear-events')
  .description('Clear all mock events')
  .action(async () => {
    await cli.clearMockEvents();
  });

program
  .command('test-webhook')
  .description('Test webhook delivery')
  .requiredOption('-w, --webhook-url <url>', 'Webhook URL')
  .option('-e, --event-type <type>', 'Event type (default: SubscriptionBilled)', 'SubscriptionBilled')
  .option('-p, --payload <payload>', 'Custom payload as JSON string')
  .action(async (options) => {
    await cli.testWebhook(options);
  });

// Error handling
program.on('command:*', () => {
  console.error(chalk.red('Invalid command: %s'), program.args.join(' '));
  console.log(chalk.gray('See --help for a list of available commands.'));
  process.exit(1);
});

// Parse command line arguments
program.parse();

// Handle no arguments
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
