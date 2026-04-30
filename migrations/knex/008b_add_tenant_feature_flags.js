/**
 * Add Tenant Feature Flags and Configuration Tables
 * 
 * This migration creates:
 * - tenant_configurations: Stores feature flags and configuration per tenant
 * - feature_flag_audit_log: Immutable audit trail for all configuration changes
 */

exports.up = async function(knex) {
  // Create tenant_configurations table
  await knex.schema.createTable('tenant_configurations', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('tenant_id').notNullable();
    table.string('flag_name', 100).notNullable();
    table.boolean('flag_value').defaultTo(false);
    table.json('metadata').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    // Indexes for performance
    table.index(['tenant_id'], 'idx_tenant_config_tenant');
    table.index(['flag_name'], 'idx_tenant_config_flag');
    table.unique(['tenant_id', 'flag_name'], 'uk_tenant_flag');
    
    // Foreign key constraint (assuming tenants table exists)
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });

  // Create feature_flag_audit_log table
  await knex.schema.createTable('feature_flag_audit_log', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('tenant_id').notNullable();
    table.string('flag_name', 100).notNullable();
    table.boolean('old_value');
    table.boolean('new_value').notNullable();
    table.string('changed_by', 255).notNullable(); // User or system that made the change
    table.string('change_reason', 500);
    table.json('metadata').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    // Indexes for audit queries
    table.index(['tenant_id'], 'idx_audit_tenant');
    table.index(['flag_name'], 'idx_audit_flag');
    table.index(['created_at'], 'idx_audit_timestamp');
    
    // Foreign key constraint
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });

  // Insert default feature flags for all existing tenants
  await knex.raw(`
    INSERT INTO tenant_configurations (tenant_id, flag_name, flag_value, metadata)
    SELECT 
      t.id as tenant_id,
      f.flag_name,
      f.default_value,
      '{"auto_created": true}' as metadata
    FROM tenants t
    CROSS JOIN (
      SELECT 'enable_crypto_checkout' AS flag_name, 0 AS default_value
      UNION ALL SELECT 'enable_b2b_invoicing', 0
      UNION ALL SELECT 'require_kyc_for_subs', 0
      UNION ALL SELECT 'enable_advanced_analytics', 0
      UNION ALL SELECT 'enable_api_webhooks', 0
      UNION ALL SELECT 'enable_custom_branding', 0
      UNION ALL SELECT 'enable_priority_support', 0
      UNION ALL SELECT 'enable_bulk_operations', 0
    ) AS f
    WHERE NOT EXISTS (
      SELECT 1 FROM tenant_configurations tc 
      WHERE tc.tenant_id = t.id AND tc.flag_name = f.flag_name
    )
  `);
};


exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('feature_flag_audit_log');
  await knex.schema.dropTableIfExists('tenant_configurations');
};
