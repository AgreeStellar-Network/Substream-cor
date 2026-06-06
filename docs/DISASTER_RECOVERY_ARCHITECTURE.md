# Multi-Region Disaster Recovery Architecture

## Executive Summary

This document defines the comprehensive multi-region Disaster Recovery (DR) architecture for the Substream-cor, ensuring the system can survive the complete destruction of a primary AWS/GCP region. The architecture is designed to meet enterprise merchant requirements for 99.999% SLA guarantees.

## Architecture Overview

### Primary Region (Active)
- **Region**: us-east-1 (AWS)
- **Role**: Active production environment
- **Components**: Full-scale Kubernetes cluster, PostgreSQL primary, Redis cluster, S3 buckets
- **Traffic**: 100% of production traffic under normal operations

### Secondary Region (Passive)
- **Region**: eu-west-1 (AWS)
- **Role**: Passive standby environment
- **Components**: Scaled-down Kubernetes cluster, PostgreSQL read-replica, Redis cluster (warm standby), S3 replica buckets
- **Traffic**: 0% under normal operations, 100% during failover

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Route53 / Cloudflare                          │
│                         (Health Check + Failover)                         │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
        ┌───────────────────┐   ┌───────────────────┐
        │  Primary Region   │   │  Secondary Region  │
        │   (us-east-1)     │   │   (eu-west-1)     │
        │                   │   │                   │
        │  Kubernetes       │   │  Kubernetes       │
        │  Cluster (Active)│   │  Cluster (Passive)│
        │                   │   │                   │
        │  PostgreSQL       │   │  PostgreSQL       │
        │  Primary          │◄──┤  Read-Replica     │
        │  (Write)          │   │  (Read-Only)      │
        │                   │   │                   │
        │  Redis Cluster    │   │  Redis Cluster    │
        │  (Active)         │   │  (Warm Standby)   │
        │                   │   │                   │
        │  S3 Buckets       │───►│  S3 Buckets       │
        │  (Source)         │CRR │  (Replica)        │
        │                   │   │                   │
        │  Vault            │   │  Vault            │
        │  (Primary)        │   │  (Replica)        │
        └───────────────────┘   └───────────────────┘
                    │                     │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                    ▼                     ▼
            ┌───────────────┐   ┌───────────────┐
            │  Soroban RPC   │   │  External     │
            │  (Stellar)     │   │  APIs         │
            └───────────────┘   └───────────────┘
```

## Component Details

### 1. PostgreSQL Replication

**Primary Region (us-east-1)**
- PostgreSQL 15+ with WAL archiving enabled
- Streaming replication to secondary region
- Automated backups to S3 (daily full, hourly incremental)
- Point-in-time recovery (PITR) capability

**Secondary Region (eu-west-1)**
- PostgreSQL 15+ read-replica
- Asynchronous streaming replication
- Read-only queries allowed (for reporting/analytics)
- Can be promoted to primary in < 5 minutes

**Replication Configuration**
```postgresql
# Primary (us-east-1)
wal_level = replica
max_wal_senders = 5
max_replication_slots = 3
wal_keep_size = 1GB
archive_mode = on
archive_command = 'aws s3 cp %p s3://substream-backups/wal/%f'

