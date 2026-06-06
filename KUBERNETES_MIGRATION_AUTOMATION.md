# Kubernetes Database Migration Automation

This document describes the automated database schema migration system for the Substream-cor, which ensures safe and reliable database updates during Kubernetes deployments.

## Overview

The migration automation system eliminates the need for manual database migrations during deployments. It integrates with Kubernetes to:
- Automatically run database migrations before application pods start
- Prevent application deployment if migrations fail
- Ensure database schema and application code are always synchronized
- Support distributed execution without race conditions
- Handle long-running migrations gracefully

## Architecture

### Components

1. **Migration Script** (`scripts/migrate-init-container.js`)
   - Idempotent migration runner for Kubernetes initContainers
   - Distributed locking to prevent concurrent migrations
   - Timeout protection for long-running operations
   - Comprehensive logging and error handling

2. **Dockerfile Updates**
   - Packages Knex schema and migration files into the Docker image
   - Ensures migrations are available at runtime

3. **Helm Chart Configuration**
   - Supports two deployment strategies: initContainer or Job hooks
   - Configurable timeouts and resource limits
   - Vault integration for secure credential management

4. **Vault Integration** (Optional)
   - Secure credential management for migration operations
   - Dynamic credential provisioning
   - Role-based access control

## Deployment Strategies

### Strategy 1: initContainer (Default)

The initContainer runs migrations before the main application container starts.

**Advantages:**
- Simple and straightforward
- Migrations complete before any application pod starts
- Failed migrations prevent pod startup automatically

**Configuration:**
```yaml
migration:
  enabled: true
  strategy: "initContainer"
  timeout: 1800
  lockTimeout: 300
```

**How it works:**
1. Kubernetes creates a pod with the initContainer
2. initContainer runs the migration script
3. If migration succeeds, the main container starts
4. If migration fails, the pod fails and Kubernetes retries

### Strategy 2: Helm Job Hooks

The migration runs as a separate Kubernetes Job using Helm hooks.

**Advantages:**
- Migration runs once per Helm release (not per pod)
- Better for large-scale deployments with many replicas
- Can be configured to run pre-install or pre-upgrade

**Configuration:**
```yaml
migration:
  enabled: true
  strategy: "job"
  timeout: 1800
  lockTimeout: 300
```

**How it works:**
1. Helm creates a Job before the Deployment
2. Job runs the migration script
3. If migration succeeds, Helm proceeds with Deployment
4. If migration fails, Helm aborts the upgrade

## Quick Start

### 1. Update Dockerfile

The Dockerfile has been updated to include migration files:

```dockerfile
# Copy Knex migrations for initContainer
COPY --chown=nodejs:nodejs migrations ./migrations
COPY --chown=nodejs:nodejs scripts ./scripts
```

### 2. Build and Push Image

```bash
docker build -t substream/backend:latest .
docker push substream/backend:latest
```

### 3. Configure Helm Values

Update `helm/substream-backend/values.yaml`:

```yaml
migration:
  enabled: true
  strategy: "initContainer" # or "job"
  timeout: 1800
  lockTimeout: 300
  resources:
    requests:
      memory: "128Mi"
      cpu: "100m"
    limits:
      memory: "256Mi"
      cpu: "200m"
```

### 4. Deploy

```bash
helm upgrade substream-backend ./helm/substream-backend \
  --namespace production \
  --values values-production.yaml
```

### 5. Monitor

```bash
# Watch migration logs
kubectl logs -f deployment/substream-backend -c migration -n production

# Check migration status
kubectl describe pod <pod-name> -n production
```

## Features

### Idempotent Execution

The migration script can be run multiple times safely:
- Checks if migrations are already applied
- Skips already-completed migrations
- Uses database-level locking to prevent race conditions

### Distributed Locking

Prevents concurrent migrations across multiple pods:
- Lock table in the database
- Automatic lock expiration
- Lock acquisition with timeout
- Automatic lock release on completion

### Timeout Protection

Configurable timeouts prevent indefinite hangs:
- Migration timeout (default: 30 minutes)
- Lock acquisition timeout (default: 5 minutes)
- Configurable via environment variables
- Warnings for long-running operations

### Comprehensive Logging

Detailed logging for debugging and monitoring:
- Migration start/end timestamps
- Individual migration names and status
- Lock acquisition/release events
- Error details and stack traces
- Progress tracking for long operations

### Failure Handling

