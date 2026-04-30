exports.up = async function(knex) {
  await knex.schema.createTable('data_export_requests', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('tenant_id').notNullable();
    table.string('status', 50).defaultTo('pending');
    table.string('requester_email', 255).notNullable();
    table.string('export_format', 20).defaultTo('json');
    table.string('s3_url').nullable();
    table.timestamp('s3_url_expires_at').nullable();
    table.json('export_metadata').defaultTo('{}');
    table.text('error_message').nullable();
    table.timestamp('requested_at').defaultTo(knex.fn.now());
    table.timestamp('started_at').nullable();
    table.timestamp('completed_at').nullable();
    table.index(['tenant_id']);
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });

  await knex.schema.createTable('data_export_rate_limits', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('tenant_id').notNullable();
    table.timestamp('last_export_at').defaultTo(knex.fn.now());
    table.integer('export_count').defaultTo(1);
    table.timestamp('period_start').defaultTo(knex.fn.now());
    table.json('metadata').defaultTo('{}');
    table.index(['tenant_id']);
    table.unique(['tenant_id']);
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('data_export_rate_limits');
  await knex.schema.dropTableIfExists('data_export_requests');
};
