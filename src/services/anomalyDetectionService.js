const EventEmitter = require('events');

/**
 * Anomaly Detection Service
 * Detects sudden spikes in subscription cancellations and payment failures
 */
class AnomalyDetectionService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration
    this.windowSize = options.windowSize || 60 * 60 * 1000; // 1 hour window in milliseconds
    this.baselineMultiplier = options.baselineMultiplier || 3; // 3x baseline triggers alert
    this.minBaselineSamples = options.minBaselineSamples || 10; // Minimum samples for baseline
    this.alertCooldown = options.alertCooldown || 30 * 60 * 1000; // 30 minutes between alerts
    
    // Data storage
    this.subscriptionEvents = [];
    this.paymentFailureEvents = [];
    this.lastAlerts = {
      subscriptionCancellation: 0,
      paymentFailure: 0
    };
    
    // Baseline metrics
    this.baselines = {
      subscriptionCancellations: { count: 0, rate: 0, lastUpdated: 0 },
      paymentFailures: { count: 0, rate: 0, lastUpdated: 0 }
    };
    
    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * Record a subscription event
   * @param {Object} event - { type: 'cancelled' | 'expired' | 'subscribed', creatorId: string, timestamp?: Date }
   */
  recordSubscriptionEvent(event) {
    const timestamp = event.timestamp || new Date();
    const eventRecord = {
      ...event,
      timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp),
      recordedAt: new Date()
    };

    this.subscriptionEvents.push(eventRecord);
    
    // Check for anomalies if it's a cancellation or expiration
    if (event.type === 'cancelled' || event.type === 'expired') {
      this.checkSubscriptionAnomaly();
    }
    
    // Update baseline periodically
    this.updateSubscriptionBaseline();
    
    this.emit('subscriptionEvent', eventRecord);
  }

  /**
   * Record a payment failure event
   * @param {Object} event - { type: 'payment_failed', creatorId: string, amount?: number, reason?: string, timestamp?: Date }
   */
  recordPaymentFailure(event) {
    const timestamp = event.timestamp || new Date();
    const eventRecord = {
      ...event,
      timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp),
      recordedAt: new Date()
    };

    this.paymentFailureEvents.push(eventRecord);
    
    // Check for anomalies
    this.checkPaymentFailureAnomaly();
    
    // Update baseline periodically
    this.updatePaymentFailureBaseline();
    
    this.emit('paymentFailure', eventRecord);
  }

  /**
   * Check for subscription cancellation anomalies
   */
  checkSubscriptionAnomaly() {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.windowSize);
    
    // Count cancellations in the current window
    const recentCancellations = this.subscriptionEvents.filter(event => 
      (event.type === 'cancelled' || event.type === 'expired') &&
      event.timestamp >= windowStart
    );
    
    const currentCount = recentCancellations.length;
    const currentRate = currentCount / (this.windowSize / (60 * 1000)); // per minute
    
    // Get baseline
    const baseline = this.baselines.subscriptionCancellations;
    
    // Check if we have enough baseline data
    if (baseline.rate > 0 && this.subscriptionEvents.length >= this.minBaselineSamples) {
      const threshold = baseline.rate * this.baselineMultiplier;
      
      if (currentRate > threshold) {
        const timeSinceLastAlert = now.getTime() - this.lastAlerts.subscriptionCancellation;
        
        if (timeSinceLastAlert >= this.alertCooldown) {
          this.triggerAlert('subscriptionCancellation', {
            currentCount,
            currentRate: currentRate.toFixed(2),
            baselineRate: baseline.rate.toFixed(2),
            threshold: threshold.toFixed(2),
            multiplier: (currentRate / baseline.rate).toFixed(2),
            windowSize: this.windowSize / (60 * 1000), // in minutes
            events: recentCancellations.slice(-10) // last 10 events
          });
          
          this.lastAlerts.subscriptionCancellation = now.getTime();
        }
      }
    }
    
    return {
      currentCount,
      currentRate,
      baselineRate: baseline.rate,
      isAnomalous: baseline.rate > 0 && currentRate > (baseline.rate * this.baselineMultiplier)
    };
  }

  /**
   * Check for payment failure anomalies
   */
  checkPaymentFailureAnomaly() {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.windowSize);
    
    // Count payment failures in the current window
    const recentFailures = this.paymentFailureEvents.filter(event => 
      event.timestamp >= windowStart
    );
    
    const currentCount = recentFailures.length;
    const currentRate = currentCount / (this.windowSize / (60 * 1000)); // per minute
    
    // Get baseline
    const baseline = this.baselines.paymentFailures;
    
    // Check if we have enough baseline data
    if (baseline.rate > 0 && this.paymentFailureEvents.length >= this.minBaselineSamples) {
      const threshold = baseline.rate * this.baselineMultiplier;
      
      if (currentRate > threshold) {
        const timeSinceLastAlert = now.getTime() - this.lastAlerts.paymentFailure;
        
        if (timeSinceLastAlert >= this.alertCooldown) {
          this.triggerAlert('paymentFailure', {
            currentCount,
            currentRate: currentRate.toFixed(2),
            baselineRate: baseline.rate.toFixed(2),
            threshold: threshold.toFixed(2),
            multiplier: (currentRate / baseline.rate).toFixed(2),
            windowSize: this.windowSize / (60 * 1000), // in minutes
            events: recentFailures.slice(-10) // last 10 events
          });
          
          this.lastAlerts.paymentFailure = now.getTime();
        }
      }
    }
    
    return {
      currentCount,
      currentRate,
      baselineRate: baseline.rate,
      isAnomalous: baseline.rate > 0 && currentRate > (baseline.rate * this.baselineMultiplier)
    };
  }

  /**
   * Update subscription cancellation baseline
   */
  updateSubscriptionBaseline() {
    const now = new Date();
    const timeSinceLastUpdate = now.getTime() - this.baselines.subscriptionCancellations.lastUpdated;
    
    // Update baseline every 10 minutes
    if (timeSinceLastUpdate >= 10 * 60 * 1000) {
      const baselineWindow = new Date(now.getTime() - (24 * 60 * 60 * 1000)); // 24 hours
      
      const baselineEvents = this.subscriptionEvents.filter(event => 
        (event.type === 'cancelled' || event.type === 'expired') &&
        event.timestamp >= baselineWindow
      );
      
      const baselineCount = baselineEvents.length;
      const baselineRate = baselineCount / (24 * 60); // per minute over 24 hours
      
      this.baselines.subscriptionCancellations = {
        count: baselineCount,
        rate: baselineRate,
        lastUpdated: now.getTime()
      };
    }
  }

  /**
   * Update payment failure baseline
   */
  updatePaymentFailureBaseline() {
    const now = new Date();
    const timeSinceLastUpdate = now.getTime() - this.baselines.paymentFailures.lastUpdated;
    
    // Update baseline every 10 minutes
    if (timeSinceLastUpdate >= 10 * 60 * 1000) {
      const baselineWindow = new Date(now.getTime() - (24 * 60 * 60 * 1000)); // 24 hours
      
      const baselineEvents = this.paymentFailureEvents.filter(event => 
        event.timestamp >= baselineWindow
      );
      
      const baselineCount = baselineEvents.length;
      const baselineRate = baselineCount / (24 * 60); // per minute over 24 hours
      
      this.baselines.paymentFailures = {
        count: baselineCount,
        rate: baselineRate,
        lastUpdated: now.getTime()
      };
    }
  }

  /**
   * Trigger an anomaly alert
   */
  triggerAlert(type, data) {
    const alert = {
      id: this.generateAlertId(),
      type,
      severity: 'high',
      timestamp: new Date(),
      data,
      message: this.generateAlertMessage(type, data)
    };
    
    console.warn(`[AnomalyDetection] ${type.toUpperCase()} ANOMALY DETECTED:`, alert);
    
    this.emit('anomaly', alert);
    this.emit(`anomaly:${type}`, alert);
  }

  /**
   * Generate alert message
   */
  generateAlertMessage(type, data) {
    switch (type) {
      case 'subscriptionCancellation':
        return `Subscription cancellation spike detected: ${data.currentRate} cancellations/minute (${data.multiplier}x baseline rate of ${data.baselineRate}/minute)`;
      
      case 'paymentFailure':
        return `Payment failure spike detected: ${data.currentRate} failures/minute (${data.multiplier}x baseline rate of ${data.baselineRate}/minute)`;
      
      default:
        return `Anomaly detected in ${type}: Current rate ${data.currentRate} exceeds baseline ${data.baselineRate}`;
    }
  }

  /**
   * Generate unique alert ID
   */
  generateAlertId() {
    return `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Start periodic cleanup of old events
   */
  startCleanup() {
    setInterval(() => {
      this.cleanup();
    }, 60 * 60 * 1000); // Clean up every hour
  }

  /**
   * Clean up old events to prevent memory leaks
   */
  cleanup() {
    const cutoff = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)); // Keep 7 days of data
    
    this.subscriptionEvents = this.subscriptionEvents.filter(event => 
      event.timestamp >= cutoff
    );
    
    this.paymentFailureEvents = this.paymentFailureEvents.filter(event => 
      event.timestamp >= cutoff
    );
    
    console.log(`[AnomalyDetection] Cleanup completed. Retaining ${this.subscriptionEvents.length} subscription events and ${this.paymentFailureEvents.length} payment failure events`);
  }

  /**
   * Get current statistics
   */
  getStatistics() {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.windowSize);
    
    const recentCancellations = this.subscriptionEvents.filter(event => 
      (event.type === 'cancelled' || event.type === 'expired') &&
      event.timestamp >= windowStart
    );
    
    const recentFailures = this.paymentFailureEvents.filter(event => 
      event.timestamp >= windowStart
    );
    
    return {
      subscriptionCancellations: {
        currentWindow: recentCancellations.length,
        currentRate: (recentCancellations.length / (this.windowSize / (60 * 1000))).toFixed(2),
        baselineRate: this.baselines.subscriptionCancellations.rate.toFixed(2),
        totalEvents: this.subscriptionEvents.length
      },
      paymentFailures: {
        currentWindow: recentFailures.length,
        currentRate: (recentFailures.length / (this.windowSize / (60 * 1000))).toFixed(2),
        baselineRate: this.baselines.paymentFailures.rate.toFixed(2),
        totalEvents: this.paymentFailureEvents.length
      },
      lastAlerts: {
        subscriptionCancellation: new Date(this.lastAlerts.subscriptionCancellation),
        paymentFailure: new Date(this.lastAlerts.paymentFailure)
      },
      configuration: {
        windowSize: this.windowSize / (60 * 1000), // in minutes
        baselineMultiplier: this.baselineMultiplier,
        alertCooldown: this.alertCooldown / (60 * 1000) // in minutes
      }
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    Object.assign(this, newConfig);
  }

  /**
   * Reset all data and baselines
   */
  reset() {
    this.subscriptionEvents = [];
    this.paymentFailureEvents = [];
    this.lastAlerts = {
      subscriptionCancellation: 0,
      paymentFailure: 0
    };
    this.baselines = {
      subscriptionCancellations: { count: 0, rate: 0, lastUpdated: 0 },
      paymentFailures: { count: 0, rate: 0, lastUpdated: 0 }
    };
    
    console.log('[AnomalyDetection] Service reset completed');
  }
}

module.exports = { AnomalyDetectionService };
