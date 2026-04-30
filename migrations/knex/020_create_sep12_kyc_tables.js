/**
 * SEP-12 KYC Tables
 *
 * customer_profiles        : Stores encrypted PII per Stellar pubkey.
 *                            All sensitive fields are AES-256 ciphertext blobs.
 * merchant_kyc_requirements: Per-merchant tier requirements that drive
 *                            "requirement masking" — which fields are needed
 *                            before a customer is cleared for a given plan.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('customer_profiles', (table) => {
    table.string('id').primary().defaultTo(knex.raw("(lower(hex(randomblob(16))))"));
    table.string('stellar_account').notNullable().unique();

    // Encrypted PII blobs (AES-256-GCM, base64-encoded: iv:authTag:ciphertext)
    table.text('enc_full_name').nullable();
    table.text('enc_address').nullable();
    table.text('enc_date_of_birth').nullable();
    table.text('enc_id_photo_cid').nullable();   // IPFS CID of uploaded ID document

    // KYC status managed by SumSub webhook
    table.string('verification_status').notNullable().defaultTo('NEEDS_INFO');
    // NEEDS_INFO | PENDING | APPROVED | REJECTED

    table.string('sumsub_applicant_id').nullable().unique();
    table.text('rejection_reason').nullable();

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.index(['stellar_account']);
    table.index(['verification_status']);
  });

  await knex.schema.createTable('merchant_kyc_requirements', (table) => {
    table.string('id').primary().defaultTo(knex.raw("(lower(hex(randomblob(16))))"));
    table.string('merchant_id').notNullable();
    table.string('tier_name').notNullable();   // e.g. 'Tier_1', 'Tier_2'

    // Which fields are required for this merchant/tier combination
    table.boolean('requires_full_name').notNullable().defaultTo(true);
    table.boolean('requires_address').notNullable().defaultTo(false);
    table.boolean('requires_date_of_birth').notNullable().defaultTo(false);
    table.boolean('requires_id_photo').notNullable().defaultTo(false);

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['merchant_id', 'tier_name']);
    table.index(['merchant_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('merchant_kyc_requirements');
  await knex.schema.dropTableIfExists('customer_profiles');
};
