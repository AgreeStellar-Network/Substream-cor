# Substream-cor Monitoring Setup

This document explains how to set up Prometheus monitoring, Grafana dashboards, and alerting for the Substream-cor.

## Overview

The backend exposes a `/metrics` endpoint that provides RED (Rate, Errors, Duration) metrics and custom business metrics for monitoring.

## Metrics Exposed

### RED Metrics
- `http_requests_total`: Total HTTP requests by method, route, and status code
- `http_request_duration_seconds`: Histogram of request durations

### Custom Business Metrics
- `total_mrr_processed_today`: Gauge showing total MRR processed today
- `soroban_indexer_ledger_lag`: Gauge showing indexer lag in ledgers
- `database_connections_active`: Gauge showing active database connections

## Setup Instructions

### 1. Deploy ServiceMonitor

Apply the ServiceMonitor to enable Prometheus scraping:

```bash
kubectl apply -f k8s/servicemonitor.yaml
```

### 2. Import Grafana Dashboard

1. Open Grafana in your browser
2. Go to Dashboards → Import
3. Upload the `k8s/grafana-dashboard.json` file
4. Select the appropriate Prometheus data source

### 3. Configure Alerts

The PrometheusRule in `servicemonitor.yaml` includes the following alerts:

- **High5xxErrorRate**: Triggers when 5xx error rate exceeds 2% for 5 minutes
- **SorobanIndexerLagHigh**: Triggers when indexer lag exceeds 50 ledgers
- **DatabaseConnectionsHigh**: Triggers when active connections exceed 50
- **APILatencyHigh**: Triggers when p95 latency exceeds 5 seconds

### 4. Tune Alert Thresholds

Adjust thresholds in `k8s/servicemonitor.yaml` based on your environment:

```yaml
# Example: Adjust 5xx error rate threshold
- alert: High5xxErrorRate
  expr: rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05  # Changed from 0.02
  for: 10m  # Changed from 5m
```

### 5. Security

The `/metrics` endpoint is protected from public access via the Ingress configuration in `k8s/ingress.yaml`, which denies all requests to `/metrics`.

## Dashboard Panels

The Grafana dashboard includes:

1. **API Request Rate**: Requests per second by endpoint
2. **API Error Rate**: 4xx and 5xx error rates
3. **API Latency Percentiles**: p50, p95, p99 response times
4. **Active Database Connections**: Current connection count
5. **Soroban Indexer Lag**: Ledgers behind network
6. **Total MRR Processed Today**: Revenue metric

## Troubleshooting

### Metrics Not Appearing
- Verify ServiceMonitor is applied: `kubectl get servicemonitor`
- Check Prometheus targets: Ensure the backend pods are discovered
- Test metrics endpoint: `curl http://backend-pod-ip:3000/metrics`

### Alerts Not Firing
- Verify PrometheusRule is loaded: `kubectl get prometheusrules`
- Check alertmanager configuration
- Test alert expressions in Prometheus UI

### High Cardinality
The metrics are designed with low cardinality by using limited label values. Monitor Prometheus performance and adjust if needed.