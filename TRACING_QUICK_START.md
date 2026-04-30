# Quick Start: Distributed Tracing Integration

This guide will help you quickly integrate distributed tracing into your services.

## 5-Minute Setup

### Step 1: Ensure Tracing is Initialized (Already Done)

The tracing is initialized at the top of `index.js`:

```javascript
const { initTracing } = require('./src/utils/opentelemetry');
initTracing({ 
  serviceName: 'substream-protocol-backend', 
  serviceVersion: '1.0.0' 
});
```

### Step 2: Add HTTP Middleware (If Not Already Added)

```javascript
// index.js
const { 
  httpTracingMiddleware,
  traceAwareRequestLogger 
} = require('./src/middleware/httpTracingMiddleware');

app.use(httpTracingMiddleware());      // Must be first!
app.use(traceAwareRequestLogger());
// ... other middleware
```

### Step 3: Trace Your Services

**Option A - Trace All Methods:**

```javascript
// services/contentService.js
const { createTracedService } = require('../utils/serviceInstrumentation');

class ContentService {
  async getContent(id) { /* ... */ }
  async createContent(data) { /* ... */ }
  async updateContent(id, data) { /* ... */ }
}

module.exports = createTracedService(ContentService, 'content-service');
```

**Option B - Trace Specific Methods:**

```javascript
// services/authService.js
const { traceServiceMethods } = require('../utils/serviceInstrumentation');

class AuthService {
  async login(credentials) { /* ... */ }
  async logout(token) { /* ... */ }
}

const service = new AuthService();
module.exports = traceServiceMethods(service, 'auth-service', [
  'login',
  'logout'
]);
```

### Step 4: Enable Trace Context in HTTP Clients

```javascript
// config/httpClient.js
const axios = require('axios');
const { setupAxiosTracing } = require('../utils/traceContextPropagation');

const axiosInstance = axios.create({
  timeout: 10000
});

// Add tracing to all requests
setupAxiosTracing(axiosInstance, { format: 'w3c' });

module.exports = axiosInstance;
```

### Step 5: Start Jaeger Locally

```bash
docker run -d \
  -p 16686:16686 \
  -p 4317:4317 \
  jaegertracing/all-in-one:latest

# Access at http://localhost:16686
```

### Step 6: Set Environment Variables

```bash
# Copy and update .env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
OTEL_SERVICE_NAME=substream-protocol-backend
OTEL_DIAG_LEVEL=debug
OTEL_SAMPLING_RATE=1.0  # 100% for development
```

### Step 7: Start Application

```bash
npm run dev
```

Make a request:
```bash
curl http://localhost:3000/api/content
```

View the trace in Jaeger UI at http://localhost:16686

---

## Common Use Cases

### Trace Database Queries

```javascript
// services/userService.js
const { createDatabaseTracing } = require('../utils/serviceInstrumentation');
const dbTracing = createDatabaseTracing();

async function getUser(userId) {
  const tracer = dbTracing.traceQuery('SELECT', 'users', 
    'SELECT * FROM users WHERE id = $1'
  );

  try {
    const result = await db.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    tracer.end(result.rowCount);
    return result.rows[0];
  } catch (error) {
    tracer.error(error);
    throw error;
  }
}
```

### Trace External API Calls

```javascript
// services/ipfsService.js
const { createHttpClientTracing } = require('../utils/serviceInstrumentation');
const { getContextHeaders } = require('../utils/traceContextPropagation');
const httpTracing = createHttpClientTracing();

async function pinContent(hash) {
  const tracer = httpTracing.traceRequest(
    'POST', 
    'https://api.pinata.cloud/pinning/pinByHash',
    'pinata'
  );

  try {
    const response = await fetch('https://api.pinata.cloud/pinning/pinByHash', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PINATA_JWT}`,
        ...getContextHeaders(correlationId)  // Include trace context
      },
      body: JSON.stringify({ hashToPin: hash })
    });

    tracer.end(response.status, response.headers['content-length']);
    return response.json();
  } catch (error) {
    tracer.error(error, 0);
    throw error;
  }
}
```

### Trace Cache Operations

```javascript
// services/cacheService.js
const { createCacheTracing } = require('../utils/serviceInstrumentation');
const cacheTracing = createCacheTracing();

async function getFromCache(key) {
  const tracer = cacheTracing.traceGet(key);

  try {
    const value = await redis.get(key);
    tracer.end(value !== null);
    return value;
  } catch (error) {
    tracer.error(error);
    throw error;
  }
}
```

### Trace Message Queue Operations

```javascript
// services/eventPublisher.js
const { createQueueTracing } = require('../utils/serviceInstrumentation');
const queueTracing = createQueueTracing();

async function publishEvent(event) {
  const tracer = queueTracing.tracePublish('events', event.type);

  try {
    const messageId = await amqp.publish('events', event);
    tracer.end(messageId);
    return messageId;
  } catch (error) {
    tracer.error(error);
    throw error;
  }
}
```

### Trace Blockchain Operations

```javascript
// services/stellarService.js
const { createBlockchainSpan } = require('../utils/tracingUtils');

