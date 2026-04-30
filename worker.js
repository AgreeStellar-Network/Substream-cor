#!/usr/bin/env node

const dotenv = require('dotenv');
const { initTracing } = require('./src/utils/opentelemetry');

dotenv.config();
initTracing({ serviceName: 'substream-protocol-backend-worker', serviceVersion: '1.0.0' });

const { loadConfig } = require('./src/config');
const { BackgroundWorkerService } = require('./src/services/backgroundWorkerService');
const { SorobanIndexerWorker } = require('./src/services/sorobanIndexerWorker');
const { ReconciliationWorker } = require('./src/services/reconciliationWorker');
const { getVaultService } = require('./src/services/vaultService');
const { getSorobanIndexerFailoverHandler, resetSorobanIndexerFailoverHandler } = require('./src/services/sorobanIndexerFailover');
const { getRedisCacheFailoverHandler, resetRedisCacheFailoverHandler } = require('./src/services/redisCacheFailover');

// Initialize Vault service if enabled
let vaultService = null;

if (process.env.VAULT_ENABLED === 'true') {
  vaultService = getVaultService({
    vaultAddr: process.env.VAULT_ADDR || 'http://vault:8200',
    vaultRole: process.env.VAULT_ROLE || 'substream-backend',
    authPath: process.env.VAULT_AUTH_PATH || 'auth/kubernetes',
    secretPath: process.env.VAULT_SECRET_PATH || 'secret/data/substream',
    dbPath: process.env.VAULT_DB_PATH || 'database/creds/substream-role'
  });
  console.log('[Vault] Vault integration enabled in worker');
}

// SIGHUP signal handler for hot-reloading secrets
if (process.env.VAULT_ENABLED === 'true' && vaultService) {
  process.on('SIGHUP', async () => {
    console.log('[Vault] Received SIGHUP signal, reloading secrets...');
    try {
      await vaultService.reloadSecrets();
      console.log('[Vault] Successfully reloaded secrets on SIGHUP');
    } catch (error) {
      console.error('[Vault] Failed to reload secrets on SIGHUP:', error.message);
    }
  });
}

