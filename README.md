# SubStream Protocol Backend

A comprehensive backend API for the SubStream Protocol, supporting wallet-based authentication, tier-based content access, real-time analytics, and multi-region storage replication.

> **Last Updated:** April 28, 2026  
> **Version:** 1.0.0 (Production Ready)

## 📋 Project Overview

This project has undergone extensive development with enterprise-grade features, security enhancements, infrastructure improvements, and compliance frameworks. Below is a complete summary of all implementations.

---

## 🎯 Core Architecture

### System Components
- **API Layer**: Express.js with NestJS integration for real-time features
- **Database**: PostgreSQL with Row-Level Security (RLS) for multi-tenancy
- **Message Queue**: RabbitMQ & BullMQ for async event processing
- **Cache Layer**: Redis for performance optimization and rate limiting
- **Storage**: S3/IPFS for media and data storage
- **Blockchain**: Soroban/Stellar integration for Web3 functionality
- **Real-time**: WebSockets for live analytics and streaming

---

## ✨ Features

### 🎥 Video Transcoding & Streaming
- **Multi-resolution transcoding**: Automatic conversion to 360p, 720p, and 1080p
- **HLS streaming**: Segmented video for smooth adaptive bitrate streaming
- **Adaptive quality**: Automatic quality selection based on connection speed
- **Background processing**: Queue-based transcoding with Redis
- **Storage flexibility**: Support for S3 and IPFS storage
- **Pay-per-second integration**: Seamless integration with subscription system

### 🔐 Authentication (SIWE)
- Wallet-based authentication using Sign In With Ethereum
- JWT token generation and validation
- Nonce-based security
- Multi-tier user support (Bronze, Silver, Gold)

### 📊 Real-time Analytics
- View-time event aggregation
- On-chain withdrawal event tracking
- Heatmap generation for content engagement
- Server-sent events for real-time updates
- Creator analytics dashboard

### 🌍 Multi-Region Storage
- IPFS content replication across multiple services
- Automatic failover between regions
- Health monitoring and service recovery
- Support for Pinata, Web3.Storage, and Infura

### 🛡️ Tier-Based Access Control
- Content filtering based on user subscription tier
- Censored previews for unauthorized content
- Database-level access control
- Upgrade suggestions and tier management

### ⚡ Asynchronous Event Processing
- **RabbitMQ integration**: Reliable message queuing for background tasks
- **Event-driven architecture**: Non-blocking processing of heavy operations
- **Retry logic**: Automatic retry with exponential backoff for failed operations
- **Circuit breaker**: Prevents cascading failures during high load
- **Dead letter queue**: Failed message handling for debugging
- **Background worker**: Separate process for handling emails, notifications.



## Quick Start

### Prerequisites
- Node.js 20.11.0+
- npm or yarn
- FFmpeg (for video transcoding)
- Redis (for job queue)
- RabbitMQ (for asynchronous event processing)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/lifewithbigdamz/SubStream-Protocol-Backend.git
cd SubStream-Protocol-Backend
```

2. Install FFmpeg:
```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y ffmpeg

# macOS
brew install ffmpeg

# Windows
# Download from https://ffmpeg.org/download.html
```

3. Install and start Redis:
```bash
# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis

# macOS
brew install redis
brew services start redis

# Windows
# Download from https://redis.io/download
```

4. Install and start RabbitMQ:
```bash
# Ubuntu/Debian
sudo apt-get install rabbitmq-server
sudo systemctl start rabbitmq-server

# macOS
brew install rabbitmq
brew services start rabbitmq

# Windows
# Download from https://www.rabbitmq.com/download.html
```

5. Install dependencies:
```bash
npm install
```

6. Copy environment variables:
```bash
cp .env.example .env
```

7. Configure your environment variables in `.env`:
- Set your JWT secret
- Add IPFS service API keys
- Configure Redis connection
- Configure RabbitMQ connection
- Set up S3 credentials (optional)
- Configure FFmpeg path
- Set up CDN base URL

8. Start the services:

**Option 1: Start API and Worker Together**
```bash
npm run dev
```

**Option 2: Start Services Separately (Recommended for Production)**
```bash
# Terminal 1: Start the API server
npm run dev

# Terminal 2: Start the background worker
npm run worker:dev
```

The API will be available at `http://localhost:3000`
The background worker will process events from RabbitMQ queues

## API Endpoints

### Authentication
- `GET /auth/nonce?address={address}` - Get nonce for SIWE
- `POST /auth/login` - Authenticate with wallet signature

