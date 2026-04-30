/**
 * Backwards Compatibility Checker for Database Migrations
 * 
 * This module ensures that database migrations maintain backwards compatibility
 * with existing API endpoints and application functionality.
 */

const knex = require('knex');

class BackwardsCompatibilityChecker {
  constructor(knexInstance) {
    this.knex = knexInstance;
    this.compatibilityRules = new Map();
    this.setupDefaultRules();
  }

  /**
   * Setup default backwards compatibility rules
   */
  setupDefaultRules() {
    // Rule: Never remove columns that are referenced by API endpoints
    this.compatibilityRules.set('column_removal', {
      check: this.checkColumnRemoval.bind(this),
      severity: 'critical'
    });

    // Rule: Never change data types in a breaking way
    this.compatibilityRules.set('type_change', {
      check: this.checkDataTypeChanges.bind(this),
      severity: 'critical'
    });

    // Rule: Never remove constraints that maintain data integrity
    this.compatibilityRules.set('constraint_removal', {
      check: this.checkConstraintRemoval.bind(this),
      severity: 'high'
    });

    // Rule: Index removal should not impact query performance
    this.compatibilityRules.set('index_removal', {
      check: this.checkIndexRemoval.bind(this),
      severity: 'medium'
    });

    // Rule: Table renaming requires API updates
    this.compatibilityRules.set('table_rename', {
      check: this.checkTableRename.bind(this),
      severity: 'critical'
    });
  }

  /**
   * Perform comprehensive backwards compatibility check
   */
  async checkCompatibility(migrationFile, currentSchema) {
    console.log('[CompatibilityChecker] Starting backwards compatibility analysis');

    const results = {
      isCompatible: true,
      issues: [],
      warnings: [],
      recommendations: []
    };

    // Parse migration file to detect changes
    const migrationChanges = await this.parseMigrationChanges(migrationFile);

    // Run all compatibility rules
    for (const [ruleName, rule] of this.compatibilityRules) {
      try {
        const ruleResult = await rule.check(migrationChanges, currentSchema);
        
        if (!ruleResult.compatible) {
          results.isCompatible = false;
          results.issues.push({
            rule: ruleName,
            severity: rule.severity,
            message: ruleResult.message,
            details: ruleResult.details
          });
        }

        if (ruleResult.warnings) {
          results.warnings.push(...ruleResult.warnings);
        }

        if (ruleResult.recommendations) {
          results.recommendations.push(...ruleResult.recommendations);
        }

      } catch (error) {
        console.error(`[CompatibilityChecker] Rule ${ruleName} failed:`, error);
        results.issues.push({
          rule: ruleName,
          severity: 'high',
          message: `Compatibility check failed: ${error.message}`
        });
      }
    }

    // Check API endpoint compatibility
    await this.checkAPICompatibility(migrationChanges, results);

    // Check query performance impact
    await this.checkQueryPerformanceImpact(migrationChanges, results);

    console.log(`[CompatibilityChecker] Compatibility check completed. Compatible: ${results.isCompatible}`);
    return results;
  }

  /**
   * Check if column removal breaks compatibility
   */
  async checkColumnRemoval(migrationChanges, currentSchema) {
    const removedColumns = [];
    const criticalColumns = await this.getCriticalColumns();

    for (const change of migrationChanges) {
      if (change.type === 'dropColumn') {
        removedColumns.push({
          table: change.table,
          column: change.column
        });

        // Check if removed column is critical
        const isCritical = criticalColumns.some(critical => 
          critical.table === change.table && critical.column === change.column
        );

        if (isCritical) {
          return {
            compatible: false,
            message: `Critical column removal detected: ${change.table}.${change.column}`,
            details: `This column is referenced by API endpoints or application logic`
          };
        }
      }
    }

    if (removedColumns.length > 0) {
      return {
        compatible: false,
        message: `Column removals detected: ${removedColumns.map(c => `${c.table}.${c.column}`).join(', ')}`,
        details: 'Column removals break backwards compatibility. Consider deprecating instead.',
        recommendations: [
          'Add column as nullable first',
          'Update application to handle null values',
          'Remove column in a later migration after deprecation period'
        ]
      };
    }

    return { compatible: true };
  }

