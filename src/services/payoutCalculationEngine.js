/**
 * Payout Calculation Engine with Intensity Scaling
 * 
 * Integrates ScaledUserProp algorithm with Sybil attack protection to provide
 * fraud-proof revenue division for the AgreeStellar.
 * 
 * Key Features:
 * - Real-time payout calculations
 * - Engagement intensity scaling
 * - Sybil resistance integration
 * - Economic incentive analysis
 * - Performance optimization
 */

class PayoutCalculationEngine {
  constructor(database, config = {}) {
    this.db = database;
    this.config = {
      // ScaledUserProp parameters
      alpha: config.alpha || 0.7, // Platform commission rate
      gamma: config.gamma || 0.5, // Engagement scaling parameter
      minEngagementThreshold: config.minEngagementThreshold || 0.1,
      maxEngagementMultiplier: config.maxEngagementMultiplier || 5,
      
      // Performance parameters
      batchSize: config.batchSize || 1000,
      cacheTimeout: config.cacheTimeout || 300000, // 5 minutes
      maxConcurrentCalculations: config.maxConcurrentCalculations || 10,
      
      // Economic parameters
      subscriptionFee: config.subscriptionFee || 1.0,
      minimumPayout: config.minimumPayout || 0.01,
      
      ...config
    };
    
    // Initialize services
    this.scaledUserPropEngine = new (require('./scaledUserPropEngine')).ScaledUserPropEngine(this.config);
    this.sybilProtection = new (require('./sybilAttackProtectionService')).SybilAttackProtectionService(database, this.config);
    
    // Initialize cache
    this.payoutCache = new Map();
    this.engagementCache = new Map();
    
    // Initialize database tables
    this.initializeDatabase();
    
    // Performance metrics
    this.metrics = {
      calculationsPerformed: 0,
      averageCalculationTime: 0,
      cacheHitRate: 0,
      sybilDetectionsBlocked: 0
    };
  }

  /**
   * Initialize database tables for payout calculations
   */
  initializeDatabase() {
    const tables = [
      // Payout calculation cache
      `CREATE TABLE IF NOT EXISTS payout_calculations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calculation_hash TEXT NOT NULL UNIQUE,
        period_start DATETIME NOT NULL,
        period_end DATETIME NOT NULL,
        total_users INTEGER NOT NULL,
        total_creators INTEGER NOT NULL,
        total_revenue REAL NOT NULL,
        calculation_data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL
      )`,
      
      // Creator payout records
      `CREATE TABLE IF NOT EXISTS creator_payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calculation_hash TEXT NOT NULL,
        creator_address TEXT NOT NULL,
        payout_amount REAL NOT NULL,
        engagement_share REAL NOT NULL,
        intensity_factor REAL NOT NULL,
        sybil_risk_score REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (calculation_hash) REFERENCES payout_calculations(calculation_hash)
      )`,
      
      // User engagement intensity records
      `CREATE TABLE IF NOT EXISTS user_engagement_intensity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calculation_hash TEXT NOT NULL,
        user_address TEXT NOT NULL,
        total_engagement REAL NOT NULL,
        intensity_factor REAL NOT NULL,
        effective_engagement REAL NOT NULL,
        is_suspicious BOOLEAN DEFAULT FALSE,
        sybil_risk_score REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (calculation_hash) REFERENCES payout_calculations(calculation_hash)
      )`,
      
      // Payout calculation performance metrics
      `CREATE TABLE IF NOT EXISTS payout_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        calculation_hash TEXT NOT NULL,
        calculation_time_ms INTEGER NOT NULL,
        users_processed INTEGER NOT NULL,
        cache_hit BOOLEAN DEFAULT FALSE,
        sybil_checks INTEGER NOT NULL,
        sybil_blocks INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (calculation_hash) REFERENCES payout_calculations(calculation_hash)
      )`
    ];

    // Create indexes for performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_payout_calculations_period ON payout_calculations(period_start, period_end)',
      'CREATE INDEX IF NOT EXISTS idx_payout_calculations_hash ON payout_calculations(calculation_hash)',
      'CREATE INDEX IF NOT EXISTS idx_creator_payouts_calculation ON creator_payouts(calculation_hash)',
      'CREATE INDEX IF NOT EXISTS idx_creator_payouts_creator ON creator_payouts(creator_address)',
      'CREATE INDEX IF NOT EXISTS idx_user_engagement_calculation ON user_engagement_intensity(calculation_hash)',
      'CREATE INDEX IF NOT EXISTS idx_user_engagement_user ON user_engagement_intensity(user_address)',
      'CREATE INDEX IF NOT EXISTS idx_payout_performance_calculation ON payout_performance(calculation_hash)'
    ];