### Content
- `GET /content` - List content (filtered by user tier)
- `GET /content/{id}` - Get specific content
- `POST /content` - Create new content (requires authentication)
- `PUT /content/{id}` - Update content (creator only)
- `DELETE /content/{id}` - Delete content (creator only)
- `GET /content/{id}/access` - Check access permissions
- `GET /content/upgrade/suggestions` - Get upgrade suggestions

### Analytics
- `POST /analytics/view-event` - Record view-time event
- `POST /analytics/withdrawal-event` - Record withdrawal event
- `GET /analytics/heatmap/{videoId}` - Get content heatmap
- `GET /analytics/creator/{address}` - Get creator analytics
- `GET /analytics/stream/{videoId}` - Real-time analytics stream

### Storage
- `POST /storage/pin` - Pin content to multiple regions
- `GET /storage/content/{id}` - Get content with failover
- `GET /storage/metadata/{id}` - Get content metadata
- `GET /storage/health` - Check storage service health
- `GET /storage/url/{id}` - Get content URLs

### System
- `GET /` - API information
- `GET /health` - Health check

---

## 🚀 Implemented Features & Enhancements

### 1. **Live Substream Analytics Feed** (#155)
Provides real-time MRR and churn analytics pushed via WebSockets with intelligent throttling.

**Key Features:**
- 5-second throttling to prevent server overload
- Metric delta calculations showing previous vs current values
- Granular breakdowns: MRR gained/lost today, churn rate, plan breakdowns
- Redis caching for consistency between REST API and WebSocket data
- **Files**: `src/services/mrrAnalyticsService.js`, `src/websocket/websocket.gateway.ts`
- **Tests**: `tests/mrrAnalyticsService.test.js`

---

### 2. **Row-Level Security (RLS) Multi-Tenancy** (#158)
Enterprise-grade database-level data isolation ensuring merchants cannot access each other's data.

**Key Features:**
- PostgreSQL kernel-level RLS policies prevent cross-tenant data leakage
- Automatic tenant context injection via `SET LOCAL app.current_tenant_id`
- Background worker bypass for global operations
- Sub-100ms query performance with optimized indexes
- SOC2 compliance with structural data separation
- **Files**: `migrations/knex/012_implement_rls_multi_tenancy.js`, `src/services/rlsService.js`, `middleware/tenantRls.js`
- **Tests**: `tests/rlsSecurity.test.js`

---

### 3. **Tenant-Level Feature Flag Toggles** (#161)
Robust tenant configuration module enabling customized merchant experiences without core code branching.

**Key Features:**
- Redis-backed caching with sub-1ms flag evaluation performance
- Token bucket algorithm for efficient rate limiting
- Audit logging for all configuration changes with immutable tracking
- Bulk operations for managing multiple flags simultaneously
- Request-level flag information for UI adaptation
- **Endpoints**: 
  - `GET /api/v1/config/flags` - Retrieve all tenant flags
  - `PUT /api/v1/admin/config/flags/:tenantId/:flagName` - Update flag
  - `PUT /api/v1/admin/config/flags/:tenantId/bulk` - Bulk update
  - `GET /api/v1/admin/config/flags/:tenantId/audit` - Audit log
- **Files**: `src/services/tenantFeatureFlagService.js`, `src/middleware/featureFlagMiddleware.js`, `routes/featureFlagRoutes.js`
- **Tests**: `tests/featureFlagService.test.js`
- **Protected Endpoints**: crypto checkout, B2B invoicing, etc.

---

### 4. **Automated Data Export & Portability** (#164)
Comprehensive GDPR-compliant data export engine preventing vendor lock-in.

**Key Features:**
- Background job processing with BullMQ for large datasets
- Streaming architecture using Postgres cursors for millions of records
- Encrypted ZIP archives with AES-256 S3 server-side encryption
- Multiple export formats: JSON and CSV with standardized schemas
- Rate limiting: once per 7 days with automatic cleanup
- 24-hour expiring S3 URLs for secure downloads
- Email notifications with secure download links
- **Endpoints**:
  - `POST /api/v1/merchants/export-data` - Request export
  - `GET /api/v1/merchants/export-data/:exportId/status` - Track progress
  - `GET /api/v1/merchants/export-data` - Export history
  - `DELETE /api/v1/merchants/export-data/:exportId` - Cancel export
- **Files**: `src/services/dataExportService.js`, `routes/dataExport.js`, `workers/dataExportWorker.js`
- **Tests**: `tests/dataExport.test.js`
- **Concurrent Processing**: Handles 2 simultaneous exports with graceful shutdown

