/**
 * Enhanced Migration Runner with Zero-Downtime and Backwards Compatibility
 * 
 * This combines the existing migration system with new zero-downtime capabilities
 * and comprehensive backwards compatibility checking.
 */

const knex = require('knex');
const knexConfig = require('./knexfile');
const ZeroDowntimeMigrationManager = require('./ZeroDowntimeMigrationManager');
const BackwardsCompatibilityChecker = require('./BackwardsCompatibilityChecker');

class EnhancedMigrationRunner {
  constructor(options = {}) {
    this.knex = knex(knexConfig);
    this.zeroDowntimeManager = new ZeroDowntimeMigrationManager(knexConfig, options);
    this.compatibilityChecker = new BackwardsCompatibilityChecker(this.knex);
    this.options = {
      enableZeroDowntime: true,
      enableCompatibilityCheck: true,
      maxRetries: 3,
      healthCheckInterval: 5000,
      ...options
    };
  }

  /**
   * Run migration with comprehensive zero-downtime safeguards
   */
  async runMigration(migrationName, migrationFunction) {
    console.log(`[EnhancedMigration] Starting migration: ${migrationName}`);
    
    const startTime = Date.now();
    const migrationContext = {
      name: migrationName,
      startTime,
      status: 'running'
    };

    try {
      // Step 1: Pre-migration checks
      if (this.options.enableCompatibilityCheck) {
        await this.performCompatibilityCheck(migrationName);
      }

      // Step 2: Get current schema snapshot
      const beforeSchema = await this.zeroDowntimeManager.getCurrentSchema();
      
      // Step 3: Execute with zero-downtime manager if enabled
      if (this.options.enableZeroDowntime) {
        const result = await this.zeroDowntimeManager.executeMigration(
          migrationName, 
          migrationFunction
        );
        
        migrationContext.status = 'completed';
        migrationContext.duration = Date.now() - startTime;
        
        console.log(`[EnhancedMigration] Migration completed successfully: ${migrationName}`);
        return result;
      } else {
        // Fallback to standard migration
        await migrationFunction(this.knex);
        migrationContext.status = 'completed';
        migrationContext.duration = Date.now() - startTime;
        
        console.log(`[EnhancedMigration] Standard migration completed: ${migrationName}`);
        return { success: true, migrationName, duration: migrationContext.duration };
      }

    } catch (error) {
      migrationContext.status = 'failed';
      migrationContext.error = error.message;
      
      console.error(`[EnhancedMigration] Migration failed: ${migrationName}`, error);
      throw error;
    }
  }

  /**
   * Perform backwards compatibility check
   */
  async performCompatibilityCheck(migrationName) {
    console.log(`[EnhancedMigration] Checking backwards compatibility for: ${migrationName}`);
    
    try {
      const currentSchema = await this.zeroDowntimeManager.getCurrentSchema();
      const migrationFile = await this.getMigrationFile(migrationName);
      
      const compatibilityResult = await this.compatibilityChecker.checkCompatibility(
        migrationFile, 
        currentSchema
      );

      if (!compatibilityResult.isCompatible) {
        const errorMessage = `Backwards compatibility check failed for ${migrationName}:\n` +
          compatibilityResult.issues.map(issue => `- ${issue.message}`).join('\n');
        
        throw new Error(errorMessage);
      }

      if (compatibilityResult.warnings.length > 0) {
        console.warn(`[EnhancedMigration] Compatibility warnings for ${migrationName}:`);
        compatibilityResult.warnings.forEach(warning => {
          console.warn(`  - ${warning.message}`);
        });
      }

      console.log(`[EnhancedMigration] Backwards compatibility verified for: ${migrationName}`);
      
    } catch (error) {
      console.error(`[EnhancedMigration] Compatibility check failed:`, error);
      throw error;
    }
  }

  /**
   * Get migration file content
   */
  async getMigrationFile(migrationName) {
    // This would read the actual migration file
    // For now, return a placeholder
    return {
      name: migrationName,
      content: `// Migration content for ${migrationName}`
    };
  }

  /**
   * Run multiple migrations in sequence with safeguards
   */
  async runMigrationSequence(migrations) {
    console.log(`[EnhancedMigration] Running migration sequence with ${migrations.length} migrations`);
    
    const results = [];
    const failedMigrations = [];

    for (const migration of migrations) {
      try {
        const result = await this.runMigration(migration.name, migration.function);
        results.push(result);
        
        // Wait between migrations to allow system to stabilize
        if (this.options.migrationDelay) {
          await new Promise(resolve => setTimeout(resolve, this.options.migrationDelay));
        }
        
      } catch (error) {
        failedMigrations.push({
          name: migration.name,
          error: error.message
        });
        
        // Stop on first failure or continue based on configuration
        if (!this.options.continueOnFailure) {
          break;
        }
      }
    }

    return {
      success: failedMigrations.length === 0,
      completed: results,
      failed: failedMigrations,
      summary: {
        total: migrations.length,
        completed: results.length,
        failed: failedMigrations.length
      }
    };
  }

  /**
   * Create a new migration with zero-downtime template
   */
  async createMigration(name, description) {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];
    const filename = `${timestamp}_${name}.js`;
    const filepath = `./migrations/knex/${filename}`;

    const template = this.generateMigrationTemplate(name, description, timestamp);
    
    // Write migration file
    const fs = require('fs').promises;
    await fs.writeFile(filepath, template);
    
