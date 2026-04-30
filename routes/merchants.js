const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken, getUserId } = require('../middleware/unifiedAuth');
const StripeMigrationService = require('../services/stripeMigrationService');
const treasuryService = require('../services/treasuryService');
const { EnhancedChurnRiskService } = require('../services/enhancedChurnRiskService');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const uploadDir = path.join(process.cwd(), 'uploads', 'stripe-exports');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const filename = `stripe-export-${timestamp}-${file.originalname}`;
      cb(null, filename);
    }
  }),
  fileFilter: (req, file, cb) => {
    // Only accept CSV files
    if (file.mimetype === 'text/csv' || 
        file.mimetype === 'application/csv' || 
        path.extname(file.originalname).toLowerCase() === '.csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
    files: 1
  }
});

/**
 * POST /api/v1/merchants/import/stripe
 * Import Stripe customer data and generate migration links
 */
router.post('/import/stripe', authenticateToken, upload.single('csvFile'), async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { planMappings } = req.body;

    // Validate inputs
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'CSV file is required'
      });
    }

    if (!planMappings) {
      return res.status(400).json({
        success: false,
        error: 'Plan mappings are required'
      });
    }

    // Parse plan mappings
    let parsedMappings;
    try {
      parsedMappings = typeof planMappings === 'string' 
        ? JSON.parse(planMappings) 
        : planMappings;
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid plan mappings format. Expected JSON object.'
      });
    }

    // Validate plan mappings structure
    if (typeof parsedMappings !== 'object' || Object.keys(parsedMappings).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Plan mappings must be a non-empty object'
      });
    }

    // Initialize migration service
    const migrationService = new StripeMigrationService(req.app.get('database'));

    // Save plan mappings for future use
    migrationService.savePlanMappings(userId, parsedMappings);

    // Process the CSV file
    const result = await migrationService.processStripeCSV(req.file.path, userId, parsedMappings);

    // Clean up uploaded file
    try {
      fs.unlinkSync(req.file.path);
    } catch (error) {
      console.warn('Failed to clean up uploaded file:', error);
    }

    res.json({
      success: true,
      data: {
        jobId: result.jobId,
        summary: {
          total: result.results.total,
          processed: result.results.processed,
          failed: result.results.failed
        },
        message: 'Stripe import processed successfully'
      }
    });

  } catch (error) {
    console.error('Stripe import error:', error);

    // Clean up uploaded file on error
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.warn('Failed to clean up uploaded file:', cleanupError);
      }
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process Stripe import'
    });
  }
});

/**
 * GET /api/v1/merchants/migration/:jobId/status
 * Get migration job status and results
 */
router.get('/migration/:jobId/status', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { jobId } = req.params;

    const migrationService = new StripeMigrationService(req.app.get('database'));
    const jobStatus = migrationService.getMigrationJobStatus(jobId);

    // Verify that the job belongs to the requesting merchant
    if (jobStatus.merchant_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied: Migration job not found'
      });
    }

    res.json({
      success: true,
      data: {
        jobId: jobStatus.id,
        status: jobStatus.status,
        totalRecords: jobStatus.total_records,
        processedRecords: jobStatus.processed_records,
        failedRecords: jobStatus.failed_records,
        createdAt: jobStatus.created_at,
        completedAt: jobStatus.completed_at,
        errorMessage: jobStatus.error_message,
        planMappings: jobStatus.stripePlanMappings,
        records: jobStatus.records.map(record => ({
          id: record.id,
          customerEmail: record.customer_email,
          stripePlanId: record.stripe_plan_id,
          substreamPlanId: record.substream_plan_id,
          renewalDate: record.renewal_date,
          status: record.status,
          migrationLink: record.migration_link,
          linkedAt: record.linked_at,
          errorMessage: record.error_message,
          createdAt: record.created_at
        }))
      }
    });

  } catch (error) {
    console.error('Migration status error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get migration status'
    });
  }
});

/**
 * GET /api/v1/merchants/migration/verify
 * Verify migration link signature
 */
router.get('/migration/verify', async (req, res) => {
  try {
    const { record, email, ts, sig } = req.query;

    if (!record || !email || !ts || !sig) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: record, email, ts, sig'
      });
    }

    const migrationService = new StripeMigrationService(req.app.get('database'));
    const isValid = migrationService.verifyMigrationLink(record, email, ts, sig);

    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired migration link'
      });
    }

    // Get migration record details
    const recordData = migrationService.database.db.prepare(`
      SELECT * FROM migration_records WHERE id = ? AND status = 'pending'
    `).get(record);

    if (!recordData) {
      return res.status(404).json({
        success: false,
        error: 'Migration record not found or already processed'
      });
    }

    res.json({
      success: true,
      data: {
        recordId: recordData.id,
        customerEmail: recordData.customer_email,
        stripePlanId: recordData.stripe_plan_id,
        substreamPlanId: recordData.substream_plan_id,
        renewalDate: recordData.renewal_date,
        message: 'Migration link verified successfully'
      }
    });

  } catch (error) {
    console.error('Migration verification error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to verify migration link'
    });
  }
});

