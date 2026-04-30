const SorobanBalanceChecker = require('./sorobanBalanceChecker');

/**
 * Pre-Billing Health Check Service
 * Daily cron job that checks subscriptions 3 days before billing
 */
class PreBillingHealthCheck {
  constructor(config = {}) {
    this.database = config.database;
    this.emailService = config.emailService;
    this.balanceChecker = new SorobanBalanceChecker(config.soroban || {});
    this.warningThresholdDays = config.warningThresholdDays || 3;
    this.batchSize = config.batchSize || 50;
    this.maxRetries = config.maxRetries || 3;
    // Optional SeasonalPauseService — when present, paused plans are skipped
    // and skipped_cycles are recorded for reconciliation on resume.
    this.seasonalPauseService = config.seasonalPauseService || null;

    if (!this.database) {
      throw new Error('database is required');
    }

    if (!this.emailService) {
      throw new Error('emailService is required');
    }

    this.ensureDatabaseSchema();
  }

  /**
   * Ensure database has required columns for pre-billing checks
   */
  ensureDatabaseSchema() {
    try {
      // Check if next_billing_date column exists
      const tableInfo = this.database.db.prepare("PRAGMA table_info(subscriptions);").all();
      const hasNextBillingDate = tableInfo.some(col => col.name === 'next_billing_date');
      const hasNextWarningSent = tableInfo.some(col => col.name === 'warning_sent_at');
      const hasRequiredAmount = tableInfo.some(col => col.name === 'required_amount');

      if (!hasNextBillingDate) {
        this.database.db.exec('ALTER TABLE subscriptions ADD COLUMN next_billing_date TEXT');
      }

      if (!hasNextWarningSent) {
        this.database.db.exec('ALTER TABLE subscriptions ADD COLUMN warning_sent_at TEXT');
      }

      if (!hasRequiredAmount) {
        this.database.db.exec('ALTER TABLE subscriptions ADD COLUMN required_amount REAL DEFAULT 0');
      }

      // Create indexes for performance
      this.database.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing_date);
        CREATE INDEX IF NOT EXISTS idx_subscriptions_warning_sent ON subscriptions(warning_sent_at);
      `);

    } catch (error) {
      console.error('Failed to ensure database schema:', error);
      throw error;
    }
  }

  /**
   * Run the daily pre-billing health check
   * @param {Object} options - Options for the health check
   * @returns {Promise<Object>} Health check results
   */
  async runDailyHealthCheck(options = {}) {
    const now = options.now || new Date();
    const targetDate = new Date(now.getTime() + (this.warningThresholdDays * 24 * 60 * 60 * 1000));

    console.log(`Starting pre-billing health check for ${targetDate.toISOString()}`);

    try {
      // Get subscriptions due for billing in exactly 3 days
      const allDue = this.getSubscriptionsDueForBilling(targetDate);
      console.log(`Found ${allDue.length} subscriptions due for billing on ${targetDate.toISOString()}`);

      // Honor any active seasonal pause: paused plans skip the pull entirely
      // and we record a skipped_cycle entry so resume math can reconcile.
      const { active: subscriptions, skipped: skippedDuringPause } =
        this.partitionPausedSubscriptions(allDue);

      if (skippedDuringPause > 0) {
        console.log(
          `Skipped ${skippedDuringPause} paused subscriptions (Seasonally_Inactive)`
        );
      }

      if (subscriptions.length === 0) {
        return {
          processed: 0,
          warningsSent: 0,
          errors: 0,
          skipped: skippedDuringPause,
          message:
            skippedDuringPause > 0
              ? 'All due subscriptions belonged to paused plans and were skipped'
              : 'No subscriptions due for billing in the warning window'
        };
      }

      // Process subscriptions in batches
      const results = await this.processSubscriptions(subscriptions);
      results.skipped = skippedDuringPause;

      // Clean up expired cache entries
      this.balanceChecker.clearExpiredCache();

      console.log(`Pre-billing health check completed:`, results);
      return results;

    } catch (error) {
      console.error('Pre-billing health check failed:', error);
      throw error;
    }
  }

  /**
   * Get subscriptions due for billing on the target date
   * @param {Date} targetDate - Target billing date
   * @returns {Array} Array of subscription records
   */
  getSubscriptionsDueForBilling(targetDate) {
    const targetDateString = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD format

    const query = `
      SELECT 
        creator_id AS creatorId,
        wallet_address AS walletAddress,
        user_email AS userEmail,
        next_billing_date AS nextBillingDate,
        required_amount AS requiredAmount,
        warning_sent_at AS warningSentAt,
        stripe_plan_id AS stripePlanId
      FROM subscriptions 
      WHERE active = 1 
        AND next_billing_date IS NOT NULL
        AND DATE(next_billing_date) = ?
        AND (warning_sent_at IS NULL OR DATE(warning_sent_at) != DATE('now'))
    `;

    return this.database.db.prepare(query).all(targetDateString);
  }

  /**
   * Process subscriptions in batches
   * @param {Array} subscriptions - Array of subscription records
   * @returns {Promise<Object>} Processing results
   */
  async processSubscriptions(subscriptions) {
    let processed = 0;
    let warningsSent = 0;
    let errors = 0;
    const errorDetails = [];

    // Process in batches to respect rate limits
    for (let i = 0; i < subscriptions.length; i += this.batchSize) {
      const batch = subscriptions.slice(i, i + this.batchSize);
      console.log(`Processing batch ${Math.floor(i / this.batchSize) + 1}/${Math.ceil(subscriptions.length / this.batchSize)}`);

      const batchResults = await this.processBatch(batch);
      processed += batchResults.processed;
      warningsSent += batchResults.warningsSent;
      errors += batchResults.errors;
      errorDetails.push(...batchResults.errorDetails);

      // Add delay between batches to respect rate limits
      if (i + this.batchSize < subscriptions.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    return {
      processed,
      warningsSent,
      errors,
      errorDetails,
      message: `Processed ${processed} subscriptions, sent ${warningsSent} warnings`
    };
  }

  /**
   * Process a batch of subscriptions
   * @param {Array} batch - Batch of subscription records
   * @returns {Promise<Object>} Batch processing results
   */
  async processBatch(batch) {
    let processed = 0;
    let warningsSent = 0;
    let errors = 0;
    const errorDetails = [];

    // Perform health checks for all wallets in the batch
    const walletAddresses = batch.map(sub => sub.walletAddress);
    const healthChecks = await this.balanceChecker.batchHealthCheck(
      walletAddresses,
      undefined, // Use default contract ID
      batch.map(sub => sub.requiredAmount || 0)
    );

    // Process each subscription with its health check result
    for (let i = 0; i < batch.length; i++) {
      const subscription = batch[i];
      const healthCheck = healthChecks[i];

      try {
        processed++;

        if (!healthCheck.isHealthy) {
          // Send warning email
          await this.sendWarningEmail(subscription, healthCheck);
          warningsSent++;

          // Update warning timestamp
          this.updateWarningTimestamp(subscription);

          // Log without exposing user data
          console.log('Warning sent for subscription with health check failure');
        } else {
          // Log without exposing user data
          console.log('Health check passed for subscription');
        }

      } catch (error) {
        errors++;
        const errorDetail = {
          subscription: subscription,
          error: error.message,
          timestamp: new Date().toISOString()
        };
        errorDetails.push(errorDetail);
        console.error(`Failed to process subscription for wallet ${subscription.walletAddress}:`, error);
      }
    }

    return {
      processed,
      warningsSent,
      errors,
      errorDetails
    };
  }

  /**
   * Send warning email to user
   * @param {Object} subscription - Subscription record
   * @param {Object} healthCheck - Health check result
   * @returns {Promise<void>}
   */
  async sendWarningEmail(subscription, healthCheck) {
    if (!subscription.userEmail) {
      console.warn(`No email address for wallet ${subscription.walletAddress}`);
      return;
    }

    const emailData = {
      to: subscription.userEmail,
      subject: 'Action Required: Your Substream payment will fail in 3 days',
      template: 'pre_billing_warning',
      data: {
        walletAddress: subscription.walletAddress,
        creatorId: subscription.creatorId,
        nextBillingDate: subscription.nextBillingDate,
        requiredAmount: subscription.requiredAmount || 0,
        issues: healthCheck.issues,
        balanceCheck: healthCheck.balanceCheck,
        authCheck: healthCheck.authCheck,
        warningDays: this.warningThresholdDays
      }
    };

    try {
      await this.emailService.sendEmail(emailData);
      console.log(`Warning email sent to ${subscription.userEmail}`);
    } catch (error) {
      console.error(`Failed to send warning email to ${subscription.userEmail}:`, error);
      throw error;
    }
  }

  /**
   * Update warning timestamp for subscription
   * @param {Object} subscription - Subscription record
   */
  updateWarningTimestamp(subscription) {
    const now = new Date().toISOString();

    this.database.db.prepare(`
      UPDATE subscriptions 
      SET warning_sent_at = ?
      WHERE creator_id = ? AND wallet_address = ?
    `).run(now, subscription.creatorId, subscription.walletAddress);
  }

  /**
   * Split a list of due subscriptions into ones that should bill and ones
   * whose plan is currently Seasonally_Inactive. For each skipped subscription
   * we record a skipped_cycles row so resume can reconcile correctly.
   *
   * @param {Array} subscriptions
   * @returns {{active: Array, skipped: number}}
   */
  partitionPausedSubscriptions(subscriptions) {
    if (!this.seasonalPauseService || subscriptions.length === 0) {
      return { active: subscriptions, skipped: 0 };
    }

    const active = [];
    let skipped = 0;

    for (const sub of subscriptions) {
      const planId = sub.stripePlanId;
      if (planId && this.seasonalPauseService.isPlanPaused(planId)) {
        const result = this.seasonalPauseService.maybeSkipBilling({
          planId,
          creatorId: sub.creatorId,
          walletAddress: sub.walletAddress,
          scheduledBillingDate: sub.nextBillingDate,
          requiredAmount: sub.requiredAmount || 0,
        });
        if (result.skipped) {
          skipped += 1;
          continue;
        }
      }
      active.push(sub);
    }

    return { active, skipped };
  }

  /**
   * Update next billing date for a subscription
   * @param {string} creatorId - Creator ID
   * @param {string} walletAddress - Wallet address
   * @param {Date} nextBillingDate - Next billing date
   * @param {number} requiredAmount - Required amount for payment
   */
  updateNextBillingDate(creatorId, walletAddress, nextBillingDate, requiredAmount = 0) {
    this.database.db.prepare(`
      UPDATE subscriptions 
      SET next_billing_date = ?, required_amount = ?
      WHERE creator_id = ? AND wallet_address = ?
    `).run(nextBillingDate.toISOString(), requiredAmount, creatorId, walletAddress);
  }

  /**
   * Get health check statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      warningThresholdDays: this.warningThresholdDays,
      batchSize: this.batchSize,
      maxRetries: this.maxRetries,
      balanceChecker: this.balanceChecker.getStats()
    };
  }

  /**
   * Test the health check system with a specific wallet
   * @param {string} walletAddress - Wallet address to test
   * @param {number} requiredAmount - Required amount for payment
   * @returns {Promise<Object>} Test result
   */
  async testHealthCheck(walletAddress, requiredAmount = 0) {
    try {
      const healthCheck = await this.balanceChecker.performHealthCheck(
        walletAddress,
        undefined,
        requiredAmount
      );

      return {
        walletAddress,
        requiredAmount,
        healthCheck,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        walletAddress,
        requiredAmount,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get subscriptions that need warnings (for monitoring)
   * @param {number} daysAhead - Number of days ahead to check
   * @returns {Array} Array of subscriptions
   */
  getSubscriptionsNeedingWarnings(daysAhead = this.warningThresholdDays) {
    const targetDate = new Date(Date.now() + (daysAhead * 24 * 60 * 60 * 1000));
    const targetDateString = targetDate.toISOString().split('T')[0];

    const query = `
      SELECT 
        creator_id AS creatorId,
        wallet_address AS walletAddress,
        user_email AS userEmail,
        next_billing_date AS nextBillingDate,
        required_amount AS requiredAmount,
        warning_sent_at AS warningSentAt
      FROM subscriptions 
      WHERE active = 1 
        AND next_billing_date IS NOT NULL
        AND DATE(next_billing_date) = ?
        AND (warning_sent_at IS NULL OR DATE(warning_sent_at) != DATE('now'))
    `;

    return this.database.db.prepare(query).all(targetDateString);
  }

  /**
   * Manually trigger health check for specific date
   * @param {Date} targetDate - Target date to check
   * @returns {Promise<Object>} Health check results
   */
  async triggerHealthCheckForDate(targetDate) {
    return this.runDailyHealthCheck({ now: new Date(Date.now() - (this.warningThresholdDays * 24 * 60 * 60 * 1000) + (targetDate.getTime() - Date.now())) });
  }
}

module.exports = PreBillingHealthCheck;
