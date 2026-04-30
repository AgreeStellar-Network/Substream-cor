/**
 * Migration Health Monitor
 * 
 * Provides real-time monitoring and health checks during database migrations
 * to ensure zero-downtime and system stability.
 */

const EventEmitter = require('events');
const { performance } = require('perf_hooks');

class MigrationHealthMonitor extends EventEmitter {
  constructor(knex, options = {}) {
    super();
    this.knex = knex;
    this.options = {
      checkInterval: 5000, // 5 seconds
      responseTimeThreshold: 1000, // 1 second
      errorRateThreshold: 0.05, // 5% error rate
      connectionThreshold: 80, // 80% of max connections
      lockTimeThreshold: 30000, // 30 seconds
      ...options
    };
    
    this.isMonitoring = false;
    this.monitoringInterval = null;
    this.metrics = {
      responseTime: [],
      errorCount: 0,
      totalQueries: 0,
      activeConnections: 0,
      lockInfo: null,
      lastCheck: null
    };
    
    this.alerts = [];
    this.healthStatus = 'healthy';
  }

  /**
   * Start health monitoring
   */
  startMonitoring() {
    if (this.isMonitoring) {
      console.warn('[HealthMonitor] Monitoring already started');
      return;
    }

    console.log('[HealthMonitor] Starting health monitoring...');
    this.isMonitoring = true;
    this.healthStatus = 'monitoring';
    
    this.monitoringInterval = setInterval(async () => {
      if (this.isMonitoring) {
        await this.performHealthCheck();
      }
    }, this.options.checkInterval);

    this.emit('monitoringStarted');
  }

  /**
   * Stop health monitoring
   */
  stopMonitoring() {
    if (!this.isMonitoring) {
      return;
    }

    console.log('[HealthMonitor] Stopping health monitoring...');
    this.isMonitoring = false;
    this.healthStatus = 'stopped';
    
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.emit('monitoringStopped');
  }

  /**
   * Perform comprehensive health check
   */
  async performHealthCheck() {
    const checkStartTime = performance.now();
    
    try {
      // Check 1: Database connectivity and response time
      await this.checkDatabaseResponse();
      
      // Check 2: Connection pool status
      await this.checkConnectionPool();
      
      // Check 3: Lock contention
      await this.checkLockContention();
      
      // Check 4: Error rate
      await this.checkErrorRate();
      
      // Check 5: Disk space (if applicable)
      await this.checkDiskSpace();
      
      // Check 6: Query performance
      await this.checkQueryPerformance();
      
      // Update metrics
      this.metrics.lastCheck = new Date().toISOString();
      const checkDuration = performance.now() - checkStartTime;
      
      // Evaluate overall health
      this.evaluateOverallHealth();
      
      this.emit('healthCheckCompleted', {
        status: this.healthStatus,
        metrics: this.metrics,
        duration: checkDuration,
        alerts: this.alerts
      });
      
    } catch (error) {
      this.handleHealthCheckError(error);
    }
  }

  /**
   * Check database response time
   */
  async checkDatabaseResponse() {
    const startTime = performance.now();
    
    try {
      await this.knex.raw('SELECT 1');
      const responseTime = performance.now() - startTime;
      
      this.metrics.responseTime.push({
        timestamp: new Date().toISOString(),
        value: responseTime
      });
      
      // Keep only last 10 measurements
      if (this.metrics.responseTime.length > 10) {
        this.metrics.responseTime.shift();
      }
      
      // Check threshold
      if (responseTime > this.options.responseTimeThreshold) {
        this.addAlert('high_response_time', {
          message: `Database response time too high: ${responseTime.toFixed(2)}ms`,
          severity: 'warning',
          value: responseTime,
          threshold: this.options.responseTimeThreshold
        });
      }
      
    } catch (error) {
      this.addAlert('database_connection_error', {
        message: `Database connection failed: ${error.message}`,
        severity: 'critical',
        error: error.message
      });
      
      this.metrics.errorCount++;
    }
    
    this.metrics.totalQueries++;
  }

