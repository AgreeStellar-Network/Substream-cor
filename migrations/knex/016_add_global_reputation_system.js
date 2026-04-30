exports.up = async function(knex) {
  await knex.schema.createTable('global_reputation_scores', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('wallet_address', 56).notNullable().unique().index();
    table.string('hashed_identifier', 64).unique().index();
    table.decimal('reputation_score', 5, 2).notNullable().defaultTo(100.00);
    table.string('risk_level', 20).notNullable().defaultTo('low');
    table.integer('total_flags').notNullable().defaultTo(0);
    table.integer('malicious_dispute_flags').notNullable().defaultTo(0);
    table.integer('allowance_exploitation_flags').notNullable().defaultTo(0);
    table.integer('fraud_flags').notNullable().defaultTo(0);
    table.integer('spam_flags').notNullable().defaultTo(0);
    table.json('flag_details');
    table.timestamp('last_flagged_at');
    table.timestamp('last_reviewed_at');
    table.string('last_reviewed_by_tenant');
    table.text('review_notes');
    table.boolean('auto_rejection_enabled').defaultTo(false);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index(['reputation_score']);
  });

  await knex.schema.createTable('reputation_events', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('global_reputation_id').notNullable();
    table.string('tenant_id').notNullable();
    table.string('wallet_address', 56).notNullable();
    table.string('event_type', 50).notNullable();
    table.decimal('score_impact', 5, 2).notNullable();
    table.decimal('previous_score', 5, 2);
    table.decimal('new_score', 5, 2);
    table.text('reason');
    table.json('event_metadata');
    table.string('flagged_by_tenant_name', 255);
    table.string('flagged_by_user_id');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.foreign('global_reputation_id').references('id').inTable('global_reputation_scores').onDelete('CASCADE');
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });

  await knex.schema.createTable('tenant_reputation_settings', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('tenant_id').notNullable().unique();
    table.boolean('global_reputation_enabled').defaultTo(true);
    table.decimal('warning_threshold', 5, 2).defaultTo(70.00);
    table.decimal('blocking_threshold', 5, 2).defaultTo(30.00);
    table.boolean('auto_rejection_enabled').defaultTo(false);
    table.json('custom_flag_weights');
    table.boolean('share_flags_with_global').defaultTo(true);
    table.boolean('receive_global_flags').defaultTo(true);
    table.integer('flags_required_for_review').defaultTo(3);
    table.text('rejection_message_template');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.foreign('tenant_id').references('id').inTable('tenants').onDelete('CASCADE');
  });

  await knex.schema.createTable('reputation_review_queue', function(table) {
    table.string('id').primary().defaultTo(knex.raw('(lower(hex(randomblob(16))))'));
    table.string('global_reputation_id').notNullable();
    table.string('assigned_to_tenant_id');
    table.string('priority', 20).defaultTo('medium');
    table.string('status', 20).defaultTo('pending');
    table.text('review_reason');
    table.json('review_context');
    table.timestamp('assigned_at');
    table.timestamp('review_started_at');
    table.timestamp('review_completed_at');
    table.string('reviewed_by_user_id');
    table.text('review_decision');
    table.text('review_notes');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.foreign('global_reputation_id').references('id').inTable('global_reputation_scores').onDelete('CASCADE');
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('reputation_review_queue');
  await knex.schema.dropTableIfExists('tenant_reputation_settings');
  await knex.schema.dropTableIfExists('reputation_events');
  await knex.schema.dropTableIfExists('global_reputation_scores');
};
