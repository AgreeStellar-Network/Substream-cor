const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

/**
 * SQLite-backed application database wrapper.
 */
class AppDatabase {
  /**
   * Insert a notification for a creator.
   * @param {{creatorId: string, type: string, message: string, metadata?: object, timestamp?: string}} notification
   * @returns {object}
   */
  insertNotification(notification) {
    const id = crypto.randomUUID();
    const timestamp = notification.timestamp || new Date().toISOString();
    this.ensureCreator(notification.creatorId);
    this.db.prepare(
      'INSERT INTO notifications (id, creator_id, type, message, metadata_json, timestamp, read) VALUES (?, ?, ?, ?, ?, ?, 0)'
    ).run(
      id,
      notification.creatorId,
      notification.type,
      notification.message,
      JSON.stringify(notification.metadata || {}),
      timestamp
    );
    return this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  }


  /**
   * List notifications for a creator (most recent first).
   * @param {string} creatorId
   * @returns {object[]}
   */
  listNotificationsByCreatorId(creatorId) {
    return this.db.prepare(
      'SELECT * FROM notifications WHERE creator_id = ? ORDER BY timestamp DESC, id DESC'
    ).all(creatorId);
  }

  /**
   * Mark a notification as read.
   * @param {string} notificationId
   * @returns {object}
   */
  markNotificationAsRead(notificationId) {
    this.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(notificationId);
    return this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId);
  }

  /**
   * @param {string} filename SQLite filename or `:memory:`.
   */
  constructor(filename) {
    this.filename = filename;
    this.ensureDirectory();
    this.db = new Database(filename);
    this.initializeSchema();
    this.ensureSubscriberCountColumn();
    this.ensureWebhookColumns();
    this.ensureSubscriptionRiskColumns();
  }

  /**
   * Initialize the database schema
   */
  initializeSchema() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS creators (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_settings (
        creator_id TEXT PRIMARY KEY REFERENCES creators(id),
        flow_rate TEXT NOT NULL,
        currency TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        title TEXT NOT NULL,
        description TEXT,
        original_filename TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploaded',
        message TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transcoding_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL REFERENCES videos(id),
        master_playlist TEXT NOT NULL,
        resolutions TEXT NOT NULL,
        upload_results TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS coop_splits (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        split_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS creator_audit_logs (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        action_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        creator_id TEXT NOT NULL REFERENCES creators(id),
        wallet_address TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        subscribed_at TEXT NOT NULL,
        unsubscribed_at TEXT,
        balance REAL,
        daily_spend REAL,
        user_email TEXT,
        risk_status TEXT,
        estimated_run_out_at TEXT,
        migrated_from_stripe INTEGER DEFAULT 0,
        stripe_plan_id TEXT,
        PRIMARY KEY (creator_id, wallet_address)
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        timestamp TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS email_queue (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        to_address TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_creator_audit_logs_creator_timestamp
        ON creator_audit_logs (creator_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        user_address TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments (post_id);
      CREATE INDEX IF NOT EXISTS idx_comments_creator_id ON comments (creator_id);
      CREATE INDEX IF NOT EXISTS idx_comments_user_address ON comments (user_address);

      CREATE TABLE IF NOT EXISTS creator_subdomains (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL REFERENCES creators(id),
        subdomain TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_creator_subdomains_subdomain ON creator_subdomains (subdomain);
      CREATE INDEX IF NOT EXISTS idx_creator_subdomains_creator_id ON creator_subdomains (creator_id);

      CREATE TABLE IF NOT EXISTS soroban_ingestion_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id TEXT NOT NULL UNIQUE,
        last_ingested_ledger INTEGER NOT NULL DEFAULT 0,
        last_ingested_timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_soroban_ingestion_state_contract_id ON soroban_ingestion_state (contract_id);

      CREATE TABLE IF NOT EXISTS soroban_events (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        ledger_sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL,
        raw_xdr TEXT,
        ledger_timestamp TEXT NOT NULL,
        ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE (transaction_hash, event_index)
      );

      CREATE INDEX IF NOT EXISTS idx_soroban_events_contract_id ON soroban_events (contract_id);
      CREATE INDEX IF NOT EXISTS idx_soroban_events_ledger_sequence ON soroban_events (ledger_sequence);
      CREATE INDEX IF NOT EXISTS idx_soroban_events_event_type ON soroban_events (event_type);
      CREATE INDEX IF NOT EXISTS idx_soroban_events_status ON soroban_events (status);
      CREATE INDEX IF NOT EXISTS idx_soroban_events_ingested_at ON soroban_events (ingested_at);
      CREATE INDEX IF NOT EXISTS idx_soroban_events_contract_type ON soroban_events (contract_id, event_type, ledger_sequence DESC);

      CREATE TABLE IF NOT EXISTS soroban_events_archive (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        ledger_sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL,
        raw_xdr TEXT,
        ledger_timestamp TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        processed_at TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_soroban_archive_contract_id ON soroban_events_archive (contract_id);
      CREATE INDEX IF NOT EXISTS idx_soroban_archive_ledger_timestamp ON soroban_events_archive (ledger_timestamp);
      CREATE INDEX IF NOT EXISTS idx_soroban_archive_event_type ON soroban_events_archive (event_type);
      CREATE INDEX IF NOT EXISTS idx_soroban_archive_archived_at ON soroban_events_archive (archived_at);
    `);

    this.ensureSubscriberCountColumn();
  }


    /**
     * Ensure the parent directory for the database file exists.
     */
    ensureDirectory() {
      if (this.filename !== ':memory:') {
        const dir = path.dirname(this.filename);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
    }

    /**
     * Ensure the creators table has a subscriber_count column.
     * This is a noop for in-memory DBs that already have the column.
     */
    ensureSubscriberCountColumn() {
      try {
        const info = this.db.prepare('PRAGMA table_info(creators);').all();
        const hasColumn = info.some((col) => col.name === 'subscriber_count');
        if (!hasColumn) {
          this.db.exec('ALTER TABLE creators ADD COLUMN subscriber_count INTEGER DEFAULT 0');
        }
      } catch (error) {
        console.warn('ensureSubscriberCountColumn failed:', error.message);
      }
    }

    /**
     * Ensure the creators table has webhook columns.
     */
    ensureWebhookColumns() {
      try {
        const info = this.db.prepare('PRAGMA table_info(creators);').all();
        const hasUrl = info.some((col) => col.name === 'webhook_url');
        const hasSecret = info.some((col) => col.name === 'webhook_secret');
        
        if (!hasUrl) {
          this.db.exec('ALTER TABLE creators ADD COLUMN webhook_url TEXT');
        }
        if (!hasSecret) {
          this.db.exec('ALTER TABLE creators ADD COLUMN webhook_secret TEXT');
        }
      } catch (error) {
        console.warn('ensureWebhookColumns failed:', error.message);
      }
    }

    /**
     * Ensure subscriptions table has fields used by low-balance risk checks.
     *
     * @returns {void}
     */
    ensureSubscriptionRiskColumns() {
      try {
        const info = this.db
          .prepare("PRAGMA table_info(subscriptions);")
          .all();

        const hasBalance = info.some((col) => col.name === 'balance');
        const hasDailySpend = info.some((col) => col.name === 'daily_spend');
        const hasUserEmail = info.some((col) => col.name === 'user_email');
        const hasRiskStatus = info.some((col) => col.name === 'risk_status');
        const hasEstimatedRunOutAt = info.some((col) => col.name === 'estimated_run_out_at');

        if (!hasBalance) {
          this.db.exec(`ALTER TABLE subscriptions ADD COLUMN balance REAL`);
        }

        if (!hasDailySpend) {
          this.db.exec(`ALTER TABLE subscriptions ADD COLUMN daily_spend REAL`);
        }

        if (!hasUserEmail) {
          this.db.exec(`ALTER TABLE subscriptions ADD COLUMN user_email TEXT`);
        }

        if (!hasRiskStatus) {
          this.db.exec(`ALTER TABLE subscriptions ADD COLUMN risk_status TEXT`);
        }

        if (!hasEstimatedRunOutAt) {
          this.db.exec(`ALTER TABLE subscriptions ADD COLUMN estimated_run_out_at TEXT`);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('ensureSubscriptionRiskColumns failed:', error.message);
      }
    }

    /**
     * Execute work inside a database transaction.
     *
     * @template T
     * @param {() => T} callback Work to execute.
     * @returns {T}
     */
    transaction(callback) {
      this.db.exec('BEGIN');
      try {
        const result = callback();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }

      if (!hasMigratedFromStripe) {
        this.db.exec(`ALTER TABLE subscriptions ADD COLUMN migrated_from_stripe INTEGER DEFAULT 0`);
      }

      if (!hasStripePlanId) {
        this.db.exec(`ALTER TABLE subscriptions ADD COLUMN stripe_plan_id TEXT`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('ensureSubscriptionRiskColumns failed:', error.message);
    }

    /**
     * Ensure a creator row exists, inserting a stub if absent.
     *
     * @param {string} creatorId Creator identifier.
     */
  ensureCreator(creatorId) {
    this.db
      .prepare(
        'INSERT INTO creators (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(creatorId, new Date().toISOString());
  }

  /**
   * Get creator information
   * @param {string} creatorId 
   * @returns {object|null}
   */
  getCreator(creatorId) {
    return this.db
      .prepare('SELECT * FROM creators WHERE id = ?')
      .get(creatorId);
  }

  /**
   * Update creator webhook settings
   * @param {string} creatorId 
   * @param {string} url 
   * @param {string} secret 
   */
  updateCreatorWebhook(creatorId, url, secret) {
    this.ensureCreator(creatorId);
    this.db
      .prepare('UPDATE creators SET webhook_url = ?, webhook_secret = ? WHERE id = ?')
      .run(url, secret, creatorId);
  }

    /**
     * Seed a video for tests or local setup.
     *
     * @param {{id: string, creatorId: string, title?: string, visibility: string}} video Video seed.
     */
    seedVideo(video) {
      this.ensureCreator(video.creatorId);
      this.db
        .prepare(
          'INSERT INTO videos (id, creator_id, title, visibility, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(video.id, video.creatorId, video.title || null, video.visibility, new Date().toISOString());
    }

    /**
     * Seed a co-op split for tests or local setup.
     *
     * @param {{id: string, creatorId: string, splits: object[]}} split Split seed.
     */
    seedCoopSplit(split) {
      this.ensureCreator(split.creatorId);
      this.db
        .prepare(
          'INSERT INTO coop_splits (id, creator_id, split_json, updated_at) VALUES (?, ?, ?, ?)',
        )
        .run(split.id, split.creatorId, JSON.stringify(split.splits), new Date().toISOString());
    }

    /**
     * Seed creator settings for tests or local setup.
     *
     * @param {{creatorId: string, flowRate: string, currency?: string}} settings Settings seed.
     * @returns {void}
     */
    seedCreatorSettings(settings) {
      this.ensureCreator(settings.creatorId);
      this.db
        .prepare(
          'INSERT INTO creator_settings (creator_id, flow_rate, currency, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(creator_id) DO UPDATE SET flow_rate = excluded.flow_rate, currency = excluded.currency, updated_at = excluded.updated_at',
        )
        .run(settings.creatorId, settings.flowRate, settings.currency || null, new Date().toISOString());
    }

    /**
     * Get creator settings for a creator.
     *
     * @param {string} creatorId Creator identifier.
     * @returns {object|null}
     */
    getCreatorSettings(creatorId) {
      const row = this.db
        .prepare(
          'SELECT creator_id AS creatorId, flow_rate AS flowRate, currency, updated_at AS updatedAt FROM creator_settings WHERE creator_id = ?',
        )
        .get(creatorId);
      return row || null;
    }

    /**
     * Create or update creator settings.
     *
     * @param {{creatorId: string, flowRate: string, currency: string|null, updatedAt: string}} settings Settings data.
     * @returns {object}
     */
    upsertCreatorSettings(settings) {
      this.ensureCreator(settings.creatorId);
      this.db
        .prepare(
          'INSERT INTO creator_settings (creator_id, flow_rate, currency, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(creator_id) DO UPDATE SET flow_rate = excluded.flow_rate, currency = excluded.currency, updated_at = excluded.updated_at',
        )
        .run(settings.creatorId, settings.flowRate, settings.currency, settings.updatedAt);
      return this.getCreatorSettings(settings.creatorId);
    }

    /**
     * Fetch a video.
     *
     * @param {string} videoId Video identifier.
     * @returns {object|null}
     */
    getVideoById(videoId) {
      const row = this.db
        .prepare(
          'SELECT id, creator_id AS creatorId, title, visibility, updated_at AS updatedAt FROM videos WHERE id = ?',
        )
        .get(videoId);
      return row || null;
    }

    /**
     * Update the visibility of an existing video.
     *
     * @param {{videoId: string, visibility: string, updatedAt: string}} input Update payload.
     * @returns {object}
     */
    updateVideoVisibility(input) {
      this.db
        .prepare('UPDATE videos SET visibility = ?, updated_at = ? WHERE id = ?')
        .run(input.visibility, input.updatedAt, input.videoId);
      return this.getVideoById(input.videoId);
    }

    /**
     * Fetch a co-op split by identifier.
     *
     * @param {string} splitId Split identifier.
     * @returns {object|null}
     */
    getCoopSplitById(splitId) {
      const row = this.db
        .prepare(
          'SELECT id, creator_id AS creatorId, split_json AS splitJson, updated_at AS updatedAt FROM coop_splits WHERE id = ?',
        )
        .get(splitId);
      if (!row) {
        return null;
      }
      return {
        ...row,
        splits: JSON.parse(row.splitJson),
      };
    }

    /**
     * Update an existing co-op split.
     *
     * @param {{splitId: string, splits: object[], updatedAt: string}} input Update payload.
     * @returns {object}
     */
    updateCoopSplit(input) {
      this.db
        .prepare('UPDATE coop_splits SET split_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(input.splits), input.updatedAt, input.splitId);
      return this.getCoopSplitById(input.splitId);
    }

    /**
     * Insert an immutable audit log entry.
     *
     * @param {{creatorId: string, actionType: string, entityType: string, entityId: string, timestamp: string, ipAddress: string, metadata: object}} entry Audit log payload.
     * @returns {object}
     */
    insertAuditLog(entry) {
      const id = crypto.randomUUID();
      this.ensureCreator(entry.creatorId);
      this.db
        .prepare(
          'INSERT INTO creator_audit_logs (id, creator_id, action_type, entity_type, entity_id, timestamp, ip_address, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          entry.creatorId,
          entry.actionType,
          entry.entityType,
          entry.entityId,
          entry.timestamp,
          entry.ipAddress,
          JSON.stringify(entry.metadata || {}),
          entry.timestamp,
        );

      return this.db
        .prepare(
          'SELECT id, creator_id AS creatorId, action_type AS actionType, entity_type AS entityType, entity_id AS entityId, timestamp, ip_address AS ipAddress, metadata_json AS metadataJson, created_at AS createdAt FROM creator_audit_logs WHERE id = ?',
        )
        .get(id);
    }

    /**
     * List audit logs for a creator in reverse chronological order.
     *
     * @param {string} creatorId Creator identifier.
     * @returns {object[]}
     */
    listAuditLogsByCreatorId(creatorId) {
      return this.db
        .prepare(
          'SELECT id, creator_id AS creatorId, action_type AS actionType, entity_type AS entityType, entity_id AS entityId, timestamp, ip_address AS ipAddress, metadata_json AS metadataJson, created_at AS createdAt FROM creator_audit_logs WHERE creator_id = ? ORDER BY timestamp DESC, id DESC',
        )
        .all(creatorId);
    }

    /**
     * Get the cached subscriber count for a creator.
     * Ensures the creator row exists and returns a number (0 if missing).
     *
     * @param {string} creatorId
     * @returns {number}
     */
    getCreatorSubscriberCount(creatorId) {
      this.ensureCreator(creatorId);
      const row = this.db
        .prepare('SELECT subscriber_count AS subscriberCount FROM creators WHERE id = ?')
      return (row && Number(row.subscriberCount)) || 0;
    }

    /**
     * Increment the subscriber count for a creator by 1.
     * Returns the new count.
     *
     * @param {string} creatorId
     * @returns {number}
     */
    incrementCreatorSubscriberCount(creatorId) {
      return this.transaction(() => {
        this.ensureCreator(creatorId);
        this.db
          .prepare(
            'UPDATE creators SET subscriber_count = COALESCE(subscriber_count, 0) + 1 WHERE id = ?',
          )
        return this.getCreatorSubscriberCount(creatorId);
      });
    }

    /**
     * Decrement the subscriber count for a creator by 1, clamped at 0.
     * Returns the new count.
     *
     * @param {string} creatorId
     * @returns {number}
     */
    decrementCreatorSubscriberCount(creatorId) {
      return this.transaction(() => {
        this.ensureCreator(creatorId);
        this.db
          .prepare(
            'UPDATE creators SET subscriber_count = MAX(COALESCE(subscriber_count, 0) - 1, 0) WHERE id = ?',
          )
          .run(creatorId);
      return this.getCreatorSubscriberCount(creatorId);
    });
  }

  /**
   * Set the subscriber count explicitly.
   *
   * @param {string} creatorId
   * @param {number} count
   * @returns {number}
   */
  setCreatorSubscriberCount(creatorId, count) {
    return this.transaction(() => {
      this.ensureCreator(creatorId);
      const safe = Math.max(0, Math.floor(Number(count) || 0));
      this.db
        .prepare('UPDATE creators SET subscriber_count = ? WHERE id = ?')
        .run(safe, creatorId);
      return this.getCreatorSubscriberCount(creatorId);
    });
  }

  /**
   * Get a subscription row for a creator and wallet.
   *
   * @param {string} creatorId
   * @param {string} walletAddress
   * @returns {object|null}
   */
  getSubscription(creatorId, walletAddress) {
    const row = this.db
      .prepare(
        'SELECT creator_id AS creatorId, wallet_address AS walletAddress, active, subscribed_at AS subscribedAt, unsubscribed_at AS unsubscribedAt FROM subscriptions WHERE creator_id = ? AND wallet_address = ?',
      )
      .get(creatorId, walletAddress);
    return row || null;
  }


/**
 * List active subscriptions that can be assessed for low-balance risk.
 *
 * @returns {Array<{creatorId: string, walletAddress: string, balance: number|null, dailySpend: number|null, userEmail: string|null}>}
 */
  listSubscriptionsForRiskCheck() {
  return this.db
    .prepare(
      `
        SELECT
          creator_id AS creatorId,
          wallet_address AS walletAddress,
          balance,
          daily_spend AS dailySpend,
          user_email AS userEmail
        FROM subscriptions
        WHERE active = 1
      `,
    )
    .all();
  }

/**
 * Persist estimated run-out date and optionally update risk status.
 *
 * @param {{creatorId: string, walletAddress: string, estimatedRunOutAt: string|null, riskStatus?: string|null}} input
 * @returns {void}
 */
  updateSubscriptionRiskAssessment(input) {
  if (input.riskStatus === undefined) {
    this.db
      .prepare(
        `
          UPDATE subscriptions
          SET estimated_run_out_at = ?
          WHERE creator_id = ? AND wallet_address = ?
        `,
      )
      .run(input.estimatedRunOutAt, input.creatorId, input.walletAddress);
    return;
  }

  this.db
    .prepare(
      `
        UPDATE subscriptions
        SET estimated_run_out_at = ?, risk_status = ?
        WHERE creator_id = ? AND wallet_address = ?
      `,
    )
    .run(input.estimatedRunOutAt, input.riskStatus, input.creatorId, input.walletAddress);
  }

/**
 * Create a new comment.
 *
 * @param {{postId: string, userAddress: string, creatorId: string, content: string}} comment Comment data.
 * @returns {object}
 */
  createComment(comment) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  this.db
    .prepare(
      `
        INSERT INTO comments (id, post_id, user_address, creator_id, content, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(id, comment.postId, comment.userAddress, comment.creatorId, comment.content, now, now);

  return this.getCommentById(id);
  }

/**
 * Get a comment by ID.
 *
 * @param {string} commentId Comment identifier.
 * @returns {object|null}
 */
  getCommentById(commentId) {
  const row = this.db
    .prepare(
      `
        SELECT id, post_id AS postId, user_address AS userAddress, creator_id AS creatorId, content, created_at AS createdAt, updated_at AS updatedAt
        FROM comments
        WHERE id = ?
      `,
    )
    .get(commentId);

  return row || null;
  }

/**
 * Create or activate a subscription for a wallet.
 * Returns { changed: boolean, count: number }.
 *
 * Create or activate a subscription for a wallet. Returns { changed: boolean, count: number }
 * @param {string} creatorId
 * @param {string} walletAddress
 */
  createOrActivateSubscription(creatorId, walletAddress) {
  return this.transaction(() => {
    this.ensureCreator(creatorId);
    const existing = this.getSubscription(creatorId, walletAddress);
    const now = new Date().toISOString();

    if (existing && existing.active === 1) {
      // already active
      return { changed: false, count: this.getCreatorSubscriberCount(creatorId) };
    }

    if (existing) {
      this.db
        .prepare(
          'UPDATE subscriptions SET active = 1, subscribed_at = ?, unsubscribed_at = NULL WHERE creator_id = ? AND wallet_address = ?',
        )
        .run(now, creatorId, walletAddress);
    } else {
      this.db
        .prepare(
          'INSERT INTO subscriptions (creator_id, wallet_address, active, subscribed_at) VALUES (?, ?, 1, ?)',
        )
        .run(creatorId, walletAddress, now);
    }

    this.db
      .prepare(
        'UPDATE creators SET subscriber_count = COALESCE(subscriber_count, 0) + 1 WHERE id = ?',
      )
      .run(creatorId);

    return { changed: true, count: this.getCreatorSubscriberCount(creatorId) };
});
  }

/**
 * Deactivate a subscription if it is currently active.
 * Returns { changed: boolean, count: number }.
 *
 * Deactivate a subscription if it is currently active. Returns { changed: boolean, count: number }
 * @param {string} creatorId
 * @param {string} walletAddress
 */
  deactivateSubscription(creatorId, walletAddress) {
  return this.transaction(() => {
    this.ensureCreator(creatorId);
    const existing = this.getSubscription(creatorId, walletAddress);
    const now = new Date().toISOString();

    if (!existing || existing.active !== 1) {
      return { changed: false, count: this.getCreatorSubscriberCount(creatorId) };
    }

    this.db
      .prepare(
        'UPDATE subscriptions SET active = 0, unsubscribed_at = ? WHERE creator_id = ? AND wallet_address = ?',
      )
      .run(now, creatorId, walletAddress);

    this.db
      .prepare(
        'UPDATE creators SET subscriber_count = MAX(COALESCE(subscriber_count, 0) - 1, 0) WHERE id = ?',
      )
      .run(creatorId);

    return { changed: true, count: this.getCreatorSubscriberCount(creatorId) };
  });
  }

/**
 * Count active subscriptions for a creator (derived from subscriptions table).
 *
 * @param {string} creatorId
 * @returns {number}
 */
  countActiveSubscriptions(creatorId) {
  const row = this.db
    .prepare('SELECT COUNT(1) AS ct FROM subscriptions WHERE creator_id = ? AND active = 1')
    .get(creatorId);
  return (row && Number(row.ct)) || 0;
  }


/**
 * Get comments by post ID.
 *
 * @param {string} postId Post identifier.
 * @returns {object[]}
 */
  getCommentsByPostId(postId) {
  return this.db
    .prepare(
      `
        SELECT id, post_id AS postId, user_address AS userAddress, creator_id AS creatorId, content, created_at AS createdAt, updated_at AS updatedAt
        FROM comments
        WHERE post_id = ?
        ORDER BY created_at DESC
      `,
    )
    .all(postId);
  }

/**
 * Update a comment.
 *
 * @param {{commentId: string, content: string}} input Update payload.
 * @returns {object}
 */
  updateComment(input) {
  const now = new Date().toISOString();
  this.db
    .prepare(
      `
        UPDATE comments
        SET content = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .run(input.content, now, input.commentId);

  return this.getCommentById(input.commentId);
  }

/**
 * Delete a comment.
 *
 * @param {string} commentId Comment identifier.
 * @returns {boolean}
 */
  deleteComment(commentId) {
  const result = this.db
    .prepare(
      `
        DELETE FROM comments WHERE id = ?
      `,
    )
    .run(commentId);

  return result.changes > 0;
  }

/**
 * Create a subdomain for a creator.
 *
 * @param {{creatorId: string, subdomain: string}} subdomainData Subdomain data.
 * @returns {object}
 */
  createCreatorSubdomain(subdomainData) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  this.ensureCreator(subdomainData.creatorId);

  this.db
    .prepare(
      `
        INSERT INTO creator_subdomains (id, creator_id, subdomain, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `,
    )
    .run(id, subdomainData.creatorId, subdomainData.subdomain, now, now);

  return this.getCreatorSubdomain(id);
  }

/**
 * Get a creator subdomain by ID.
 *
 * @param {string} subdomainId Subdomain identifier.
 * @returns {object|null}
 */
  getCreatorSubdomain(subdomainId) {
  const row = this.db
    .prepare(
      `
        SELECT id, creator_id AS creatorId, subdomain, status, created_at AS createdAt, updated_at AS updatedAt
        FROM creator_subdomains
        WHERE id = ?
      `,
    )
    .get(subdomainId);

  return row || null;
  }

/**
 * Get a creator subdomain by subdomain name.
 *
 * @param {string} subdomain Subdomain name.
 * @returns {object|null}
 */
  getCreatorSubdomainByName(subdomain) {
  const row = this.db
    .prepare(
      `
        SELECT id, creator_id AS creatorId, subdomain, status, created_at AS createdAt, updated_at AS updatedAt
        FROM creator_subdomains
        WHERE subdomain = ? AND status = 'active'
      `,
    )
    .get(subdomain);

  return row || null;
  }

/**
 * Get all subdomains for a creator.
 *
 * @param {string} creatorId Creator identifier.
 * @returns {object[]}
 */
  getCreatorSubdomains(creatorId) {
  return this.db
    .prepare(
      `
        SELECT id, creator_id AS creatorId, subdomain, status, created_at AS createdAt, updated_at AS updatedAt
        FROM creator_subdomains
        WHERE creator_id = ?
        ORDER BY created_at DESC
      `,
    )
    .all(creatorId);
  }

/**
 * Update a subdomain's status.
 *
 * @param {{subdomainId: string, status: string}} updateData Update data.
 * @returns {object}
 */
  updateSubdomainStatus(updateData) {
  const now = new Date().toISOString();
  this.db
    .prepare(
      `
        UPDATE creator_subdomains
        SET status = ?, updated_at = ?
        WHERE id = ?
      `,
    )
    .run(updateData.status, now, updateData.subdomainId);

  return this.getCreatorSubdomain(updateData.subdomainId);
  }

/**
 * Delete a creator subdomain.
 *
 * @param {string} subdomainId Subdomain identifier.
 * @returns {boolean}
 */
  deleteCreatorSubdomain(subdomainId) {
  const result = this.db
    .prepare(
      `
        DELETE FROM creator_subdomains WHERE id = ?
      `,
    )
    .run(subdomainId);

  return result.changes > 0;
  }

// ActivityPub Federation Methods

/**
 * Get creator information for ActivityPub
 * @param {string} address Creator wallet address
 * @returns {object|null}
 */
  getCreator(address) {
  const row = this.db
    .prepare(
      `
        SELECT id, address, name, bio, avatar, banner, created_at
        FROM creators 
        WHERE address = ?
      `,
    )
    .get(address);

  return row || null;
  }

/**
 * Get content information for federation
 * @param {string} contentId Content ID
 * @returns {object|null}
 */
  getContent(contentId) {
  const row = this.db
    .prepare(
      `
        SELECT id, creator_address, title, description, thumbnail, type, tags, created_at
        FROM content 
        WHERE id = ?
      `,
    )
    .get(contentId);

  if (row && row.tags) {
    row.tags = JSON.parse(row.tags);
  }

  return row || null;
  }

/**
 * Get creator's content for outbox
 * @param {string} creatorAddress Creator wallet address
 * @param {object} options Query options
 * @returns {object[]}
 */
  getCreatorContent(creatorAddress, options = {}) {
  const { limit = 20, offset = 0 } = options;

  const rows = this.db
    .prepare(
      `
        SELECT id, creator_address, title, description, thumbnail, type, tags, created_at
        FROM content 
        WHERE creator_address = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
    )
    .all(creatorAddress, limit, offset);

  return rows.map(row => {
    if (row.tags) {
      row.tags = JSON.parse(row.tags);
    }
    return row;
  });
  }

/**
 * Get creator's content count
 * @param {string} creatorAddress Creator wallet address
 * @returns {number}
 */
  getCreatorContentCount(creatorAddress) {
  const row = this.db
    .prepare(
      `
        SELECT COUNT(*) as count
        FROM content 
        WHERE creator_address = ?
      `,
    )
    .get(creatorAddress);

  return row.count || 0;
  }

/**
 * Add ActivityPub follower
 * @param {object} followerData Follower information
 * @returns {object}
 */
  addFollower(followerData) {
  const id = crypto.randomUUID();

  this.db
    .prepare(
      `
        INSERT INTO activitypub_followers (
          id, creator_address, follower_actor, follower_inbox,
          follower_shared_inbox, follow_activity_id, follower_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      followerData.creator_address,
      followerData.follower_actor,
      followerData.follower_inbox || '',
      followerData.follower_shared_inbox || '',
      followerData.follow_activity_id,
      JSON.stringify(followerData.follower_data || {})
    );

  return this.db
    .prepare('SELECT * FROM activitypub_followers WHERE id = ?')
    .get(id);
  }

/**
 * Remove ActivityPub follower
 * @param {object} followerData Follower information
 * @returns {boolean}
 */
  removeFollower(followerData) {
  const result = this.db
    .prepare(
      `
        DELETE FROM activitypub_followers 
        WHERE creator_address = ? AND follower_actor = ?
      `,
    )
    .run(followerData.creator_address, followerData.follower_actor);

  return result.changes > 0;
  }

/**
 * Add ActivityPub engagement
 * @param {object} engagementData Engagement information
 * @returns {object}
 */
  addEngagement(engagementData) {
  const id = crypto.randomUUID();

  this.db
    .prepare(
      `
        INSERT INTO activitypub_engagements (
          id, creator_address, activity_type, activity_actor,
          activity_id, object_id, object_type, activity_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      id,
      engagementData.creator_address,
      engagementData.activity_type,
      engagementData.activity_actor,
      engagementData.activity_id,
      engagementData.object_id || '',
      engagementData.object_type || '',
      JSON.stringify(engagementData.activity_data || {})
    );

  return this.db
    .prepare('SELECT * FROM activitypub_engagements WHERE id = ?')
    .get(id);
  }

/**
 * Get creator subscriber count
 * @param {string} creatorId Creator ID
 * @returns {number}
 */
  getCreatorSubscriberCount(creatorId) {
  const row = this.db
    .prepare(
      `
        SELECT COUNT(*) as count
        FROM activitypub_followers 
        WHERE creator_address = ? AND active = 1
      `,
    )
    .get(creatorId);

  return row.count || 0;
  }

/**
 * Get privacy preferences for a wallet address
 * @param {string} walletAddress
 * @returns {object|null}
 */
  getPrivacyPreferences(walletAddress) {
  const row = this.db
    .prepare(
      `
        SELECT wallet_address, share_email_with_merchants, allow_marketing, updated_at
        FROM privacy_preferences
        WHERE wallet_address = ?
      `,
    )
    .get(walletAddress);

  if (!row) return null;

  return {
    ...row,
    share_email_with_merchants: Boolean(row.share_email_with_merchants),
    allow_marketing: Boolean(row.allow_marketing),
  };
  }

/**
 * Create or update privacy preferences
 * @param {string} walletAddress
 * @param {object} preferences
 * @returns {object}
 */
  upsertPrivacyPreferences(walletAddress, preferences) {
  const now = new Date().toISOString();
  
  // Use INSERT OR REPLACE or similar depending on DB
  // For better-sqlite3:
  this.db
    .prepare(
      `
        INSERT INTO privacy_preferences (
          wallet_address, share_email_with_merchants, allow_marketing, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(wallet_address) DO UPDATE SET
          share_email_with_merchants = excluded.share_email_with_merchants,
          allow_marketing = excluded.allow_marketing,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      walletAddress,
      preferences.share_email_with_merchants !== undefined ? (preferences.share_email_with_merchants ? 1 : 0) : 1,
      preferences.allow_marketing !== undefined ? (preferences.allow_marketing ? 1 : 0) : 1,
      now
    );

  return this.getPrivacyPreferences(walletAddress);
  }

/**
 * Create a new dunning sequence
 * @param {object} sequence
 */
  createDunningSequence(sequence) {
  this.db
    .prepare(
      `
        INSERT INTO dunning_sequences (
          id, wallet_address, creator_id, status, current_day,
          last_notified_at, next_notification_at, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      sequence.id,
      sequence.wallet_address,
      sequence.creator_id,
      sequence.status,
      sequence.current_day,
      new Date().toISOString(),
      sequence.next_notification_at,
      new Date().toISOString(),
      new Date().toISOString()
    );
  }

/**
 * Get active dunning sequences that need notification
 * @returns {object[]}
 */
  getActiveDunningSequences() {
  return this.db
    .prepare(
      `
        SELECT * FROM dunning_sequences
        WHERE status = 'active' AND next_notification_at <= ?
      `,
    )
    .all(new Date().toISOString());
  }

/**
 * Update a dunning sequence
 * @param {string} id
 * @param {object} updates
 */
  updateDunningSequence(id, updates) {
  const fields = Object.keys(updates);
  const values = Object.values(updates);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  
  this.db
    .prepare(`UPDATE dunning_sequences SET ${setClause}, updated_at = ? WHERE id = ?`)
    .run(...values, new Date().toISOString(), id);
  }

/**
 * Halt an active dunning sequence
 * @param {string} walletAddress
 * @param {string} creatorId
 */
  haltDunningSequence(walletAddress, creatorId) {
  this.db
    .prepare(
      `
        UPDATE dunning_sequences
        SET status = 'halted', updated_at = ?
        WHERE wallet_address = ? AND creator_id = ? AND status = 'active'
      `,
    )
    .run(new Date().toISOString(), walletAddress, creatorId);
  }

/**
 * Record dunning event history
 * @param {object} history
 */
  recordDunningHistory(history) {
  this.db
    .prepare(
      `
        INSERT INTO dunning_history (
          id, sequence_id, event_type, occurred_at, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      history.id,
      history.sequence_id,
      history.event_type,
      new Date().toISOString(),
      history.status,
      JSON.stringify(history.metadata_json || {})
    );
  }
  }

module.exports = {
  AppDatabase,
  getDatabase: (filename) => new AppDatabase(filename),
};