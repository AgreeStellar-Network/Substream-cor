const { EnhancedChurnRiskService } = require('./enhancedChurnRiskService');
const db = require('../database/connection');

/**
 * Enhanced Churn Risk Background Worker
 * 
 * This worker runs daily to update risk scores for all merchants' subscribers.
 * Optimized for processing thousands of users without database bottlenecks.
 */
class EnhancedChurnRiskWorker {
  constructor(options = {}) {
    this.options = {
      // Worker timing
      runInterval: options.runInterval || 24 * 60 * 60 * 1000, // 24 hours
      initialDelay: options.initialDelay || 5 * 60 * 1000, // 5 minutes
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 30 * 1000, // 30 seconds
      
      // Performance optimization
      merchantBatchSize: options.merchantBatchSize || 10,
      subscriberBatchSize: options.subscriberBatchSize || 1000,
      maxConcurrentMerchants: options.maxConcurrentMerchants || 5,
      processingTimeout: options.processingTimeout || 30 * 60 * 1000, // 30 minutes
      
      // Logging and monitoring
      enableDetailedLogging: options.enableDetailedLogging || false,
      metricsRetentionDays: options.metricsRetentionDays || 30,
      
      ...options
    };
    
    this.churnRiskService = new EnhancedChurnRiskService({
      batchSize: this.options.subscriberBatchSize,
      maxConcurrentQueries: this.options.maxConcurrentMerchants
    });
    
    this.isRunning = false;
    this.timer = null;
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      lastRunTime: null,
      lastRunDuration: 0,
      totalMerchantsProcessed: 0,
      totalSubscribersProcessed: 0,
      averageProcessingTime: 0
    };
  }

  /**
   * Start the background worker
   */
  async start() {
    if (this.isRunning) {
      console.log('EnhancedChurnRiskWorker is already running');
      return;
    }
    
    console.log('Starting EnhancedChurnRiskWorker...');
    this.isRunning = true;
    
    // Schedule initial run
    setTimeout(() => {
      this.runDailyAnalysis();
    }, this.options.initialDelay);
    
    // Schedule recurring runs
    this.timer = setInterval(() => {
      this.runDailyAnalysis();
    }, this.options.runInterval);
    
    console.log(`EnhancedChurnRiskWorker started. Running every ${this.options.runInterval / (60 * 60 * 1000)} hours`);
  }

  /**
   * Stop the background worker
   */
  async stop() {
    if (!this.isRunning) {
      console.log('EnhancedChurnRiskWorker is not running');
      return;
    }
    
    console.log('Stopping EnhancedChurnRiskWorker...');
    this.isRunning = false;
    
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    
    console.log('EnhancedChurnRiskWorker stopped');
  }

  /**
   * Run the daily churn risk analysis
   */
  async runDailyAnalysis() {
    if (!this.isRunning) return;
    
    const runStartTime = Date.now();
    this.stats.totalRuns++;
    
    console.log(`Starting daily churn risk analysis (Run #${this.stats.totalRuns})...`);
    
    try {
      // Get all active merchants
      const merchants = await this.getActiveMerchants();
      console.log(`Found ${merchants.length} active merchants to process`);
      
      // Process merchants in batches
      const results = await this.processMerchantsInBatches(merchants);
      
      // Update statistics
      const runDuration = Date.now() - runStartTime;
      this.updateRunStats(results, runDuration);
      
      // Clean up old metrics
      await this.cleanupOldMetrics();
      
      console.log(`Daily churn risk analysis completed successfully:`, {
        duration: `${runDuration}ms`,
        merchantsProcessed: results.merchantsProcessed,
        subscribersProcessed: results.subscribersProcessed,
        highRiskIdentified: results.highRiskCount,
        errors: results.errors.length
      });
      
    } catch (error) {
      console.error('Error in daily churn risk analysis:', error);
      this.stats.failedRuns++;
      
      // Retry logic
      if (this.options.retryAttempts > 0) {
        console.log(`Retrying analysis in ${this.options.retryDelay / 1000} seconds...`);
        setTimeout(() => {
          this.runDailyAnalysisWithRetry();
        }, this.options.retryDelay);
      }
    }
  }

  /**
   * Run analysis with retry logic
   */
  async runDailyAnalysisWithRetry(attempt = 1) {
    try {
      await this.runDailyAnalysis();
    } catch (error) {
      if (attempt < this.options.retryAttempts) {
        console.log(`Retry attempt ${attempt} failed. Retrying in ${this.options.retryDelay / 1000} seconds...`);
        setTimeout(() => {
          this.runDailyAnalysisWithRetry(attempt + 1);
        }, this.options.retryDelay);
      } else {
        console.error(`All ${this.options.retryAttempts} retry attempts failed. Skipping this run.`);
      }
    }
  }

  /**
   * Get all active merchants
   */
  async getActiveMerchants() {
    const query = `
      SELECT DISTINCT 
        m.id as merchant_id,
        m.name as merchant_name,
        COUNT(s.wallet_address) as subscriber_count
      FROM merchants m
      LEFT JOIN subscriptions s ON m.id = s.creator_id AND s.active = 1
      WHERE m.created_at >= CURRENT_DATE - INTERVAL '90 days'
        OR EXISTS (
          SELECT 1 FROM subscriptions s2 
          WHERE s2.creator_id = m.id AND s2.active = 1
        )
      GROUP BY m.id, m.name
      HAVING COUNT(s.wallet_address) > 0
      ORDER BY subscriber_count DESC
    `;
    
    const result = await db.query(query);
    return result.rows;
  }

  /**
   * Process merchants in batches to avoid database bottlenecks
   */
  async processMerchantsInBatches(merchants) {
    const results = {
      merchantsProcessed: 0,
      subscribersProcessed: 0,
      highRiskCount: 0,
      errors: []
    };
    
    // Create batches of merchants
    const merchantBatches = this.createBatches(merchants, this.options.merchantBatchSize);
    
    for (const batch of merchantBatches) {
      const batchPromises = batch.map(merchant => 
        this.processMerchantWithTimeout(merchant)
      );
      
      try {
        const batchResults = await Promise.allSettled(batchPromises);
        
        batchResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            results.merchantsProcessed++;
            results.subscribersProcessed += result.value.subscribersProcessed;
            results.highRiskCount += result.value.highRiskCount;
          } else {
            results.errors.push({
              merchantId: batch[index].merchant_id,
              error: result.reason.message
            });
          }
        });
        
        // Add delay between batches to prevent database overload
        if (merchantBatches.indexOf(batch) < merchantBatches.length - 1) {
          await this.sleep(1000); // 1 second delay
        }
        
      } catch (error) {
        console.error('Error processing merchant batch:', error);
        results.errors.push({ error: error.message });
      }
    }
    
    return results;
  }

  /**
   * Process a single merchant with timeout
   */
  async processMerchantWithTimeout(merchant) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Processing timeout for merchant ${merchant.merchant_id}`));
      }, this.options.processingTimeout);
      
      this.processMerchant(merchant)
        .then(result => {
          clearTimeout(timeout);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  /**
   * Process a single merchant
   */
  async processMerchant(merchant) {
    const startTime = Date.now();
    
    try {
      if (this.options.enableDetailedLogging) {
        console.log(`Processing merchant ${merchant.merchant_id} (${merchant.subscriber_count} subscribers)...`);
      }
      
      // Run the churn risk analysis
      const analysis = await this.churnRiskService.analyzeMerchantChurnRisk(merchant.merchant_id);
      
      const processingTime = Date.now() - startTime;
      
      if (this.options.enableDetailedLogging) {
        console.log(`Completed merchant ${merchant.merchant_id}:`, {
          subscribers: analysis.totalSubscribers,
          highRisk: analysis.highRiskCount,
          processingTime: `${processingTime}ms`
        });
      }
      
      // Store processing metrics
      await this.storeProcessingMetrics({
        merchantId: merchant.merchant_id,
        subscriberCount: analysis.totalSubscribers,
        highRiskCount: analysis.highRiskCount,
        processingTime,
        success: true
      });
      
      return {
        subscribersProcessed: analysis.totalSubscribers,
        highRiskCount: analysis.highRiskCount,
        processingTime
      };
      
    } catch (error) {
      const processingTime = Date.now() - startTime;
      
      // Store error metrics
      await this.storeProcessingMetrics({
        merchantId: merchant.merchant_id,
        subscriberCount: merchant.subscriber_count,
        highRiskCount: 0,
        processingTime,
        success: false,
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * Store processing metrics for monitoring
   */
  async storeProcessingMetrics(metrics) {
    const query = `
      INSERT INTO churn_risk_worker_metrics (
        merchant_id, subscriber_count, high_risk_count, 
        processing_time_ms, success, error_message, processed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    
    const values = [
      metrics.merchantId,
      metrics.subscriberCount,
      metrics.highRiskCount,
      metrics.processingTime,
      metrics.success,
      metrics.error || null,
      new Date()
    ];
    
    try {
      await db.query(query, values);
    } catch (error) {
      console.error('Failed to store processing metrics:', error);
    }
  }

  /**
   * Clean up old metrics to prevent table bloat
   */
  async cleanupOldMetrics() {
    const query = `
      DELETE FROM churn_risk_worker_metrics 
      WHERE processed_at < CURRENT_DATE - INTERVAL '${this.options.metricsRetentionDays} days'
    `;
    
    try {
      const result = await db.query(query);
      if (result.rowCount > 0) {
        console.log(`Cleaned up ${result.rowCount} old metric records`);
      }
    } catch (error) {
      console.error('Failed to cleanup old metrics:', error);
    }
  }

  /**
   * Update worker statistics
   */
  updateRunStats(results, runDuration) {
    this.stats.successfulRuns++;
    this.stats.lastRunTime = new Date();
    this.stats.lastRunDuration = runDuration;
    this.stats.totalMerchantsProcessed += results.merchantsProcessed;
    this.stats.totalSubscribersProcessed += results.subscribersProcessed;
    
    // Calculate average processing time
    const totalRuns = this.stats.successfulRuns;
    this.stats.averageProcessingTime = 
      ((this.stats.averageProcessingTime * (totalRuns - 1)) + runDuration) / totalRuns;
  }

  /**
   * Get worker statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      nextRunTime: this.timer ? new Date(Date.now() + this.options.runInterval) : null,
      configuration: {
        runInterval: this.options.runInterval,
        merchantBatchSize: this.options.merchantBatchSize,
        subscriberBatchSize: this.options.subscriberBatchSize,
        maxConcurrentMerchants: this.options.maxConcurrentMerchants
      }
    };
  }

  /**
   * Trigger manual analysis for testing
   */
  async triggerManualAnalysis(merchantIds = null) {
    console.log('Triggering manual churn risk analysis...');
    
    if (merchantIds && merchantIds.length > 0) {
      // Process specific merchants
      const results = [];
      for (const merchantId of merchantIds) {
        try {
          const analysis = await this.churnRiskService.analyzeMerchantChurnRisk(merchantId);
          results.push({ merchantId, success: true, ...analysis });
        } catch (error) {
          results.push({ merchantId, success: false, error: error.message });
        }
      }
      return results;
    } else {
      // Process all merchants
      await this.runDailyAnalysis();
      return this.getStats();
    }
  }

  /**
   * Helper methods
   */
  createBatches(array, batchSize) {
    const batches = [];
    for (let i = 0; i < array.length; i += batchSize) {
      batches.push(array.slice(i, i + batchSize));
    }
    return batches;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { EnhancedChurnRiskWorker };
