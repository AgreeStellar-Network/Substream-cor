exports.up = async function(knex) {
  await knex.schema.createTable('monitoring_alerts', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('endpoint', 255).notNullable().index();
    table.string('severity', 20).notNullable();
    table.string('alert_type', 50).notNullable();
    table.integer('error_count').notNullable();
    table.integer('threshold').notNullable();
    table.integer('monitoring_window').notNullable();
    table.json('alert_data');
    table.boolean('acknowledged').defaultTo(false);
    table.string('acknowledged_by');
    table.timestamp('acknowledged_at');
    table.text('acknowledgment_notes');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index(['endpoint', 'created_at']);
  });

  await knex.schema.createTable('monitoring_notifications', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('name', 255).notNullable();
    table.string('notification_type', 50).notNullable();
    table.string('recipient', 255);
    table.string('endpoint_patterns', 1000);
    table.string('severity_filter', 20).defaultTo('critical');
    table.boolean('active').defaultTo(true);
    table.string('webhook_secret', 255);
    table.json('notification_config');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('endpoint_performance_metrics', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('endpoint', 255).notNullable().index();
    table.string('method', 10).notNullable();
    table.timestamp('window_start').notNullable().index();
    table.timestamp('window_end').notNullable();
    table.integer('total_requests').notNullable().defaultTo(0);
    table.integer('total_errors').notNullable().defaultTo(0);
    table.integer('total_5xx_errors').notNullable().defaultTo(0);
    table.decimal('avg_response_time', 10, 3).defaultTo(0);
    table.decimal('p95_response_time', 10, 3).defaultTo(0);
    table.decimal('p99_response_time', 10, 3).defaultTo(0);
    table.decimal('error_rate', 5, 2).defaultTo(0);
    table.decimal('throughput', 10, 2).defaultTo(0);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.unique(['endpoint', 'method', 'window_start']);
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('endpoint_performance_metrics');
  await knex.schema.dropTableIfExists('monitoring_notifications');
  await knex.schema.dropTableIfExists('monitoring_alerts');
};