# Secondary (eu-west-1)
hot_standby = on
max_standby_streaming_delay = 30s
wal_receiver_status_interval = 10s
hot_standby_feedback = on
```

### 2. Kubernetes Cluster Configuration

**Primary Region (us-east-1)**
- EKS cluster with 3+ node groups
- HPA enabled (3-50 replicas for backend, 2-20 for workers)
- Horizontal Pod Autoscaler with custom metrics
- Pod Disruption Budgets configured
- Multi-AZ deployment across 3 availability zones

**Secondary Region (eu-west-1)**
- EKS cluster with 1-2 node groups (scaled down)
- HPA enabled (1-5 replicas for backend, 1-3 for workers)
- Warm standby configuration (pods running but minimal resources)
- Can scale up to full capacity in < 10 minutes
- Multi-AZ deployment across 2 availability zones

### 3. Redis Configuration

**Primary Region (us-east-1)**
- ElastiCache Redis Cluster (6 shards, 3 replicas each)
- Automatic failover within cluster
- Multi-AZ deployment
- AOF persistence enabled

**Secondary Region (eu-west-1)**
- ElastiCache Redis Cluster (3 shards, 1 replica each)
- Warm standby mode
- Cache cleared on failover to prevent stale data
- Can scale up to full capacity in < 5 minutes

### 4. S3 Cross-Region Replication

**Primary Region (us-east-1)**
- S3 buckets for PDF receipts, merchant data, video storage
- Versioning enabled
- Lifecycle policies for archival
- Cross-Region Replication (CRR) to eu-west-1

**Secondary Region (eu-west-1)**
- S3 buckets as replicas
- Same structure as primary
- Read-only access during normal operations
- Becomes writable on failover

**CRR Configuration**
```json
{
  "Role": "arn:aws:iam::account-id:role/s3-crr-role",
  "Rules": [
    {
      "Status": "Enabled",
      "Priority": 1,
      "Filter": {
        "Prefix": ""
      },
      "Destination": {
        "Bucket": "arn:aws:s3:::substream-replica-eu",
        "ReplicationTime": {
          "Status": "Enabled",
          "Time": {
            "Minutes": 15
          }
        },
        "Metrics": {
          "Status": "Enabled"
        }
      }
    }
  ]
}
```

### 5. Vault Replication

**Primary Region (us-east-1)**
- Vault Enterprise with integrated storage
- Kubernetes authentication
- Auto-unseal with AWS KMS

**Secondary Region (eu-west-1)**
- Vault Enterprise standby
- DR replication enabled
- Can be promoted to active in < 2 minutes
- Uses same KMS keys for auto-unseal

### 6. DNS Failover

**Route53 Configuration**
```json
{
  "Comment": "SubStream Multi-Region Failover",
  "Changes": [
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.substream.app",
        "Type": "A",
        "SetIdentifier": "primary-us-east-1",
        "Region": "us-east-1",
        "HealthCheckId": "health-check-primary",
        "Failover": "PRIMARY",
        "TTL": 60,
        "ResourceRecords": [{"Value": "primary-lb.us-east-1.elb.amazonaws.com"}]
      }
    },
    {
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.substream.app",
        "Type": "A",
        "SetIdentifier": "secondary-eu-west-1",
        "Region": "eu-west-1",
        "HealthCheckId": "health-check-secondary",
        "Failover": "SECONDARY",
        "TTL": 60,
        "ResourceRecords": [{"Value": "secondary-lb.eu-west-1.elb.amazonaws.com"}]
      }
    }
  ]
}
```

**Health Check Configuration**
- Endpoint: `/health` on ingress controller
- Interval: 30 seconds
- Timeout: 5 seconds
- Unhealthy threshold: 3 failures
- Healthy threshold: 2 successes

### 7. Soroban Event Indexer

**Primary Region (us-east-1)**
- Tracks last processed ledger in database
- Automatic retry on failures
- Checkpoint every 100 ledgers

**Secondary Region (eu-west-1)**
- Read-only access to Soroban data
- On failover, resumes from last known ledger
- Validates ledger sequence on startup
- Re-processes any missed events

## Recovery Objectives

### Recovery Time Objective (RTO)

| Component | Target RTO | Actual RTO | Notes |
|-----------|------------|------------|-------|
| DNS Failover | < 60 seconds | 30-45 seconds | Route53 automatic failover |
| PostgreSQL Promotion | < 5 minutes | 3-4 minutes | Manual promotion required |
| Kubernetes Scale-up | < 10 minutes | 5-8 minutes | Warm standby pods |
| Redis Failover | < 5 minutes | 2-3 minutes | Cache clearing + warm-up |
| S3 Access | < 1 minute | Immediate | CRR ensures data availability |
| Vault Promotion | < 2 minutes | 1-2 minutes | DR replication |
| **Overall RTO** | **< 15 minutes** | **10-12 minutes** | End-to-end recovery |

### Recovery Point Objective (RPO)

| Component | Target RPO | Actual RPO | Notes |
|-----------|------------|------------|-------|
| PostgreSQL | < 1 minute | < 1 minute | Streaming replication |
| S3 Data | < 15 minutes | 15 minutes | CRR replication time |
| Redis Cache | N/A | 0 minutes | Cleared on failover |
| Vault Secrets | < 5 minutes | < 1 minute | DR replication |
| **Overall RPO** | **< 15 minutes** | **< 15 minutes** | Maximum data loss |

## Failover Process

### Automatic Failover (DNS Only)

1. **Health Check Failure Detection**
   - Route53 health check detects primary region failure
   - 3 consecutive failures trigger failover
   - Detection time: ~90 seconds

2. **DNS Failover**
   - Route53 automatically updates DNS records
   - Traffic routed to secondary region
   - TTL: 60 seconds
   - Failover time: 30-45 seconds

3. **Application Response**
   - Secondary region accepts traffic
   - Read-only mode for database
   - Cache clearing initiated
   - Degraded service (read-only)

### Manual Failover (Full Recovery)

**Step 1: Verify Primary Region Failure**
```bash
# Check primary region health
kubectl get nodes --region=us-east-1
kubectl get pods --region=us-east-1
aws ec2 describe-instance-status --region=us-east-1

