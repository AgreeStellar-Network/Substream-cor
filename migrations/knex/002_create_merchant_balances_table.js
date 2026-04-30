/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.createTable('merchant_balances', (table) => {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('merchant_id').notNullable().references('id').inTable('merchants').onDelete('CASCADE');
    table.string('asset_code').notNullable(); // e.g., 'XLM', 'USDC', 'EURC'
    table.string('asset_issuer').nullable(); // Stellar asset issuer
    table.decimal('balance', 20, 8).notNullable().defaultTo(0);
    table.timestamp('last_updated').defaultTo(knex.fn.now());
    
    table.unique(['merchant_id', 'asset_code']);
    table.index('merchant_id');
    table.index('asset_code');
    table.index('last_updated');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.dropTable('merchant_balances');
};
