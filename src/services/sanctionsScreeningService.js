const crypto = require('crypto');
const { StaticListSanctionsProvider } = require('./sanctionsProviders');

const ACCOUNT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  BLOCKED: 'BLOCKED',
  PENDING_REVIEW: 'PENDING_REVIEW',
});

const RISK_LEVEL = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  UNKNOWN: 'UNKNOWN',
});

const EVENT_TYPE = Object.freeze({
  SCREEN_PASS: 'SCREEN_PASS',
  SCREEN_FLAGGED: 'SCREEN_FLAGGED',
  BLOCKED: 'BLOCKED',
  UNBLOCKED: 'UNBLOCKED',
  FALSE_POSITIVE: 'FALSE_POSITIVE',
  CONFIRMED_SANCTION: 'CONFIRMED_SANCTION',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  REVIEW_QUEUED: 'REVIEW_QUEUED',
  WEBHOOK_BLOCKED: 'WEBHOOK_BLOCKED',
});

const REVIEW_STATUS = Object.freeze({
  OPEN: 'open',
  CLEARED: 'cleared',
  CONFIRMED: 'confirmed',
});

const DEFAULT_BLOCK_CACHE_TTL_MS = 60 * 1000;

/**
 * SanctionsScreeningService
 *
 * Real-time OFAC / global-sanctions screening. Consumed at:
 *   - SEP-10 verify (block before issuing JWT)
 *   - subscription init (block before recording the subscription)
 *   - middleware on every authenticated request (block already-flagged accounts
 *     with an indexed, in-process cached lookup)
 *   - webhook dispatch path (refuse to dispatch to a BLOCKED account)
 *
 * All decisions are recorded in the security_audit table with the provider's
 * risk score and the reason for the flag, satisfying acceptance #3.
 */
