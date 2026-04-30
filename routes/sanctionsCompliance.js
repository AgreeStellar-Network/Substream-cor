const express = require('express');
const { SanctionsScreeningService } = require('../src/services/sanctionsScreeningService');

/**
 * Compliance officer surface for reviewing sanctions hits.
 *
 *   GET    /api/compliance/sanctions/queue          - list open review tickets
 *   POST   /api/compliance/sanctions/:address/false-positive
 *                                                   - clear an address (unblock)
 *   POST   /api/compliance/sanctions/:address/confirm
 *                                                   - confirm sanction (stay blocked)
 *   GET    /api/compliance/sanctions/:address/audit - full audit trail
 *   GET    /api/compliance/sanctions/:address       - current account status
 *
 * The router is service-injectable so the main app and tests can share a
 * single SanctionsScreeningService (and its in-process cache).
 */
function createSanctionsComplianceRoutes(deps = {}) {
  const router = express.Router();

  const getService = (req) => {
    if (deps.sanctionsScreeningService) return deps.sanctionsScreeningService;
    const fromApp = req.app.get('sanctionsScreeningService');
    if (fromApp) return fromApp;

    const database = deps.database || req.app.get('database');
    if (!database) {
      throw new Error('SanctionsScreeningService unavailable: no database configured');
    }
    const service = new SanctionsScreeningService({ database });
    req.app.set('sanctionsScreeningService', service);
    return service;
  };

  router.get('/queue', (req, res) => {
    try {
      const { status, limit } = req.query;
      const service = getService(req);
      const queue = service.listReviewQueue({ status, limit });
      return res.status(200).json({ success: true, data: queue });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, error: error.message || 'Queue lookup failed' });
    }
  });

  router.post('/:address/false-positive', async (req, res) => {
    try {
      const { address } = req.params;
      const { reviewedBy, decisionNotes } = req.body || {};
      if (!reviewedBy) {
        return res
          .status(400)
          .json({ success: false, error: 'reviewedBy is required' });
      }
      const service = getService(req);
      const result = await service.markFalsePositive({
        walletAddress: address,
        reviewedBy,
        decisionNotes,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      const status = /not currently blocked/i.test(error.message) ? 409 : 500;
      return res
        .status(status)
        .json({ success: false, error: error.message || 'Review failed' });
    }
  });

  router.post('/:address/confirm', async (req, res) => {
    try {
      const { address } = req.params;
      const { reviewedBy, decisionNotes } = req.body || {};
      if (!reviewedBy) {
        return res
          .status(400)
          .json({ success: false, error: 'reviewedBy is required' });
      }
      const service = getService(req);
      const result = await service.confirmSanction({
        walletAddress: address,
        reviewedBy,
        decisionNotes,
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      const status = /not currently blocked/i.test(error.message) ? 409 : 500;
      return res
        .status(status)
        .json({ success: false, error: error.message || 'Review failed' });
    }
  });

  router.get('/:address/audit', (req, res) => {
    try {
      const { address } = req.params;
      const { limit } = req.query;
      const service = getService(req);
      const audit = service.getAuditTrail(address, { limit });
      return res.status(200).json({ success: true, data: audit });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, error: error.message || 'Audit lookup failed' });
    }
  });

  router.get('/:address', (req, res) => {
    try {
      const { address } = req.params;
      const service = getService(req);
      const status = service.getAccountStatus(address);
      if (!status) {
        return res.status(404).json({
          success: false,
          error: `No screening record for ${address}`,
        });
      }
      return res.status(200).json({ success: true, data: status });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, error: error.message || 'Status lookup failed' });
    }
  });

  return router;
}

module.exports = createSanctionsComplianceRoutes;
