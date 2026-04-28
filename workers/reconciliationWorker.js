#!/usr/bin/env node

/**
 * Reconciliation Worker Process
 * 
 * This worker runs the reconciliation system independently.
 * It can be started as a separate process or integrated into the main application.
 */

const { ReconciliationManager } = require('../src/services/reconciliationManager');
const { AppDatabase } = require('../src/db/appDatabase');
const { SorobanRpcService } = require('../src/services/sorobanRpcService');
require('dotenv').config();

// Parse command line arguments
const args = process.argv.slice(2);
const isManualRun = args.includes('--manual');
const isHealthCheck = args.includes('--health');
const targetDateArg = args.find(arg => arg.startsWith('--date='));

async function main() {
  try {
    console.log('🔄 Starting Reconciliation Worker...');
    
    // Initialize database connection
    const database = new AppDatabase({
      filename: process.env.DATABASE_PATH || './data/app.db'
    });

    // Initialize Soroban RPC service
    const sorobanRpcService = new SorobanRpcService({
      rpcUrl: process.env.SOROBAN_RPC_URL,
      networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
    });

    // Initialize reconciliation manager
    const reconciliationManager = new ReconciliationManager(database, sorobanRpcService, {
      scheduler: {
        schedule: process.env.RECONCILIATION_SCHEDULE || '0 0 * * *', // UTC midnight
        autoStart: !isManualRun, // Don't auto-start for manual runs
        timezone: 'UTC',
        worker: {
          reportsDir: process.env.RECONCILIATION_REPORTS_DIR || './reports/reconciliation',
          maxRetries: parseInt(process.env.RECONCILIATION_MAX_RETRIES) || 3,
          batchSize: parseInt(process.env.RECONCILIATION_BATCH_SIZE) || 100
        }
      },
      analytics: {
        tolerancePercentage: parseFloat(process.env.RECONCILIATION_TOLERANCE_PERCENTAGE) || 0.01,
        minAmountThreshold: parseFloat(process.env.RECONCILIATION_MIN_AMOUNT_THRESHOLD) || 0.000001,
        cacheTimeout: parseInt(process.env.RECONCILIATION_CACHE_TIMEOUT) || 300000 // 5 minutes
      }
    });

    if (isHealthCheck) {
      // Health check mode
      console.log('🏥 Running health check...');
      const health = await reconciliationManager.healthCheck();
      
      console.log('Health Status:', JSON.stringify(health, null, 2));
      
      if (health.healthy) {
        console.log('✅ Reconciliation Worker is healthy');
        process.exit(0);
      } else {
        console.log('❌ Reconciliation Worker is unhealthy');
        process.exit(1);
      }
    } else if (isManualRun) {
      // Manual run mode
      const targetDate = targetDateArg ? new Date(targetDateArg.split('=')[1]) : new Date();
      
      console.log(`🔧 Running manual reconciliation for ${targetDate.toISOString()}...`);
      
      try {
        const result = await reconciliationManager.runDailyReconciliation(targetDate);
        
        console.log('✅ Manual reconciliation completed successfully');
        console.log('Results:', JSON.stringify(result, null, 2));
        
        process.exit(0);
      } catch (error) {
        console.error('❌ Manual reconciliation failed:', error);
        process.exit(1);
      }
    } else {
      // Scheduler mode (default)
      console.log('⏰ Starting reconciliation scheduler...');
      
      // Set up graceful shutdown
      const gracefulShutdown = async (signal) => {
        console.log(`\n📡 Received ${signal}. Shutting down gracefully...`);
        
        try {
          await reconciliationManager.stop();
          console.log('✅ Reconciliation Worker stopped gracefully');
          process.exit(0);
        } catch (error) {
          console.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      };

      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
      process.on('SIGINT', () => gracefulShutdown('SIGINT'));

      // Start the reconciliation system
      await reconciliationManager.start();
      
      console.log('✅ Reconciliation Worker started successfully');
      console.log('📊 System Status:', JSON.stringify(await reconciliationManager.getSystemStatus(), null, 2));
      
      // Keep the process running
      console.log('⏳ Reconciliation Worker is running. Press Ctrl+C to stop.');
      
      // Set up periodic status logging
      setInterval(async () => {
        try {
          const status = await reconciliationManager.getSystemStatus();
          console.log(`📈 Status: ${status.isRunning ? 'Running' : 'Stopped'}, ` +
                   `Uptime: ${Math.floor(status.uptime / 1000)}s, ` +
                   `Last Run: ${status.manager?.lastReconciliationTime || 'Never'}`);
        } catch (error) {
          console.error('❌ Error getting status:', error.message);
        }
      }, 300000); // Every 5 minutes

    }

  } catch (error) {
    console.error('❌ Failed to start Reconciliation Worker:', error);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run the main function
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
