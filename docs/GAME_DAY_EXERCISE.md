# Game Day Exercise: Multi-Region Disaster Recovery

This document provides a comprehensive plan for conducting a simulated "Game Day" exercise to artificially fail the primary database and measure the time to recover. This exercise is critical for validating the DR architecture and meeting enterprise SLA requirements.

## Exercise Overview

### Objective
Validate that the Substream-cor can survive a complete primary region failure and recover within the defined RTO (< 15 minutes) and RPO (< 15 minutes).

### Scope
- Primary region: us-east-1
- Secondary region: eu-west-1
- Components tested: PostgreSQL, Kubernetes, Redis, S3, DNS, Soroban Indexer

### Schedule
- **Frequency**: Quarterly
- **Duration**: 4-6 hours
- **Notification**: 2 weeks in advance to all stakeholders
- **Time Window**: Low-traffic period (recommended: 02:00-06:00 UTC Sunday)

## Pre-Exercise Checklist

### 2 Weeks Before

- [ ] Schedule exercise date and time with all stakeholders
- [ ] Notify customers and partners about planned maintenance
- [ ] Update status page with maintenance notice
- [ ] Ensure secondary region is fully operational
- [ ] Verify PostgreSQL replication lag < 1 minute
- [ ] Verify S3 CRR is working correctly
- [ ] Verify DNS health checks are operational
- [ ] Create incident response channel (Slack/Teams)
- [ ] Assign exercise roles and responsibilities

### 1 Week Before

- [ ] Review and update failover runbook
- [ ] Verify all Terraform configurations are up-to-date
- [ ] Test secondary region scaling capabilities
- [ ] Prepare monitoring dashboards
- [ ] Set up alerting for exercise duration
- [ ] Create exercise timeline checklist
- [ ] Prepare communication templates
- [ ] Verify backup integrity
- [ ] Test Vault DR replication

### 1 Day Before

- [ ] Final health check of secondary region
- [ ] Verify all team members are available
- [ ] Send final reminders to stakeholders
- [ ] Prepare rollback plan
- [ ] Document current system state
- [ ] Create exercise log sheet

## Exercise Roles

### Exercise Commander
- Overall coordination and decision-making
- Authorizes failover initiation
- Communicates with stakeholders
- Makes go/no-go decisions

### Database Administrator
- Executes PostgreSQL promotion
- Verifies data consistency
- Monitors database performance
- Documents database metrics

### Platform Engineer
- Manages Kubernetes operations
- Scales applications up/down
- Monitors pod health
- Verifies infrastructure status

### Network Engineer
- Manages DNS failover
- Monitors network connectivity
- Verifies routing configuration
- Troubleshoots network issues

### Application Engineer
- Verifies application functionality
- Tests API endpoints
- Monitors application logs
- Validates business logic

### Security Engineer
- Monitors security posture
- Verifies access controls
- Audits failover actions
- Ensures compliance

### Scribe
- Documents all actions and timestamps
- Records metrics and observations
- Captures lessons learned
- Produces after-action report

## Exercise Timeline

### Phase 1: Preparation (T-30 minutes)

**Time**: T-30 minutes to T-0

**Actions**:
1. Exercise Commander calls meeting
2. All team members check in
3. Verify secondary region health
4. Confirm all monitoring dashboards accessible
5. Document baseline metrics:
   - Current active users
   - API request rate
   - Database connection count
   - Replication lag
   - Cache hit rate

**Verification**:
```bash
# Baseline metrics
kubectl get pods -n substream --region us-east-1
kubectl get pods -n substream --region eu-west-1
kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"
aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name CPUUtilization ...
```

### Phase 2: Primary Failure Simulation (T+0 to T+5 minutes)

**Time**: T+0 to T+5 minutes

**Actions**:
1. Exercise Commander authorizes primary failure simulation
2. Network Engineer blocks traffic to primary region:
   ```bash
   # Option 1: Update security group to deny all traffic
   aws ec2 revoke-security-group-ingress --group-id sg-primary --protocol -1 --port -1 --source-cidr 0.0.0.0/0 --region us-east-1
   
   # Option 2: Update Route53 health check to fail
   aws route53 update-health-check --health-check-id <primary-hc-id> --disabled --region us-east-1
   ```
3. Monitor DNS failover:
   ```bash
   watch -n 5 dig api.substream.app +short
   ```
