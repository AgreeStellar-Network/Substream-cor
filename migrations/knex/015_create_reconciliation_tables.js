exports.up = function(knex) {
  return knex.schema
    .createTable('reconciliation_gaps', (table) => {
      table.string('id').primary();
      table.string('transaction_hash').notNullable();
      table.string('merchant_id').notNullable();
      table.text('ledger_state').notNullable(); // JSON string
      table.text('internal_state').notNullable(); // JSON string
      table.string('failure_stage').notNullable();
      table.string('status').notNullable().defaultTo('pending');
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    })
    .createTable('accountant_audit_trail', (table) => {
      table.string('id').primary();
      table.string('discrepancy_id').notNullable().references('id').inTable('reconciliation_gaps');
      table.string('accountant_id').notNullable();
      table.string('action').notNullable();
      table.string('previous_status').notNullable();
      table.string('new_status').notNullable();
      table.text('reason').notNullable();
      table.timestamp('timestamp').notNullable().defaultTo(knex.fn.now());
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('accountant_audit_trail')
    .dropTableIfExists('reconciliation_gaps');
};
