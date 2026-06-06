# Zero-Downtime Database Migration Guide

## Overview

This guide explains how to perform database migrations on the Substream-cor backend **without any service interruption**, even under high load (5,000+ requests per second).

## Architecture Principles

### 1. **Backward Compatibility**
All schema changes must be backward compatible with the current running code.

### 2. **Gradual Rollout**
Changes are deployed in phases, not all at once.

### 3. **Health Checks**
Continuous monitoring before, during, and after migrations.

### 4. **Rollback Capability**
Every migration can be safely rolled back if issues arise.

## Migration Strategy

### Phase-Based Approach

#### Phase 1: Pre-Deploy (Additive Changes Only)

**Goal:** Add new columns/tables without breaking existing functionality

```sql
-- ✅ SAFE: Adding nullable column
ALTER TABLE subscriptions ADD COLUMN tier_level TEXT NULL DEFAULT 'free';

-- ❌ UNSAFE: Adding NOT NULL column without default
ALTER TABLE subscriptions ADD COLUMN tier_level TEXT NOT NULL;
```

**Pre-Deploy Checklist:**
- [ ] Database backup completed
- [ ] Health checks passing
- [ ] Current load < 80% capacity
- [ ] Rollback procedure tested
- [ ] Monitoring alerts configured

#### Phase 2: Background Data Migration

**Goal:** Gradually update existing records without locking tables

```javascript
// Batch processing with delays
const BATCH_SIZE = 1000;
const DELAY_MS = 100;

while (hasMoreRecords) {
  await updateBatch(BATCH_SIZE);
  await sleep(DELAY_MS); // Allow normal traffic to proceed
}
```

**Key Techniques:**
- Small batch sizes (100-1000 rows)
- Delays between batches
- Rate limiting based on database load
- Parallel query monitoring

#### Phase 3: Post-Deploy (Constraints & Validation)

**Goal:** Add constraints now that data is migrated

```sql
-- ✅ SAFE: Now that all rows have values
ALTER TABLE subscriptions ALTER COLUMN tier_level SET NOT NULL;

-- Add indexes after data migration
CREATE INDEX idx_subscriptions_tier_level ON subscriptions (tier_level);
```

## Blue-Green Deployment Strategy

### Infrastructure Setup

```
                    ┌─────────────┐
    Users ─────────>│ Load        │
                    │ Balancer    │
                    └──────┬──────┘
                           │
            ┌──────────────┴──────────────┐
            │                             │
            ▼                             ▼
    ┌───────────────┐             ┌───────────────┐
    │ BLUE          │             │ GREEN         │
    │ - Version 1.0 │             │ - Version 2.0 │
    │ - Active      │             │ - Standby     │
    └───────┬───────┘             └───────┬───────┘
            │                             │
            └──────────────┬──────────────┘
                           │
                    ┌──────▼──────┐
                    │ Shared      │
                    │ Database    │
                    └─────────────┘
```

### Deployment Steps

#### Step 1: Deploy to Green Environment
```bash
# Deploy new code to GREEN servers
kubectl apply -f k8s/green-deployment.yaml

# Run migrations on shared database
npm run migrate
```

#### Step 2: Health Check Green
```bash
# Verify GREEN is healthy
curl https://api.substream.green/health

# Run integration tests
npm run test:integration
```

#### Step 3: Shift Traffic Gradually
```bash
# Start with 10% traffic to GREEN
kubectl patch virtualservice substream-vs -p '{"spec":{"http":[{"route":[{"destination":{"host":"blue","subset":"v1"},"weight":90},{"destination":{"host":"green","subset":"v2"},"weight":10}]}]}}'

# Monitor error rates
prometheus-query 'rate(http_requests_total{status="500"}[5m])'

# Gradually increase: 10% -> 25% -> 50% -> 100%
```

#### Step 4: Complete Cutover
```bash
# Switch 100% to GREEN
kubectl patch virtualservice substream-vs -p '{"spec":{"http":[{"route":[{"destination":{"host":"green","subset":"v2"},"weight":100}]}]}}'

# Scale down BLUE
kubectl scale deployment substream-blue --replicas=0
```

## Example: Adding a Column with Zero Downtime

### Scenario
Add `tier_level` column to `subscriptions` table while serving 5,000 RPS.