---

### 5. **Docker Containerization for Kubernetes** (#165)
Production-ready multi-stage Docker container optimized for K8s orchestration.

**Key Features:**
- Multi-stage build with Node.js 18 Alpine base
- Non-root user execution (UID 1001) for privilege escalation prevention
- dumb-init for proper signal handling and graceful shutdowns
- readOnlyRootFilesystem with capability dropping
- Alpine Linux base for minimal attack surface
- Health checks with proper HTTP endpoint validation
- **Image Size**: < 250MB
- **K8s Manifests**: Deployment, Pod security contexts, Resource limits, Probes configuration
- **Files**: `Dockerfile`, `k8s/`, `.dockerignore`
- **Features**: ConfigMaps, Secrets management, Environment variable injection
- **Tests**: `tests/docker.test.js` - Validates build, image size, runtime security

---

### 6. **Tenant-Level Storage Quotas & Archival** (#163)
Storage quota enforcement and automated archival to S3 Glacier for data retention.

**Key Features:**
- Tier-based quotas: Free (10K users), Pro (100K users), Enterprise (unlimited)
- Real-time enforcement with 403 responses for quota-exceeding operations
- Automated archival moving stale data to S3 Glacier
- Redis-based usage tracking for minimal latency
- Billing integration for cost allocation
- **Files**: `src/services/storageQuotaService.js`, `src/services/archivalService.js`, `migrations/knex/013_add_storage_quotas_and_archival.js`
- **Tests**: `tests/storageQuotaArchival.test.js`

---

### 7. **Tenant-Specific API Key Scoping** (#159)
Secure API key system with granular permissions for server-to-server integrations.

**Key Features:**
- Cryptographically secure keys with `sk_` prefix and 64-character hex payload
- bcrypt hashing ensures plain-text keys are never stored
- Granular permissions: 12 specific permissions plus admin:all
- Comprehensive audit logging for security trail
- Redis-based per-key rate limiting
- 1-year auto-expiration with manual rotation support
- Multi-tenant isolation boundaries inherited
- **Files**: `src/services/apiKeyService.js`, `middleware/apiKeyAuth.js`, `migrations/knex/014_add_api_keys_and_audit.js`
- **Tests**: `tests/apiKeyService.test.js`

---

### 8. **Vesting Vault Enhancements** 
Advanced Stellar-based vesting vault protocol enhancements.

**Features:**
- **Proxy/Wasm-Rotation Pattern**: Contract upgrades without breaking vesting schedules
- **Schedule Consolidation**: Merges vesting tracks with weighted average calculations
- **Registry Map**: Track all active vault contract IDs by creator for ecosystem discovery
- **Multi-lingual Token Purchase Agreements**: Store agreement hashes in 10 languages
- **Services**: `SorobanVaultManager`, `VestingScheduleManager`, `VaultRegistryService`, `LegalAgreementService`
- **Files**: `src/services/sorobanVaultManager.js`, `src/services/vestingScheduleManager.js`, `src/services/vaultRegistryService.js`, `src/services/legalAgreementService.js`
- **Supported Languages**: EN, ZH, ES, FR, DE, JA, KO, PT, RU, AR

---

### 9. **Device Fingerprinting for Fraud Prevention**
Sophisticated device identification for enhanced fraud detection.

**Key Features:**
- Browser-level device fingerprinting without persistent cookies
- Redis-based suspicious activity tracking
- Behavioral biometric analysis for anomaly detection
- Integration with checkout process
- **Service**: `src/services/deviceFingerprintService.js`
- **Routes**: `routes/device.js`
- **Migration**: `migrations/002_device_fingerprinting.sql`

---

### 10. **Zero-Downtime Migrations**
Implement schema changes without service interruption.

**Key Features:**
- Backward-compatible migration patterns
- Health checking before migration application
- Blue-green deployment support
- Automatic rollback on failure
- **Config**: `knexfile.js`
- **Runner**: `migrations/runMigrations.js`, `migrations/healthChecker.js`
- **Docs**: `docs/ZERO_DOWNTIME_MIGRATIONS.md`

---

### 11. **Structured Logging & Error Tracking**
Enterprise-grade logging with Sentry integration.

**Key Features:**
- Winston-based structured logging with JSON output
- Sentry integration for real-time error tracking
- Discord webhook notifications for critical errors
- Correlation IDs for request tracing
- **Logger**: `src/utils/logger.js`
- **Error Tracking**: `src/utils/errorTracking.js`
- **Integration**: Available across all services

