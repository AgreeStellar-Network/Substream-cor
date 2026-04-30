# HPA DevOps Runbook

## Overview

This runbook provides comprehensive guidance for managing and troubleshooting the Horizontal Pod Autoscaler (HPA) configuration for the SubStream Protocol Backend. The HPA ensures the backend can dynamically react to massive traffic spikes without manual DevOps intervention.

## Architecture

### Components

1. **Main Backend HPA** (`substream-backend-hpa`)
   - Scales based on CPU utilization (70% threshold)
   - Min replicas: 3, Max replicas: 50
   - Scale-up: 100% or 4 pods every 15 seconds
   - Scale-down: 10% every 60 seconds with 300s stabilization

2. **Worker HPA** (`substream-worker-hpa`)
   - Scales based on CPU utilization (70% threshold)
   - Scales based on Redis queue length (>1000 items)
   - Min replicas: 2, Max replicas: 20
   - Scale-up: 200% or 5 pods every 15 seconds
   - Scale-down: 10% every 60 seconds with 600s stabilization

3. **External Metrics Adapter** (`redis-metrics-adapter`)
   - Monitors Redis queue length for Soroban events
   - Exposes metrics for Prometheus
   - Enables queue-based scaling

## Monitoring

### Key Metrics to Monitor

#### CPU-Based Scaling
```bash
# Check HPA status
kubectl get hpa substream-backend-hpa -n substream -o yaml

# Monitor current CPU utilization
kubectl top pods -n substream -l app=substream-backend

# Check HPA events
kubectl describe hpa substream-backend-hpa -n substream
```

#### Queue-Based Scaling
```bash
# Check Redis queue length
kubectl exec -n substream deployment/redis -- redis-cli llen soroban_events_queue

# Monitor worker HPA status
kubectl get hpa substream-worker-hpa -n substream -o yaml

# Check worker pod count
kubectl get pods -n substream -l app=substream-worker
```

#### Prometheus Metrics
- `redis_queue_length{queue="soroban_events"}` - Current queue length
- `kube_hpa_status_current_replicas` - Current replica count
- `kube_hpa_status_desired_replicas` - Desired replica count
- `container_cpu_usage_seconds_total` - CPU usage per container

### Alerting Rules

#### High CPU Utilization
```yaml
- alert: HighCPUUtilization
  expr: rate(container_cpu_usage_seconds_total[5m]) * 100 > 70
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High CPU utilization detected"
    description: "CPU utilization is above 70% for 5 minutes"
```

#### Redis Queue Backlog
```yaml
- alert: RedisQueueBacklogHigh
  expr: redis_queue_length{queue="soroban_events"} > 1000
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "Redis queue backlog is high"
    description: "Soroban events queue has {{ $value }} pending items"
```

#### HPA Scaling Events
```yaml
- alert: HPAAtMaxReplicas
  expr: kube_hpa_status_current_replicas == kube_hpa_spec_max_replicas
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: "HPA reached maximum replicas"
    description: "HPA {{ $labels.hpa }} has been at max replicas for 10 minutes"
```

## Troubleshooting

### Common Issues

#### 1. HPA Not Scaling Up

**Symptoms:**
- High CPU utilization but no new pods
- HPA shows desired replicas = current replicas

**Troubleshooting Steps:**
```bash
# Check HPA configuration
kubectl get hpa substream-backend-hpa -n substream -o yaml

# Check metrics server status
kubectl get pods -n kube-system | grep metrics-server

# Verify resource requests are set
kubectl describe deployment substream-backend -n substream | grep -A 10 "Resources:"

# Check if metrics are available
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/substream/pods"
```

**Common Causes:**
- Metrics server not running
- Resource requests not configured
- Insufficient cluster resources
- Pod disruption budgets blocking scaling

#### 2. HPA Scaling Too Frequently (Thrashing)

**Symptoms:**
- Rapid scale-up and scale-down cycles
- Pod count fluctuating frequently

**Solutions:**
```bash
# Increase stabilization window
kubectl patch hpa substream-backend-hpa -n substream -p '{"spec":{"behavior":{"scaleDown":{"stabilizationWindowSeconds":600}}}}'

# Check current behavior configuration
kubectl get hpa substream-backend-hpa -n substream -o yaml | grep -A 10 behavior
```

#### 3. Redis Queue Not Triggering Worker Scaling

**Symptoms:**
- High Redis queue length but no worker scaling
- External metrics not available

**Troubleshooting Steps:**
```bash
# Check metrics adapter pod
kubectl get pods -n substream -l app=redis-metrics-adapter

# Check metrics adapter logs
kubectl logs -n substream -l app=redis-metrics-adapter

# Verify external metrics are available
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/substream/redis_queue_length"

# Check Prometheus adapter configuration
kubectl get prometheusrules -n substream
```

#### 4. Slow Startup During Scale Events

**Symptoms:**
- New pods taking >10 seconds to become ready
- HPA scaling not effective during traffic spikes

**Troubleshooting Steps:**
```bash
# Run startup time test
./scripts/startup-time-test.sh

# Check pod readiness probe configuration
kubectl describe deployment substream-backend -n substream | grep -A 10 "Readiness:"

# Monitor pod startup events
kubectl get events -n substream --field-selector involvedObject.name=substream-backend
```

### Performance Tuning

#### Optimizing Scale-Up Response
```yaml
# More aggressive scale-up for critical services
behavior:
  scaleUp:
    stabilizationWindowSeconds: 0
    policies:
    - type: Percent
      value: 200  # Increase to 200%
      periodSeconds: 10  # Reduce to 10 seconds
    - type: Pods
      value: 10  # Increase to 10 pods
      periodSeconds: 10
```

