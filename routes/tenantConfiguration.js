const express = require('express');
const router = express.Router();
const tenantConfigurationService = require('../src/services/tenantConfigurationService');
const { requireFeatureFlag } = require('../middleware/featureFlags');
const {
  ADMIN_ROLES,
  READ_ROLES,
  requireRbacUser,
  requireRole,
  requirePermissionOrRole
} = require('../middleware/merchantConfigRbac');

/**
 * GET /api/v1/config/flags
 * Get all feature flags for the authenticated tenant
 */
router.get('/flags', requireRbacUser, requirePermissionOrRole('merchants:read', READ_ROLES), async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    const flags = await tenantConfigurationService.getAllTenantFlags(tenantId);
    
    res.json({
      success: true,
      data: {
        tenant_id: tenantId,
        flags: flags,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting tenant flags:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve feature flags'
    });
  }
});

/**
 * GET /api/v1/config/flags/:flagName
 * Get a specific feature flag value
 */
router.get('/flags/:flagName', requireRbacUser, requirePermissionOrRole('merchants:read', READ_ROLES), async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    const { flagName } = req.params;
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    const flagValue = await tenantConfigurationService.evaluateFeatureFlag(tenantId, flagName);
    
    res.json({
      success: true,
      data: {
        tenant_id: tenantId,
        flag_name: flagName,
        flag_value: flagValue,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting feature flag:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve feature flag'
    });
  }
});

/**
 * PUT /api/v1/config/flags/:flagName
 * Update a feature flag (admin only)
 */
router.put('/flags/:flagName', requireRbacUser, requirePermissionOrRole('merchants:write', ADMIN_ROLES), async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    const { flagName } = req.params;
    const { value, reason } = req.body;
    const changedBy = req.user?.email || req.user?.id || 'system';
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    // Validate input
    if (typeof value !== 'boolean') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Flag value must be a boolean'
      });
    }

    await tenantConfigurationService.updateFeatureFlag(
      tenantId, 
      flagName, 
      value, 
      changedBy, 
      reason || 'Manual update via API'
    );
    
    res.json({
      success: true,
      data: {
        tenant_id: tenantId,
        flag_name: flagName,
        old_value: null, // Could be fetched if needed
        new_value: value,
        updated_by: changedBy,
        reason: reason || 'Manual update via API',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error updating feature flag:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update feature flag'
    });
  }
});

/**
 * GET /api/v1/config/flags/:flagName/audit
 * Get audit history for a specific feature flag
 */
router.get('/flags/:flagName/audit', requireRbacUser, requirePermissionOrRole('merchants:read', READ_ROLES), async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    const { flagName } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    if (limit > 100) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Limit cannot exceed 100 records'
      });
    }

    const auditHistory = await tenantConfigurationService.getFlagAuditHistory(
      tenantId, 
      flagName, 
      limit
    );
    
    res.json({
      success: true,
      data: {
        tenant_id: tenantId,
        flag_name: flagName,
        audit_history: auditHistory,
        total_records: auditHistory.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting audit history:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve audit history'
    });
  }
});

/**
 * DELETE /api/v1/config/cache
 * Clear cache for tenant (admin only)
 */
router.delete('/cache', requireRbacUser, requirePermissionOrRole('merchants:write', ADMIN_ROLES), async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    await tenantConfigurationService.clearTenantCache(tenantId);
    
    res.json({
      success: true,
      data: {
        tenant_id: tenantId,
        message: 'Cache cleared successfully',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to clear cache'
    });
  }
});

/**
 * GET /api/v1/config/metrics
 * Get performance metrics (admin only)
 */
router.get('/metrics', requireRbacUser, requireRole(ADMIN_ROLES), async (req, res) => {
  try {
    // This should be protected by admin middleware
    const metrics = tenantConfigurationService.getMetrics();
    
    res.json({
      success: true,
      data: {
        metrics: metrics,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting metrics:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve metrics'
    });
  }
});

module.exports = router;
