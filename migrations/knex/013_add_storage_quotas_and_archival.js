exports.up = async function(knex) {
  await knex.schema
    .createTable('tenant_quotas', (table) => {
      table.string('tenant_id').primary().references('id').inTable('creators');
      table.json('quota_config').notNullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['tenant_id']);
    })
    .createTable('tenant_retention_policies', (table) => {
      table.string('tenant_id').primary().references('id').inTable('creators');
      table.json('retention_config').notNullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.index(['tenant_id']);
    })
    .createTable('archive_logs', (table) => {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('tenant_id').notNullable().references('id').inTable('creators');
      table.string('archive_id').notNullable();
      table.string('table_name').notNullable();
      table.integer('record_count').notNullable();
      table.string('storage_class').notNullable();
      table.string('s3_key').notNullable();
      table.string('upload_id').nullable();
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.index(['tenant_id', 'created_at']);
    })
    .createTable('archive_retrieval_requests', (table) => {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('tenant_id').notNullable().references('id').inTable('creators');
      table.string('archive_id').notNullable();
      table.string('status').notNullable().defaultTo('initiated');
      table.timestamp('requested_at').defaultTo(knex.fn.now());
      table.timestamp('completed_at').nullable();
      table.text('error_message').nullable();
      table.index(['tenant_id', 'requested_at']);
    });
};

exports.down = async function(knex) {
  await knex.schema
    .dropTableIfExists('archive_retrieval_requests')
    .dropTableIfExists('archive_logs')
    .dropTableIfExists('tenant_retention_policies')
    .dropTableIfExists('tenant_quotas');
};
