const { Worker } = require('bullmq');
const winston = require('winston');
const { SUBSCRIPTION_EVENT_TYPES, deriveQueueName } = require('./sorobanSubscriptionQueueManager');

/**
 * Default concurrency settings per event type.
 * These are conservative starting points that can be overridden via config.
 *
 * PaymentFailed is deliberately kept at a lower concurrency so that dunning
 * side-effects (emails, retries, webhooks) don't overwhelm downstream services
 * during a billing spike.
 */
const DEFAULT_CONCURRENCY = {
  [SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED]: 10,
  [SUBSCRIPTION_EVENT_TYPES.TRIAL_STARTED]: 8,
  [SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED]: 4,
  [SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED_GRACE_PERIOD]: 4,
};

/**
 * Soroban Event Worker Pool
 *
 * Spins up one isolated BullMQ Worker per on-chain event type. Each worker
 * runs with its own concurrency, processor function, and error tracking so
 * that a failure storm in one category cannot starve or destabilise workers
 * handling other categories.
 *
 * Dependency injection via the `processors` map makes the pool fully testable
 * without a live Redis or RabbitMQ connection.
 */
class SorobanEventWorkerPool {
  /**
   * @param {object} options
   * @param {object} options.config            Application config (from loadConfig())
   * @param {Map<string,Function>} [options.processors]
   *   Map of eventType → async processor function. Falls back to the built-in
   *   no-op processor when an entry is absent (useful in unit tests).
   * @param {object} [options.logger]          Winston-compatible logger
   * @param {object} [options.analyticsService]
   * @param {object} [options.notificationService]
   * @param {object} [options.dunningService]
   * @param {object} [options.webhookDispatcher]
   */
  constructor({
    config,
    processors = new Map(),
    logger = null,
    analyticsService = null,
    notificationService = null,
    dunningService = null,
    webhookDispatcher = null,
  }) {
    this.config = config;
    this.logger = logger || this._buildDefaultLogger(config.logLevel);

    // Injected downstream service handles (optional, wired in production)
    this.analyticsService = analyticsService;
    this.notificationService = notificationService;
    this.dunningService = dunningService;
    this.webhookDispatcher = webhookDispatcher;

    // Custom processor overrides for testing / advanced usage
    this.customProcessors = processors;

    /** @type {Map<string, Worker>} eventType → BullMQ Worker */
    this.workers = new Map();

    /** @type {Map<string, object>} eventType → per-worker stats */
    this.workerStats = new Map();

    this.isRunning = false;
    this.redisConnection = this._buildRedisConnection(config.redis);
  }

