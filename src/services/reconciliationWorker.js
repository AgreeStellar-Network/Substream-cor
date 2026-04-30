const { loadConfig } = require('../config');
const { SorobanRpcService } = require('./sorobanRpcService');
const { merchantService } = require('./merchantService');
const { AppDatabase } = require('../db/appDatabase');
const { logger } = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');

/**
 * Reconciliation Worker Service
 * Runs daily at UTC midnight to compare on-chain events with vault balances
 */
class ReconciliationWorker {
  constructor(config = null, dependencies = {}) {
    this.config = config || loadConfig();
    this.logger = dependencies.logger || logger;
    this.database = dependencies.database || new AppDatabase(this.config.database);
    
    // Initialize services
    this.rpcService = new SorobanRpcService(this.config.soroban, this.logger);
    
    // Worker state
    this.isRunning = false;
    this.currentJob = null;
    this.stats = {
      totalReports: 0,
      successfulReports: 0,
      failedReports: 0,
      discrepanciesFound: 0,
      healingAttempts: 0,
      healingSuccesses: 0,
      startTime: null,
      lastRunTime: null
    };
    
    // Default configuration
    this.reconciliationConfig = {
      scheduleTime: '00:00', // UTC midnight
      timezone: 'UTC',
      batchSize: 100,
      maxProcessingTimeMs: 30 * 60 * 1000, // 30 minutes
      discrepancyThresholdPercentage: 0.01, // 0.01%
      criticalDiscrepancyThresholdPercentage: 1.0, // 1%
      autoHealing: {
        enabled: true,
        maxRetries: 3,
        retryDelayMs: 5000,
        strategies: {
          rePollRpc: true,
          reprocessLedger: true,
          syncMissingEvents: true
        },
        thresholds: {
          maxDiscrepancyPercentage: 5.0,
          maxMissingEvents: 10,
          maxHealingTimeMs: 10 * 60 * 1000 // 10 minutes
        }
      },
      generateJsonReport: true,
      generateCsvReport: true,
      reportRetentionDays: 90,
      emailReports: false,
      emailRecipients: [],
      alertOnDiscrepancy: true,
      alertOnHealingFailure: true
    };
  }

  /**
   * Start the reconciliation worker
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn('Reconciliation worker is already running');
      return;
    }

    try {
      this.isRunning = true;
      this.stats.startTime = new Date().toISOString();
      
      this.logger.info('Starting Reconciliation Worker', {
        scheduleTime: this.reconciliationConfig.scheduleTime,
        timezone: this.reconciliationConfig.timezone,
        autoHealingEnabled: this.reconciliationConfig.autoHealing.enabled
      });

      // Start the scheduling loop
      await this.runSchedulingLoop();
    } catch (error) {
      this.logger.error('Failed to start reconciliation worker', { error: error.message });
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the reconciliation worker
   */
  async stop() {
    this.isRunning = false;
    
    if (this.currentJob) {
      this.logger.info('Waiting for current reconciliation job to complete...');
      // Wait for current job to complete (with timeout)
      const timeout = setTimeout(() => {
        this.logger.warn('Force stopping reconciliation job due to timeout');
      }, this.reconciliationConfig.maxProcessingTimeMs);
      
      // In a real implementation, we'd wait for the job to complete
      clearTimeout(timeout);
    }
    
    this.logger.info('Reconciliation worker stopped', {
      finalStats: this.getStats()
    });
  }

  /**
   * Main scheduling loop
   */
  async runSchedulingLoop() {
    while (this.isRunning) {
      try {
        const now = new Date();
        const utcTime = now.toUTCString().split(' ')[4]; // Get HH:MM:SS part
        const currentTime = utcTime.substring(0, 5); // HH:MM
        
        if (currentTime === this.reconciliationConfig.scheduleTime) {
          this.logger.info('Starting daily reconciliation process');
          await this.runDailyReconciliation();
          
          // Wait 60 seconds to avoid running multiple times
          await this.sleep(60000);
        }
        
        // Check every minute
        await this.sleep(60000);
      } catch (error) {
        this.logger.error('Error in scheduling loop', { error: error.message });
        await this.sleep(60000); // Wait before retrying
      }
    }
  }

