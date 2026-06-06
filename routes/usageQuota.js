const express = require('express');
const router = express.Router();
const usageQuotaService = require('../src/services/usageQuota');
const billingService = require('../src/services/billingService');
const usageTracking = require('../src/middleware/usageTracking');

// Apply usage tracking middleware to all routes
router.use(usageTracking.usageTracker);

// Get API status and usage information
router.get('/status', (req, res) => {
  res.json({
    status: 'operational',
    timestamp: new Date().toISOString(),
    usage: req.usageInfo,
    message: 'AgreeStellar API is running normally',
  });
});

// Get usage analytics for developer
router.get('/analytics', async (req, res) => {
  try {
    const stats = await usageQuotaService.getUsageStats(req.usageInfo.apiKeyId);
    
    if (!stats) {
      return res.status(404).json({
        error: 'Analytics not available',
        message: 'Usage statistics could not be retrieved',
      });
    }
    
    res.json({
      developer_id: req.usageInfo.developerId,
      tier: stats.tier,
      usage: stats,
      billing_status: await billingService.getBillingStatus(req.usageInfo.developerId),
      upgrade_url: billingService.generateUpgradeUrl(req.usageInfo.developerId, 'premium'),
    });
  } catch (error) {
    console.error('Analytics endpoint error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve analytics data',
    });
  }
});

// Sample data endpoint for AgreeStellar
router.get('/data', (req, res) => {
  // Simulate AgreeStellar data access
  res.json({
    protocol: 'SubStream',
    data: {
      latest_block: 12345,
      network_status: 'active',
      transactions_pending: 42,
      gas_price: '0.000001 ETH',
    },
    request_info: {
      tier: req.usageInfo.tier,
      api_key_id: req.usageInfo.apiKeyId,
    },
  });
});

// Transaction submission endpoint
router.post('/transactions', (req, res) => {
  const { transaction } = req.body;
  
  if (!transaction) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'Transaction data is required',
    });
  }
  
  // Simulate transaction processing
  res.json({
    success: true,
    transaction_id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    status: 'submitted',
    message: 'Transaction submitted to AgreeStellar',
  });
});

// Billing webhook endpoint (no API key required for webhooks)
router.post('/billing/webhook', async (req, res) => {
  try {
    const signature = req.get('X-Webhook-Signature');
    const eventType = req.get('X-Event-Type');
    
    if (!signature || !eventType) {
      return res.status(400).json({
        error: 'Invalid webhook',
        message: 'Missing required webhook headers',
      });
    }
    
    await billingService.handleBillingWebhook(eventType, req.body, signature);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Billing webhook error:', error);
    res.status(400).json({
      error: 'Webhook processing failed',
      message: error.message,
    });
  }
});

// On-chain payment verification endpoint
router.post('/billing/verify-payment', async (req, res) => {
  try {
    const { transaction_hash, expected_amount } = req.body;
    
    if (!transaction_hash || !expected_amount) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Transaction hash and expected amount are required',
      });
    }
    
    const result = await billingService.verifyOnChainPayment(
      transaction_hash,
      expected_amount,
      req.usageInfo.developerId
    );
    
    res.json(result);
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(400).json({
      error: 'Payment verification failed',
      message: error.message,
    });
  }
});

module.exports = router;
