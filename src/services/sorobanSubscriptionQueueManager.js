const { Queue, QueueEvents } = require('bullmq');
const winston = require('winston');

/**
 * Supported on-chain subscription event types emitted by the Soroban contract.
 * Each entry maps to its own isolated BullMQ queue.
 */
const SUBSCRIPTION_EVENT_TYPES = {
  SUBSCRIPTION_BILLED: 'SubscriptionBilled',
  TRIAL_STARTED: 'TrialStarted',
  PAYMENT_FAILED: 'PaymentFailed',
  PAYMENT_FAILED_GRACE_PERIOD: 'PaymentFailedGracePeriodStarted',
};

/**
 * Derive a deterministic queue name from an event type string.
 * Example: "SubscriptionBilled" → "soroban:subscription_billed"
 *
 * @param {string} eventType
 * @returns {string}
 */
function deriveQueueName(eventType) {
  const slug = eventType
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
  return `soroban:${slug}`;
}

/**
 * Soroban Subscription Queue Manager
 *
 * Creates and manages an isolated BullMQ Queue per on-chain Soroban event type.
 * Isolation ensures that a flood or failure in one event category (e.g. PaymentFailed
 * during a billing spike) cannot starve or corrupt processing of other categories.
 *
 * Queue configuration per event type is read from the application config so that
 * concurrency, rate limits, and retry behaviour can be tuned independently via
 * environment variables without code changes.
 */
class SorobanSubscriptionQueueManager {
  /**
   * @param {object} config    Application config object (from loadConfig())
   * @param {object} [logger]  Winston-compatible logger; defaults to a console logger
   */
  constructor(config, logger = null) {
    this.config = config;
    this.logger = logger || this._buildDefaultLogger(config.logLevel);

    /** @type {Map<string, Queue>} eventType → BullMQ Queue */
    this.queues = new Map();

    /** @type {Map<string, QueueEvents>} eventType → BullMQ QueueEvents */
    this.queueEvents = new Map();

    this.isInitialized = false;

    // Redis connection options forwarded to every BullMQ queue
    this.redisConnection = this._buildRedisConnection(config.redis);
  }

