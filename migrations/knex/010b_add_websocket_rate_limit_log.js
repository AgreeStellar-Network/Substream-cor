exports.up = async function(knex) {
  await knex.schema.createTable('websocket_rate_limit_log', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('event_type', 50).notNullable();
    table.string('client_ip', 45).notNullable();
    table.string('tenant_id').nullable();
    table.json('details').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index(['event_type']);
    table.index(['client_ip']);
    table.index(['tenant_id']);
    table.index(['created_at']);
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('SET NULL');
  });

  await knex.schema.createTable('tenant_rate_limits', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('tenant_id').notNullable().unique();
    table.integer('max_connections_per_ip').defaultTo(null);
    table.integer('max_connections_per_tenant').defaultTo(null);
    table.integer('max_messages_per_second').defaultTo(null);
    table.json('metadata').defaultTo('{}');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index(['tenant_id']);
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('tenant_rate_limits');
  await knex.schema.dropTableIfExists('websocket_rate_limit_log');
};
