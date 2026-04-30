# Distributed Tracing Implementation Checklist

Use this checklist to systematically add distributed tracing to each service in the SubStream Protocol Backend.

## ✅ Core Infrastructure (Completed)

- [x] OpenTelemetry SDK initialization (`src/utils/opentelemetry.js`)
- [x] Tracing utilities module (`src/utils/tracingUtils.js`)
- [x] HTTP tracing middleware (`src/middleware/httpTracingMiddleware.js`)
- [x] Trace context propagation (`src/utils/traceContextPropagation.js`)
- [x] Service instrumentation factory (`src/utils/serviceInstrumentation.js`)
- [x] Example implementations (`src/utils/exampleServiceInstrumentation.js`)
- [x] Comprehensive documentation
- [x] Testing suite
- [x] Environment configuration

## 📋 Integration Checklist by Service

### Authentication Service (`src/services/auth.service.js`)

**Required Tracing:**
- [ ] JWT token generation
- [ ] Token verification
- [ ] Login flow
- [ ] Logout flow
- [ ] Nonce generation (for SIWE)
- [ ] Signature verification
- [ ] User lookup/creation
- [ ] Session management

**Integration Steps:**
1. Import service instrumentation:
   ```javascript
   const { traceServiceMethods } = require('../utils/serviceInstrumentation');
   ```

2. Wrap service methods:
   ```javascript
   module.exports = traceServiceMethods(service, 'auth-service', [
     'generateMemberToken',
     'verifyToken',
     'loginWithSignature',
     'generateNonce'
   ]);
   ```

**Status: Ready for Integration**

---

### Content Service (`src/services/[content-related].js`)

**Required Tracing:**
- [ ] Content retrieval
- [ ] Content creation
- [ ] Content updates
- [ ] Content deletion
- [ ] Access control filtering
- [ ] Cache lookups
- [ ] View event tracking

**Integration Steps:**
1. Add database tracing:
   ```javascript
   const { createDatabaseTracing } = require('../utils/serviceInstrumentation');
   const dbTracing = createDatabaseTracing();
   ```

2. Wrap database queries:
   ```javascript
   async getContent(id) {
     const tracer = dbTracing.traceQuery('SELECT', 'content', sql);
     try {
       const result = await db.query(sql, [id]);
       tracer.end(result.rowCount);
       return result.rows;
     } catch (error) {
       tracer.error(error);
       throw error;
     }
   }
   ```

**Status: Ready for Integration**

---

### Subscription Service (`src/services/subscriptionService.js`)

**Required Tracing:**
- [ ] Subscription creation
- [ ] Subscription verification
- [ ] Subscription expiry checking
- [ ] Tier-based access control
- [ ] Upgrade/downgrade flows
- [ ] Payment verification

**Integration Steps:**
1. Wrap with service instrumentation
2. Add blockchain tracing for Stellar calls
3. Track payment verification events

**Status: Ready for Integration**

---

### Video Processing Service (`src/services/videoTranscodingService.js`)

**Required Tracing:**
- [ ] Transcoding job creation
- [ ] Queue operations
- [ ] Progress tracking
- [ ] Error handling and retries
- [ ] Output file tracking

**Integration Steps:**
1. Add queue operation tracing:
   ```javascript
   const { createQueueTracing } = require('../utils/serviceInstrumentation');
   const queueTracing = createQueueTracing();
   ```

2. Trace job publishing/consuming
3. Track processing pipeline stages

**Status: Ready for Integration**

---

### IPFS Storage Service (`src/services/[storage-related].js`)

**Required Tracing:**
- [ ] Content pinning
- [ ] Multi-region replication
- [ ] Failover attempts
- [ ] Health checks
- [ ] Cache operations
- [ ] API calls to Pinata/Web3.Storage

**Integration Steps:**
1. Add HTTP client tracing:
   ```javascript
   const { createHttpClientTracing } = require('../utils/serviceInstrumentation');
   const httpTracing = createHttpClientTracing();
   ```

2. Setup axios with trace propagation:
   ```javascript
   setupAxiosTracing(axios, { format: 'w3c' });
   ```

3. Track failover patterns

**Status: Ready for Integration**

---

### Stellar/Blockchain Service (`src/services/sorobanEventIndexer.js`, `sorobanRpcService.js`)

**Required Tracing:**
- [ ] Ledger synchronization
- [ ] Event indexing
- [ ] Transaction submission
- [ ] Account queries
- [ ] Contract interactions
- [ ] Error recovery