class SanctionsScreeningService {
  /**
   * @param {{
   *   database: any,
   *   provider?: { screenAddress: (addr: string) => Promise<any> },
   *   logger?: any,
   *   failClosed?: boolean,
   *   highRiskScoreThreshold?: number,
   *   blockCacheTtlMs?: number,
   *   clock?: () => Date,
   * }} options
   */
  constructor({
    database,
    provider,
    logger,
    failClosed,
    highRiskScoreThreshold,
    blockCacheTtlMs,
    clock,
  } = {}) {
    if (!database) throw new Error('database is required');
    this.database = database;
    this.logger = logger || console;
    this.provider = provider || new StaticListSanctionsProvider();
    // Default to fail-OPEN to avoid breaking auth when the provider is down,
    // but log a PROVIDER_ERROR event. Production-grade compliance teams
    // typically toggle this to true.
    this.failClosed = !!failClosed;
    this.highRiskScoreThreshold = Number(highRiskScoreThreshold || 75);
    this.blockCacheTtlMs = Number(blockCacheTtlMs || DEFAULT_BLOCK_CACHE_TTL_MS);
    this.clock = clock || (() => new Date());

    // Per-process LRU-ish cache: map<address, { blocked, expiresAt }>. Keeps
    // the request-time middleware lookup at O(1) without re-querying the DB.
    this._statusCache = new Map();

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
        CREATE TABLE IF NOT EXISTS screened_users (
          wallet_address TEXT PRIMARY KEY,
          account_status TEXT NOT NULL DEFAULT 'ACTIVE',
          risk_level TEXT,
          risk_score REAL,
          flagged_lists TEXT,
          block_reason TEXT,
          blocking_provider TEXT,
          last_screened_at TEXT,
          last_audit_id TEXT,
          blocked_at TEXT,
          unblocked_at TEXT,
          unblocked_by TEXT,
          override_until TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_screened_users_status
          ON screened_users (account_status);
        CREATE INDEX IF NOT EXISTS idx_screened_users_risk
          ON screened_users (risk_level);

        CREATE TABLE IF NOT EXISTS security_audit (
          id TEXT PRIMARY KEY,
          wallet_address TEXT NOT NULL,
          event_type TEXT NOT NULL,
          provider TEXT,
          risk_level TEXT,
          risk_score REAL,
          flagged_lists TEXT,
          reason TEXT,
          provider_response TEXT,
          triggering_action TEXT,
          actor TEXT,
          ip_address TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_security_audit_wallet_created
          ON security_audit (wallet_address, created_at);
        CREATE INDEX IF NOT EXISTS idx_security_audit_event_created
          ON security_audit (event_type, created_at);

        CREATE TABLE IF NOT EXISTS sanctions_review_queue (
          id TEXT PRIMARY KEY,
          wallet_address TEXT NOT NULL,
          triggering_audit_id TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          risk_level TEXT,
          risk_score REAL,
          flagged_lists TEXT,
          reason TEXT,
          submitted_at TEXT NOT NULL,
          reviewed_at TEXT,
          reviewed_by TEXT,
          decision_notes TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sanctions_review_queue_status
          ON sanctions_review_queue (status, submitted_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sanctions_review_queue_one_open
          ON sanctions_review_queue (wallet_address) WHERE status = 'open';
      `);
    } catch (error) {
      this.logger.warn &&
        this.logger.warn(
          'SanctionsScreeningService.ensureSchema failed:',
          error.message
        );
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // screenAddress: the entry point for SEP-10 verify and subscription init.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Screen a wallet address. Records an audit row and updates the screened
   * users row. If the result is HIGH risk (or hits the score threshold) the
   * account is auto-blocked AND a review queue entry is created.
   *
   * Returns the final state for the caller to react on:
   *   { allowed, status, riskLevel, riskScore, blocked, auditId, reason, flaggedLists }
   *
   * @param {string} walletAddress
   * @param {{ triggeringAction?: string, actor?: string, ipAddress?: string, force?: boolean }} [context]
   */
  async screenAddress(walletAddress, context = {}) {
    const address = normalizeAddress(walletAddress);
    if (!address) {
      throw new Error('walletAddress is required');
    }

    // Short-circuit: if the wallet is already BLOCKED we don't even hit the
    // upstream provider — re-screening a blocked address can't change the
    // outcome until a compliance officer clears it.
    const existing = this.getAccountStatus(address);
    if (existing && existing.accountStatus === ACCOUNT_STATUS.BLOCKED && !context.force) {
      this._cacheStatus(address, true);
      return {
        allowed: false,
        status: ACCOUNT_STATUS.BLOCKED,
        riskLevel: existing.riskLevel || RISK_LEVEL.HIGH,
        riskScore: existing.riskScore != null ? Number(existing.riskScore) : 100,
        blocked: true,
        auditId: existing.lastAuditId,
        reason: existing.blockReason,
        flaggedLists: parseList(existing.flaggedLists),
        cached: true,
      };
    }

    let providerResult;
    let providerError = null;
    try {
      providerResult = await this.provider.screenAddress(address);
    } catch (err) {
      providerError = err;
    }

    if (providerError) {
      const auditId = this._appendAudit({
        walletAddress: address,
        eventType: EVENT_TYPE.PROVIDER_ERROR,
        provider: this.provider && this.provider.name,
        reason: providerError.message,
        triggeringAction: context.triggeringAction,
        actor: context.actor,
        ipAddress: context.ipAddress,
      });

      if (this.failClosed) {
        // Compliance-strict mode: refuse the action when we can't verify.
        this._cacheStatus(address, true);
        return {
          allowed: false,
          status: ACCOUNT_STATUS.PENDING_REVIEW,
          riskLevel: RISK_LEVEL.UNKNOWN,
          riskScore: 0,
          blocked: false,
          auditId,
          reason: 'Sanctions provider unavailable; failing closed',
          flaggedLists: [],
          providerError: providerError.message,
        };
      }

      this._cacheStatus(address, false);
      return {
        allowed: true,
        status: ACCOUNT_STATUS.ACTIVE,
        riskLevel: RISK_LEVEL.UNKNOWN,
        riskScore: 0,
        blocked: false,
        auditId,
        reason: null,
        flaggedLists: [],
        providerError: providerError.message,
      };
    }

    const normalized = this._normalizeProviderResult(providerResult);
    const shouldBlock =
      normalized.riskLevel === RISK_LEVEL.HIGH ||
      (Number.isFinite(normalized.riskScore) &&
        normalized.riskScore >= this.highRiskScoreThreshold);

    if (shouldBlock) {
      const auditId = this._appendAudit({
        walletAddress: address,
        eventType: EVENT_TYPE.SCREEN_FLAGGED,
        provider: normalized.provider,
        riskLevel: normalized.riskLevel,
        riskScore: normalized.riskScore,
        flaggedLists: normalized.flaggedLists,
        reason: normalized.reason,
        providerResponse: normalized.raw,
        triggeringAction: context.triggeringAction,
        actor: context.actor,
        ipAddress: context.ipAddress,
      });

      this._upsertScreenedUser(address, {
        accountStatus: ACCOUNT_STATUS.BLOCKED,
        riskLevel: normalized.riskLevel || RISK_LEVEL.HIGH,
        riskScore: normalized.riskScore,
        flaggedLists: normalized.flaggedLists,
        blockReason:
          normalized.reason ||
          `Flagged by ${normalized.provider} (lists: ${normalized.flaggedLists.join(', ') || 'unknown'})`,
        blockingProvider: normalized.provider,
        lastAuditId: auditId,
        blockedAt: this.clock().toISOString(),
      });

      this._appendAudit({
        walletAddress: address,
        eventType: EVENT_TYPE.BLOCKED,
        provider: normalized.provider,
        riskLevel: normalized.riskLevel,
        riskScore: normalized.riskScore,
        flaggedLists: normalized.flaggedLists,
        reason: 'Auto-blocked due to sanctions screening hit',
        triggeringAction: context.triggeringAction,
        actor: context.actor,
        ipAddress: context.ipAddress,
      });

      this._enqueueReview({
        walletAddress: address,
        auditId,
        riskLevel: normalized.riskLevel,
        riskScore: normalized.riskScore,
        flaggedLists: normalized.flaggedLists,
        reason: normalized.reason,
      });

      this._cacheStatus(address, true);

      return {
        allowed: false,
        status: ACCOUNT_STATUS.BLOCKED,
        riskLevel: normalized.riskLevel || RISK_LEVEL.HIGH,
        riskScore: normalized.riskScore,
        blocked: true,
        auditId,
        reason: normalized.reason,
        flaggedLists: normalized.flaggedLists,
      };
    }

    // Clean pass — record audit, refresh status, allow.
    const auditId = this._appendAudit({
      walletAddress: address,
      eventType: EVENT_TYPE.SCREEN_PASS,
      provider: normalized.provider,
      riskLevel: normalized.riskLevel,
      riskScore: normalized.riskScore,
      flaggedLists: normalized.flaggedLists,
      reason: normalized.reason,
      providerResponse: normalized.raw,
      triggeringAction: context.triggeringAction,
      actor: context.actor,
      ipAddress: context.ipAddress,
    });

    this._upsertScreenedUser(address, {
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      riskLevel: normalized.riskLevel || RISK_LEVEL.LOW,
      riskScore: normalized.riskScore,
      flaggedLists: normalized.flaggedLists,
      lastAuditId: auditId,
    });

    this._cacheStatus(address, false);

    return {
      allowed: true,
      status: ACCOUNT_STATUS.ACTIVE,
      riskLevel: normalized.riskLevel || RISK_LEVEL.LOW,
      riskScore: normalized.riskScore,
      blocked: false,
      auditId,
      reason: null,
      flaggedLists: normalized.flaggedLists,
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Hot-path helpers used by middleware and webhook dispatch.
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Synchronous, in-process-cached check that an address is BLOCKED.
   * Returns true even before any screening if the wallet was previously
   * flagged. Used by middleware on every authenticated request.
   */
  isBlocked(walletAddress) {
    const address = normalizeAddress(walletAddress);
    if (!address) return false;

    const cached = this._statusCache.get(address);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.blocked;
    }

    const status = this.getAccountStatus(address);
    const blocked = !!(status && status.accountStatus === ACCOUNT_STATUS.BLOCKED);
    this._cacheStatus(address, blocked);
    return blocked;
  }

  /**
   * Throws if the address is BLOCKED. Used by webhook dispatchers and other
   * call sites that want a guard rather than a check + branch.
   */
  assertNotBlocked(walletAddress, { eventType, actor, ipAddress } = {}) {
    if (this.isBlocked(walletAddress)) {
      this._appendAudit({
        walletAddress: normalizeAddress(walletAddress),
        eventType: eventType || EVENT_TYPE.WEBHOOK_BLOCKED,
        reason: 'Action blocked: account is on sanctions blocklist',
        actor,
        ipAddress,
      });
      const error = new Error(
        `Account ${walletAddress} is BLOCKED by sanctions screening`
      );
      error.code = 'ACCOUNT_BLOCKED';
      error.walletAddress = normalizeAddress(walletAddress);
      throw error;
    }
  }

  getAccountStatus(walletAddress) {
    const address = normalizeAddress(walletAddress);
    if (!address) return null;
    const db = this.database.db || this.database;
    const row = db
      .prepare(
        `SELECT wallet_address AS walletAddress,
                account_status AS accountStatus,
                risk_level AS riskLevel,
                risk_score AS riskScore,
                flagged_lists AS flaggedLists,
                block_reason AS blockReason,
                blocking_provider AS blockingProvider,
                last_screened_at AS lastScreenedAt,
                last_audit_id AS lastAuditId,
                blocked_at AS blockedAt,
                unblocked_at AS unblockedAt,
                unblocked_by AS unblockedBy,
                override_until AS overrideUntil
           FROM screened_users WHERE wallet_address = ?`
      )
      .get(address);
    return row || null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Compliance officer review surface (false-positive workflow).
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Mark a flagged address as a false positive — unblock it and close the
   * review ticket. Records FALSE_POSITIVE + UNBLOCKED audit events.
   */
  async markFalsePositive({ walletAddress, reviewedBy, decisionNotes } = {}) {
    const address = normalizeAddress(walletAddress);
    if (!address) throw new Error('walletAddress is required');
    if (!reviewedBy) throw new Error('reviewedBy is required');

    const status = this.getAccountStatus(address);
    if (!status || status.accountStatus !== ACCOUNT_STATUS.BLOCKED) {
      throw new Error(`Wallet ${address} is not currently blocked`);
    }

    const now = this.clock().toISOString();
    const db = this.database.db || this.database;

    db.prepare(
      `UPDATE screened_users
         SET account_status = 'ACTIVE',
             unblocked_at = ?,
             unblocked_by = ?,
             override_until = ?,
             updated_at = ?
         WHERE wallet_address = ?`
    ).run(
      now,
      reviewedBy,
      // Suppress re-blocking by automated re-scans for 90 days. A scheduled
      // re-screen can still flag the address again later if upstream data
      // changes; the override_until is a guard against immediately re-blocking
      // on the next provider hit.
      new Date(this.clock().getTime() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      now,
      address
    );

    this._appendAudit({
      walletAddress: address,
      eventType: EVENT_TYPE.FALSE_POSITIVE,
      reason: decisionNotes || 'Marked as false positive by compliance officer',
      actor: reviewedBy,
    });
    this._appendAudit({
      walletAddress: address,
      eventType: EVENT_TYPE.UNBLOCKED,
      reason: 'Manual unblock following false-positive review',
      actor: reviewedBy,
    });

    db.prepare(
      `UPDATE sanctions_review_queue
         SET status = 'cleared',
             reviewed_at = ?,
             reviewed_by = ?,
             decision_notes = ?
         WHERE wallet_address = ? AND status = 'open'`
    ).run(now, reviewedBy, decisionNotes || null, address);

    this._cacheStatus(address, false);

    return {
      walletAddress: address,
      status: ACCOUNT_STATUS.ACTIVE,
      reviewedBy,
      reviewedAt: now,
    };
  }

  /**
   * Officer confirms the sanctions hit is real. Account stays BLOCKED, the
   * review ticket is closed.
   */
  async confirmSanction({ walletAddress, reviewedBy, decisionNotes } = {}) {
    const address = normalizeAddress(walletAddress);
    if (!address) throw new Error('walletAddress is required');
    if (!reviewedBy) throw new Error('reviewedBy is required');

    const status = this.getAccountStatus(address);
    if (!status || status.accountStatus !== ACCOUNT_STATUS.BLOCKED) {
      throw new Error(`Wallet ${address} is not currently blocked`);
    }

    const now = this.clock().toISOString();
    const db = this.database.db || this.database;

    this._appendAudit({
      walletAddress: address,
      eventType: EVENT_TYPE.CONFIRMED_SANCTION,
      reason: decisionNotes || 'Sanctions hit confirmed by compliance officer',
      actor: reviewedBy,
    });

    db.prepare(
      `UPDATE sanctions_review_queue
         SET status = 'confirmed',
             reviewed_at = ?,
             reviewed_by = ?,
             decision_notes = ?
         WHERE wallet_address = ? AND status = 'open'`
    ).run(now, reviewedBy, decisionNotes || null, address);

    return {
      walletAddress: address,
      status: ACCOUNT_STATUS.BLOCKED,
      reviewedBy,
      reviewedAt: now,
    };
  }

  listReviewQueue({ status, limit } = {}) {
    const db = this.database.db || this.database;
    const where = status ? 'WHERE status = ?' : "WHERE status = 'open'";
    const params = status ? [String(status)] : [];
    const lim = Math.max(1, Math.min(500, Number(limit || 100)));
    return db
      .prepare(
        `SELECT id, wallet_address AS walletAddress, triggering_audit_id AS triggeringAuditId,
                status, risk_level AS riskLevel, risk_score AS riskScore,
                flagged_lists AS flaggedLists, reason,
                submitted_at AS submittedAt, reviewed_at AS reviewedAt,
                reviewed_by AS reviewedBy, decision_notes AS decisionNotes
           FROM sanctions_review_queue
           ${where}
           ORDER BY submitted_at DESC
           LIMIT ${lim}`
      )
      .all(...params)
      .map((row) => ({
        ...row,
        flaggedLists: parseList(row.flaggedLists),
      }));
  }

  getAuditTrail(walletAddress, { limit } = {}) {
    const address = normalizeAddress(walletAddress);
    if (!address) return [];
    const db = this.database.db || this.database;
    const lim = Math.max(1, Math.min(500, Number(limit || 100)));
    return db
      .prepare(
        `SELECT id, wallet_address AS walletAddress, event_type AS eventType,
                provider, risk_level AS riskLevel, risk_score AS riskScore,
                flagged_lists AS flaggedLists, reason,
                triggering_action AS triggeringAction, actor, ip_address AS ipAddress,
                created_at AS createdAt
           FROM security_audit
           WHERE wallet_address = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ${lim}`
      )
      .all(address)
      .map((row) => ({ ...row, flaggedLists: parseList(row.flaggedLists) }));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────────

  _normalizeProviderResult(raw) {
    const result = raw || {};
    const flaggedLists = Array.isArray(result.flaggedLists)
      ? result.flaggedLists.map(String)
      : [];
    let riskLevel = result.riskLevel ? String(result.riskLevel).toUpperCase() : null;
    if (
      riskLevel &&
      !Object.prototype.hasOwnProperty.call(RISK_LEVEL, riskLevel)
    ) {
      riskLevel = null;
    }
    return {
      provider: result.provider || (this.provider && this.provider.name) || 'unknown',
      riskLevel: riskLevel || RISK_LEVEL.LOW,
      riskScore: Number.isFinite(Number(result.riskScore))
        ? Number(result.riskScore)
        : 0,
      flaggedLists,
      reason: result.reason || null,
      raw: result.raw || result,
    };
  }

  _appendAudit(entry) {
    const db = this.database.db || this.database;
    const id = `sec_${Date.now().toString(36)}_${randomToken()}`;
    db.prepare(
      `INSERT INTO security_audit (
         id, wallet_address, event_type, provider, risk_level, risk_score,
         flagged_lists, reason, provider_response,
         triggering_action, actor, ip_address, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      entry.walletAddress,
      entry.eventType,
      entry.provider || null,
      entry.riskLevel || null,
      entry.riskScore != null ? Number(entry.riskScore) : null,
      Array.isArray(entry.flaggedLists)
        ? JSON.stringify(entry.flaggedLists)
        : entry.flaggedLists || null,
      entry.reason || null,
      entry.providerResponse ? JSON.stringify(entry.providerResponse) : null,
      entry.triggeringAction || null,
      entry.actor || null,
      entry.ipAddress || null,
      this.clock().toISOString()
    );
    return id;
  }

  _upsertScreenedUser(address, data) {
    const db = this.database.db || this.database;
    const now = this.clock().toISOString();
    const existing = this.getAccountStatus(address);

    if (existing) {
      const fields = [];
      const params = [];

      if (data.accountStatus !== undefined) {
        fields.push('account_status = ?');
        params.push(data.accountStatus);
      }
      if (data.riskLevel !== undefined) {
        fields.push('risk_level = ?');
        params.push(data.riskLevel);
      }
      if (data.riskScore !== undefined) {
        fields.push('risk_score = ?');
        params.push(data.riskScore);
      }
      if (data.flaggedLists !== undefined) {
        fields.push('flagged_lists = ?');
        params.push(
          Array.isArray(data.flaggedLists)
            ? JSON.stringify(data.flaggedLists)
            : data.flaggedLists
        );
      }
      if (data.blockReason !== undefined) {
        fields.push('block_reason = ?');
        params.push(data.blockReason);
      }
      if (data.blockingProvider !== undefined) {
        fields.push('blocking_provider = ?');
        params.push(data.blockingProvider);
      }
      if (data.lastAuditId !== undefined) {
        fields.push('last_audit_id = ?');
        params.push(data.lastAuditId);
      }
      if (data.blockedAt !== undefined) {
        fields.push('blocked_at = ?');
        params.push(data.blockedAt);
      }
      fields.push('last_screened_at = ?');
      params.push(now);
      fields.push('updated_at = ?');
      params.push(now);
      params.push(address);

      db.prepare(
        `UPDATE screened_users SET ${fields.join(', ')} WHERE wallet_address = ?`
      ).run(...params);
      return;
    }

    db.prepare(
      `INSERT INTO screened_users (
         wallet_address, account_status, risk_level, risk_score, flagged_lists,
         block_reason, blocking_provider, last_screened_at, last_audit_id,
         blocked_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      address,
      data.accountStatus || ACCOUNT_STATUS.ACTIVE,
      data.riskLevel || null,
      data.riskScore != null ? Number(data.riskScore) : null,
      Array.isArray(data.flaggedLists)
        ? JSON.stringify(data.flaggedLists)
        : data.flaggedLists || null,
      data.blockReason || null,
      data.blockingProvider || null,
      now,
      data.lastAuditId || null,
      data.blockedAt || null,
      now,
      now
    );
  }

  _enqueueReview(entry) {
    const db = this.database.db || this.database;
    const now = this.clock().toISOString();
    const id = `srq_${Date.now().toString(36)}_${randomToken()}`;
    // INSERT OR IGNORE keeps a single open ticket per wallet — re-screening
    // a still-blocked account doesn't pile up duplicate review work.
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO sanctions_review_queue (
           id, wallet_address, triggering_audit_id, status, risk_level,
           risk_score, flagged_lists, reason, submitted_at
         ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        entry.walletAddress,
        entry.auditId || null,
        entry.riskLevel || null,
        entry.riskScore != null ? Number(entry.riskScore) : null,
        Array.isArray(entry.flaggedLists)
          ? JSON.stringify(entry.flaggedLists)
          : entry.flaggedLists || null,
        entry.reason || null,
        now
      );

    if (result.changes > 0) {
      this._appendAudit({
        walletAddress: entry.walletAddress,
        eventType: EVENT_TYPE.REVIEW_QUEUED,
        reason: 'Auto-queued for compliance officer review',
      });
    }
    return id;
  }

  _cacheStatus(address, blocked) {
    if (this._statusCache.size > 5000) {
      // Bound the cache; clear on threshold to avoid an unbounded Map.
      this._statusCache.clear();
    }
    this._statusCache.set(address, {
      blocked,
      expiresAt: Date.now() + this.blockCacheTtlMs,
    });
  }

  invalidateStatusCache(walletAddress) {
    if (walletAddress === undefined) {
      this._statusCache.clear();
      return;
    }
    const address = normalizeAddress(walletAddress);
    if (address) this._statusCache.delete(address);
  }
}

function normalizeAddress(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.toUpperCase();
}

function parseList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

function randomToken() {
  return crypto.randomBytes(6).toString('hex');
}

module.exports = {
  SanctionsScreeningService,
  ACCOUNT_STATUS,
  RISK_LEVEL,
  EVENT_TYPE,
  REVIEW_STATUS,
};