4. Verify traffic routes to secondary region
5. Document failover time

**Expected Result**: DNS fails over to secondary region within 60 seconds

**Metrics to Capture**:
- Time to DNS failover
- Number of failed requests during transition
- Error rate during failover

### Phase 3: Secondary Region Scale-Up (T+5 to T+15 minutes)

**Time**: T+5 to T+15 minutes

**Actions**:
1. Platform Engineer scales up secondary region:
   ```bash
   # Scale Kubernetes deployments
   kubectl scale deployment substream-backend --replicas=10 --region eu-west-1
   kubectl scale deployment substream-worker --replicas=5 --region eu-west-1
   
   # Scale Redis cluster
   aws elasticache modify-replication-group --replication-group-id substream-redis-eu \
     --node-group-count 6 --apply-immediately --region eu-west-1
   ```
2. Monitor pod startup:
   ```bash
   watch -n 5 kubectl get pods -n substream --region eu-west-1
   ```
3. Verify all pods are healthy
4. Document scale-up time

**Expected Result**: All pods ready within 10 minutes

**Metrics to Capture**:
- Time to scale up
- Pod startup time
- Resource utilization

### Phase 4: PostgreSQL Promotion (T+15 to T+20 minutes)

**Time**: T+15 to T+20 minutes

**Actions**:
1. Database Administrator stops application writes:
   ```bash
   kubectl scale deployment substream-backend --replicas=0 --region eu-west-1
   kubectl scale deployment substream-worker --replicas=0 --region eu-west-1
   ```
2. Verify no active connections
3. Promote PostgreSQL replica:
   ```bash
   # For RDS
   aws rds promote-read-replica --db-instance-identifier substream-postgresql-eu-west-1 --region eu-west-1
   
   # Or using pg_promote()
   kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT pg_promote();"
   ```
4. Verify promotion success
5. Document promotion time

**Expected Result**: PostgreSQL promoted within 3 minutes

**Metrics to Capture**:
- Promotion time
- Data loss (RPO)
- Replication lag before promotion

### Phase 5: Configuration Updates (T+20 to T+25 minutes)

**Time**: T+20 to T+25 minutes

**Actions**:
1. Update Vault with new database connection:
   ```bash
   vault kv put secret/data/substream DATABASE_URL="postgresql://postgres:password@postgresql-eu-west-1:5432/substream"
   ```
2. Update Kubernetes ConfigMap:
   ```bash
   kubectl patch configmap substream-config -n substream --region eu-west-1 \
     --type=json -p='{"data":{"database-host":"postgresql-eu-west-1","database-region":"eu-west-1"}}'
   ```
3. Update environment variables
4. Clear Redis cache:
   ```bash
   kubectl exec -it redis-0 -n substream --region eu-west-1 -- redis-cli FLUSHALL
   ```
5. Document configuration update time

**Expected Result**: Configuration updated within 2 minutes

**Metrics to Capture**:
- Configuration update time
- Cache clear time

### Phase 6: Application Recovery (T+25 to T+35 minutes)

**Time**: T+25 to T+35 minutes

**Actions**:
1. Platform Engineer scales up applications:
   ```bash
   kubectl scale deployment substream-backend --replicas=10 --region eu-west-1
   kubectl scale deployment substream-worker --replicas=5 --region eu-west-1
   ```
2. Monitor application logs:
   ```bash
   kubectl logs -f deployment/substream-backend -n substream --region eu-west-1
   ```
3. Application Engineer tests API endpoints:
   ```bash
   # Test health endpoint
   curl https://api.substream.app/health
   
   # Test authentication
   curl https://api.substream.app/api/auth/verify
   
   # Test subscription endpoint
   curl https://api.substream.app/api/subscription/status
   ```
4. Verify Soroban indexer:
   ```bash
   kubectl logs deployment/substream-worker -n substream --region eu-west-1 | grep "last_processed_ledger"
   kubectl exec -it substream-worker-xxx -n substream --region eu-west-1 -- node worker.js --soroban --health
   ```
5. Document application recovery time

**Expected Result**: Applications fully functional within 10 minutes

**Metrics to Capture**:
- Application startup time
- API response time
- Error rate
- Soroban indexer resume point

### Phase 7: Validation (T+35 to T+45 minutes)

**Time**: T+35 to T+45 minutes