  /**
   * Start a dedicated BullMQ worker for every registered event type.
   * Workers begin consuming from their respective queues immediately.
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn('[WorkerPool] Pool is already running');
      return;
    }

    this.logger.info('[WorkerPool] Starting isolated subscription event workers...');

    const queueCfg = this.config.sorobanQueues || {};

    for (const eventType of Object.values(SUBSCRIPTION_EVENT_TYPES)) {
      const queueName = deriveQueueName(eventType);
      const perTypeCfg = queueCfg[eventType] || {};

      const concurrency =
        perTypeCfg.concurrency ??
        queueCfg.defaultConcurrency ??
        DEFAULT_CONCURRENCY[eventType] ??
        5;

      // Initialise per-worker metrics so health checks are always readable
      this.workerStats.set(eventType, {
        processed: 0,
        failed: 0,
        lastProcessedAt: null,
        lastFailedAt: null,
        lastError: null,
      });

      const processor = this.customProcessors.get(eventType) ||
        this._buildProcessor(eventType);

      const worker = new Worker(queueName, processor, {
        connection: this.redisConnection,
        concurrency,
        limiter: perTypeCfg.rateLimiter
          ? { max: perTypeCfg.rateLimiter.max, duration: perTypeCfg.rateLimiter.duration }
          : undefined,
      });

      this._attachWorkerListeners(worker, eventType);
      this.workers.set(eventType, worker);

      this.logger.info(`[WorkerPool] Worker started: ${queueName}`, {
        eventType,
        queueName,
        concurrency,
      });
    }

    this.isRunning = true;
    this.logger.info('[WorkerPool] All isolated event workers are running', {
      count: this.workers.size,
    });
  }

  /**
   * Gracefully drain all workers and close Redis connections.
   * In-flight jobs are allowed to complete before the workers exit.
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('[WorkerPool] Stopping all event workers gracefully...');

    const closeOps = [...this.workers.entries()].map(async ([eventType, worker]) => {
      try {
        await worker.close();
        this.logger.info(`[WorkerPool] Worker stopped: ${deriveQueueName(eventType)}`);
      } catch (error) {
        this.logger.warn(`[WorkerPool] Error stopping worker for ${eventType}`, {
          error: error.message,
        });
      }
    });

    await Promise.all(closeOps);

    this.workers.clear();
    this.isRunning = false;
    this.logger.info('[WorkerPool] All event workers stopped');
  }

  /**
   * Return a health snapshot for all workers and their queues.
   *
   * @returns {object}
   */
  getHealthStatus() {
    const workerHealth = {};

    for (const [eventType] of this.workers) {
      const stats = this.workerStats.get(eventType) || {};
      workerHealth[eventType] = {
        running: true,
        queueName: deriveQueueName(eventType),
        ...stats,
      };
    }

    return {
      isRunning: this.isRunning,
      workerCount: this.workers.size,
      workers: workerHealth,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Processor factory ─────────────────────────────────────────────────────

  /**
   * Build the processor function for a specific event type. Each processor
   * runs the appropriate business-logic handler and updates per-worker metrics.
   *
   * @param {string} eventType
   * @returns {Function}
   */
  _buildProcessor(eventType) {
    return async (job) => {
      const startTime = Date.now();
      const { data } = job;

      this.logger.debug(`[WorkerPool] Processing ${eventType} event`, {
        jobId: job.id,
        transactionHash: data.transactionHash,
        ledgerSequence: data.ledgerSequence,
        attempt: job.attemptsMade + 1,
      });

      try {
        await this._routeEvent(eventType, data);

        const stats = this.workerStats.get(eventType);
        stats.processed += 1;
        stats.lastProcessedAt = new Date().toISOString();

        this.logger.info(`[WorkerPool] ${eventType} event processed`, {
          jobId: job.id,
          transactionHash: data.transactionHash,
          durationMs: Date.now() - startTime,
        });
      } catch (error) {
        const stats = this.workerStats.get(eventType);
        stats.failed += 1;
        stats.lastFailedAt = new Date().toISOString();
        stats.lastError = error.message;

        this.logger.error(`[WorkerPool] ${eventType} event processing failed`, {
          jobId: job.id,
          transactionHash: data.transactionHash,
          attempt: job.attemptsMade + 1,
          error: error.message,
        });

        // Re-throw so BullMQ can apply backoff and retry according to the
        // queue's defaultJobOptions.
        throw error;
      }
    };
  }

  /**
   * Route a decoded event payload to the correct handler based on event type.
   * Each handler is kept deliberately small — heavy orchestration happens in
   * the downstream services that are injected via the constructor.
   *
   * @param {string} eventType
   * @param {object} data  Decoded event payload from the Soroban indexer
   */
  async _routeEvent(eventType, data) {
    switch (eventType) {
      case SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED:
        await this._handleSubscriptionBilled(data);
        break;

      case SUBSCRIPTION_EVENT_TYPES.TRIAL_STARTED:
        await this._handleTrialStarted(data);
        break;

      case SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED:
        await this._handlePaymentFailed(data);
        break;

      case SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED_GRACE_PERIOD:
        await this._handlePaymentFailedGracePeriod(data);
        break;

      default:
        this.logger.warn(`[WorkerPool] Unhandled event type: ${eventType}`, { data });
    }
  }

  /**
   * Handle SubscriptionBilled: record analytics, generate invoice trigger,
   * invalidate caches, and dispatch webhooks.
   *
   * @param {object} data
   */
  async _handleSubscriptionBilled(data) {
    if (this.analyticsService?.recordSubscriptionEvent) {
      await this.analyticsService.recordSubscriptionEvent({
        ...data,
        type: 'SubscriptionBilled',
      });
    }

    if (this.dunningService?.handleSubscriptionBilled) {
      await this.dunningService.handleSubscriptionBilled(data);
    }

    if (this.analyticsService?.invalidateAnalytics) {
      await this.analyticsService.invalidateAnalytics(data.creatorAddress);
    }

    if (this.webhookDispatcher?.dispatch) {
      await this.webhookDispatcher.dispatch(
        data.creatorAddress,
        data.subscriberAddress,
        'subscription.billed',
        data
      );
    }
  }

  /**
   * Handle TrialStarted: record analytics and send a welcome notification.
   *
   * @param {object} data
   */
  async _handleTrialStarted(data) {
    if (this.analyticsService?.recordSubscriptionEvent) {
      await this.analyticsService.recordSubscriptionEvent({
        ...data,
        type: 'TrialStarted',
      });
    }

    if (this.notificationService?.sendCreatorNotification) {
      await this.notificationService.sendCreatorNotification({
        type: 'trial_started',
        creatorId: data.creatorAddress,
        data: {
          subscriberAddress: data.subscriberAddress,
          trialEndDate: data.trialEndDate,
          transactionHash: data.transactionHash,
        },
      });
    }

    if (this.webhookDispatcher?.dispatch) {
      await this.webhookDispatcher.dispatch(
        data.creatorAddress,
        data.subscriberAddress,
        'subscription.trial_started',
        data
      );
    }
  }

  /**
   * Handle PaymentFailed: trigger dunning logic and alert the creator.
   *
   * @param {object} data
   */
  async _handlePaymentFailed(data) {
    if (this.dunningService?.handlePaymentFailed) {
      await this.dunningService.handlePaymentFailed({
        ...data,
        type: 'PaymentFailed',
      });
    }

    if (this.notificationService?.sendCreatorNotification) {
      await this.notificationService.sendCreatorNotification({
        type: 'payment_failed',
        creatorId: data.creatorAddress,
        data: {
          subscriberAddress: data.subscriberAddress,
          reason: data.reason,
          retryCount: data.retryCount,
          transactionHash: data.transactionHash,
        },
      });
    }

    if (this.webhookDispatcher?.dispatch) {
      await this.webhookDispatcher.dispatch(
        data.creatorAddress,
        data.subscriberAddress,
        'subscription.payment_failed',
        data
      );
    }
  }

  /**
   * Handle PaymentFailedGracePeriodStarted: start grace period tracking
   * and notify the subscriber.
   *
   * @param {object} data
   */
  async _handlePaymentFailedGracePeriod(data) {
    if (this.dunningService?.handlePaymentFailed) {
      await this.dunningService.handlePaymentFailed({
        ...data,
        type: 'PaymentFailedGracePeriodStarted',
      });
    }

    if (this.notificationService?.sendCreatorNotification) {
      await this.notificationService.sendCreatorNotification({
        type: 'payment_failed_grace_period',
        creatorId: data.creatorAddress,
        data: {
          subscriberAddress: data.subscriberAddress,
          gracePeriodEnds: data.gracePeriodEnds,
          transactionHash: data.transactionHash,
        },
      });
    }

    if (this.webhookDispatcher?.dispatch) {
      await this.webhookDispatcher.dispatch(
        data.creatorAddress,
        data.subscriberAddress,
        'subscription.grace_period_started',
        data
      );
    }
  }

  // ─── Worker event listeners ────────────────────────────────────────────────

  /**
   * Attach BullMQ lifecycle listeners to a worker for observability.
   *
   * @param {Worker} worker
   * @param {string} eventType
   */
  _attachWorkerListeners(worker, eventType) {
    worker.on('ready', () => {
      this.logger.info(`[WorkerPool] Worker ready: ${deriveQueueName(eventType)}`);
    });

    worker.on('error', (err) => {
      this.logger.error(`[WorkerPool] Worker error (${eventType})`, { error: err.message });
    });

    worker.on('failed', (job, err) => {
      this.logger.warn(`[WorkerPool] Job failed (${eventType})`, {
        jobId: job?.id,
        attempts: job?.attemptsMade,
        error: err.message,
      });
    });

    worker.on('stalled', (jobId) => {
      this.logger.warn(`[WorkerPool] Job stalled (${eventType})`, { jobId });
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
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
      defaultMeta: { service: 'soroban-event-worker-pool' },
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

module.exports = { SorobanEventWorkerPool };
