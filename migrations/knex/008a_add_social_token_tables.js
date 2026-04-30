exports.up = function(knex) {
  return knex.schema
    // Social token gated content table
    .createTable('social_token_gated_content', function(table) {
      table.string('content_id').primary().references('id').inTable('content').onDelete('CASCADE');
      table.string('creator_address').notNullable().index();
      table.string('asset_code').notNullable().index();
      table.string('asset_issuer').notNullable().index();
      table.decimal('minimum_balance', 20, 8).notNullable();
      table.integer('verification_interval').defaultTo(60000); // 1 minute default
      table.boolean('active').defaultTo(true).index();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      // Indexes for performance
      table.index(['creator_address', 'active']);
      table.index(['asset_code', 'asset_issuer']);
      table.unique(['content_id']);
    })
    
    // Social token sessions table for balance re-verification
    .createTable('social_token_sessions', function(table) {
      table.string('session_id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('user_address').notNullable().index();
      table.string('content_id').notNullable().references('id').inTable('content').onDelete('CASCADE');
      table.string('asset_code').notNullable().index();
      table.string('asset_issuer').notNullable().index();
      table.decimal('minimum_balance', 20, 8).notNullable();
      table.integer('verification_interval').notNullable();
      table.timestamp('last_verified').defaultTo(knex.fn.now()).index();
      table.boolean('still_valid').defaultTo(true).index();
      table.timestamp('created_at').defaultTo(knex.fn.now()).index();
      
      // Indexes for performance
      table.index(['user_address', 'still_valid']);
      table.index(['content_id', 'still_valid']);
    })

    
    // Social token access logs for analytics
    .createTable('social_token_access_logs', function(table) {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('user_address').notNullable().index();
      table.string('content_id').notNullable().references('id').inTable('content').onDelete('CASCADE');
      table.boolean('has_access').notNullable().index();
      table.boolean('requires_token').notNullable().index();
      table.string('asset_code').index();
      table.string('asset_issuer').index();
      table.decimal('minimum_balance', 20, 8);
      table.string('reason');
      table.timestamp('created_at').defaultTo(knex.fn.now()).index();
      
      // Indexes for analytics queries
      table.index(['user_address', 'created_at']);
      table.index(['content_id', 'created_at']);
      table.index(['has_access', 'created_at']);
      table.index(['asset_code', 'created_at']);
    })
    
    // Update content table to include social token metadata
    .table('content', function(table) {
      table.boolean('requires_social_token').defaultTo(false);
      table.string('social_token_asset_code');
      table.string('social_token_asset_issuer');
      table.decimal('social_token_minimum_balance', 20, 8);
      table.timestamp('social_token_updated_at');
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('social_token_access_logs')
    .dropTableIfExists('social_token_sessions')
    .dropTableIfExists('social_token_gated_content')
    .table('content', function(table) {
      table.dropColumn('requires_social_token');
      table.dropColumn('social_token_asset_code');
      table.dropColumn('social_token_asset_issuer');
      table.dropColumn('social_token_minimum_balance');
      table.dropColumn('social_token_updated_at');
    });
};
