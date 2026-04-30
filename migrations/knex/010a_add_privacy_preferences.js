
exports.up = function(knex) {
  return knex.schema.createTable('privacy_preferences', (table) => {
    table.string('wallet_address').primary();
    table.boolean('share_email_with_merchants').defaultTo(true);
    table.boolean('allow_marketing').defaultTo(true);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('privacy_preferences');
};