    console.log(`[EnhancedMigration] Created migration: ${filename}`);
    return filename;
  }

  /**
   * Generate migration template with zero-downtime patterns
   */
  generateMigrationTemplate(name, description, timestamp) {
    return `/**
 * Migration: ${name}
 * Description: ${description}
 * Created: ${timestamp}
 * 
 * Zero-Downtime Migration Pattern:
 * 1. Add new columns/tables (non-breaking)
 * 2. Backfill data in batches
 * 3. Update application logic to use new structure
 * 4. Remove old structure (in separate migration)
 */

/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function(knex) {
  console.log('[Migration] Starting zero-downtime migration: ${name}');
  
  try {
    // Phase 1: Add new structure (non-breaking)
    await phase1_AddNewStructure(knex);
    
    // Phase 2: Backfill data gradually
    await phase2_BackfillData(knex);
    
    // Phase 3: Update constraints (safe after backfill)
    await phase3_UpdateConstraints(knex);
    
    console.log('[Migration] Migration completed successfully: ${name}');
  } catch (error) {
    console.error('[Migration] Migration failed:', error);
    throw error;
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function(knex) {
  console.log('[Migration] Rolling back migration: ${name}');
  
  try {
    // Reverse the migration phases
    await rollbackPhase3_UpdateConstraints(knex);
    await rollbackPhase2_BackfillData(knex);
    await rollbackPhase1_AddNewStructure(knex);
    
    console.log('[Migration] Rollback completed: ${name}');
  } catch (error) {
    console.error('[Migration] Rollback failed:', error);
    throw error;
  }
};

/**
 * Phase 1: Add new columns/tables (always non-breaking)
 */
async function phase1_AddNewStructure(knex) {
  console.log('[Migration] Phase 1: Adding new structure...');
  
  // Example: Add new column as nullable
  // await knex.schema.alterTable('example_table', (table) => {
  //   table.string('new_column').nullable().defaultTo(null);
  // });
  
  // Example: Create new table
  // await knex.schema.createTable('new_table', (table) => {
  //   table.increments('id').primary();
  //   table.string('name').notNullable();
  //   table.timestamps(true, true);
  // });
  
  console.log('[Migration] Phase 1 completed');
}

/**
 * Phase 2: Backfill data in small batches
 */
async function phase2_BackfillData(knex) {
  console.log('[Migration] Phase 2: Backfilling data...');
  
  const BATCH_SIZE = 1000;
  const DELAY_MS = 100;
  
  let offset = 0;
  let processedCount = 0;
  
  while (true) {
    // Get batch of records that need backfilling
    const batch = await knex('example_table')
      .whereNull('new_column')
      .limit(BATCH_SIZE)
      .offset(offset);
    
    if (batch.length === 0) {
      console.log(\`[Migration] Backfill complete. Processed \${processedCount} records\`);
      break;
    }
    
    // Update this batch
    await Promise.all(batch.map(record => 
      knex('example_table')
        .where('id', record.id)
        .update({ new_column: generateValue(record) })
    ));
    
    processedCount += batch.length;
    offset += BATCH_SIZE;
    
    console.log(\`[Migration] Backfilled \${processedCount} records...\`);
    
    // Small delay to allow normal traffic
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }
  
  console.log('[Migration] Phase 2 completed');
}

/**
 * Phase 3: Update constraints (safe after backfill)
 */
async function phase3_UpdateConstraints(knex) {
  console.log('[Migration] Phase 3: Updating constraints...');
  
  // Example: Add NOT NULL constraint after backfill
  // await knex.schema.alterTable('example_table', (table) => {
  //   table.string('new_column').notNullable().alter();
  // });
  
  // Example: Create index
  // await knex.raw(\`
  //   CREATE INDEX IF NOT EXISTS idx_example_table_new_column 
  //   ON example_table (new_column)
  // \`);
  
  console.log('[Migration] Phase 3 completed');
}

/**
 * Rollback functions - reverse the migration phases
 */
async function rollbackPhase3_UpdateConstraints(knex) {
  console.log('[Migration] Rolling back Phase 3...');
  // Reverse constraint changes
}

async function rollbackPhase2_BackfillData(knex) {
  console.log('[Migration] Rolling back Phase 2...');
  // Data backfill is usually not reversible - just log
}

async function rollbackPhase1_AddNewStructure(knex) {
  console.log('[Migration] Rolling back Phase 1...');
  // Reverse structure changes
}

/**
 * Helper function to generate backfill values
 */
function generateValue(record) {
  // Implement your business logic here
  return 'generated_value';
}
`;
  }

  /**
   * Get migration status and health
   */
  async getMigrationStatus() {
    const status = {
      isRunning: this.zeroDowntimeManager.migrationState.isRunning,
      currentMigration: this.zeroDowntimeManager.migrationState.currentMigration,
      healthStatus: this.zeroDowntimeManager.migrationState.healthStatus,
      uptime: this.zeroDowntimeManager.migrationState.startTime ? 
        Date.now() - this.zeroDowntimeManager.migrationState.startTime : 0
    };

    // Add database health
    try {
      await this.knex.raw('SELECT 1');
      status.databaseHealth = 'healthy';
    } catch (error) {
      status.databaseHealth = 'unhealthy';
      status.databaseError = error.message;
    }

    return status;
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    try {
      await this.knex.destroy();
      console.log('[EnhancedMigration] Cleanup completed');
    } catch (error) {
      console.error('[EnhancedMigration] Cleanup error:', error);
    }
  }
}

module.exports = EnhancedMigrationRunner;

// CLI interface
if (require.main === module) {
  const runner = new EnhancedMigrationRunner();
  
  // Example usage
  runner.runMigration('example_migration', async (knex) => {
    // Migration logic here
    console.log('Running example migration...');
  })
  .then((result) => {
    console.log('Migration completed:', result);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
}
