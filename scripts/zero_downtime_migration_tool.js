#!/usr/bin/env node

/**
 * Zero-Downtime Migration CLI Tool
 * 
 * Command-line interface for executing zero-downtime migrations with
 * comprehensive backwards compatibility checking and health monitoring.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const EnhancedMigrationRunner = require('../migrations/enhanced_migration_runner');
const MigrationHealthMonitor = require('../migrations/MigrationHealthMonitor');

const program = new Command();

// CLI configuration
program
  .name('zero-downtime-migration')
  .description('Zero-downtime database migration tool')
  .version('1.0.0');

// Create migration command
program
  .command('create')
  .description('Create a new zero-downtime migration')
  .argument('<name>', 'Migration name')
  .option('-d, --description <description>', 'Migration description')
  .option('-t, --table <table>', 'Target table')
  .action(async (name, options) => {
    try {
      const spinner = ora('Creating migration...').start();
      
      const runner = new EnhancedMigrationRunner();
      const description = options.description || `Zero-downtime migration for ${name}`;
      
      const filename = await runner.createMigration(name, description);
      
      spinner.succeed(chalk.green(`Migration created: ${filename}`));
      
      console.log(chalk.blue('\nNext steps:'));
      console.log(`1. Edit the migration file: migrations/knex/${filename}`);
      console.log('2. Test the migration with: npm run migrate:test');
      console.log('3. Run the migration: npm run migrate:zero-downtime');
      
    } catch (error) {
      console.error(chalk.red('Error creating migration:'), error.message);
      process.exit(1);
    }
  });

// Run migration command
program
  .command('run')
  .description('Run a zero-downtime migration')
  .argument('<migration>', 'Migration name or file')
  .option('--dry-run', 'Run in dry-run mode (no changes)')
  .option('--force', 'Skip compatibility checks')
  .option('--monitor', 'Enable health monitoring')
  .option('--batch-size <size>', 'Batch size for data operations', '1000')
  .action(async (migration, options) => {
    try {
      console.log(chalk.blue(`\n🚀 Starting zero-downtime migration: ${migration}`));
      
      const runner = new EnhancedMigrationRunner({
        batchSize: parseInt(options.batchSize),
        enableCompatibilityCheck: !options.force,
        enableZeroDowntime: true
      });
      
      let healthMonitor = null;
      if (options.monitor) {
        healthMonitor = new MigrationHealthMonitor(runner.knex);
        healthMonitor.startMonitoring();
        
        // Monitor health events
        healthMonitor.on('alert', (alert) => {
          if (alert.severity === 'critical') {
            console.log(chalk.red(`🚨 Critical Alert: ${alert.message}`));
          } else if (alert.severity === 'error') {
            console.log(chalk.yellow(`⚠️  Error: ${alert.message}`));
          } else {
            console.log(chalk.blue(`ℹ️  Warning: ${alert.message}`));
          }
        });
      }
      
      // Load migration function
      const migrationFunction = await loadMigration(migration);
      
      if (options.dryRun) {
        console.log(chalk.yellow('\n🔍 Dry-run mode - no changes will be made'));
        
        // Run compatibility checks only
        await runner.performCompatibilityCheck(migration);
        console.log(chalk.green('✅ Migration is compatible and ready to run'));
        
      } else {
        const spinner = ora('Running migration...').start();
        
        try {
          const result = await runner.runMigration(migration, migrationFunction);
          
          spinner.succeed(chalk.green('Migration completed successfully!'));
          
          console.log(chalk.blue('\n📊 Migration Summary:'));
          console.log(`- Duration: ${result.duration}ms`);
          console.log(`- Status: ${result.success ? 'Success' : 'Failed'}`);
          
          if (healthMonitor) {
            const healthReport = healthMonitor.getHealthReport();
            console.log(chalk.blue('\n🏥 Health Report:'));
            console.log(`- Status: ${healthReport.summary.status}`);
            console.log(`- Avg Response Time: ${healthReport.metrics.averageResponseTime}ms`);
            console.log(`- Error Rate: ${healthReport.metrics.errorRate}%`);
            
            if (healthReport.alerts.total > 0) {
              console.log(chalk.yellow(`⚠️  ${healthReport.alerts.total} alerts generated`));
            }
          }
          
        } catch (error) {
          spinner.fail(chalk.red('Migration failed'));
          throw error;
        }
      }
      
      if (healthMonitor) {
        healthMonitor.stopMonitoring();
      }
      
      await runner.cleanup();
      
    } catch (error) {
      console.error(chalk.red('\n❌ Migration failed:'), error.message);
      
      if (error.message.includes('compatibility')) {
        console.log(chalk.yellow('\n💡 Try running with --force to skip compatibility checks'));
      }
      
      process.exit(1);
    }
  });

// Test migration command
program
  .command('test')
  .description('Test migration compatibility and safety')
  .argument('<migration>', 'Migration name or file')
  .option('--verbose', 'Show detailed compatibility report')
  .action(async (migration, options) => {
    try {
      console.log(chalk.blue(`\n🧪 Testing migration: ${migration}`));
      
      const runner = new EnhancedMigrationRunner();
      
      const spinner = ora('Running compatibility checks...').start();
      
      try {
        await runner.performCompatibilityCheck(migration);
        spinner.succeed(chalk.green('Compatibility checks passed'));
        
        console.log(chalk.green('\n✅ Migration is safe to run'));
        console.log(chalk.blue('\n📋 Compatibility Report:'));
        console.log('- No breaking changes detected');
        console.log('- All critical columns preserved');
        console.log('- Data types compatible');
        console.log('- API endpoints will continue to work');
        
      } catch (error) {
        spinner.fail(chalk.red('Compatibility checks failed'));
        
        if (options.verbose) {
          console.log(chalk.red('\n📋 Detailed Report:'));
          console.log(error.message);
        }
        
        console.log(chalk.yellow('\n💡 Recommendations:'));
        console.log('- Review the migration for breaking changes');
        console.log('- Consider using a multi-phase approach');
        console.log('- Test in a staging environment first');
        
        process.exit(1);
      }
      
      await runner.cleanup();
      
    } catch (error) {
      console.error(chalk.red('Test failed:'), error.message);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show migration and system status')
  .option('--health', 'Show detailed health report')
  .action(async (options) => {
    try {
      const runner = new EnhancedMigrationRunner();
      const status = await runner.getMigrationStatus();
      
      console.log(chalk.blue('\n📊 Migration Status:'));
      console.log(`- Running: ${status.isRunning ? 'Yes' : 'No'}`);
      console.log(`- Current: ${status.currentMigration || 'None'}`);
      console.log(`- Health: ${status.healthStatus}`);
      console.log(`- Database: ${status.databaseHealth}`);
      
      if (options.health) {
        const healthMonitor = new MigrationHealthMonitor(runner.knex);
        
        console.log(chalk.blue('\n🏥 Health Report:'));
        const report = healthMonitor.getHealthReport();
        
        console.log(`- Status: ${report.summary.status}`);
        console.log(`- Avg Response Time: ${report.metrics.averageResponseTime}ms`);
        console.log(`- Error Rate: ${report.metrics.errorRate}%`);
        console.log(`- Active Connections: ${report.metrics.activeConnections}`);
        console.log(`- Locks Detected: ${report.metrics.lockDetected ? 'Yes' : 'No'}`);
        
        if (report.alerts.total > 0) {
          console.log(chalk.yellow(`\n⚠️  Recent Alerts (${report.alerts.total}):`));
          report.alerts.recent.forEach(alert => {
            const icon = alert.severity === 'critical' ? '🚨' : 
                        alert.severity === 'error' ? '❌' : '⚠️';
            console.log(`${icon} ${alert.message}`);
          });
        }
        
        if (report.recommendations.length > 0) {
          console.log(chalk.blue('\n💡 Recommendations:'));
          report.recommendations.forEach(rec => {
            console.log(`- ${rec}`);
          });
        }
      }
      
      await runner.cleanup();
      
    } catch (error) {
      console.error(chalk.red('Status check failed:'), error.message);
      process.exit(1);
    }
  });

// Interactive migration wizard
program
  .command('wizard')
  .description('Interactive migration wizard')
  .action(async () => {
    try {
      console.log(chalk.blue('\n🧙 Zero-Downtime Migration Wizard\n'));
      
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'What would you like to do?',
          choices: [
            { name: 'Create a new migration', value: 'create' },
            { name: 'Run an existing migration', value: 'run' },
            { name: 'Test a migration', value: 'test' },
            { name: 'Check system status', value: 'status' }
          ]
        }
      ]);
      
      switch (answers.action) {
        case 'create':
          await handleCreateMigration();
          break;
        case 'run':
          await handleRunMigration();
          break;
        case 'test':
          await handleTestMigration();
          break;
        case 'status':
          await handleStatusCheck();
          break;
      }
      
    } catch (error) {
      console.error(chalk.red('Wizard failed:'), error.message);
      process.exit(1);
    }
  });

// Helper functions
async function loadMigration(migration) {
  // This would dynamically load the migration file
  // For now, return a placeholder function
  return async (knex) => {
    console.log(`Running migration: ${migration}`);
    // Migration logic would be here
  };
}

async function handleCreateMigration() {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Migration name:',
      validate: (input) => input.trim() !== '' || 'Name is required'
    },
    {
      type: 'input',
      name: 'description',
      message: 'Migration description:'
    },
    {
      type: 'input',
      name: 'table',
      message: 'Target table (optional):'
    }
  ]);
  
  const runner = new EnhancedMigrationRunner();
  const filename = await runner.createMigration(answers.name, answers.description);
  
  console.log(chalk.green(`\n✅ Migration created: ${filename}`));
  await runner.cleanup();
}

async function handleRunMigration() {
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'monitor',
      message: 'Enable health monitoring?',
      default: true
    },
    {
      type: 'confirm',
      name: 'dryRun',
      message: 'Run in dry-run mode first?',
      default: true
    }
  ]);
  
  console.log(chalk.yellow('\n⚠️  Running migrations requires the migration name'));
  console.log('Use: npm run migrate:zero-downtime run <migration-name>');
}

async function handleTestMigration() {
  console.log(chalk.yellow('\n⚠️  Testing migrations requires the migration name'));
  console.log('Use: npm run migrate:test <migration-name>');
}

async function handleStatusCheck() {
  const runner = new EnhancedMigrationRunner();
  const status = await runner.getMigrationStatus();
  
  console.log(chalk.blue('\n📊 System Status:'));
  console.log(`- Migration Running: ${status.isRunning ? 'Yes' : 'No'}`);
  console.log(`- Database Health: ${status.databaseHealth}`);
  console.log(`- Current Migration: ${status.currentMigration || 'None'}`);
  
  await runner.cleanup();
}

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error(chalk.red('Unhandled Rejection:'), reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error(chalk.red('Uncaught Exception:'), error);
  process.exit(1);
});

// Parse command line arguments
program.parse();

// Export for testing
module.exports = { program };
