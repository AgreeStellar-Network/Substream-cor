const express = require('express');
const router = express.Router();
const dataExportService = require('../src/services/dataExportService');
const { requireFeatureFlag } = require('../middleware/featureFlags');

/**
 * POST /api/v1/merchants/export-data
 * Request a complete data export for the authenticated merchant
 */
router.post('/export-data', requireFeatureFlag('enable_data_export'), async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    const requesterEmail = req.user?.email || req.body.email;
    const { format = 'json' } = req.body;
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    if (!requesterEmail) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Requester email is required'
      });
    }

    // Initialize service if not already done
    if (!dataExportService.s3) {
      dataExportService.initialize();
    }

    const exportRequest = await dataExportService.requestExport(tenantId, requesterEmail, format);
    
    res.status(202).json({
      success: true,
      message: 'Export request submitted successfully',
      data: exportRequest
    });
  } catch (error) {
    console.error('Error requesting data export:', error);
    
    if (error.message.includes('Rate limit exceeded')) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: error.message,
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }
    
    if (error.message.includes('Invalid export format')) {
      return res.status(400).json({
        error: 'Bad Request',
        message: error.message,
        code: 'INVALID_FORMAT'
      });
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process export request'
    });
  }
});

/**
 * GET /api/v1/merchants/export-data/:exportId/status
 * Get the status of a data export request
 */
router.get('/export-data/:exportId/status', async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    const { exportId } = req.params;
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    const exportStatus = await dataExportService.getExportStatus(exportId, tenantId);
    
    res.json({
      success: true,
      data: {
        export_id: exportStatus.id,
        status: exportStatus.status,
        requested_at: exportStatus.requested_at,
        started_at: exportStatus.started_at,
        completed_at: exportStatus.completed_at,
        s3_url: exportStatus.s3_url,
        s3_url_expires_at: exportStatus.s3_url_expires_at,
        export_format: exportStatus.export_format,
        error_message: exportStatus.error_message,
        metadata: exportStatus.export_metadata
      }
    });
  } catch (error) {
    console.error('Error getting export status:', error);
    
    if (error.message.includes('Export request not found')) {
      return res.status(404).json({
        error: 'Not Found',
        message: error.message,
        code: 'EXPORT_NOT_FOUND'
      });
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve export status'
    });
  }
});

/**
 * GET /api/v1/merchants/export-data
 * Get list of all export requests for the tenant
 */
router.get('/export-data', async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    const { limit = 20, offset = 0, status } = req.query;
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    const db = require('../src/db/appDatabase').getDatabase();
    
    let query = db('data_export_requests')
      .where('tenant_id', tenantId)
      .orderBy('requested_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    if (status) {
      query = query.where('status', status);
    }

    const exports = await query.select('*');
    
    // Get total count
    const totalCount = await db('data_export_requests')
      .where('tenant_id', tenantId)
      .modify(function(queryBuilder) {
        if (status) {
          queryBuilder.where('status', status);
        }
      })
      .count('* as count')
      .first();

    res.json({
      success: true,
      data: {
        exports: exports,
        pagination: {
          total: parseInt(totalCount.count),
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });
  } catch (error) {
    console.error('Error getting export history:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve export history'
    });
  }
});

/**
 * DELETE /api/v1/merchants/export-data/:exportId
 * Cancel a pending export request
 */
router.delete('/export-data/:exportId', async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || req.tenant?.id;
    const { exportId } = req.params;
    
    if (!tenantId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant authentication required'
      });
    }

    const db = require('../src/db/appDatabase').getDatabase();
    
    // Check if export can be cancelled
    const exportRequest = await db('data_export_requests')
      .where({
        id: exportId,
        tenant_id: tenantId
      })
      .first();

    if (!exportRequest) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Export request not found',
        code: 'EXPORT_NOT_FOUND'
      });
    }

    if (exportRequest.status !== 'pending') {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Only pending exports can be cancelled',
        code: 'EXPORT_NOT_CANCELLABLE'
      });
    }

    // Update status to cancelled
    await db('data_export_requests')
      .where('id', exportId)
      .update({
        status: 'cancelled',
        completed_at: new Date(),
        error_message: 'Cancelled by user'
      });

    res.json({
      success: true,
      message: 'Export request cancelled successfully',
      data: {
        export_id: exportId,
        status: 'cancelled'
      }
    });
  } catch (error) {
    console.error('Error cancelling export:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to cancel export request'
    });
  }
});

