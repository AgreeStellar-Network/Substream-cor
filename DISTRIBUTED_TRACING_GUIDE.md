# Distributed Tracing Implementation Guide

## Overview

This guide covers the comprehensive distributed tracing implementation using OpenTelemetry for the SubStream Protocol Backend. Distributed tracing enables cross-service transaction debugging, performance monitoring, and troubleshooting across the entire system.

## Table of Contents

1. [Architecture](#architecture)
2. [Components](#components)
3. [Configuration](#configuration)
4. [Integration Patterns](#integration-patterns)
5. [Usage Examples](#usage-examples)
6. [Best Practices](#best-practices)
7. [Troubleshooting](#troubleshooting)
8. [Performance Considerations](#performance-considerations)

## Architecture

### System Design

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Request                              │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   HTTP Tracing Middleware                       │
│  ├─ Extract trace context from headers                         │
│  ├─ Generate correlation ID                                    │
│  ├─ Create root span                                           │
│  └─ Propagate context to handlers                              │
└──────────┬──────────────────────────────────────────────┬───────┘
           │                                              │
           ▼                                              ▼
┌────────────────────────────────┐  ┌──────────────────────────────┐
│   Service Layer Spans          │  │  Database Query Spans         │
│  ├─ Auth operations            │  │  ├─ SELECT queries           │
│  ├─ Content filtering          │  │  ├─ INSERT/UPDATE           │
│  ├─ Analytics processing       │  │  ├─ Transactions            │
│  └─ Storage operations         │  │  └─ Connection pool stats   │
└────────────┬───────────────────┘  └──────────────┬───────────────┘
             │                                     │
             ▼                                     ▼
┌────────────────────────────────┐  ┌──────────────────────────────┐
│   External Service Spans       │  │  Cache Operation Spans        │
│  ├─ IPFS calls                 │  │  ├─ Redis GET                │
│  ├─ Stripe API                 │  │  ├─ Redis SET                │
│  ├─ Stellar RPC                │  │  ├─ Cache invalidation       │
│  ├─ Web3.Storage               │  │  └─ Failover attempts        │
│  └─ Pinata API                 │  │                              │
└────────────┬───────────────────┘  └──────────────┬───────────────┘
             │                                     │
             └──────────────────┬──────────────────┘
                                │
                                ▼
                ┌───────────────────────────────┐
                │   Span Processor & Exporter   │
                │  ├─ Batch processing          │
                │  ├─ Context propagation       │
                │  └─ Export to collector       │
                └───────────────┬───────────────┘
                                │
                                ▼
                  ┌─────────────────────────────┐
                  │  OpenTelemetry Collector    │
                  │  or Backend (Jaeger, etc)   │
                  └─────────────────────────────┘
```

## Components

### 1. **OpenTelemetry Core** (`src/utils/opentelemetry.js`)

The main initialization module that sets up the OpenTelemetry SDK with:
- Automatic Node.js instrumentation
- HTTP and Express instrumentation
- Database instrumentation (PostgreSQL, Redis)
- Message queue instrumentation (RabbitMQ/AMQP)

```javascript
const { initTracing, getTracer, withSpan } = require('./src/utils/opentelemetry');

// Initialize in main.js
initTracing({
  serviceName: 'substream-protocol-backend',
  serviceVersion: '1.0.0'
});
```

### 2. **Tracing Utilities** (`src/utils/tracingUtils.js`)

Helper functions for manual span creation and context management:

- `createModuleTracer(moduleName)` - Create tracer for specific module
- `getTraceId()` / `getSpanId()` - Get current context IDs
- `withSpan()` - Execute code within a span
- `traceAsync()` / `traceSync()` - Wrap functions with automatic tracing
- Specialized span creators: `createDbSpan()`, `createHttpSpan()`, `createCacheSpan()`, etc.

### 3. **HTTP Tracing Middleware** (`src/middleware/httpTracingMiddleware.js`)

Automatic HTTP request/response tracing:

- `httpTracingMiddleware()` - Main middleware for Express/Fastify
- `traceContextResponseMiddleware()` - Add trace headers to responses
- `traceAwareRequestLogger()` - Enhanced request logging with trace context
- `TracingGuard` - NestJS decorator support

**Features:**
- Automatic correlation ID generation/tracking
- W3C Trace Context header extraction
- Request/response attribute capture
- Status code tracking

### 4. **Trace Context Propagation** (`src/utils/traceContextPropagation.js`)

Manages cross-service trace context:

- **W3C Trace Context** - Standard format (recommended)
- **B3 Format** - Zipkin compatibility
- **Multi-format Propagator** - Supports both formats

**Functions:**
- `W3CTraceContextPropagator` - W3C standard implementation
- `B3TraceContextPropagator` - B3 format support
- `setupAxiosTracing()` - Auto-inject headers in axios
- `createTracedFetch()` - Wrap fetch with trace propagation
- `attachTraceContext()` - Add headers to any request

### 5. **Service Instrumentation** (`src/utils/serviceInstrumentation.js`)

Adds tracing to service classes and methods:

- `createTracedService()` - Auto-instrument all service methods
- `traceServiceMethods()` - Selective method tracing
- Specialized tracers for: Auth, Database, Cache, Queue, HTTP Client

## Configuration

### Environment Variables

```bash
# OpenTelemetry Core
OTEL_DISABLED=false                              # Disable all tracing
OTEL_SERVICE_NAME=substream-protocol-backend    # Service name
OTEL_SERVICE_VERSION=1.0.0                      # Service version
OTEL_DIAG_LEVEL=error                           # Log level (debug, info, warn, error)

# OTLP Exporter (standard)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317     # OTLP collector
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4317/v1/traces
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20token,Custom-Header=value

# Tracing Configuration
OTEL_IGNORE_PATHS=/health,/metrics,/status     # Exclude paths from tracing
OTEL_SAMPLING_RATE=0.1                         # Sample 10% of traces
NODE_ENV=development                           # Environment
```

### Docker Compose Setup

```yaml
version: '3.8'

services:
  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "6831:6831/udp"
      - "6832:6832/udp"
      - "5778:5778"
      - "16686:16686"  # Jaeger UI
      - "14268:14268"  # OTLP receiver
    environment:
      COLLECTOR_OTLP_ENABLED: "true"

  backend:
    build: .
    ports:
      - "3000:3000"
    environment:
      OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:14268/api/traces
      OTEL_SERVICE_NAME: substream-protocol-backend
      NODE_ENV: production
    depends_on:
      - jaeger
```

## Integration Patterns

### 1. Basic Middleware Setup

```javascript
// index.js or main.ts
const express = require('express');
const { initTracing } = require('./src/utils/opentelemetry');
const { httpTracingMiddleware, traceAwareRequestLogger } = require('./src/middleware/httpTracingMiddleware');

// Initialize tracing FIRST
initTracing({
  serviceName: 'substream-protocol-backend',
  serviceVersion: '1.0.0'
});

const app = express();

// Add tracing middleware
app.use(httpTracingMiddleware());
app.use(traceAwareRequestLogger());

// Your other middleware...
app.use(cors());
app.use(express.json());
```

### 2. Service Method Tracing

```javascript
// services/userService.js
const { createTracedService, traceServiceMethods } = require('../utils/serviceInstrumentation');

class UserService {
  async getUserById(userId) {
    // Implementation
  }

  async createUser(userData) {
    // Implementation
  }

  async updateUser(userId, updates) {
    // Implementation
  }
}

// Option A: Wrap entire class
module.exports = createTracedService(UserService, 'user-service');

// Option B: Selective tracing
const service = new UserService();
module.exports = traceServiceMethods(service, 'user-service', [
  'getUserById',
  'createUser',
  'updateUser'
]);
```

### 3. Database Operation Tracing

```javascript
// services/databaseService.js
const { createDatabaseTracing } = require('../utils/serviceInstrumentation');
const dbTracing = createDatabaseTracing();

async function queryDatabase(query, params) {
  const tracer = dbTracing.traceQuery('SELECT', 'users', query);

  try {
    const result = await db.query(query, params);
    tracer.end(result.rowCount);
    return result.rows;
  } catch (error) {
    tracer.error(error);
    throw error;
  }
}
```

### 4. HTTP Client Tracing (Axios)

```javascript
// config/axios.js
const axios = require('axios');
const { setupAxiosTracing } = require('../utils/traceContextPropagation');

const axiosInstance = axios.create({
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Add tracing to all axios requests
setupAxiosTracing(axiosInstance, { format: 'w3c' });

module.exports = axiosInstance;
```

### 5. External Service Calls with Trace Propagation

```javascript
// services/ipfsService.js
const { createHttpClientTracing } = require('../utils/serviceInstrumentation');
const { getContextHeaders } = require('../utils/traceContextPropagation');
const httpTracing = createHttpClientTracing();

async function pinContent(contentHash) {
  const url = `https://api.pinata.cloud/pinning/pinByHash`;
  const tracer = httpTracing.traceRequest('POST', url, 'pinata');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PINATA_JWT}`,
        ...getContextHeaders(null, 'w3c')  // Add trace context
      },
      body: JSON.stringify({ hashToPin: contentHash })
    });

    const data = await response.json();
    tracer.end(response.status, JSON.stringify(data).length);
    return data;
  } catch (error) {
    tracer.error(error, 0);
    throw error;
  }
}
```

### 6. Queue Operation Tracing

```javascript
// services/eventPublisher.js
const { createQueueTracing } = require('../utils/serviceInstrumentation');
const queueTracing = createQueueTracing();

async function publishEvent(queue, message) {
  const tracer = queueTracing.tracePublish(queue, message.type);

  try {
    const channel = await amqp.connection.createChannel();
    await channel.assertQueue(queue);
    const published = channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));

    tracer.end(message.id);
    return published;
  } catch (error) {
    tracer.error(error);
    throw error;
  }
}
```

### 7. Cache Operation Tracing

```javascript
// services/cacheService.js
const { createCacheTracing } = require('../utils/serviceInstrumentation');
const cacheTracing = createCacheTracing();

async function getFromCache(key) {
  const tracer = cacheTracing.traceGet(key);

  try {
    const value = await redis.get(key);
    const hit = value !== null;
    tracer.end(hit, value);
    return value;
  } catch (error) {
    tracer.error(error);
    throw error;
  }
}
```

## Usage Examples

### Example 1: Tracing a Complete User Registration Flow

```javascript
// routes/auth.js
const express = require('express');
const { withSpan, recordSpanEvent } = require('../utils/opentelemetry');
const { getTraceId, getCorrelationId } = require('../utils/tracingUtils');

router.post('/register', async (req, res) => {
  return withSpan('auth.register', async (rootSpan) => {
    const { email, password } = req.body;
    const traceId = getTraceId();
    const correlationId = req.correlationId;

    rootSpan.setAttributes({
      'user.email': email,
      'trace.id': traceId,
      'correlation.id': correlationId
    });

    try {
      // Validate input
      recordSpanEvent('validation.start');
      const validationResult = await validateUserInput(email, password);
      recordSpanEvent('validation.complete', { success: true });

      // Create database record
      recordSpanEvent('db.create_user');
      const user = await userService.createUser(email, password);
      recordSpanEvent('db.user_created', { userId: user.id });

      // Send verification email
      recordSpanEvent('email.send_verification');
      await emailService.sendVerification(email, user.id);
      recordSpanEvent('email.sent', { success: true });

      res.status(201).json({
        success: true,
        userId: user.id,
        message: 'User created successfully'
      });
    } catch (error) {
      recordSpanException(error, { step: 'registration' });
      res.status(400).json({ error: error.message });
    }
  });
});
```

### Example 2: Viewing Analytics Flow with Multiple Services

```javascript
// services/analyticsService.js
const { getTracer } = require('../utils/opentelemetry');
const { createDatabaseTracing } = require('../utils/serviceInstrumentation');

class AnalyticsService {
  async getVideoAnalytics(videoId, userId) {
    const tracer = getTracer('analytics-service');
    const rootSpan = tracer.startSpan('analytics.getVideoStats', {
      attributes: {
        'video.id': videoId,
        'user.id': userId
      }
    });

    try {
      // Get basic video info
      const videoSpan = tracer.startSpan('analytics.getVideoInfo');
      const video = await this.db.query('SELECT * FROM videos WHERE id = $1', [videoId]);
      videoSpan.end();

      // Get view statistics
      const statsSpan = tracer.startSpan('analytics.getViewStats');
      const stats = await this.db.query(
        'SELECT COUNT(*) as views, AVG(watch_time) as avg_watch FROM analytics WHERE video_id = $1',
        [videoId]
      );
      statsSpan.end();

      // Get engagement heatmap
      const heatmapSpan = tracer.startSpan('analytics.generateHeatmap');
      const heatmap = await this.generateHeatmap(videoId);
      heatmapSpan.end();

      rootSpan.setAttributes({
        'analytics.total_views': stats[0]?.views || 0,
        'analytics.avg_watch_time': stats[0]?.avg_watch || 0,
        'analytics.heatmap_points': heatmap.length
      });

      return {
        video: video[0],
        statistics: stats[0],
        heatmap
      };
    } catch (error) {
      rootSpan.recordException(error);
      throw error;
    } finally {
      rootSpan.end();
    }
  }
}
```

## Best Practices

### 1. **Naming Conventions**

- **Span Names**: Use dot notation for hierarchy (`service.operation`)
  ```javascript
  // ✅ Good
  'auth.login'
  'db.query_users'
  'cache.redis_set'
  'http.client.post_to_ipfs'
  
  // ❌ Avoid
  'LoginUser'
  'database-operation'
  'HTTP POST REQUEST'
  ```

- **Attributes**: Use lowercase with underscores
  ```javascript
  span.setAttributes({
    'user.id': userId,
    'request.method': 'POST',
    'cache.key': key,
    'error.type': 'validation_error'
  });
  ```

### 2. **Span Attributes**

Always capture relevant context without sensitive data:

```javascript
// ✅ Good - Capture relevant non-sensitive data
span.setAttributes({
  'user.id': userId,           // Safe: user ID
  'request.size': 1024,        // Safe: size
  'response.status': 200,      // Safe: status code
  'operation.count': 5,        // Safe: count
  'cache.hit': true            // Safe: boolean
});

// ❌ Avoid - Don't capture sensitive data
span.setAttributes({
  'user.password': password,       // DANGER: password
  'request.body': fullBody,        // DANGER: PII
  'credit_card': cardNumber,       // DANGER: payment info
  'api_key': apiKey                // DANGER: secrets
});
```

### 3. **Error Handling**

Always record exceptions with context:

```javascript
// ✅ Good error tracking
try {
  await operation();
} catch (error) {
  span.recordException(error);
  span.setAttributes({
    'error.type': error.constructor.name,
    'error.message': error.message,
    'error.code': error.code,
    'retry.attempt': attemptNumber
  });
  span.setStatus({ 
    code: SpanStatusCode.ERROR, 
    message: error.message 
  });
  throw error;
}
```

### 4. **Correlation ID Usage**

Maintain correlation IDs across all services:

```javascript
// ✅ Propagate correlation ID
const correlationId = req.get('x-correlation-id') || uuidv4();
const headers = getContextHeaders(correlationId);

const response = await fetch(externalUrl, {
  headers: headers  // Includes both trace context AND correlation ID
});

// In logs
logger.info('Operation completed', {
  correlationId,
  traceId,
  spanId,
  duration
});
```

### 5. **Sampling Strategy**

Configure sampling based on environment:

```javascript
// Production: Sample 1% of traces
// Development: Sample 100% of traces
// Staging: Sample 10% of traces

const samplingRate = {
  'production': 0.01,
  'staging': 0.1,
  'development': 1.0
}[process.env.NODE_ENV];
```

### 6. **Avoid Blocking Operations**

Use async span operations:

```javascript
// ✅ Good - Non-blocking
const response = await axiosInstance.get(url);  // Has interceptor

// ❌ Bad - If it blocks
const metadata = JSON.stringify(largeObject);    // Sync, might block
span.setAttribute('data', metadata);
```

## Troubleshooting

### Issue: Traces Not Appearing in Backend

**Symptoms:**
- No traces in Jaeger UI
- Console logs show successful initialization

**Solutions:**

```bash
# 1. Check OpenTelemetry collector is running
docker logs jaeger

# 2. Verify endpoint configuration
echo $OTEL_EXPORTER_OTLP_ENDPOINT

# 3. Test connectivity
curl -i http://localhost:4317/

# 4. Enable verbose logging
export OTEL_DIAG_LEVEL=debug

# 5. Check for firewall/network issues
netstat -tuln | grep 4317
```

### Issue: High Memory Usage

**Causes:**
- Too many active spans
- Batch processor not flushing
- Memory leaks in span context

**Solutions:**

```javascript
// Configure batch processor limits
const batchProcessor = new BatchSpanProcessor(exporter, {
  maxQueueSize: 1000,      // Default 2048 - reduce if memory-heavy
  maxExportBatchSize: 100, // Default 512 - reduce batch size
  scheduledDelayMillis: 5000  // Default 5000 - flush faster
});

// Limit sampling in high-load scenarios
const samplingRate = load > 0.8 ? 0.01 : 0.1;
```

### Issue: Missing Correlation IDs

**Check:**

```javascript
// Ensure middleware is first in chain
app.use(httpTracingMiddleware());  // MUST be early
app.use(express.json());           // Other middleware
```

**Debug:**

```javascript
// Log correlation ID creation
app.use((req, res, next) => {
  console.log('[Tracing]', {
    correlationId: req.correlationId,
    headers: req.headers['x-correlation-id']
  });
  next();
});
```

### Issue: Trace Context Not Propagating Between Services

**Verify:**

```bash
# Check if headers are being sent
curl -i -H "traceparent: 00-..." http://service2:3000/api

# Verify service2 is receiving headers
console.log('Received headers:', req.headers);

# Confirm context extraction is working
const context = extractTraceContext(req.headers);
console.log('Extracted context:', context);
```

## Performance Considerations

### 1. **Sampling Strategy**

Sampling reduces telemetry volume and improves performance:

```javascript
// Environment-specific sampling
const samplingConfig = {
  development: 1.0,    // 100% - debug everything
  staging: 0.1,        // 10%  - reasonable coverage
  production: 0.01     // 1%   - minimal overhead
};

const sampler = new ProbabilitySampler(samplingConfig[NODE_ENV]);
```

### 2. **Batch Processing**

Configure batch processor for efficiency:

```javascript
// Default: 100 spans per batch, flush every 5 seconds
// For high throughput: increase batch size
{
  maxExportBatchSize: 256,
  scheduledDelayMillis: 1000
}
```

### 3. **Span Processor Selection**

```javascript
// Simple: Synchronous (blocks on export)
new SimpleSpanProcessor(exporter)

// Batch: Asynchronous, buffered (recommended)
new BatchSpanProcessor(exporter)

// Always: Never drop spans
new AlwaysOnSampler()

// Never: All spans dropped (for testing)
new AlwaysOffSampler()
```

### 4. **Memory Footprint**

Typical per-span overhead:
- ~200 bytes per span context
- ~100-200 attributes per span average
- Total: ~1-2 KB per trace (10-20 spans)

### 5. **Network Impact**

OTLP compression:
```javascript
// Enable compression for OTLP export
{
  compression: 'gzip'
}
```

## Monitoring the Tracer

### Health Check for Tracing

```javascript
app.get('/health/tracing', (req, res) => {
  const span = trace.getActiveSpan();
  const isTracing = !!span;

  res.json({
    status: 'ok',
    tracing_enabled: !process.env.OTEL_DISABLED,
    active_span: isTracing,
    service_name: process.env.OTEL_SERVICE_NAME,
    environment: process.env.NODE_ENV
  });
});
```

### Metrics Export

```javascript
// Prometheus metrics for OpenTelemetry
GET /metrics

otel_sdk_spans_total{service="substream-backend"} 10250
otel_sdk_span_duration_ms{service="substream-backend"} 45.3
otel_exporter_otlp_requests_total{service="substream-backend"} 102
```

## Related Documentation

- [OpenTelemetry Specification](https://opentelemetry.io/docs/reference/specification/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [Jaeger Documentation](https://www.jaegertracing.io/docs/)
- [OTLP Protocol](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/protocol/otlp.md)