**Actions**:
1. Security Engineer verifies access controls
2. Application Engineer performs functional testing:
   - User authentication
   - Subscription management
   - Video upload
   - Payment processing
   - Analytics queries
3. Database Administrator verifies data integrity:
   ```bash
   # Check for missing transactions
   kubectl exec -it postgresql-0 -n substream --region eu-west-1 -- psql -U postgres -c "SELECT count(*) FROM transactions WHERE created_at > NOW() - INTERVAL '1 hour';"
   ```
4. Network Engineer verifies DNS resolution
5. Platform Engineer verifies resource utilization
6. Document validation results

**Expected Result**: All validations pass

**Metrics to Capture**:
- Functional test results
- Data integrity checks
- Resource utilization
- Security audit results

### Phase 8: Stabilization (T+45 to T+60 minutes)

**Time**: T+45 to T+60 minutes

**Actions**:
1. Configure backups for new primary:
   ```bash
   aws rds modify-db-instance --db-instance-identifier substream-postgresql-eu-west-1 \
     --backup-retention-period 7 --region eu-west-1
   ```
2. Monitor system performance
3. Adjust resource allocations if needed
4. Update documentation
5. Notify stakeholders
6. Document stabilization time

**Expected Result**: System stable with normal performance

**Metrics to Capture**:
- Backup configuration status
- Performance metrics
- Resource adjustments

### Phase 9: Rollback (T+60 to T+90 minutes)

**Time**: T+60 to T+90 minutes

**Actions**:
1. Restore primary region:
   ```bash
   # Re-enable primary region security group
   aws ec2 authorize-security-group-ingress --group-id sg-primary --protocol -1 --port -1 --source-cidr 0.0.0.0/0 --region us-east-1
   
   # Scale down secondary region
   kubectl scale deployment substream-backend --replicas=1 --region eu-west-1
   kubectl scale deployment substream-worker --replicas=1 --region eu-west-1
   ```
2. Configure PostgreSQL as read-replica (if primary recovered)
3. Update DNS back to primary
4. Verify failback
5. Document rollback time

**Expected Result**: System restored to normal configuration

**Metrics to Capture**:
- Rollback time
- Failback success
- Data consistency after failback

### Phase 10: Post-Exercise Review (T+90 to T+120 minutes)

**Time**: T+90 to T+120 minutes

**Actions**:
1. Conduct hotwash meeting
2. Collect metrics and observations
3. Document lessons learned
4. Identify improvements needed
5. Update runbooks and documentation
6. Schedule follow-up actions
7. Create after-action report

## Success Criteria

The exercise is considered successful if:

1. **RTO Met**: Full recovery within 15 minutes
2. **RPO Met**: Data loss less than 15 minutes
3. **DNS Failover**: Automatic failover within 60 seconds
4. **Application Recovery**: All services functional
5. **Data Integrity**: No data corruption
6. **Soroban Indexer**: Resumes from last known ledger
7. **Redis Cache**: Successfully cleared
8. **No Customer Impact**: Minimal disruption to users
9. **Documentation**: All actions documented
10. **Rollback**: Successful return to normal state

## Failure Modes

### If DNS Failover Fails

**Symptoms**: DNS continues to resolve to primary region

**Actions**:
1. Manually update DNS records
2. Increase health check interval
3. Investigate Route53 configuration
4. Consider Cloudflare as backup DNS

### If PostgreSQL Promotion Fails

**Symptoms**: pg_promote() fails or RDS promotion times out

**Actions**:
1. Try manual promotion method
2. Check replication status
3. Consider point-in-time recovery
4. Escalate to AWS support

### If Applications Fail to Start

**Symptoms**: Pods crash or fail to become ready

**Actions**:
1. Check application logs
2. Verify configuration
3. Check resource limits
4. Consider using previous image version

### If Data Loss Exceeds RPO

**Symptoms**: Replication lag > 15 minutes

**Actions**:
1. Document actual RPO
2. Investigate cause of lag
3. Consider improving network bandwidth
4. Update RPO targets if necessary

## Measurement Template

