const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');

/**
 * Stripe-to-Substream Migration Service
 * Handles CSV parsing, plan mapping, and migration link generation
 */
class StripeMigrationService {
  constructor(database) {
    this.database = database;
    this.ensureMigrationTables();
  }

  /**
   * Ensure migration-related database tables exist
   */
  ensureMigrationTables() {
    try {
      // Create migration jobs table
      this.database.db.exec(`
        CREATE TABLE IF NOT EXISTS migration_jobs (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          total_records INTEGER DEFAULT 0,
          processed_records INTEGER DEFAULT 0,
          failed_records INTEGER DEFAULT 0,
          stripe_plan_mappings TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          error_message TEXT
        );
      `);

      // Create migration records table
      this.database.db.exec(`
        CREATE TABLE IF NOT EXISTS migration_records (
          id TEXT PRIMARY KEY,
          migration_job_id TEXT NOT NULL REFERENCES migration_jobs(id),
          customer_email TEXT NOT NULL,
          stripe_plan_id TEXT NOT NULL,
          substream_plan_id TEXT NOT NULL,
          renewal_date TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          migration_link TEXT,
          stellar_public_key TEXT,
          linked_at TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // Create merchant plan mappings table
      this.database.db.exec(`
        CREATE TABLE IF NOT EXISTS merchant_plan_mappings (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL,
          stripe_plan_id TEXT NOT NULL,
          substream_plan_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(merchant_id, stripe_plan_id)
        );
      `);

      // Create indexes for performance
      this.database.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_migration_jobs_merchant_id ON migration_jobs(merchant_id);
        CREATE INDEX IF NOT EXISTS idx_migration_records_job_id ON migration_records(migration_job_id);
        CREATE INDEX IF NOT EXISTS idx_migration_records_email ON migration_records(customer_email);
        CREATE INDEX IF NOT EXISTS idx_migration_records_status ON migration_records(status);
        CREATE INDEX IF NOT EXISTS idx_merchant_plan_mappings_merchant_id ON merchant_plan_mappings(merchant_id);
      `);
    } catch (error) {
      console.error('Failed to create migration tables:', error);
      throw error;
    }
  }

