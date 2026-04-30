const crypto = require('crypto');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PAUSE_STATUS = Object.freeze({
  ACTIVE: 'active',
  RESUMED: 'resumed',
  CANCELLED: 'cancelled',
});
const SUBSCRIPTION_SEASONAL_STATUS = Object.freeze({
  ACTIVE: 'Active',
  INACTIVE: 'Seasonally_Inactive',
});
const DEFAULT_BULK_BATCH_SIZE = 1000;
const MAX_PLANS_PER_PAUSE = 10000;

/**
 * SeasonalPauseService
 *
 * Off-chain bulk pause/resume for enterprise merchants (e.g. seasonal
 * streaming services) so they don't have to broadcast 100k on-chain
 * transactions to halt billing for their off-season.
 *
 * Responsibilities:
 *   1. bulkPause(planIds): mark every subscription on each plan as
 *      Seasonally_Inactive in a single transaction-per-batch so 100k
 *      rows update in seconds, not hours.
 *   2. maybeSkipBilling(...): a guard the indexer / pre-billing worker
 *      calls before any pull attempt — paused plans return skipped:true
 *      and a skipped_cycle row is recorded for later reconciliation.
 *   3. bulkResume(pauseId): re-activate subscriptions and recompute
 *      next_billing_date so the user's paid-for value from the previous
 *      season is preserved (we shift forward by the pause duration).
 */
