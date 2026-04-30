/**
 * Sanctions Screening Tables
 *
 * Stores the result of every OFAC / global-sanctions check we run, plus the
 * status of every screened wallet (so requests from BLOCKED accounts can be
 * rejected at the middleware layer without re-querying the upstream provider).
 *
 * - screened_users         : the per-wallet status row (the "User" status the
 *                            issue refers to). account_status is the gate
 *                            checked by the request-time middleware.
 * - security_audit         : append-only audit log of every screening event,
 *                            with provider identity, risk score, and reason
 *                            for the flag. Satisfies regulatory reporting.
 * - sanctions_review_queue : compliance-officer worklist for false-positive
 *                            review. cleared addresses are unblocked and
 *                            re-screening is suppressed via override_until.
 */
exports.up = async function up(knex) {
  const hasScreenedUsers = await knex.schema.hasTable('screened_users');
  if (!hasScreenedUsers) {
    await knex.schema.createTable('screened_users', (table) => {
      table.string('wallet_address').primary();
      table.string('account_status').notNullable().defaultTo('ACTIVE');
      table.string('risk_level').nullable();
      table.decimal('risk_score', 10, 4).nullable();
      table.text('flagged_lists').nullable();
      table.text('block_reason').nullable();
      table.string('blocking_provider').nullable();
      table.timestamp('last_screened_at').nullable();
      table.string('last_audit_id').nullable();
      table.timestamp('blocked_at').nullable();
      table.timestamp('unblocked_at').nullable();
      table.string('unblocked_by').nullable();
      table.timestamp('override_until').nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      table.index(['account_status']);
      table.index(['risk_level']);
      table.index(['last_screened_at']);
    });
  }

  const hasSecurityAudit = await knex.schema.hasTable('security_audit');
  if (!hasSecurityAudit) {
    await knex.schema.createTable('security_audit', (table) => {
      table.string('id').primary();
      table.string('wallet_address').notNullable().index();
      table.string('event_type').notNullable();
      table.string('provider').nullable();
      table.string('risk_level').nullable();
      table.decimal('risk_score', 10, 4).nullable();
      table.text('flagged_lists').nullable();
      table.text('reason').nullable();
      table.text('provider_response').nullable();
      table.string('triggering_action').nullable();
      table.string('actor').nullable();
      table.string('ip_address').nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      table.index(['wallet_address', 'created_at']);
      table.index(['event_type', 'created_at']);
      table.index(['provider', 'created_at']);
    });
  }

  const hasReviewQueue = await knex.schema.hasTable('sanctions_review_queue');
  if (!hasReviewQueue) {
    await knex.schema.createTable('sanctions_review_queue', (table) => {
      table.string('id').primary();
      table.string('wallet_address').notNullable();
      table.string('triggering_audit_id').nullable();
      table.string('status').notNullable().defaultTo('open');
      table.string('risk_level').nullable();
      table.decimal('risk_score', 10, 4).nullable();
      table.text('flagged_lists').nullable();
      table.text('reason').nullable();
      table.timestamp('submitted_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('reviewed_at').nullable();
      table.string('reviewed_by').nullable();
      table.text('decision_notes').nullable();

      table.index(['wallet_address', 'status']);
      table.index(['status', 'submitted_at']);
    });

    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_sanctions_review_queue_one_open_per_wallet
         ON sanctions_review_queue (wallet_address) WHERE status = 'open'`
    );
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('sanctions_review_queue');
  await knex.schema.dropTableIfExists('security_audit');
  await knex.schema.dropTableIfExists('screened_users');
};
