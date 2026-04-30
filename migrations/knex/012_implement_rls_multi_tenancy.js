exports.up = async function(knex) {
  const tables = ['subscriptions', 'billing_events', 'users', 'creators', 'creator_settings', 'videos'];
  for (const tableName of tables) {
    const hasTable = await knex.schema.hasTable(tableName);
    if (!hasTable) {
        if (tableName === 'creators') {
            await knex.schema.createTable('creators', table => {
                table.string('id').primary();
                table.timestamp('created_at').defaultTo(knex.fn.now());
            });
        } else {
            continue;
        }
    }
    const hasColumn = await knex.schema.hasColumn(tableName, 'tenant_id');
    if (!hasColumn) {
      await knex.schema.table(tableName, table => {
        table.string('tenant_id').notNullable().defaultTo('');
        table.index(['tenant_id']);
      });
    }
  }
};

exports.down = async function(knex) {
  // Not dropping columns to avoid data loss
};