async function getSubscription(accountId, productId) {
  const span = createBlockchainSpan(
    'verify_subscription',
    'stellar',
    { 'account.id': accountId, 'product.id': productId }
  );

  try {
    const account = await stellarServer.loadAccount(accountId);
    span.recordLedger(account.ledger);
    
    // Check subscription...
    
    span.end();
  } catch (error) {
    span.recordError(error);
    throw error;
  }
}
```

### Add Custom Events to Spans

```javascript
// In your route handler or service method
const { recordSpanEvent, setSpanAttributes } = require('../utils/opentelemetry');

router.post('/checkout', async (req, res) => {
  try {
    recordSpanEvent('checkout.started', { userId: req.user.id });
    
    const cart = await cartService.getCart(req.user.id);
    recordSpanEvent('cart.loaded', { items: cart.items.length });
    
    const payment = await paymentService.process(cart);
    recordSpanEvent('payment.processed', { amount: payment.amount });
    
    setSpanAttributes({
      'checkout.total_amount': payment.amount,
      'checkout.item_count': cart.items.length
    });

    res.json({ success: true, orderId: payment.orderId });
  } catch (error) {
    recordSpanEvent('checkout.failed', { error: error.message });
    res.status(400).json({ error: error.message });
  }
});
```

---

## Viewing Traces

### In Jaeger UI

1. Open http://localhost:16686
2. Select service: `substream-protocol-backend`
3. Click "Find Traces"
4. Click a trace to view details
5. Each span shows:
   - Operation name
   - Duration
   - Attributes
   - Events
   - Errors (if any)

### In Application Logs

Traces appear in logs with correlation ID:

```
[HTTP] Request completed {
  timestamp: '2026-04-29T10:30:00.000Z',
  method: 'POST',
  path: '/api/content',
  statusCode: 201,
  duration: '145ms',
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  correlationId: 'req-uuid-123'
}
```

---

## Debugging Tips

### Enable Verbose Logging

```bash
export OTEL_DIAG_LEVEL=debug
npm run dev
```

### Check Trace Context Propagation

```bash
# Make a request and check headers
curl -v http://localhost:3000/api/content

# Look for these headers in response:
# x-correlation-id: <uuid>
# x-trace-id: <trace-id>
# traceparent: 00-<trace-id>-<span-id>-01
```

### Verify Service is Connected

```bash
curl http://localhost:3000/health/tracing
```

Should return:
```json
{
  "status": "ok",
  "tracing_enabled": true,
  "service_name": "substream-protocol-backend",
  "environment": "development"
}
```

---

## Sampling Rates by Environment

| Environment | Rate | Command |
|-------------|------|---------|
| Development | 100% | `OTEL_SAMPLING_RATE=1.0 npm run dev` |
| Local Testing | 50% | `OTEL_SAMPLING_RATE=0.5 npm run dev` |
| Staging | 10% | `OTEL_SAMPLING_RATE=0.1 npm run dev` |
| Production | 1% | `OTEL_SAMPLING_RATE=0.01 npm start` |

---

## Performance Considerations

### Memory Usage
- ~1-2KB per trace (10-20 spans)
- No noticeable impact on most services

### CPU Usage
- <1% additional CPU on typical workloads
- Async processing prevents blocking

### Network Impact
- ~200 bytes per exported trace
- Batch export reduces overhead

### Latency
- <5ms per request overhead
- Much faster than full APM solutions

---

## Best Practices

✅ **DO:**
- Initialize tracing first in index.js
- Add middleware as the first Express middleware
- Wrap all I/O operations (DB, API calls, cache)
- Use correlation IDs across all services
- Set meaningful span names
- Add relevant attributes without PII

❌ **DON'T:**
- Store passwords or API keys in spans
- Include full request bodies
- Trace /health or /metrics endpoints
- Add too many attributes (limit to <50 per span)
- Ignore trace context in external calls

---

## Troubleshooting

### Problem: No traces in Jaeger

**Solution:**
```bash
# 1. Check Jaeger is running
docker ps | grep jaeger

# 2. Check endpoint
echo $OTEL_EXPORTER_OTLP_ENDPOINT

# 3. Check logs
npm run dev 2>&1 | grep -i tracing

# 4. Enable debug logging
export OTEL_DIAG_LEVEL=debug
npm run dev
```

### Problem: High latency with tracing

**Solution:**
```bash
# Reduce sampling rate
export OTEL_SAMPLING_RATE=0.01

# Or ignore certain paths
export OTEL_IGNORE_PATHS=/health,/metrics
```

### Problem: Memory usage too high

**Solution:**
```bash
# Reduce batch size
export OTEL_BATCH_SPAN_PROCESSOR_MAX_QUEUE_SIZE=1024

# Reduce sampling rate
export OTEL_SAMPLING_RATE=0.01
```

---

## Getting Help

- Check [DISTRIBUTED_TRACING_GUIDE.md](./DISTRIBUTED_TRACING_GUIDE.md) for detailed docs
- See [TRACING_DEPLOYMENT_GUIDE.md](./TRACING_DEPLOYMENT_GUIDE.md) for deployment
- Review [examples](./src/utils/exampleServiceInstrumentation.js) for patterns
- Run tests: `npm test -- test/distributedTracing.test.js`

---

**Happy Tracing! 🎯**

For questions or issues, refer to the comprehensive documentation or reach out to the backend team.
