const cron = require('node-cron');
const { ReconciliationWorker } = require('./reconciliationWorker');

/**
 * Reconciliation Scheduler Service
 * 
 * Manages the scheduled execution of the Reconciliation Worker.
 * Runs every 24 hours at UTC midnight (00:00 UTC).
 */
class ReconciliationScheduler {
  constructor(database, sorobanRpcService, config = {}) {
    this.database = database;
    this.sorobanRpcService = sorobanRpcService;
    this.config = config;
    
    // Scheduler state
    this.isRunning = false;
    this.task = null;
    this.worker = null;
    
    // Configuration
    this.schedule = config.schedule || '0 0 * * *'; // Cron for UTC midnight
    this.timezone = config.timezone || 'UTC';
    this.autoStart = config.autoStart !== false; // Default to true
    
    // Statistics
    this.stats = {
      scheduledRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      averageRunTime: 0,
      lastRunTime: null,
      nextRunTime: null,
      uptime: 0,
      startTime: null
    };
  }

  /**
   * Start the scheduler
   */
  async start() {
    if (this.isRunning) {
      console.warn('Reconciliation scheduler is already running');
      return;
    }

    try {
      // Initialize the reconciliation worker
      this.worker = new ReconciliationWorker(
        this.database,
        this.sorobanRpcService,
        this.config.worker || {}
      );

      // Set up event listeners
      this.setupEventListeners();

      // Start the worker
      await this.worker.start();

      // Schedule the daily task
      this.task = cron.schedule(this.schedule, async () => {
        await this.runScheduledReconciliation();
      }, {
        scheduled: false,
        timezone: this.timezone
      });

      // Start the scheduler
      this.task.start();
      this.isRunning = true;
      this.stats.startTime = new Date();
      this.stats.nextRunTime = this.getNextRunTime();

      console.log(`Reconciliation scheduler started. Next run: ${this.stats.nextRunTime.toISOString()}`);
      
      // Run immediately if configured
      if (this.autoStart) {
        console.log('Running initial reconciliation...');
        await this.runScheduledReconciliation();
      }

    } catch (error) {
      console.error('Failed to start reconciliation scheduler:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the scheduler
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    try {
      // Stop the cron task
      if (this.task) {
        this.task.stop();
        this.task = null;
      }

      // Stop the worker
      if (this.worker) {
        await this.worker.stop();
        this.worker = null;
      }

      this.isRunning = false;
      this.stats.uptime = Date.now() - this.stats.startTime.getTime();

      console.log('Reconciliation scheduler stopped');

    } catch (error) {
      console.error('Error stopping reconciliation scheduler:', error);
      throw error;
    }
  }

  /**
   * Run the scheduled reconciliation
   */
  async runScheduledReconciliation() {
    const runId = this.generateRunId();
    const startTime = new Date();
    
    this.stats.scheduledRuns++;
    this.stats.lastRunTime = startTime;

    console.log(`Starting scheduled reconciliation run ${runId} at ${startTime.toISOString()}`);

    try {
      // Run the daily reconciliation
      const result = await this.worker.runDailyReconciliation(startTime);

      const endTime = new Date();
      const runTime = Math.floor((endTime - startTime) / 1000);

      // Update statistics
      this.stats.completedRuns++;
      this.updateAverageRunTime(runTime);
      this.stats.nextRunTime = this.getNextRunTime();

      console.log(`Scheduled reconciliation run ${runId} completed successfully in ${runTime}s:`, {
        totalMerchantsProcessed: result.totalMerchantsProcessed,
        totalDiscrepanciesFound: result.totalDiscrepanciesFound,
        totalAutoHealed: result.totalAutoHealed
      });

      return result;

    } catch (error) {
      const endTime = new Date();
      const runTime = Math.floor((endTime - startTime) / 1000);

      this.stats.failedRuns++;
      this.updateAverageRunTime(runTime);
      this.stats.nextRunTime = this.getNextRunTime();

      console.error(`Scheduled reconciliation run ${runId} failed after ${runTime}s:`, error);

      // Emit error for monitoring/alerting
      this.emitError(error, {
        runId,
        startTime,
        endTime,
        runTime
      });

      throw error;
    }
  }

  /**
   * Run reconciliation manually (for testing or immediate execution)
   */
  async runManualReconciliation(targetDate = new Date()) {
    if (!this.worker) {
      throw new Error('Reconciliation worker not initialized');
    }

    console.log(`Running manual reconciliation for ${targetDate.toISOString()}`);
    
    try {
      const result = await this.worker.runDailyReconciliation(targetDate);
      
      console.log('Manual reconciliation completed:', {
        totalMerchantsProcessed: result.totalMerchantsProcessed,
        totalDiscrepanciesFound: result.totalDiscrepanciesFound,
        totalAutoHealed: result.totalAutoHealed
      });

      return result;

    } catch (error) {
      console.error('Manual reconciliation failed:', error);
      throw error;
    }
  }

  /**
   * Get next scheduled run time
   */
  getNextRunTime() {
    if (!this.task) {
      return null;
    }

    // Calculate next UTC midnight
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);

    return tomorrow;
  }

  /**
   * Set up event listeners for the worker
   */
  setupEventListeners() {
    if (!this.worker) {
      return;
    }

    // Forward worker events to scheduler
    this.worker.on('reconciliation_started', (data) => {
      console.log('Reconciliation started:', data);
    });

    this.worker.on('reconciliation_completed', (data) => {
      console.log('Reconciliation completed:', data);
    });

    this.worker.on('reconciliation_failed', (data) => {
      console.error('Reconciliation failed:', data);
      this.emitError(new Error(data.error), data);
    });

    this.worker.on('merchant_reconciled', (data) => {
      console.log(`Merchant ${data.merchantId} reconciled:`, {
        totalDiscrepancies: data.report.total_discrepancies,
        autoHealedCount: data.report.auto_healed_count
      });
    });

    this.worker.on('merchant_error', (data) => {
      console.error(`Merchant ${data.merchantId} reconciliation failed:`, data.error);
    });

    this.worker.on('error', (error) => {
      console.error('Reconciliation worker error:', error);
      this.emitError(error);
    });
  }

  /**
   * Emit error for monitoring/alerting
   */
  emitError(error, context = {}) {
    // In a real implementation, this would send alerts to monitoring systems
    console.error('Reconciliation scheduler error:', {
      error: error.message,
      stack: error.stack,
      context,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Update average run time
   */
  updateAverageRunTime(newRunTime) {
    const totalRuns = this.stats.completedRuns + this.stats.failedRuns;
    if (totalRuns === 1) {
      this.stats.averageRunTime = newRunTime;
    } else {
      this.stats.averageRunTime = 
        ((this.stats.averageRunTime * (totalRuns - 1)) + newRunTime) / totalRuns;
    }
  }

  /**
   * Generate run ID
   */
  generateRunId() {
    return `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get scheduler statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      schedule: this.schedule,
      timezone: this.timezone,
      nextRunTime: this.stats.nextRunTime?.toISOString(),
      uptime: this.isRunning && this.stats.startTime ? 
        Date.now() - this.stats.startTime.getTime() : this.stats.uptime
    };
  }

  /**
   * Get worker statistics
   */
  getWorkerStats() {
    return this.worker ? this.worker.getStats() : null;
  }

  /**
   * Health check
   */
  async getHealthStatus() {
    try {
      const schedulerStats = this.getStats();
      const workerStats = this.getWorkerStats();

      return {
        healthy: this.isRunning && !!this.worker,
        scheduler: schedulerStats,
        worker: workerStats,
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
   * Update scheduler configuration
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    
    if (this.worker) {
      // Update worker configuration
      this.worker.config = { ...this.worker.config, ...(newConfig.worker || {}) };
    }

    console.log('Scheduler configuration updated:', newConfig);
  }

  /**
   * Get execution history
   */
  async getExecutionHistory(limit = 30) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          execution_date,
          started_at,
          completed_at,
          status,
          total_merchants_processed,
          total_reports_generated,
          total_discrepancies_found,
          total_auto_healed,
          processing_time_seconds,
          error_message
        FROM reconciliation_worker_history
        ORDER BY execution_date DESC
        LIMIT $1
      `;

      const result = await client.query(query, [limit]);
      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Get merchant reconciliation status
   */
  async getMerchantStatus(merchantId, days = 30) {
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
          completed_at
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
}

module.exports = ReconciliationScheduler;