---

### 12. **Swagger/OpenAPI Documentation**
Auto-generated, interactive API documentation.

**Key Features:**
- Automatic API documentation generation
- Interactive Swagger UI at `/api/docs`
- Real-time schema updates
- **Generator**: `src/utils/swaggerGenerator.js`
- **Routes**: `routes/swagger.js`
- **Command**: `npm run docs`

---

### 13. **SEP-10 Authentication**
Stellar-based authentication for Web3 security.

**Key Features:**
- Nonce-based challenge-response protocol
- Wallet signature verification
- Account linkage and multi-sig support
- Domain binding for security
- **Services**: `src/services/sep10Service.js`, `src/services/stellarAuthService.js`
- **Tests**: `tests/sep10Compliance.test.js`, `tests/sep10Integration.test.js`

---

### 14. **Stripe Migration & Billing**
Seamless Stripe payment processing integration.

**Key Features:**
- Product sync with Stripe
- Subscription management
- Invoice tracking and reconciliation
- Billing history
- **Service**: `src/services/stripeMigration.js`
- **Guide**: `STRIPE_MIGRATION_GUIDE.md`
- **Tests**: `tests/stripeMigration.test.js`

---

### 15. **PII Scrubbing & Data Privacy**
Automated sensitive data removal and anonymization.

**Key Features:**
- Configurable PII detection patterns
- Dry-run mode for safety validation
- Scheduled automated scrubbing
- Audit trail for compliance
- **Service**: `workers/piiScrubbingWorker.js`
- **Guide**: `PII_SCRUBBING_README.md`
- **Tests**: `tests/piiScrubbing.test.js`

---

### 16. **WebSocket Real-time Communication**
Live event streaming with NestJS integration.

**Key Features:**
- Real-time analytics updates
- Live notification delivery
- Event throttling and batching
- Connection pooling
- **Files**: `src/websocket/websocket.gateway.ts`
- **Guide**: `README-WEBSOCKET.md`

---

### 17. **IP Intelligence & Fraud Prevention**
Geographic and behavioral IP analysis.

**Key Features:**
- IP geolocation tracking
- VPN/Proxy detection
- Suspicious access pattern detection
- Datacenter identification
- **Service**: `src/services/ipIntelligenceService.js`
- **Guide**: `IP_INTELLIGENCE_README.md`
- **Tests**: `tests/ipIntelligence.test.js`

---

### 18. **Rate Limiting & DDoS Protection**
Multi-layer rate limiting strategy.

**Key Features:**
- Per-IP rate limiting
- Per-user rate limiting
- Per-API-key rate limiting
- Sliding window algorithm
- Redis-backed for distributed systems
- **Service**: `src/services/rateLimiterService.js`
- **Guide**: `REDIS_CACHING_README.md`
- **Tests**: `tests/rateLimiter.test.js`

---

### 19. **Behavioral Biometric Analysis**
Advanced fraud detection through user behavior patterns.

**Key Features:**
- Mouse movement pattern analysis
- Keystroke dynamics monitoring
- Interaction velocity tracking
- Anomaly detection
- **Service**: `src/services/behavioralBiometricService.js`
- **Tests**: `tests/behavioralBiometric.test.js`

---

### 20. **Automated Copyright Fingerprinting**
Content protection and piracy prevention.

**Key Features:**
- Perceptual hashing for video content
- Fingerprint matching database
- Abuse reporting integration
- DMCA compliance
- **Service**: `src/services/automatedCopyrightFingerprinting.js`
- **Tests**: `tests/automatedCopyrightFingerprinting.test.js`

---

### 21. **AML/KYC Scanning**
Anti-Money Laundering and Know Your Customer compliance.

**Key Features:**
- Sanctions list matching
- Risk scoring algorithms
- Document verification
- Transaction monitoring
- **Implementation**: `AML_SCANNER_IMPLEMENTATION.md`

---

### 22. **Pre-Billing Health Checks**
Validation before payment processing.

**Key Features:**
- Account status verification
- Subscription validity checking
- Payment method validation
- Risk assessment
- **Service**: `src/services/preBillingHealthCheckService.js`
- **Guide**: `PRE_BILLING_HEALTH_CHECK_GUIDE.md`
- **Tests**: `tests/preBillingHealthCheck.test.js`

---

### 23. **Subscription Management**
Complete subscription lifecycle management.

