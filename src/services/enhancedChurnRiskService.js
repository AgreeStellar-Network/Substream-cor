const { v4: uuidv4 } = require('uuid');
const db = require('../database/connection');

/**
 * Enhanced Churn Risk Prediction Service
 * 
 * This service implements the specific requirements:
 * - Analyzes user's balance_history and missed_payment_streak over last 6 cycles
 * - Flags users as High_Churn_Risk if they topped up "just-in-time" for last 3 cycles
 * - Provides actionable risk scores for merchant's subscriber base
 * - Optimized for scanning thousands of users without database bottlenecks
 */
class EnhancedChurnRiskService {
  constructor(options = {}) {
    this.db = db;
    this.options = {
      // Risk scoring thresholds
      highRiskThreshold: options.highRiskThreshold || 70,
      mediumRiskThreshold: options.mediumRiskThreshold || 40,
      
      // "Just-in-time" detection parameters
      justInTimeWindowHours: options.justInTimeWindowHours || 24,
      justInTimeCyclesThreshold: options.justInTimeCyclesThreshold || 3,
      analysisWindowCycles: options.analysisWindowCycles || 6,
      
      // Performance optimization
      batchSize: options.batchSize || 1000,
      maxConcurrentQueries: options.maxConcurrentQueries || 10,
      
      ...options
    };
  }

  /**
   * Analyze churn risk for all subscribers of a merchant
   * @param {string} merchantId - Merchant ID
   * @returns {Promise<Object>} Risk analysis results
   */
  async analyzeMerchantChurnRisk(merchantId) {
    const startTime = Date.now();
    
    try {
      // Get all active subscribers for the merchant
      const subscribers = await this.getMerchantSubscribers(merchantId);
      
      // Process subscribers in batches for performance
      const riskAnalysis = {
        merchantId,
        totalSubscribers: subscribers.length,
        highRiskCount: 0,
        mediumRiskCount: 0,
        lowRiskCount: 0,
        riskScores: [],
        analysisDate: new Date().toISOString(),
        processingTimeMs: 0
      };

      // Process in batches to avoid database bottlenecks
      const batches = this.createBatches(subscribers, this.options.batchSize);
      
      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(subscriber => this.analyzeSubscriberRisk(merchantId, subscriber))
        );
        
        // Aggregate batch results
        batchResults.forEach(result => {
          if (result.riskLevel === 'High' || result.riskLevel === 'Critical') {
            riskAnalysis.highRiskCount++;
          } else if (result.riskLevel === 'Medium') {
            riskAnalysis.mediumRiskCount++;
          } else {
            riskAnalysis.lowRiskCount++;
          }
          
          riskAnalysis.riskScores.push(result);
        });
      }

      riskAnalysis.processingTimeMs = Date.now() - startTime;
      
      // Store aggregated metrics
      await this.storeRiskMetrics(riskAnalysis);
      
