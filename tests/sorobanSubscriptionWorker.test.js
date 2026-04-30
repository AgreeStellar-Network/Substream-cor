/**
 * Tests for the isolated Soroban subscription worker queues (Issue #230).
 *
 * Covers:
 *  - SorobanSubscriptionQueueManager  (queue lifecycle, enqueue, idempotency)
 *  - SorobanEventWorkerPool           (worker lifecycle, routing, error handling)
 */

const {
  SorobanSubscriptionQueueManager,
  SUBSCRIPTION_EVENT_TYPES,
  deriveQueueName,
} = require('../src/services/sorobanSubscriptionQueueManager');
const { SorobanEventWorkerPool } = require('../src/services/sorobanEventWorkerPool');

// ── BullMQ mock ──────────────────────────────────────────────────────────────
jest.mock('bullmq');

// ── Winston mock (keeps test output clean) ───────────────────────────────────
jest.mock('winston', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return {
    createLogger: jest.fn(() => mockLogger),
    format: {
      combine: jest.fn(),
      timestamp: jest.fn(),
      errors: jest.fn(),
      json: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
    },
    transports: {
      Console: jest.fn(),
      File: jest.fn(),
    },
  };
});

// ── Shared fixtures ──────────────────────────────────────────────────────────

function buildMockConfig(overrides = {}) {
  return {
    logLevel: 'error',
    redis: { host: 'localhost', port: 6379 },
    sorobanQueues: {
      defaultMaxAttempts: 5,
      defaultBackoffDelay: 2000,
      defaultConcurrency: 5,
      defaultRetainCompleted: 200,
      defaultRetainFailed: 100,
    },
    ...overrides,
  };
}

function buildMockEvent(overrides = {}) {
  return {
    transactionHash: 'abc123txhash',
    eventIndex: 0,
    contractId: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
    ledgerSequence: 100,
    ledgerTimestamp: new Date().toISOString(),
    subscriberAddress: 'GSUBSCRIBER',
    creatorAddress: 'GCREATOR',
    amount: '10.00',
    currency: 'XLM',
    ...overrides,
  };
}

// ── SorobanSubscriptionQueueManager ─────────────────────────────────────────