Automatic failure handling to prevent deployment:
- Exit code 0 on success
- Exit code 1 on failure (prevents pod startup)
- Automatic rollback on failure
- Lock cleanup on error

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_FILENAME` | Path to SQLite database file | `/app/data/substream.db` |
| `MIGRATION_TIMEOUT` | Migration timeout in milliseconds | `1800000` (30 min) |
| `MIGRATION_LOCK_TIMEOUT` | Lock acquisition timeout in milliseconds | `300000` (5 min) |
| `POD_NAME` | Kubernetes pod name (auto-injected) | - |
| `NAMESPACE` | Kubernetes namespace (auto-injected) | - |
| `HOSTNAME` | Node hostname (auto-injected) | - |

### Helm Values

```yaml
migration:
  enabled: true                    # Enable/disable migrations
  strategy: "initContainer"        # "initContainer" or "job"
  timeout: 1800                    # Migration timeout in seconds
  lockTimeout: 300                 # Lock timeout in seconds
  resources:
    requests:
      memory: "128Mi"
      cpu: "100m"
    limits:
      memory: "256Mi"
      cpu: "200m"
  vault:
    enabled: false                 # Enable Vault integration
    role: "substream-migration"     # Vault role name
    secretPath: "database/creds/migration"
    address: "http://vault:8200"
```

## Vault Integration

For secure credential management, enable Vault integration:

### Setup

1. Configure Vault policy (see [VAULT_MIGRATION_SETUP.md](./docs/VAULT_MIGRATION_SETUP.md))
2. Enable Vault in Helm values:

```yaml
migration:
  vault:
    enabled: true
    role: "substream-migration"
    secretPath: "database/creds/migration"
    address: "http://vault:8200"
```

3. Annotate service account for Vault authentication

## Writing Migrations

### Basic Migration

```javascript
// migrations/knex/016_add_new_column.js
exports.up = function(knex) {
  return knex.schema.table('users', (table) => {
    table.string('new_column').nullable();
  });
};

exports.down = function(knex) {
  return knex.schema.table('users', (table) => {
    table.dropColumn('new_column');
  });
};
```

### Backwards-Compatible Migration

Always write backwards-compatible migrations:

```javascript
exports.up = function(knex) {
  // Add nullable column
  return knex.schema.table('users', (table) => {
    table.string('email').nullable();
  });
};
```

See [BACKWARDS_COMPATIBLE_MIGRATIONS.md](./docs/BACKWARDS_COMPATIBLE_MIGRATIONS.md) for detailed guidelines.

### Long-Running Migration

For operations that take a long time:

```javascript
exports.up = async function(knex) {
  const batchSize = 10000;
  let processed = 0;

  while (true) {
    const updated = await knex('large_table')
      .whereNull('new_column')
      .limit(batchSize)
      .update({ new_column: 'value' });

    if (updated === 0) break;

    processed += updated;
    console.log(`Processed ${processed} records`);
  }
};
```

See [LONG_RUNNING_MIGRATIONS.md](./docs/LONG_RUNNING_MIGRATIONS.md) for strategies.

## Troubleshooting

### Migration Fails

**Symptoms:**
- Pod fails to start
- Job fails with error

**Steps:**
1. Check logs: `kubectl logs <pod-name> -c migration -n production`
2. Review [Migration Failure Runbook](./docs/MIGRATION_FAILURE_RUNBOOK.md)
3. Check database connectivity
4. Verify migration file syntax
5. Check for lock contention

### Lock Timeout

**Symptoms:**
- "Timeout waiting for migration lock"
- Migration waits indefinitely

**Steps:**
1. Check for existing locks in `_migration_locks` table
2. Manually release stale locks (emergency only)
3. Increase `lockTimeout` in values.yaml
4. Check for stuck migration jobs

### Migration Timeout

**Symptoms:**
- "Migration timeout after Xms"
- Long-running migration fails

**Steps:**
1. Increase `timeout` in values.yaml
2. Optimize migration (use batches)
3. Use background job strategy
4. See [Long-Running Migrations](./docs/LONG_RUNNING_MIGRATIONS.md)

## Monitoring

### Kubernetes

```bash
# Watch migration logs
kubectl logs -f deployment/substream-backend -c migration -n production

# Check pod status
kubectl get pods -n production -l app=substream-backend