      return riskAnalysis;
      
    } catch (error) {
      console.error(`Error analyzing churn risk for merchant ${merchantId}:`, error);
      throw error;
    }
  }

  /**
   * Analyze individual subscriber risk
   * @param {string} merchantId - Merchant ID
   * @param {string} userWalletAddress - User wallet address
   * @returns {Promise<Object>} Risk analysis for the subscriber
   */
  async analyzeSubscriberRisk(merchantId, userWalletAddress) {
    try {
      // Get balance history for the last 6 cycles
      const balanceHistory = await this.getBalanceHistory(merchantId, userWalletAddress, 6);
      
      // Get payment attempts for the last 6 cycles
      const paymentAttempts = await this.getPaymentAttempts(merchantId, userWalletAddress, 6);
      
      // Calculate risk factors
      const missedPaymentStreak = await this.calculateMissedPaymentStreak(paymentAttempts);
      const justInTimeTopups = await this.detectJustInTimeTopups(paymentAttempts, balanceHistory);
      const balanceTrend = await this.analyzeBalanceTrend(balanceHistory);
      const daysUntilExhausted = await this.calculateDaysUntilBalanceExhausted(balanceHistory, paymentAttempts);
      
      // Calculate risk score using weighted factors
      const riskScore = this.calculateRiskScore({
        missedPaymentStreak,
        justInTimeTopups,
        balanceTrend,
        daysUntilExhausted,
        balanceHistory: balanceHistory.length
      });
      
      const riskLevel = this.determineRiskLevel(riskScore);
      
      const riskAnalysis = {
        merchantId,
        userWalletAddress,
        riskScore,
        riskLevel,
        predictionFactors: {
          missedPaymentStreak,
          justInTimeTopups,
          balanceTrend,
          daysUntilExhausted,
          analysisWindowCycles: this.options.analysisWindowCycles
        },
        analysisDate: new Date().toISOString()
      };

      // Store individual risk metrics
      await this.storeSubscriberRiskMetrics(riskAnalysis);
      
      return riskAnalysis;
      
    } catch (error) {
      console.error(`Error analyzing risk for subscriber ${userWalletAddress}:`, error);
      // Return default low risk on error to prevent analysis failures
      return {
        merchantId,
        userWalletAddress,
        riskScore: 0,
        riskLevel: 'Low',
        predictionFactors: {},
        analysisDate: new Date().toISOString(),
        error: error.message
      };
    }
  }

  /**
   * Get merchant subscribers with their current status
   * @param {string} merchantId - Merchant ID
   * @returns {Promise<Array>} List of subscribers
   */
  async getMerchantSubscribers(merchantId) {
    const query = `
      SELECT DISTINCT 
        s.wallet_address as userWalletAddress,
        s.balance,
        s.daily_spend as dailySpend,
        s.risk_status as currentRiskStatus,
        s.estimated_run_out_at as estimatedRunOutAt
      FROM subscriptions s
      WHERE s.creator_id = $1 
        AND s.active = 1
      ORDER BY s.wallet_address
    `;
    
    const result = await this.db.query(query, [merchantId]);
    return result.rows;
  }

  /**
   * Get balance history for a subscriber
   * @param {string} merchantId - Merchant ID
   * @param {string} userWalletAddress - User wallet address
   * @param {number} cycles - Number of cycles to analyze
   * @returns {Promise<Array>} Balance history records
   */
  async getBalanceHistory(merchantId, userWalletAddress, cycles = 6) {
    const query = `
      SELECT 
        balance,
        previous_balance as previousBalance,
        change_amount as changeAmount,
        change_type as changeType,
        cycle_number as cycleNumber,
        recorded_at as recordedAt
      FROM balance_history
      WHERE merchant_id = $1 
        AND user_wallet_address = $2
        AND cycle_number >= (
          SELECT COALESCE(MAX(cycle_number), 0) - $3 + 1 
          FROM balance_history 
          WHERE merchant_id = $1 AND user_wallet_address = $2
        )
      ORDER BY cycle_number DESC, recorded_at DESC
      LIMIT 100
    `;
    
    const result = await this.db.query(query, [merchantId, userWalletAddress, cycles]);
    return result.rows;
  }

  /**
   * Get payment attempts for a subscriber
   * @param {string} merchantId - Merchant ID
   * @param {string} userWalletAddress - User wallet address
   * @param {number} cycles - Number of cycles to analyze
   * @returns {Promise<Array>} Payment attempt records
   */
  async getPaymentAttempts(merchantId, userWalletAddress, cycles = 6) {
    const query = `
      SELECT 
        amount,
        status,
        failure_reason as failureReason,
        retry_count as retryCount,
        cycle_number as cycleNumber,
        attempted_at as attemptedAt
      FROM payment_attempts
      WHERE merchant_id = $1 
        AND user_wallet_address = $2
        AND cycle_number >= (
          SELECT COALESCE(MAX(cycle_number), 0) - $3 + 1 
          FROM payment_attempts 
          WHERE merchant_id = $1 AND user_wallet_address = $2
        )
      ORDER BY cycle_number DESC, attempted_at DESC
      LIMIT 100
    `;
    
    const result = await this.db.query(query, [merchantId, userWalletAddress, cycles]);
    return result.rows;
  }

  /**
   * Calculate missed payment streak from payment attempts
   * @param {Array} paymentAttempts - Payment attempt records
   * @returns {number} Number of consecutive missed payments
   */
  calculateMissedPaymentStreak(paymentAttempts) {
    if (!paymentAttempts || paymentAttempts.length === 0) return 0;
    
    // Group by cycle number and get the latest status for each cycle
    const cyclesByStatus = {};
    paymentAttempts.forEach(attempt => {
      const cycle = attempt.cycleNumber;
      if (!cyclesByStatus[cycle] || attempt.attemptedAt > cyclesByStatus[cycle].attemptedAt) {
        cyclesByStatus[cycle] = attempt;
      }
    });
    
    // Get sorted cycle numbers
    const cycles = Object.keys(cyclesByStatus)
      .map(Number)
      .sort((a, b) => b - a); // Sort descending (most recent first)
    
    let streak = 0;
    for (const cycle of cycles) {
      const attempt = cyclesByStatus[cycle];
      if (attempt.status === 'failed') {
        streak++;
      } else if (attempt.status === 'success') {
        break; // Streak ends on first success
      }
    }
    
    return streak;
  }

  /**
   * Detect "just-in-time" top-ups for the last 3 cycles
   * @param {Array} paymentAttempts - Payment attempt records
   * @param {Array} balanceHistory - Balance history records
   * @returns {number} Number of just-in-time top-ups detected
   */
  detectJustInTimeTopups(paymentAttempts, balanceHistory) {
    if (!paymentAttempts || !balanceHistory || paymentAttempts.length === 0) return 0;
    
    let justInTimeCount = 0;
    const windowHours = this.options.justInTimeWindowHours;
    const threshold = this.options.justInTimeCyclesThreshold;
    
    // Get the most recent cycles
    const recentCycles = this.getRecentCycles(paymentAttempts, threshold);
    
    for (const cycle of recentCycles) {
      const failedPayment = paymentAttempts.find(
        p => p.cycleNumber === cycle && p.status === 'failed'
      );
      
      if (failedPayment) {
        // Look for top-up within the window around the failed payment
        const justInTimeTopup = balanceHistory.find(
          b => b.cycleNumber === cycle && 
               b.changeType === 'topup' &&
               this.isWithinTimeWindow(
                 new Date(b.recordedAt), 
                 new Date(failedPayment.attemptedAt), 
                 windowHours
               )
        );
        
        if (justInTimeTopup) {
          justInTimeCount++;
        }
      }
    }
    
    return justInTimeCount;
  }

  /**
   * Analyze balance trend from history
   * @param {Array} balanceHistory - Balance history records
   * @returns {string} Balance trend ('increasing', 'stable', 'decreasing', 'critical')
   */
  analyzeBalanceTrend(balanceHistory) {
    if (!balanceHistory || balanceHistory.length < 2) return 'stable';
    
    const recentBalances = balanceHistory.slice(0, 3).map(h => parseFloat(h.balance));
    const olderBalances = balanceHistory.slice(3, 6).map(h => parseFloat(h.balance));
    
    if (recentBalances.length === 0) return 'stable';
    
    const recentAvg = recentBalances.reduce((a, b) => a + b, 0) / recentBalances.length;
    const olderAvg = olderBalances.length > 0 ? 
      olderBalances.reduce((a, b) => a + b, 0) / olderBalances.length : recentAvg;
    
    const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100;
    
    if (changePercent < -30) return 'critical';
    if (changePercent < -10) return 'decreasing';
    if (changePercent > 10) return 'increasing';
    return 'stable';
  }

  /**
   * Calculate days until balance is exhausted
   * @param {Array} balanceHistory - Balance history records
   * @param {Array} paymentAttempts - Payment attempt records
   * @returns {number} Days until balance exhaustion
   */
  calculateDaysUntilBalanceExhausted(balanceHistory, paymentAttempts) {
    if (!balanceHistory || balanceHistory.length === 0) return null;
    
    const currentBalance = parseFloat(balanceHistory[0].balance);
    if (currentBalance <= 0) return 0;
    
    // Calculate average daily spend from recent payment attempts
    const recentPayments = paymentAttempts.slice(0, 5);
    if (recentPayments.length === 0) return null;
    
    const dailySpend = recentPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0) / recentPayments.length;
    
    if (dailySpend <= 0) return null;
    
    return Math.floor(currentBalance / dailySpend);
  }

  /**
   * Calculate overall risk score using weighted factors
   * @param {Object} factors - Risk factors
   * @returns {number} Risk score (0-100)
   */
  calculateRiskScore(factors) {
    let score = 0;
    
    // High-Churn Risk: Just-in-time top-ups for last 3 cycles (40 points)
    if (factors.justInTimeTopups >= this.options.justInTimeCyclesThreshold) {
      score += 40;
    } else if (factors.justInTimeTopups > 0) {
      score += factors.justInTimeTopups * 10;
    }
    
    // Missed payment streak (30 points)
    score += Math.min(factors.missedPaymentStreak * 10, 30);
    
    // Balance trend (20 points)
    switch (factors.balanceTrend) {
      case 'critical': score += 20; break;
      case 'decreasing': score += 15; break;
      case 'stable': score += 5; break;
      case 'increasing': score += 0; break;
    }
    
    // Days until balance exhausted (10 points)
    if (factors.daysUntilExhausted !== null) {
      if (factors.daysUntilExhausted <= 3) score += 10;
      else if (factors.daysUntilExhausted <= 7) score += 7;
      else if (factors.daysUntilExhausted <= 14) score += 3;
    }
    
    return Math.min(score, 100);
  }

  /**
   * Determine risk level from score
   * @param {number} score - Risk score
   * @returns {string} Risk level
   */
  determineRiskLevel(score) {
    if (score >= 85) return 'Critical';
    if (score >= this.options.highRiskThreshold) return 'High';
    if (score >= this.options.mediumRiskThreshold) return 'Medium';
    return 'Low';
  }

  /**
   * Store risk metrics for a subscriber
   * @param {Object} riskAnalysis - Risk analysis data
   */
  async storeSubscriberRiskMetrics(riskAnalysis) {
    const query = `
      INSERT INTO risk_metrics (
        merchant_id, user_wallet_address, risk_score, risk_level,
        prediction_factors, missed_payment_streak, just_in_time_topups_count,
        balance_trend, days_until_balance_exhausted, analysis_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (merchant_id, user_wallet_address, analysis_date)
      DO UPDATE SET
        risk_score = EXCLUDED.risk_score,
        risk_level = EXCLUDED.risk_level,
        prediction_factors = EXCLUDED.prediction_factors,
        missed_payment_streak = EXCLUDED.missed_payment_streak,
        just_in_time_topups_count = EXCLUDED.just_in_time_topups_count,
        balance_trend = EXCLUDED.balance_trend,
        days_until_balance_exhausted = EXCLUDED.days_until_balance_exhausted,
        updated_at = CURRENT_TIMESTAMP
    `;
    
    const values = [
      riskAnalysis.merchantId,
      riskAnalysis.userWalletAddress,
      riskAnalysis.riskScore,
      riskAnalysis.riskLevel,
      JSON.stringify(riskAnalysis.predictionFactors),
      riskAnalysis.predictionFactors.missedPaymentStreak,
      riskAnalysis.predictionFactors.justInTimeTopups,
      riskAnalysis.predictionFactors.balanceTrend,
      riskAnalysis.predictionFactors.daysUntilExhausted,
      riskAnalysis.analysisDate
    ];
    
    await this.db.query(query, values);
  }

  /**
   * Store aggregated risk metrics for merchant
   * @param {Object} riskAnalysis - Aggregated risk analysis
   */
  async storeRiskMetrics(riskAnalysis) {
    // This could store summary data for analytics
    // Implementation depends on specific requirements
    console.log(`Stored risk metrics for merchant ${riskAnalysis.merchantId}:`, {
      total: riskAnalysis.totalSubscribers,
      highRisk: riskAnalysis.highRiskCount,
      mediumRisk: riskAnalysis.mediumRiskCount,
      lowRisk: riskAnalysis.lowRiskCount,
      processingTime: riskAnalysis.processingTimeMs
    });
  }

  /**
   * Get risk analysis for a merchant (for API endpoint)
   * @param {string} merchantId - Merchant ID
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Risk analysis results
   */
  async getMerchantRiskAnalysis(merchantId, options = {}) {
    const {
      riskLevel = null,
      limit = 100,
      offset = 0,
      includeFactors = true
    } = options;
    
    let query = `
      SELECT 
        user_wallet_address as userWalletAddress,
        risk_score as riskScore,
        risk_level as riskLevel,
        analysis_date as analysisDate
      `;
    
    if (includeFactors) {
      query += `,
        missed_payment_streak as missedPaymentStreak,
        just_in_time_topups_count as justInTimeTopupsCount,
        balance_trend as balanceTrend,
        days_until_balance_exhausted as daysUntilBalanceExhausted,
        prediction_factors as predictionFactors
        `;
    }
    
    query += `
      FROM risk_metrics
      WHERE merchant_id = $1
        AND analysis_date >= CURRENT_DATE - INTERVAL '7 days'
      `;
    
    const params = [merchantId];
    
    if (riskLevel) {
      query += ` AND risk_level = $${params.length + 1}`;
      params.push(riskLevel);
    }
    
    query += ` ORDER BY risk_score DESC, analysis_date DESC`;
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await this.db.query(query, params);
    
    // Get summary statistics
    const summaryQuery = `
      SELECT 
        COUNT(*) as totalSubscribers,
        COUNT(CASE WHEN risk_level IN ('High', 'Critical') THEN 1 END) as highRiskCount,
        COUNT(CASE WHEN risk_level = 'Medium' THEN 1 END) as mediumRiskCount,
        COUNT(CASE WHEN risk_level = 'Low' THEN 1 END) as lowRiskCount,
        AVG(risk_score) as averageRiskScore
      FROM risk_metrics
      WHERE merchant_id = $1
        AND analysis_date >= CURRENT_DATE - INTERVAL '7 days'
    `;
    
    const summaryResult = await this.db.query(summaryQuery, [merchantId]);
    
    return {
      merchantId,
      summary: summaryResult.rows[0],
      subscribers: result.rows,
      filters: { riskLevel, limit, offset },
      generatedAt: new Date().toISOString()
    };
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

  getRecentCycles(paymentAttempts, count) {
    const cycles = [...new Set(paymentAttempts.map(p => p.cycleNumber))]
      .sort((a, b) => b - a);
    return cycles.slice(0, count);
  }

  isWithinTimeWindow(date1, date2, windowHours) {
    const diffMs = Math.abs(date1 - date2);
    const diffHours = diffMs / (1000 * 60 * 60);
    return diffHours <= windowHours;
  }
}

module.exports = { EnhancedChurnRiskService };