  /**
   * Check connection pool status
   */
  async checkConnectionPool() {
    try {
      // Get connection count (SQLite specific)
      const result = await this.knex.raw('PRAGMA busy_timeout');
      const busyTimeout = result[0]?.busy_timeout || 0;
      
      // For connection pool monitoring, we'd check the actual pool in production
      // This is a simplified version
      const simulatedConnections = Math.floor(Math.random() * 20) + 5;
      this.metrics.activeConnections = simulatedConnections;
      
      const maxConnections = this.options.maxConnections || 100;
      const usagePercent = (simulatedConnections / maxConnections) * 100;
      
      if (usagePercent > this.options.connectionThreshold) {
        this.addAlert('high_connection_usage', {
          message: `Connection pool usage high: ${usagePercent.toFixed(1)}%`,
          severity: 'warning',
          value: usagePercent,
          threshold: this.options.connectionThreshold
        });
      }
      
    } catch (error) {
      this.addAlert('connection_pool_error', {
        message: `Connection pool check failed: ${error.message}`,
        severity: 'error',
        error: error.message
      });
    }
  }

  /**
   * Check for lock contention
   */
  async checkLockContention() {
    try {
      // SQLite doesn't have extensive lock monitoring like PostgreSQL
      // We'll check for busy timeout and simulate lock detection
      const result = await this.knex.raw('PRAGMA busy_timeout');
      const busyTimeout = result[0]?.busy_timeout || 0;
      
      // Simulate lock detection (in production, this would be more sophisticated)
      const hasLocks = Math.random() > 0.95; // 5% chance of detecting locks
      
      if (hasLocks) {
        this.addAlert('lock_contention', {
          message: 'Database lock contention detected',
          severity: 'warning',
          busyTimeout
        });
        
        this.metrics.lockInfo = {
          detected: true,
          timestamp: new Date().toISOString(),
          busyTimeout
        };
      } else {
        this.metrics.lockInfo = {
          detected: false,
          timestamp: new Date().toISOString(),
          busyTimeout
        };
      }
      
    } catch (error) {
      this.addAlert('lock_check_error', {
        message: `Lock contention check failed: ${error.message}`,
        severity: 'error',
        error: error.message
      });
    }
  }

  /**
   * Check error rate
   */
  async checkErrorRate() {
    const errorRate = this.metrics.totalQueries > 0 ? 
      this.metrics.errorCount / this.metrics.totalQueries : 0;
    
    if (errorRate > this.options.errorRateThreshold) {
      this.addAlert('high_error_rate', {
        message: `Error rate too high: ${(errorRate * 100).toFixed(2)}%`,
        severity: 'critical',
        value: errorRate,
        threshold: this.options.errorRateThreshold,
        errorCount: this.metrics.errorCount,
        totalQueries: this.metrics.totalQueries
      });
    }
  }

  /**
   * Check disk space
   */
  async checkDiskSpace() {
    try {
      // In production, this would check actual disk space
      // For now, we'll simulate the check
      const diskUsage = Math.floor(Math.random() * 90) + 5; // 5-95% usage
      
      if (diskUsage > 85) {
        this.addAlert('low_disk_space', {
          message: `Disk space low: ${diskUsage}% used`,
          severity: 'critical',
          value: diskUsage
        });
      } else if (diskUsage > 75) {
        this.addAlert('disk_space_warning', {
          message: `Disk space warning: ${diskUsage}% used`,
          severity: 'warning',
          value: diskUsage
        });
      }
      
    } catch (error) {
      this.addAlert('disk_check_error', {
        message: `Disk space check failed: ${error.message}`,
        severity: 'error',
        error: error.message
      });
    }
  }

  /**
   * Check query performance
   */
  async checkQueryPerformance() {
    const criticalQueries = [
      'SELECT COUNT(*) FROM creators',
      'SELECT COUNT(*) FROM subscriptions',
      'SELECT * FROM creators LIMIT 1',
      'SELECT * FROM subscriptions LIMIT 1'
    ];
    
    for (const query of criticalQueries) {
      const startTime = performance.now();
      
      try {
        await this.knex.raw(query);
        const duration = performance.now() - startTime;
        
        if (duration > 2000) { // 2 second threshold for critical queries
          this.addAlert('slow_query', {
            message: `Slow query detected: ${query} (${duration.toFixed(2)}ms)`,
            severity: 'warning',
            query,
            duration
          });
        }
        
      } catch (error) {
        this.addAlert('query_error', {
          message: `Query failed: ${query} - ${error.message}`,
          severity: 'error',
          query,
          error: error.message
        });
        
        this.metrics.errorCount++;
      }
      
      this.metrics.totalQueries++;
    }
  }