# Describe pod for events
kubectl describe pod <pod-name> -n production
```

### Application Logs

The migration script logs to stdout/stderr:
- `[InitContainer]` prefix for all messages
- Timestamps for all operations
- Progress tracking for long operations
- Error details with stack traces

### Metrics

Consider adding metrics for:
- Migration duration
- Migration success/failure rate
- Lock acquisition time
- Number of migrations run

## Best Practices

### Before Deployment

1. **Test in Staging**: Always test migrations in staging first
2. **Backup Database**: Ensure recent backups are available
3. **Review Migration**: Check migration file for potential issues
4. **Estimate Duration**: Test with production-like data
5. **Plan Rollback**: Have a rollback strategy ready

### During Deployment

1. **Monitor Logs**: Watch migration logs in real-time
2. **Check Progress**: Verify migrations are progressing
3. **Watch Resources**: Monitor database and pod resources
4. **Be Ready**: Have runbook and team on standby

### After Deployment

1. **Verify Application**: Ensure application works correctly
2. **Check Data Integrity**: Verify data consistency
3. **Monitor Performance**: Watch for performance issues
4. **Document**: Document any issues or learnings

## Security Considerations

### Credentials

- Never hardcode database credentials
- Use Vault for credential management
- Rotate credentials regularly
- Use least-privilege access

### Database Access

- Migration role should have minimal required privileges
- Revoke migration credentials after use
- Audit all migration operations
- Use read-only credentials for verification

### Network

- Use TLS for database connections
- Restrict database access to migration pods
- Use network policies to limit access
- Monitor for unauthorized access

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      
      - name: Build Docker Image
        run: |
          docker build -t substream/backend:${{ github.sha }} .
          docker push substream/backend:${{ github.sha }}
      
      - name: Deploy with Helm
        run: |
          helm upgrade substream-backend ./helm/substream-backend \
            --namespace production \
            --set image.tag=${{ github.sha }} \
            --set migration.enabled=true
```

### GitLab CI Example

```yaml
deploy:
  stage: deploy
  script:
    - docker build -t substream/backend:$CI_COMMIT_SHA .
    - docker push substream/backend:$CI_COMMIT_SHA
    - helm upgrade substream-backend ./helm/substream-backend
        --namespace production
        --set image.tag=$CI_COMMIT_SHA
        --set migration.enabled=true
  only:
    - main
```

## Rollback Procedure

If a deployment fails:

1. **Stop Deployment**
   ```bash
   helm rollback substream-backend -n production
   ```

2. **Check Migration Status**
   ```bash
   kubectl exec -it <pod-name> -n production -- npx knex migrate:list
   ```

3. **Rollback Migrations** (if needed)
   ```bash
   kubectl exec -it <pod-name> -n production -- npx knex migrate:rollback
   ```

4. **Verify System**
   ```bash
   kubectl get pods -n production
   kubectl logs deployment/substream-backend -n production
   ```

See [Migration Failure Runbook](./docs/MIGRATION_FAILURE_RUNBOOK.md) for detailed procedures.

## Documentation

- [Migration Failure Runbook](./docs/MIGRATION_FAILURE_RUNBOOK.md) - Handling failed migrations
- [Backwards-Compatible Migrations](./docs/BACKWARDS_COMPATIBLE_MIGRATIONS.md) - Writing safe migrations
- [Long-Running Migrations](./docs/LONG_RUNNING_MIGRATIONS.md) - Handling slow operations
- [Vault Migration Setup](./docs/VAULT_MIGRATION_SETUP.md) - Vault integration guide

## Acceptance Criteria

### Acceptance 1: Autonomous and Secure Updates
✅ Database schemas are updated automatically during Kubernetes deployment
✅ Migrations run before application pods start
✅ Failed migrations prevent application deployment
✅ Secure credential management via Vault (optional)

### Acceptance 2: Failed Migration Protection
✅ Failed migrations prevent pod startup
✅ Exit code 1 on failure triggers Kubernetes retry logic
✅ Automatic rollback on failure
✅ Comprehensive error logging

### Acceptance 3: Helm Hooks and Distributed Execution
✅ Supports both initContainer and Job hook strategies
✅ Database-level locking prevents race conditions
✅ Idempotent execution safe for multiple pods
✅ Configurable timeouts and resources

## Support

For issues or questions:
- Review the troubleshooting section
- Check the detailed runbooks
- Consult the Knex.js documentation
- Contact the DevOps team

## License

MIT
