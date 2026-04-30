/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.createTable('merchants', (table) => {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('name').notNullable();
    table.string('base_currency').notNullable().defaultTo('USD');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    
    table.index('base_currency');
    table.index('created_at');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.dropTable('merchants');
};
