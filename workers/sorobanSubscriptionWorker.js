#!/usr/bin/env node

/**
 * Soroban Subscription Worker
 *
 * Standalone process that runs isolated BullMQ workers for every on-chain
 * Soroban subscription event type. Each event type gets its own queue and
 * dedicated worker concurrency so that a spike or failure in one category
 * never affects the throughput of others.
 *
 * Usage:
 *   node workers/sorobanSubscriptionWorker.js
 *   node workers/sorobanSubscriptionWorker.js --health
 *
 * The --health flag performs a quick liveness check and exits with code 0
 * (healthy) or 1 (unhealthy). This is compatible with Kubernetes liveness
 * probes and Docker HEALTHCHECK instructions.
 */

'use strict';

const { loadConfig } = require('../src/config');
const { SorobanSubscriptionQueueManager } = require('../src/services/sorobanSubscriptionQueueManager');
const { SorobanEventWorkerPool } = require('../src/services/sorobanEventWorkerPool');
const winston = require('winston');

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'soroban-subscription-worker' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
    new winston.transports.File({
      filename: 'logs/soroban-subscription-worker-error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/soroban-subscription-worker.log',
    }),
  ],
});

// ─── Globals (kept at module scope so signal handlers can reach them) ─────────

let queueManager = null;
let workerPool = null;
let isShuttingDown = false;

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info(`[Worker] Received ${signal} — shutting down gracefully...`);

  try {
    if (workerPool) {
      await workerPool.stop();
    }
    if (queueManager) {
      await queueManager.close();
    }
    logger.info('[Worker] Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('[Worker] Error during shutdown', { error: error.message });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (error) => {
  logger.error('[Worker] Uncaught exception', { error: error.message, stack: error.stack });
  await shutdown('uncaughtException');
});

process.on('unhandledRejection', async (reason) => {
  logger.error('[Worker] Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  await shutdown('unhandledRejection');
});

// ─── Health check mode ────────────────────────────────────────────────────────

async function runHealthCheck() {
  try {
    const config = await loadConfig(process.env, null);

    // Instantiate a transient queue manager just to verify Redis connectivity
    const manager = new SorobanSubscriptionQueueManager(config, logger);
    await manager.initialize();

    const stats = await manager.getQueueStats();
    await manager.close();

    console.log(JSON.stringify({ healthy: true, queues: stats }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ healthy: false, error: error.message }, null, 2));
    process.exit(1);
  }
}

// ─── Main start sequence ──────────────────────────────────────────────────────

async function start() {
  logger.info('[Worker] Starting Soroban Subscription Event Worker...');

  let config;
  try {
    config = await loadConfig(process.env, null);
  } catch (error) {
    logger.error('[Worker] Failed to load configuration', { error: error.message });
    process.exit(1);
  }

  // Warn when Redis is not explicitly configured — BullMQ will still fall
  // back to localhost:6379 but it's better to be explicit in production.
  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
    logger.warn('[Worker] Neither REDIS_URL nor REDIS_HOST is set; defaulting to 127.0.0.1:6379');
  }

  // ── Queue Manager ─────────────────────────────────────────────────────────
  queueManager = new SorobanSubscriptionQueueManager(config, logger);

  try {
    await queueManager.initialize();
  } catch (error) {
    logger.error('[Worker] Queue manager initialization failed', { error: error.message });
    process.exit(1);
  }

  // ── Worker Pool ───────────────────────────────────────────────────────────
  // Downstream services are not imported here to keep the worker process
  // lightweight. In a production environment you would inject the real
  // analyticsService, dunningService, etc. by requiring them here.
  workerPool = new SorobanEventWorkerPool({ config, logger });

  try {
    await workerPool.start();
  } catch (error) {
    logger.error('[Worker] Worker pool failed to start', { error: error.message });
    await queueManager.close();
    process.exit(1);
  }

  logger.info('[Worker] Soroban Subscription Event Worker is running');
  logger.info('[Worker] Press Ctrl+C to stop');

  // Periodic stats logging so operators can observe throughput without
  // reaching for an external dashboard.
  const statsInterval = setInterval(async () => {
    try {
      const queueStats = await queueManager.getQueueStats();
      const workerHealth = workerPool.getHealthStatus();

      logger.info('[Worker] Periodic stats snapshot', {
        queues: queueStats,
        workers: workerHealth.workers,
      });
    } catch (error) {
      logger.warn('[Worker] Failed to collect stats', { error: error.message });
    }
  }, Number(process.env.SOROBAN_WORKER_STATS_INTERVAL_MS || 60_000));

  // Ensure the interval is cleaned up on exit so Node can drain properly
  process.on('beforeExit', () => clearInterval(statsInterval));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--health')) {
  runHealthCheck();
} else {
  start().catch((error) => {
    logger.error('[Worker] Fatal startup error', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}