#### Optimizing Scale-Down Stability
```yaml
# Prevent thrashing during fluctuating load
behavior:
  scaleDown:
    stabilizationWindowSeconds: 900  # 15 minutes
    policies:
    - type: Percent
      value: 5  # More conservative scale-down
      periodSeconds: 60
```

## Maintenance

### Regular Checks

#### Daily
```bash
# Check HPA status
kubectl get hpa -n substream

# Monitor resource utilization
kubectl top pods -n substream

# Check queue lengths
kubectl exec -n substream deployment/redis -- redis-cli llen soroban_events_queue
```

#### Weekly
```bash
# Run load tests
./scripts/test-hpa-scaling.sh

# Validate startup times
./scripts/startup-time-test.sh

# Review scaling events
kubectl get events -n substream --field-selector reason=SuccessfulCreate
```

### Scaling Adjustments

#### Adjusting CPU Threshold
```bash
# Change CPU target from 70% to 60%
kubectl patch hpa substream-backend-hpa -n substream -p '{"spec":{"metrics":[{"type":"Resource","resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":60}}}]}}'
```

#### Adjusting Replica Limits
```bash
# Increase max replicas to 100
kubectl patch hpa substream-backend-hpa -n substream -p '{"spec":{"maxReplicas":100}}'
```

## Emergency Procedures

### Traffic Spike Response

1. **Immediate Actions:**
   ```bash
   # Manually scale up if HPA is slow to respond
   kubectl scale deployment substream-backend --replicas=20 -n substream
   kubectl scale deployment substream-worker --replicas=10 -n substream
   ```

2. **Monitor System:**
   ```bash
   # Watch pod creation
   watch kubectl get pods -n substream
   
   # Monitor HPA status
   watch kubectl get hpa -n substream
   ```

3. **Post-Incident Review:**
   - Analyze scaling events
   - Review HPA configuration
   - Consider adjusting thresholds or limits

### Resource Exhaustion

1. **Identify Bottlenecks:**
   ```bash
   # Check cluster resource usage
   kubectl top nodes
   
   # Check pending pods
   kubectl get pods -n substream --field-selector status.phase=Pending
   ```

2. **Mitigation Actions:**
   - Scale down non-critical services
   - Request additional cluster resources
   - Implement resource quotas

## Testing

### Load Testing

#### CPU-Based Scaling Test
```bash
# Run K6 load test
k6 run tests/load/hpa-verification-test.js \
  --env BASE_URL=http://your-load-balancer-url
```

#### Queue-Based Scaling Test
```bash
# Generate queue backlog
for i in {1..2000}; do
  curl -X POST http://api-url/soroban/events \
    -H "Content-Type: application/json" \
    -d '{"event_type": "test", "data": {"id": '$i'}}'
done

# Monitor worker scaling
watch kubectl get pods -n substream -l app=substream-worker
```

### Validation Checklist

- [ ] HPA configuration matches requirements
- [ ] Resource requests and limits are set
- [ ] Metrics server is operational
- [ ] External metrics adapter is working
- [ ] Load tests trigger expected scaling
- [ ] Scale-down occurs during low traffic
- [ ] No thrashing behavior observed
- [ ] Startup times under 10 seconds
- [ ] Database connections handle scale-up

## Configuration Reference

### HPA Configuration Values

| Parameter | Backend | Worker | Description |
|-----------|---------|--------|-------------|
| minReplicas | 3 | 2 | Minimum pod count |
| maxReplicas | 50 | 20 | Maximum pod count |
| targetCPU | 70% | 70% | CPU utilization target |
| queueThreshold | N/A | 1000 | Redis queue length threshold |
| scaleDownStabilization | 300s | 600s | Scale-down delay |
| scaleUpPercent | 100% | 200% | Scale-up percentage |
| scaleUpPeriod | 15s | 15s | Scale-up evaluation period |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| DB_POOL_MAX / DB_MAX_CONNECTIONS | 10 | Maximum PostgreSQL connections per pod. Keep this low enough that `maxReplicas * DB_POOL_MAX` stays below the database connection budget. |
| DB_POOL_MIN | 0 | Minimum idle PostgreSQL connections per pod. Defaults to zero so scaled-out idle pods do not reserve database sessions. |
| DB_POOL_IDLE_TIMEOUT_MS | 10000 | Time before idle PostgreSQL clients are released. |
| DB_POOL_CONNECTION_TIMEOUT_MS | 3000 | Time to wait for a PostgreSQL connection before failing fast. |
| DB_STATEMENT_TIMEOUT_MS | 30000 | PostgreSQL statement timeout applied to pooled clients. |
| DB_IDLE_IN_TRANSACTION_TIMEOUT_MS | 15000 | Timeout for clients left idle in a transaction. |
| DB_TENANT_POOL_CACHE_MAX | 10 | Maximum tenant database pools cached per process before least-recently-used eviction. |
| DB_TENANT_POOL_MAX | 4 | Maximum PostgreSQL connections for each tenant-specific Knex pool. |
| REDIS_HOST | redis-service | Redis server host |
| REDIS_PORT | 6379 | Redis server port |
| NODE_ENV | production | Application environment |

## Contacts

- **Primary DevOps:** devops@substream.protocol
- **On-call Engineer:** oncall@substream.protocol
- **Development Team:** dev@substream.protocol

## Related Documentation

- [Kubernetes HPA Documentation](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [Prometheus Metrics](https://prometheus.io/docs/practices/metrics/)
- [K6 Load Testing](https://k6.io/docs/)
- [Redis Monitoring](https://redis.io/topics/monitoring)
