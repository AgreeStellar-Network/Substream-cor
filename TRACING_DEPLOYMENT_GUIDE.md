# Distributed Tracing Deployment Guide

## Quick Start

This guide covers deploying the SubStream Protocol Backend with distributed tracing enabled.

## Table of Contents

- [Local Development](#local-development)
- [Docker Deployment](#docker-deployment)
- [Kubernetes Deployment](#kubernetes-deployment)
- [Integration with Existing Services](#integration-with-existing-services)
- [Performance Tuning](#performance-tuning)
- [Troubleshooting](#troubleshooting)

## Local Development

### 1. Start Jaeger Locally

```bash
# Using Docker
docker run -d \
  --name jaeger \
  -p 6831:6831/udp \
  -p 6832:6832/udp \
  -p 5778:5778 \
  -p 16686:16686 \
  -p 14268:14268 \
  jaegertracing/all-in-one:latest

# Access Jaeger UI at http://localhost:16686
```

### 2. Configure Environment

```bash
# Copy environment variables
cp .env.tracing.example .env

# Update for local development
cat >> .env << EOF
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_SERVICE_NAME=substream-protocol-backend
OTEL_DIAG_LEVEL=debug
OTEL_CONSOLE_EXPORTER=false
NODE_ENV=development
EOF
```

### 3. Start Application

```bash
# Terminal 1: Start API server
npm run dev

# Terminal 2: Start background worker
npm run worker:dev

# Application will be available at http://localhost:3000
```

### 4. Generate Test Traces

```bash
# Make requests to trigger traces
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/content

# View traces in Jaeger UI
# Visit http://localhost:16686
# Select service: substream-protocol-backend
# Click "Find Traces"
```

## Docker Deployment

### 1. Update Dockerfile

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# OpenTelemetry initialization must be first
ENV NODE_OPTIONS="--require ./src/utils/opentelemetry.js"

# Expose ports
EXPOSE 3000 4317

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD npm run health-check

CMD ["node", "index.js"]
```

### 2. Docker Compose Setup

```yaml
# docker-compose.yml
version: '3.8'

services:
  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "6831:6831/udp"
      - "6832:6832/udp"
      - "16686:16686"
      - "4317:4317"
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
    volumes:
      - jaeger_data:/badger/data

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: substream
      POSTGRES_USER: substream
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

  rabbitmq:
    image: rabbitmq:3.12-management-alpine
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: guest
      RABBITMQ_DEFAULT_PASS: guest
    volumes:
      - rabbitmq_data:/var/lib/rabbitmq

  backend:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://substream:${DB_PASSWORD}@postgres:5432/substream
      REDIS_URL: redis://redis:6379
      RABBITMQ_URL: amqp://guest:guest@rabbitmq:5672
      OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4317
      OTEL_SERVICE_NAME: substream-protocol-backend
      OTEL_DIAG_LEVEL: info
      OTEL_SAMPLING_RATE: 0.1
    depends_on:
      - jaeger
      - postgres
      - redis
      - rabbitmq
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  jaeger_data:
  postgres_data:
  redis_data:
  rabbitmq_data:
```

### 3. Run Stack

```bash
# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f backend

# Access Jaeger UI
# http://localhost:16686

# Stop services
docker-compose down
```

## Kubernetes Deployment

### 1. Create Jaeger Deployment

```yaml
# k8s/jaeger-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger
  template:
    metadata:
      labels:
        app: jaeger
    spec:
      containers:
      - name: jaeger
        image: jaegertracing/all-in-one:latest
        ports:
        - containerPort: 4317
          name: otlp
        - containerPort: 16686
          name: ui
        env:
        - name: COLLECTOR_OTLP_ENABLED
          value: "true"
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /
            port: 16686
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 16686
          initialDelaySeconds: 5
          periodSeconds: 5

---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
  namespace: monitoring
spec:
  selector:
    app: jaeger
  ports:
  - name: otlp
    port: 4317
    targetPort: 4317
  - name: ui
    port: 16686
    targetPort: 16686
  type: LoadBalancer
```

### 2. Backend Deployment with Tracing

```yaml
# k8s/backend-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: substream-backend
  labels:
    app: substream-backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: substream-backend
  template:
    metadata:
      labels:
        app: substream-backend
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: backend
        image: substream/backend:latest
        imagePullPolicy: Always
        ports:
        - containerPort: 3000
          name: http
        env:
        - name: NODE_ENV
          value: "production"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: database-url
        - name: REDIS_URL
          value: "redis://redis.default.svc.cluster.local:6379"
        - name: OTEL_EXPORTER_OTLP_ENDPOINT
          value: "http://jaeger.monitoring.svc.cluster.local:4317"
        - name: OTEL_SERVICE_NAME
          value: "substream-protocol-backend"
        - name: OTEL_SERVICE_VERSION
          valueFrom:
            fieldRef:
              fieldPath: metadata.labels['app.kubernetes.io/version']
        - name: OTEL_SAMPLING_RATE
          value: "0.1"
        - name: OTEL_DIAG_LEVEL
          value: "info"
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3

---
apiVersion: v1
kind: Service
metadata:
  name: substream-backend
spec:
  selector:
    app: substream-backend
  ports:
  - port: 3000
    targetPort: 3000
    name: http
  type: ClusterIP
```

### 3. Deploy to Kubernetes

```bash
# Create monitoring namespace
kubectl create namespace monitoring

# Deploy Jaeger
kubectl apply -f k8s/jaeger-deployment.yaml

# Deploy backend with tracing
kubectl apply -f k8s/backend-deployment.yaml

# Port-forward to access Jaeger UI
kubectl port-forward -n monitoring svc/jaeger 16686:16686

# Access at http://localhost:16686

# View backend logs with traces
kubectl logs -f deployment/substream-backend
```

## Integration with Existing Services

### 1. Add Tracing to Express Middleware Stack

```javascript
// index.js - CRITICAL: Initialize tracing FIRST
const dotenv = require('dotenv');
const { initTracing } = require('./src/utils/opentelemetry');

dotenv.config();

// Initialize tracing as first operation
initTracing({
  serviceName: 'substream-protocol-backend',
  serviceVersion: '1.0.0'
});

const express = require('express');
const {
  httpTracingMiddleware,
  traceContextResponseMiddleware,
  traceAwareRequestLogger
} = require('./src/middleware/httpTracingMiddleware');

const app = express();

// Add tracing middleware (must be first)
app.use(httpTracingMiddleware());
app.use(traceContextResponseMiddleware());

// Add logging middleware
app.use(traceAwareRequestLogger());

// Other middleware
app.use(express.json());
app.use(cors());

// Routes
require('./src/routes')(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  console.log(`[Tracing] Service: ${process.env.OTEL_SERVICE_NAME}`);
  console.log(`[Tracing] OTLP Endpoint: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
});
```

### 2. Instrument Existing Services

```javascript
// services/userService.js - Wrap with tracing
const { traceServiceMethods } = require('../utils/serviceInstrumentation');

class UserService {
  async getUser(userId) { /* ... */ }
  async createUser(data) { /* ... */ }
  async updateUser(userId, updates) { /* ... */ }
  async deleteUser(userId) { /* ... */ }
}

// Apply tracing
const userService = new UserService();
module.exports = traceServiceMethods(userService, 'user-service', [
  'getUser',
  'createUser',
  'updateUser',
  'deleteUser'
]);
```

### 3. Update Route Handlers

```javascript
// routes/content.js
const express = require('express');
const { withSpan, recordSpanEvent } = require('../utils/opentelemetry');

const router = express.Router();

router.get('/:id', async (req, res, next) => {
  try {
    return withSpan('route.get_content', async (span) => {
      const { id } = req.params;
      
      recordSpanEvent('fetching_content', { contentId: id });
      const content = await contentService.getContentById(id);
      
      recordSpanEvent('content_retrieved', { contentSize: content.size });
      
      res.json(content);
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

## Performance Tuning

### 1. Adjust Sampling Rate

```javascript
// Environment-specific sampling
const NODE_ENV = process.env.NODE_ENV || 'development';
const SAMPLING_RATES = {
  development: 1.0,    // 100% for debugging
  staging: 0.1,        // 10% for reasonable coverage
  production: 0.01     // 1% for minimal overhead
};

process.env.OTEL_SAMPLING_RATE = SAMPLING_RATES[NODE_ENV];
```

### 2. Batch Configuration for High Throughput

```bash
# For high-traffic services
OTEL_BATCH_SPAN_PROCESSOR_MAX_QUEUE_SIZE=4096
OTEL_BATCH_SPAN_PROCESSOR_MAX_EXPORT_BATCH_SIZE=1024
OTEL_BATCH_SPAN_PROCESSOR_SCHEDULED_DELAY_MS=1000
```

### 3. Memory Optimization

```bash
# Limit attributes to reduce memory
OTEL_SPAN_ATTRIBUTE_LIMIT=64

# Limit events per span
OTEL_SPAN_EVENT_LIMIT=32

# Limit links per span
OTEL_SPAN_LINK_LIMIT=16
```

## Troubleshooting

### Traces Not Appearing

```bash
# 1. Check OTLP endpoint connectivity
curl -i http://localhost:4317/

# 2. Verify environment variables
env | grep OTEL_

# 3. Enable verbose logging
export OTEL_DIAG_LEVEL=debug
npm run dev

# 4. Check application logs
docker logs backend | grep -i tracing
```

### High Memory Usage

```bash
# Reduce sampling rate
export OTEL_SAMPLING_RATE=0.01

# Reduce batch size
export OTEL_BATCH_SPAN_PROCESSOR_MAX_EXPORT_BATCH_SIZE=256

# Limit attributes
export OTEL_SPAN_ATTRIBUTE_LIMIT=32
```

### Connection Refused

```bash
# Verify Jaeger is running
docker ps | grep jaeger

# Check Jaeger logs
docker logs jaeger

# Verify network connectivity (Docker)
docker network inspect bridge

# For K8s, check service DNS
kubectl get svc -n monitoring
kubectl describe svc jaeger -n monitoring
```

## Monitoring the Tracing System

### 1. Health Check

```bash
curl http://localhost:3000/health/tracing
```

Response:
```json
{
  "status": "ok",
  "tracing_enabled": true,
  "active_span": false,
  "service_name": "substream-protocol-backend",
  "environment": "production"
}
```

### 2. View Metrics

```bash
curl http://localhost:3000/metrics | grep otel
```

### 3. Jaeger API Usage

```bash
# Get services
curl http://localhost:16686/api/services

# Get traces for a service
curl http://localhost:16686/api/traces?service=substream-protocol-backend

# Get specific trace
curl http://localhost:16686/api/traces/{traceId}
```

## Cleanup

### Local Development

```bash
# Stop Docker services
docker-compose down -v

# Remove Jaeger container
docker rm -f jaeger
```

### Kubernetes

```bash
# Delete backend deployment
kubectl delete deployment substream-backend

# Delete Jaeger
kubectl delete -f k8s/jaeger-deployment.yaml

# Delete namespace
kubectl delete namespace monitoring
```

## Next Steps

1. Configure alerts based on trace data
2. Set up trace-based SLOs
3. Integrate with existing monitoring dashboards
4. Implement custom span metrics
5. Add service dependencies visualization

## Support & Resources

- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [OpenTelemetry Docs](https://opentelemetry.io/docs/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
