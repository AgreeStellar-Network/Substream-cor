const { EventEmitter } = require('events');
const { format, startOfDay, endOfDay, subDays, startOfMonth, endOfMonth } = require('date-fns');

/**
 * Reconciliation Analytics Validator Service
 * 
 * Validates analytical metrics (MRR/Churn) against the raw ledger state every day.
 * Ensures mathematical accuracy of reported metrics by comparing with on-chain data.
 */
class ReconciliationAnalyticsValidator extends EventEmitter {
  constructor(database, sorobanRpcService, config = {}) {
    super();
    
    this.database = database;
    this.sorobanRpcService = sorobanRpcService;
    this.config = config;
    
    // Configuration
    this.tolerancePercentage = config.tolerancePercentage || 0.01; // 0.01% tolerance
    this.minAmountThreshold = config.minAmountThreshold || 0.000001; // 1 stroop
    
    // Validation cache
    this.validationCache = new Map();
    this.cacheTimeout = config.cacheTimeout || 300000; // 5 minutes
  }

  /**
   * Validate MRR metrics against on-chain data for a merchant
   */
  async validateMRR(merchantId, targetDate = new Date()) {
    const cacheKey = `mrr_${merchantId}_${format(targetDate, 'yyyy-MM-dd')}`;
    
    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Get analytical MRR data (from analytics service)
      const analyticalMRR = await this.getAnalyticalMRR(merchantId, targetDate);
      
      // Get on-chain MRR data (from ledger state)
      const onChainMRR = await this.calculateOnChainMRR(merchantId, targetDate);
      
      // Perform validation
      const validationResult = this.validateMRRComparison(
        analyticalMRR, 
        onChainMRR, 
        merchantId, 
        targetDate
      );

      // Cache the result
      this.setCache(cacheKey, validationResult);

      this.emit('mrr_validated', {
        merchantId,
        targetDate,
        result: validationResult
      });

      return validationResult;

    } catch (error) {
      const errorResult = {
        merchantId,
        targetDate,
        metric: 'MRR',
        isValid: false,
        error: error.message,
        analyticalData: null,
        onChainData: null,
        discrepancies: []
      };

      this.emit('validation_error', {
        merchantId,
        metric: 'MRR',
        error: error.message
      });

      return errorResult;
    }
  }

  /**
   * Validate Churn metrics against on-chain data for a merchant
   */
  async validateChurn(merchantId, targetDate = new Date()) {
    const cacheKey = `churn_${merchantId}_${format(targetDate, 'yyyy-MM-dd')}`;
    
    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      // Get analytical churn data
      const analyticalChurn = await this.getAnalyticalChurn(merchantId, targetDate);
      
      // Get on-chain churn data
      const onChainChurn = await this.calculateOnChainChurn(merchantId, targetDate);
      
      // Perform validation
      const validationResult = this.validateChurnComparison(
        analyticalChurn, 
        onChainChurn, 
        merchantId, 
        targetDate
      );

      // Cache the result
      this.setCache(cacheKey, validationResult);

      this.emit('churn_validated', {
        merchantId,
        targetDate,
        result: validationResult
      });

      return validationResult;

    } catch (error) {
      const errorResult = {
        merchantId,
        targetDate,
        metric: 'Churn',
        isValid: false,
        error: error.message,
        analyticalData: null,
        onChainData: null,
        discrepancies: []
      };

      this.emit('validation_error', {
        merchantId,
        metric: 'Churn',
        error: error.message
      });

      return errorResult;
    }
  }

  /**
   * Validate all metrics for a merchant
   */
  async validateAllMetrics(merchantId, targetDate = new Date()) {
    const [mrrValidation, churnValidation] = await Promise.all([
      this.validateMRR(merchantId, targetDate),
      this.validateChurn(merchantId, targetDate)
    ]);

    const overallResult = {
      merchantId,
      targetDate,
      isValid: mrrValidation.isValid && churnValidation.isValid,
      mrr: mrrValidation,
      churn: churnValidation,
      totalDiscrepancies: [
        ...(mrrValidation.discrepancies || []),
        ...(churnValidation.discrepancies || [])
      ],
      validatedAt: new Date().toISOString()
    };

    this.emit('all_metrics_validated', overallResult);

    return overallResult;
  }

  /**
   * Get analytical MRR data from the analytics service
   */
  async getAnalyticalMRR(merchantId, targetDate) {
    const client = await this.database.pool.connect();
    try {
      // Get MRR data from analytics cache or calculations
      const query = `
        SELECT 
          total_mrr,
          active_subscribers,
          mrr_gained_today,
          mrr_lost_to_churn,
          churn_rate,
          average_revenue_per_user,
          currency
        FROM mrr_analytics_cache
        WHERE creator_id = $1 
          AND date = $2
      `;

      const result = await client.query(query, [merchantId, format(targetDate, 'yyyy-MM-dd')]);
      
      if (result.rows.length === 0) {
        // If no cached data, calculate it
        return await this.calculateAnalyticalMRR(merchantId, targetDate);
      }

      return {
        totalMRR: parseFloat(result.rows[0].total_mrr) || 0,
        activeSubscribers: parseInt(result.rows[0].active_subscribers) || 0,
        mrrGainedToday: parseFloat(result.rows[0].mrr_gained_today) || 0,
        mrrLostToChurn: parseFloat(result.rows[0].mrr_lost_to_churn) || 0,
        churnRate: parseFloat(result.rows[0].churn_rate) || 0,
        averageRevenuePerUser: parseFloat(result.rows[0].average_revenue_per_user) || 0,
        currency: result.rows[0].currency || 'XLM'
      };

    } finally {
      client.release();
    }
  }

  /**
   * Calculate analytical MRR if not cached
   */
  async calculateAnalyticalMRR(merchantId, targetDate) {
    const client = await this.database.pool.connect();
    try {
      // Calculate MRR from subscription data
      const query = `
        SELECT 
          COALESCE(SUM(CAST(cs.flow_rate AS DECIMAL)), 0) as total_mrr,
          COUNT(s.wallet_address) as active_subscribers,
          cs.currency,
          COALESCE(AVG(CAST(cs.flow_rate AS DECIMAL)), 0) as avg_revenue_per_user
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 AND s.active = 1
      `;

      const baseResult = await client.query(query, [merchantId]);
      const baseData = baseResult.rows[0] || { 
        total_mrr: 0, active_subscribers: 0, currency: 'XLM', avg_revenue_per_user: 0 
      };

      // Get MRR gained today
      const gainedTodayQuery = `
        SELECT COALESCE(SUM(CAST(flow_rate AS DECIMAL)), 0) as mrr_gained_today
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 
          AND s.active = 1 
          AND DATE(s.subscribed_at) = $2
      `;

      const gainedResult = await client.query(gainedTodayQuery, [merchantId, format(targetDate, 'yyyy-MM-dd')]);

      // Get MRR lost to churn today
      const lostToChurnQuery = `
        SELECT COALESCE(SUM(CAST(cs.flow_rate AS DECIMAL)), 0) as mrr_lost_to_churn
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 
          AND s.active = 0 
          AND DATE(s.unsubscribed_at) = $2
      `;

      const lostResult = await client.query(lostToChurnQuery, [merchantId, format(targetDate, 'yyyy-MM-dd')]);

      // Calculate churn rate (last 30 days)
      const churnRateQuery = `
        SELECT 
          COUNT(*) as total_lost,
          (SELECT COUNT(*) FROM subscriptions WHERE creator_id = $1 AND active = 1) as current_active
        FROM subscriptions 
        WHERE creator_id = $1 
          AND active = 0 
          AND unsubscribed_at >= $2
      `;

      const churnResult = await client.query(churnRateQuery, [
        merchantId, 
        subDays(targetDate, 30)
      ]);

      const churnData = churnResult.rows[0];
      const churnRate = churnData.current_active > 0 
        ? (churnData.total_lost / (churnData.current_active + churnData.total_lost)) * 100 
        : 0;

      return {
        totalMRR: parseFloat(baseData.total_mrr) || 0,
        activeSubscribers: parseInt(baseData.active_subscribers) || 0,
        mrrGainedToday: parseFloat(gainedResult.rows[0].mrr_gained_today) || 0,
        mrrLostToChurn: parseFloat(lostResult.rows[0].mrr_lost_to_churn) || 0,
        churnRate: parseFloat(churnRate) || 0,
        averageRevenuePerUser: parseFloat(baseData.avg_revenue_per_user) || 0,
        currency: baseData.currency || 'XLM'
      };

    } finally {
      client.release();
    }
  }

  /**
   * Calculate on-chain MRR from ledger state
   */
  async calculateOnChainMRR(merchantId, targetDate) {
    const startDate = startOfDay(targetDate);
    const endDate = endOfDay(targetDate);

    const client = await this.database.pool.connect();
    try {
      // Get all SubscriptionBilled events for the day
      const query = `
        SELECT 
          event_data,
          ledger_timestamp
        FROM soroban_events 
        WHERE contract_id = $1 
          AND event_type = 'SubscriptionBilled'
          AND ledger_timestamp >= $2 
          AND ledger_timestamp <= $3
          AND status = 'processed'
      `;

      const result = await client.query(query, [merchantId, startDate, endDate]);
      
      let totalMRR = 0;
      let uniqueSubscribers = new Set();
      let subscriberAmounts = new Map();

      // Process each event
      for (const row of result.rows) {
        const eventData = row.event_data;
        const subscriberAddress = eventData.subscriberAddress;
        const amount = parseFloat(eventData.amount || '0');

        totalMRR += amount;
        uniqueSubscribers.add(subscriberAddress);
        
        // Track amount per subscriber for average calculation
        subscriberAmounts.set(subscriberAddress, amount);
      }

      // Calculate average revenue per user
      const averageRevenuePerUser = uniqueSubscribers.size > 0 
        ? totalMRR / uniqueSubscribers.size 
        : 0;

      return {
        totalMRR,
        activeSubscribers: uniqueSubscribers.size,
        mrrGainedToday: totalMRR, // All billed events today contribute to gained MRR
        mrrLostToChurn: 0, // Cannot determine from on-chain events alone
        churnRate: 0, // Cannot determine from single day's events
        averageRevenuePerUser,
        currency: 'XLM', // Assuming XLM, could be determined from events
        eventCount: result.rows.length
      };

    } finally {
      client.release();
    }
  }

  /**
   * Get analytical churn data
   */
  async getAnalyticalChurn(merchantId, targetDate) {
    const client = await this.database.pool.connect();
    try {
      // Get churn analytics from database
      const query = `
        SELECT 
          COUNT(*) as churned_subscribers,
          COALESCE(SUM(CAST(cs.flow_rate AS DECIMAL)), 0) as churned_mrr,
          AVG(CAST(cs.flow_rate AS DECIMAL)) as avg_churned_mrr
        FROM subscriptions s
        JOIN creator_settings cs ON s.creator_id = cs.creator_id
        WHERE s.creator_id = $1 
          AND s.active = 0 
          AND DATE(s.unsubscribed_at) = $2
      `;

      const result = await client.query(query, [merchantId, format(targetDate, 'yyyy-MM-dd')]);
      const churnData = result.rows[0] || { 
        churned_subscribers: 0, churned_mrr: 0, avg_churned_mrr: 0 
      };

      // Get total active subscribers for churn rate calculation
      const activeQuery = `
        SELECT COUNT(*) as active_subscribers
        FROM subscriptions 
        WHERE creator_id = $1 AND active = 1
      `;

      const activeResult = await client.query(activeQuery, [merchantId]);
      const activeCount = parseInt(activeResult.rows[0]?.active_subscribers || '0');

      return {
        churnedSubscribers: parseInt(churnData.churned_subscribers) || 0,
        churnedMRR: parseFloat(churnData.churned_mrr) || 0,
        averageChurnedMRR: parseFloat(churnData.avg_churned_mrr) || 0,
        activeSubscribers: activeCount,
        churnRate: activeCount > 0 ? (churnData.churned_subscribers / (activeCount + churnData.churned_subscribers)) * 100 : 0
      };

    } finally {
      client.release();
    }
  }

  /**
   * Calculate on-chain churn data
   */
  async calculateOnChainChurn(merchantId, targetDate) {
    // On-chain churn is difficult to determine without explicit cancellation events
    // For this implementation, we'll estimate based on subscription patterns
    
    const startDate = startOfDay(targetDate);
    const endDate = endOfDay(targetDate);
    const previousDate = subDays(targetDate, 1);

    const client = await this.database.pool.connect();
    try {
      // Get subscribers who were billed yesterday but not today (estimate churn)
      const yesterdayQuery = `
        SELECT DISTINCT event_data->>'subscriberAddress' as subscriber
        FROM soroban_events 
        WHERE contract_id = $1 
          AND event_type = 'SubscriptionBilled'
          AND DATE(ledger_timestamp) = $2
          AND status = 'processed'
      `;

      const yesterdayResult = await client.query(yesterdayQuery, [
        merchantId, 
        format(previousDate, 'yyyy-MM-dd')
      ]);

      const todayQuery = `
        SELECT DISTINCT event_data->>'subscriberAddress' as subscriber
        FROM soroban_events 
        WHERE contract_id = $1 
          AND event_type = 'SubscriptionBilled'
          AND DATE(ledger_timestamp) = $2
          AND status = 'processed'
      `;

      const todayResult = await client.query(todayQuery, [
        merchantId, 
        format(targetDate, 'yyyy-MM-dd')
      ]);

      const yesterdaySubscribers = new Set(yesterdayResult.rows.map(row => row.subscriber));
      const todaySubscribers = new Set(todayResult.rows.map(row => row.subscriber));

      // Estimate churned subscribers (billed yesterday but not today)
      const churnedSubscribers = [...yesterdaySubscribers].filter(sub => !todaySubscribers.has(sub));
      
      // Get current active subscribers
      const activeSubscribers = todaySubscribers.size;

      // Calculate churn rate
      const totalSubscribers = yesterdaySubscribers.size;
      const churnRate = totalSubscribers > 0 ? (churnedSubscribers.length / totalSubscribers) * 100 : 0;

      return {
        churnedSubscribers: churnedSubscribers.length,
        churnedMRR: 0, // Would need additional data to calculate
        averageChurnedMRR: 0, // Would need additional data to calculate
        activeSubscribers,
        churnRate,
        estimated: true, // Flag that this is an estimate
        yesterdaySubscribers: yesterdaySubscribers.size,
        todaySubscribers: todaySubscribers.size
      };

    } finally {
      client.release();
    }
  }

  /**
   * Validate MRR comparison between analytical and on-chain data
   */
  validateMRRComparison(analyticalMRR, onChainMRR, merchantId, targetDate) {
    const discrepancies = [];
    let isValid = true;

    // Validate total MRR
    const mrrDifference = Math.abs(analyticalMRR.totalMRR - onChainMRR.totalMRR);
    const mrrPercentageDiff = analyticalMRR.totalMRR > 0 
      ? (mrrDifference / analyticalMRR.totalMRR) * 100 
      : 0;

    if (mrrDifference > this.minAmountThreshold && mrrPercentageDiff > this.tolerancePercentage) {
      isValid = false;
      discrepancies.push({
        metric: 'totalMRR',
        analyticalValue: analyticalMRR.totalMRR,
        onChainValue: onChainMRR.totalMRR,
        difference: mrrDifference,
        percentageDifference: mrrPercentageDiff,
        threshold: this.tolerancePercentage,
        exceedsThreshold: true
      });
    }

    // Validate active subscribers
    const subscriberDifference = Math.abs(analyticalMRR.activeSubscribers - onChainMRR.activeSubscribers);
    const subscriberPercentageDiff = analyticalMRR.activeSubscribers > 0 
      ? (subscriberDifference / analyticalMRR.activeSubscribers) * 100 
      : 0;

    if (subscriberDifference > 0 && subscriberPercentageDiff > this.tolerancePercentage) {
      isValid = false;
      discrepancies.push({
        metric: 'activeSubscribers',
        analyticalValue: analyticalMRR.activeSubscribers,
        onChainValue: onChainMRR.activeSubscribers,
        difference: subscriberDifference,
        percentageDifference: subscriberPercentageDiff,
        threshold: this.tolerancePercentage,
        exceedsThreshold: true
      });
    }

    // Validate average revenue per user
    const arpuDifference = Math.abs(analyticalMRR.averageRevenuePerUser - onChainMRR.averageRevenuePerUser);
    const arpuPercentageDiff = analyticalMRR.averageRevenuePerUser > 0 
      ? (arpuDifference / analyticalMRR.averageRevenuePerUser) * 100 
      : 0;

    if (arpuDifference > this.minAmountThreshold && arpuPercentageDiff > this.tolerancePercentage) {
      isValid = false;
      discrepancies.push({
        metric: 'averageRevenuePerUser',
        analyticalValue: analyticalMRR.averageRevenuePerUser,
        onChainValue: onChainMRR.averageRevenuePerUser,
        difference: arpuDifference,
        percentageDifference: arpuPercentageDiff,
        threshold: this.tolerancePercentage,
        exceedsThreshold: true
      });
    }

    return {
      merchantId,
      targetDate,
      metric: 'MRR',
      isValid,
      analyticalData: analyticalMRR,
      onChainData: onChainMRR,
      discrepancies,
      validatedAt: new Date().toISOString()
    };
  }

  /**
   * Validate churn comparison between analytical and on-chain data
   */
  validateChurnComparison(analyticalChurn, onChainChurn, merchantId, targetDate) {
    const discrepancies = [];
    let isValid = true;

    // Validate churned subscribers
    const churnedDifference = Math.abs(analyticalChurn.churnedSubscribers - onChainChurn.churnedSubscribers);
    const churnedPercentageDiff = analyticalChurn.churnedSubscribers > 0 
      ? (churnedDifference / analyticalChurn.churnedSubscribers) * 100 
      : 0;

    // Allow higher tolerance for churn due to estimation challenges
    const churnTolerance = onChainChurn.estimated ? this.tolerancePercentage * 10 : this.tolerancePercentage;

    if (churnedDifference > 0 && churnedPercentageDiff > churnTolerance) {
      isValid = false;
      discrepancies.push({
        metric: 'churnedSubscribers',
        analyticalValue: analyticalChurn.churnedSubscribers,
        onChainValue: onChainChurn.churnedSubscribers,
        difference: churnedDifference,
        percentageDifference: churnedPercentageDiff,
        threshold: churnTolerance,
        exceedsThreshold: true,
        note: onChainChurn.estimated ? 'On-chain value is estimated' : null
      });
    }

    // Validate churn rate
    const churnRateDifference = Math.abs(analyticalChurn.churnRate - onChainChurn.churnRate);
    
    if (churnRateDifference > churnTolerance) {
      isValid = false;
      discrepancies.push({
        metric: 'churnRate',
        analyticalValue: analyticalChurn.churnRate,
        onChainValue: onChainChurn.churnRate,
        difference: churnRateDifference,
        percentageDifference: churnRateDifference,
        threshold: churnTolerance,
        exceedsThreshold: true,
        note: onChainChurn.estimated ? 'On-chain value is estimated' : null
      });
    }

    return {
      merchantId,
      targetDate,
      metric: 'Churn',
      isValid,
      analyticalData: analyticalChurn,
      onChainData: onChainChurn,
      discrepancies,
      validatedAt: new Date().toISOString()
    };
  }

  /**
   * Get cached validation result
   */
  getFromCache(key) {
    const cached = this.validationCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }
    return null;
  }

  /**
   * Set cache entry
   */
  setCache(key, data) {
    this.validationCache.set(key, {
      data,
      timestamp: Date.now()
    });

    // Clean up old cache entries periodically
    if (this.validationCache.size > 1000) {
      this.cleanupCache();
    }
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.validationCache.entries()) {
      if (now - value.timestamp > this.cacheTimeout) {
        this.validationCache.delete(key);
      }
    }
  }

  /**
   * Get validation statistics
   */
  getValidationStats() {
    return {
      cacheSize: this.validationCache.size,
      cacheTimeout: this.cacheTimeout,
      tolerancePercentage: this.tolerancePercentage,
      minAmountThreshold: this.minAmountThreshold
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.validationCache.clear();
  }
}

module.exports = ReconciliationAnalyticsValidator;
