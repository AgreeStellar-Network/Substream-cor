const Database = require('better-sqlite3');
const request = require('supertest');
const express = require('express');

const {
  SeasonalPauseService,
  PAUSE_STATUS,
  SUBSCRIPTION_SEASONAL_STATUS,
  MS_PER_DAY,
} = require('./src/services/seasonalPauseService');
const { BulkPauseExecutionJob } = require('./src/services/bulkPauseExecutionJob');
const createSeasonalPauseRoutes = require('./routes/seasonalPause');

function makeDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE subscriptions (
      creator_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      subscribed_at TEXT,
      next_billing_date TEXT,
      stripe_plan_id TEXT,
      required_amount REAL DEFAULT 0,
      billing_interval_days INTEGER DEFAULT 30,
      seasonal_status TEXT DEFAULT 'Active',
      paused_pause_id TEXT,
      paused_next_billing_date TEXT,
      PRIMARY KEY (creator_id, wallet_address)
    );
  `);
  return { db };
}

function seedSubscription(database, sub) {
  database.db
    .prepare(
      `INSERT INTO subscriptions (
        creator_id, wallet_address, active, subscribed_at,
        next_billing_date, stripe_plan_id, required_amount, billing_interval_days,
        seasonal_status, paused_pause_id, paused_next_billing_date
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'Active', NULL, NULL)`
    )
    .run(
      sub.creatorId,
      sub.walletAddress,
      new Date('2026-01-01T00:00:00.000Z').toISOString(),
      sub.nextBillingDate,
      sub.planId,
      sub.requiredAmount || 0,
      sub.billingIntervalDays || 30
    );
}

function getSubscription(database, creatorId, walletAddress) {
  return database.db
    .prepare(
      `SELECT creator_id AS creatorId, wallet_address AS walletAddress,
              next_billing_date AS nextBillingDate,
              stripe_plan_id AS stripePlanId,
              seasonal_status AS seasonalStatus,
              paused_pause_id AS pausedPauseId,
              paused_next_billing_date AS pausedNextBillingDate
         FROM subscriptions WHERE creator_id = ? AND wallet_address = ?`
    )
    .get(creatorId, walletAddress);
}

describe('SeasonalPauseService', () => {
  let database;
  let service;
  let now;

  beforeEach(() => {
    database = makeDatabase();
    now = new Date('2026-04-01T00:00:00.000Z');
    service = new SeasonalPauseService({
      database,
      clock: () => now,
      logger: { warn: () => {}, error: () => {} },
    });
  });

  afterEach(() => {
    database.db.close();
  });

  test('bulkPause flips every subscription on a plan to Seasonally_Inactive', async () => {
    seedSubscription(database, {
      creatorId: 'c1',
      walletAddress: 'w1',
      nextBillingDate: '2026-04-15T00:00:00.000Z',
      planId: 'plan-winter',
    });
    seedSubscription(database, {
      creatorId: 'c2',
      walletAddress: 'w2',
      nextBillingDate: '2026-04-20T00:00:00.000Z',
      planId: 'plan-winter',
    });
    seedSubscription(database, {
      creatorId: 'c3',
      walletAddress: 'w3',
      nextBillingDate: '2026-04-12T00:00:00.000Z',
      planId: 'plan-summer',
    });

    const result = await service.bulkPause({
      merchantId: 'merchant-A',
      planIds: ['plan-winter'],
      reason: 'off-season',
      expectedResumeAt: '2026-09-01T00:00:00.000Z',
      pausedBy: 'admin@merchant-A',
    });

    expect(result.pauses).toHaveLength(1);
    expect(result.totalSubscriptionsAffected).toBe(2);
    expect(result.pauses[0].pauseId).toMatch(/^spause_/);

    const w1 = getSubscription(database, 'c1', 'w1');
    expect(w1.seasonalStatus).toBe(SUBSCRIPTION_SEASONAL_STATUS.INACTIVE);
    expect(w1.pausedPauseId).toBe(result.pauses[0].pauseId);
    expect(w1.pausedNextBillingDate).toBe('2026-04-15T00:00:00.000Z');

    // unrelated plan stays active
    const w3 = getSubscription(database, 'c3', 'w3');
    expect(w3.seasonalStatus).toBe(SUBSCRIPTION_SEASONAL_STATUS.ACTIVE);
    expect(w3.pausedPauseId).toBeNull();
  });

  test('bulkPause refuses to overlap two active pauses on the same plan', async () => {
    seedSubscription(database, {
      creatorId: 'c1',
      walletAddress: 'w1',
      nextBillingDate: '2026-04-15T00:00:00.000Z',
      planId: 'plan-winter',
    });

    await service.bulkPause({
      merchantId: 'merchant-A',
      planIds: ['plan-winter'],
    });

    await expect(
      service.bulkPause({
        merchantId: 'merchant-A',
        planIds: ['plan-winter'],
      })
    ).rejects.toThrow(/already has an active seasonal pause/);
  });

  test('isPlanPaused reflects current state, even after resume', async () => {
    seedSubscription(database, {
      creatorId: 'c1',
      walletAddress: 'w1',
      nextBillingDate: '2026-04-15T00:00:00.000Z',
      planId: 'plan-winter',
    });

    expect(service.isPlanPaused('plan-winter')).toBe(false);

    const { pauses } = await service.bulkPause({
      merchantId: 'merchant-A',
      planIds: ['plan-winter'],
    });
    expect(service.isPlanPaused('plan-winter')).toBe(true);

    now = new Date('2026-09-01T00:00:00.000Z');
    await service.bulkResume({ pauseId: pauses[0].pauseId });
    expect(service.isPlanPaused('plan-winter')).toBe(false);
  });

  test('maybeSkipBilling records a skipped cycle exactly once per scheduled date', () => {
    // Create a pause manually so we can test the guard in isolation.
    seedSubscription(database, {
      creatorId: 'c1',
      walletAddress: 'w1',
      nextBillingDate: '2026-04-15T00:00:00.000Z',
      planId: 'plan-winter',
    });
    return service
      .bulkPause({
        merchantId: 'merchant-A',
        planIds: ['plan-winter'],
      })
      .then(({ pauses }) => {
        const skipDate = '2026-04-15T00:00:00.000Z';
        const first = service.maybeSkipBilling({
          planId: 'plan-winter',
          creatorId: 'c1',
          walletAddress: 'w1',
          scheduledBillingDate: skipDate,
          requiredAmount: 9.99,
        });
        expect(first.skipped).toBe(true);
        expect(first.pauseId).toBe(pauses[0].pauseId);
        expect(first.alreadyRecorded).toBe(false);

        // Idempotent retry
        const second = service.maybeSkipBilling({
          planId: 'plan-winter',
          creatorId: 'c1',
          walletAddress: 'w1',
          scheduledBillingDate: skipDate,
          requiredAmount: 9.99,
        });
        expect(second.skipped).toBe(true);
        expect(second.alreadyRecorded).toBe(true);

        const cycles = service.getSkippedCyclesForSubscription({
          creatorId: 'c1',
          walletAddress: 'w1',
        });
        expect(cycles).toHaveLength(1);
        expect(cycles[0].requiredAmount).toBe(9.99);
        expect(cycles[0].reconciled).toBe(0);

        const detail = service.getPauseDetail(pauses[0].pauseId);
        expect(detail.skippedCyclesCount).toBe(1);
      });
  });

  test('maybeSkipBilling is a no-op when the plan is not paused', () => {
    const result = service.maybeSkipBilling({
      planId: 'plan-summer',
      creatorId: 'c1',
      walletAddress: 'w1',
      scheduledBillingDate: '2026-04-15T00:00:00.000Z',
      requiredAmount: 9.99,
    });
    expect(result.skipped).toBe(false);
  });

  test('bulkResume preserves the user paid-for value by shifting next_billing_date forward by the pause duration', async () => {
    // Subscriber paid through April 14; next bill scheduled April 15.
    seedSubscription(database, {
      creatorId: 'c1',
      walletAddress: 'w1',
      nextBillingDate: '2026-04-15T00:00:00.000Z',
      planId: 'plan-winter',
      billingIntervalDays: 30,
    });

    // Pause begins April 1.
    now = new Date('2026-04-01T00:00:00.000Z');
    const { pauses } = await service.bulkPause({
      merchantId: 'merchant-A',
      planIds: ['plan-winter'],
    });

    // Skip the April 15 cycle while paused.
    service.maybeSkipBilling({
      planId: 'plan-winter',
      creatorId: 'c1',
      walletAddress: 'w1',
      scheduledBillingDate: '2026-04-15T00:00:00.000Z',
      requiredAmount: 9.99,
    });

    // Pause for exactly 90 days.
    now = new Date('2026-06-30T00:00:00.000Z');
    const resumeResult = await service.bulkResume({
      pauseId: pauses[0].pauseId,
    });

    expect(resumeResult.pauseDurationMs).toBe(90 * MS_PER_DAY);
    expect(resumeResult.subscriptionsRecalculated).toBe(1);

    const sub = getSubscription(database, 'c1', 'w1');
    expect(sub.seasonalStatus).toBe(SUBSCRIPTION_SEASONAL_STATUS.ACTIVE);
    expect(sub.pausedPauseId).toBeNull();
    expect(sub.pausedNextBillingDate).toBeNull();

    // Original next bill: 2026-04-15. Plus 90 days = 2026-07-14.
    // The user already paid for the cycle starting April 15, so on resume
    // we owe them that full cycle from the resume point — shifting by the
    // pause duration is the precise way to honour it.
    const expectedNext = new Date('2026-04-15T00:00:00.000Z').getTime() + 90 * MS_PER_DAY;
    expect(new Date(sub.nextBillingDate).getTime()).toBe(expectedNext);

    const cycles = service.getSkippedCyclesForSubscription({
      creatorId: 'c1',
      walletAddress: 'w1',
    });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].reconciled).toBe(1);

    const detail = service.getPauseDetail(pauses[0].pauseId);
    expect(detail.status).toBe(PAUSE_STATUS.RESUMED);
    expect(detail.resumedAt).toBe('2026-06-30T00:00:00.000Z');
  });

  test('cancelPause restores subscriptions without reconciling cycles', async () => {
    seedSubscription(database, {
      creatorId: 'c1',
      walletAddress: 'w1',
      nextBillingDate: '2026-04-15T00:00:00.000Z',
      planId: 'plan-winter',
    });

    const { pauses } = await service.bulkPause({
      merchantId: 'merchant-A',
      planIds: ['plan-winter'],
    });

    const cancelled = await service.cancelPause({
      pauseId: pauses[0].pauseId,
      cancelledBy: 'ops@substream',
    });
    expect(cancelled.status).toBe(PAUSE_STATUS.CANCELLED);

    const sub = getSubscription(database, 'c1', 'w1');
    expect(sub.seasonalStatus).toBe(SUBSCRIPTION_SEASONAL_STATUS.ACTIVE);
    expect(sub.nextBillingDate).toBe('2026-04-15T00:00:00.000Z');

    expect(service.isPlanPaused('plan-winter')).toBe(false);
  });
});

describe('BulkPauseExecutionJob', () => {
  test('chunks plan ids and aggregates results', async () => {
    const database = makeDatabase();
    const service = new SeasonalPauseService({
      database,
      logger: { warn: () => {}, error: () => {} },
    });

    for (const planId of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      seedSubscription(database, {
        creatorId: `creator-${planId}`,
        walletAddress: `wallet-${planId}`,
        nextBillingDate: '2026-04-15T00:00:00.000Z',
        planId,
      });
    }

    const job = new BulkPauseExecutionJob({
      seasonalPauseService: service,
      planChunkSize: 2,
    });

    const chunkProgress = [];
    const result = await job.execute({
      merchantId: 'merchant-A',
      planIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
      reason: 'off-season',
      onChunkComplete: (info) =>
        chunkProgress.push({ processed: info.processed, total: info.total }),
    });

    expect(result.requestedPlanCount).toBe(5);
    expect(result.successfulPlanCount).toBe(5);
    expect(result.failedPlanCount).toBe(0);
    expect(result.totalSubscriptionsAffected).toBe(5);
    expect(chunkProgress.map((p) => p.processed)).toEqual([2, 4, 5]);

    database.db.close();
  });
});

describe('seasonalPause routes', () => {
  let database;
  let service;
  let app;

  beforeEach(() => {
    database = makeDatabase();
    service = new SeasonalPauseService({
      database,
      logger: { warn: () => {}, error: () => {} },
    });

    seedSubscription(database, {
      creatorId: 'c1',
      walletAddress: 'w1',
      nextBillingDate: '2026-04-15T00:00:00.000Z',
      planId: 'plan-winter',
    });

    app = express();
    app.use(express.json());
    app.set('database', database);
    app.set('seasonalPauseService', service);
    app.use('/api/seasonal-pause', createSeasonalPauseRoutes());
  });

  afterEach(() => {
    database.db.close();
  });

  test('POST /api/seasonal-pause/bulk pauses plans and 404 on resume of unknown', async () => {
    const res = await request(app)
      .post('/api/seasonal-pause/bulk')
      .send({
        merchantId: 'merchant-A',
        planIds: ['plan-winter'],
        reason: 'off-season',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.successfulPlanCount).toBe(1);
    expect(res.body.data.totalSubscriptionsAffected).toBe(1);
    const pauseId = res.body.data.pauses[0].pauseId;

    const detailRes = await request(app).get(`/api/seasonal-pause/${pauseId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.planId).toBe('plan-winter');

    const missing = await request(app)
      .post('/api/seasonal-pause/spause_doesnotexist/resume')
      .send({});
    expect(missing.status).toBe(404);
  });

  test('POST /api/seasonal-pause/bulk validates input', async () => {
    const r1 = await request(app).post('/api/seasonal-pause/bulk').send({});
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post('/api/seasonal-pause/bulk')
      .send({ merchantId: 'm', planIds: [] });
    expect(r2.status).toBe(400);
  });
});