describe('SorobanSubscriptionQueueManager', () => {
  let queueManager;
  let mockQueue;
  let config;

  beforeEach(() => {
    const { Queue } = require('bullmq');

    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
      close: jest.fn().mockResolvedValue(undefined),
      getWaitingCount: jest.fn().mockResolvedValue(0),
      getActiveCount: jest.fn().mockResolvedValue(0),
      getFailedCount: jest.fn().mockResolvedValue(0),
      getCompletedCount: jest.fn().mockResolvedValue(0),
      getDelayedCount: jest.fn().mockResolvedValue(0),
    };

    Queue.mockImplementation(() => mockQueue);

    config = buildMockConfig();
    queueManager = new SorobanSubscriptionQueueManager(config);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── deriveQueueName helper ────────────────────────────────────────────────

  describe('deriveQueueName', () => {
    test('converts SubscriptionBilled to soroban:subscription_billed', () => {
      expect(deriveQueueName('SubscriptionBilled')).toBe('soroban:subscription_billed');
    });

    test('converts TrialStarted to soroban:trial_started', () => {
      expect(deriveQueueName('TrialStarted')).toBe('soroban:trial_started');
    });

    test('converts PaymentFailed to soroban:payment_failed', () => {
      expect(deriveQueueName('PaymentFailed')).toBe('soroban:payment_failed');
    });

    test('converts PaymentFailedGracePeriodStarted to soroban:payment_failed_grace_period_started', () => {
      expect(deriveQueueName('PaymentFailedGracePeriodStarted')).toBe(
        'soroban:payment_failed_grace_period_started'
      );
    });
  });

  // ── SUBSCRIPTION_EVENT_TYPES ──────────────────────────────────────────────

  describe('SUBSCRIPTION_EVENT_TYPES', () => {
    test('exports all four required event type constants', () => {
      expect(SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED).toBe('SubscriptionBilled');
      expect(SUBSCRIPTION_EVENT_TYPES.TRIAL_STARTED).toBe('TrialStarted');
      expect(SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED).toBe('PaymentFailed');
      expect(SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED_GRACE_PERIOD).toBe(
        'PaymentFailedGracePeriodStarted'
      );
    });
  });

  // ── initialize ────────────────────────────────────────────────────────────

  describe('initialize', () => {
    test('creates a dedicated Queue for every event type', async () => {
      const { Queue } = require('bullmq');
      await queueManager.initialize();

      expect(Queue).toHaveBeenCalledTimes(Object.values(SUBSCRIPTION_EVENT_TYPES).length);
    });

    test('marks the manager as initialized after first call', async () => {
      await queueManager.initialize();
      expect(queueManager.isInitialized).toBe(true);
    });

    test('subsequent initialize() calls are no-ops (idempotent)', async () => {
      const { Queue } = require('bullmq');
      await queueManager.initialize();
      await queueManager.initialize();

      // Queue should only have been constructed once per event type
      expect(Queue).toHaveBeenCalledTimes(Object.values(SUBSCRIPTION_EVENT_TYPES).length);
    });

    test('stores queues keyed by event type string', async () => {
      await queueManager.initialize();

      for (const eventType of Object.values(SUBSCRIPTION_EVENT_TYPES)) {
        expect(queueManager.getQueue(eventType)).toBe(mockQueue);
      }
    });
  });

  // ── enqueue ───────────────────────────────────────────────────────────────

  describe('enqueue', () => {
    beforeEach(async () => {
      await queueManager.initialize();
    });

    test('enqueues a SubscriptionBilled event and returns a job', async () => {
      const event = buildMockEvent();
      const job = await queueManager.enqueue(SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED, event);

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(job).toEqual({ id: 'job-1' });
    });

    test('constructs a stable job ID from transactionHash and eventIndex', async () => {
      const event = buildMockEvent({ transactionHash: 'hash99', eventIndex: 3 });
      await queueManager.enqueue(SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED, event);

      const [, , callOptions] = mockQueue.add.mock.calls[0];
      expect(callOptions.jobId).toContain('hash99');
      expect(callOptions.jobId).toContain('3');
    });

    test('assigns PaymentFailed the highest job priority', async () => {
      const event = buildMockEvent();
      await queueManager.enqueue(SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED, event);

      const [, , callOptions] = mockQueue.add.mock.calls[0];
      expect(callOptions.priority).toBe(1);
    });

    test('assigns TrialStarted a lower priority than PaymentFailed', async () => {
      const event = buildMockEvent();
      await queueManager.enqueue(SUBSCRIPTION_EVENT_TYPES.TRIAL_STARTED, event);

      const [, , callOptions] = mockQueue.add.mock.calls[0];
      expect(callOptions.priority).toBeGreaterThan(1);
    });

    test('throws when called before initialize()', async () => {
      const uninitializedManager = new SorobanSubscriptionQueueManager(config);
      await expect(
        uninitializedManager.enqueue(SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED, buildMockEvent())
      ).rejects.toThrow(/not been initialized/);
    });

    test('throws for an unknown event type', async () => {
      await expect(
        queueManager.enqueue('UnknownEventType', buildMockEvent())
      ).rejects.toThrow(/No queue registered/);
    });

    test('silently skips duplicate jobs (idempotent)', async () => {
      mockQueue.add.mockRejectedValueOnce(new Error('Job already exists'));

      const result = await queueManager.enqueue(
        SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED,
        buildMockEvent()
      );

      expect(result).toBeNull();
    });

    test('rethrows non-duplicate errors from the queue', async () => {
      mockQueue.add.mockRejectedValueOnce(new Error('Redis connection refused'));

      await expect(
        queueManager.enqueue(SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED, buildMockEvent())
      ).rejects.toThrow('Redis connection refused');
    });
  });

  // ── getQueueStats ─────────────────────────────────────────────────────────

  describe('getQueueStats', () => {
    test('returns counts for every registered event type', async () => {
      await queueManager.initialize();
      const stats = await queueManager.getQueueStats();

      for (const eventType of Object.values(SUBSCRIPTION_EVENT_TYPES)) {
        expect(stats[eventType]).toBeDefined();
        expect(stats[eventType]).toMatchObject({
          waiting: 0,
          active: 0,
          failed: 0,
          completed: 0,
          delayed: 0,
        });
      }
    });

    test('returns an error field when a queue stat call fails', async () => {
      mockQueue.getWaitingCount.mockRejectedValueOnce(new Error('timeout'));
      await queueManager.initialize();

      const stats = await queueManager.getQueueStats();

      // At least one event type should have the error field
      const hasError = Object.values(stats).some(s => s.error !== undefined);
      expect(hasError).toBe(true);
    });
  });

  // ── close ─────────────────────────────────────────────────────────────────

  describe('close', () => {
    test('closes every queue and clears internal state', async () => {
      await queueManager.initialize();
      await queueManager.close();

      expect(mockQueue.close).toHaveBeenCalledTimes(
        Object.values(SUBSCRIPTION_EVENT_TYPES).length
      );
      expect(queueManager.isInitialized).toBe(false);
      expect(queueManager.queues.size).toBe(0);
    });
  });
});

// ── SorobanEventWorkerPool ───────────────────────────────────────────────────

describe('SorobanEventWorkerPool', () => {
  let workerPool;
  let mockWorker;
  let config;

  beforeEach(() => {
    const { Worker } = require('bullmq');

    mockWorker = {
      on: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    Worker.mockImplementation(() => mockWorker);

    config = buildMockConfig();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── constructor ───────────────────────────────────────────────────────────

  describe('constructor', () => {
    test('initializes in a stopped state', () => {
      workerPool = new SorobanEventWorkerPool({ config });
      expect(workerPool.isRunning).toBe(false);
      expect(workerPool.workers.size).toBe(0);
    });

    test('accepts injected downstream services', () => {
      const mockAnalytics = { recordSubscriptionEvent: jest.fn() };
      workerPool = new SorobanEventWorkerPool({
        config,
        analyticsService: mockAnalytics,
      });
      expect(workerPool.analyticsService).toBe(mockAnalytics);
    });
  });

  // ── start ─────────────────────────────────────────────────────────────────

  describe('start', () => {
    beforeEach(() => {
      workerPool = new SorobanEventWorkerPool({ config });
    });

    test('creates a dedicated Worker for every event type', async () => {
      const { Worker } = require('bullmq');
      await workerPool.start();

      expect(Worker).toHaveBeenCalledTimes(Object.values(SUBSCRIPTION_EVENT_TYPES).length);
      expect(workerPool.isRunning).toBe(true);
    });

    test('subsequent start() calls are no-ops', async () => {
      const { Worker } = require('bullmq');
      await workerPool.start();
      await workerPool.start();

      expect(Worker).toHaveBeenCalledTimes(Object.values(SUBSCRIPTION_EVENT_TYPES).length);
    });

    test('attaches lifecycle listeners to every worker', async () => {
      await workerPool.start();

      // Each worker gets: ready, error, failed, stalled  (4 listeners)
      expect(mockWorker.on).toHaveBeenCalledTimes(
        Object.values(SUBSCRIPTION_EVENT_TYPES).length * 4
      );
    });

    test('initialises per-worker stats counters', async () => {
      await workerPool.start();

      for (const eventType of Object.values(SUBSCRIPTION_EVENT_TYPES)) {
        const stats = workerPool.workerStats.get(eventType);
        expect(stats).toBeDefined();
        expect(stats.processed).toBe(0);
        expect(stats.failed).toBe(0);
      }
    });

    test('uses per-type concurrency from config when provided', async () => {
      const { Worker } = require('bullmq');
      const configWithConcurrency = buildMockConfig({
        sorobanQueues: {
          defaultConcurrency: 2,
          SubscriptionBilled: { concurrency: 15 },
        },
      });

      workerPool = new SorobanEventWorkerPool({ config: configWithConcurrency });
      await workerPool.start();

      const billedCall = Worker.mock.calls.find(([queueName]) =>
        queueName === 'soroban:subscription_billed'
      );
      expect(billedCall).toBeDefined();
      expect(billedCall[2].concurrency).toBe(15);
    });

    test('falls back to default concurrency when per-type config is absent', async () => {
      const { Worker } = require('bullmq');
      await workerPool.start();

      // All workers should have concurrency set (not undefined)
      Worker.mock.calls.forEach(([, , opts]) => {
        // concurrency is either from config, the per-type default, or the constant default
        expect(opts.concurrency).toBeGreaterThan(0);
      });
    });
  });

  // ── stop ──────────────────────────────────────────────────────────────────

  describe('stop', () => {
    test('closes every worker and marks pool as stopped', async () => {
      workerPool = new SorobanEventWorkerPool({ config });
      await workerPool.start();
      await workerPool.stop();

      expect(mockWorker.close).toHaveBeenCalledTimes(
        Object.values(SUBSCRIPTION_EVENT_TYPES).length
      );
      expect(workerPool.isRunning).toBe(false);
      expect(workerPool.workers.size).toBe(0);
    });

    test('stop() before start() is a safe no-op', async () => {
      workerPool = new SorobanEventWorkerPool({ config });
      await expect(workerPool.stop()).resolves.toBeUndefined();
    });
  });

  // ── getHealthStatus ───────────────────────────────────────────────────────

  describe('getHealthStatus', () => {
    test('reports isRunning=false before start()', () => {
      workerPool = new SorobanEventWorkerPool({ config });
      const health = workerPool.getHealthStatus();
      expect(health.isRunning).toBe(false);
      expect(health.workerCount).toBe(0);
    });

    test('reports all workers as running after start()', async () => {
      workerPool = new SorobanEventWorkerPool({ config });
      await workerPool.start();
      const health = workerPool.getHealthStatus();

      expect(health.isRunning).toBe(true);
      expect(health.workerCount).toBe(Object.values(SUBSCRIPTION_EVENT_TYPES).length);

      for (const eventType of Object.values(SUBSCRIPTION_EVENT_TYPES)) {
        expect(health.workers[eventType]).toBeDefined();
        expect(health.workers[eventType].running).toBe(true);
      }
    });

    test('includes a timestamp in the health snapshot', async () => {
      workerPool = new SorobanEventWorkerPool({ config });
      await workerPool.start();
      const health = workerPool.getHealthStatus();

      expect(health.timestamp).toBeDefined();
      expect(() => new Date(health.timestamp)).not.toThrow();
    });
  });

  // ── _routeEvent (processor routing) ──────────────────────────────────────

  describe('_routeEvent', () => {
    let mockAnalytics;
    let mockNotification;
    let mockDunning;
    let mockWebhook;

    beforeEach(() => {
      mockAnalytics = {
        recordSubscriptionEvent: jest.fn().mockResolvedValue(undefined),
        invalidateAnalytics: jest.fn().mockResolvedValue(undefined),
      };
      mockNotification = {
        sendCreatorNotification: jest.fn().mockResolvedValue(undefined),
      };
      mockDunning = {
        handlePaymentFailed: jest.fn().mockResolvedValue(undefined),
        handleSubscriptionBilled: jest.fn().mockResolvedValue(undefined),
      };
      mockWebhook = {
        dispatch: jest.fn().mockResolvedValue(undefined),
      };

      workerPool = new SorobanEventWorkerPool({
        config,
        analyticsService: mockAnalytics,
        notificationService: mockNotification,
        dunningService: mockDunning,
        webhookDispatcher: mockWebhook,
      });
    });

    test('SubscriptionBilled triggers analytics, dunning, cache invalidation and webhook', async () => {
      const event = buildMockEvent();
      await workerPool._routeEvent(SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED, event);

      expect(mockAnalytics.recordSubscriptionEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'SubscriptionBilled' })
      );
      expect(mockDunning.handleSubscriptionBilled).toHaveBeenCalledWith(event);
      expect(mockAnalytics.invalidateAnalytics).toHaveBeenCalledWith(event.creatorAddress);
      expect(mockWebhook.dispatch).toHaveBeenCalledWith(
        event.creatorAddress,
        event.subscriberAddress,
        'subscription.billed',
        event
      );
    });

    test('TrialStarted triggers analytics, creator notification and webhook', async () => {
      const event = buildMockEvent({ trialEndDate: '2025-12-01' });
      await workerPool._routeEvent(SUBSCRIPTION_EVENT_TYPES.TRIAL_STARTED, event);

      expect(mockAnalytics.recordSubscriptionEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TrialStarted' })
      );
      expect(mockNotification.sendCreatorNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'trial_started' })
      );
      expect(mockWebhook.dispatch).toHaveBeenCalledWith(
        event.creatorAddress,
        event.subscriberAddress,
        'subscription.trial_started',
        event
      );
    });

    test('PaymentFailed triggers dunning, creator notification and webhook', async () => {
      const event = buildMockEvent({ reason: 'insufficient_balance', retryCount: 1 });
      await workerPool._routeEvent(SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED, event);

      expect(mockDunning.handlePaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PaymentFailed' })
      );
      expect(mockNotification.sendCreatorNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payment_failed' })
      );
      expect(mockWebhook.dispatch).toHaveBeenCalledWith(
        event.creatorAddress,
        event.subscriberAddress,
        'subscription.payment_failed',
        event
      );
    });

    test('PaymentFailedGracePeriodStarted triggers dunning, notification and webhook', async () => {
      const event = buildMockEvent({ gracePeriodEnds: '2025-06-01' });
      await workerPool._routeEvent(SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED_GRACE_PERIOD, event);

      expect(mockDunning.handlePaymentFailed).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'PaymentFailedGracePeriodStarted' })
      );
      expect(mockNotification.sendCreatorNotification).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payment_failed_grace_period' })
      );
      expect(mockWebhook.dispatch).toHaveBeenCalledWith(
        event.creatorAddress,
        event.subscriberAddress,
        'subscription.grace_period_started',
        event
      );
    });

    test('unknown event type is handled without throwing', async () => {
      await expect(
        workerPool._routeEvent('SomeFutureEventType', buildMockEvent())
      ).resolves.toBeUndefined();
    });

    test('downstream service errors propagate upward (BullMQ will retry)', async () => {
      mockDunning.handlePaymentFailed.mockRejectedValueOnce(new Error('dunning down'));

      await expect(
        workerPool._routeEvent(SUBSCRIPTION_EVENT_TYPES.PAYMENT_FAILED, buildMockEvent())
      ).rejects.toThrow('dunning down');
    });
  });

  // ── custom processor injection ────────────────────────────────────────────

  describe('custom processor injection', () => {
    test('uses an injected processor instead of the built-in one', async () => {
      const { Worker } = require('bullmq');
      const customProcessor = jest.fn().mockResolvedValue('custom-result');
      const processors = new Map([
        [SUBSCRIPTION_EVENT_TYPES.SUBSCRIPTION_BILLED, customProcessor],
      ]);

      workerPool = new SorobanEventWorkerPool({ config, processors });
      await workerPool.start();

      // The Worker for SubscriptionBilled should have received the custom processor
      const billedCall = Worker.mock.calls.find(([queueName]) =>
        queueName === 'soroban:subscription_billed'
      );
      expect(billedCall).toBeDefined();
      expect(billedCall[1]).toBe(customProcessor);
    });
  });
});