  /**
   * Run the daily reconciliation process for all merchants
   */
  async runDailyReconciliation() {
    if (this.currentJob) {
      this.logger.warn('Reconciliation job already in progress, skipping');
      return;
    }

    const startTime = Date.now();
    this.currentJob = {
      startTime: new Date(),
      status: 'running'
    };

    try {
      this.logger.info('Starting daily reconciliation for all merchants');
      
      // Get all merchants
      const merchants = await this.getAllMerchants();
      
      for (const merchant of merchants) {
        try {
          await this.reconcileMerchant(merchant.id);
          this.stats.successfulReports++;
        } catch (error) {
          this.logger.error(`Failed to reconcile merchant ${merchant.id}`, { error: error.message });
          this.stats.failedReports++;
        }
      }
      
      this.currentJob.status = 'completed';
      this.currentJob.endTime = new Date();
      this.stats.lastRunTime = new Date().toISOString();
      
      this.logger.info('Daily reconciliation completed', {
        totalMerchants: merchants.length,
        successful: this.stats.successfulReports,
        failed: this.stats.failedReports,
        duration: Date.now() - startTime
      });
    } catch (error) {
      this.currentJob.status = 'failed';
      this.currentJob.error = error.message;
      this.logger.error('Daily reconciliation failed', { error: error.message });
    } finally {
      this.currentJob = null;
    }
  }