**Integration Steps:**
1. Add blockchain operation tracing:
   ```javascript
   const { createBlockchainSpan } = require('../utils/tracingUtils');
   ```

2. Track transaction hashes and ledger numbers
3. Monitor indexer lag

**Status: Ready for Integration**

---

### Analytics Service (`src/services/engagementMetricsService.js`, `globalStatsService.js`)

**Required Tracing:**
- [ ] Event recording (views, engagement)
- [ ] Aggregation queries
- [ ] Heatmap generation
- [ ] Stats calculation
- [ ] Caching of results

**Integration Steps:**
1. Trace database aggregations
2. Track cache hit/miss for analytics
3. Monitor computation time

**Status: Ready for Integration**

---

### Notification Service (`src/services/notificationService.js`)

**Required Tracing:**
- [ ] Email sending
- [ ] Webhook dispatching
- [ ] Queue operations
- [ ] Template rendering
- [ ] Retry logic

**Integration Steps:**
1. Add HTTP tracing for email/webhook APIs
2. Track queue operations
3. Monitor retry attempts

**Status: Ready for Integration**

---

### Database Service (`src/services/database-connection.factory.ts`)

**Required Tracing:**
- [ ] Connection pooling
- [ ] Query execution
- [ ] Transaction management
- [ ] Prepared statements
- [ ] Error handling

**Integration Steps:**
1. Already instrumented via `@opentelemetry/instrumentation-pg`
2. Verify attributes are correct
3. Add custom tracing for critical queries

**Status: Partially Complete (Core Tracing Done)**

---

### Cache/Redis Service (`src/services/redisCacheFailover.js`)

**Required Tracing:**
- [ ] GET operations
- [ ] SET operations
- [ ] DELETE operations
- [ ] TTL management
- [ ] Failover handling

**Integration Steps:**
1. Already instrumented via `@opentelemetry/instrumentation-redis`
2. Add custom cache span creation:
   ```javascript
   const { createCacheSpan } = require('../utils/tracingUtils');
   ```

3. Track hit/miss ratios

**Status: Partially Complete (Core Tracing Done)**

---

### Message Queue Service (`src/services/eventPublisherService.js`)

**Required Tracing:**
- [ ] Message publishing
- [ ] Message consumption
- [ ] Dead letter queue handling
- [ ] Retry logic

**Integration Steps:**
1. Already instrumented via `@opentelemetry/instrumentation-amqp`
2. Add queue operation tracing:
   ```javascript
   const { createQueueTracing } = require('../utils/serviceInstrumentation');
   ```

**Status: Partially Complete (Core Tracing Done)**

---

### Rate Limiting Service (`src/services/rateLimitService.js`)

**Required Tracing:**
- [ ] Rate limit checks
- [ ] Quota calculation
- [ ] Token bucket updates
- [ ] Rejection handling

**Integration Steps:**
1. Add custom span for rate limit checks
2. Track quota usage patterns

**Status: Ready for Integration**

---

### Billing Service (`src/services/billingService.js`)

**Required Tracing:**
- [ ] Invoice generation
- [ ] Payment processing (Stripe)
- [ ] Dunning management
- [ ] Payout calculations

**Integration Steps:**
1. Add HTTP client tracing for Stripe API:
   ```javascript
   setupAxiosTracing(stripeClient, { format: 'w3c' });
   ```

2. Track payment state transitions
3. Monitor webhook receipts

**Status: Ready for Integration**

---

### Tenant/Organization Service (`src/services/organization.service.ts`, `tenantConfigurationService.js`)

**Required Tracing:**
- [ ] Tenant creation
- [ ] Organization queries
- [ ] Configuration updates
- [ ] Multi-tenancy enforcement

**Integration Steps:**
1. Add service instrumentation
2. Track tenant isolation at request level
3. Monitor configuration changes

**Status: Ready for Integration**

---

### Security Services (`src/services/piiScrubbingService.js`, `privacyService.js`, etc.)

**Required Tracing:**
- [ ] Data scrubbing operations
- [ ] Encryption/decryption
- [ ] Privacy control enforcement
- [ ] Audit trail

**Integration Steps:**
1. Add tracing to security operations
2. Include operation type and result count
3. Avoid tracing sensitive data content

**Status: Ready for Integration**

---

## 📊 HTTP Routes Integration

### Authentication Routes (`src/routes/auth.js` or controllers)