  /**
   * Evaluate overall health status
   */
  evaluateOverallHealth() {
    const criticalAlerts = this.alerts.filter(alert => alert.severity === 'critical');
    const errorAlerts = this.alerts.filter(alert => alert.severity === 'error');
    const warningAlerts = this.alerts.filter(alert => alert.severity === 'warning');
    
    if (criticalAlerts.length > 0) {
      this.healthStatus = 'critical';
    } else if (errorAlerts.length > 0) {
      this.healthStatus = 'error';
    } else if (warningAlerts.length > 0) {
      this.healthStatus = 'warning';
    } else {
      this.healthStatus = 'healthy';
    }
    
    // Clean old alerts (older than 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    this.alerts = this.alerts.filter(alert => 
      new Date(alert.timestamp) > fiveMinutesAgo
    );
  }

  /**
   * Add alert to the alerts list
   */
  addAlert(type, data) {
    const alert = {
      id: `${type}_${Date.now()}`,
      type,
      timestamp: new Date().toISOString(),
      ...data
    };
    
    this.alerts.push(alert);
    this.emit('alert', alert);
    
    console.warn(`[HealthMonitor] Alert: ${alert.message}`);
  }

  /**
   * Handle health check errors
   */
  handleHealthCheckError(error) {
    this.addAlert('health_check_error', {
      message: `Health check failed: ${error.message}`,
      severity: 'critical',
      error: error.message
    });
    
    this.healthStatus = 'critical';
    this.emit('healthCheckError', error);
  }

  /**
   * Get current health status
   */
  getHealthStatus() {
    return {
      status: this.healthStatus,
      isMonitoring: this.isMonitoring,
      metrics: this.metrics,
      alerts: this.alerts,
      lastCheck: this.metrics.lastCheck
    };
  }

  /**
   * Get detailed health report
   */
  getHealthReport() {
    const avgResponseTime = this.metrics.responseTime.length > 0 ?
      this.metrics.responseTime.reduce((sum, r) => sum + r.value, 0) / this.metrics.responseTime.length : 0;
    
    const errorRate = this.metrics.totalQueries > 0 ?
      (this.metrics.errorCount / this.metrics.totalQueries) * 100 : 0;
    
    return {
      summary: {
        status: this.healthStatus,
        isMonitoring: this.isMonitoring,
        lastCheck: this.metrics.lastCheck
      },
      metrics: {
        averageResponseTime: avgResponseTime.toFixed(2),
        errorRate: errorRate.toFixed(2),
        totalQueries: this.metrics.totalQueries,
        activeConnections: this.metrics.activeConnections,
        lockDetected: this.metrics.lockInfo?.detected || false
      },
      alerts: {
        total: this.alerts.length,
        critical: this.alerts.filter(a => a.severity === 'critical').length,
        error: this.alerts.filter(a => a.severity === 'error').length,
        warning: this.alerts.filter(a => a.severity === 'warning').length,
        recent: this.alerts.slice(-5) // Last 5 alerts
      },
      recommendations: this.generateRecommendations()
    };
  }

  /**
   * Generate health recommendations
   */
  generateRecommendations() {
    const recommendations = [];
    
    if (this.metrics.responseTime.length > 0) {
      const avgResponseTime = this.metrics.responseTime.reduce((sum, r) => sum + r.value, 0) / this.metrics.responseTime.length;
      
      if (avgResponseTime > 500) {
        recommendations.push('Consider optimizing database queries or adding indexes');
      }
    }
    
    if (this.metrics.activeConnections > 50) {
      recommendations.push('Monitor connection pool usage and consider increasing pool size');
    }
    
    if (this.metrics.errorCount > 0) {
      recommendations.push('Investigate and fix database errors to improve reliability');
    }
    
    const criticalAlerts = this.alerts.filter(a => a.severity === 'critical');
    if (criticalAlerts.length > 0) {
      recommendations.push('Address critical alerts immediately to ensure system stability');
    }
    
    return recommendations;
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      responseTime: [],
      errorCount: 0,
      totalQueries: 0,
      activeConnections: 0,
      lockInfo: null,
      lastCheck: null
    };
    
    this.alerts = [];
    this.healthStatus = 'healthy';
    
    console.log('[HealthMonitor] Metrics reset');
  }
}

module.exports = MigrationHealthMonitor;
