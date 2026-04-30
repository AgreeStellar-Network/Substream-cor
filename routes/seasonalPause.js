const express = require('express');
const { SeasonalPauseService } = require('../src/services/seasonalPauseService');
const { BulkPauseExecutionJob } = require('../src/services/bulkPauseExecutionJob');

/**
 * REST endpoints for the seasonal-pause / Deferred Billing flow.
 *
 *   POST   /api/seasonal-pause/bulk           - bulk pause many plans
 *   POST   /api/seasonal-pause/:pauseId/resume- resume + recalculate billing
 *   POST   /api/seasonal-pause/:pauseId/cancel- cancel without reconciling
 *   GET    /api/seasonal-pause                - list active pauses
 *   GET    /api/seasonal-pause/:pauseId       - pause detail
 *   GET    /api/seasonal-pause/skipped/:creatorId/:walletAddress - skipped cycles
 *
 * Mount with:
 *     app.use('/api/seasonal-pause', createSeasonalPauseRoutes({ database }));
 *
 * The router accepts an injected service so tests / the main app can share a
 * single SeasonalPauseService instance (and its in-process pause cache).
 */
function createSeasonalPauseRoutes(deps = {}) {
  const router = express.Router();

  const getService = (req) => {
    if (deps.seasonalPauseService) return deps.seasonalPauseService;
    const fromApp = req.app.get('seasonalPauseService');
    if (fromApp) return fromApp;

    const database = deps.database || req.app.get('database');
    if (!database) {
      throw new Error('SeasonalPauseService unavailable: no database configured');
    }
    const service = new SeasonalPauseService({ database });
    req.app.set('seasonalPauseService', service);
    return service;
  };

  const getJob = (req) => {
    if (deps.bulkPauseExecutionJob) return deps.bulkPauseExecutionJob;
    const fromApp = req.app.get('bulkPauseExecutionJob');
    if (fromApp) return fromApp;
    const job = new BulkPauseExecutionJob({
      seasonalPauseService: getService(req),
    });
    req.app.set('bulkPauseExecutionJob', job);
    return job;
  };

  router.post('/bulk', async (req, res) => {
    try {
      const { merchantId, planIds, reason, expectedResumeAt, pausedBy } =
        req.body || {};

      if (!merchantId) {
        return res
          .status(400)
          .json({ success: false, error: 'merchantId is required' });
      }
      if (!Array.isArray(planIds) || planIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'planIds must be a non-empty array',
        });
      }

      const job = getJob(req);
      const result = await job.execute({
        merchantId,
        planIds,
        reason,
        expectedResumeAt,
        pausedBy,
      });

      const status = result.failedPlanCount === 0 ? 200 : 207;
      return res.status(status).json({ success: true, data: result });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, error: error.message || 'Bulk pause failed' });
    }
  });

  router.post('/:pauseId/resume', async (req, res) => {
    try {
      const { pauseId } = req.params;
      const { resumedAt, resumedBy } = req.body || {};
      const service = getService(req);
      const result = await service.bulkResume({ pauseId, resumedAt, resumedBy });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      const status = /not found/i.test(error.message)
        ? 404
        : /not active/i.test(error.message)
          ? 409
          : 500;
      return res
        .status(status)
        .json({ success: false, error: error.message || 'Resume failed' });
    }
  });

  router.post('/:pauseId/cancel', async (req, res) => {
    try {
      const { pauseId } = req.params;
      const { cancelledBy } = req.body || {};
      const service = getService(req);
      const result = await service.cancelPause({ pauseId, cancelledBy });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      const status = /not found/i.test(error.message)
        ? 404
        : /not active/i.test(error.message)
          ? 409
          : 500;
      return res
        .status(status)
        .json({ success: false, error: error.message || 'Cancel failed' });
    }
  });

  router.get('/', (req, res) => {
    try {
      const { merchantId } = req.query;
      const service = getService(req);
      const pauses = service.listActivePauses({ merchantId });
      return res.status(200).json({ success: true, data: pauses });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, error: error.message || 'List failed' });
    }
  });

  router.get('/skipped/:creatorId/:walletAddress', (req, res) => {
    try {
      const { creatorId, walletAddress } = req.params;
      const { pauseId } = req.query;
      const service = getService(req);
      const cycles = service.getSkippedCyclesForSubscription({
        creatorId,
        walletAddress,
        pauseId,
      });
      return res.status(200).json({ success: true, data: cycles });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, error: error.message || 'Lookup failed' });
    }
  });

  router.get('/:pauseId', (req, res) => {
    try {
      const { pauseId } = req.params;
      const service = getService(req);
      const pause = service.getPauseDetail(pauseId);
      if (!pause) {
        return res
          .status(404)
          .json({ success: false, error: `Pause ${pauseId} not found` });
      }
      return res.status(200).json({ success: true, data: pause });
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, error: error.message || 'Lookup failed' });
    }
  });

  return router;
}

module.exports = createSeasonalPauseRoutes;
