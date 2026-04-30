exports.up = async function(knex) {
  await knex.schema.createTable('anchor_transactions', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('tenant_id').notNullable();
    table.string('stellar_public_key', 56).notNullable().index();
    table.string('transaction_id', 64).unique().notNullable();
    table.string('anchor_transaction_id', 64).unique();
    table.string('transaction_type').notNullable();
    table.string('asset_code', 12).notNullable();
    table.string('asset_issuer', 56);
    table.decimal('amount', 20, 8).notNullable();
    table.string('amount_in_asset', 64);
    table.string('status', 50).notNullable().defaultTo('pending_user_transfer_start');
    table.text('status_message');
    table.json('transaction_details');
    table.string('session_token', 255).unique();
    table.timestamp('session_expires_at');
    table.string('interactive_url', 2048);
    table.text('customer_memo');
    table.string('bank_account_type', 50);
    table.string('bank_account_number', 255);
    table.string('bank_routing_number', 255);
    table.string('bank_name', 255);
    table.string('bank_country', 2);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('completed_at');
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
    table.index(['tenant_id', 'status']);
  });

  await knex.schema.createTable('sep24_interactive_sessions', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('anchor_transaction_id').notNullable();
    table.string('session_token', 255).unique().notNullable();
    table.string('origin_domain', 255).notNullable();
    table.string('callback_url', 2048);
    table.json('session_data');
    table.string('status', 20).defaultTo('active');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('expires_at').notNullable();
    table.timestamp('completed_at');
    table.foreign('anchor_transaction_id').references('id').inTable('anchor_transactions').onDelete('CASCADE');
  });

  await knex.schema.createTable('anchor_webhook_configs', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('tenant_id').notNullable();
    table.string('anchor_name', 255).notNullable();
    table.string('webhook_url', 2048).notNullable();
    table.string('webhook_secret', 255);
    table.json('supported_assets');
    table.boolean('active').defaultTo(true);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('anchor_webhook_configs');
  await knex.schema.dropTableIfExists('sep24_interactive_sessions');
  await knex.schema.dropTableIfExists('anchor_transactions');
};
