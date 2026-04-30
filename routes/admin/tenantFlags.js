const express = require('express');
const router = express.Router();
const tenantConfigurationService = require('../../src/services/tenantConfigurationService');
const { getDatabase } = require('../../src/db/appDatabase');
const {
  ADMIN_ROLES,
  requireRbacUser,
  requireRole
} = require('../../middleware/merchantConfigRbac');

router.use(requireRbacUser, requireRole(ADMIN_ROLES));

/**
 * GET /api/v1/admin/tenants/:tenantId/flags
 * Get all feature flags for a specific tenant (admin only)
 */
router.get('/tenants/:tenantId/flags', async (req, res) => {
  try {
    const { tenantId } = req.params;
    
    // Validate tenant exists
    const db = getDatabase();
    const tenant = await db('tenants').where('id', tenantId).first();
    
    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found'
      });
    }

    const flags = await tenantConfigurationService.getAllTenantFlags(tenantId);
    
    res.json({
      success: true,
      data: {
        tenant_id: tenantId,
        tenant_name: tenant.name || 'Unknown',
        flags: flags,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting tenant flags (admin):', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve tenant flags'
    });
  }
});

/**
 * PUT /api/v1/admin/tenants/:tenantId/flags/:flagName
 * Update a feature flag for a tenant (admin only)
 */
router.put('/tenants/:tenantId/flags/:flagName', async (req, res) => {
  try {
    const { tenantId, flagName } = req.params;
    const { value, reason, force } = req.body;
    const changedBy = req.user?.email || req.user?.id || 'admin';
    
    // Validate tenant exists
    const db = getDatabase();
    const tenant = await db('tenants').where('id', tenantId).first();
    
    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found'
      });
    }

    // Validate input
    if (typeof value !== 'boolean') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Flag value must be a boolean'
      });
    }

    // Check if this is a force override (bypassing normal validation)
    if (force && req.user?.role !== 'super_admin') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Only super admins can force override feature flags'
      });
    }

    // Get current value for audit
    const currentFlags = await tenantConfigurationService.getAllTenantFlags(tenantId);
    const oldValue = currentFlags[flagName] || false;

    // Update the flag
    await tenantConfigurationService.updateFeatureFlag(
      tenantId, 
      flagName, 
      value, 
      changedBy, 
      reason || `Admin override via dashboard${force ? ' (forced)' : ''}`
    );
    
    res.json({
      success: true,
      data: {
        tenant_id: tenantId,
        tenant_name: tenant.name || 'Unknown',
        flag_name: flagName,
        old_value: oldValue,
        new_value: value,
        updated_by: changedBy,
        reason: reason || `Admin override via dashboard${force ? ' (forced)' : ''}`,
        forced: force || false,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error updating tenant flag (admin):', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update tenant flag'
    });
  }
});

/**
 * GET /api/v1/admin/tenants/:tenantId/flags/:flagName/audit
 * Get audit history for a specific tenant's feature flag (admin only)
 */
router.get('/tenants/:tenantId/flags/:flagName/audit', async (req, res) => {
  try {
    const { tenantId, flagName } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    // Validate tenant exists
    const db = getDatabase();
    const tenant = await db('tenants').where('id', tenantId).first();
    
    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found'
      });
    }

    if (limit > 1000) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Limit cannot exceed 1000 records'
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
        tenant_name: tenant.name || 'Unknown',
        flag_name: flagName,
        audit_history: auditHistory,
        total_records: auditHistory.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting tenant audit history (admin):', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve audit history'
    });
  }
});

/**
 * GET /api/v1/admin/flags/summary
 * Get summary of all feature flags across all tenants (admin only)
 */
router.get('/flags/summary', async (req, res) => {
  try {
    const db = getDatabase();
    
    // Get flag usage statistics
    const flagStats = await db('tenant_configurations')
      .select(
        'flag_name',
        db.raw('COUNT(*) as total_tenants'),
        db.raw('SUM(CASE WHEN flag_value = true THEN 1 ELSE 0 END) as enabled_tenants'),
        db.raw('SUM(CASE WHEN flag_value = false THEN 1 ELSE 0 END) as disabled_tenants')
      )
      .groupBy('flag_name')
      .orderBy('flag_name');

    // Get total tenant count
    const totalTenants = await db('tenants').count('* as count').first();
    
    // Get recent audit activity
    const recentActivity = await db('feature_flag_audit_log')
      .select('*')
      .orderBy('created_at', 'desc')
      .limit(10);

    res.json({
      success: true,
      data: {
        summary: {
          total_tenants: parseInt(totalTenants.count),
          total_flag_types: flagStats.length,
          flag_statistics: flagStats
        },
        recent_activity: recentActivity,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting flags summary (admin):', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve flags summary'
    });
  }
});

/**
 * POST /api/v1/admin/flags/bulk-update
 * Bulk update feature flags for multiple tenants (admin only)
 */
router.post('/flags/bulk-update', async (req, res) => {
  try {
    const { tenantIds, flagName, value, reason } = req.body;
    const changedBy = req.user?.email || req.user?.id || 'admin';
    
    // Validate input
    if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'tenantIds must be a non-empty array'
      });
    }

    if (typeof value !== 'boolean') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Flag value must be a boolean'
      });
    }

    if (tenantIds.length > 100) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot update more than 100 tenants at once'
      });
    }

    // Validate all tenants exist
    const db = getDatabase();
    const existingTenants = await db('tenants')
      .select('id', 'name')
      .whereIn('id', tenantIds);

    if (existingTenants.length !== tenantIds.length) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'One or more tenants not found'
      });
    }

    // Update flags for all tenants
    const updatePromises = tenantIds.map(tenantId =>
      tenantConfigurationService.updateFeatureFlag(
        tenantId,
        flagName,
        value,
        changedBy,
        reason || `Bulk admin update via dashboard`
      )
    );

    await Promise.all(updatePromises);

    res.json({
      success: true,
      data: {
        updated_tenants: tenantIds.length,
        flag_name: flagName,
        new_value: value,
        updated_by: changedBy,
        reason: reason || 'Bulk admin update via dashboard',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error bulk updating flags (admin):', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to bulk update flags'
    });
  }
});

/**
 * DELETE /api/v1/admin/tenants/:tenantId/cache
 * Clear cache for a specific tenant (admin only)
 */
router.delete('/tenants/:tenantId/cache', async (req, res) => {
  try {
    const { tenantId } = req.params;
    
    // Validate tenant exists
    const db = getDatabase();
    const tenant = await db('tenants').where('id', tenantId).first();
    
    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found'
      });
    }

    await tenantConfigurationService.clearTenantCache(tenantId);
    
    res.json({
      success: true,
      data: {
        tenant_id: tenantId,
        tenant_name: tenant.name || 'Unknown',
        message: 'Cache cleared successfully',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error clearing tenant cache (admin):', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to clear tenant cache'
    });
  }
});

module.exports = router;