/**
 * POST /api/v1/merchants/migration/complete
 * Complete migration by linking wallet
 */
router.post('/migration/complete', async (req, res) => {
  try {
    const { recordId, stellarPublicKey, signature } = req.body;

    if (!recordId || !stellarPublicKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: recordId, stellarPublicKey'
      });
    }

    // Validate Stellar public key format
    try {
      const { StellarSdk } = require('@stellar/stellar-sdk');
      StellarSdk.Keypair.fromPublicKey(stellarPublicKey);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Stellar public key format'
      });
    }

    const migrationService = new StripeMigrationService(req.app.get('database'));
    const result = await migrationService.completeMigration(recordId, stellarPublicKey);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Migration completion error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to complete migration'
    });
  }
});

/**
 * GET /api/v1/merchants/plan-mappings
 * Get merchant's plan mappings
 */
router.get('/plan-mappings', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const migrationService = new StripeMigrationService(req.app.get('database'));
    const mappings = migrationService.getPlanMappings(userId);

    res.json({
      success: true,
      data: mappings
    });

  } catch (error) {
    console.error('Get plan mappings error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get plan mappings'
    });
  }
});

/**
 * POST /api/v1/merchants/plan-mappings
 * Save merchant's plan mappings
 */
router.post('/plan-mappings', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { mappings } = req.body;

    if (!mappings || typeof mappings !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Plan mappings are required and must be an object'
      });
    }

    const migrationService = new StripeMigrationService(req.app.get('database'));
    migrationService.savePlanMappings(userId, mappings);

    res.json({
      success: true,
      message: 'Plan mappings saved successfully'
    });

  } catch (error) {
    console.error('Save plan mappings error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to save plan mappings'
    });
  }
});

/**
 * GET /api/v1/merchants/migration-jobs
 * List all migration jobs for the merchant
 */
router.get('/migration-jobs', authenticateToken, async (req, res) => {
  try {
    const userId = getUserId(req.user);
    const { status, limit = 10, offset = 0 } = req.query;

    let query = `
      SELECT id, status, total_records, processed_records, failed_records, 
             created_at, completed_at, error_message
      FROM migration_jobs 
      WHERE merchant_id = ?
    `;
    const params = [userId];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const jobs = req.app.get('database').db.prepare(query).all(...params);

    res.json({
      success: true,
      data: jobs
    });

  } catch (error) {
    console.error('List migration jobs error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list migration jobs'
    });
  }
});

/**
 * GET /api/v1/merchants/:id/treasury/consolidated
 * Get consolidated treasury view for a merchant
 */