  /**
   * Initialize all per-event-type queues and assert their existence in Redis.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  async initialize() {
    if (this.isInitialized) {
      this.logger.warn('[QueueManager] Already initialized, skipping');
      return;
    }

    this.logger.info('[QueueManager] Initializing isolated Soroban subscription queues...');

    const queueCfg = this.config.sorobanQueues || {};

    for (const eventType of Object.values(SUBSCRIPTION_EVENT_TYPES)) {
      const queueName = deriveQueueName(eventType);
      const perTypeCfg = queueCfg[eventType] || {};

      const queue = new Queue(queueName, {
        connection: this.redisConnection,
        defaultJobOptions: {
          attempts: perTypeCfg.maxAttempts ?? queueCfg.defaultMaxAttempts ?? 5,
          backoff: {
            type: 'exponential',
            delay: perTypeCfg.backoffDelay ?? queueCfg.defaultBackoffDelay ?? 2000,
          },
          removeOnComplete: {
            count: perTypeCfg.retainCompleted ?? queueCfg.defaultRetainCompleted ?? 200,
          },
          removeOnFail: {
            count: perTypeCfg.retainFailed ?? queueCfg.defaultRetainFailed ?? 100,
          },
        },
      });

      this.queues.set(eventType, queue);

      this.logger.info(`[QueueManager] Queue ready: ${queueName}`, {
        eventType,
        queueName,
        maxAttempts: perTypeCfg.maxAttempts ?? queueCfg.defaultMaxAttempts ?? 5,
      });
    }

    this.isInitialized = true;
    this.logger.info('[QueueManager] All isolated subscription queues initialized', {
      count: this.queues.size,
      eventTypes: [...this.queues.keys()],
    });
  }

  /**
   * Enqueue a parsed Soroban event onto its type-specific isolated queue.
   *
   * @param {string} eventType  One of the SUBSCRIPTION_EVENT_TYPES values
   * @param {object} eventData  The enriched event payload to process
   * @returns {Promise<import('bullmq').Job>} The created BullMQ job
   */
  async enqueue(eventType, eventData) {
    if (!this.isInitialized) {
      throw new Error('[QueueManager] Queue manager has not been initialized');
    }

    const queue = this.queues.get(eventType);
    if (!queue) {
      throw new Error(`[QueueManager] No queue registered for event type: ${eventType}`);
    }

    // Stable job ID derived from the on-chain unique key prevents duplicates
    // even if the indexer replays the same ledger range after a restart.
    const jobId = this._buildJobId(eventData);

    try {
      const job = await queue.add(eventType, eventData, {
        jobId,
        // Per-type priority override if configured (lower number = higher priority)
        priority: this._resolvePriority(eventType),
      });

      this.logger.debug('[QueueManager] Event enqueued', {
        eventType,
        jobId: job.id,
        transactionHash: eventData.transactionHash,
        ledgerSequence: eventData.ledgerSequence,
      });

      return job;
    } catch (error) {
      // BullMQ throws when a job with the same ID already exists and the
      // queue is configured with duplicate handling. Treat this as idempotent.
      if (error.message && error.message.includes('Job already exists')) {
        this.logger.debug('[QueueManager] Duplicate job skipped (idempotent)', { jobId, eventType });
        return null;
      }

      this.logger.error('[QueueManager] Failed to enqueue event', {
        eventType,
        jobId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Return the Queue instance for a given event type (used by worker pool).
   *
   * @param {string} eventType
   * @returns {Queue|undefined}
   */
  getQueue(eventType) {
    return this.queues.get(eventType);
  }

  /**
   * Snapshot queue depths for monitoring and health-check endpoints.
   *
   * @returns {Promise<object>}
   */
  async getQueueStats() {
    const stats = {};

    for (const [eventType, queue] of this.queues) {
      try {
        const [waiting, active, failed, completed, delayed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getFailedCount(),
          queue.getCompletedCount(),
          queue.getDelayedCount(),
        ]);

        stats[eventType] = { waiting, active, failed, completed, delayed };
      } catch (error) {
        this.logger.warn(`[QueueManager] Could not fetch stats for ${eventType}`, {
          error: error.message,
        });
        stats[eventType] = { error: error.message };
      }
    }

    return stats;
  }

  /**
   * Gracefully close all queue connections.
   */
  async close() {
    this.logger.info('[QueueManager] Closing all subscription queues...');

    const closeOps = [...this.queues.values()].map(q =>
      q.close().catch(err =>
        this.logger.warn('[QueueManager] Error closing queue', { error: err.message })
      )
    );

    await Promise.all(closeOps);

    this.queues.clear();
    this.queueEvents.clear();
    this.isInitialized = false;

    this.logger.info('[QueueManager] All queues closed');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Build a stable, unique job ID from the event's on-chain identity.
   * This makes re-enqueuing the same on-chain event a no-op (idempotent).
   *
   * @param {object} eventData
   * @returns {string}
   */
  _buildJobId(eventData) {
    const { transactionHash, eventIndex, contractId } = eventData;
    if (!transactionHash || eventIndex === undefined) {
      // Fallback to a timestamp-based ID when the on-chain fields are missing
      return `soroban_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
    return `${contractId || 'unknown'}:${transactionHash}:${eventIndex}`;
  }

  /**
   * Resolve the BullMQ job priority for an event type.
   * PaymentFailed events are given the highest priority so dunning
   * logic is not held behind a billing backlog.
   *
   * @param {string} eventType
   * @returns {number|undefined}
   */
  _resolvePriority(eventType) {
    const priorities = {
      [SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED]: 1,
      [SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED_GRACE_PERIOD]: 2,
      [SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED]: 3,
      [SUBSCRIPTION_EVENT_TYPES.TRIAL_STARTED]: 4,
    };
    return priorities[eventType];
  }

  /**
   * Map application redis config to BullMQ connection options.
   *
   * @param {object} redisCfg
   * @returns {object}
   */
  _buildRedisConnection(redisCfg = {}) {
    if (process.env.REDIS_URL) {
      return { url: process.env.REDIS_URL };
    }
    return {
      host: redisCfg.host || process.env.REDIS_HOST || '127.0.0.1',
      port: Number(redisCfg.port || process.env.REDIS_PORT || 6379),
      password: redisCfg.password || process.env.REDIS_PASSWORD || undefined,
      db: Number(redisCfg.db || process.env.REDIS_DB || 0),
    };
  }

  /**
   * Build a default Winston logger when none is injected.
   *
   * @param {string} [level]
   * @returns {object}
   */
  _buildDefaultLogger(level = 'info') {
    return winston.createLogger({
      level,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'soroban-queue-manager' },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          ),
        }),
      ],
    });
  }
}

module.exports = { SorobanSubscriptionQueueManager, SUBSCRIPTION_EVENT_TYPES, deriveQueueName };