### Timeline

**Day 1: Code Deployment**
```sql
-- Migration 003: Add column (nullable)
ALTER TABLE subscriptions 
ADD COLUMN tier_level TEXT NULL DEFAULT 'free';
```

Code changes deployed with backward-compatible logic:
```javascript
// Handle both old and new schema
subscription.tierLevel = subscription.tier_level || 'free';
```

**Day 2: Background Backfill**
```javascript
// Run as background worker
for await (const batch of getUnmigratedSubscriptions()) {
  await backfillTierLevels(batch);
  await sleep(100); // Prevent lock contention
}
```

**Day 3: Constraint Addition**
```sql
-- After verifying 100% backfill
ALTER TABLE subscriptions 
ALTER COLUMN tier_level SET NOT NULL;

CREATE INDEX idx_subscriptions_tier_level ON subscriptions (tier_level);
```

## Monitoring & Alerts

### Key Metrics

```yaml
# Prometheus metrics to monitor
database:
  - active_connections
  - query_duration_p95
  - lock_wait_time
  - replication_lag
  
application:
  - http_request_duration_p99
  - error_rate
  - request_queue_depth
  
migration:
  - rows_migrated_total
  - batch_duration_seconds
  - rollback_count
```

### Alert Thresholds

```yaml
alerts:
  - name: HighDatabaseLatency
    condition: query_duration_p95 > 500ms
    severity: warning
    
  - name: MigrationStalled
    condition: rows_migrated_total == 0 for 5m
    severity: critical
    
  - name: ErrorRateSpike
    condition: error_rate > 1%
    severity: critical
    action: trigger_rollback
```

## Rollback Procedures

### Immediate Rollback (< 1 minute)
```bash
# Switch traffic back to BLUE
kubectl patch virtualservice substream-vs \
  -p '{"spec":{"http":[{"route":[{"destination":{"host":"blue","subset":"v1"},"weight":100}]}]}}'

# Rollback database migration
npm run migrate:rollback
```

### Data Recovery from Backup
```bash
# Restore from pre-migration backup
psql substream < backups/subscriptions_backup_20260328.sql

# Verify row counts
SELECT COUNT(*) FROM subscriptions;
```

## Best Practices

### DO ✅
- Test migrations on staging with production-like load
- Use small batch sizes for data updates
- Monitor continuously during migrations
- Have rollback scripts ready
- Schedule migrations during low-traffic periods (even if zero-downtime)

### DON'T ❌
- Never run large UPDATE statements without batching
- Don't add NOT NULL columns in one step
- Avoid long-running transactions
- Don't skip health checks
- Never migrate without monitoring dashboards open

## Tools & Scripts

### Migration Runner
```bash
# Run all pending migrations with health checks
npm run migrate

# Run with custom config
NODE_ENV=production npm run migrate

# Dry run (no changes)
npm run migrate:dry-run
```

### Health Check Script
```bash
# Comprehensive health verification
./scripts/health-check.sh

# Output:
# ✓ Database connected (12ms)
# ✓ All tables accessible
# ✓ Query performance normal (p95: 45ms)
# ✓ No locked queries
# ✓ Replication lag: 0ms
```

## Troubleshooting

### Issue: Migration Locking Table
**Solution:** Reduce batch size and add delays
```javascript
const BATCH_SIZE = 100; // Down from 1000
const DELAY_MS = 500;   // Up from 100
```

### Issue: High Error Rate During Migration
**Solution:** Trigger immediate rollback
```bash
./scripts/emergency-rollback.sh
```

### Issue: Incomplete Backfill
**Solution:** Resume from last checkpoint
```javascript
await resumeBackfill({
  lastProcessedId: 123456,
  batchSize: 500,
});
```

## Success Criteria

A migration is considered successful when:
- ✅ All data migrated correctly
- ✅ Error rate < 0.1% during migration
- ✅ P95 latency increase < 20%
- ✅ No user-facing errors
- ✅ Rollback not required
- ✅ Monitoring shows normal operation

## Contact & Support

For questions about this guide:
- Documentation: `/docs` folder
- DevOps Team: #devops Slack channel
- On-Call: PagerDuty rotation

---

**Last Updated:** March 28, 2026  
**Version:** 1.0  
**Author:** AgreeStellar Team