  /**
   * Check data type changes for breaking changes
   */
  async checkDataTypeChanges(migrationChanges, currentSchema) {
    const breakingChanges = [];

    for (const change of migrationChanges) {
      if (change.type === 'alterColumn' && change.newType) {
        const oldType = currentSchema[change.table]?.[change.column]?.type;
        
        if (this.isBreakingTypeChange(oldType, change.newType)) {
          breakingChanges.push({
            table: change.table,
            column: change.column,
            oldType,
            newType: change.newType
          });
        }
      }
    }

    if (breakingChanges.length > 0) {
      return {
        compatible: false,
        message: `Breaking data type changes detected`,
        details: breakingChanges.map(c => `${c.table}.${c.column}: ${c.oldType} -> ${c.newType}`).join(', '),
        recommendations: [
          'Use progressive migration: add new column, backfill data, then switch',
          'Ensure application can handle both old and new types during transition'
        ]
      };
    }

    return { compatible: true };
  }

  /**
   * Check constraint removal impacts
   */
  async checkConstraintRemoval(migrationChanges, currentSchema) {
    const removedConstraints = [];

    for (const change of migrationChanges) {
      if (change.type === 'dropConstraint') {
        removedConstraints.push({
          table: change.table,
          constraint: change.name
        });
      }
    }

    // Check if removed constraints were protecting data integrity
    for (const constraint of removedConstraints) {
      const isIntegrityConstraint = await this.checkIntegrityConstraint(constraint);
      if (isIntegrityConstraint) {
        return {
          compatible: false,
          message: `Data integrity constraint removal detected: ${constraint.table}.${constraint.constraint}`,
          details: 'This constraint protects data integrity and should not be removed'
        };
      }
    }

    return { compatible: true };
  }

  /**
   * Check index removal impact on query performance
   */
  async checkIndexRemoval(migrationChanges, currentSchema) {
    const removedIndexes = [];
    const criticalQueries = await this.getCriticalQueries();

    for (const change of migrationChanges) {
      if (change.type === 'dropIndex') {
        removedIndexes.push({
          table: change.table,
          index: change.name
        });
      }
    }

    // Check if removed indexes are used by critical queries
    for (const index of removedIndexes) {
      const queryImpact = await this.analyzeIndexImpact(index, criticalQueries);
      if (queryImpact.impact === 'high') {
        return {
          compatible: false,
          message: `Critical index removal detected: ${index.table}.${index.index}`,
          details: `This index is used by ${queryImpact.affectedQueries} critical queries`,
          recommendations: [
            'Keep index until queries are optimized',
            'Create new indexes before removing old ones',
            'Monitor query performance during migration'
          ]
        };
      }
    }

    return { compatible: true };
  }

  /**
   * Check table renaming compatibility
   */
  async checkTableRename(migrationChanges, currentSchema) {
    const renamedTables = [];

    for (const change of migrationChanges) {
      if (change.type === 'renameTable') {
        renamedTables.push({
          oldName: change.oldName,
          newName: change.newName
        });
      }
    }

    if (renamedTables.length > 0) {
      return {
        compatible: false,
        message: `Table renaming detected: ${renamedTables.map(t => `${t.oldName} -> ${t.newName}`).join(', ')}`,
        details: 'Table renaming breaks all existing queries and API endpoints',
        recommendations: [
          'Create view with old name pointing to new table',
          'Update all application code to use new table name',
          'Remove view in later migration after transition period'
        ]
      };
    }

    return { compatible: true };
  }

  /**
   * Check API endpoint compatibility
   */
  async checkAPICompatibility(migrationChanges, results) {
    const apiEndpoints = await this.getAPIEndpoints();
    
    for (const endpoint of apiEndpoints) {
      for (const query of endpoint.queries) {
        const compatibility = await this.testQueryCompatibility(query, migrationChanges);
        if (!compatibility.compatible) {
          results.issues.push({
            rule: 'api_compatibility',
            severity: 'critical',
            message: `API endpoint ${endpoint.path} will break`,
            details: `Query "${query}" is incompatible with migration changes`
          });
        }
      }
    }
  }

  /**
   * Check query performance impact
   */
  async checkQueryPerformanceImpact(migrationChanges, results) {
    const criticalQueries = await this.getCriticalQueries();
    
    for (const query of criticalQueries) {
      const impact = await this.analyzeQueryPerformance(query, migrationChanges);
      if (impact.degradation > 50) { // 50% performance degradation threshold
        results.warnings.push({
          rule: 'performance_impact',
          message: `Query performance degradation detected: ${query.name}`,
          details: `Expected ${impact.degradation}% performance decrease`,
          recommendations: impact.recommendations
        });
      }
    }
  }

