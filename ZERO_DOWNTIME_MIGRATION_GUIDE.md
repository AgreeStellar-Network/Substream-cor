# Zero-Downtime Migration Strategy Guide

## Overview

This guide outlines the comprehensive zero-downtime database migration strategy implemented for the SubStream Protocol backend. The system ensures database migrations can be performed without service interruption, maintaining backwards compatibility and system reliability.

## Key Components

### 1. ZeroDowntimeMigrationManager
- **Location**: `migrations/ZeroDowntimeMigrationManager.js`
- **Purpose**: Core migration orchestration with health monitoring
- **Features**:
  - Pre-execution health checks
  - Real-time monitoring during migrations
  - Automatic rollback on failure
  - Checkpoint creation for safe rollbacks

### 2. BackwardsCompatibilityChecker
- **Location**: `migrations/BackwardsCompatibilityChecker.js`
- **Purpose**: Ensures migrations don't break existing functionality
- **Features**:
  - Column removal detection
  - Data type change analysis
  - Constraint impact assessment
  - API endpoint compatibility testing

### 3. EnhancedMigrationRunner
- **Location**: `migrations/enhanced_migration_runner.js`
- **Purpose**: Combines zero-downtime capabilities with existing migration system
- **Features**:
  - Migration sequencing
  - Template generation
  - Status monitoring
  - Resource cleanup

### 4. MigrationHealthMonitor
- **Location**: `migrations/MigrationHealthMonitor.js`
- **Purpose**: Real-time health monitoring during migrations
- **Features**:
  - Database response time monitoring
  - Connection pool tracking
  - Lock contention detection
  - Error rate tracking

## Migration Strategy

### Phase-Based Approach

All zero-downtime migrations follow a 4-phase approach:

#### Phase 1: Add New Structure (Non-Breaking)
- Add new columns as nullable
- Create new tables
- Add indexes without blocking
- **Safe**: Doesn't affect existing queries

#### Phase 2: Backfill Data Gradually
- Process data in small batches (1000 records)
- Add delays between batches (100ms)
- Monitor system performance
- **Safe**: Minimal lock contention

#### Phase 3: Update Constraints
- Add NOT NULL constraints after backfill
- Create additional indexes
- Update foreign keys
- **Safe**: Data already populated

#### Phase 4: Application Updates
- Update application code to use new structure
- Remove old columns in separate migration
- Clean up temporary structures
- **Safe**: Application already using new structure

## Usage

### CLI Commands

```bash
# Create new zero-downtime migration
npm run migrate:zero-downtime create <name> --description "Description"

# Test migration compatibility
npm run migrate:test <migration-name>

# Run migration with monitoring
npm run migrate:zero-downtime run <migration-name> --monitor

# Interactive wizard
npm run migrate:wizard

# Check system status
npm run migrate:zero-downtime status --health
```

### Programmatic Usage

```javascript
const EnhancedMigrationRunner = require('./migrations/enhanced_migration_runner');

const runner = new EnhancedMigrationRunner({
  enableZeroDowntime: true,
  enableCompatibilityCheck: true,
  maxRetries: 3,
  healthCheckInterval: 5000
});

// Run migration
await runner.runMigration('my_migration', async (knex) => {
  // Migration logic here
});
```

## Migration Template

```javascript
/**
 * @param { import("knex").Knex } knex
 */
exports.up = async function(knex) {
  console.log('[Migration] Starting zero-downtime migration');
  
  try {
    // Phase 1: Add new structure (non-breaking)
    await phase1_AddNewStructure(knex);
    
    // Phase 2: Backfill data gradually
    await phase2_BackfillData(knex);
    
    // Phase 3: Update constraints (safe after backfill)
    await phase3_UpdateConstraints(knex);
    
    console.log('[Migration] Migration completed successfully');
  } catch (error) {
    console.error('[Migration] Migration failed:', error);
    throw error;
  }
};

exports.down = async function(knex) {
  // Rollback logic
};
```

## Backwards Compatibility Rules