router.get('/:id/treasury/consolidated', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = getUserId(req.user);

    // For now, allow access to any merchant ID (in production, add proper authorization)
    const consolidatedTreasury = await treasuryService.getConsolidatedTreasury(id);
    
    if (!consolidatedTreasury) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Merchant not found or no treasury data available for merchant ID: ${id}`,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      data: consolidatedTreasury,
      timestamp: new Date().toISOString(),
      message: 'Consolidated treasury retrieved successfully'
    });
  } catch (error) {
    console.error('Error in consolidated treasury endpoint', { merchantId: req.params.id, error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve consolidated treasury data',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/v1/merchants/:id/treasury/history
 * Get treasury history for a merchant
 */
router.get('/:id/treasury/history', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { days = '30' } = req.query;
    
    const history = await treasuryService.getTreasuryHistory(id, parseInt(days));
    
    res.json({
      success: true,
      data: {
        merchantId: id,
        history,
        period: `${days} days`
      },
      timestamp: new Date().toISOString(),
      message: 'Treasury history retrieved successfully'
    });
  } catch (error) {
    console.error('Error in treasury history endpoint', { merchantId: req.params.id, error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve treasury history',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/v1/merchants/:id/risk-analysis
 * Get churn risk analysis for a merchant's subscribers
 */
router.get('/:id/risk-analysis', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      riskLevel = null, 
      limit = 100, 
      offset = 0, 
      includeFactors = 'true',
      triggerAnalysis = 'false'
    } = req.query;
    
    // Initialize the enhanced churn risk service
    const churnRiskService = new EnhancedChurnRiskService();
    
    // Trigger real-time analysis if requested
    if (triggerAnalysis === 'true') {
      console.log(`Triggering real-time churn risk analysis for merchant ${id}`);
      await churnRiskService.analyzeMerchantChurnRisk(id);
    }
    
    // Get risk analysis data
    const options = {
      riskLevel,
      limit: parseInt(limit),
      offset: parseInt(offset),
      includeFactors: includeFactors === 'true'
    };
    
    const riskAnalysis = await churnRiskService.getMerchantRiskAnalysis(id, options);
    
    // Return actionable insights for merchants
    const actionableInsights = generateActionableInsights(riskAnalysis);
    
    res.json({
      success: true,
      data: {
        ...riskAnalysis,
        actionableInsights,
        webhookConfig: {
          highRiskWebhook: `/api/v1/webhooks/merchants/${id}/high-risk-churn`,
          retentionSuggestions: generateRetentionSuggestions(riskAnalysis.summary)
        }
      },
      timestamp: new Date().toISOString(),
      message: 'Risk analysis retrieved successfully'
    });
    
  } catch (error) {
    console.error('Error in risk analysis endpoint', { merchantId: req.params.id, error });
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      message: 'Failed to retrieve risk analysis data',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Generate actionable insights for merchants
 */
function generateActionableInsights(riskAnalysis) {
  const { summary, subscribers } = riskAnalysis;
  const insights = [];
  
  // High-risk insights
  if (summary.highRiskCount > 0) {
    insights.push({
      type: 'high_risk_alert',
      priority: 'critical',
      title: `${summary.highRiskCount} subscribers at high risk of churn`,
      description: 'Immediate action recommended to prevent revenue loss',
      suggestedActions: [
        'Send targeted retention emails with loyalty discounts',
        'Offer temporary payment grace periods',
        'Enable automatic payment retry with higher limits'
      ]
    });
  }
  
  // Just-in-time topup pattern detection
  const justInTimeUsers = subscribers.filter(s => 
    s.justInTimeTopupsCount && s.justInTimeTopupsCount >= 3
  );
  
  if (justInTimeUsers.length > 0) {
    insights.push({
      type: 'just_in_time_pattern',
      priority: 'high',
      title: `${justInTimeUsers.length} subscribers show just-in-time topup patterns`,
      description: 'These users consistently top up right before payment failures',
      suggestedActions: [
        'Proactively offer subscription plan upgrades',
        'Implement automatic balance alerts',
        'Provide flexible payment scheduling options'
      ]
    });
  }
  
  // Balance exhaustion warnings
  const criticalBalanceUsers = subscribers.filter(s => 
    s.daysUntilBalanceExhausted !== null && s.daysUntilBalanceExhausted <= 7
  );
  
  if (criticalBalanceUsers.length > 0) {
    insights.push({
      type: 'balance_exhaustion',
      priority: 'medium',
      title: `${criticalBalanceUsers.length} subscribers may run out of balance within 7 days`,
      description: 'Early intervention can prevent payment failures',
      suggestedActions: [
        'Send low balance notifications',
        'Offer automatic top-up options',
        'Provide temporary credit extensions'
      ]
    });
  }
  
  // Overall risk assessment
  const riskPercentage = (summary.highRiskCount / summary.totalSubscribers) * 100;
  if (riskPercentage > 20) {
    insights.push({
      type: 'overall_risk',
      priority: 'high',
      title: `High overall churn risk: ${riskPercentage.toFixed(1)}% of subscribers`,
      description: 'Consider reviewing your pricing and payment strategies',
      suggestedActions: [
        'Review subscription pricing tiers',
        'Implement proactive retention campaigns',
        'Consider offering annual billing discounts'
      ]
    });
  }
  
  return insights;
}

/**
 * Generate retention suggestions based on risk analysis
 */
function generateRetentionSuggestions(summary) {
  const suggestions = [];
  
  if (summary.highRiskCount > 0) {
    suggestions.push({
      strategy: 'loyalty_discounts',
      description: 'Offer 10-20% discounts for high-risk subscribers',
      expectedImpact: 'Reduce churn by 15-25%',
      implementation: 'Automated email campaigns with discount codes'
    });
  }
  
  if (summary.averageRiskScore > 50) {
    suggestions.push({
      strategy: 'payment_reminders',
      description: 'Send payment reminders 3-5 days before billing',
      expectedImpact: 'Reduce failed payments by 30%',
      implementation: 'Automated SMS and email notifications'
    });
  }
  
  suggestions.push({
    strategy: 'flexible_billing',
    description: 'Offer multiple payment dates and methods',
    expectedImpact: 'Improve payment success by 20%',
    implementation: 'User preference management in account settings'
  });
  
  return suggestions;
}

module.exports = router;
