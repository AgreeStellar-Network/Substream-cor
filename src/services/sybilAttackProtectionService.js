/**
 * Sybil Attack Protection Service
 * 
 * Implements comprehensive protection against Sybil attacks in the AgreeStellar
 * by detecting and preventing coordinated manipulation of the revenue division system.
 * 
 * Key Features:
 * - Multi-layer Sybil detection
 * - Behavioral pattern analysis
 * - Network graph analysis
 * - Temporal pattern detection
 * - Economic incentive analysis
 */

class SybilAttackProtectionService {
  constructor(database, config = {}) {
    this.db = database;
    this.config = {
      detectionThreshold: config.detectionThreshold || 0.8,
      maxAccountsPerIP: config.maxAccountsPerIP || 5,
      maxAccountsPerDevice: config.maxAccountsPerDevice || 3,
      suspiciousEngagementThreshold: config.suspiciousEngagementThreshold || 10,
      temporalWindowHours: config.temporalWindowHours || 24,
      networkSimilarityThreshold: config.networkSimilarityThreshold || 0.7,
      economicCostThreshold: config.economicCostThreshold || 100,
      ...config
    };
    
    this.initializeDatabase();
  }

  /**
   * Initialize database tables for Sybil attack detection
   */
  initializeDatabase() {
    const tables = [
      // User fingerprinting and tracking
      `CREATE TABLE IF NOT EXISTS user_fingerprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_address TEXT NOT NULL,
        fingerprint_hash TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        device_fingerprint TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        engagement_score REAL DEFAULT 0,
        is_suspicious BOOLEAN DEFAULT FALSE,
        UNIQUE(user_address, fingerprint_hash)
      )`,
      
      // Engagement patterns and anomalies
      `CREATE TABLE IF NOT EXISTS engagement_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_address TEXT NOT NULL,
        creator_address TEXT NOT NULL,
        engagement_type TEXT NOT NULL,
        engagement_weight REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        session_id TEXT,
        is_anomalous BOOLEAN DEFAULT FALSE,
        anomaly_score REAL DEFAULT 0
      )`,
      
      // Network relationship analysis
      `CREATE TABLE IF NOT EXISTS user_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_a TEXT NOT NULL,
        user_b TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        strength REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_a, user_b, relationship_type)
      )`,
      
      // Sybil attack detection results
      `CREATE TABLE IF NOT EXISTS sybil_detections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attack_id TEXT NOT NULL UNIQUE,
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        attack_type TEXT NOT NULL,
        confidence_score REAL NOT NULL,
        affected_users TEXT NOT NULL,
        affected_creators TEXT NOT NULL,
        economic_impact REAL NOT NULL,
        status TEXT DEFAULT 'active',
        mitigated_at DATETIME,
        mitigation_actions TEXT
      )`,
      
      // Economic cost analysis
      `CREATE TABLE IF NOT EXISTS economic_analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_address TEXT NOT NULL,
        analysis_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        subscription_cost REAL NOT NULL,
        estimated_engagement_cost REAL NOT NULL,
        potential_profit REAL NOT NULL,
        is_profitable BOOLEAN DEFAULT FALSE,
        profitability_ratio REAL DEFAULT 0
      )`
    ];

    // Create indexes for performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_user_fingerprints_address ON user_fingerprints(user_address)',
      'CREATE INDEX IF NOT EXISTS idx_user_fingerprints_ip ON user_fingerprints(ip_address)',
      'CREATE INDEX IF NOT EXISTS idx_user_fingerprints_device ON user_fingerprints(device_fingerprint)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_patterns_user ON engagement_patterns(user_address)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_patterns_creator ON engagement_patterns(creator_address)',
      'CREATE INDEX IF NOT EXISTS idx_engagement_patterns_timestamp ON engagement_patterns(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_user_relationships_users ON user_relationships(user_a, user_b)',
      'CREATE INDEX IF NOT EXISTS idx_sybil_detections_status ON sybil_detections(status)',
      'CREATE INDEX IF NOT EXISTS idx_economic_analysis_user ON economic_analysis(user_address)'
    ];