### Critical Rules (Must Pass)
- **Never remove columns** referenced by API endpoints
- **Never change data types** in breaking ways
- **Never rename tables** without migration path
- **Never remove constraints** that protect data integrity

### Warning Rules (Should Review)
- **Index removal** that affects query performance
- **Large data migrations** that may impact performance
- **Constraint additions** that may affect writes

### Recommendations
- Use progressive migration patterns
- Test in staging environment first
- Monitor performance during migration
- Have rollback plan ready

## Health Monitoring

### Metrics Tracked
- Database response time
- Connection pool usage
- Lock contention
- Error rate
- Query performance

### Alert Thresholds
- Response time > 1 second (warning)
- Connection usage > 80% (warning)
- Error rate > 5% (critical)
- Lock time > 30 seconds (warning)

### Health Status Levels
- **Healthy**: All metrics within thresholds
- **Warning**: Some metrics exceed thresholds
- **Error**: Multiple issues detected
- **Critical**: System stability at risk

## Best Practices

### Before Migration
1. **Test compatibility** with `npm run migrate:test`
2. **Check system health** with status command
3. **Backup critical data** if needed
4. **Schedule during low traffic** periods

### During Migration
1. **Monitor health** in real-time
2. **Watch error rates** closely
3. **Be ready to rollback** if issues arise
4. **Communicate status** to team

### After Migration
1. **Verify functionality** works correctly
2. **Check performance** metrics
3. **Clean up temporary** structures
4. **Document changes** for future reference

## Example Migration

See `migrations/knex/018_zero_downtime_user_profile_migration.js` for a complete example of a zero-downtime migration that:

1. Creates new profile tables
2. Backfills existing user data
3. Creates indexes and constraints
4. Includes comprehensive rollback logic

## Troubleshooting

### Common Issues

#### Migration Stuck
- Check database locks: `PRAGMA busy_timeout`
- Monitor connection pool usage
- Verify system resources

#### Compatibility Check Failed
- Review breaking changes
- Consider multi-phase approach
- Test in staging environment

#### Performance Degradation
- Reduce batch size
- Increase delays between batches
- Add indexes before migration

#### Rollback Failed
- Check checkpoint integrity
- Verify backup availability
- Manual intervention may be required

### Emergency Procedures

1. **Stop Migration**: Ctrl+C or kill process
2. **Assess State**: Check migration status
3. **Rollback**: Use rollback command if safe
4. **Restore**: From backup if necessary
5. **Investigate**: Root cause analysis

## Integration with Soroban

The zero-downtime migration system is designed to work seamlessly with Soroban integration:

- **Event Indexer**: Migrations can update Soroban event indexes safely
- **Smart Contract Data**: Migration patterns support blockchain data updates
- **Transaction Processing**: Minimal impact on Soroban transaction processing
- **Audit Trail**: All migrations logged for compliance

## Security Considerations

### Data Protection
- All migrations run with database-level permissions
- Sensitive data handled with care during backfill
- Audit trails maintained for all changes

### Access Control
- Migration execution requires appropriate permissions
- Health monitoring respects data privacy
- Rollback capabilities controlled by authorization

## Performance Impact

### Expected Impact
- **Phase 1**: Minimal impact (structure changes only)
- **Phase 2**: Low to moderate (gradual data processing)
- **Phase 3**: Minimal impact (constraint updates)
- **Overall**: <5% performance degradation typical

### Optimization Techniques
- Small batch sizes (500-1000 records)
- Delays between batches (100-200ms)
- Index creation before data updates
- Connection pool tuning

## Monitoring and Alerting

### Metrics to Monitor
- Migration duration
- Database response times
- Error rates
- Connection pool usage
- Lock contention

### Alert Configuration
- Set up alerts for critical thresholds
- Configure notification channels
- Establish escalation procedures
- Document response playbooks

## Conclusion

This zero-downtime migration strategy provides a robust framework for database schema evolution while maintaining system availability and backwards compatibility. The comprehensive tooling and monitoring ensure migrations can be executed safely with minimal risk to production systems.

For questions or support, refer to the development team or create an issue in the project repository.
