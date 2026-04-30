const request = require('supertest');
const app = require('../index');
const tenantConfigurationService = require('../src/services/tenantConfigurationService');
const dataExportService = require('../src/services/dataExportService');
const websocketRateLimitService = require('../src/services/websocketRateLimitService');
const { getDatabase } = require('../src/db/appDatabase');
const { AuthService } = require('../src/services/auth.service');

describe('Integration Tests - All Four Features', () => {
  let db;
  let testTenantId;
  let authToken;
  
  beforeAll(async () => {
    db = getDatabase();
    const authService = new AuthService();
    
    // Create test tenant
    const [tenant] = await db('tenants').insert({
      name: 'Integration Test Tenant',
      email: 'integration-test@example.com',
      created_at: new Date(),
      updated_at: new Date()
    }).returning('*');
    
    testTenantId = tenant.id;
    const member = {
      id: 'member-integration-test',
      email: 'integration-test@example.com',
      organizationId: testTenantId,
      role: 'ADMIN',
      permissions: ['merchants:read', 'merchants:write']
    };

    authToken = `Bearer ${authService.generateMemberToken(member)}`;
    
    // Initialize all services
    await tenantConfigurationService.initialize();
    dataExportService.initialize();
    await websocketRateLimitService.initialize();
  });

  afterAll(async () => {
    // Shutdown services
    await tenantConfigurationService.shutdown();
    await websocketRateLimitService.shutdown();
    
    // Clean up test data
    await db('data_export_requests').where('tenant_id', testTenantId).del();
    await db('data_export_rate_limits').where('tenant_id', testTenantId).del();
    await db('tenant_configurations').where('tenant_id', testTenantId).del();
    await db('feature_flag_audit_log').where('tenant_id', testTenantId).del();
    await db('websocket_rate_limit_log').where('tenant_id', testTenantId).del();
    await db('tenants').where('id', testTenantId).del();
  });

  beforeEach(async () => {
    // Clear test data
    await db('data_export_requests').where('tenant_id', testTenantId).del();
    await db('data_export_rate_limits').where('tenant_id', testTenantId).del();
    await db('tenant_configurations').where('tenant_id', testTenantId).del();
    await db('feature_flag_audit_log').where('tenant_id', testTenantId).del();
    await db('websocket_rate_limit_log').where('tenant_id', testTenantId).del();
    
    // Clear Redis
    await websocketRateLimitService.redis.flushAll();
  });

  describe('Feature Flags + Data Export Integration', () => {
    test('should block data export when feature flag is disabled', async () => {
      // Disable data export feature
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_data_export',
        false,
        'test_user',
        'Disable for testing'
      );

      // Try to request export
      const response = await request(app)
        .post('/api/v1/merchants/export-data')
        .set('Authorization', authToken)
        .send({
          format: 'json',
          email: 'test@example.com'
        })
        .expect(403);

      expect(response.body.error).toBe('Feature Not Available');
      expect(response.body.code).toBe('FEATURE_FLAG_DISABLED');
    });

    test('should allow data export when feature flag is enabled', async () => {
      // Enable data export feature
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_data_export',
        true,
        'test_user',
        'Enable for testing'
      );

      // Request export
      const response = await request(app)
        .post('/api/v1/merchants/export-data')
        .set('Authorization', authToken)
        .send({
          format: 'json',
          email: 'test@example.com'
        })
        .expect(202);

      expect(response.body.success).toBe(true);
      expect(response.body.data.export_id).toBeDefined();
    });

    test('should log feature flag changes correctly', async () => {
      // Update feature flag
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_data_export',
        true,
        'test_user',
        'Integration test'
      );

      // Check audit log
      const auditLog = await tenantConfigurationService.getFlagAuditHistory(
        testTenantId,
        'enable_data_export',
        1
      );

      expect(auditLog).toHaveLength(1);
      expect(auditLog[0].changed_by).toBe('test_user');
      expect(auditLog[0].change_reason).toBe('Integration test');
      expect(auditLog[0].new_value).toBe(true);
    });
  });

  describe('Feature Flags + WebSocket Rate Limiting Integration', () => {
    test('should use custom rate limits when feature flag is enabled', async () => {
      // Enable custom rate limiting
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_websocket_rate_limiting',
        true,
        'test_user',
        'Enable custom limits'
      );

      // Set custom rate limits for tenant
      await db('tenant_rate_limits').insert({
        tenant_id: testTenantId,
        max_connections_per_ip: 3,
        max_connections_per_tenant: 5,
        max_messages_per_second: 5
      });

      // Check if custom limits are applied
      const config = await websocketRateLimitService.getTenantRateLimitConfig(testTenantId);
      
      expect(config.custom).toBe(true);
      expect(config.maxConnectionsPerIP).toBe(3);
      expect(config.maxConnectionsPerTenant).toBe(5);
      expect(config.maxMessagesPerSecond).toBe(5);
    });

    test('should use default limits when feature flag is disabled', async () => {
      // Disable custom rate limiting
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_websocket_rate_limiting',
        false,
        'test_user',
        'Disable custom limits'
      );

      // Check if default limits are used
      const config = await websocketRateLimitService.getTenantRateLimitConfig(testTenantId);
      
      expect(config.custom).toBe(false);
      expect(config.maxConnectionsPerIP).toBe(websocketRateLimitService.config.maxConnectionsPerIP);
      expect(config.maxConnectionsPerTenant).toBe(websocketRateLimitService.config.maxConnectionsPerTenant);
    });
  });

  describe('Data Export + WebSocket Rate Limiting Integration', () => {
    test('should handle concurrent operations without interference', async () => {
      // Enable data export
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_data_export',
        true,
        'test_user',
        'Enable for testing'
      );

      // Start data export
      const exportResponse = await request(app)
        .post('/api/v1/merchants/export-data')
        .set('Authorization', authToken)
        .send({
          format: 'json',
          email: 'test@example.com'
        })
        .expect(202);

      // Simulate WebSocket connections while export is processing
      const testIP = '192.168.1.100';
      const socketIds = ['socket1', 'socket2', 'socket3'];
      
      for (const socketId of socketIds) {
        await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId);
      }

      // Both operations should work independently
      expect(exportResponse.body.success).toBe(true);
      
      const stats = await websocketRateLimitService.getConnectionStats();
      expect(stats.total_connections).toBe(3);
    });

    test('should log both export and rate limit events', async () => {
      // Enable data export
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_data_export',
        true,
        'test_user',
        'Enable for testing'
      );

      // Request export (this should be rate limited)
      await dataExportService.requestExport(testTenantId, 'test@example.com', 'json');
      
      // Try to exceed rate limit
      try {
        await dataExportService.requestExport(testTenantId, 'test@example.com', 'json');
      } catch (error) {
        // Expected - rate limit exceeded
      }

      // Create WebSocket connections to trigger rate limiting
      const maxConnections = websocketRateLimitService.config.maxConnectionsPerIP;
      const testIP = '192.168.1.200';
      
      for (let i = 0; i < maxConnections; i++) {
        await websocketRateLimitService.registerConnection(testIP, testTenantId, `socket${i}`);
      }
      
      // Try to exceed connection limit
      await websocketRateLimitService.checkConnectionLimit(testIP, testTenantId, 'socket_exceed');

      // Check logs
      const exportLogs = await db('data_export_rate_limits').where('tenant_id', testTenantId);
      const wsLogs = await db('websocket_rate_limit_log').where('tenant_id', testTenantId);

      expect(exportLogs.length).toBeGreaterThan(0);
      expect(wsLogs.length).toBeGreaterThan(0);
    });
  });

  describe('All Features Working Together', () => {
    test('should handle complete workflow with all features', async () => {
      // Step 1: Enable all required feature flags
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_data_export',
        true,
        'test_user',
        'Enable for integration test'
      );

      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_websocket_rate_limiting',
        true,
        'test_user',
        'Enable for integration test'
      );

      // Step 2: Set up WebSocket rate limiting
      await db('tenant_rate_limits').insert({
        tenant_id: testTenantId,
        max_connections_per_ip: 5,
        max_connections_per_tenant: 10,
        max_messages_per_second: 15
      });

      // Step 3: Register WebSocket connections
      const testIP = '192.168.1.300';
      const socketIds = ['ws1', 'ws2', 'ws3'];
      
      for (const socketId of socketIds) {
        await websocketRateLimitService.registerConnection(testIP, testTenantId, socketId);
      }

      // Step 4: Request data export
      const exportResponse = await request(app)
        .post('/api/v1/merchants/export-data')
        .set('Authorization', authToken)
        .send({
          format: 'json',
          email: 'integration-test@example.com'
        })
        .expect(202);

      // Step 5: Check feature flag status
      const flagsResponse = await request(app)
        .get('/api/v1/config/flags')
        .set('Authorization', authToken)
        .expect(200);

      expect(flagsResponse.body.data.flags.enable_data_export).toBe(true);
      expect(flagsResponse.body.data.flags.enable_websocket_rate_limiting).toBe(true);

      // Step 6: Check WebSocket statistics
      const wsStats = await websocketRateLimitService.getConnectionStats();
      expect(wsStats.total_connections).toBe(3);
      expect(wsStats.unique_tenants).toBe(1);

      // Step 7: Check export status
      const exportStatus = await request(app)
        .get(`/api/v1/merchants/export-data/${exportResponse.body.data.export_id}/status`)
        .set('Authorization', authToken)
        .expect(200);

      expect(exportStatus.body.data.status).toBeDefined();

      // Step 8: Verify audit logs
      const auditLogs = await tenantConfigurationService.getFlagAuditHistory(
        testTenantId,
        'enable_data_export',
        2
      );

      expect(auditLogs.length).toBeGreaterThan(0);

      // All features should be working together
      expect(exportResponse.body.success).toBe(true);
      expect(flagsResponse.body.success).toBe(true);
      expect(wsStats).toBeDefined();
    });

    test('should maintain performance under load', async () => {
      // Enable all features
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_data_export',
        true,
        'test_user',
        'Performance test'
      );

      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_websocket_rate_limiting',
        true,
        'test_user',
        'Performance test'
      );

      // Measure feature flag evaluation performance
      const iterations = 100;
      const start = process.hrtime.bigint();
      
      for (let i = 0; i < iterations; i++) {
        await tenantConfigurationService.evaluateFeatureFlag(testTenantId, 'enable_data_export');
      }
      
      const end = process.hrtime.bigint();
      const totalTime = Number(end - start) / 1000000;
      const averageTime = totalTime / iterations;

      // Should be under 1ms on average (cached)
      expect(averageTime).toBeLessThan(1);

      // Measure WebSocket rate limiting performance
      const wsStart = process.hrtime.bigint();
      
      for (let i = 0; i < 10; i++) {
        await websocketRateLimitService.checkConnectionLimit('192.168.1.400', testTenantId, `socket${i}`);
      }
      
      const wsEnd = process.hrtime.bigint();
      const wsTotalTime = Number(wsEnd - wsStart) / 1000000;
      const wsAverageTime = wsTotalTime / 10;

      // Should be reasonably fast
      expect(wsAverageTime).toBeLessThan(10);
    });
  });

  describe('Error Handling and Recovery', () => {
    test('should handle service failures gracefully', async () => {
      // Test with Redis failure simulation
      const originalRedis = websocketRateLimitService.redis;
      websocketRateLimitService.redis = null;

      // Should still allow connections (fail-safe)
      const result = await websocketRateLimitService.checkConnectionLimit('192.168.1.500', testTenantId, 'socket_fail');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('ERROR_FALLBACK_ALLOWED');

      // Restore Redis
      websocketRateLimitService.redis = originalRedis;
    });

    test('should maintain data consistency across services', async () => {
      // Update feature flag
      await tenantConfigurationService.updateFeatureFlag(
        testTenantId,
        'enable_data_export',
        true,
        'test_user',
        'Consistency test'
      );

      // Verify flag is enabled
      const flagValue = await tenantConfigurationService.evaluateFeatureFlag(testTenantId, 'enable_data_export');
      expect(flagValue).toBe(true);

      // Request export (should work)
      const exportResponse = await request(app)
        .post('/api/v1/merchants/export-data')
        .set('Authorization', authToken)
        .send({
          format: 'json',
          email: 'consistency-test@example.com'
        })
        .expect(202);

      expect(exportResponse.body.success).toBe(true);

      // Verify audit log consistency
      const auditLog = await tenantConfigurationService.getFlagAuditHistory(
        testTenantId,
        'enable_data_export',
        1
      );

      expect(auditLog[0].new_value).toBe(true);
    });
  });
});