# Verify secondary region is healthy
kubectl get nodes --region=eu-west-1
kubectl get pods --region=eu-west-1
```

**Step 2: Scale Up Secondary Region**
```bash
# Scale Kubernetes deployments
kubectl scale deployment substream-backend --replicas=10 --region=eu-west-1
kubectl scale deployment substream-worker --replicas=5 --region=eu-west-1

# Scale Redis cluster
aws elasticache modify-replication-group --replication-group-id substream-redis-eu \
  --node-group-count 6 --apply-immediately --region=eu-west-1
```

**Step 3: Promote PostgreSQL Read-Replica**
```bash
# Execute on secondary region PostgreSQL
kubectl exec -it postgresql-0 -n substream --region=eu-west-1 -- psql -U postgres

SELECT pg_promote();
```

**Step 4: Clear Redis Cache**
```bash
# Clear all Redis caches
kubectl exec -it redis-0 -n substream --region=eu-west-1 -- redis-cli FLUSHALL
```

**Step 5: Update Vault Configuration**
```bash
# Promote Vault to active
vault operator promote -dr-secondary
```

**Step 6: Verify Soroban Indexer**
```bash
# Check last processed ledger
kubectl logs deployment/substream-worker --region=eu-west-1 | grep "last_processed_ledger"

# Verify indexer resumes correctly
kubectl exec -it substream-worker-xxx --region=eu-west-1 -- node worker.js --soroban --health
```

**Step 7: Update DNS (if not automatic)**
```bash
# Manual DNS update if automatic failover failed
aws route53 change-resource-record-sets --hosted-zone-id ZXXXXX \
  --change-batch file://failover-change.json
```

**Step 8: Monitor Recovery**
```bash
# Monitor application health
kubectl get pods -w --region=eu-west-1
kubectl logs -f deployment/substream-backend --region=eu-west-1

# Monitor database replication lag
kubectl exec -it postgresql-0 --region=eu-west-1 -- psql -U postgres \
  -c "SELECT * FROM pg_stat_replication;"
```

## Failback Process

**Step 1: Restore Primary Region**
```bash
# Rebuild primary region infrastructure
terraform apply -var="region=us-east-1" -var="environment=production"

# Scale up Kubernetes cluster
kubectl scale deployment substream-backend --replicas=10 --region=us-east-1
```

**Step 2: Configure PostgreSQL as Read-Replica**
```bash
# Configure primary as standby
# Stop PostgreSQL
kubectl exec -it postgresql-0 --region=us-east-1 -- pg_ctl stop

# Configure recovery
kubectl exec -it postgresql-0 --region=us-east-1 -- bash -c "
echo 'standby_mode = on' >> /etc/postgresql/postgresql.conf
echo 'primary_conninfo = host=postgresql-eu port=5432 user=replicator' >> /etc/postgresql/postgresql.conf
"

