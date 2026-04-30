
exports.up = function(knex) {
  return knex.schema
    .createTable('dunning_sequences', (table) => {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('wallet_address').notNullable();
      table.string('creator_id').notNullable();
      table.string('status').defaultTo('active'); // active, halted, completed
      table.integer('current_day').defaultTo(1);
      table.timestamp('last_notified_at').defaultTo(knex.fn.now());
      table.timestamp('next_notification_at').nullable();
      table.timestamp('started_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      
      table.unique(['wallet_address', 'creator_id', 'status']);
    })
    .createTable('dunning_history', (table) => {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('sequence_id').references('id').inTable('dunning_sequences');
      table.string('event_type').notNullable(); // email_day_1, email_day_4, webhook_day_7, etc.
      table.timestamp('occurred_at').defaultTo(knex.fn.now());
      table.string('status').notNullable(); // success, failed
      table.text('metadata_json').nullable();
    });

};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('dunning_history')
    .dropTableIfExists('dunning_sequences');
};