```markdown
# Game Day Exercise Metrics

## Timeline
- Start Time: [T-30 minutes]
- Primary Failure: [T+0]
- DNS Failover: [T+X minutes]
- Scale-Up Complete: [T+Y minutes]
- PostgreSQL Promoted: [T+Z minutes]
- Applications Recovered: [T+A minutes]
- Validation Complete: [T+B minutes]
- Total Recovery Time: [T+B minutes]

## RTO Metrics
- Target RTO: 15 minutes
- Actual RTO: [X] minutes
- Met: [Yes/No]

## RPO Metrics
- Target RPO: 15 minutes
- Actual RPO: [X] minutes
- Data Loss: [X] transactions
- Met: [Yes/No]

## Component Metrics
- DNS Failover Time: [X] seconds
- PostgreSQL Promotion Time: [X] minutes
- Application Scale-Up Time: [X] minutes
- Redis Cache Clear Time: [X] seconds
- Configuration Update Time: [X] minutes
- Soroban Indexer Resume Time: [X] minutes

## Performance Metrics
- API Response Time (pre-failover): [X] ms
- API Response Time (post-failover): [X] ms
- Database CPU (pre-failover): [X]%
- Database CPU (post-failover): [X]%
- Error Rate (during failover): [X]%
- Error Rate (post-failover): [X]%

## Customer Impact
- Affected Users: [X]
- Failed Requests: [X]
- Duration of Outage: [X] minutes
- Customer Complaints: [X]
```

## Communication Plan

### Pre-Exercise
- **2 weeks before**: Email to all stakeholders
- **1 week before**: Status page update
- **1 day before**: Final reminder to team

### During Exercise
- **T-5 minutes**: Exercise start notification
- **T+0 minutes**: Primary failure notification
- **T+15 minutes**: Progress update
- **T+30 minutes**: Progress update
- **T+45 minutes**: Recovery complete notification
- **T+60 minutes**: Rollback notification

### Post-Exercise
- **Immediately**: Status page update
- **1 hour after**: Email summary to stakeholders
- **1 day after**: After-action report
- **1 week after**: Follow-up improvements

## Emergency Contacts

| Role | Name | Phone | Email |
|------|------|-------|-------|
| Exercise Commander | [Name] | [Phone] | [Email] |
| Database Administrator | [Name] | [Phone] | [Email] |
| Platform Engineer | [Name] | [Phone] | [Email] |
| Network Engineer | [Name] | [Phone] | [Email] |
| Application Engineer | [Name] | [Phone] | [Email] |
| Security Engineer | [Name] | [Phone] | [Email] |
| CTO | [Name] | [Phone] | [Email] |

## Escalation Matrix

| Issue Type | Primary Contact | Escalation | Timeline |
|------------|----------------|------------|----------|
| DNS Failover Failure | Network Engineer | Exercise Commander | 5 minutes |
| PostgreSQL Promotion Failure | DBA | AWS Support | 5 minutes |
| Application Startup Failure | Platform Engineer | Engineering Lead | 5 minutes |
| Data Loss > RPO | DBA | CTO + Legal | Immediate |
| Security Breach | Security Engineer | CTO + Legal | Immediate |
| Customer Impact > 10% | Exercise Commander | CEO | Immediate |

## Lessons Learned Template

```markdown
# Game Day Exercise - Lessons Learned

## What Went Well
- [List successes]
- [What exceeded expectations]
- [Best practices to continue]

## What Didn't Go Well
- [List failures]
- [What didn't meet expectations]
- [Areas for improvement]

## Timeline Analysis
- [Which phases took longer than expected]
- [Which phases were faster than expected]
- [Bottlenecks identified]

## Process Improvements
- [Runbook updates needed]
- [Automation opportunities]
- [Documentation gaps]

## Technical Improvements
- [Infrastructure changes needed]
- [Configuration improvements]
- [Monitoring enhancements]

## Communication Improvements
- [Notification timing]
- [Stakeholder communication]
- [Status page updates]

## Action Items
1. [Owner] - [Task] - [Due Date]
2. [Owner] - [Task] - [Due Date]
3. [Owner] - [Task] - [Due Date]

## Next Exercise Date
- [Scheduled date]
- [Improvements to implement]
- [Goals for next exercise]
```

## Approval

**Exercise Commander**: _________________ Date: _______

**CTO**: _________________ Date: _______

**Security Team**: _________________ Date: _______

## Related Documentation

- [Disaster Recovery Architecture](./DISASTER_RECOVERY_ARCHITECTURE.md)
- [PostgreSQL Failover Runbook](./POSTGRESQL_FAILOVER_RUNBOOK.md)
- [Route53 Failover Configuration](../terraform/secondary-region/route53-failover.tf)
