/**
 * Migration: Add allowed_origins column to merchants table
 */

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function(knex) {
  console.log('[Migration 018] Adding allowed_origins column to merchants...');
  
  const hasColumn = await knex.schema.hasColumn('merchants', 'allowed_origins');
  
  if (!hasColumn) {
    await knex.schema.alterTable('merchants', (table) => {
      // Using text to store JSON array of strings
      table.text('allowed_origins').nullable();
    });
    console.log('[Migration 018] Column added successfully');
  } else {
    console.log('[Migration 018] Column already exists, skipping');
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function(knex) {
  console.log('[Migration 018] Removing allowed_origins column from merchants...');
  
  try {
    await knex.schema.alterTable('merchants', (table) => {
      table.dropColumn('allowed_origins');
    });
    console.log('[Migration 018] Column removed successfully');
  } catch (error) {
    console.error('[Migration 018] Rollback failed:', error);
    throw error;
  }
};
