/**
 * Seasonal Pause ("Deferred Billing") Tables
 *
 * Supports off-chain bulk pause of subscription billing for seasonal merchants
 * (e.g. winter sports streaming) without requiring on-chain mutations per user.
 *
 * - seasonal_pauses tracks the lifecycle of a pause window for a (merchant, plan).
 * - subscription_skipped_cycles records every billing cycle that was skipped
 *   while a plan was Seasonally_Inactive, so cycles can be reconciled on resume.
 * - subscriptions gains seasonal_status / paused_pause_id / paused_next_billing_date
 *   so the indexer skip-logic can short-circuit pull attempts safely.
 */
exports.up = async function up(knex) {
  const hasPauses = await knex.schema.hasTable('seasonal_pauses');
  if (!hasPauses) {
    await knex.schema.createTable('seasonal_pauses', (table) => {
      table.string('id').primary();
      table.string('merchant_id').notNullable().index();
      table.string('plan_id').notNullable().index();
      table.string('status').notNullable().defaultTo('active');
      table.text('reason').nullable();
      table.timestamp('paused_at').notNullable();
      table.string('paused_by').nullable();
      table.timestamp('expected_resume_at').nullable();
      table.timestamp('resumed_at').nullable();
      table.string('resumed_by').nullable();
      table.integer('subscriptions_affected').notNullable().defaultTo(0);
      table.integer('skipped_cycles_count').notNullable().defaultTo(0);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      table.index(['merchant_id', 'status']);
      table.index(['plan_id', 'status']);
    });

    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_seasonal_pauses_one_active_per_plan
         ON seasonal_pauses (plan_id) WHERE status = 'active'`
    );
  }

  const hasSkipped = await knex.schema.hasTable('subscription_skipped_cycles');
  if (!hasSkipped) {
    await knex.schema.createTable('subscription_skipped_cycles', (table) => {
      table.string('id').primary();
      table.string('pause_id').notNullable().index().references('id').inTable('seasonal_pauses');
      table.string('merchant_id').notNullable().index();
      table.string('plan_id').notNullable().index();
      table.string('creator_id').notNullable();
      table.string('wallet_address').notNullable();
      table.timestamp('scheduled_billing_date').notNullable();
      table.decimal('required_amount', 20, 8).notNullable().defaultTo(0);
      table.timestamp('skipped_at').notNullable().defaultTo(knex.fn.now());
      table.boolean('reconciled').notNullable().defaultTo(false);
      table.timestamp('reconciled_at').nullable();

      table.unique(['pause_id', 'creator_id', 'wallet_address', 'scheduled_billing_date']);
      table.index(['creator_id', 'wallet_address']);
    });
  }

  const hasSeasonalStatus = await knex.schema.hasColumn('subscriptions', 'seasonal_status');
  if (!hasSeasonalStatus) {
    await knex.schema.alterTable('subscriptions', (table) => {
      table.string('seasonal_status').nullable().defaultTo('Active');
    });
  }

  const hasPausedPauseId = await knex.schema.hasColumn('subscriptions', 'paused_pause_id');
  if (!hasPausedPauseId) {
    await knex.schema.alterTable('subscriptions', (table) => {
      table.string('paused_pause_id').nullable();
    });
  }

  const hasPausedNextBillingDate = await knex.schema.hasColumn(
    'subscriptions',
    'paused_next_billing_date'
  );
  if (!hasPausedNextBillingDate) {
    await knex.schema.alterTable('subscriptions', (table) => {
      table.timestamp('paused_next_billing_date').nullable();
    });
  }

  const hasBillingIntervalDays = await knex.schema.hasColumn(
    'subscriptions',
    'billing_interval_days'
  );
  if (!hasBillingIntervalDays) {
    await knex.schema.alterTable('subscriptions', (table) => {
      table.integer('billing_interval_days').notNullable().defaultTo(30);
    });
  }

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_seasonal_status
       ON subscriptions (seasonal_status)`
  );
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_paused_pause_id
       ON subscriptions (paused_pause_id)`
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('subscription_skipped_cycles');
  await knex.schema.dropTableIfExists('seasonal_pauses');
  // Subscription columns are left in place: dropping columns in SQLite requires
  // table rebuilds, and the columns are harmless when unused.
};