**Key Features:**
- Tier management (Bronze, Silver, Gold)
- Auto-renewal configuration
- Cancellation handling
- Trial periods
- Grace periods
- **Tests**: `tests/subscription.test.js`

---

### 24. **Global Statistics & Aggregation**
System-wide metrics and analytics.

**Key Features:**
- Real-time stats calculation
- Historical trend analysis
- Performance metrics
- Usage patterns
- **Tests**: `tests/globalStats.test.js`

---

### 25. **Redis Caching Strategy**
Performance optimization through intelligent caching.

**Key Features:**
- Multi-layer cache invalidation
- Cache warming strategies
- TTL management
- Cache statistics
- **Guide**: `REDIS_CACHING_README.md`

---

### 26. **Kubernetes Deployment & HPA**
Production-grade container orchestration.

**Key Features:**
- Horizontal Pod Autoscaling (HPA)
- Resource limits and requests
- Service discovery
- Rolling updates
- Health checks and probes
- **Manifests**: `k8s/`, `helm/`
- **Guides**: `KUBERNETES_MIGRATION_AUTOMATION.md`, `HPA_IMPLEMENTATION_PR_DESCRIPTION.md`

---

### 27. **Security Architecture**
Defense-in-depth security model.

**Features:**
- mTLS mesh architecture
- Secret lifecycle management
- Webhook signature algorithms
- Incident response runbook
- Security council multi-sig
- Branch protection rules
- SOC2 compliance
- **Documentation**: `SECURITY_ARCHITECTURE.md`, `SECURITY_AUDIT_REPORT.md`

---

### 28. **Disaster Recovery**
Business continuity and backup strategies.

**Features:**
- Database replication
- Point-in-time recovery
- Backup automation
- Multi-region failover
- **Documentation**: `docs/DISASTER_RECOVERY_ARCHITECTURE.md`, `docs/DISASTER_RECOVERY_IMPLEMENTATION_SUMMARY.md`

---

## 📊 Database Schema

Key tables implemented:
- `users` - User accounts and authentication
- `content` - Video content and metadata
- `subscriptions` - User subscription data
- `analytics_events` - View and engagement tracking
- `tenant_configurations` - Feature flags and settings
- `data_export_requests` - Export tracking
- `api_keys` - API key management
- `vault_contracts` - Soroban vault tracking
- `legal_agreements` - Multi-lingual agreement storage
- `device_fingerprints` - Fraud prevention tracking
- `feature_flag_audit_log` - Configuration audit trail
- `data_export_rate_limits` - Export rate limiting
- `websocket_rate_limit_log` - WebSocket security auditing

---

## 🔐 Security Features

### Authentication & Authorization
- ✅ SEP-10 wallet-based authentication
- ✅ JWT token validation
- ✅ API key management with bcrypt hashing
- ✅ Multi-signature support for admin actions
- ✅ Tenant isolation via RLS

### Data Protection
- ✅ Row-Level Security (RLS) at database level
- ✅ Encrypted PII scrubbing
- ✅ GDPR-compliant data export
- ✅ Automatic archival to S3 Glacier
- ✅ AES-256 encryption for sensitive data

### Infrastructure Security
- ✅ mTLS mesh for service-to-service communication
- ✅ DDoS protection with rate limiting
- ✅ IP intelligence filtering
- ✅ Behavioral biometric analysis
- ✅ Device fingerprinting for fraud prevention

### Compliance & Auditing
- ✅ Complete audit logging with immutable trails
- ✅ SOC2 compliance framework
- ✅ AML/KYC scanning
- ✅ DMCA-compliant copyright protection
- ✅ Multi-region compliance support

---

## 🚀 Deployment

### Local Development
```bash
# Install dependencies
npm install

# Start Redis
redis-server

# Start RabbitMQ (if needed)
rabbitmq-server

# Run migrations
npm run migrate

# Start development server
npm run dev
```

### Docker Deployment
```bash
# Build Docker image
docker build -t substream-backend:latest .

# Run with Docker
docker run -p 3000:3000 substream-backend:latest
```

### Kubernetes Deployment
```bash
# Deploy to K8s
kubectl apply -f k8s/

# Check deployment status
kubectl get pods

# View logs
kubectl logs -f deployment/substream-backend
```

### Production Checklist
- [ ] Configure all environment variables
- [ ] Set up PostgreSQL database
- [ ] Configure Redis cluster
- [ ] Set up RabbitMQ cluster
- [ ] Create S3 buckets
- [ ] Configure CDN
- [ ] Set up monitoring and alerting
- [ ] Enable database backups
- [ ] Configure disaster recovery
- [ ] Run security audit
- [ ] Enable AML/KYC scanning
- [ ] Configure Sentry error tracking
- [ ] Set up log aggregation
- [ ] Enable rate limiting