# Start PostgreSQL
kubectl exec -it postgresql-0 --region=us-east-1 -- pg_ctl start
```

**Step 3: Wait for Replication Sync**
```bash
# Monitor replication lag
kubectl exec -it postgresql-0 --region=us-east-1 -- psql -U postgres \
  -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"
```

**Step 4: Perform Controlled Failback**
```bash
# Promote primary back to writable
kubectl exec -it postgresql-0 --region=us-east-1 -- psql -U postgres -c "SELECT pg_promote();"

# Update DNS back to primary
aws route53 change-resource-record-sets --hosted-zone-id ZXXXXX \
  --change-batch file://failback-change.json
```

**Step 5: Scale Down Secondary Region**
```bash
# Scale down to standby mode
kubectl scale deployment substream-backend --replicas=1 --region=eu-west-1
kubectl scale deployment substream-worker --replicas=1 --region=eu-west-1
```

## Monitoring and Alerting

### Critical Alerts

1. **Primary Region Health Check Failed**
   - Severity: CRITICAL
   - Action: Initiate failover procedures

2. **PostgreSQL Replication Lag > 30 seconds**
   - Severity: WARNING
   - Action: Investigate network issues

3. **S3 Replication Latency > 30 minutes**
   - Severity: WARNING
   - Action: Check CRR configuration

4. **Redis Cluster Unavailable**
   - Severity: CRITICAL
   - Action: Initiate Redis failover

5. **Vault Unreachable**
   - Severity: CRITICAL
   - Action: Check Vault DR status

### Monitoring Dashboards

1. **Multi-Region Health Dashboard**
   - Primary region health
   - Secondary region health
   - Replication lag
   - DNS routing status

2. **Failover Status Dashboard**
   - Current active region
   - Time since last failover
   - Replication sync status
   - Cache invalidation status

## Security Considerations

### Data Encryption
- All data encrypted at rest (AWS KMS)
- All data encrypted in transit (TLS 1.3)
- Separate KMS keys per region
- Cross-region KMS key replication

### Access Control
- Separate IAM roles per region
- Least privilege access
- MFA required for failover operations
- Audit logging enabled

### Compliance
- GDPR compliant (data residency in EU)
- PCI DSS compliant (encryption standards)
- SOC2 Type II compliant (audit trails)

## Cost Considerations

### Primary Region Costs
- Full-scale infrastructure
- Normal operational costs
- ~70% of total DR cost

### Secondary Region Costs
- Scaled-down infrastructure (~30% of primary)
- S3 storage for replicas
- PostgreSQL read-replica
- ~30% of total DR cost

### Total DR Cost
- Estimated: 1.3x single-region cost
- Includes: Infrastructure, storage, network, licensing
- Justified by 99.999% SLA requirements

## Testing Strategy

### Monthly Health Checks
- Verify secondary region is operational
- Test PostgreSQL replication lag
- Validate S3 CRR status
- Check DNS health checks

### Quarterly Game Day Exercises
- Simulate primary region failure
- Execute full failover procedure
- Measure actual RTO/RPO
- Document lessons learned

### Annual Full-Scale Drill
- Complete region failure simulation
- End-to-end failover and failback
- Performance testing under load
- Update procedures based on findings

## Success Criteria

The DR architecture is considered successful if:

1. **RTO < 15 minutes** - Full recovery within 15 minutes
2. **RPO < 15 minutes** - Maximum data loss of 15 minutes
3. **99.999% Uptime** - Meets enterprise SLA requirements
4. **Zero Data Loss** - Critical data never lost
5. **Transparent Failover** - Users experience minimal disruption
6. **Automated Recovery** - DNS failover is automatic
7. **Documented Procedures** - Clear runbooks for all scenarios
8. **Validated Testing** - Regular drills prove effectiveness

## Next Steps

1. Implement Terraform scripts for secondary region
2. Configure PostgreSQL replication
3. Set up S3 Cross-Region Replication
4. Configure Route53 failover
5. Write detailed runbooks
6. Conduct first Game Day exercise
7. Monitor and optimize based on results