  /**
   * Parse Stripe CSV export and extract customer data
   * @param {string} csvFilePath - Path to the CSV file
   * @param {string} merchantId - Merchant identifier
   * @param {Object} planMappings - Stripe plan to Substream plan mappings
   * @returns {Object} Migration job results
   */
  async processStripeCSV(csvFilePath, merchantId, planMappings) {
    const jobId = crypto.randomUUID();
    const startTime = new Date().toISOString();

    try {
      // Validate inputs
      if (!fs.existsSync(csvFilePath)) {
        throw new Error('CSV file not found');
      }

      if (!merchantId || !planMappings) {
        throw new Error('Merchant ID and plan mappings are required');
      }

      // Create migration job record
      this.database.db.prepare(`
        INSERT INTO migration_jobs (id, merchant_id, status, stripe_plan_mappings, created_at)
        VALUES (?, ?, 'processing', ?, ?)
      `).run(jobId, merchantId, JSON.stringify(planMappings), startTime);

      // Parse CSV file
      const csvData = await this.parseStripeCSV(csvFilePath);
      
      // Process each record
      const results = {
        total: csvData.length,
        processed: 0,
        failed: 0,
        records: []
      };

      for (const record of csvData) {
        try {
          const migrationRecord = await this.processCustomerRecord(record, jobId, planMappings);
          results.records.push(migrationRecord);
          results.processed++;
        } catch (error) {
          console.error(`Failed to process record for ${record.customerEmail}:`, error);
          results.failed++;
          
          // Create failed record
          const failedRecord = {
            id: crypto.randomUUID(),
            migrationJobId: jobId,
            customerEmail: record.customerEmail,
            stripePlanId: record.stripePlanId,
            substreamPlanId: null,
            renewalDate: record.renewalDate,
            status: 'failed',
            migrationLink: null,
            stellarPublicKey: null,
            linkedAt: null,
            errorMessage: error.message,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          this.database.db.prepare(`
            INSERT INTO migration_records (
              id, migration_job_id, customer_email, stripe_plan_id, substream_plan_id,
              renewal_date, status, migration_link, stellar_public_key, linked_at,
              error_message, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            failedRecord.id, failedRecord.migrationJobId, failedRecord.customerEmail,
            failedRecord.stripePlanId, failedRecord.substreamPlanId, failedRecord.renewalDate,
            failedRecord.status, failedRecord.migrationLink, failedRecord.stellarPublicKey,
            failedRecord.linkedAt, failedRecord.errorMessage, failedRecord.createdAt,
            failedRecord.updatedAt
          );
        }
      }

      // Update migration job status
      const completionTime = new Date().toISOString();
      this.database.db.prepare(`
        UPDATE migration_jobs 
        SET status = 'completed', total_records = ?, processed_records = ?, 
            failed_records = ?, completed_at = ?
        WHERE id = ?
      `).run(results.total, results.processed, results.failed, completionTime, jobId);

      return {
        success: true,
        jobId,
        results
      };

    } catch (error) {
      // Update job with error
      this.database.db.prepare(`
        UPDATE migration_jobs 
        SET status = 'failed', error_message = ?, completed_at = ?
        WHERE id = ?
      `).run(error.message, new Date().toISOString(), jobId);

      throw error;
    }
  }

  /**
   * Parse Stripe CSV export file
   * @param {string} csvFilePath - Path to CSV file
   * @returns {Array} Parsed customer records
   */
  async parseStripeCSV(csvFilePath) {
    try {
      const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      const processedRecords = [];

      for (const record of records) {
        try {
          const processedRecord = this.extractCustomerData(record);
          if (processedRecord) {
            processedRecords.push(processedRecord);
          }
        } catch (error) {
          console.warn(`Skipping malformed row: ${error.message}`);
          // Continue processing other records
        }
      }

      return processedRecords;
    } catch (error) {
      throw new Error(`Failed to parse CSV file: ${error.message}`);
    }
  }

  /**
   * Extract relevant customer data from CSV row
   * @param {Object} csvRow - Raw CSV row data
   * @returns {Object} Processed customer record
   */
  extractCustomerData(csvRow) {
    // Stripe CSV export typically contains these columns (may vary by export type)
    const possibleEmailFields = ['Email', 'Customer Email', 'email', 'customer_email'];
    const possiblePlanFields = ['Plan', 'Subscription Plan', 'Plan ID', 'plan', 'subscription_plan'];
    const possibleRenewalFields = ['Renewal Date', 'Next Billing Date', 'renewal_date', 'next_billing_date'];
    const possibleStatusFields = ['Status', 'Subscription Status', 'status', 'subscription_status'];

    // Find the actual column names
    const emailField = possibleEmailFields.find(field => csvRow[field] !== undefined);
    const planField = possiblePlanFields.find(field => csvRow[field] !== undefined);
    const renewalField = possibleRenewalFields.find(field => csvRow[field] !== undefined);
    const statusField = possibleStatusFields.find(field => csvRow[field] !== undefined);

    if (!emailField || !csvRow[emailField]) {
      throw new Error('Missing or empty customer email');
    }

    if (!planField || !csvRow[planField]) {
      throw new Error('Missing or empty plan information');
    }

    const customerEmail = csvRow[emailField].trim();
    const stripePlanId = csvRow[planField].trim();
    const renewalDate = renewalField && csvRow[renewalField] ? this.parseDate(csvRow[renewalField]) : null;
    const status = statusField ? csvRow[statusField].trim() : 'unknown';

    // Validate email format
    if (!this.isValidEmail(customerEmail)) {
      throw new Error(`Invalid email format: ${customerEmail}`);
    }

    // Only process active subscriptions
    if (status.toLowerCase() !== 'active' && status.toLowerCase() !== 'trialing') {
      return null; // Skip inactive subscriptions
    }

    return {
      customerEmail,
      stripePlanId,
      renewalDate,
      status
    };
  }

  /**
   * Process individual customer record and create migration record
   * @param {Object} customerRecord - Customer data from CSV
   * @param {string} jobId - Migration job ID
   * @param {Object} planMappings - Plan mapping configuration
   * @returns {Object} Migration record
   */
  async processCustomerRecord(customerRecord, jobId, planMappings) {
    const recordId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Find corresponding Substream plan
    const substreamPlanId = planMappings[customerRecord.stripePlanId];
    if (!substreamPlanId) {
      throw new Error(`No mapping found for Stripe plan: ${customerRecord.stripePlanId}`);
    }

    // Generate migration link
    const migrationLink = this.generateMigrationLink(recordId, customerRecord.customerEmail);

    // Create migration record
    const migrationRecord = {
      id: recordId,
      migrationJobId: jobId,
      customerEmail: customerRecord.customerEmail,
      stripePlanId: customerRecord.stripePlanId,
      substreamPlanId: substreamPlanId,
      renewalDate: customerRecord.renewalDate,
      status: 'pending',
      migrationLink,
      stellarPublicKey: null,
      linkedAt: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now
    };

    this.database.db.prepare(`
      INSERT INTO migration_records (
        id, migration_job_id, customer_email, stripe_plan_id, substream_plan_id,
        renewal_date, status, migration_link, stellar_public_key, linked_at,
        error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      migrationRecord.id, migrationRecord.migrationJobId, migrationRecord.customerEmail,
      migrationRecord.stripePlanId, migrationRecord.substreamPlanId, migrationRecord.renewalDate,
      migrationRecord.status, migrationRecord.migrationLink, migrationRecord.stellarPublicKey,
      migrationRecord.linkedAt, migrationRecord.errorMessage, migrationRecord.createdAt,
      migrationRecord.updatedAt
    );

    return migrationRecord;
  }

  /**
   * Generate secure migration link for customer
   * @param {string} recordId - Migration record ID
   * @param {string} email - Customer email
   * @returns {string} Migration link URL
   */
  generateMigrationLink(recordId, email) {
    const timestamp = Date.now();
    const signature = crypto
      .createHmac('sha256', process.env.MIGRATION_SECRET || 'default-migration-secret')
      .update(`${recordId}:${email}:${timestamp}`)
      .digest('hex');

    const baseUrl = process.env.FRONTEND_URL || 'https://app.substream.app';
    return `${baseUrl}/migrate?record=${recordId}&email=${encodeURIComponent(email)}&ts=${timestamp}&sig=${signature}`;
  }

  /**
   * Verify migration link signature
   * @param {string} recordId - Migration record ID
   * @param {string} email - Customer email
   * @param {string} timestamp - Link timestamp
   * @param {string} signature - Link signature
   * @returns {boolean} Whether the link is valid
   */
  verifyMigrationLink(recordId, email, timestamp, signature) {
    const expectedSignature = crypto
      .createHmac('sha256', process.env.MIGRATION_SECRET || 'default-migration-secret')
      .update(`${recordId}:${email}:${timestamp}`)
      .digest('hex');

    // Check if signature matches and link is not expired (24 hours)
    const isValid = signature === expectedSignature;
    const isNotExpired = (Date.now() - parseInt(timestamp)) < 24 * 60 * 60 * 1000;

    return isValid && isNotExpired;
  }

  /**
   * Complete migration by linking wallet to email
   * @param {string} recordId - Migration record ID
   * @param {string} stellarPublicKey - Customer's Stellar public key
   * @returns {Object} Migration completion result
   */
  async completeMigration(recordId, stellarPublicKey) {
    try {
      // Get migration record
      const record = this.database.db.prepare(`
        SELECT * FROM migration_records WHERE id = ? AND status = 'pending'
      `).get(recordId);

      if (!record) {
        throw new Error('Migration record not found or already processed');
      }

      // Update record with wallet information
      const now = new Date().toISOString();
      this.database.db.prepare(`
        UPDATE migration_records 
        SET stellar_public_key = ?, linked_at = ?, status = 'completed', updated_at = ?
        WHERE id = ?
      `).run(stellarPublicKey, now, now, recordId);

      // Create subscription in the main subscriptions table
      await this.createSubscriptionFromMigration(record, stellarPublicKey);

      return {
        success: true,
        message: 'Migration completed successfully',
        recordId,
        stellarPublicKey,
        substreamPlanId: record.substreamPlanId
      };

    } catch (error) {
      // Update record with error
      this.database.db.prepare(`
        UPDATE migration_records 
        SET status = 'failed', error_message = ?, updated_at = ?
        WHERE id = ?
      `).run(error.message, new Date().toISOString(), recordId);

      throw error;
    }
  }

  /**
   * Create subscription record from migration
   * @param {Object} migrationRecord - Migration record
   * @param {string} stellarPublicKey - Customer's Stellar public key
   */
  async createSubscriptionFromMigration(migrationRecord, stellarPublicKey) {
    // Extract creator ID from substream plan ID or use merchant ID
    const creatorId = this.extractCreatorIdFromPlan(migrationRecord.substreamPlanId);
    
    // Create or activate subscription
    this.database.createOrActivateSubscription(creatorId, stellarPublicKey);

    // Update subscription with migration metadata
    this.database.db.prepare(`
      UPDATE subscriptions 
      SET user_email = ?, migrated_from_stripe = 1, stripe_plan_id = ?
      WHERE creator_id = ? AND wallet_address = ?
    `).run(migrationRecord.customerEmail, migrationRecord.stripePlanId, creatorId, stellarPublicKey);
  }

  /**
   * Extract creator ID from Substream plan ID
   * @param {string} planId - Substream plan ID
   * @returns {string} Creator ID
   */
  extractCreatorIdFromPlan(planId) {
    // Assuming plan ID format: creatorId_planName or similar
    // This should be adapted based on actual plan ID structure
    const parts = planId.split('_');
    return parts[0] || planId;
  }

  /**
   * Get migration job status and results
   * @param {string} jobId - Migration job ID
   * @returns {Object} Job status and results
   */
  getMigrationJobStatus(jobId) {
    const job = this.database.db.prepare(`
      SELECT * FROM migration_jobs WHERE id = ?
    `).get(jobId);

    if (!job) {
      throw new Error('Migration job not found');
    }

    const records = this.database.db.prepare(`
      SELECT * FROM migration_records WHERE migration_job_id = ?
      ORDER BY created_at DESC
    `).all(jobId);

    return {
      ...job,
      stripePlanMappings: JSON.parse(job.stripe_plan_mappings),
      records
    };
  }

  /**
   * Validate email format
   * @param {string} email - Email address
   * @returns {boolean} Whether email is valid
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Parse date from various Stripe date formats
   * @param {string} dateString - Date string from CSV
   * @returns {string} ISO date string
   */
  parseDate(dateString) {
    if (!dateString) return null;

    try {
      // Handle various date formats Stripe might export
      const date = new Date(dateString);
      return date.toISOString();
    } catch (error) {
      console.warn(`Failed to parse date: ${dateString}`);
      return null;
    }
  }

  /**
   * Save merchant plan mappings
   * @param {string} merchantId - Merchant ID
   * @param {Object} mappings - Plan mappings
   */
  savePlanMappings(merchantId, mappings) {
    const now = new Date().toISOString();

    for (const [stripePlanId, substreamPlanId] of Object.entries(mappings)) {
      this.database.db.prepare(`
        INSERT OR REPLACE INTO merchant_plan_mappings (id, merchant_id, stripe_plan_id, substream_plan_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), merchantId, stripePlanId, substreamPlanId, now);
    }
  }

  /**
   * Get merchant plan mappings
   * @param {string} merchantId - Merchant ID
   * @returns {Object} Plan mappings
   */
  getPlanMappings(merchantId) {
    const mappings = this.database.db.prepare(`
      SELECT stripe_plan_id, substream_plan_id FROM merchant_plan_mappings WHERE merchant_id = ?
    `).all(merchantId);

    const result = {};
    mappings.forEach(mapping => {
      result[mapping.stripe_plan_id] = mapping.substream_plan_id;
    });

    return result;
  }
}

module.exports = StripeMigrationService;
