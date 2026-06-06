# Database Migration Failure Runbook

This runbook provides step-by-step procedures for handling failed database migrations and performing safe rollbacks in the Substream-cor.

## Table of Contents

1. [Immediate Response](#immediate-response)
2. [Diagnosis](#diagnosis)
3. [Rollback Procedures](#rollback-procedures)
4. [Post-Incident Actions](#post-incident-actions)
5. [Prevention Strategies](#prevention-strategies)

---

## Immediate Response

### Step 1: Stop the Deployment

When a migration fails, the Kubernetes deployment will automatically stop. However, verify that no pods are running with the new version:

```bash
# Check deployment status
kubectl get deployment substream-backend -n substream

# Check pod status
kubectl get pods -n substream -l app=substream-backend

# If any new pods are running, scale to 0
kubectl scale deployment substream-backend --replicas=0 -n substream
```

### Step 2: Preserve the Current State

Before making any changes, gather diagnostic information:

```bash
# Get migration job logs
kubectl logs job/substream-backend-migration -n substream > migration-failure.log

# Get initContainer logs (if using initContainer strategy)
kubectl logs <pod-name> -c migration -n substream > migration-init-failure.log

# Get database lock status
kubectl exec -it <pod-name> -n substream -- node -e "
const knex = require('knex');
const db = knex({ client: 'better-sqlite3', connection: { filename: '/app/data/substream.db' } });
db('_migration_locks').select('*').then(console.log).finally(() => db.destroy());
"

# List current migration status
kubectl exec -it <pod-name> -n substream -- npx knex migrate:list
```

### Step 3: Notify Stakeholders

Notify the following teams immediately:
- Engineering team
- Database team (if separate)
- DevOps/SRE team
- Product team (if user-facing impact is expected)

---

## Diagnosis

### Step 1: Analyze the Failure

Review the migration logs to identify the root cause:

```bash
# Check for common error patterns
grep -i "error" migration-failure.log
grep -i "timeout" migration-failure.log
grep -i "lock" migration-failure.log
grep -i "permission" migration-failure.log
```

### Step 2: Categorize the Failure

#### Category A: Lock Acquisition Failure
**Symptoms:**
- "Lock already held" error
- "Timeout waiting for migration lock"

**Diagnosis:**
- Another migration is in progress
- Previous migration crashed without releasing lock
- Lock timeout is too short

**Resolution:**
```bash
# Manually release the lock (emergency only)
kubectl exec -it <pod-name> -n substream -- node -e "
const knex = require('knex');
const db = knex({ client: 'better-sqlite3', connection: { filename: '/app/data/substream.db' } });
db('_migration_locks').where('lock_key', 'schema_migration').del().then(() => console.log('Lock released')).finally(() => db.destroy());
"
```

#### Category B: Schema Conflict
**Symptoms:**
- "Table already exists"
- "Column already exists"
- "Duplicate key error"

**Diagnosis:**
- Migration was partially applied
- Manual schema changes were made
- Migration files are out of order

**Resolution:**
```bash
# Check which migrations have been applied
kubectl exec -it <pod-name> -n substream -- npx knex migrate:list

# If migration is partially applied, manually complete or rollback
kubectl exec -it <pod-name> -n substream -- npx knex migrate:rollback
```

#### Category C: Data Integrity Error
**Symptoms:**
- "Foreign key constraint"
- "Check constraint violation"
- "Cannot truncate table"

**Diagnosis:**
- Data conflicts with new schema
- Referential integrity issues
- Data type mismatches

**Resolution:**
1. Fix data issues manually
2. Create a data migration script
3. Re-run the schema migration

#### Category D: Timeout Error
**Symptoms:**
- "Migration timeout after Xms"
- "Query execution timeout"

**Diagnosis:**
- Long-running migration (e.g., adding index to large table)
- Insufficient resources
- Database performance issues

**Resolution:**
1. Increase migration timeout in values.yaml
2. Add more resources to migration job
3. Optimize the migration (see [Long-Running Migrations](#long-running-migrations))

#### Category E: Permission Error
**Symptoms:**
- "Permission denied"
- "Access denied"

**Diagnosis:**
- Insufficient database privileges
- Vault role misconfiguration
- Service account lacks permissions

**Resolution:**
1. Verify Vault policy
2. Check database role permissions
3. Update service account annotations

---

## Rollback Procedures

### Option 1: Automatic Rollback (Recommended)

The migration script includes automatic rollback on failure. If this didn't trigger, manually rollback:

```bash
# Rollback last migration batch
kubectl exec -it <pod-name> -n substream -- npx knex migrate:rollback

# Verify rollback
kubectl exec -it <pod-name> -n substream -- npx knex migrate:list
```

### Option 2: Manual Rollback

If automatic rollback fails, perform manual rollback:

#### Step 1: Identify the Failed Migration

```bash
# Get migration list
kubectl exec -it <pod-name> -n substream -- npx knex migrate:list

# Note the migration name that failed
```

#### Step 2: Create Rollback Script

Create a manual rollback script based on the migration file:

```javascript
// scripts/manual-rollback.js
const knex = require('knex');
const knexConfig = require('../knexfile');

async function rollback() {
  const db = knex(knexConfig);
  
  try {
    // Reverse the changes from the failed migration
    await db.schema.dropTableIfExists('new_table');
    await db.schema.table('existing_table', (table) => {
      table.dropColumn('new_column');
    });
    
    console.log('Manual rollback completed');
  } catch (error) {
    console.error('Rollback failed:', error);
    throw error;
  } finally {
    await db.destroy();
  }
}

rollback();
```

#### Step 3: Execute Rollback

```bash
kubectl exec -it <pod-name> -n substream -- node scripts/manual-rollback.js
```

### Option 3: Database Restore (Last Resort)

If rollback is not possible, restore from backup:

```bash
# Identify the last successful backup
# This depends on your backup solution (e.g., Velero, pg_dump, etc.)

# For SQLite, restore from backup
kubectl cp ./substream.db.backup <pod-name>:/app/data/substream.db -n substream

# Restart the application
kubectl rollout restart deployment substream-backend -n substream
```

---

## Post-Incident Actions

### Step 1: Verify System Health

After rollback, verify the system is healthy:

```bash
# Check pod status
kubectl get pods -n substream

# Check application health
kubectl exec -it <pod-name> -n substream -- curl http://localhost:3000/health

# Check database connectivity
kubectl exec -it <pod-name> -n substream -- node -e "
const knex = require('knex');
const db = knex({ client: 'better-sqlite3', connection: { filename: '/app/data/substream.db' } });
db.raw('SELECT 1').then(() => console.log('Database OK')).catch(console.error).finally(() => db.destroy());
"
```

### Step 2: Document the Incident

Create an incident report with:
- Timestamp of failure
- Error messages and logs
- Root cause analysis
- Actions taken
- Resolution steps
- Preventive measures

### Step 3: Update Monitoring

Add alerts for common migration failures:
- Migration job failures
- Lock acquisition timeouts
- Long-running migrations
- Database permission errors

### Step 4: Post-Mortem

Conduct a post-mortem meeting with stakeholders to:
- Review the incident timeline
- Identify process improvements
- Update documentation
- Assign action items

---

## Prevention Strategies

### 1. Pre-Deployment Testing

Always test migrations in a staging environment:

```bash
# Run migrations in staging
helm upgrade substream-backend ./helm/substream-backend \
  --namespace staging \
  --values values-staging.yaml \
  --set migration.enabled=true

# Verify application works
# Run smoke tests
# Run integration tests
```

### 2. Migration Best Practices

Follow these guidelines when writing migrations:

- **Always write rollback scripts**
- **Use idempotent operations** (IF NOT EXISTS, IF EXISTS)
- **Avoid data loss operations** (DROP without backup)
- **Test with production-like data**
- **Document breaking changes**

### 3. Staged Rollout

Use canary deployments for critical migrations:

```yaml
# Initial canary (10% traffic)
helm upgrade substream-backend ./helm/substream-backend \
  --namespace production \
  --set replicaCount=1 \
  --set migration.enabled=true

# Monitor for 30 minutes
# If successful, scale up
helm upgrade substream-backend ./helm/substream-backend \
  --namespace production \
  --set replicaCount=3
```

### 4. Backup Before Migration

Automate database backups before migrations:

```yaml
# Add pre-migration backup hook
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "substream-backend.fullname" . }}-backup
  annotations:
    "helm.sh/hook": pre-upgrade
    "helm.sh/hook-weight": "-10"
spec:
  template:
    spec:
      containers:
        - name: backup
          image: appropriate/backup-tool
          command: ["backup-database"]
```

### 5. Health Checks

Implement comprehensive health checks:

```javascript
// Add to migration script
async function postMigrationHealthCheck() {
  // Check table counts
  // Check data integrity
  // Test critical queries
  // Verify indexes
}
```

---

## Long-Running Migrations

For migrations that take longer than the default timeout:

### Strategy 1: Increase Timeout

```yaml
migration:
  timeout: 3600 # 1 hour
```

### Strategy 2: Batch Processing

Break large operations into smaller batches:

```javascript
// Instead of: UPDATE users SET status = 'active'
// Use:
async function batchUpdate() {
  const batchSize = 10000;
  let offset = 0;
  
  while (true) {
    const users = await db('users')
      .limit(batchSize)
      .offset(offset);
    
    if (users.length === 0) break;
    
    await db('users')
      .whereIn('id', users.map(u => u.id))
      .update({ status: 'active' });
    
    offset += batchSize;
    console.log(`Processed ${offset} users`);
  }
}
```

### Strategy 3: Online Schema Change

For PostgreSQL, use online schema change tools:
- `pg_repack`
- `pg_squeeze`
- `ALTER TABLE ... CONCURRENTLY`

### Strategy 4: Two-Phase Migration

Deploy in two phases:

**Phase 1 (Non-breaking):**
- Add new columns (nullable)
- Create new tables
- Add new indexes (CONCURRENTLY)

**Phase 2 (Breaking):**
- Backfill data
- Update application code
- Remove old columns/tables

---

## Emergency Contacts

- **On-Call Engineer**: [Phone/Slack]
- **Database Team**: [Phone/Slack]
- **DevOps Team**: [Phone/Slack]
- **Engineering Manager**: [Phone/Slack]

---

## Related Documentation

- [Vault Migration Setup](./VAULT_MIGRATION_SETUP.md)
- [Backwards-Compatible Migrations](./BACKWARDS_COMPATIBLE_MIGRATIONS.md)
- [Helm Chart Documentation](../../helm/substream-backend/README.md)