- [ ] GET `/auth/nonce` - Trace nonce generation
- [ ] POST `/auth/login` - Trace login flow
- [ ] POST `/auth/logout` - Trace logout
- [ ] POST `/auth/refresh` - Trace token refresh

**Integration:**
```javascript
router.post('/login', async (req, res, next) => {
  return withSpan('route.login', async (span) => {
    // Route implementation
  });
});
```

**Status: Ready for Integration**

---

### Content Routes

- [ ] GET `/content` - Trace list with filters
- [ ] GET `/content/:id` - Trace retrieval
- [ ] POST `/content` - Trace creation
- [ ] PUT `/content/:id` - Trace updates
- [ ] DELETE `/content/:id` - Trace deletion

**Status: Ready for Integration**

---

### Analytics Routes

- [ ] POST `/analytics/view-event` - Trace event recording
- [ ] GET `/analytics/heatmap/:id` - Trace heatmap generation
- [ ] GET `/analytics/creator/:address` - Trace stats retrieval

**Status: Ready for Integration**

---

### Storage Routes

- [ ] POST `/storage/pin` - Trace pinning operations
- [ ] GET `/storage/content/:id` - Trace retrieval with failover
- [ ] GET `/storage/health` - Trace health checks

**Status: Ready for Integration**

---

## 🔧 Configuration

- [x] Environment variables template (`.env.tracing.example`)
- [ ] Production configuration (ask DevOps for endpoint)
- [ ] Staging configuration
- [ ] Development configuration (localhost)
- [x] Kubernetes configuration example
- [x] Docker Compose configuration example

**Status: Mostly Complete**

---

## 📦 Deployment

- [ ] Update Docker images with tracing
- [ ] Deploy Jaeger backend
- [ ] Configure OTLP endpoint in K8s
- [ ] Verify traces flowing to backend
- [ ] Set up Jaeger UI access
- [ ] Configure retention policies
- [ ] Set up alerts/dashboards

**Status: Documentation Complete, Deployment TBD**

---

## 📚 Documentation

- [x] Main implementation guide (2000+ lines)
- [x] Quick start guide
- [x] Deployment guide
- [x] Example implementations (5 complete services)
- [x] Environment configuration
- [x] Troubleshooting guide
- [x] API documentation

**Status: Complete**

---

## 🧪 Testing

- [x] Unit tests for tracing utilities
- [x] Integration tests for middleware
- [x] Performance benchmarks
- [ ] Load testing with tracing enabled
- [ ] E2E tests with trace verification

**Status: Core Tests Complete**

---

## 🚀 Rollout Plan

### Phase 1: Development (Current)
- [x] Implement infrastructure
- [x] Create examples
- [x] Write documentation
- [ ] Developers start integrating services
- [ ] Local testing and validation

### Phase 2: Staging (Next)
- [ ] Deploy to staging environment
- [ ] Verify trace collection
- [ ] Performance testing
- [ ] Team review and feedback

### Phase 3: Production (Final)
- [ ] Set up production Jaeger
- [ ] Enable with low sampling rate (1%)
- [ ] Monitor and adjust
- [ ] Expand based on learnings

---

## ✨ Success Metrics

Track these metrics to validate the implementation:

- [ ] 100% of services instrumented
- [ ] 0% data loss in trace export
- [ ] <5ms average latency overhead
- [ ] <2% memory overhead
- [ ] <1% CPU overhead
- [ ] 99.9% availability of tracing infrastructure
- [ ] Average trace latency <500ms
- [ ] Ability to correlate requests across services

---

## 🔍 Validation Checklist

Before marking a service as complete:

- [ ] All major methods are traced
- [ ] Errors are being captured
- [ ] Database queries show row counts
- [ ] External API calls show status codes
- [ ] Trace context is propagating
- [ ] Correlation IDs are consistent
- [ ] No sensitive data in spans
- [ ] Tests pass
- [ ] Documentation is updated

---

## 📞 Support Resources

- **Documentation:** See `DISTRIBUTED_TRACING_GUIDE.md`
- **Quick Start:** See `TRACING_QUICK_START.md`
- **Examples:** See `src/utils/exampleServiceInstrumentation.js`
- **Tests:** Run `npm test -- test/distributedTracing.test.js`

---

## Notes

- This checklist should be completed service-by-service
- Each developer can work on their own service
- Parallel integration is encouraged
- Report issues in the main tracing module early

---

**Last Updated:** April 29, 2026  
**Implementation Status:** 🟢 **Production Ready Infrastructure, Ready for Service Integration**