---

## 📚 Documentation

Comprehensive guides available in the project:
- `DEPLOYMENT_GUIDE.md` - Production deployment steps
- `SECURITY_ARCHITECTURE.md` - Security model and threat analysis
- `KUBERNETES_MIGRATION_AUTOMATION.md` - K8s orchestration
- `STRIPE_MIGRATION_GUIDE.md` - Payment integration
- `REDIS_CACHING_README.md` - Caching strategies
- `README-WEBSOCKET.md` - Real-time communication
- `PII_SCRUBBING_README.md` - Data privacy
- `IP_INTELLIGENCE_README.md` - Fraud prevention
- `SEP10_AUTHENTICATION_GUIDE.md` - Stellar authentication
- `docs/ZERO_DOWNTIME_MIGRATIONS.md` - Schema updates
- Plus 30+ additional implementation guides

---

## 📊 Testing

Comprehensive test suite covering:
- Unit tests for all services
- Integration tests for API endpoints
- Security tests for RLS and authentication
- Performance tests for caching and rate limiting
- Docker build validation
- K8s manifest validation

**Run tests:**
```bash
npm test                              # All tests
npm test -- --coverage                # With coverage
jest --testPathPattern=soroban        # Soroban tests
npm run test:pii                      # PII scrubbing tests
```

---

## 🤝 Contributing

1. Create a feature branch from `main`
2. Implement your changes with tests
3. Run full test suite: `npm test`
4. Create pull request with detailed description
5. Address review feedback
6. Merge after approval

---

## 📝 License

[Your License Here]

---

## 📞 Support

For issues, questions, or feature requests:
- Create an issue on GitHub
- Check existing documentation
- Review implementation guides
- Contact: [support email]

---

## 🎯 Roadmap

Future enhancements:
- [ ] GraphQL API support
- [ ] Enhanced machine learning fraud detection
- [ ] Multi-chain blockchain support
- [ ] Advanced analytics dashboards
- [ ] Webhook event streaming
- [ ] Enhanced reporting tools
- [ ] Mobile app backend optimization

---

**Last Updated:** April 28, 2026
**Status:** Production Ready ✅

## Usage Examples

### Authentication
```javascript
// 1. Get nonce
const nonceResponse = await fetch('/auth/nonce?address=0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45');
const { nonce } = await nonceResponse.json();

// 2. Sign message with wallet
const message = `Sign in to SubStream Protocol at ${new Date().toISOString()}\n\nNonce: ${nonce}\nAddress: 0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45`;
const signature = await signer.signMessage(message);

// 3. Login
const loginResponse = await fetch('/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address, signature, message, nonce })
});
const { token } = await loginResponse.json();
```

### Content Access
```javascript
// Get content list (automatically filtered by tier)
const response = await fetch('/content', {
  headers: { 'Authorization': `Bearer ${token}` }
});
const { content } = await response.json();

// Content will be full or censored based on user tier
```

### Analytics
```javascript
// Record view event
await fetch('/analytics/view-event', {
  method: 'POST',
  headers: { 
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    videoId: 'video_001',
    watchTime: 120,
    totalDuration: 300
  })
});

// Get heatmap
const heatmapResponse = await fetch('/analytics/heatmap/video_001', {
  headers: { 'Authorization': `Bearer ${token}` }
});
```

## Architecture

### Services
- **AuthService**: Handles SIWE authentication and JWT management
- **ContentService**: Manages content with tier-based filtering
- **AnalyticsService**: Processes real-time analytics and generates heatmaps
- **StorageService**: Manages multi-region IPFS replication

### Middleware
- **Authentication**: JWT token validation
- **Tier Access**: Role-based access control
- **Error Handling**: Centralized error management

### Data Flow
1. User authenticates via wallet signature
2. JWT token issued with tier information
3. All subsequent requests include token
4. Content filtered based on user tier
5. Analytics events tracked in real-time
6. Content replicated across multiple regions

## Environment Variables

See `.env.example` for all available configuration options.

## Development

### Running Tests
```bash
npm test
```

### Project Structure
```
├── routes/          # API route handlers
├── middleware/      # Express middleware
├── services/        # Business logic services
├── docs/           # API documentation
├── tests/          # Test files
└── index.js        # Main application entry
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

For issues and questions, please open an issue on GitHub.