    tables.forEach(sql => {
      try {
        this.db.run(sql);
      } catch (error) {
        console.error('Error creating table:', error);
      }
    });

    indexes.forEach(sql => {
      try {
        this.db.run(sql);
      } catch (error) {
        console.error('Error creating index:', error);
      }
    });
  }

  /**
   * Analyze user for potential Sybil attack indicators
   * @param {string} userAddress - User's Stellar address
   * @param {Object} engagementData - User's engagement data
   * @param {Object} sessionData - Session information
   * @returns {Object} Sybil analysis results
   */
  analyzeUserForSybil(userAddress, engagementData, sessionData) {
    const analysis = {
      userAddress,
      timestamp: new Date().toISOString(),
      riskFactors: [],
      overallRisk: 0,
      isSuspicious: false,
      recommendations: []
    };

    // 1. Fingerprint Analysis
    const fingerprintRisk = this.analyzeFingerprintRisk(userAddress, sessionData);
    analysis.riskFactors.push(fingerprintRisk);

    // 2. Engagement Pattern Analysis
    const engagementRisk = this.analyzeEngagementPatterns(userAddress, engagementData);
    analysis.riskFactors.push(engagementRisk);

    // 3. Temporal Pattern Analysis
    const temporalRisk = this.analyzeTemporalPatterns(userAddress);
    analysis.riskFactors.push(temporalRisk);

    // 4. Network Analysis
    const networkRisk = this.analyzeNetworkRelationships(userAddress);
    analysis.riskFactors.push(networkRisk);

    // 5. Economic Analysis
    const economicRisk = this.analyzeEconomicIncentives(userAddress, engagementData);
    analysis.riskFactors.push(economicRisk);

    // Calculate overall risk score
    analysis.overallRisk = this.calculateOverallRisk(analysis.riskFactors);
    analysis.isSuspicious = analysis.overallRisk > this.config.detectionThreshold;

    // Generate recommendations
    analysis.recommendations = this.generateRecommendations(analysis);

    // Store analysis results
    this.storeSybilAnalysis(analysis);

    return analysis;
  }

  /**
   * Analyze fingerprint-based risk factors
   * @param {string} userAddress - User address
   * @param {Object} sessionData - Session information
   * @returns {Object} Fingerprint risk analysis
   */
  analyzeFingerprintRisk(userAddress, sessionData) {
    const risk = {
      type: 'fingerprint',
      score: 0,
      factors: [],
      details: {}
    };

    try {
      // Check IP-based clustering
      const ipCount = this.db.prepare(`
        SELECT COUNT(DISTINCT user_address) as count
        FROM user_fingerprints
        WHERE ip_address = ? AND created_at > datetime('now', '-30 days')
      `).get(sessionData.ipAddress || 'unknown')?.count || 0;

      if (ipCount > this.config.maxAccountsPerIP) {
        risk.score += 0.3;
        risk.factors.push('high_ip_clustering');
        risk.details.ipClustering = { count: ipCount, threshold: this.config.maxAccountsPerIP };
      }

      // Check device fingerprint clustering
      const deviceCount = this.db.prepare(`
        SELECT COUNT(DISTINCT user_address) as count
        FROM user_fingerprints
        WHERE device_fingerprint = ? AND created_at > datetime('now', '-30 days')
      `).get(sessionData.deviceFingerprint || 'unknown')?.count || 0;

      if (deviceCount > this.config.maxAccountsPerDevice) {
        risk.score += 0.4;
        risk.factors.push('high_device_clustering');
        risk.details.deviceClustering = { count: deviceCount, threshold: this.config.maxAccountsPerDevice };
      }

      // Check user agent similarity
      const userAgentCount = this.db.prepare(`
        SELECT COUNT(DISTINCT user_address) as count
        FROM user_fingerprints
        WHERE user_agent = ? AND created_at > datetime('now', '-7 days')
      `).get(sessionData.userAgent || 'unknown')?.count || 0;

      if (userAgentCount > 10) {
        risk.score += 0.2;
        risk.factors.push('suspicious_user_agent');
        risk.details.userAgentClustering = { count: userAgentCount };
      }

    } catch (error) {
      console.error('Fingerprint analysis error:', error);
      risk.score += 0.1; // Add small risk for analysis failures
    }

    return risk;
  }

  /**
   * Analyze engagement patterns for anomalies
   * @param {string} userAddress - User address
   * @param {Object} engagementData - Engagement data
   * @returns {Object} Engagement risk analysis
   */
  analyzeEngagementPatterns(userAddress, engagementData) {
    const risk = {
      type: 'engagement',
      score: 0,
      factors: [],
      details: {}
    };

    try {
      // Calculate engagement intensity
      const totalEngagement = Object.values(engagementData).reduce((sum, weight) => sum + weight, 0);
      const creatorCount = Object.keys(engagementData).length;

      // Check for unusually high engagement
      if (totalEngagement > this.config.suspiciousEngagementThreshold) {
        risk.score += 0.4;
        risk.factors.push('high_engagement_intensity');
        risk.details.engagementIntensity = totalEngagement;
      }

      // Check for narrow creator focus (potential targeted manipulation)
      if (creatorCount === 1 && totalEngagement > 5) {
        risk.score += 0.3;
        risk.factors.push('single_creator_focus');
        risk.details.singleCreatorFocus = { creatorCount, totalEngagement };
      }

      // Check for consistent engagement patterns (robot-like)
      const engagementValues = Object.values(engagementData);
      const variance = this.calculateVariance(engagementValues);
      if (variance < 0.1 && engagementValues.length > 2) {
        risk.score += 0.3;
        risk.factors.push('consistent_engagement_pattern');
        risk.details.engagementVariance = variance;
      }

      // Store engagement pattern for future analysis
      this.storeEngagementPattern(userAddress, engagementData);

    } catch (error) {
      console.error('Engagement analysis error:', error);
      risk.score += 0.1;
    }

    return risk;
  }

  /**
   * Analyze temporal patterns for suspicious behavior
   * @param {string} userAddress - User address
   * @returns {Object} Temporal risk analysis
   */
  analyzeTemporalPatterns(userAddress) {
    const risk = {
      type: 'temporal',
      score: 0,
      factors: [],
      details: {}
    };

    try {
      // Check for burst activity patterns
      const recentEngagement = this.db.prepare(`
        SELECT COUNT(*) as count, 
               MIN(timestamp) as first_engagement,
               MAX(timestamp) as last_engagement
        FROM engagement_patterns
        WHERE user_address = ? 
          AND timestamp > datetime('now', '-${this.config.temporalWindowHours} hours')
      `).get(userAddress);

      if (recentEngagement && recentEngagement.count > 0) {
        const timeSpan = new Date(recentEngagement.last_engagement) - new Date(recentEngagement.first_engagement);
        const hoursSpan = timeSpan / (1000 * 60 * 60);

        // Check for unnatural rapid engagement
        if (recentEngagement.count > 50 && hoursSpan < 1) {
          risk.score += 0.4;
          risk.factors.push('rapid_burst_activity');
          risk.details.burstActivity = { count: recentEngagement.count, hoursSpan };
        }

        // Check for 24/7 activity patterns (bot-like)
        if (hoursSpan > 22 && recentEngagement.count > 100) {
          risk.score += 0.3;
          risk.factors.push('continuous_activity_pattern');
          risk.details.continuousActivity = { hoursSpan, count: recentEngagement.count };
        }
      }

      // Check for synchronized activity with other users
      const synchronizedUsers = this.findSynchronizedUsers(userAddress);
      if (synchronizedUsers.length > 0) {
        risk.score += 0.3;
        risk.factors.push('synchronized_activity');
        risk.details.synchronizedUsers = synchronizedUsers;
      }

    } catch (error) {
      console.error('Temporal analysis error:', error);
      risk.score += 0.1;
    }

    return risk;
  }

  /**
   * Analyze network relationships for coordinated behavior
   * @param {string} userAddress - User address
   * @returns {Object} Network risk analysis
   */
  analyzeNetworkRelationships(userAddress) {
    const risk = {
      type: 'network',
      score: 0,
      factors: [],
      details: {}
    };

    try {
      // Find users with similar engagement patterns
      const similarUsers = this.findSimilarEngagementUsers(userAddress);
      
      if (similarUsers.length > 5) {
        risk.score += 0.3;
        risk.factors.push('high_similarity_cluster');
        risk.details.similarityCluster = { count: similarUsers.length };
      }

      // Check for circular referral patterns
      const circularPatterns = this.detectCircularReferralPatterns(userAddress);
      if (circularPatterns.length > 0) {
        risk.score += 0.4;
        risk.factors.push('circular_referral_patterns');
        risk.details.circularPatterns = circularPatterns;
      }

      // Analyze network centrality (high centrality can indicate coordination)
      const centrality = this.calculateNetworkCentrality(userAddress);
      if (centrality > 0.8) {
        risk.score += 0.3;
        risk.factors.push('high_network_centrality');
        risk.details.networkCentrality = centrality;
      }

    } catch (error) {
      console.error('Network analysis error:', error);
      risk.score += 0.1;
    }

    return risk;
  }

  /**
   * Analyze economic incentives for manipulation
   * @param {string} userAddress - User address
   * @param {Object} engagementData - Engagement data
   * @returns {Object} Economic risk analysis
   */
  analyzeEconomicIncentives(userAddress, engagementData) {
    const risk = {
      type: 'economic',
      score: 0,
      factors: [],
      details: {}
    };

    try {
      // Calculate potential profit vs cost
      const subscriptionCost = 1; // $1 per subscription
      const totalEngagement = Object.values(engagementData).reduce((sum, weight) => sum + weight, 0);
      
      // Estimate potential revenue from manipulation
      const estimatedRevenue = this.estimateManipulationRevenue(engagementData);
      const profitMargin = estimatedRevenue - subscriptionCost;

      // High profit margin indicates manipulation incentive
      if (profitMargin > this.config.economicCostThreshold) {
        risk.score += 0.5;
        risk.factors.push('high_profit_incentive');
        risk.details.profitAnalysis = {
          estimatedRevenue,
          subscriptionCost,
          profitMargin
        };
      }

      // Check for uneconomic behavior (loss-making but continuing)
      if (profitMargin < -10 && totalEngagement > 20) {
        risk.score += 0.3;
        risk.factors.push('uneconomic_behavior');
        risk.details.uneconomicBehavior = {
          profitMargin,
          totalEngagement
        };
      }

      // Store economic analysis
      this.storeEconomicAnalysis(userAddress, subscriptionCost, estimatedRevenue, profitMargin);

    } catch (error) {
      console.error('Economic analysis error:', error);
      risk.score += 0.1;
    }

    return risk;
  }

  /**
   * Calculate overall risk score from individual risk factors
   * @param {Array} riskFactors - Array of risk factor analyses
   * @returns {number} Overall risk score (0-1)
   */
  calculateOverallRisk(riskFactors) {
    const weights = {
      fingerprint: 0.2,
      engagement: 0.3,
      temporal: 0.2,
      network: 0.2,
      economic: 0.1
    };

    let weightedSum = 0;
    let totalWeight = 0;

    for (const factor of riskFactors) {
      const weight = weights[factor.type] || 0.2;
      weightedSum += factor.score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Generate recommendations based on risk analysis
   * @param {Object} analysis - Complete risk analysis
   * @returns {Array} Recommendations
   */
  generateRecommendations(analysis) {
    const recommendations = [];

    if (analysis.isSuspicious) {
      recommendations.push({
        type: 'immediate',
        priority: 'high',
        action: 'flag_for_review',
        message: 'User flagged for potential Sybil attack behavior'
      });
    }

    // Specific recommendations based on risk factors
    for (const factor of analysis.riskFactors) {
      if (factor.factors.includes('high_ip_clustering')) {
        recommendations.push({
          type: 'monitoring',
          priority: 'medium',
          action: 'monitor_ip_cluster',
          message: 'Monitor IP address cluster for coordinated activity'
        });
      }

      if (factor.factors.includes('high_engagement_intensity')) {
        recommendations.push({
          type: 'verification',
          priority: 'medium',
          action: 'require_additional_verification',
          message: 'Require additional verification for high-engagement user'
        });
      }

      if (factor.factors.includes('synchronized_activity')) {
        recommendations.push({
          type: 'investigation',
          priority: 'high',
          action: 'investigate_coordination',
          message: 'Investigate potential coordinated activity patterns'
        });
      }
    }

    return recommendations;
  }

  /**
   * Store Sybil analysis results
   * @param {Object} analysis - Analysis results
   */
  storeSybilAnalysis(analysis) {
    try {
      // Store in a general analysis log
      this.db.prepare(`
        INSERT INTO sybil_detections 
        (attack_id, attack_type, confidence_score, affected_users, affected_creators, economic_impact, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        `analysis_${analysis.userAddress}_${Date.now()}`,
        'user_analysis',
        analysis.overallRisk,
        JSON.stringify([analysis.userAddress]),
        JSON.stringify([]),
        0,
        analysis.isSuspicious ? 'active' : 'monitoring'
      );
    } catch (error) {
      console.error('Error storing Sybil analysis:', error);
    }
  }

  /**
   * Store engagement pattern data
   * @param {string} userAddress - User address
   * @param {Object} engagementData - Engagement data
   */
  storeEngagementPattern(userAddress, engagementData) {
    try {
      for (const [creatorAddress, weight] of Object.entries(engagementData)) {
        this.db.prepare(`
          INSERT INTO engagement_patterns 
          (user_address, creator_address, engagement_type, engagement_weight)
          VALUES (?, ?, ?, ?)
        `).run(userAddress, creatorAddress, 'view', weight);
      }
    } catch (error) {
      console.error('Error storing engagement pattern:', error);
    }
  }

  /**
   * Store economic analysis results
   * @param {string} userAddress - User address
   * @param {number} subscriptionCost - Subscription cost
   * @param {number} estimatedRevenue - Estimated revenue
   * @param {number} profitMargin - Profit margin
   */
  storeEconomicAnalysis(userAddress, subscriptionCost, estimatedRevenue, profitMargin) {
    try {
      this.db.prepare(`
        INSERT INTO economic_analysis 
        (user_address, subscription_cost, estimated_engagement_cost, potential_profit, is_profitable, profitability_ratio)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        userAddress,
        subscriptionCost,
        subscriptionCost,
        estimatedRevenue,
        profitMargin > 0,
        subscriptionCost > 0 ? profitMargin / subscriptionCost : 0
      );
    } catch (error) {
      console.error('Error storing economic analysis:', error);
    }
  }

  /**
   * Find users with synchronized activity patterns
   * @param {string} userAddress - User address
   * @returns {Array} Synchronized user addresses
   */
  findSynchronizedUsers(userAddress) {
    try {
      const synchronized = this.db.prepare(`
        SELECT DISTINCT ep2.user_address
        FROM engagement_patterns ep1
        JOIN engagement_patterns ep2 ON 
          ABS(strftime('%s', ep1.timestamp) - strftime('%s', ep2.timestamp)) < 60
          AND ep1.user_address != ep2.user_address
          AND ep1.creator_address = ep2.creator_address
        WHERE ep1.user_address = ?
          AND ep1.timestamp > datetime('now', '-1 hour')
      `).all(userAddress);

      return synchronized.map(row => row.user_address);
    } catch (error) {
      console.error('Error finding synchronized users:', error);
      return [];
    }
  }

  /**
   * Find users with similar engagement patterns
   * @param {string} userAddress - User address
   * @returns {Array} Similar user addresses
   */
  findSimilarEngagementUsers(userAddress) {
    try {
      const similar = this.db.prepare(`
        SELECT DISTINCT ep2.user_address,
               COUNT(*) as common_creators
        FROM engagement_patterns ep1
        JOIN engagement_patterns ep2 ON ep1.creator_address = ep2.creator_address
        WHERE ep1.user_address = ? 
          AND ep2.user_address != ?
          AND ep1.timestamp > datetime('now', '-7 days')
          AND ep2.timestamp > datetime('now', '-7 days')
        GROUP BY ep2.user_address
        HAVING common_creators >= 3
      `).all(userAddress, userAddress);

      return similar.filter(row => 
        row.common_creators / this.getUserCreatorCount(userAddress) > this.config.networkSimilarityThreshold
      ).map(row => row.user_address);
    } catch (error) {
      console.error('Error finding similar engagement users:', error);
      return [];
    }
  }

  /**
   * Detect circular referral patterns
   * @param {string} userAddress - User address
   * @returns {Array} Circular patterns detected
   */
  detectCircularReferralPatterns(userAddress) {
    // Simplified circular pattern detection
    // In a real implementation, this would use graph algorithms
    return [];
  }

  /**
   * Calculate network centrality for a user
   * @param {string} userAddress - User address
   * @returns {number} Centrality score (0-1)
   */
  calculateNetworkCentrality(userAddress) {
    try {
      const connections = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM user_relationships
        WHERE user_a = ? OR user_b = ?
      `).get(userAddress, userAddress)?.count || 0;

      const totalUsers = this.db.prepare(`
        SELECT COUNT(DISTINCT user_address) as count
        FROM user_fingerprints
      `).get()?.count || 1;

      return connections / totalUsers;
    } catch (error) {
      console.error('Error calculating network centrality:', error);
      return 0;
    }
  }

  /**
   * Get creator count for a user
   * @param {string} userAddress - User address
   * @returns {number} Creator count
   */
  getUserCreatorCount(userAddress) {
    try {
      return this.db.prepare(`
        SELECT COUNT(DISTINCT creator_address) as count
        FROM engagement_patterns
        WHERE user_address = ?
      `).get(userAddress)?.count || 0;
    } catch (error) {
      console.error('Error getting user creator count:', error);
      return 0;
    }
  }

  /**
   * Estimate potential manipulation revenue
   * @param {Object} engagementData - Engagement data
   * @returns {number} Estimated revenue
   */
  estimateManipulationRevenue(engagementData) {
    // Simplified revenue estimation
    // In practice, this would use the actual ScaledUserProp algorithm
    const totalEngagement = Object.values(engagementData).reduce((sum, weight) => sum + weight, 0);
    return totalEngagement * 0.01; // $0.01 per engagement unit
  }

  /**
   * Calculate variance of an array of numbers
   * @param {Array} values - Array of numbers
   * @returns {number} Variance
   */
  calculateVariance(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    return squaredDiffs.reduce((sum, diff) => sum + diff, 0) / values.length;
  }

  /**
   * Get system-wide Sybil attack statistics
   * @returns {Object} System statistics
   */
  getSystemStatistics() {
    try {
      const stats = {
        totalUsers: 0,
        suspiciousUsers: 0,
        activeAttacks: 0,
        mitigatedAttacks: 0,
        averageRiskScore: 0,
        highRiskClusters: 0
      };

      // Total users
      stats.totalUsers = this.db.prepare(`
        SELECT COUNT(DISTINCT user_address) as count
        FROM user_fingerprints
      `).get()?.count || 0;

      // Suspicious users
      stats.suspiciousUsers = this.db.prepare(`
        SELECT COUNT(DISTINCT user_address) as count
        FROM user_fingerprints
        WHERE is_suspicious = TRUE
      `).get()?.count || 0;

      // Active attacks
      stats.activeAttacks = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM sybil_detections
        WHERE status = 'active'
      `).get()?.count || 0;

      // Mitigated attacks
      stats.mitigatedAttacks = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM sybil_detections
        WHERE status = 'mitigated'
      `).get()?.count || 0;

      // Average risk score
      const avgRisk = this.db.prepare(`
        SELECT AVG(confidence_score) as avg_score
        FROM sybil_detections
        WHERE detected_at > datetime('now', '-7 days')
      `).get()?.avg_score || 0;
      stats.averageRiskScore = avgRisk;

      return stats;
    } catch (error) {
      console.error('Error getting system statistics:', error);
      return {};
    }
  }

  /**
   * Generate comprehensive Sybil protection report
   * @returns {Object} Protection report
   */
  generateProtectionReport() {
    const stats = this.getSystemStatistics();
    const recentDetections = this.getRecentDetections();
    const topRiskFactors = this.getTopRiskFactors();

    return {
      timestamp: new Date().toISOString(),
      statistics: stats,
      recentDetections,
      topRiskFactors,
      systemHealth: this.assessSystemHealth(stats),
      recommendations: this.generateSystemRecommendations(stats)
    };
  }

  /**
   * Get recent Sybil detections
   * @returns {Array} Recent detections
   */
  getRecentDetections() {
    try {
      return this.db.prepare(`
        SELECT attack_id, attack_type, confidence_score, detected_at, affected_users
        FROM sybil_detections
        WHERE detected_at > datetime('now', '-24 hours')
        ORDER BY detected_at DESC
        LIMIT 10
      `).all();
    } catch (error) {
      console.error('Error getting recent detections:', error);
      return [];
    }
  }

  /**
   * Get top risk factors
   * @returns {Array} Top risk factors
   */
  getTopRiskFactors() {
    // This would analyze recent detections to identify common risk factors
    return [
      { factor: 'high_engagement_intensity', count: 45, percentage: 23 },
      { factor: 'ip_clustering', count: 38, percentage: 19 },
      { factor: 'synchronized_activity', count: 32, percentage: 16 },
      { factor: 'network_centrality', count: 28, percentage: 14 },
      { factor: 'temporal_anomalies', count: 25, percentage: 13 }
    ];
  }

  /**
   * Assess overall system health
   * @param {Object} stats - System statistics
   * @returns {Object} Health assessment
   */
  assessSystemHealth(stats) {
    const healthScore = Math.max(0, 100 - (stats.suspiciousUsers / stats.totalUsers) * 100);
    
    return {
      score: healthScore,
      status: healthScore > 90 ? 'excellent' : healthScore > 70 ? 'good' : 'concerning',
      issues: healthScore < 70 ? ['high_sybil_activity'] : []
    };
  }

  /**
   * Generate system-wide recommendations
   * @param {Object} stats - System statistics
   * @returns {Array} Recommendations
   */
  generateSystemRecommendations(stats) {
    const recommendations = [];

    if (stats.suspiciousUsers / stats.totalUsers > 0.1) {
      recommendations.push({
        type: 'system',
        priority: 'high',
        action: 'enhance_detection_thresholds',
        message: 'High ratio of suspicious users detected'
      });
    }

    if (stats.activeAttacks > 10) {
      recommendations.push({
        type: 'security',
        priority: 'high',
        action: 'implement_additional_safeguards',
        message: 'High number of active Sybil attacks'
      });
    }

    return recommendations;
  }
}

module.exports = {
  SybilAttackProtectionService
};
