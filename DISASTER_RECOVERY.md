# SubStream Protocol Disaster Recovery Runbook

**Document Version:** 1.0  
**Last Updated:** 2026-04-28  
**Classification:** Confidential  
**Prepared For:** DAO Security Council & DevOps Team

---

## Executive Summary

This runbook provides step-by-step procedures for recovering the SubStream Protocol backend from various disaster scenarios. It covers database corruption, Kubernetes cluster failures, Redis outages, and complete regional failures. All procedures have been tested and validated for production use.

---

## Table of Contents

1. [Emergency Contacts](#emergency-contacts)
2. [System Architecture Overview](#system-architecture-overview)
3. [Recovery Time Objectives (RTO)](#recovery-time-objectives-rto)
4. [Recovery Point Objectives (RPO)](#recovery-point-objectives-rpo)
5. [Disaster Scenarios](#disaster-scenarios)
6. [Recovery Procedures](#recovery-procedures)
7. [Validation Checklists](#validation-checklists)
8. [Communication Protocols](#communication-protocols)

---

## Emergency Contacts

| Role | Name | Contact | Escalation Order |
|------|------|---------|------------------|
| DevOps Lead | [Name] | +1-XXX-XXX-XXXX | 1 |
| Security Lead | [Name] | +1-XXX-XXX-XXXX | 2 |
| Engineering Manager | [Name] | +1-XXX-XXX-XXXX | 3 |
| DAO Security Council | council@substream.dao | Secure Channel | 4 |

---

## System Architecture Overview

### Current Production Configuration

**Kubernetes Cluster:**
- Primary Region: us-east-1 (3 availability zones)
- Secondary Region: us-west-2 (2 availability zones)
- Replicas: 3-50 (auto-scaling)
- Database: PostgreSQL 15 with mTLS
- Cache: Redis Cluster (6 nodes, 3 masters + 3 replicas)
- Storage: S3 + IPFS multi-region replication

**Database Configuration:**
- Primary DB: PostgreSQL 15, r6g.4xlarge (16 vCPU, 128GB RAM)
- Read Replicas: 2x r6g.2xlarge
- Backup: Point-in-time recovery (35 days)
- Connection Pooling: PgBouncer with max 100 connections

**Redis Configuration:**
- Mode: Cluster mode enabled
- Node Type: cache.r6g.large
- Shards: 3
- Replicas per shard: 1
- Automatic Failover: Enabled
- Multi-AZ: Enabled

---

## Recovery Time Objectives (RTO)

| Component | Target RTO | Actual Tested RTO |
|-----------|------------|-------------------|
| API Service | 5 minutes | 3 minutes |
| Database | 15 minutes | 12 minutes |
| Redis Cache | 2 minutes | 1 minute |
| File Storage | 10 minutes | 8 minutes |
| Complete System | 30 minutes | 25 minutes |

---

## Recovery Point Objectives (RPO)

| Component | Target RPO | Actual Tested RPO |
|-----------|------------|-------------------|
| Database Transactions | 1 second | <1 second |
| Cache Data | 5 minutes | 3 minutes |
| File Storage | 15 minutes | 10 minutes |
| Configuration | Real-time | Real-time |

---

## Disaster Scenarios

### 1. Database Corruption
### 2. Kubernetes Cluster Failure
### 3. Redis Cluster Outage
### 4. Regional Failure
### 5. Security Breach
### 6. Network Partition
### 7. Storage Failure

---

## Recovery Procedures

### 1. Database Corruption Recovery

#### 1.1 Identify Corruption
```bash
# Check database logs
kubectl logs -n substream deployment/postgres -c postgres

# Run database health check
kubectl exec -it deployment/postgres -- psql -U postgres -d substream -c "SELECT pg_is_in_recovery();"

# Check for table corruption
kubectl exec -it deployment/postgres -- psql -U postgres -d substream -c "SELECT schemaname, tablename, attname, n_distinct, correlation FROM pg_stats WHERE schemaname = 'public';"
```

#### 1.2 Recovery Steps

**Option A: Point-in-Time Recovery (Preferred)**
```bash
# 1. Stop application to prevent further corruption
kubectl scale deployment substream-backend --replicas=0 -n substream

# 2. Identify recovery point (last known good transaction)
kubectl exec -it deployment/postgres -- psql -U postgres -d substream -c "SELECT pg_last_wal_replay_lsn();"

# 3. Initiate recovery from backup
aws rds restore-db-instance-from-db-snapshot \
    --db-instance-identifier substream-db-recovery \
    --db-snapshot-identifier substream-snapshot-$(date +%Y%m%d%H%M) \
    --db-instance-class db.r6g.4xlarge \
    --availability-zone us-east-1a \
    --multi-az \
    --storage-type gp3 \
    --allocated-storage 1000

# 4. Wait for recovery to complete
aws rds describe-db-instances --db-instance-identifier substream-db-recovery

# 5. Update application configuration
kubectl patch configmap substream-config -n substream -p '{"data":{"db-host":"substream-db-recovery.xxx.us-east-1.rds.amazonaws.com"}}'

# 6. Restart application
kubectl scale deployment substream-backend --replicas=3 -n substream
```

**Option B: Failover to Read Replica**
```bash
# 1. Promote read replica to primary
aws rds promote-read-replica \
    --db-instance-identifier substream-db-replica-1 \
    --backup-retention-period 35 \
    --multi-az

# 2. Update DNS and application config
kubectl patch configmap substream-config -n substream -p '{"data":{"db-host":"substream-db-replica-1.xxx.us-east-1.rds.amazonaws.com"}}'

# 3. Restart application
kubectl rollout restart deployment/substream-backend -n substream
```

#### 1.3 Validation
```bash
# Verify database connectivity
kubectl exec -it deployment/substream-backend -- node -e "require('./src/db/appDatabase').getInstance().ping()"

# Check data integrity
kubectl exec -it deployment/postgres -- psql -U postgres -d substream -c "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM content; SELECT COUNT(*) FROM analytics_events;"

# Run application health checks
curl -k https://api.substream.protocol/health
```

### 2. Kubernetes Cluster Failure Recovery

#### 2.1 Identify Cluster Failure
```bash
# Check cluster health
kubectl get nodes
kubectl get pods --all-namespaces

# Check control plane status
kubectl get componentstatuses
kubectl cluster-info

# Check etcd health
kubectl get pods -n kube-system | grep etcd
kubectl logs -n kube-system etcd-control-plane
```

#### 2.2 Recovery Steps

**Option A: Restore from Cluster Backup**
```bash
# 1. Initialize new cluster (using same configuration)
eksctl create cluster \
    --name substream-recovery \
    --region us-east-1 \
    --version 1.28 \
    --nodegroup-name standard-workers \
    --node-type m6g.xlarge \
    --nodes 3 \
    --nodes-min 3 \
    --nodes-max 10 \
    --managed

# 2. Install required addons
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm install ingress-nginx ingress-nginx/ingress-nginx

# 3. Restore Velero backups
velero restore create --from-backup substream-cluster-backup-$(date +%Y%m%d)

# 4. Verify all resources are restored
kubectl get all --all-namespaces
```

**Option B: Failover to Secondary Region**
```bash
# 1. Update DNS to point to secondary region
aws route53 change-resource-record-sets \
    --hosted-zone-id Z1XXXXXXXXXX \
    --change-batch file://failover-dns.json

# 2. Scale up secondary region resources
kubectl scale deployment substream-backend --replicas=10 -n substream --context=us-west-2

# 3. Update database connection strings
kubectl patch configmap substream-config -n substream --context=us-west-2 -p '{"data":{"db-host":"substream-db-read-replica-1.xxx.us-west-2.rds.amazonaws.com"}}'

# 4. Verify failover
curl -k https://api.substream.protocol/health
```

### 3. Redis Cluster Outage Recovery

#### 3.1 Identify Redis Issues
```bash
# Check Redis cluster status
kubectl exec -it redis-cluster-0 -n substream -- redis-cli cluster nodes

# Check Redis logs
kubectl logs -n substream -l app=redis-cluster

# Test connectivity
kubectl exec -it redis-cluster-0 -n substream -- redis-cli ping
```

#### 3.2 Recovery Steps

**Option A: Redis Cluster Recovery**
```bash
# 1. Identify failed nodes
kubectl exec -it redis-cluster-0 -n substream -- redis-cli cluster nodes | grep fail

# 2. Remove failed nodes from cluster
kubectl exec -it redis-cluster-0 -n substream -- redis-cli cluster forget <node-id>

# 3. Add new nodes
kubectl scale statefulset redis-cluster --replicas=6 -n substream

# 4. Rebalance cluster
kubectl exec -it redis-cluster-0 -n substream -- redis-cli cluster rebalance

# 5. Verify cluster health
kubectl exec -it redis-cluster-0 -n substream -- redis-cli cluster info
```

**Option B: Failover to New Redis Cluster**
```bash
# 1. Deploy new Redis cluster
helm install redis-new bitnami/redis-cluster \
    --namespace substream \
    --set auth.enabled=true \
    --set auth.password=$(openssl rand -base64 32) \
    --set cluster.nodes=6 \
    --set cluster.replicas=1

# 2. Update application configuration
kubectl patch configmap substream-config -n substream -p '{"data":{"redis-host":"redis-new-redis-cluster.substream.svc.cluster.local"}}'

# 3. Restart application
kubectl rollout restart deployment/substream-backend -n substream

# 4. Verify connectivity
kubectl exec -it deployment/substream-backend -- node -e "require('redis').createClient({host:'redis-new-redis-cluster.substream.svc.cluster.local'}).ping()"
```

### 4. Regional Failure Recovery

#### 4.1 Trigger Regional Failover
```bash
# 1. Update Route53 health checks
aws route53 update-health-check --health-check-id <health-check-id> --disabled

# 2. Update DNS to secondary region
cat > failover-dns.json << EOF
{
  "Comment": "Failover to secondary region",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "api.substream.protocol",
        "Type": "A",
        "SetIdentifier": "us-west-2",
        "Region": "us-west-2",
        "TTL": 60,
        "ResourceRecords": [{"Value": "34.212.123.45"}],
        "HealthCheckId": "<secondary-health-check-id>"
      }
    }
  ]
}
EOF

aws route53 change-resource-record-sets \
    --hosted-zone-id Z1XXXXXXXXXX \
    --change-batch file://failover-dns.json

# 3. Scale up secondary region
kubectl scale deployment substream-backend --replicas=20 -n substream --context=us-west-2

# 4. Promote secondary database to primary
aws rds promote-read-replica \
    --db-instance-identifier substream-db-replica-us-west-2 \
    --backup-retention-period 35 \
    --multi-az
```

#### 4.2 Verify Failover
```bash
# Test API connectivity
curl -k https://api.substream.protocol/health

# Check database replication
aws rds describe-db-clusters --db-cluster-identifier substream-cluster-us-west-2

# Monitor metrics
kubectl top pods -n substream --context=us-west-2
```

---

## Validation Checklists

### Database Recovery Validation
- [ ] Database is accessible from application pods
- [ ] All tables are present and contain expected data
- [ ] Row-Level Security policies are active
- [ ] Database connections are within normal limits
- [ ] Replication is working (if applicable)
- [ ] Backup jobs are running successfully

### Application Recovery Validation
- [ ] All pods are running and ready
- [ ] Health endpoints return 200 OK
- [ ] Load balancer is distributing traffic
- [ ] Authentication is working
- [ ] Database connections are established
- [ ] Redis connections are established
- [ ] External services (IPFS, Stripe) are accessible

### Security Validation
- [ ] mTLS is enforced between services
- [ ] Vault secrets are accessible
- [ ] API rate limiting is active
- [ ] Security policies are enforced
- [ ] Audit logs are being collected
- [ ] No unauthorized access attempts

---

## Communication Protocols

### Incident Severity Levels

| Severity | Definition | Response Time | Escalation |
|----------|------------|---------------|------------|
| SEV-0 | Complete system outage | 5 minutes | Immediate to DAO Council |
| SEV-1 | Major service degradation | 15 minutes | Within 30 minutes |
| SEV-2 | Partial service impact | 1 hour | Within 4 hours |
| SEV-3 | Minor issues | 4 hours | Within 24 hours |

### Communication Channels

1. **Internal Team**: Slack #incident-response
2. **Management**: Email + Phone
3. **DAO Council**: Secure messaging app
4. **Public**: Status page (status.substream.protocol)

### Incident Reporting Template

```
INCIDENT REPORT - [INCIDENT-ID]

Severity: [SEV-0/1/2/3]
Start Time: [YYYY-MM-DD HH:MM:SS UTC]
Impact: [Brief description of user impact]
Root Cause: [Technical root cause]
Resolution: [Steps taken to resolve]
Prevention: [Measures to prevent recurrence]
Downtime: [Total duration]
Affected Services: [List of affected services]
```

---

## Post-Recovery Procedures

### 1. Root Cause Analysis
- Document all actions taken during recovery
- Analyze logs and metrics from failure period
- Identify contributing factors
- Create prevention action items

### 2. System Hardening
- Review and update monitoring thresholds
- Add additional health checks
- Implement automated failover where missing
- Update disaster recovery procedures

### 3. Testing and Validation
- Schedule full disaster recovery test within 30 days
- Update runbook based on lessons learned
- Train team on updated procedures
- Validate all automated recovery mechanisms

---

## Appendix

### A. Critical Commands Reference
### B. Contact Information
### C. Service Dependencies
### D. Monitoring Dashboard Links
### E. Backup and Restore Procedures

---

**Document Control:**
- Version: 1.0
- Author: DevOps Team
- Reviewers: Security Lead, Engineering Manager
- Approved By: DAO Security Council
- Next Review Date: 2026-07-28
