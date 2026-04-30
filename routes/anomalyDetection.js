const express = require('express');
const router = express.Router();

/**
 * Anomaly Detection Monitoring Routes
 * Provides endpoints for monitoring and managing anomaly detection
 */

// GET /api/anomaly/statistics - Get current anomaly detection statistics
router.get('/statistics', async (req, res) => {
  try {
    const app = req.app;
    const subscriptionService = app.get('subscriptionService');

    if (!subscriptionService || !subscriptionService.getAnomalyStatistics) {
      return res.status(503).json({ 
        success: false, 
        error: 'Anomaly detection service not configured' 
      });
    }

    const statistics = subscriptionService.getAnomalyStatistics();
    
    res.json({
      success: true,
      data: statistics,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[AnomalyDetection] Failed to get statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve anomaly detection statistics'
    });
  }
});

// POST /api/anomaly/payment-failure - Record a payment failure event
router.post('/payment-failure', async (req, res) => {
  try {
    const app = req.app;
    const subscriptionService = app.get('subscriptionService');

    if (!subscriptionService || !subscriptionService.recordPaymentFailure) {
      return res.status(503).json({ 
        success: false, 
        error: 'Anomaly detection service not configured' 
      });
    }

    const { creatorId, amount, reason, timestamp } = req.body;

    if (!creatorId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required field: creatorId' 
      });
    }

    subscriptionService.recordPaymentFailure({
      creatorId,
      amount,
      reason,
      timestamp: timestamp ? new Date(timestamp) : new Date()
    });

    res.json({
      success: true,
      message: 'Payment failure recorded for anomaly detection',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[AnomalyDetection] Failed to record payment failure:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to record payment failure'
    });
  }
});

// PUT /api/anomaly/config - Update anomaly detection configuration
router.put('/config', async (req, res) => {
  try {
    const app = req.app;
    const subscriptionService = app.get('subscriptionService');

    if (!subscriptionService || !subscriptionService.updateAnomalyDetectionConfig) {
      return res.status(503).json({ 
        success: false, 
        error: 'Anomaly detection service not configured' 
      });
    }

    const config = req.body;

    // Validate configuration
    if (config.windowSize && (typeof config.windowSize !== 'number' || config.windowSize <= 0)) {
      return res.status(400).json({ 
        success: false, 
        error: 'windowSize must be a positive number' 
      });
    }

    if (config.baselineMultiplier && (typeof config.baselineMultiplier !== 'number' || config.baselineMultiplier <= 1)) {
      return res.status(400).json({ 
        success: false, 
        error: 'baselineMultiplier must be a number greater than 1' 
      });
    }

    subscriptionService.updateAnomalyDetectionConfig(config);

    res.json({
      success: true,
      message: 'Anomaly detection configuration updated',
      config,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[AnomalyDetection] Failed to update configuration:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update anomaly detection configuration'
    });
  }
});

// GET /api/anomaly/health - Health check for anomaly detection service
router.get('/health', async (req, res) => {
  try {
    const app = req.app;
    const subscriptionService = app.get('subscriptionService');

    if (!subscriptionService || !subscriptionService.getAnomalyStatistics) {
      return res.status(503).json({ 
        success: false, 
        status: 'unhealthy',
        error: 'Anomaly detection service not configured' 
      });
    }

    const statistics = subscriptionService.getAnomalyStatistics();
    
    // Check if the service is processing events
    const isProcessingEvents = statistics.subscriptionCancellations.totalEvents > 0 || 
                               statistics.paymentFailures.totalEvents > 0;

    const health = {
      status: 'healthy',
      service: 'anomaly-detection',
      timestamp: new Date().toISOString(),
      metrics: {
        totalSubscriptionEvents: statistics.subscriptionCancellations.totalEvents,
        totalPaymentFailureEvents: statistics.paymentFailures.totalEvents,
        isProcessingEvents,
        lastAlerts: statistics.lastAlerts
      }
    };

    res.json(health);
  } catch (error) {
    console.error('[AnomalyDetection] Health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      service: 'anomaly-detection',
      error: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// POST /api/anomaly/test - Test anomaly detection with simulated data
router.post('/test', async (req, res) => {
  try {
    const app = req.app;
    const subscriptionService = app.get('subscriptionService');

    if (!subscriptionService) {
      return res.status(503).json({ 
        success: false, 
        error: 'Anomaly detection service not configured' 
      });
    }

    const { testType, count = 10, creatorId = 'test-creator' } = req.body;

    if (!testType || !['subscription_cancellation', 'payment_failure'].includes(testType)) {
      return res.status(400).json({ 
        success: false, 
        error: 'testType must be either "subscription_cancellation" or "payment_failure"' 
      });
    }

    // Generate test events
    const events = [];
    const now = new Date();
    
    for (let i = 0; i < count; i++) {
      const timestamp = new Date(now.getTime() - (i * 60000)); // Spread events over time
      
      if (testType === 'subscription_cancellation') {
        subscriptionService.anomalyDetectionService.recordSubscriptionEvent({
          type: 'cancelled',
          creatorId: `${creatorId}-${i}`,
          timestamp
        });
        events.push({ type: 'cancelled', creatorId: `${creatorId}-${i}`, timestamp });
      } else {
        subscriptionService.recordPaymentFailure({
          creatorId: `${creatorId}-${i}`,
          amount: Math.random() * 100,
          reason: 'Test payment failure',
          timestamp
        });
        events.push({ type: 'payment_failed', creatorId: `${creatorId}-${i}`, timestamp });
      }
    }

    res.json({
      success: true,
      message: `Generated ${count} test ${testType} events`,
      events: events.slice(0, 5), // Return first 5 events for reference
      totalEvents: events.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[AnomalyDetection] Test failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate test events'
    });
  }
});

module.exports = router;