class SeasonalPauseService {
  /**
   * @param {{
   *   database: any,
   *   logger?: any,
   *   batchSize?: number,
   *   clock?: () => Date,
   *   planResolver?: (planId: string) => Array<{creatorId: string, walletAddress: string, nextBillingDate: string|null, requiredAmount: number, billingIntervalDays: number}>,
   * }} options
   */
  constructor({ database, logger, batchSize, clock, planResolver } = {}) {
    if (!database) throw new Error('database is required');
    this.database = database;
    this.logger = logger || console;
    this.batchSize = batchSize || DEFAULT_BULK_BATCH_SIZE;
    this.clock = clock || (() => new Date());
    this.planResolver = planResolver || null;

    // In-process cache of currently-paused plan ids. Refreshed lazily on
    // pause/resume and on the first call to isPlanPaused(). Sized for ~50k
    // distinct plan ids — this is bounded by the merchant fleet, not the
    // subscription count.
    this._pausedPlanCache = null;

    this.ensureSchema();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Schema bootstrap (idempotent — used by tests against an in-memory SQLite
  // database, and as a safety net when the knex migration hasn't run yet).
  // ────────────────────────────────────────────────────────────────────────

  ensureSchema() {
    const db = this.database.db || this.database;
    if (!db || typeof db.exec !== 'function') return;

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS seasonal_pauses (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          reason TEXT,
          paused_at TEXT NOT NULL,
          paused_by TEXT,
          expected_resume_at TEXT,
          resumed_at TEXT,
          resumed_by TEXT,
          subscriptions_affected INTEGER NOT NULL DEFAULT 0,
          skipped_cycles_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_seasonal_pauses_merchant_status
          ON seasonal_pauses (merchant_id, status);
        CREATE INDEX IF NOT EXISTS idx_seasonal_pauses_plan_status
          ON seasonal_pauses (plan_id, status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_seasonal_pauses_one_active_per_plan
          ON seasonal_pauses (plan_id) WHERE status = 'active';

        CREATE TABLE IF NOT EXISTS subscription_skipped_cycles (
          id TEXT PRIMARY KEY,
          pause_id TEXT NOT NULL REFERENCES seasonal_pauses(id),
          merchant_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          creator_id TEXT NOT NULL,
          wallet_address TEXT NOT NULL,
          scheduled_billing_date TEXT NOT NULL,
          required_amount REAL NOT NULL DEFAULT 0,
          skipped_at TEXT NOT NULL,
          reconciled INTEGER NOT NULL DEFAULT 0,
          reconciled_at TEXT,
          UNIQUE (pause_id, creator_id, wallet_address, scheduled_billing_date)
        );

        CREATE INDEX IF NOT EXISTS idx_skipped_cycles_pause
          ON subscription_skipped_cycles (pause_id);
        CREATE INDEX IF NOT EXISTS idx_skipped_cycles_subscription
          ON subscription_skipped_cycles (creator_id, wallet_address);
        CREATE INDEX IF NOT EXISTS idx_skipped_cycles_plan
          ON subscription_skipped_cycles (plan_id);
      `);

      // Subscriptions table may exist with a different shape across deployments
      // (this codebase mixes SQLite test databases with managed Postgres).
      // PRAGMA is sqlite-only and used only in dev/test — silently ignore on
      // other engines.
      try {
        const cols = db.prepare('PRAGMA table_info(subscriptions);').all();
        const has = (name) => cols.some((c) => c.name === name);

        if (cols.length > 0) {
          if (!has('seasonal_status')) {
            db.exec(
              "ALTER TABLE subscriptions ADD COLUMN seasonal_status TEXT DEFAULT 'Active'"
            );
          }
          if (!has('paused_pause_id')) {
            db.exec('ALTER TABLE subscriptions ADD COLUMN paused_pause_id TEXT');
          }
          if (!has('paused_next_billing_date')) {
            db.exec(
              'ALTER TABLE subscriptions ADD COLUMN paused_next_billing_date TEXT'
            );
          }
          if (!has('billing_interval_days')) {
            db.exec(
              'ALTER TABLE subscriptions ADD COLUMN billing_interval_days INTEGER DEFAULT 30'
            );
          }
          if (!has('next_billing_date')) {
            // preBillingHealthCheck would have added this; ensure it exists
            // for direct test setups too.
            db.exec('ALTER TABLE subscriptions ADD COLUMN next_billing_date TEXT');
          }
          if (!has('stripe_plan_id')) {
            db.exec('ALTER TABLE subscriptions ADD COLUMN stripe_plan_id TEXT');
          }

          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_subscriptions_seasonal_status
              ON subscriptions (seasonal_status);
            CREATE INDEX IF NOT EXISTS idx_subscriptions_paused_pause_id
              ON subscriptions (paused_pause_id);
            CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_plan_id
              ON subscriptions (stripe_plan_id);
          `);
        }
      } catch (_pragmaError) {
        // Non-sqlite engine: the knex migration is responsible for the schema.
      }
    } catch (error) {
      this.logger.warn &&
        this.logger.warn('SeasonalPauseService.ensureSchema failed:', error.message);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // bulkPause: the entry point used by the bulk_pause_execution job.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Mark every subscription on the given plans as Seasonally_Inactive.
   * Returns one pause record per plan id.
   *
   * @param {{
   *   merchantId: string,
   *   planIds: string[],
   *   reason?: string,
   *   expectedResumeAt?: string|Date|null,
   *   pausedBy?: string,
   * }} input
   */
  async bulkPause(input) {
    const merchantId = String(input?.merchantId || '').trim();
    const reason = input?.reason ? String(input.reason) : null;
    const pausedBy = input?.pausedBy ? String(input.pausedBy) : null;
    const expectedResumeAt = toIsoOrNull(input?.expectedResumeAt);
    const planIds = uniqueNonEmpty(input?.planIds);

    if (!merchantId) throw new Error('merchantId is required');
    if (planIds.length === 0) throw new Error('planIds must be a non-empty array');
    if (planIds.length > MAX_PLANS_PER_PAUSE) {
      throw new Error(
        `Refusing to pause more than ${MAX_PLANS_PER_PAUSE} plans in a single call`
      );
    }

    const db = this.database.db || this.database;
    const pausedAt = this.clock().toISOString();
    const pauses = [];

    for (const planId of planIds) {
      // Reject overlapping active pauses for the same plan up-front so
      // resume math stays unambiguous.
      const existing = db
        .prepare(
          'SELECT id FROM seasonal_pauses WHERE plan_id = ? AND status = ?'
        )
        .get(planId, PAUSE_STATUS.ACTIVE);
      if (existing) {
        throw new Error(
          `Plan ${planId} already has an active seasonal pause (${existing.id})`
        );
      }
    }

    const tx = this._transaction(db);

    try {
      tx.begin();

      for (const planId of planIds) {
        const pauseId = `spause_${nowToken()}_${randomToken()}`;

        db.prepare(
          `INSERT INTO seasonal_pauses (
             id, merchant_id, plan_id, status, reason, paused_at, paused_by,
             expected_resume_at, subscriptions_affected, skipped_cycles_count,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 0, 0, ?, ?)`
        ).run(
          pauseId,
          merchantId,
          planId,
          reason,
          pausedAt,
          pausedBy,
          expectedResumeAt,
          pausedAt,
          pausedAt
        );

        const affected = this._markPlanSubscriptionsPaused(db, planId, pauseId);

        if (affected > 0) {
          db.prepare(
            'UPDATE seasonal_pauses SET subscriptions_affected = ?, updated_at = ? WHERE id = ?'
          ).run(affected, pausedAt, pauseId);
        }

        pauses.push({
          pauseId,
          planId,
          merchantId,
          subscriptionsAffected: affected,
          pausedAt,
          expectedResumeAt,
        });
      }

      tx.commit();
    } catch (error) {
      tx.rollback();
      throw error;
    }

    this._invalidatePausedPlanCache();

    return {
      pauses,
      totalSubscriptionsAffected: pauses.reduce(
        (sum, p) => sum + p.subscriptionsAffected,
        0
      ),
    };
  }

  /**
   * Update subscription rows belonging to a plan in batches, capturing the
   * pre-pause next_billing_date so resume can shift it forward without losing
   * the original cadence.
   *
   * @returns {number} number of rows transitioned to Seasonally_Inactive
   */
  _markPlanSubscriptionsPaused(db, planId, pauseId) {
    let totalAffected = 0;

    if (this.planResolver) {
      // External resolver path — useful when the canonical subscriptions list
      // lives in Postgres and the SQLite test DB is just a stub.
      const subs = this.planResolver(planId) || [];
      for (let i = 0; i < subs.length; i += this.batchSize) {
        const batch = subs.slice(i, i + this.batchSize);
        for (const sub of batch) {
          const result = db
            .prepare(
              `UPDATE subscriptions
                 SET seasonal_status = 'Seasonally_Inactive',
                     paused_pause_id = ?,
                     paused_next_billing_date = COALESCE(paused_next_billing_date, next_billing_date)
                 WHERE creator_id = ? AND wallet_address = ?
                   AND (seasonal_status IS NULL OR seasonal_status = 'Active')`
            )
            .run(pauseId, sub.creatorId, sub.walletAddress);
          totalAffected += result.changes || 0;
        }
      }
      return totalAffected;
    }

    // Fast path: plans correspond to stripe_plan_id on subscriptions.
    // We intentionally do NOT clear next_billing_date so that the indexer's
    // pre-billing query still surfaces the row and routes it through the
    // skip path (where we record a skipped_cycle entry).
    const stmt = db.prepare(
      `UPDATE subscriptions
         SET seasonal_status = 'Seasonally_Inactive',
             paused_pause_id = ?,
             paused_next_billing_date = COALESCE(paused_next_billing_date, next_billing_date)
         WHERE stripe_plan_id = ?
           AND (seasonal_status IS NULL OR seasonal_status = 'Active')`
    );

    const result = stmt.run(pauseId, planId);
    totalAffected += result.changes || 0;

    return totalAffected;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Indexer guard: skip-logic that records skipped cycles.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if the plan currently has an active pause.
   * Cached in-process to avoid hitting the DB on every billing tick.
   */
  isPlanPaused(planId) {
    if (!planId) return false;
    if (!this._pausedPlanCache) this._refreshPausedPlanCache();
    return this._pausedPlanCache.has(String(planId));
  }

  getActivePauseForPlan(planId) {
    if (!planId) return null;
    const db = this.database.db || this.database;
    const row = db
      .prepare(
        `SELECT id AS pauseId, merchant_id AS merchantId, plan_id AS planId,
                paused_at AS pausedAt, expected_resume_at AS expectedResumeAt,
                reason
           FROM seasonal_pauses
           WHERE plan_id = ? AND status = 'active'`
      )
      .get(String(planId));
    return row || null;
  }

  /**
   * Guard called by the indexer / pre-billing worker BEFORE attempting to
   * pull funds. If the plan is paused this records a skipped_cycle row and
   * returns { skipped: true, ... }; the caller MUST honour the skip.
   *
   * Idempotent: calling it twice for the same scheduled billing date is safe
   * thanks to the UNIQUE(pause_id, creator_id, wallet_address, scheduled_billing_date)
   * constraint.
   */
  maybeSkipBilling(input) {
    const planId = input?.planId ? String(input.planId) : null;
    const creatorId = input?.creatorId ? String(input.creatorId) : null;
    const walletAddress = input?.walletAddress ? String(input.walletAddress) : null;
    const scheduledBillingDate = toIsoOrNull(input?.scheduledBillingDate);
    const requiredAmount = Number(input?.requiredAmount || 0);

    if (!planId || !creatorId || !walletAddress || !scheduledBillingDate) {
      return { skipped: false, reason: 'missing_fields' };
    }

    const pause = this.getActivePauseForPlan(planId);
    if (!pause) return { skipped: false };

    const db = this.database.db || this.database;
    const skippedAt = this.clock().toISOString();
    const skippedCycleId = `scc_${nowToken()}_${randomToken()}`;

    // INSERT OR IGNORE is the SQLite spelling of "do nothing on conflict";
    // upstream callers can retry safely.
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO subscription_skipped_cycles (
           id, pause_id, merchant_id, plan_id, creator_id, wallet_address,
           scheduled_billing_date, required_amount, skipped_at, reconciled
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        skippedCycleId,
        pause.pauseId,
        pause.merchantId,
        planId,
        creatorId,
        walletAddress,
        scheduledBillingDate,
        requiredAmount,
        skippedAt
      );

    if (result.changes > 0) {
      db.prepare(
        `UPDATE seasonal_pauses
           SET skipped_cycles_count = skipped_cycles_count + 1,
               updated_at = ?
           WHERE id = ?`
      ).run(skippedAt, pause.pauseId);
    }

    return {
      skipped: true,
      pauseId: pause.pauseId,
      skippedCycleId: result.changes > 0 ? skippedCycleId : null,
      alreadyRecorded: result.changes === 0,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // bulkResume: re-activate subscriptions and shift next_billing_date forward
  // by the pause duration so the user's previously-paid value is preserved.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * @param {{ pauseId: string, resumedAt?: string|Date, resumedBy?: string }} input
   */
  async bulkResume(input) {
    const pauseId = String(input?.pauseId || '').trim();
    if (!pauseId) throw new Error('pauseId is required');

    const resumedBy = input?.resumedBy ? String(input.resumedBy) : null;
    const resumedAtDate = input?.resumedAt
      ? new Date(input.resumedAt)
      : this.clock();
    if (Number.isNaN(resumedAtDate.getTime())) {
      throw new Error('resumedAt must be a valid date');
    }
    const resumedAt = resumedAtDate.toISOString();

    const db = this.database.db || this.database;
    const pause = db
      .prepare(
        `SELECT id, merchant_id AS merchantId, plan_id AS planId, status,
                paused_at AS pausedAt, skipped_cycles_count AS skippedCyclesCount,
                subscriptions_affected AS subscriptionsAffected
           FROM seasonal_pauses WHERE id = ?`
      )
      .get(pauseId);

    if (!pause) throw new Error(`Pause ${pauseId} not found`);
    if (pause.status !== PAUSE_STATUS.ACTIVE) {
      throw new Error(
        `Pause ${pauseId} is not active (current status: ${pause.status})`
      );
    }

    const pauseDurationMs = Math.max(
      0,
      resumedAtDate.getTime() - new Date(pause.pausedAt).getTime()
    );

    const tx = this._transaction(db);
    let recalculated = 0;

    try {
      tx.begin();

      // Walk the affected subscriptions in batches and shift each one
      // forward by the pause duration. Doing it per-row preserves any
      // cadence variation across users on the same plan (e.g. some
      // mid-cycle, some at-cycle-end).
      const subRows = db
        .prepare(
          `SELECT creator_id AS creatorId,
                  wallet_address AS walletAddress,
                  paused_next_billing_date AS pausedNextBillingDate,
                  next_billing_date AS nextBillingDate,
                  billing_interval_days AS billingIntervalDays
             FROM subscriptions
             WHERE paused_pause_id = ?
               AND seasonal_status = 'Seasonally_Inactive'`
        )
        .all(pauseId);

      const updateStmt = db.prepare(
        `UPDATE subscriptions
           SET seasonal_status = 'Active',
               paused_pause_id = NULL,
               paused_next_billing_date = NULL,
               next_billing_date = ?
           WHERE creator_id = ? AND wallet_address = ? AND paused_pause_id = ?`
      );

      for (const sub of subRows) {
        const baseline =
          sub.pausedNextBillingDate ||
          sub.nextBillingDate ||
          pause.pausedAt;
        const newNextBilling = new Date(
          new Date(baseline).getTime() + pauseDurationMs
        ).toISOString();

        updateStmt.run(newNextBilling, sub.creatorId, sub.walletAddress, pauseId);
        recalculated += 1;
      }

      // Mark all skipped cycles as reconciled.
      db.prepare(
        `UPDATE subscription_skipped_cycles
           SET reconciled = 1, reconciled_at = ?
           WHERE pause_id = ? AND reconciled = 0`
      ).run(resumedAt, pauseId);

      db.prepare(
        `UPDATE seasonal_pauses
           SET status = 'resumed',
               resumed_at = ?,
               resumed_by = ?,
               updated_at = ?
           WHERE id = ?`
      ).run(resumedAt, resumedBy, resumedAt, pauseId);

      tx.commit();
    } catch (error) {
      tx.rollback();
      throw error;
    }

    this._invalidatePausedPlanCache();

    return {
      pauseId,
      planId: pause.planId,
      merchantId: pause.merchantId,
      pausedAt: pause.pausedAt,
      resumedAt,
      pauseDurationMs,
      subscriptionsRecalculated: recalculated,
      skippedCyclesReconciled: pause.skippedCyclesCount,
    };
  }

  /**
   * Cancel a pause without reconciling skipped cycles. Use this if a pause
   * was created in error — subscriptions are reactivated with their original
   * next_billing_date intact.
   */
  async cancelPause({ pauseId, cancelledBy } = {}) {
    if (!pauseId) throw new Error('pauseId is required');
    const db = this.database.db || this.database;

    const pause = db
      .prepare('SELECT id, status FROM seasonal_pauses WHERE id = ?')
      .get(pauseId);
    if (!pause) throw new Error(`Pause ${pauseId} not found`);
    if (pause.status !== PAUSE_STATUS.ACTIVE) {
      throw new Error(`Pause ${pauseId} is not active`);
    }

    const now = this.clock().toISOString();
    const tx = this._transaction(db);

    try {
      tx.begin();
      db.prepare(
        `UPDATE subscriptions
           SET seasonal_status = 'Active',
               paused_pause_id = NULL,
               paused_next_billing_date = NULL
           WHERE paused_pause_id = ?`
      ).run(pauseId);

      db.prepare(
        `UPDATE seasonal_pauses
           SET status = 'cancelled',
               resumed_at = ?,
               resumed_by = ?,
               updated_at = ?
           WHERE id = ?`
      ).run(now, cancelledBy || null, now, pauseId);
      tx.commit();
    } catch (error) {
      tx.rollback();
      throw error;
    }

    this._invalidatePausedPlanCache();
    return { pauseId, status: PAUSE_STATUS.CANCELLED, cancelledAt: now };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Read-side helpers
  // ────────────────────────────────────────────────────────────────────────

  listActivePauses({ merchantId } = {}) {
    const db = this.database.db || this.database;
    if (merchantId) {
      return db
        .prepare(
          `SELECT id AS pauseId, merchant_id AS merchantId, plan_id AS planId,
                  status, paused_at AS pausedAt, expected_resume_at AS expectedResumeAt,
                  subscriptions_affected AS subscriptionsAffected,
                  skipped_cycles_count AS skippedCyclesCount
             FROM seasonal_pauses
             WHERE merchant_id = ? AND status = 'active'
             ORDER BY paused_at DESC`
        )
        .all(String(merchantId));
    }
    return db
      .prepare(
        `SELECT id AS pauseId, merchant_id AS merchantId, plan_id AS planId,
                status, paused_at AS pausedAt, expected_resume_at AS expectedResumeAt,
                subscriptions_affected AS subscriptionsAffected,
                skipped_cycles_count AS skippedCyclesCount
           FROM seasonal_pauses
           WHERE status = 'active'
           ORDER BY paused_at DESC`
      )
      .all();
  }

  getPauseDetail(pauseId) {
    if (!pauseId) return null;
    const db = this.database.db || this.database;
    const pause = db
      .prepare(
        `SELECT id AS pauseId, merchant_id AS merchantId, plan_id AS planId,
                status, reason, paused_at AS pausedAt, paused_by AS pausedBy,
                expected_resume_at AS expectedResumeAt,
                resumed_at AS resumedAt, resumed_by AS resumedBy,
                subscriptions_affected AS subscriptionsAffected,
                skipped_cycles_count AS skippedCyclesCount
           FROM seasonal_pauses WHERE id = ?`
      )
      .get(String(pauseId));
    return pause || null;
  }

  getSkippedCyclesForSubscription({ creatorId, walletAddress, pauseId } = {}) {
    const db = this.database.db || this.database;
    if (pauseId) {
      return db
        .prepare(
          `SELECT id, pause_id AS pauseId, plan_id AS planId,
                  creator_id AS creatorId, wallet_address AS walletAddress,
                  scheduled_billing_date AS scheduledBillingDate,
                  required_amount AS requiredAmount, skipped_at AS skippedAt,
                  reconciled, reconciled_at AS reconciledAt
             FROM subscription_skipped_cycles
             WHERE creator_id = ? AND wallet_address = ? AND pause_id = ?
             ORDER BY scheduled_billing_date ASC`
        )
        .all(String(creatorId), String(walletAddress), String(pauseId));
    }
    return db
      .prepare(
        `SELECT id, pause_id AS pauseId, plan_id AS planId,
                creator_id AS creatorId, wallet_address AS walletAddress,
                scheduled_billing_date AS scheduledBillingDate,
                required_amount AS requiredAmount, skipped_at AS skippedAt,
                reconciled, reconciled_at AS reconciledAt
           FROM subscription_skipped_cycles
           WHERE creator_id = ? AND wallet_address = ?
           ORDER BY scheduled_billing_date ASC`
      )
      .all(String(creatorId), String(walletAddress));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  _refreshPausedPlanCache() {
    const db = this.database.db || this.database;
    const rows = db
      .prepare(
        "SELECT plan_id AS planId FROM seasonal_pauses WHERE status = 'active'"
      )
      .all();
    this._pausedPlanCache = new Set(rows.map((r) => String(r.planId)));
  }

  _invalidatePausedPlanCache() {
    this._pausedPlanCache = null;
  }

  _transaction(db) {
    return {
      begin: () => db.exec('BEGIN'),
      commit: () => db.exec('COMMIT'),
      rollback: () => {
        try {
          db.exec('ROLLBACK');
        } catch (_e) {
          // nothing to roll back
        }
      },
    };
  }
}

function uniqueNonEmpty(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const v of value) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function toIsoOrNull(value) {
  if (value === undefined || value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function nowToken() {
  return Date.now().toString(36);
}

function randomToken() {
  return crypto.randomBytes(6).toString('hex');
}

module.exports = {
  SeasonalPauseService,
  PAUSE_STATUS,
  SUBSCRIPTION_SEASONAL_STATUS,
  MS_PER_DAY,
};
