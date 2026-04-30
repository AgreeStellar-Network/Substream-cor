const express = require('express');
const { ReconciliationService } = require('../../src/services/reconciliationService');

module.exports = function createReconciliationRoutes(database) {
  const router = express.Router();
  const reconciliationService = new ReconciliationService(database);

  /**
   * Drill-Down API
   * GET /api/admin/reconciliation/:discrepancyId/drill-down
   * Returns side-by-side comparison of Ledger vs Internal state and tracing
   */
  router.get('/:discrepancyId/drill-down', async (req, res) => {
    try {
      const { discrepancyId } = req.params;
      const result = await reconciliationService.getDiscrepancy(discrepancyId);
      
      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Force-Sync API
   * POST /api/admin/reconciliation/:discrepancyId/force-sync
   * Manually override transaction status for SOX compliance
   */
  router.post('/:discrepancyId/force-sync', async (req, res) => {
    try {
      const { discrepancyId } = req.params;
      const { newStatus, reason } = req.body;
      
      // In a real scenario, the accountantId comes from auth middleware
      // For this implementation, we can extract from user or body
      const accountantId = req.user?.address || req.body.accountantId || 'system_accountant';

      if (!newStatus || !reason) {
        return res.status(400).json({
          success: false,
          error: 'newStatus and reason are required'
        });
      }

      const result = await reconciliationService.forceSync(discrepancyId, newStatus, reason, accountantId);
      
      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      if (error.message.includes('not found')) {
        return res.status(404).json({ success: false, error: error.message });
      }
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
};
