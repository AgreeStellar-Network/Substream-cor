const { EventEmitter } = require('events');
const { createObjectCsvWriter } = require('csv-writer');
const fs = require('fs').promises;
const path = require('path');
const { format, startOfDay, endOfDay, subDays } = require('date-fns');

/**
 * Reconciliation Worker Service
 * 
 * Performs daily reconciliation between SubscriptionBilled events on-chain and database records.
 * Identifies discrepancy gaps and attempts auto-healing sync for missing transactions.
 * Generates daily reports for B2B trust and accounting validation.
 */
class ReconciliationWorker extends EventEmitter {
  constructor(database, sorobanRpcService, config = {}) {
    super();
    
    this.database = database;
    this.sorobanRpcService = sorobanRpcService;
    this.config = config;
    
    // Configuration
    this.maxRetries = config.maxRetries || 3;
    this.batchSize = config.batchSize || 100;
    this.reportsDir = config.reportsDir || './reports/reconciliation';
    
    // Worker state
    this.isRunning = false;
    this.currentExecution = null;
    
    // Statistics
    this.stats = {
      totalExecutions: 0,
      totalMerchantsProcessed: 0,
      totalDiscrepanciesFound: 0,
      totalAutoHealed: 0,
      lastExecutionTime: null,
      averageExecutionTime: 0
    };
    
    // Ensure reports directory exists
    this.ensureReportsDirectory();
  }