/**
 * GET /api/v1/merchants/export-data/schema
 * Get the data export schema documentation
 */
router.get('/export-data/schema', async (req, res) => {
  try {
    const schema = {
      version: '1.0',
      description: 'Data export schema for AgreeStellar tenant data',
      last_updated: new Date().toISOString(),
      tables: {
        tenant_info: {
          description: 'Basic tenant information',
          fields: {
            id: 'UUID - Unique tenant identifier',
            name: 'String - Tenant business name',
            email: 'String - Primary contact email',
            created_at: 'ISO 8601 timestamp - Account creation date',
            updated_at: 'ISO 8601 timestamp - Last update date'
          }
        },
        users: {
          description: 'All user accounts belonging to the tenant',
          fields: {
            id: 'UUID - Unique user identifier',
            email: 'String - User email address',
            first_name: 'String - User first name',
            last_name: 'String - User last name',
            created_at: 'ISO 8601 timestamp - Account creation date',
            updated_at: 'ISO 8601 timestamp - Last update date'
          }
        },
        subscription_plans: {
          description: 'Subscription plans created by the tenant',
          fields: {
            id: 'UUID - Unique plan identifier',
            name: 'String - Plan display name',
            price: 'Number - Plan price in smallest currency unit',
            currency: 'String - ISO 4217 currency code',
            interval: 'String - Billing interval (monthly, yearly, etc.)',
            features: 'JSON - Plan features object',
            created_at: 'ISO 8601 timestamp - Plan creation date',
            updated_at: 'ISO 8601 timestamp - Last update date'
          }
        },
        billing_history: {
          description: 'All billing transactions and invoices',
          fields: {
            id: 'UUID - Unique transaction identifier',
            amount: 'Number - Transaction amount in smallest currency unit',
            currency: 'String - ISO 4217 currency code',
            status: 'String - Transaction status (paid, pending, failed)',
            payment_method: 'String - Payment method used',
            created_at: 'ISO 8601 timestamp - Transaction date',
            updated_at: 'ISO 8601 timestamp - Last update date'
          }
        },
        webhook_logs: {
          description: 'Webhook delivery logs (limited to 10,000 most recent)',
          fields: {
            id: 'UUID - Unique log identifier',
            event_type: 'String - Type of event that triggered webhook',
            url: 'String - Webhook endpoint URL',
            status_code: 'Number - HTTP status code returned',
            response_body: 'String - Response body from webhook endpoint',
            created_at: 'ISO 8601 timestamp - Webhook delivery time'
          }
        },
        analytics: {
          description: 'Analytics and usage data (limited to 10,000 most recent events)',
          fields: {
            id: 'UUID - Unique event identifier',
            event_type: 'String - Type of analytics event',
            event_data: 'JSON - Event-specific data payload',
            user_id: 'UUID - User who triggered the event (if applicable)',
            created_at: 'ISO 8601 timestamp - Event timestamp'
          }
        }
      },
      export_formats: {
        json: {
          description: 'Complete JSON export with all data in structured format',
          file_structure: {
            'export_data.json': 'Complete dataset with metadata and all tables'
          },
          recommended_for: 'Programmatic processing and data integration'
        },
        csv: {
          description: 'CSV files for each table type plus metadata',
          file_structure: {
            'tenant_info.csv': 'Tenant information',
            'users.csv': 'User accounts',
            'subscription_plans.csv': 'Subscription plans',
            'billing_history.csv': 'Billing transactions',
            'webhook_logs.csv': 'Webhook delivery logs',
            'analytics.csv': 'Analytics events',
            'metadata.json': 'Export metadata and schema information'
          },
          recommended_for: 'Spreadsheet applications and manual data review'
        }
      },
      security_notes: [
        'Raw API keys and internal protocol metadata are excluded from exports',
        'All exports are encrypted at rest using AES-256',
        'Download links expire after 24 hours for security',
        'Exports are rate-limited to once per 7 days per tenant',
        'Large datasets are streamed to prevent memory issues'
      ],
      limitations: {
        webhook_logs: 'Limited to 10,000 most recent records',
        analytics: 'Limited to 10,000 most recent records',
        rate_limit: 'One export per 7 days per tenant',
        retention: 'Download links expire after 24 hours'
      }
    };

    res.json({
      success: true,
      data: schema
    });
  } catch (error) {
    console.error('Error getting export schema:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve export schema'
    });
  }
});

module.exports = router;
