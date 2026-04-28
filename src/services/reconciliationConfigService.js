/**
 * Reconciliation Configuration Service
 * 
 * Manages reconciliation configuration for merchants including settings,
 * thresholds, and notification preferences.
 */
class ReconciliationConfigService {
  constructor(database) {
    this.database = database;
  }

  /**
   * Get reconciliation configuration for a merchant
   */
  async getMerchantConfig(merchantId) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM reconciliation_config WHERE merchant_id = $1',
        [merchantId]
      );
      
      if (result.rows.length === 0) {
        // Return default configuration
        return this.getDefaultConfig(merchantId);
      }

      return result.rows[0];

    } finally {
      client.release();
    }
  }

  /**
   * Create or update merchant reconciliation configuration
   */
  async upsertMerchantConfig(merchantId, config) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(`
        INSERT INTO reconciliation_config (
          merchant_id, enabled, auto_heal_enabled, max_healing_attempts,
          healing_retry_delay_minutes, discrepancy_threshold_amount,
          discrepancy_threshold_percentage, notify_on_discrepancy,
          notify_on_healing_failure, notification_email
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (merchant_id) 
        DO UPDATE SET 
          enabled = excluded.enabled,
          auto_heal_enabled = excluded.auto_heal_enabled,
          max_healing_attempts = excluded.max_healing_attempts,
          healing_retry_delay_minutes = excluded.healing_retry_delay_minutes,
          discrepancy_threshold_amount = excluded.discrepancy_threshold_amount,
          discrepancy_threshold_percentage = excluded.discrepancy_threshold_percentage,
          notify_on_discrepancy = excluded.notify_on_discrepancy,
          notify_on_healing_failure = excluded.notify_on_healing_failure,
          notification_email = excluded.notification_email,
          updated_at = NOW()
        RETURNING *
      `, [
        merchantId,
        config.enabled !== undefined ? config.enabled : true,
        config.auto_heal_enabled !== undefined ? config.auto_heal_enabled : true,
        config.max_healing_attempts || 3,
        config.healing_retry_delay_minutes || 5,
        config.discrepancy_threshold_amount || 0.000001,
        config.discrepancy_threshold_percentage || 0.01,
        config.notify_on_discrepancy !== undefined ? config.notify_on_discrepancy : true,
        config.notify_on_healing_failure !== undefined ? config.notify_on_healing_failure : true,
        config.notification_email || null
      ]);

      return result.rows[0];

    } finally {
      client.release();
    }
  }

  /**
   * Get default configuration for a merchant
   */
  getDefaultConfig(merchantId) {
    return {
      id: null,
      merchant_id: merchantId,
      enabled: true,
      auto_heal_enabled: true,
      max_healing_attempts: 3,
      healing_retry_delay_minutes: 5,
      discrepancy_threshold_amount: 0.000001, // 1 stroop
      discrepancy_threshold_percentage: 0.01, // 0.01%
      notify_on_discrepancy: true,
      notify_on_healing_failure: true,
      notification_email: null,
      created_at: new Date(),
      updated_at: new Date()
    };
  }

  /**
   * Enable reconciliation for a merchant
   */
  async enableMerchant(merchantId) {
    return await this.updateMerchantField(merchantId, 'enabled', true);
  }

  /**
   * Disable reconciliation for a merchant
   */
  async disableMerchant(merchantId) {
    return await this.updateMerchantField(merchantId, 'enabled', false);
  }

  /**
   * Enable auto-healing for a merchant
   */
  async enableAutoHealing(merchantId) {
    return await this.updateMerchantField(merchantId, 'auto_heal_enabled', true);
  }

  /**
   * Disable auto-healing for a merchant
   */
  async disableAutoHealing(merchantId) {
    return await this.updateMerchantField(merchantId, 'auto_heal_enabled', false);
  }

  /**
   * Update discrepancy thresholds for a merchant
   */
  async updateThresholds(merchantId, amountThreshold, percentageThreshold) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(`
        UPDATE reconciliation_config 
        SET discrepancy_threshold_amount = $2,
            discrepancy_threshold_percentage = $3,
            updated_at = NOW()
        WHERE merchant_id = $1
        RETURNING *
      `, [merchantId, amountThreshold, percentageThreshold]);

      return result.rows[0];

    } finally {
      client.release();
    }
  }

  /**
   * Update notification settings for a merchant
   */
  async updateNotificationSettings(merchantId, notifyOnDiscrepancy, notifyOnHealingFailure, notificationEmail) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(`
        UPDATE reconciliation_config 
        SET notify_on_discrepancy = $2,
            notify_on_healing_failure = $3,
            notification_email = $4,
            updated_at = NOW()
        WHERE merchant_id = $1
        RETURNING *
      `, [merchantId, notifyOnDiscrepancy, notifyOnHealingFailure, notificationEmail]);

      return result.rows[0];

    } finally {
      client.release();
    }
  }

  /**
   * Update a single field for a merchant
   */
  async updateMerchantField(merchantId, field, value) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(`
        UPDATE reconciliation_config 
        SET ${field} = $2, updated_at = NOW()
        WHERE merchant_id = $1
        RETURNING *
      `, [merchantId, value]);

      if (result.rows.length === 0) {
        // Create config if it doesn't exist
        return await this.upsertMerchantConfig(merchantId, { [field]: value });
      }

      return result.rows[0];

    } finally {
      client.release();
    }
  }

  /**
   * Get all enabled merchants
   */
  async getEnabledMerchants() {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM reconciliation_config WHERE enabled = true ORDER BY merchant_id'
      );
      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Get all merchants with their configuration
   */
  async getAllMerchants() {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM reconciliation_config ORDER BY merchant_id'
      );
      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Delete merchant configuration
   */
  async deleteMerchantConfig(merchantId) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        'DELETE FROM reconciliation_config WHERE merchant_id = $1 RETURNING *',
        [merchantId]
      );
      return result.rows[0] || null;

    } finally {
      client.release();
    }
  }

  /**
   * Bulk update merchant configurations
   */
  async bulkUpdateConfigs(updates) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');

      const results = [];
      for (const update of updates) {
        const result = await this.upsertMerchantConfig(update.merchantId, update.config);
        results.push(result);
      }

      await client.query('COMMIT');
      return results;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get configuration statistics
   */
  async getConfigStats() {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          COUNT(*) as total_merchants,
          COUNT(CASE WHEN enabled = true THEN 1 END) as enabled_merchants,
          COUNT(CASE WHEN auto_heal_enabled = true THEN 1 END) as auto_heal_enabled,
          COUNT(CASE WHEN notify_on_discrepancy = true THEN 1 END) as discrepancy_notifications_enabled,
          AVG(discrepancy_threshold_percentage) as avg_threshold_percentage,
          AVG(max_healing_attempts) as avg_healing_attempts
        FROM reconciliation_config
      `);

      return result.rows[0];

    } finally {
      client.release();
    }
  }

  /**
   * Validate configuration values
   */
  validateConfig(config) {
    const errors = [];

    if (config.discrepancy_threshold_amount !== undefined) {
      if (typeof config.discrepancy_threshold_amount !== 'number' || config.discrepancy_threshold_amount < 0) {
        errors.push('discrepancy_threshold_amount must be a non-negative number');
      }
    }

    if (config.discrepancy_threshold_percentage !== undefined) {
      if (typeof config.discrepancy_threshold_percentage !== 'number' || 
          config.discrepancy_threshold_percentage < 0 || 
          config.discrepancy_threshold_percentage > 100) {
        errors.push('discrepancy_threshold_percentage must be a number between 0 and 100');
      }
    }

    if (config.max_healing_attempts !== undefined) {
      if (!Number.isInteger(config.max_healing_attempts) || 
          config.max_healing_attempts < 0 || 
          config.max_healing_attempts > 10) {
        errors.push('max_healing_attempts must be an integer between 0 and 10');
      }
    }

    if (config.healing_retry_delay_minutes !== undefined) {
      if (!Number.isInteger(config.healing_retry_delay_minutes) || 
          config.healing_retry_delay_minutes < 1 || 
          config.healing_retry_delay_minutes > 1440) {
        errors.push('healing_retry_delay_minutes must be an integer between 1 and 1440');
      }
    }

    if (config.notification_email !== undefined && config.notification_email !== null) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(config.notification_email)) {
        errors.push('notification_email must be a valid email address');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Get merchants that need attention (e.g., high discrepancy rates)
   */
  async getMerchantsNeedingAttention(days = 7) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          rc.merchant_id,
          rc.enabled,
          rc.auto_heal_enabled,
          COUNT(rr.id) as total_reports,
          COUNT(CASE WHEN rr.total_discrepancies > 0 THEN 1 END) as reports_with_discrepancies,
          SUM(rr.total_discrepancies) as total_discrepancies,
          SUM(rr.failed_to_heal_count) as total_failed_heals,
          AVG(CASE WHEN rr.total_discrepancies > 0 THEN 
            (rr.total_discrepancies::FLOAT / NULLIF(rr.total_subscription_billed_events, 0)) * 100 
          END) as avg_discrepancy_percentage
        FROM reconciliation_config rc
        LEFT JOIN reconciliation_reports rr ON rc.merchant_id = rr.merchant_id
          AND rr.report_date >= CURRENT_DATE - INTERVAL '${days} days'
        WHERE rc.enabled = true
        GROUP BY rc.merchant_id, rc.enabled, rc.auto_heal_enabled
        HAVING COUNT(rr.id) > 0
        ORDER BY total_discrepancies DESC, total_failed_heals DESC
      `;

      const result = await client.query(query);
      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Export configuration to CSV
   */
  async exportConfigToCsv() {
    const merchants = await this.getAllMerchants();
    
    const headers = [
      'merchant_id',
      'enabled',
      'auto_heal_enabled',
      'max_healing_attempts',
      'healing_retry_delay_minutes',
      'discrepancy_threshold_amount',
      'discrepancy_threshold_percentage',
      'notify_on_discrepancy',
      'notify_on_healing_failure',
      'notification_email',
      'created_at',
      'updated_at'
    ];

    const csvRows = [headers.join(',')];
    
    for (const merchant of merchants) {
      const row = [
        merchant.merchant_id,
        merchant.enabled,
        merchant.auto_heal_enabled,
        merchant.max_healing_attempts,
        merchant.healing_retry_delay_minutes,
        merchant.discrepancy_threshold_amount,
        merchant.discrepancy_threshold_percentage,
        merchant.notify_on_discrepancy,
        merchant.notify_on_healing_failure,
        merchant.notification_email || '',
        merchant.created_at,
        merchant.updated_at
      ];
      csvRows.push(row.join(','));
    }

    return csvRows.join('\n');
  }
}

module.exports = ReconciliationConfigService;
