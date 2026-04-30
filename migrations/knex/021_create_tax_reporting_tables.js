exports.up = async function up(knex) {
  await knex.schema.createTable('tax_reportable_transactions', (table) => {
    table.string('id').primary();
    table.string('user_address').notNullable();
    table.string('merchant_id').nullable();
    table.string('asset_code').notNullable();
    table.decimal('amount', 36, 12).notNullable();
    table.string('transaction_kind').notNullable();
    table.timestamp('occurred_at').notNullable();
    table.text('metadata_json').nullable();

    table.index(['occurred_at']);
    table.index(['user_address']);
    table.index(['merchant_id']);
  });

  await knex.schema.createTable('tax_report_audit_log', (table) => {
    table.string('id').primary();
    table.string('report_id').notNullable();
    table.integer('version').notNullable();
    table.string('status').notNullable();
    table.string('schema_version').notNullable();
    table.integer('reporting_year').notNullable();
    table.string('jurisdiction').notNullable();
    table.string('primary_currency').notNullable();
    table.string('payload_hash').notNullable();
    table.string('previous_hash').nullable();
    table.text('payload_json').notNullable();
    table.text('payload_xml').notNullable();
    table.string('generated_by').notNullable();
    table.string('signed_off_by').nullable();
    table.timestamp('signed_off_at').nullable();
    table.timestamp('retention_until').notNullable();
    table.timestamp('created_at').notNullable();

    table.unique(['report_id', 'version']);
    table.index(['report_id', 'version']);
    table.index(['reporting_year', 'jurisdiction']);
  });

  await knex.schema.createTable('tax_report_signoffs', (table) => {
    table.string('id').primary();
    table.string('report_id').notNullable();
    table.integer('version').notNullable();
    table.string('signed_off_by').notNullable();
    table.timestamp('signed_off_at').notNullable();
    table.text('notes').nullable();
    table.string('payload_hash').notNullable();

    table.index(['report_id', 'version']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tax_report_signoffs');
  await knex.schema.dropTableIfExists('tax_report_audit_log');
  await knex.schema.dropTableIfExists('tax_reportable_transactions');
};
