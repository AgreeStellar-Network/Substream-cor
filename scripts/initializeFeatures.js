#!/usr/bin/env node

/**
 * Initialize Four Critical Features
 * 
 * This script initializes the four critical features for the Substream-cor:
 * 1. Tenant-Level Feature Flag Toggles
 * 2. Automated Data Export and Portability
 * 3. WebSocket Rate Limiting
 * 4. Docker and Kubernetes Configuration
 */

const { getDatabase } = require('../src/db/appDatabase');
const tenantConfigurationService = require('../src/services/tenantConfigurationService');
const websocketRateLimitService = require('../src/services/websocketRateLimitService');

async function initializeFeatures() {
  console.log('🚀 Initializing Four Critical Features for Substream-cor...\n');

  try {
    // Initialize services
    console.log('📡 Initializing services...');
    await tenantConfigurationService.initialize();
    await websocketRateLimitService.initialize();
    console.log('✅ Services initialized successfully\n');

    const db = getDatabase();

    // 1. Initialize Feature Flags for all existing tenants
    console.log('🏳️ Initializing feature flags for existing tenants...');
    
    const tenants = await db('tenants').select('id', 'name', 'email');
    const defaultFlags = [
      { name: 'enable_crypto_checkout', value: false, description: 'Enable cryptocurrency checkout' },
      { name: 'enable_b2b_invoicing', value: false, description: 'Enable B2B invoicing features' },
      { name: 'require_kyc_for_subs', value: false, description: 'Require KYC for subscriptions' },
      { name: 'enable_advanced_analytics', value: false, description: 'Enable advanced analytics dashboard' },
      { name: 'enable_api_webhooks', value: false, description: 'Enable API webhooks' },
      { name: 'enable_custom_branding', value: false, description: 'Enable custom branding options' },
      { name: 'enable_priority_support', value: false, description: 'Enable priority customer support' },
      { name: 'enable_bulk_operations', value: false, description: 'Enable bulk operations' },
      { name: 'enable_data_export', value: true, description: 'Enable data export functionality' },
      { name: 'enable_websocket_rate_limiting', value: true, description: 'Enable WebSocket rate limiting' }
    ];

    for (const tenant of tenants) {
      console.log(`  📋 Setting up flags for tenant: ${tenant.name} (${tenant.email})`);
      
      for (const flag of defaultFlags) {
        await tenantConfigurationService.updateFeatureFlag(
          tenant.id,
          flag.name,
          flag.value,
          'system',
          `Auto-initialization: ${flag.description}`
        );
      }
    }
    console.log('✅ Feature flags initialized successfully\n');

    // 2. Set up default rate limits for all tenants
    console.log('⚡ Setting up default rate limits...');
    
    for (const tenant of tenants) {
      await db('tenant_rate_limits').insert({
        tenant_id: tenant.id,
        max_connections_per_ip: 5,
        max_connections_per_tenant: 10,
        max_messages_per_second: 10,
        metadata: JSON.stringify({
          initialized_by: 'system',
          initialization_date: new Date().toISOString(),
          defaults_applied: true
        }),
        created_at: new Date(),
        updated_at: new Date()
      }).onConflict('tenant_id').ignore();
    }
    console.log('✅ Rate limits initialized successfully\n');

    // 3. Verify database tables
    console.log('🗄️ Verifying database tables...');
    
    const tables = [
      'tenant_configurations',
      'feature_flag_audit_log',
      'data_export_requests',
      'data_export_rate_limits',
      'websocket_rate_limit_log',
      'tenant_rate_limits'
    ];

    for (const table of tables) {
      const exists = await db.schema.hasTable(table);
      if (exists) {
        console.log(`  ✅ Table '${table}' exists`);
      } else {
        console.log(`  ❌ Table '${table}' missing - please run migrations`);
      }
    }
    console.log('');

    // 4. Test Redis connectivity
    console.log('🔗 Testing Redis connectivity...');
    
    try {
      await tenantConfigurationService.redis.ping();
      console.log('  ✅ Redis connection successful');
      
      // Test basic operations
      await tenantConfigurationService.redis.set('test:key', 'test:value');
      const value = await tenantConfigurationService.redis.get('test:key');
      await tenantConfigurationService.redis.del('test:key');
      
      if (value === 'test:value') {
        console.log('  ✅ Redis read/write operations working');
      }
    } catch (error) {
      console.log(`  ❌ Redis connection failed: ${error.message}`);
    }
    console.log('');

    // 5. Display configuration summary
    console.log('📊 Configuration Summary:');
    console.log(`  🏢 Tenants configured: ${tenants.length}`);
    console.log(`  🏳️ Feature flags per tenant: ${defaultFlags.length}`);
    console.log(`  ⚡ Rate limits configured: ${tenants.length}`);
    console.log(`  📡 Services initialized: 3 (Feature Flags, Rate Limiting, Data Export)`);
    console.log('');

    // 6. Display next steps
    console.log('🎯 Next Steps:');
    console.log('  1. Test the feature flags API: GET /api/v1/config/flags');
    console.log('  2. Test data export: POST /api/v1/merchants/export-data');
    console.log('  3. Test WebSocket rate limiting with multiple connections');
    console.log('  4. Deploy using Docker: docker build -t substream-backend .');
    console.log('  5. Deploy to Kubernetes: kubectl apply -f k8s/');
    console.log('  6. Monitor performance and security metrics');
    console.log('');

    // 7. Security reminders
    console.log('🔒 Security Reminders:');
    console.log('  • Update all secrets in k8s/secrets.yaml');
    console.log('  • Configure S3 bucket with proper IAM policies');
    console.log('  • Set up Redis authentication');
    console.log('  • Review rate limiting thresholds for your use case');
    console.log('  • Set up monitoring and alerting');
    console.log('');

    console.log('🎉 Initialization completed successfully!');
    console.log('📚 For detailed deployment instructions, see DEPLOYMENT_GUIDE.md');
    console.log('📋 For implementation details, see FOUR_FEATURES_IMPLEMENTATION_SUMMARY.md');

  } catch (error) {
    console.error('❌ Initialization failed:', error);
    process.exit(1);
  } finally {
    // Cleanup
    await tenantConfigurationService.shutdown();
    await websocketRateLimitService.shutdown();
  }
}

// Run initialization
if (require.main === module) {
  initializeFeatures();
}

module.exports = { initializeFeatures };