  /**
   * Start the reconciliation worker
   */
  async start() {
    if (this.isRunning) {
      this.emit('warning', 'Reconciliation worker is already running');
      return;
    }

    this.isRunning = true;
    this.emit('started', { timestamp: new Date().toISOString() });
    
    try {
      // Run initial reconciliation if configured
      if (this.config.runOnStart) {
        await this.runDailyReconciliation();
      }
    } catch (error) {
      this.emit('error', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the reconciliation worker
   */
  async stop() {
    this.isRunning = false;
    this.emit('stopped', { 
      timestamp: new Date().toISOString(),
      finalStats: this.stats
    });
  }

  /**
   * Run daily reconciliation for all merchants
   */
  async runDailyReconciliation(targetDate = new Date()) {
    const executionId = this.generateExecutionId();
    const startTime = new Date();
    
    this.currentExecution = {
      id: executionId,
      date: targetDate,
      startTime,
      status: 'running'
    };

    this.emit('reconciliation_started', {
      executionId,
      date: targetDate,
      startTime: startTime.toISOString()
    });

    try {
      // Create worker history entry
      const historyId = await this.createWorkerHistory(targetDate, startTime);
      
      // Get all enabled merchants
      const merchants = await this.getEnabledMerchants();
      
      let totalMerchantsProcessed = 0;
      let totalReportsGenerated = 0;
      let totalDiscrepanciesFound = 0;
      let totalAutoHealed = 0;

      // Process each merchant
      for (const merchant of merchants) {
        try {
          const report = await this.reconcileMerchant(merchant.merchant_id, targetDate);
          
          if (report) {
            totalReportsGenerated++;
            totalDiscrepanciesFound += report.total_discrepancies;
            totalAutoHealed += report.auto_healed_count;
            
            this.emit('merchant_reconciled', {
              merchantId: merchant.merchant_id,
              report,
              executionId
            });
          }
          
          totalMerchantsProcessed++;
          
        } catch (error) {
          this.emit('merchant_error', {
            merchantId: merchant.merchant_id,
            error: error.message,
            executionId
          });
          
          // Log error but continue with other merchants
          console.error(`Error reconciling merchant ${merchant.merchant_id}:`, error);
        }
      }

      const completionTime = new Date();
      const processingTime = Math.floor((completionTime - startTime) / 1000);

      // Update worker history
      await this.updateWorkerHistory(historyId, {
        status: 'completed',
        completed_at: completionTime,
        total_merchants_processed: totalMerchantsProcessed,
        total_reports_generated: totalReportsGenerated,
        total_discrepancies_found: totalDiscrepanciesFound,
        total_auto_healed: totalAutoHealed,
        processing_time_seconds: processingTime
      });

      // Update statistics
      this.updateStats({
        totalExecutions: this.stats.totalExecutions + 1,
        totalMerchantsProcessed: this.stats.totalMerchantsProcessed + totalMerchantsProcessed,
        totalDiscrepanciesFound: this.stats.totalDiscrepanciesFound + totalDiscrepanciesFound,
        totalAutoHealed: this.stats.totalAutoHealed + totalAutoHealed,
        lastExecutionTime: completionTime,
        averageExecutionTime: this.calculateAverageExecutionTime(processingTime)
      });

      const result = {
        executionId,
        date: targetDate,
        totalMerchantsProcessed,
        totalReportsGenerated,
        totalDiscrepanciesFound,
        totalAutoHealed,
        processingTime,
        completedAt: completionTime.toISOString()
      };

      this.emit('reconciliation_completed', result);
      return result;

    } catch (error) {
      const completionTime = new Date();
      
      // Update worker history with error
      if (this.currentExecution?.historyId) {
        await this.updateWorkerHistory(this.currentExecution.historyId, {
          status: 'failed',
          completed_at: completionTime,
          error_message: error.message,
          error_details: { stack: error.stack }
        });
      }

      this.emit('reconciliation_failed', {
        executionId,
        date: targetDate,
        error: error.message,
        completedAt: completionTime.toISOString()
      });

      throw error;
    } finally {
      this.currentExecution = null;
    }
  }

  /**
   * Reconcile a single merchant
   */
  async reconcileMerchant(merchantId, targetDate) {
    const reportDate = format(targetDate, 'yyyy-MM-dd');
    
    // Check if report already exists for this date
    const existingReport = await this.getExistingReport(merchantId, reportDate);
    if (existingReport && !this.config.forceRerun) {
      return existingReport;
    }

    // Get merchant configuration
    const config = await this.getMerchantConfig(merchantId);
    if (!config || !config.enabled) {
      return null;
    }

    // Create or update report record
    const reportId = await this.createReconciliationReport(merchantId, reportDate);
    
    try {
      // Update status to running
      await this.updateReportStatus(reportId, 'running', new Date());

      // Get on-chain events for the day
      const onChainEvents = await this.getOnChainEvents(merchantId, targetDate);
      
      // Get database records for the day
      const databaseRecords = await this.getDatabaseRecords(merchantId, targetDate);
      
      // Perform reconciliation
      const reconciliationResult = await this.performReconciliation(
        onChainEvents, 
        databaseRecords, 
        config
      );
      
      // Attempt auto-healing if enabled
      let autoHealedCount = 0;
      let failedToHealCount = 0;
      
      if (config.auto_heal_enabled && reconciliationResult.discrepancies.length > 0) {
        const healingResult = await this.attemptAutoHealing(
          reconciliationResult.discrepancies,
          config
        );
        
        autoHealedCount = healingResult.healedCount;
        failedToHealCount = healingResult.failedCount;
        
        // Update reconciliation result with healing outcomes
        reconciliationResult.discrepancies = healingResult.updatedDiscrepancies;
      }

      // Calculate final totals
      const totalOnChainAmount = onChainEvents.reduce(
        (sum, event) => sum + parseFloat(event.amount || 0), 
        0
      );
      
      const totalDatabaseAmount = databaseRecords.reduce(
        (sum, record) => sum + parseFloat(record.amount || 0), 
        0
      );

      // Update report with results
      await this.updateReportResults(reportId, {
        total_subscription_billed_events: onChainEvents.length,
        total_on_chain_amount: totalOnChainAmount,
        total_database_amount: totalDatabaseAmount,
        total_discrepancies: reconciliationResult.discrepancies.length,
        missing_in_database: reconciliationResult.missingInDatabase,
        missing_on_chain: reconciliationResult.missingOnChain,
        amount_mismatches: reconciliationResult.amountMismatches,
        auto_healed_count: autoHealedCount,
        failed_to_heal_count: failedToHealCount,
        status: 'completed',
        completed_at: new Date(),
        report_data: {
          onChainEventsCount: onChainEvents.length,
          databaseRecordsCount: databaseRecords.length,
          discrepancies: reconciliationResult.discrepancies,
          healingAttempted: config.auto_heal_enabled,
          processingTimestamp: new Date().toISOString()
        }
      });

      // Store detailed discrepancies
      if (reconciliationResult.discrepancies.length > 0) {
        await this.storeDiscrepancies(reportId, reconciliationResult.discrepancies);
      }

      // Generate reports (JSON and CSV)
      await this.generateReports(merchantId, reportDate, reconciliationResult);

      // Get final report
      const finalReport = await this.getReconciliationReport(reportId);
      
      // Send notifications if configured
      if (config.notify_on_discrepancy && reconciliationResult.discrepancies.length > 0) {
        await this.sendDiscrepancyNotification(merchantId, finalReport, config);
      }

      return finalReport;

    } catch (error) {
      // Update report with error
      await this.updateReportStatus(reportId, 'failed', new Date(), error.message);
      throw error;
    }
  }

  /**
   * Perform reconciliation between on-chain events and database records
   */
  async performReconciliation(onChainEvents, databaseRecords, config) {
    const discrepancies = [];
    let missingInDatabase = 0;
    let missingOnChain = 0;
    let amountMismatches = 0;

    // Create lookup maps for efficient comparison
    const onChainMap = new Map();
    onChainEvents.forEach(event => {
      const key = `${event.transaction_hash}_${event.event_index}`;
      onChainMap.set(key, event);
    });

    const databaseMap = new Map();
    databaseRecords.forEach(record => {
      const key = `${record.transaction_hash}_${record.event_index}`;
      databaseMap.set(key, record);
    });

    // Find missing in database (on-chain events not in database)
    for (const [key, onChainEvent] of onChainMap) {
      if (!databaseMap.has(key)) {
        missingInDatabase++;
        discrepancies.push({
          discrepancy_type: 'missing_in_database',
          transaction_hash: onChainEvent.transaction_hash,
          event_index: onChainEvent.event_index,
          subscription_billed_event: onChainEvent,
          database_record: null,
          on_chain_amount: parseFloat(onChainEvent.amount || 0),
          database_amount: 0,
          amount_difference: parseFloat(onChainEvent.amount || 0)
        });
      }
    }

    // Find missing on-chain (database records not on-chain)
    for (const [key, databaseRecord] of databaseMap) {
      if (!onChainMap.has(key)) {
        missingOnChain++;
        discrepancies.push({
          discrepancy_type: 'missing_on_chain',
          transaction_hash: databaseRecord.transaction_hash,
          event_index: databaseRecord.event_index,
          subscription_billed_event: null,
          database_record: databaseRecord,
          on_chain_amount: 0,
          database_amount: parseFloat(databaseRecord.amount || 0),
          amount_difference: -parseFloat(databaseRecord.amount || 0)
        });
      }
    }

    // Find amount mismatches
    for (const [key, onChainEvent] of onChainMap) {
      const databaseRecord = databaseMap.get(key);
      if (databaseRecord) {
        const onChainAmount = parseFloat(onChainEvent.amount || 0);
        const databaseAmount = parseFloat(databaseRecord.amount || 0);
        const difference = Math.abs(onChainAmount - databaseAmount);
        
        // Check if difference exceeds thresholds
        const exceedsAmountThreshold = difference > config.discrepancy_threshold_amount;
        const exceedsPercentageThreshold = onChainAmount > 0 && 
          (difference / onChainAmount) > (config.discrepancy_threshold_percentage / 100);

        if (exceedsAmountThreshold || exceedsPercentageThreshold) {
          amountMismatches++;
          discrepancies.push({
            discrepancy_type: 'amount_mismatch',
            transaction_hash: onChainEvent.transaction_hash,
            event_index: onChainEvent.event_index,
            subscription_billed_event: onChainEvent,
            database_record: databaseRecord,
            on_chain_amount: onChainAmount,
            database_amount: databaseAmount,
            amount_difference: onChainAmount - databaseAmount
          });
        }
      }
    }

    return {
      discrepancies,
      missingInDatabase,
      missingOnChain,
      amountMismatches
    };
  }

  /**
   * Attempt auto-healing for discrepancies
   */
  async attemptAutoHealing(discrepancies, config) {
    let healedCount = 0;
    let failedCount = 0;
    const updatedDiscrepancies = [];

    for (const discrepancy of discrepancies) {
      if (discrepancy.discrepancy_type === 'missing_in_database') {
        try {
          // Attempt to re-poll the Soroban RPC for this specific transaction
          const healResult = await this.healMissingDatabaseRecord(
            discrepancy.transaction_hash,
            discrepancy.event_index,
            config
          );

          if (healResult.success) {
            discrepancy.healing_status = 'healed';
            discrepancy.healed_at = new Date();
            healedCount++;
          } else {
            discrepancy.healing_status = 'failed';
            discrepancy.healing_error = healResult.error;
            failedCount++;
          }

        } catch (error) {
          discrepancy.healing_status = 'failed';
          discrepancy.healing_error = error.message;
          failedCount++;
        }
      } else {
        // Other discrepancy types cannot be auto-healed
        discrepancy.healing_status = 'failed';
        discrepancy.healing_error = 'Auto-healing not supported for this discrepancy type';
        failedCount++;
      }

      updatedDiscrepancies.push(discrepancy);
    }

    return {
      healedCount,
      failedCount,
      updatedDiscrepancies
    };
  }

  /**
   * Heal missing database record by re-polling Soroban RPC
   */
  async healMissingDatabaseRecord(transactionHash, eventIndex, config) {
    try {
      // Get transaction details from Soroban RPC
      const transaction = await this.sorobanRpcService.getTransaction(transactionHash);
      
      if (!transaction || !transaction.result) {
        return {
          success: false,
          error: 'Transaction not found or no result'
        };
      }

      // Parse the specific event
      const events = await this.sorobanRpcService.parseTransactionEvents(transaction);
      const targetEvent = events[eventIndex];

      if (!targetEvent || targetEvent.type !== 'SubscriptionBilled') {
        return {
          success: false,
          error: 'Event not found or not a SubscriptionBilled event'
        };
      }

      // Store the missing event in database
      await this.storeSubscriptionBilledEvent(targetEvent);

      return {
        success: true,
        healedEvent: targetEvent
      };

    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Store a SubscriptionBilled event in the database
   */
  async storeSubscriptionBilledEvent(event) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        INSERT INTO billing_events (
          id, subscription_id, amount, event_type, status, 
          transaction_hash, event_index, creator_id, 
          subscriber_address, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        ) ON CONFLICT (transaction_hash, event_index) DO NOTHING
      `;

      await client.query(query, [
        `billing_${event.transaction_hash}_${event.event_index}`,
        `sub_${event.parsedData.subscriberAddress}_${event.parsedData.creatorAddress}`,
        event.parsedData.amount,
        'SubscriptionBilled',
        'completed',
        event.transaction_hash,
        event.event_index,
        event.parsedData.creatorAddress,
        event.parsedData.subscriberAddress,
        new Date(event.ledgerTimestamp),
        new Date()
      ]);

    } finally {
      client.release();
    }
  }

  /**
   * Get on-chain SubscriptionBilled events for a merchant on a specific date
   */
  async getOnChainEvents(merchantId, targetDate) {
    const startDate = startOfDay(targetDate);
    const endDate = endOfDay(targetDate);

    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          contract_id,
          transaction_hash,
          event_index,
          ledger_sequence,
          event_type,
          event_data,
          ledger_timestamp,
          ingested_at
        FROM soroban_events 
        WHERE contract_id = $1 
          AND event_type = 'SubscriptionBilled'
          AND ledger_timestamp >= $2 
          AND ledger_timestamp <= $3
          AND status = 'processed'
        ORDER BY ledger_sequence, event_index
      `;

      const result = await client.query(query, [merchantId, startDate, endDate]);
      
      return result.rows.map(row => ({
        ...row,
        parsedData: row.event_data,
        amount: row.event_data?.amount || '0'
      }));

    } finally {
      client.release();
    }
  }

  /**
   * Get database billing records for a merchant on a specific date
   */
  async getDatabaseRecords(merchantId, targetDate) {
    const startDate = startOfDay(targetDate);
    const endDate = endOfDay(targetDate);

    const client = await this.database.pool.connect();
    try {
      const query = `
        SELECT 
          id,
          subscription_id,
          amount,
          event_type,
          status,
          transaction_hash,
          event_index,
          creator_id,
          subscriber_address,
          created_at,
          updated_at
        FROM billing_events 
        WHERE creator_id = $1 
          AND event_type = 'SubscriptionBilled'
          AND created_at >= $2 
          AND created_at <= $3
          AND status = 'completed'
        ORDER BY created_at
      `;

      const result = await client.query(query, [merchantId, startDate, endDate]);
      return result.rows;

    } finally {
      client.release();
    }
  }

  /**
   * Generate JSON and CSV reports
   */
  async generateReports(merchantId, reportDate, reconciliationResult) {
    const reportDir = path.join(this.reportsDir, merchantId, reportDate.replace(/-/g, '/'));
    await fs.mkdir(reportDir, { recursive: true });

    // Generate JSON report
    const jsonReport = {
      merchantId,
      reportDate,
      generatedAt: new Date().toISOString(),
      summary: {
        totalDiscrepancies: reconciliationResult.discrepancies.length,
        missingInDatabase: reconciliationResult.missingInDatabase,
        missingOnChain: reconciliationResult.missingOnChain,
        amountMismatches: reconciliationResult.amountMismatches
      },
      discrepancies: reconciliationResult.discrepancies
    };

    const jsonPath = path.join(reportDir, `reconciliation_report_${reportDate}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(jsonReport, null, 2));

    // Generate CSV report
    if (reconciliationResult.discrepancies.length > 0) {
      const csvPath = path.join(reportDir, `reconciliation_report_${reportDate}.csv`);
      const csvWriter = createObjectCsvWriter({
        path: csvPath,
        header: [
          { id: 'discrepancy_type', title: 'Discrepancy Type' },
          { id: 'transaction_hash', title: 'Transaction Hash' },
          { id: 'event_index', title: 'Event Index' },
          { id: 'on_chain_amount', title: 'On-Chain Amount' },
          { id: 'database_amount', title: 'Database Amount' },
          { id: 'amount_difference', title: 'Amount Difference' },
          { id: 'healing_status', title: 'Healing Status' },
          { id: 'created_at', title: 'Created At' }
        ]
      });

      await csvWriter.writeRecords(reconciliationResult.discrepancies);
    }

    return {
      jsonPath,
      csvPath: reconciliationResult.discrepancies.length > 0 ? 
        path.join(reportDir, `reconciliation_report_${reportDate}.csv`) : null
    };
  }

  // Database helper methods
  async getEnabledMerchants() {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        'SELECT DISTINCT merchant_id FROM reconciliation_config WHERE enabled = true'
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async getMerchantConfig(merchantId) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM reconciliation_config WHERE merchant_id = $1',
        [merchantId]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async getExistingReport(merchantId, reportDate) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM reconciliation_reports WHERE merchant_id = $1 AND report_date = $2',
        [merchantId, reportDate]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  async createReconciliationReport(merchantId, reportDate) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(`
        INSERT INTO reconciliation_reports (
          merchant_id, report_date, status, started_at
        ) VALUES ($1, $2, 'pending', $3)
        ON CONFLICT (merchant_id, report_date) 
        DO UPDATE SET status = 'pending', started_at = $3
        RETURNING id
      `, [merchantId, reportDate, new Date()]);
      
      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  async updateReportStatus(reportId, status, timestamp, errorMessage = null) {
    const client = await this.database.pool.connect();
    try {
      const query = `
        UPDATE reconciliation_reports 
        SET status = $1, completed_at = $2, error_message = $3
        WHERE id = $4
      `;
      await client.query(query, [status, timestamp, errorMessage, reportId]);
    } finally {
      client.release();
    }
  }

  async updateReportResults(reportId, results) {
    const client = await this.database.pool.connect();
    try {
      const fields = Object.keys(results);
      const values = Object.values(results);
      const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
      
      const query = `
        UPDATE reconciliation_reports 
        SET ${placeholders}
        WHERE id = $${fields.length + 1}
      `;
      
      await client.query(query, [...values, reportId]);
    } finally {
      client.release();
    }
  }

  async storeDiscrepancies(reportId, discrepancies) {
    const client = await this.database.pool.connect();
    try {
      for (const discrepancy of discrepancies) {
        await client.query(`
          INSERT INTO reconciliation_discrepancies (
            reconciliation_report_id, discrepancy_type, transaction_hash, event_index,
            subscription_billed_event, database_record, on_chain_amount, database_amount,
            amount_difference, healing_status, healing_attempts
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
          reportId,
          discrepancy.discrepancy_type,
          discrepancy.transaction_hash,
          discrepancy.event_index,
          JSON.stringify(discrepancy.subscription_billed_event),
          JSON.stringify(discrepancy.database_record),
          discrepancy.on_chain_amount,
          discrepancy.database_amount,
          discrepancy.amount_difference,
          discrepancy.healing_status || 'pending',
          discrepancy.healing_attempts || 0
        ]);
      }
    } finally {
      client.release();
    }
  }

  async createWorkerHistory(targetDate, startTime) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(`
        INSERT INTO reconciliation_worker_history (
          execution_date, started_at, status
        ) VALUES ($1, $2, 'running')
        ON CONFLICT (execution_date) 
        DO UPDATE SET started_at = $2, status = 'running'
        RETURNING id
      `, [targetDate, startTime]);
      
      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  async updateWorkerHistory(historyId, updates) {
    const client = await this.database.pool.connect();
    try {
      const fields = Object.keys(updates);
      const values = Object.values(updates);
      const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
      
      const query = `
        UPDATE reconciliation_worker_history 
        SET ${placeholders}
        WHERE id = $${fields.length + 1}
      `;
      
      await client.query(query, [...values, historyId]);
    } finally {
      client.release();
    }
  }

  async getReconciliationReport(reportId) {
    const client = await this.database.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM reconciliation_reports WHERE id = $1',
        [reportId]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  // Utility methods
  generateExecutionId() {
    return `recon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async ensureReportsDirectory() {
    try {
      await fs.mkdir(this.reportsDir, { recursive: true });
    } catch (error) {
      console.warn('Failed to create reports directory:', error.message);
    }
  }

  updateStats(newStats) {
    this.stats = { ...this.stats, ...newStats };
  }

  calculateAverageExecutionTime(newTime) {
    if (this.stats.totalExecutions === 0) {
      return newTime;
    }
    return ((this.stats.averageExecutionTime * this.stats.totalExecutions) + newTime) / (this.stats.totalExecutions + 1);
  }

  async sendDiscrepancyNotification(merchantId, report, config) {
    // Implementation would depend on notification service
    console.log(`Discrepancy notification sent for merchant ${merchantId}:`, {
      totalDiscrepancies: report.total_discrepancies,
      reportDate: report.report_date
    });
  }

  /**
   * Get worker statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      currentExecution: this.currentExecution
    };
  }
}

module.exports = ReconciliationWorker;