    tables.forEach(sql => {
      try {
        this.db.run(sql);
      } catch (error) {
        console.error('Error creating payout table:', error);
      }
    });

    indexes.forEach(sql => {
      try {
        this.db.run(sql);
      } catch (error) {
        console.error('Error creating payout index:', error);
      }
    });
  }

  /**
   * Calculate payouts for a given period with intensity scaling
   * @param {Object} period - Period definition {start: Date, end: Date}
   * @param {Object} options - Calculation options
   * @returns {Object} Payout calculation results
   */
  async calculatePayoutsForPeriod(period, options = {}) {
    const startTime = Date.now();
    const calculationHash = this.generateCalculationHash(period, options);
    
    try {
      // Check cache first
      const cachedResult = this.getCachedCalculation(calculationHash);
      if (cachedResult && !options.forceRecalculate) {
        this.updateCacheMetrics(true);
        return cachedResult;
      }
      
      this.updateCacheMetrics(false);
      
      // Gather engagement data for the period
      const engagementData = await this.gatherEngagementData(period);
      
      // Apply Sybil attack protection
      const protectedData = await this.applySybilProtection(engagementData);
      
      // Calculate payouts using ScaledUserProp
      const payoutResults = this.scaledUserPropEngine.calculatePayouts(protectedData);
      
      // Apply economic safeguards
      const safeguardedResults = this.applyEconomicSafeguards(payoutResults);
      
      // Store calculation results
      await this.storeCalculationResults(calculationHash, period, safeguardedResults);
      
      // Update performance metrics
      const calculationTime = Date.now() - startTime;
      this.updatePerformanceMetrics(calculationHash, calculationTime, protectedData);
      
      return safeguardedResults;
      
    } catch (error) {
      console.error('Error calculating payouts:', error);
      throw new Error(`Payout calculation failed: ${error.message}`);
    }
  }

  /**
   * Gather engagement data for a period
   * @param {Object} period - Period definition
   * @returns {Object} Engagement data
   */
  async gatherEngagementData(period) {
    try {
      // Get all users with engagement in the period
      const users = this.db.prepare(`
        SELECT DISTINCT user_address
        FROM engagement_patterns
        WHERE timestamp >= ? AND timestamp <= ?
      `).all(period.start.toISOString(), period.end.toISOString()).map(row => row.user_address);
      
      // Get all creators with engagement in the period
      const creators = this.db.prepare(`
        SELECT DISTINCT creator_address
        FROM engagement_patterns
        WHERE timestamp >= ? AND timestamp <= ?
      `).all(period.start.toISOString(), period.end.toISOString()).map(row => row.creator_address);
      
      // Build engagement matrix
      const engagements = {};
      
      for (const userAddress of users) {
        const userEngagements = this.db.prepare(`
          SELECT creator_address, SUM(engagement_weight) as total_weight
          FROM engagement_patterns
          WHERE user_address = ? AND timestamp >= ? AND timestamp <= ?
          GROUP BY creator_address
        `).all(userAddress, period.start.toISOString(), period.end.toISOString());
        
        engagements[userAddress] = {};
        for (const engagement of userEngagements) {
          engagements[userAddress][engagement.creator_address] = engagement.total_weight;
        }
      }
      
      return {
        users,
        creators,
        engagements,
        period,
        totalUsers: users.length,
        totalCreators: creators.length
      };
      
    } catch (error) {
      console.error('Error gathering engagement data:', error);
      throw error;
    }
  }

  /**
   * Apply Sybil attack protection to engagement data
   * @param {Object} engagementData - Raw engagement data
   * @returns {Object} Protected engagement data
   */
  async applySybilProtection(engagementData) {
    const protectedData = {
      ...engagementData,
      users: [],
      engagements: {},
      protectedUsers: [],
      blockedUsers: []
    };
    
    let sybilChecks = 0;
    let sybilBlocks = 0;
    
    for (const userAddress of engagementData.users) {
      sybilChecks++;
      
      // Get user's engagement data
      const userEngagement = engagementData.engagements[userAddress] || {};
      
      // Get session data (simplified)
      const sessionData = this.getUserSessionData(userAddress);
      
      // Analyze for Sybil attack
      const sybilAnalysis = this.sybilProtection.analyzeUserForSybil(
        userAddress, 
        userEngagement, 
        sessionData
      );
      
      // Apply protection based on risk score
      if (sybilAnalysis.isSuspicious) {
        sybilBlocks++;
        protectedData.blockedUsers.push({
          userAddress,
          riskScore: sybilAnalysis.overallRisk,
          reasons: sybilAnalysis.riskFactors.map(f => f.type)
        });
        
        // Don't include suspicious users in payout calculations
        continue;
      }
      
      // Include user with adjusted engagement if needed
      protectedData.users.push(userAddress);
      protectedData.engagements[userAddress] = userEngagement;
      protectedData.protectedUsers.push({
        userAddress,
        riskScore: sybilAnalysis.overallRisk,
        intensityFactor: sybilAnalysis.riskFactors.find(f => f.type === 'engagement')?.score || 0
      });
    }
    
    // Update metrics
    this.metrics.sybilDetectionsBlocked += sybilBlocks;
    
    console.log(`Sybil protection: ${sybilBlocks}/${sybilChecks} users blocked`);
    
    return protectedData;
  }

  /**
   * Apply economic safeguards to payout results
   * @param {Object} payoutResults - Raw payout results
   * @returns {Object} Safeguarded payout results
   */
  applyEconomicSafeguards(payoutResults) {
    const safeguardedResults = {
      ...payoutResults,
      economicSafeguards: {
        minimumPayoutsApplied: 0,
        maximumPayoutsAdjusted: 0,
        totalAdjustment: 0
      }
    };
    
    // Apply minimum payout threshold
    for (const [creatorId, payout] of Object.entries(safeguardedResults.creatorPayouts)) {
      if (payout > 0 && payout < this.config.minimumPayout) {
        safeguardedResults.creatorPayouts[creatorId] = 0;
        safeguardedResults.economicSafeguards.minimumPayoutsApplied++;
        safeguardedResults.economicSafeguards.totalAdjustment += payout;
      }
    }
    
    // Apply maximum payout cap (prevent extreme concentration)
    const totalRevenue = safeguardedResults.totalRevenue;
    const maxPayoutCap = totalRevenue * 0.1; // 10% of total revenue per creator
    
    for (const [creatorId, payout] of Object.entries(safeguardedResults.creatorPayouts)) {
      if (payout > maxPayoutCap) {
        const adjustment = payout - maxPayoutCap;
        safeguardedResults.creatorPayouts[creatorId] = maxPayoutCap;
        safeguardedResults.economicSafeguards.maximumPayoutsAdjusted++;
        safeguardedResults.economicSafeguards.totalAdjustment += adjustment;
      }
    }
    
    // Redistribute adjusted amounts proportionally
    if (safeguardedResults.economicSafeguards.totalAdjustment > 0) {
      this.redistributeAdjustments(safeguardedResults);
    }
    
    return safeguardedResults;
  }

  /**
   * Redistribute payout adjustments to other creators
   * @param {Object} results - Payout results
   */
  redistributeAdjustments(results) {
    const totalAdjustment = results.economicSafeguards.totalAdjustment;
    const eligibleCreators = Object.entries(results.creatorPayouts)
      .filter(([_, payout]) => payout > 0 && payout < (results.totalRevenue * 0.1))
      .map(([id, _]) => id);
    
    if (eligibleCreators.length === 0) return;
    
    const adjustmentPerCreator = totalAdjustment / eligibleCreators.length;
    
    for (const creatorId of eligibleCreators) {
      results.creatorPayouts[creatorId] += adjustmentPerCreator;
    }
  }

  /**
   * Store calculation results in database
   * @param {string} calculationHash - Unique hash for calculation
   * @param {Object} period - Calculation period
   * @param {Object} results - Calculation results
   */
  async storeCalculationResults(calculationHash, period, results) {
    try {
      // Store main calculation record
      this.db.prepare(`
        INSERT INTO payout_calculations 
        (calculation_hash, period_start, period_end, total_users, total_creators, total_revenue, calculation_data, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        calculationHash,
        period.start.toISOString(),
        period.end.toISOString(),
        results.globalStats.totalUsers,
        results.globalStats.totalCreators,
        results.totalRevenue,
        JSON.stringify(results),
        new Date(Date.now() + this.config.cacheTimeout).toISOString()
      );
      
      // Store creator payouts
      for (const [creatorId, payout] of Object.entries(results.creatorPayouts)) {
        this.db.prepare(`
          INSERT INTO creator_payouts 
          (calculation_hash, creator_address, payout_amount, engagement_share, intensity_factor, sybil_risk_score)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          calculationHash,
          creatorId,
          payout,
          results.creatorShares[creatorId] || 0,
          0, // Would be calculated from user intensities
          0  // Would be calculated from user risk scores
        );
      }
      
      // Store user engagement intensities
      if (results.userIntensities) {
        for (const [userId, intensity] of Object.entries(results.userIntensities)) {
          this.db.prepare(`
            INSERT INTO user_engagement_intensity 
            (calculation_hash, user_address, total_engagement, intensity_factor, effective_engagement, is_suspicious, sybil_risk_score)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            calculationHash,
            userId,
            intensity.totalUserEngagement || 0,
            intensity.intensityFactor || 0,
            intensity.totalEffective || 0,
            intensity.isSuspicious || false,
            intensity.engagementRatio || 0
          );
        }
      }
      
    } catch (error) {
      console.error('Error storing calculation results:', error);
    }
  }

  /**
   * Update performance metrics
   * @param {string} calculationHash - Calculation hash
   * @param {number} calculationTime - Time in milliseconds
   * @param {Object} protectedData - Protected engagement data
   */
  updatePerformanceMetrics(calculationHash, calculationTime, protectedData) {
    try {
      this.db.prepare(`
        INSERT INTO payout_performance 
        (calculation_hash, calculation_time_ms, users_processed, cache_hit, sybil_checks, sybil_blocks)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        calculationHash,
        calculationTime,
        protectedData.users.length,
        false, // Cache miss since we calculated
        protectedData.users.length + protectedData.blockedUsers.length,
        protectedData.blockedUsers.length
      );
      
      // Update in-memory metrics
      this.metrics.calculationsPerformed++;
      this.metrics.averageCalculationTime = 
        (this.metrics.averageCalculationTime * (this.metrics.calculationsPerformed - 1) + calculationTime) / 
        this.metrics.calculationsPerformed;
      
    } catch (error) {
      console.error('Error updating performance metrics:', error);
    }
  }

  /**
   * Get cached calculation result
   * @param {string} calculationHash - Calculation hash
   * @returns {Object|null} Cached result
   */
  getCachedCalculation(calculationHash) {
    try {
      const cached = this.db.prepare(`
        SELECT calculation_data
        FROM payout_calculations
        WHERE calculation_hash = ? AND expires_at > datetime('now')
      `).get(calculationHash);
      
      return cached ? JSON.parse(cached.calculation_data) : null;
    } catch (error) {
      console.error('Error getting cached calculation:', error);
      return null;
    }
  }

  /**
   * Update cache metrics
   * @param {boolean} isHit - Whether it was a cache hit
   */
  updateCacheMetrics(isHit) {
    const totalRequests = this.metrics.cacheHitRate * (this.metrics.calculationsPerformed || 1) + 1;
    const hits = isHit ? this.metrics.cacheHitRate * (this.metrics.calculationsPerformed || 1) + 1 : 
                   this.metrics.cacheHitRate * (this.metrics.calculationsPerformed || 1);
    
    this.metrics.cacheHitRate = hits / totalRequests;
  }

  /**
   * Generate unique hash for calculation
   * @param {Object} period - Calculation period
   * @param {Object} options - Calculation options
   * @returns {string} Calculation hash
   */
  generateCalculationHash(period, options) {
    const crypto = require('crypto');
    const data = {
      period: {
        start: period.start.toISOString(),
        end: period.end.toISOString()
      },
      options,
      config: {
        alpha: this.config.alpha,
        gamma: this.config.gamma,
        minEngagementThreshold: this.config.minEngagementThreshold
      }
    };
    
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
  }

  /**
   * Get user session data (simplified implementation)
   * @param {string} userAddress - User address
   * @returns {Object} Session data
   */
  getUserSessionData(userAddress) {
    try {
      const fingerprint = this.db.prepare(`
        SELECT ip_address, user_agent, device_fingerprint
        FROM user_fingerprints
        WHERE user_address = ?
        ORDER BY last_seen DESC
        LIMIT 1
      `).get(userAddress);
      
      return fingerprint || {
        ipAddress: 'unknown',
        userAgent: 'unknown',
        deviceFingerprint: 'unknown'
      };
    } catch (error) {
      console.error('Error getting user session data:', error);
      return {
        ipAddress: 'unknown',
        userAgent: 'unknown',
        deviceFingerprint: 'unknown'
      };
    }
  }

  /**
   * Calculate real-time payouts for a single creator
   * @param {string} creatorAddress - Creator address
   * @param {Object} options - Calculation options
   * @returns {Object} Real-time payout estimate
   */
  async calculateRealTimePayout(creatorAddress, options = {}) {
    try {
      const now = new Date();
      const period = {
        start: new Date(now.getTime() - 24 * 60 * 60 * 1000), // Last 24 hours
        end: now
      };
      
      const results = await this.calculatePayoutsForPeriod(period, options);
      
      return {
        creatorAddress,
        payoutAmount: results.creatorPayouts[creatorAddress] || 0,
        engagementShare: results.creatorShares[creatorAddress] || 0,
        period,
        timestamp: now.toISOString(),
        algorithm: 'ScaledUserProp',
        riskMetrics: {
          sybilRiskScore: 0, // Would be calculated from user data
          engagementQuality: 0, // Would be calculated from engagement patterns
          payoutStability: 0 // Would be calculated from historical data
        }
      };
      
    } catch (error) {
      console.error('Error calculating real-time payout:', error);
      throw error;
    }
  }

  /**
   * Get payout history for a creator
   * @param {string} creatorAddress - Creator address
   * @param {Object} options - Query options
   * @returns {Array} Payout history
   */
  getPayoutHistory(creatorAddress, options = {}) {
    try {
      const limit = options.limit || 30;
      const offset = options.offset || 0;
      
      const history = this.db.prepare(`
        SELECT 
          cp.payout_amount,
          cp.engagement_share,
          cp.intensity_factor,
          cp.sybil_risk_score,
          pc.period_start,
          pc.period_end,
          pc.total_revenue,
          cp.created_at
        FROM creator_payouts cp
        JOIN payout_calculations pc ON cp.calculation_hash = pc.calculation_hash
        WHERE cp.creator_address = ?
        ORDER BY pc.period_start DESC
        LIMIT ? OFFSET ?
      `).all(creatorAddress, limit, offset);
      
      return history.map(row => ({
        payoutAmount: row.payout_amount,
        engagementShare: row.engagement_share,
        intensityFactor: row.intensity_factor,
        sybilRiskScore: row.sybil_risk_score,
        period: {
          start: row.period_start,
          end: row.period_end
        },
        totalRevenue: row.total_revenue,
        timestamp: row.created_at
      }));
      
    } catch (error) {
      console.error('Error getting payout history:', error);
      return [];
    }
  }

  /**
   * Get system-wide payout statistics
   * @returns {Object} System statistics
   */
  getSystemStatistics() {
    try {
      const stats = {
        totalCalculations: 0,
        averageCalculationTime: 0,
        totalRevenueDistributed: 0,
        totalCreatorsPaid: 0,
        averagePayoutAmount: 0,
        sybilProtectionEffectiveness: 0,
        cachePerformance: this.metrics.cacheHitRate
      };
      
      // Total calculations
      stats.totalCalculations = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM payout_calculations
      `).get()?.count || 0;
      
      // Average calculation time
      const avgTime = this.db.prepare(`
        SELECT AVG(calculation_time_ms) as avg_time
        FROM payout_performance
      `).get()?.avg_time || 0;
      stats.averageCalculationTime = avgTime;
      
      // Total revenue distributed
      const totalRevenue = this.db.prepare(`
        SELECT SUM(total_revenue) as total
        FROM payout_calculations
      `).get()?.total || 0;
      stats.totalRevenueDistributed = totalRevenue;
      
      // Total creators paid
      stats.totalCreatorsPaid = this.db.prepare(`
        SELECT COUNT(DISTINCT creator_address) as count
        FROM creator_payouts
        WHERE payout_amount > 0
      `).get()?.count || 0;
      
      // Average payout amount
      const avgPayout = this.db.prepare(`
        SELECT AVG(payout_amount) as avg
        FROM creator_payouts
        WHERE payout_amount > 0
      `).get()?.avg || 0;
      stats.averagePayoutAmount = avgPayout;
      
      // Sybil protection effectiveness
      const totalChecks = this.db.prepare(`
        SELECT SUM(sybil_checks) as total
        FROM payout_performance
      `).get()?.total || 0;
      
      const totalBlocks = this.db.prepare(`
        SELECT SUM(sybil_blocks) as total
        FROM payout_performance
      `).get()?.total || 0;
      
      stats.sybilProtectionEffectiveness = totalChecks > 0 ? totalBlocks / totalChecks : 0;
      
      return stats;
      
    } catch (error) {
      console.error('Error getting system statistics:', error);
      return {};
    }
  }

  /**
   * Generate comprehensive payout report
   * @param {Object} period - Report period
   * @returns {Object} Comprehensive report
   */
  async generatePayoutReport(period) {
    try {
      const results = await this.calculatePayoutsForPeriod(period);
      const statistics = this.getSystemStatistics();
      const sybilReport = this.sybilProtection.generateProtectionReport();
      
      return {
        timestamp: new Date().toISOString(),
        period,
        algorithm: 'ScaledUserProp',
        results,
        statistics,
        sybilProtection: sybilReport,
        economicAnalysis: this.analyzeEconomicImpact(results),
        fairnessAnalysis: this.analyzeFairness(results),
        recommendations: this.generateRecommendations(results, statistics)
      };
      
    } catch (error) {
      console.error('Error generating payout report:', error);
      throw error;
    }
  }

  /**
   * Analyze economic impact of payout calculations
   * @param {Object} results - Payout results
   * @returns {Object} Economic analysis
   */
  analyzeEconomicImpact(results) {
    const totalPayouts = Object.values(results.creatorPayouts).reduce((sum, payout) => sum + payout, 0);
    const platformRevenue = results.totalRevenue - totalPayouts;
    
    return {
      totalRevenue: results.totalRevenue,
      totalPayouts,
      platformRevenue,
      platformCommissionRate: platformRevenue / results.totalRevenue,
      averagePayoutPerCreator: totalPayouts / Object.keys(results.creatorPayouts).length,
      payoutDistribution: {
        top10Percent: this.calculateTopPercentile(results.creatorPayouts, 0.1),
        top1Percent: this.calculateTopPercentile(results.creatorPayouts, 0.01),
        bottom50Percent: this.calculateBottomPercentile(results.creatorPayouts, 0.5)
      }
    };
  }

  /**
   * Analyze fairness of payout distribution
   * @param {Object} results - Payout results
   * @returns {Object} Fairness analysis
   */
  analyzeFairness(results) {
    const payouts = Object.values(results.creatorPayouts).filter(p => p > 0);
    
    if (payouts.length === 0) {
      return {
        giniCoefficient: 0,
        maxEnvy: 0,
        fairnessScore: 1,
        distribution: 'equal'
      };
    }
    
    // Calculate Gini coefficient
    const sortedPayouts = payouts.sort((a, b) => a - b);
    const n = sortedPayouts.length;
    let gini = 0;
    for (let i = 0; i < n; i++) {
      gini += (2 * (i + 1) - n - 1) * sortedPayouts[i];
    }
    const giniCoefficient = n > 0 ? gini / (n * sortedPayouts[n - 1]) : 0;
    
    // Calculate fairness score (inverse of Gini, normalized)
    const fairnessScore = Math.max(0, 1 - giniCoefficient);
    
    return {
      giniCoefficient,
      maxEnvy: results.fairnessMetrics?.maxEnvy || 0,
      fairnessScore,
      distribution: fairnessScore > 0.8 ? 'fair' : fairnessScore > 0.6 ? 'moderate' : 'unequal'
    };
  }

  /**
   * Calculate top percentile of payouts
   * @param {Object} payouts - Creator payouts
   * @param {number} percentile - Percentile (0-1)
   * @returns {number} Sum of top percentile payouts
   */
  calculateTopPercentile(payouts, percentile) {
    const sortedPayouts = Object.values(payouts).sort((a, b) => b - a);
    const topCount = Math.ceil(sortedPayouts.length * percentile);
    return sortedPayouts.slice(0, topCount).reduce((sum, payout) => sum + payout, 0);
  }

  /**
   * Calculate bottom percentile of payouts
   * @param {Object} payouts - Creator payouts
   * @param {number} percentile - Percentile (0-1)
   * @returns {number} Sum of bottom percentile payouts
   */
  calculateBottomPercentile(payouts, percentile) {
    const sortedPayouts = Object.values(payouts).sort((a, b) => a - b);
    const bottomCount = Math.ceil(sortedPayouts.length * percentile);
    return sortedPayouts.slice(0, bottomCount).reduce((sum, payout) => sum + payout, 0);
  }

  /**
   * Generate recommendations based on analysis
   * @param {Object} results - Payout results
   * @param {Object} statistics - System statistics
   * @returns {Array} Recommendations
   */
  generateRecommendations(results, statistics) {
    const recommendations = [];
    
    // Check Sybil protection effectiveness
    if (statistics.sybilProtectionEffectiveness < 0.1) {
      recommendations.push({
        type: 'security',
        priority: 'high',
        action: 'enhance_sybil_detection',
        message: 'Low Sybil detection rate. Consider adjusting detection thresholds.'
      });
    }
    
    // Check fairness
    if (results.fairnessMetrics?.maxEnvy > 10) {
      recommendations.push({
        type: 'fairness',
        priority: 'medium',
        action: 'adjust_gamma_parameter',
        message: 'High payout inequality detected. Consider adjusting gamma parameter.'
      });
    }
    
    // Check cache performance
    if (statistics.cachePerformance < 0.5) {
      recommendations.push({
        type: 'performance',
        priority: 'low',
        action: 'increase_cache_timeout',
        message: 'Low cache hit rate. Consider increasing cache timeout.'
      });
    }
    
    return recommendations;
  }

  /**
   * Clean up expired cache entries
   */
  cleanupExpiredCache() {
    try {
      const result = this.db.prepare(`
        DELETE FROM payout_calculations
        WHERE expires_at < datetime('now')
      `).run();
      
      console.log(`Cleaned up ${result.changes} expired cache entries`);
    } catch (error) {
      console.error('Error cleaning up cache:', error);
    }
  }
}

module.exports = {
  PayoutCalculationEngine
};