  /**
   * Reconcile a single merchant
   */
  async reconcileMerchant(merchantId) {
    const reportDate = new Date();
    reportDate.setHours(0, 0, 0, 0); // Start of day UTC
    
    this.logger.info(`Starting reconciliation for merchant ${merchantId}`, { reportDate });
    
    const startTime = Date.now();
    
    try {
      // Step 1: Get aggregated SubscriptionBilled events for the day
      const dailyEvents = await this.getDailyAggregatedEvents(merchantId, reportDate);
      
      // Step 2: Get current vault balance
      const vaultBalance = await this.getVaultBalance(merchantId);
      
      // Step 3: Compare and detect discrepancies
      const discrepancies = await this.detectDiscrepancies(dailyEvents, vaultBalance);
      
      // Step 4: Create reconciliation report
      const report = await this.createReconciliationReport(
        merchantId,
        reportDate,
        dailyEvents,
        vaultBalance,
        discrepancies
      );
      
      // Step 5: Auto-healing if discrepancies found
      if (discrepancies.length > 0 && this.reconciliationConfig.autoHealing.enabled) {
        await this.attemptAutoHealing(report.id, discrepancies);
      }
      
      // Step 6: Generate report files
      await this.generateReportFiles(report, dailyEvents, vaultBalance, discrepancies);
      
      // Step 7: Update report status
      await this.updateReportStatus(report.id, 'completed', Date.now() - startTime);
      
      this.stats.totalReports++;
      if (discrepancies.length > 0) {
        this.stats.discrepanciesFound += discrepancies.length;
      }
      
      this.logger.info(`Reconciliation completed for merchant ${merchantId}`, {
        reportId: report.id,
        totalEvents: dailyEvents.totalEvents,
        totalAmount: dailyEvents.totalAmount,
        vaultBalance: vaultBalance.totalValueUsd,
        discrepancies: discrepancies.length,
        processingTime: Date.now() - startTime
      });
      
      return report;
    } catch (error) {
      this.logger.error(`Reconciliation failed for merchant ${merchantId}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Get aggregated SubscriptionBilled events for a specific day
   */
  async getDailyAggregatedEvents(merchantId, date) {
    const startDate = new Date(date);
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 1);
    
    this.logger.debug(`Getting aggregated events for merchant ${merchantId}`, { startDate, endDate });
    
    try {
      const query = `
        SELECT 
          COUNT(*) as total_events,
          COALESCE(SUM((event_data->>'amount')::decimal), 0) as total_amount,
          MIN(ledger_sequence) as min_ledger,
          MAX(ledger_sequence) as max_ledger,
          COUNT(CASE WHEN status = 'processed' THEN 1 END) as processed_events,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_events
        FROM soroban_events 
        WHERE event_type = 'SubscriptionBilled'
          AND ledger_timestamp >= $1
          AND ledger_timestamp < $2
          AND contract_id IN (
            SELECT contract_id FROM merchant_contracts WHERE merchant_id = $3
          )
      `;
      
      const result = await this.database.query(query, [startDate, endDate, merchantId]);
      const row = result.rows[0];
      
      return {
        merchantId,
        date,
        totalEvents: parseInt(row.total_events) || 0,
        totalAmount: row.total_amount?.toString() || '0',
        processedEvents: parseInt(row.processed_events) || 0,
        failedEvents: parseInt(row.failed_events) || 0,
        ledgerRange: {
          start: parseInt(row.min_ledger) || 0,
          end: parseInt(row.max_ledger) || 0
        }
      };
    } catch (error) {
      this.logger.error('Failed to get daily aggregated events', { merchantId, date, error: error.message });
      throw error;
    }
  }

  /**
   * Get current vault balance for a merchant
   */
  async getVaultBalance(merchantId) {
    this.logger.debug(`Getting vault balance for merchant ${merchantId}`);
    
    try {
      const balances = await merchantService.getMerchantBalances(merchantId);
      
      let totalValueUsd = '0';
      let totalValueNative = '0';
      const assetBreakdown = [];
      
      for (const balance of balances) {
        const valueUsd = await this.convertToUsd(balance.balance, balance.assetCode);
        const valueNative = balance.balance;
        
        assetBreakdown.push({
          assetCode: balance.assetCode,
          assetIssuer: balance.assetIssuer,
          balance: balance.balance,
          valueUsd: valueUsd,
          priceUsd: await this.getAssetPrice(balance.assetCode)
        });
        
        totalValueUsd = this.addDecimal(totalValueUsd, valueUsd);
        totalValueNative = this.addDecimal(totalValueNative, valueNative);
      }
      
      return {
        merchantId,
        timestamp: new Date(),
        balances: assetBreakdown,
        totalValueUsd,
        totalValueNative,
        vaultAssetCode: assetBreakdown[0]?.assetCode || 'XLM'
      };
    } catch (error) {
      this.logger.error('Failed to get vault balance', { merchantId, error: error.message });
      throw error;
    }
  }

  /**
   * Detect discrepancies between events and vault balance
   */
  async detectDiscrepancies(dailyEvents, vaultBalance) {
    const discrepancies = [];
    
    // Convert amounts to comparable units (USD)
    const expectedRevenue = dailyEvents.totalAmount; // Assuming events are in USD
    const actualBalance = vaultBalance.totalValueUsd;
    
    // Calculate difference
    const difference = this.subtractDecimal(actualBalance, expectedRevenue);
    const differencePercentage = expectedRevenue !== '0' 
      ? (parseFloat(difference) / parseFloat(expectedRevenue)) * 100 
      : 0;
    
    // Check if discrepancy exceeds threshold
    if (Math.abs(differencePercentage) > this.reconciliationConfig.discrepancyThresholdPercentage) {
      const severity = this.getDiscrepancySeverity(Math.abs(differencePercentage));
      
      discrepancies.push({
        type: difference > 0 ? 'extra_balance' : 'missing_event',
        severity,
        description: `Balance difference of ${differencePercentage.toFixed(4)}% detected`,
        expectedAmount: expectedRevenue,
        actualAmount: actualBalance,
        differenceAmount: difference,
        differencePercentage: Math.abs(differencePercentage),
        suggestedAction: this.getSuggestedAction(severity, differencePercentage)
      });
    }
    
    // Check for failed events that might indicate missing data
    if (dailyEvents.failedEvents > 0) {
      discrepancies.push({
        type: 'timing_gap',
        severity: 'medium',
        description: `${dailyEvents.failedEvents} failed events detected`,
        context: {
          failedEvents: dailyEvents.failedEvents,
          totalEvents: dailyEvents.totalEvents
        },
        suggestedAction: 'Review failed events and consider reprocessing'
      });
    }
    
    this.logger.debug(`Discrepancy detection completed`, {
      expectedRevenue,
      actualBalance,
      difference,
      differencePercentage,
      discrepanciesFound: discrepancies.length
    });
    
    return discrepancies;
  }

  /**
   * Create reconciliation report in database
   */
  async createReconciliationReport(merchantId, reportDate, dailyEvents, vaultBalance, discrepancies) {
    this.logger.debug(`Creating reconciliation report for merchant ${merchantId}`);
    
    try {
      const query = `
        INSERT INTO reconciliation_reports (
          merchant_id, report_date, total_subscription_events, total_subscription_amount,
          vault_balance_usd, vault_balance_native, vault_asset_code, reconciliation_status,
          discrepancy_amount, discrepancy_percentage, healing_attempts, healing_status,
          ledger_range_start, ledger_range_end
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
      `;
      
      const discrepancyAmount = discrepancies.reduce((sum, d) => 
        this.addDecimal(sum, d.differenceAmount || '0'), '0'
      );
      
      const discrepancyPercentage = discrepancies.length > 0 
        ? Math.max(...discrepancies.map(d => d.differencePercentage || 0))
        : 0;
      
      const values = [
        merchantId,
        reportDate,
        dailyEvents.totalEvents,
        dailyEvents.totalAmount,
        vaultBalance.totalValueUsd,
        vaultBalance.totalValueNative,
        vaultBalance.vaultAssetCode,
        discrepancies.length > 0 ? 'discrepancy_found' : 'matched',
        discrepancyAmount,
        discrepancyPercentage,
        0,
        'none',
        dailyEvents.ledgerRange.start,
        dailyEvents.ledgerRange.end
      ];
      
      const result = await this.database.query(query, values);
      const reportId = result.rows[0].id;
      
      // Insert discrepancies
      if (discrepancies.length > 0) {
        await this.insertDiscrepancies(reportId, discrepancies);
      }
      
      return {
        id: reportId,
        merchantId,
        reportDate,
        dailyEvents,
        vaultBalance,
        discrepancies,
        status: discrepancies.length > 0 ? 'discrepancy_found' : 'matched'
      };
    } catch (error) {
      this.logger.error('Failed to create reconciliation report', { merchantId, error: error.message });
      throw error;
    }
  }

  /**
   * Insert discrepancies into database
   */
  async insertDiscrepancies(reportId, discrepancies) {
    const query = `
      INSERT INTO reconciliation_discrepancies (
        report_id, discrepancy_type, discrepancy_type, expected_amount,
        actual_amount, difference_amount, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    
    for (const discrepancy of discrepancies) {
      try {
        await this.database.query(query, [
          reportId,
          discrepancy.type,
          discrepancy.severity,
          discrepancy.expectedAmount,
          discrepancy.actualAmount,
          discrepancy.differenceAmount,
          discrepancy.description
        ]);
      } catch (error) {
        this.logger.error('Failed to insert discrepancy', { reportId, discrepancy, error: error.message });
      }
    }
  }

  /**
   * Attempt auto-healing for discrepancies
   */
  async attemptAutoHealing(reportId, discrepancies) {
    this.logger.info(`Starting auto-healing for report ${reportId}`, { 
      discrepancies: discrepancies.length 
    });
    
    await this.updateReportStatus(reportId, 'healing');
    
    for (const discrepancy of discrepancies) {
      try {
        if (discrepancy.type === 'missing_event' && this.reconciliationConfig.autoHealing.strategies.rePollRpc) {
          await this.healMissingEvents(reportId, discrepancy);
        } else if (discrepancy.type === 'timing_gap' && this.reconciliationConfig.autoHealing.strategies.reprocessLedger) {
          await this.healTimingGaps(reportId, discrepancy);
        }
      } catch (error) {
        this.logger.error('Auto-healing attempt failed', { 
          reportId, 
          discrepancy, 
          error: error.message 
        });
      }
    }
    
    this.stats.healingAttempts++;
  }

  /**
   * Heal missing events by re-polling RPC
   */
  async healMissingEvents(reportId, discrepancy) {
    const healingAttempt = await this.createHealingAttempt(
      reportId, 
      're_poll_rpc', 
      discrepancy
    );
    
    try {
      this.logger.debug(`Re-polling RPC for missing events`, { reportId });
      
      // Get the ledger range to re-poll
      const ledgerRange = discrepancy.context?.ledgerRange;
      if (!ledgerRange) {
        throw new Error('No ledger range available for re-polling');
      }
      
      // Re-poll events from the RPC
      const events = await this.rpcService.getEvents(
        ledgerRange.start,
        ledgerRange.end,
        ['SubscriptionBilled']
      );
      
      // Process and store any missing events
      let eventsSynced = 0;
      for (const event of events) {
        try {
          await this.processMissingEvent(event);
          eventsSynced++;
        } catch (error) {
          this.logger.error('Failed to process missing event', { event, error: error.message });
        }
      }
      
      await this.updateHealingAttempt(healingAttempt.id, 'completed', {
        eventsFound: events.length,
        eventsSynced,
        rpcResponse: events
      });
      
      this.stats.healingSuccesses++;
      
      this.logger.info(`Auto-healing completed`, {
        reportId,
        healingAttemptId: healingAttempt.id,
        eventsFound: events.length,
        eventsSynced
      });
    } catch (error) {
      await this.updateHealingAttempt(healingAttempt.id, 'failed', {
        errorMessage: error.message
      });
      throw error;
    }
  }

  /**
   * Generate JSON and CSV report files
   */
  async generateReportFiles(report, dailyEvents, vaultBalance, discrepancies) {
    const reportsDir = path.join(process.cwd(), 'reports', 'reconciliation');
    await fs.mkdir(reportsDir, { recursive: true });
    
    const dateStr = report.reportDate.toISOString().split('T')[0];
    const baseFileName = `${report.merchantId}_${dateStr}`;
    
    // Generate JSON report
    if (this.reconciliationConfig.generateJsonReport) {
      const jsonReport = {
        summary: {
          merchantId: report.merchantId,
          reportDate: report.reportDate,
          status: report.status,
          expectedRevenue: dailyEvents.totalAmount,
          actualBalance: vaultBalance.totalValueUsd,
          totalEvents: dailyEvents.totalEvents,
          discrepancies: discrepancies.length,
          processingTime: report.processingTimeMs
        },
        dailyEvents,
        vaultBalance,
        discrepancies,
        generatedAt: new Date().toISOString()
      };
      
      const jsonPath = path.join(reportsDir, `${baseFileName}.json`);
      await fs.writeFile(jsonPath, JSON.stringify(jsonReport, null, 2));
      
      await this.database.query(
        'UPDATE reconciliation_reports SET report_json_path = $1 WHERE id = $2',
        [jsonPath, report.id]
      );
    }
    
    // Generate CSV report
    if (this.reconciliationConfig.generateCsvReport) {
      const csvPath = path.join(reportsDir, `${baseFileName}.csv`);
      await this.generateCsvReport(csvPath, report, dailyEvents, vaultBalance, discrepancies);
      
      await this.database.query(
        'UPDATE reconciliation_reports SET report_csv_path = $1 WHERE id = $2',
        [csvPath, report.id]
      );
    }
  }

  /**
   * Generate CSV report
   */
  async generateCsvReport(filePath, report, dailyEvents, vaultBalance, discrepancies) {
    const csvWriter = createObjectCsvWriter({
      path: filePath,
      header: [
        { id: 'merchantId', title: 'Merchant ID' },
        { id: 'reportDate', title: 'Report Date' },
        { id: 'status', title: 'Status' },
        { id: 'totalEvents', title: 'Total Events' },
        { id: 'expectedRevenue', title: 'Expected Revenue (USD)' },
        { id: 'actualBalance', title: 'Actual Balance (USD)' },
        { id: 'discrepancyAmount', title: 'Discrepancy Amount (USD)' },
        { id: 'discrepancyPercentage', title: 'Discrepancy %' },
        { id: 'discrepancies', title: 'Number of Discrepancies' },
        { id: 'generatedAt', title: 'Generated At' }
      ]
    });
    
    const discrepancyAmount = discrepancies.reduce((sum, d) => 
      this.addDecimal(sum, d.differenceAmount || '0'), '0'
    );
    
    const discrepancyPercentage = discrepancies.length > 0 
      ? Math.max(...discrepancies.map(d => d.differencePercentage || 0))
      : 0;
    
    await csvWriter.writeRecords([{
      merchantId: report.merchantId,
      reportDate: report.reportDate.toISOString().split('T')[0],
      status: report.status,
      totalEvents: dailyEvents.totalEvents,
      expectedRevenue: dailyEvents.totalAmount,
      actualBalance: vaultBalance.totalValueUsd,
      discrepancyAmount,
      discrepancyPercentage: discrepancyPercentage.toFixed(4),
      discrepancies: discrepancies.length,
      generatedAt: new Date().toISOString()
    }]);
  }

  // Helper methods
  async getAllMerchants() {
    try {
      const result = await this.database.query('SELECT id FROM merchants');
      return result.rows;
    } catch (error) {
      this.logger.error('Failed to get merchants', { error: error.message });
      return [];
    }
  }

  async convertToUsd(amount, assetCode) {
    // Simplified conversion - in real implementation, would use price oracle
    if (assetCode === 'USDC' || assetCode === 'USD') {
      return amount;
    }
    // For other assets, would fetch current price
    return amount; // Placeholder
  }

  async getAssetPrice(assetCode) {
    // Simplified price fetching - in real implementation, would use price oracle
    if (assetCode === 'USDC' || assetCode === 'USD') {
      return '1.00';
    }
    return '0.10'; // Placeholder
  }

  getDiscrepancySeverity(percentage) {
    if (percentage >= this.reconciliationConfig.criticalDiscrepancyThresholdPercentage) {
      return 'critical';
    } else if (percentage >= 0.1) {
      return 'high';
    } else if (percentage >= 0.05) {
      return 'medium';
    }
    return 'low';
  }

  getSuggestedAction(severity, percentage) {
    switch (severity) {
      case 'critical':
        return 'IMMEDIATE ATTENTION REQUIRED: Manual review and investigation needed';
      case 'high':
        return 'Auto-healing attempted, manual review recommended';
      case 'medium':
        return 'Monitor closely, consider manual review if persists';
      default:
        return 'Monitor for patterns';
    }
  }

  addDecimal(a, b) {
    return (parseFloat(a) + parseFloat(b)).toString();
  }

  subtractDecimal(a, b) {
    return (parseFloat(a) - parseFloat(b)).toString();
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return { ...this.stats };
  }

  async createHealingAttempt(reportId, strategy, discrepancy) {
    const query = `
      INSERT INTO reconciliation_healing_attempts (
        report_id, healing_strategy, status, max_retries
      ) VALUES ($1, $2, 'pending', $3)
      RETURNING id
    `;
    
    const result = await this.database.query(query, [
      reportId, 
      strategy, 
      this.reconciliationConfig.autoHealing.maxRetries
    ]);
    
    return { id: result.rows[0].id };
  }

  async updateHealingAttempt(attemptId, status, data = {}) {
    const query = `
      UPDATE reconciliation_healing_attempts 
      SET status = $1, completed_at = NOW(), 
          events_found = COALESCE($2, events_found),
          events_synced = COALESCE($3, events_synced),
          error_message = COALESCE($4, error_message),
          rpc_response = COALESCE($5, rpc_response)
      WHERE id = $6
    `;
    
    await this.database.query(query, [
      status,
      data.eventsFound,
      data.eventsSynced,
      data.errorMessage,
      data.rpcResponse ? JSON.stringify(data.rpcResponse) : null,
      attemptId
    ]);
  }

  async updateReportStatus(reportId, status, processingTimeMs = null) {
    const query = `
      UPDATE reconciliation_reports 
      SET reconciliation_status = $1, 
          completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN NOW() ELSE completed_at END,
          processing_time_ms = COALESCE($2, processing_time_ms),
          updated_at = NOW()
      WHERE id = $3
    `;
    
    await this.database.query(query, [status, processingTimeMs, reportId]);
  }

  async processMissingEvent(event) {
    // Process and store missing event
    // This would integrate with the existing event processing pipeline
    this.logger.debug('Processing missing event', { transactionHash: event.transactionHash });
  }

  async healTimingGaps(reportId, discrepancy) {
    // Implementation for healing timing gaps
    this.logger.debug('Healing timing gaps', { reportId, discrepancy });
  }
}

module.exports = { ReconciliationWorker };
