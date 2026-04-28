const { ReconciliationScheduler } = require('./reconciliationScheduler');
const { ReconciliationAnalyticsValidator } = require('./reconciliationAnalyticsValidator');
const { ReconciliationConfigService } = require('./reconciliationConfigService');
const { EventEmitter } = require('events');

/**
 * Reconciliation Manager Service
 * 
 * Main integration point for the reconciliation system.
 * Coordinates the scheduler, worker, analytics validator, and configuration service.
 */
class ReconciliationManager extends EventEmitter {
  constructor(database, sorobanRpcService, config = {}) {
    super();
    
    this.database = database;
    this.sorobanRpcService = sorobanRpcService;
    this.config = config;
    
    // Initialize sub-services
    this.configService = new ReconciliationConfigService(database);
    this.analyticsValidator = new ReconciliationAnalyticsValidator(database, sorobanRpcService, config.analytics || {});
    this.scheduler = null;
    
    // Manager state
    this.isRunning = false;
    this.startTime = null;
    
    // Statistics
    this.stats = {
      uptime: 0,
      totalReconciliations: 0,
      totalValidations: 0,
      totalDiscrepanciesFound: 0,
      totalAutoHealed: 0,
      lastReconciliationTime: null,
      lastValidationTime: null
    };
  }

  /**
   * Start the reconciliation system
   */
  async start() {
    if (this.isRunning) {
      this.emit('warning', 'Reconciliation manager is already running');
      return;
    }

    try {
      this.startTime = new Date();
      
      // Initialize and start the scheduler
      this.scheduler = new ReconciliationScheduler(
        this.database,
        this.sorobanRpcService,
        this.config.scheduler || {}
      );

      // Set up event listeners
      this.setupEventListeners();

      // Start the scheduler
      await this.scheduler.start();

      this.isRunning = true;
      
      this.emit('started', {
        timestamp: this.startTime.toISOString(),
        config: this.config
      });

      console.log('Reconciliation manager started successfully');

    } catch (error) {
      this.emit('error', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the reconciliation system
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    try {
      // Stop the scheduler
      if (this.scheduler) {
        await this.scheduler.stop();
        this.scheduler = null;
      }

      this.isRunning = false;
      this.stats.uptime = Date.now() - this.startTime.getTime();

      this.emit('stopped', {
        timestamp: new Date().toISOString(),
        finalStats: this.stats
      });

      console.log('Reconciliation manager stopped');

    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Run reconciliation for a specific merchant
   */
  async reconcileMerchant(merchantId, targetDate = new Date()) {
    if (!this.scheduler?.worker) {
      throw new Error('Reconciliation worker not available');
    }

    try {
      const result = await this.scheduler.worker.reconcileMerchant(merchantId, targetDate);
      
      // Update statistics
      this.updateStats({
        totalReconciliations: this.stats.totalReconciliations + 1,
        totalDiscrepanciesFound: this.stats.totalDiscrepanciesFound + (result.total_discrepancies || 0),
        totalAutoHealed: this.stats.totalAutoHealed + (result.auto_healed_count || 0),
        lastReconciliationTime: new Date()
      });

      this.emit('merchant_reconciled', {
        merchantId,
        targetDate,
        result
      });

      return result;

    } catch (error) {
      this.emit('merchant_reconciliation_error', {
        merchantId,
        targetDate,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Run full daily reconciliation
   */
  async runDailyReconciliation(targetDate = new Date()) {
    if (!this.scheduler) {
      throw new Error('Reconciliation scheduler not available');
    }

    try {
      const result = await this.scheduler.runManualReconciliation(targetDate);
      
      // Update statistics
      this.updateStats({
        totalReconciliations: this.stats.totalReconciliations + 1,
        totalDiscrepanciesFound: this.stats.totalDiscrepanciesFound + result.totalDiscrepanciesFound,
        totalAutoHealed: this.stats.totalAutoHealed + result.totalAutoHealed,
        lastReconciliationTime: new Date()
      });

      this.emit('daily_reconciliation_completed', result);

      return result;

    } catch (error) {
      this.emit('daily_reconciliation_error', error);
      throw error;
    }
  }

  /**
   * Validate metrics for a merchant
   */
  async validateMerchantMetrics(merchantId, targetDate = new Date()) {
    try {
      const result = await this.analyticsValidator.validateAllMetrics(merchantId, targetDate);
      
      // Update statistics
      this.updateStats({
        totalValidations: this.stats.totalValidations + 1,
        lastValidationTime: new Date()
      });

      this.emit('metrics_validated', {
        merchantId,
        targetDate,
        result
      });

      return result;

    } catch (error) {
      this.emit('metrics_validation_error', {
        merchantId,
        targetDate,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get reconciliation report for a merchant
   */
  async getMerchantReport(merchantId, reportDate) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          rr.*,
          COUNT(rd.id) as discrepancy_details_count
        FROM reconciliation_reports rr
        LEFT JOIN reconciliation_discrepancies rd ON rr.id = rd.reconciliation_report_id
        WHERE rr.merchant_id = $1 AND rr.report_date = $2
        GROUP BY rr.id
      `;

      const result = await client.query(query, [merchantId, reportDate]);
      
      if (result.rows.length === 0) {
        return null;
      }

      const report = result.rows[0];

      // Get detailed discrepancies if any
      if (report.discrepancy_details_count > 0) {
        const discrepancyQuery = `
          SELECT * FROM reconciliation_discrepancies 
          WHERE reconciliation_report_id = $1 
          ORDER BY created_at DESC
        `;
        
        const discrepancyResult = await client.query(discrepancyQuery, [report.id]);
        report.discrepancies = discrepancyResult.rows;
      } else {
        report.discrepancies = [];
      }

      return report;

    } finally {
      client.release();
    }
  }

  /**
   * Get merchant reconciliation history
   */
  async getMerchantHistory(merchantId, days = 30) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          report_date,
          status,
          total_subscription_billed_events,
          total_on_chain_amount,
          total_database_amount,
          total_discrepancies,
          auto_healed_count,
          failed_to_heal_count,
          completed_at,
          processing_time_seconds
        FROM reconciliation_reports
        WHERE merchant_id = $1
          AND report_date >= CURRENT_DATE - INTERVAL '${days} days'
        ORDER BY report_date DESC
      `;

      const result = await client.query(query, [merchantId]);
      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Get system-wide reconciliation summary
   */
  async getSystemSummary(days = 7) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          COUNT(DISTINCT merchant_id) as active_merchants,
          COUNT(*) as total_reports,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_reports,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_reports,
          SUM(total_subscription_billed_events) as total_events_processed,
          SUM(total_on_chain_amount) as total_on_chain_volume,
          SUM(total_database_amount) as total_database_volume,
          SUM(total_discrepancies) as total_discrepancies,
          SUM(auto_healed_count) as total_auto_healed,
          SUM(failed_to_heal_count) as total_failed_heals,
          AVG(processing_time_seconds) as avg_processing_time
        FROM reconciliation_reports
        WHERE report_date >= CURRENT_DATE - INTERVAL '${days} days'
      `;

      const result = await client.query(query);
      return result.rows[0];

    } finally {
      client.release();
    }
  }

  /**
   * Get discrepancy analytics
   */
  async getDiscrepancyAnalytics(days = 30) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          discrepancy_type,
          COUNT(*) as count,
          COUNT(CASE WHEN healing_status = 'healed' THEN 1 END) as healed_count,
          COUNT(CASE WHEN healing_status = 'failed' THEN 1 END) as failed_count,
          AVG(amount_difference) as avg_amount_difference,
          SUM(amount_difference) as total_amount_difference
        FROM reconciliation_discrepancies
        WHERE created_at >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY discrepancy_type
        ORDER BY count DESC
      `;

      const result = await client.query(query);
      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Get top merchants by discrepancy count
   */
  async getTopDiscrepancyMerchants(days = 7, limit = 10) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          merchant_id,
          COUNT(*) as total_reports,
          SUM(total_discrepancies) as total_discrepancies,
          SUM(auto_healed_count) as total_auto_healed,
          AVG(CASE WHEN total_subscription_billed_events > 0 THEN 
            (total_discrepancies::FLOAT / total_subscription_billed_events) * 100 
          END) as avg_discrepancy_rate
        FROM reconciliation_reports
        WHERE report_date >= CURRENT_DATE - INTERVAL '${days} days'
          AND total_discrepancies > 0
        GROUP BY merchant_id
        ORDER BY total_discrepancies DESC
        LIMIT $1
      `;

      const result = await client.query(query, [limit]);
      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Set up event listeners
   */
  setupEventListeners() {
    if (!this.scheduler) {
      return;
    }

    // Forward scheduler events
    this.scheduler.on('reconciliation_completed', (data) => {
      this.emit('reconciliation_completed', data);
    });

    this.scheduler.on('reconciliation_failed', (data) => {
      this.emit('reconciliation_failed', data);
    });

    this.scheduler.on('merchant_reconciled', (data) => {
      this.emit('merchant_reconciled', data);
    });

    this.scheduler.on('merchant_error', (data) => {
      this.emit('merchant_error', data);
    });

    // Forward analytics validator events
    this.analyticsValidator.on('mrr_validated', (data) => {
      this.emit('mrr_validated', data);
    });

    this.analyticsValidator.on('churn_validated', (data) => {
      this.emit('churn_validated', data);
    });

    this.analyticsValidator.on('validation_error', (data) => {
      this.emit('validation_error', data);
    });
  }

  /**
   * Update statistics
   */
  updateStats(newStats) {
    this.stats = { ...this.stats, ...newStats };
  }

  /**
   * Get comprehensive system status
   */
  async getSystemStatus() {
    try {
      const schedulerStats = this.scheduler?.getStats();
      const workerStats = this.scheduler?.getWorkerStats();
      const validatorStats = this.analyticsValidator.getValidationStats();
      const configStats = await this.configService.getConfigStats();

      return {
        isRunning: this.isRunning,
        uptime: this.isRunning ? Date.now() - this.startTime.getTime() : this.stats.uptime,
        manager: this.stats,
        scheduler: schedulerStats,
        worker: workerStats,
        validator: validatorStats,
        config: configStats,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        isRunning: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Health check for monitoring
   */
  async healthCheck() {
    try {
      const systemStatus = await this.getSystemStatus();
      const recentSummary = await this.getSystemSummary(1); // Last 24 hours

      return {
        healthy: this.isRunning && (systemStatus.scheduler?.status !== 'failed'),
        status: systemStatus,
        recentActivity: recentSummary,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Export reconciliation data
   */
  async exportData(merchantId, startDate, endDate, format = 'json') {
    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          rr.*,
          json_agg(
            json_build_object(
              'discrepancy_type', rd.discrepancy_type,
              'transaction_hash', rd.transaction_hash,
              'amount_difference', rd.amount_difference,
              'healing_status', rd.healing_status,
              'created_at', rd.created_at
            )
          ) as discrepancies
        FROM reconciliation_reports rr
        LEFT JOIN reconciliation_discrepancies rd ON rr.id = rd.reconciliation_report_id
        WHERE rr.merchant_id = $1 
          AND rr.report_date >= $2 
          AND rr.report_date <= $3
        GROUP BY rr.id
        ORDER BY rr.report_date DESC
      `;

      const result = await client.query(query, [merchantId, startDate, endDate]);
      
      if (format === 'csv') {
        return this.convertToCsv(result.rows);
      }

      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Convert data to CSV format
   */
  convertToCsv(data) {
    if (data.length === 0) {
      return '';
    }

    const headers = [
      'merchant_id',
      'report_date',
      'status',
      'total_subscription_billed_events',
      'total_on_chain_amount',
      'total_database_amount',
      'total_discrepancies',
      'auto_healed_count',
      'failed_to_heal_count',
      'completed_at'
    ];

    const csvRows = [headers.join(',')];
    
    for (const row of data) {
      const csvRow = [
        row.merchant_id,
        row.report_date,
        row.status,
        row.total_subscription_billed_events,
        row.total_on_chain_amount,
        row.total_database_amount,
        row.total_discrepancies,
        row.auto_healed_count,
        row.failed_to_heal_count,
        row.completed_at
      ];
      csvRows.push(csvRow.join(','));
    }

    return csvRows.join('\n');
  }

  /**
   * Get configuration service
   */
  getConfigService() {
    return this.configService;
  }

  /**
   * Get analytics validator
   */
  getAnalyticsValidator() {
    return this.analyticsValidator;
  }

  /**
   * Get scheduler
   */
  getScheduler() {
    return this.scheduler;
  }
}

module.exports = ReconciliationManager;
