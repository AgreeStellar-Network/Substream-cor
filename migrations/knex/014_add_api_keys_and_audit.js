exports.up = async function(knex) {
  await knex.schema
    .createTable('api_keys', (table) => {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('tenant_id').notNullable().references('id').inTable('creators');
      table.string('name').notNullable();
      table.text('hashed_key').notNullable();
      table.json('permissions').notNullable();
      table.timestamp('expires_at').nullable();
      table.json('metadata').defaultTo('{}');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
      table.timestamp('last_used_at').nullable();
      table.boolean('is_active').defaultTo(true);
      table.index(['tenant_id', 'is_active']);
    })
    .createTable('api_key_audit_logs', (table) => {
      table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
      table.string('tenant_id').notNullable().references('id').inTable('creators');
      table.string('key_id').notNullable().references('id').inTable('api_keys');
      table.string('event').notNullable();
      table.json('metadata').defaultTo('{}');
      table.timestamp('timestamp').defaultTo(knex.fn.now());
      table.string('ip_address').nullable();
      table.text('user_agent').nullable();
      table.index(['tenant_id', 'timestamp']);
    });
};

exports.down = async function(knex) {
  await knex.schema
    .dropTableIfExists('api_key_audit_logs')
    .dropTableIfExists('api_keys');
};