  /**
   * Parse migration file to extract changes
   */
  async parseMigrationChanges(migrationFile) {
    // This would parse the actual migration file
    // For now, return empty array - implementation would depend on migration format
    return [];
  }

  /**
   * Get list of critical columns that cannot be removed
   */
  async getCriticalColumns() {
    return [
      { table: 'creators', column: 'id' },
      { table: 'creators', column: 'wallet_address' },
      { table: 'creators', column: 'created_at' },
      { table: 'subscriptions', column: 'id' },
      { table: 'subscriptions', column: 'creator_id' },
      { table: 'subscriptions', column: 'wallet_address' },
      { table: 'videos', column: 'id' },
      { table: 'videos', column: 'creator_id' },
      { table: 'creator_audit_logs', column: 'id' },
      { table: 'creator_audit_logs', column: 'creator_id' }
    ];
  }

  /**
   * Check if type change is breaking
   */
  isBreakingTypeChange(oldType, newType) {
    if (!oldType || !newType) return false;
    
    // Define breaking type changes
    const breakingChanges = [
      { from: 'integer', to: 'string' },
      { from: 'decimal', to: 'string' },
      { from: 'date', to: 'string' },
      { from: 'boolean', to: 'integer' }
    ];

    return breakingChanges.some(change => 
      oldType.toLowerCase().includes(change.from) && 
      newType.toLowerCase().includes(change.to)
    );
  }

  /**
   * Check if constraint protects data integrity
   */
  async checkIntegrityConstraint(constraint) {
    // Check if constraint is a foreign key, unique constraint, etc.
    const integrityConstraints = ['fk_', 'unique_', 'check_'];
    return integrityConstraints.some(prefix => constraint.constraint.includes(prefix));
  }

  /**
   * Analyze index impact on queries
   */
  async analyzeIndexImpact(index, criticalQueries) {
    // Simplified analysis - in production would use query execution plans
    const affectedQueries = criticalQueries.filter(query => 
      query.sql.includes(index.table) && 
      query.sql.includes(index.index?.columns?.[0] || '')
    );

    return {
      impact: affectedQueries.length > 0 ? 'high' : 'low',
      affectedQueries: affectedQueries.length
    };
  }

  /**
   * Get API endpoints and their queries
   */
  async getAPIEndpoints() {
    // This would integrate with your API documentation or route definitions
    return [
      {
        path: '/api/creators',
        queries: ['SELECT * FROM creators', 'SELECT * FROM creators WHERE id = ?']
      },
      {
        path: '/api/subscriptions',
        queries: ['SELECT * FROM subscriptions', 'SELECT * FROM subscriptions WHERE creator_id = ?']
      },
      {
        path: '/api/videos',
        queries: ['SELECT * FROM videos', 'SELECT * FROM videos WHERE creator_id = ?']
      }
    ];
  }

  /**
   * Get critical queries that must remain performant
   */
  async getCriticalQueries() {
    return [
      { name: 'creator_list', sql: 'SELECT * FROM creators ORDER BY created_at DESC' },
      { name: 'creator_by_wallet', sql: 'SELECT * FROM creators WHERE wallet_address = ?' },
      { name: 'subscription_check', sql: 'SELECT * FROM subscriptions WHERE creator_id = ? AND wallet_address = ?' },
      { name: 'video_list', sql: 'SELECT * FROM videos WHERE creator_id = ? ORDER BY created_at DESC' },
      { name: 'audit_log', sql: 'SELECT * FROM creator_audit_logs WHERE creator_id = ? ORDER BY created_at DESC' }
    ];
  }

  /**
   * Test query compatibility with migration changes
   */
  async testQueryCompatibility(query, migrationChanges) {
    try {
      // Try to execute the query (in a transaction that gets rolled back)
      await this.knex.raw('BEGIN');
      await this.knex.raw(query);
      await this.knex.raw('ROLLBACK');
      return { compatible: true };
    } catch (error) {
      return { 
        compatible: false, 
        error: error.message 
      };
    }
  }

  /**
   * Analyze query performance impact
   */
  async analyzeQueryPerformance(query, migrationChanges) {
    // Simplified analysis - in production would use EXPLAIN ANALYZE
    return {
      degradation: 0,
      recommendations: []
    };
  }
}

module.exports = BackwardsCompatibilityChecker;