// Graceful shutdown handler
const cleanup = async () => {
  console.log('[Shutdown] Cleaning up worker resources...');
  if (vaultService) {
    try {
      await vaultService.cleanup();
      console.log('[Vault] Vault service cleaned up');
    } catch (error) {
      console.error('[Vault] Error during cleanup:', error.message);
    }
  }
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Failover signal handler (SIGUSR2)
let sorobanFailoverHandler = null;
let redisFailoverHandler = null;

if (process.env.ENABLE_FAILOVER_HANDLING === 'true') {
  process.on('SIGUSR2', async () => {
    console.log('[Failover] Received SIGUSR2 signal, handling failover...');
    try {
      const config = await loadConfig(process.env, vaultService);

      if (!sorobanFailoverHandler) {
        sorobanFailoverHandler = getSorobanIndexerFailoverHandler(config);
        await sorobanFailoverHandler.initialize();
      }

      const sorobanResult = await sorobanFailoverHandler.handleFailover();
      console.log('[Failover] Soroban indexer failover result:', sorobanResult);

      if (!redisFailoverHandler) {
        redisFailoverHandler = getRedisCacheFailoverHandler(config);
        await redisFailoverHandler.initialize();
      }

      const redisResult = await redisFailoverHandler.handleFailover({ strategy: 'application' });
      console.log('[Failover] Redis cache clear result:', redisResult);

      console.log('[Failover] Failover handled successfully');
    } catch (error) {
      console.error('[Failover] Failed to handle failover:', error.message);
      process.exit(1);
    }
  });

  console.log('[Failover] Failover handling enabled (SIGUSR2)');
}

/**
 * Standalone background worker process
 */
async function startWorker() {
  console.log('Starting SubStream Background Worker...');

  // Initialize Vault if enabled
  if (vaultService) {
    try {
      await vaultService.initialize();
      console.log('[Vault] Vault service initialized successfully');
    } catch (vaultError) {
      console.error('[Vault] Vault initialization failed, continuing with environment variables:', vaultError.message);
    }
  }

  const config = await loadConfig(process.env, vaultService);

  // RabbitMQ Check
  if (!config.rabbitmq || (!config.rabbitmq.url && !config.rabbitmq.host)) {
    console.error('RabbitMQ configuration is missing. Please set RABBITMQ_URL or RABBITMQ_HOST environment variables.');
    process.exit(1);
  }

  const worker = new BackgroundWorkerService(config.rabbitmq);

  // Handle graceful shutdown for main background worker
  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`);
    try {
      await worker.stop();
      console.log('Background worker stopped successfully');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Start the main background worker
  try {
    await worker.start();
    console.log('Background worker started successfully');
    console.log('Processing events from queues:');
    console.log(`  - Events: ${config.rabbitmq.eventQueue}`);
    console.log(`  - Notifications: ${config.rabbitmq.notificationQueue}`);
    console.log(`  - Emails: ${config.rabbitmq.emailQueue}`);
    console.log(`  - Leaderboard: ${config.rabbitmq.leaderboardQueue}`);
  } catch (error) {
    console.error('Failed to start background worker:', error);
    process.exit(1);
  }
}

// ========================
// Worker Routing Logic
// ========================

const args = process.argv.slice(2);

if (args.includes('--soroban')) {
  // Start Soroban Indexer Worker
  console.log('[Worker] Starting Soroban Indexer...');
  const sorobanWorker = new SorobanIndexerWorker();

  if (args.includes('--health')) {
    sorobanWorker.healthCheck()
      .then(health => {
        console.log(JSON.stringify(health, null, 2));
        process.exit(health.healthy ? 0 : 1);
      })
      .catch((error) => {
        console.error('Soroban worker health check failed:', error);
        process.exit(1);
      });
  } else {
    sorobanWorker.start().catch(error => {
      console.error('Failed to start Soroban worker:', error);
      process.exit(1);
    });
  }

} else if (args.includes('--reconciliation')) {
  // Start Reconciliation Worker
  console.log('[Worker] Starting Reconciliation Worker...');
  const reconciliationWorker = new ReconciliationWorker();

  if (args.includes('--health')) {
    // Health check for reconciliation worker
    console.log('[Worker] Reconciliation Worker health check');
    console.log(JSON.stringify({
      status: 'healthy',
      isRunning: reconciliationWorker.isRunning,
      stats: reconciliationWorker.getStats()
    }, null, 2));
    process.exit(0);
  } else {
    reconciliationWorker.start().catch(error => {
      console.error('Failed to start Reconciliation worker:', error);
      process.exit(1);
    });
  }

} else {
  // Start Main Background Worker + Webhook Dispatcher
  if (args.includes('--health')) {
    const config = loadConfig();
    const worker = new BackgroundWorkerService(config.rabbitmq);

    worker.start()
      .then(() => {
        const status = worker.getStatus();
        console.log(JSON.stringify(status, null, 2));
        process.exit(status.isRunning && status.connected ? 0 : 1);
      })
      .catch((error) => {
        console.error('Health check failed:', error);
        process.exit(1);
      });
  } else {
    startWorker();

    // === Start Merchant Webhook Dispatcher Worker ===
    console.log('[Worker] Starting Merchant Webhook Dispatcher...');
    try {
      require('./src/workers/webhookWorker');
    } catch (error) {
      console.error('[Worker] Failed to start Webhook Dispatcher:', error.message);
      // Don't crash the whole worker if webhook fails to start
    }

    // === NEW: Start Enhanced Churn Risk Worker ===
    console.log('[Worker] Starting Enhanced Churn Risk Worker...');
    try {
      const churnRiskWorker = new EnhancedChurnRiskWorker({
        runInterval: 24 * 60 * 60 * 1000, // 24 hours
        initialDelay: 10 * 60 * 1000, // 10 minutes
        merchantBatchSize: 10,
        subscriberBatchSize: 1000,
        enableDetailedLogging: process.env.CHURN_RISK_DEBUG === 'true'
      });
      
      churnRiskWorker.start().then(() => {
        console.log('[Worker] Enhanced Churn Risk Worker started successfully');
      }).catch(error => {
        console.error('[Worker] Failed to start Enhanced Churn Risk Worker:', error.message);
      });
    } catch (error) {
      console.error('[Worker] Failed to initialize Enhanced Churn Risk Worker:', error.message);
      // Don't crash the whole worker if churn risk worker fails to start
    }
  }
}

// Keep the process alive when running as background worker
if (!args.includes('--soroban') && !args.includes('--health')) {
  process.stdin.resume();
}