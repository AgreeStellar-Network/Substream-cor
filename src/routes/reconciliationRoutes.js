const express = require('express');
const { format } = require('date-fns');

/**
 * Reconciliation API Routes
 * 
 * RESTful endpoints for managing reconciliation operations,
 * viewing reports, and configuring settings.
 */
function createReconciliationRoutes(reconciliationManager) {
  const router = express.Router();

  /**
   * GET /reconciliation/health
   * Health check endpoint
   */
  router.get('/health', async (req, res) => {
    try {
      const health = await reconciliationManager.healthCheck();
      res.status(health.healthy ? 200 : 503).json(health);
    } catch (error) {
      res.status(500).json({
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/status
   * Get comprehensive system status
   */
  router.get('/status', async (req, res) => {
    try {
      const status = await reconciliationManager.getSystemStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * POST /reconciliation/merchant/:merchantId/reconcile
   * Run reconciliation for a specific merchant
   */
  router.post('/merchant/:merchantId/reconcile', async (req, res) => {
    try {
      const { merchantId } = req.params;
      const { date } = req.body;
      
      const targetDate = date ? new Date(date) : new Date();
      
      const result = await reconciliationManager.reconcileMerchant(merchantId, targetDate);
      
      res.json({
        success: true,
        merchantId,
        targetDate: format(targetDate, 'yyyy-MM-dd'),
        result,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * POST /reconciliation/daily
   * Run full daily reconciliation
   */
  router.post('/daily', async (req, res) => {
    try {
      const { date } = req.body;
      const targetDate = date ? new Date(date) : new Date();
      
      const result = await reconciliationManager.runDailyReconciliation(targetDate);
      
      res.json({
        success: true,
        targetDate: format(targetDate, 'yyyy-MM-dd'),
        result,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * POST /reconciliation/merchant/:merchantId/validate
   * Validate metrics for a merchant
   */
  router.post('/merchant/:merchantId/validate', async (req, res) => {
    try {
      const { merchantId } = req.params;
      const { date } = req.body;
      
      const targetDate = date ? new Date(date) : new Date();
      
      const result = await reconciliationManager.validateMerchantMetrics(merchantId, targetDate);
      
      res.json({
        success: true,
        merchantId,
        targetDate: format(targetDate, 'yyyy-MM-dd'),
        result,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/merchant/:merchantId/report/:date
   * Get reconciliation report for a merchant on a specific date
   */
  router.get('/merchant/:merchantId/report/:date', async (req, res) => {
    try {
      const { merchantId, date } = req.params;
      
      const report = await reconciliationManager.getMerchantReport(merchantId, date);
      
      if (!report) {
        return res.status(404).json({
          error: 'Report not found',
          merchantId,
          date,
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        report,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/merchant/:merchantId/history
   * Get merchant reconciliation history
   */
  router.get('/merchant/:merchantId/history', async (req, res) => {
    try {
      const { merchantId } = req.params;
      const { days = 30 } = req.query;
      
      const history = await reconciliationManager.getMerchantHistory(
        merchantId, 
        parseInt(days)
      );
      
      res.json({
        success: true,
        merchantId,
        days: parseInt(days),
        history,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/summary
   * Get system-wide reconciliation summary
   */
  router.get('/summary', async (req, res) => {
    try {
      const { days = 7 } = req.query;
      
      const summary = await reconciliationManager.getSystemSummary(parseInt(days));
      
      res.json({
        success: true,
        days: parseInt(days),
        summary,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/discrepancies/analytics
   * Get discrepancy analytics
   */
  router.get('/discrepancies/analytics', async (req, res) => {
    try {
      const { days = 30 } = req.query;
      
      const analytics = await reconciliationManager.getDiscrepancyAnalytics(parseInt(days));
      
      res.json({
        success: true,
        days: parseInt(days),
        analytics,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/merchants/top-discrepancies
   * Get top merchants by discrepancy count
   */
  router.get('/merchants/top-discrepancies', async (req, res) => {
    try {
      const { days = 7, limit = 10 } = req.query;
      
      const merchants = await reconciliationManager.getTopDiscrepancyMerchants(
        parseInt(days), 
        parseInt(limit)
      );
      
      res.json({
        success: true,
        days: parseInt(days),
        limit: parseInt(limit),
        merchants,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/export/merchant/:merchantId
   * Export reconciliation data for a merchant
   */
  router.get('/export/merchant/:merchantId', async (req, res) => {
    try {
      const { merchantId } = req.params;
      const { startDate, endDate, format = 'json' } = req.query;
      
      if (!startDate || !endDate) {
        return res.status(400).json({
          error: 'startDate and endDate are required',
          example: '/reconciliation/export/merchant/ABC123?startDate=2023-01-01&endDate=2023-01-31&format=csv'
        });
      }

      const data = await reconciliationManager.exportData(
        merchantId, 
        startDate, 
        endDate, 
        format
      );

      const filename = `reconciliation_${merchantId}_${startDate}_to_${endDate}.${format}`;
      
      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(data);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.json(data);
      }

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Configuration endpoints
  const configService = reconciliationManager.getConfigService();

  /**
   * GET /reconciliation/config/merchant/:merchantId
   * Get merchant configuration
   */
  router.get('/config/merchant/:merchantId', async (req, res) => {
    try {
      const { merchantId } = req.params;
      
      const config = await configService.getMerchantConfig(merchantId);
      
      res.json({
        success: true,
        merchantId,
        config,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * PUT /reconciliation/config/merchant/:merchantId
   * Update merchant configuration
   */
  router.put('/config/merchant/:merchantId', async (req, res) => {
    try {
      const { merchantId } = req.params;
      const configData = req.body;
      
      // Validate configuration
      const validation = configService.validateConfig(configData);
      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          error: 'Invalid configuration',
          errors: validation.errors,
          timestamp: new Date().toISOString()
        });
      }

      const config = await configService.upsertMerchantConfig(merchantId, configData);
      
      res.json({
        success: true,
        merchantId,
        config,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * POST /reconciliation/config/merchant/:merchantId/enable
   * Enable reconciliation for a merchant
   */
  router.post('/config/merchant/:merchantId/enable', async (req, res) => {
    try {
      const { merchantId } = req.params;
      
      const config = await configService.enableMerchant(merchantId);
      
      res.json({
        success: true,
        merchantId,
        config,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * POST /reconciliation/config/merchant/:merchantId/disable
   * Disable reconciliation for a merchant
   */
  router.post('/config/merchant/:merchantId/disable', async (req, res) => {
    try {
      const { merchantId } = req.params;
      
      const config = await configService.disableMerchant(merchantId);
      
      res.json({
        success: true,
        merchantId,
        config,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/config/merchants
   * Get all merchant configurations
   */
  router.get('/config/merchants', async (req, res) => {
    try {
      const { enabled } = req.query;
      
      let merchants;
      if (enabled === 'true') {
        merchants = await configService.getEnabledMerchants();
      } else {
        merchants = await configService.getAllMerchants();
      }
      
      res.json({
        success: true,
        filter: enabled ? { enabled: true } : null,
        merchants,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/config/stats
   * Get configuration statistics
   */
  router.get('/config/stats', async (req, res) => {
    try {
      const stats = await configService.getConfigStats();
      
      res.json({
        success: true,
        stats,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/config/export
   * Export configuration to CSV
   */
  router.get('/config/export', async (req, res) => {
    try {
      const csvData = await configService.exportConfigToCsv();
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="reconciliation_config.csv"');
      res.send(csvData);

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * GET /reconciliation/config/merchants/attention
   * Get merchants that need attention
   */
  router.get('/config/merchants/attention', async (req, res) => {
    try {
      const { days = 7 } = req.query;
      
      const merchants = await configService.getMerchantsNeedingAttention(parseInt(days));
      
      res.json({
        success: true,
        days: parseInt(days),
        merchants,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  /**
   * DELETE /reconciliation/config/merchant/:merchantId
   * Delete merchant configuration
   */
  router.delete('/config/merchant/:merchantId', async (req, res) => {
    try {
      const { merchantId } = req.params;
      
      const config = await configService.deleteMerchantConfig(merchantId);
      
      if (!config) {
        return res.status(404).json({
          success: false,
          error: 'Configuration not found',
          merchantId,
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        merchantId,
        deletedConfig: config,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  return router;
}

module.exports = createReconciliationRoutes;
