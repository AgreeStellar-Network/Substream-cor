# AgreeStellar Security Architecture

**Document Version:** 1.0  
**Last Updated:** 2026-04-26  
**Classification:** Confidential  
**Prepared For:** Zealynx External Audit Firm

---

## Executive Summary

This document consolidates all security mechanisms of the AgreeStellar into a comprehensive operational manual. The protocol employs defense-in-depth architecture combining Row-Level Security (RLS), cryptographic verification, secret lifecycle management, and incident response procedures to protect millions of dollars in recurring Web3 revenue.

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [System Boundaries](#system-boundaries)
3. [Row-Level Security (RLS) Policies](#row-level-security-rls-policies)
4. [mTLS Mesh Architecture](#mtls-mesh-architecture)
5. [Vault Secret Lifecycle](#vault-secret-lifecycle)
6. [Webhook Signature Algorithms](#webhook-signature-algorithms)
7. [Incident Response Runbook](#incident-response-runbook)
8. [Security Council Multi-Sig](#security-council-multi-sig)
9. [Branch Protection Rules](#branch-protection-rules)
10. [Audit Compliance](#audit-compliance)

---

## Threat Model

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                        EXTERNAL WORLD                            │
│  (Users, Merchants, Attackers, Public Internet)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API GATEWAY / EDGE LAYER                       │
│  - Rate Limiting                                                   │
│  - DDoS Protection                                                  │
│  - IP Intelligence Filtering                                      │
│  - API Key Authentication                                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  APPLICATION LAYER (Node.js)                      │
│  - SEP-10 Authentication (Stellar)                                │
│  - API Key Validation                                              │
│  - Request Validation                                              │
│  - Business Logic                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    DATA LAYER (PostgreSQL)                        │
│  - Row-Level Security (RLS)                                       │
│  - Tenant Isolation                                               │
│  - Encrypted Secrets                                              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              BLOCKCHAIN LAYER (Soroban/Stellar)                   │
│  - Smart Contract Execution                                       │
│  - Immutable Ledger                                               │
│  - Cryptographic Verification                                      │
└─────────────────────────────────────────────────────────────────┘
```

### Adversary Classes

#### Class 1: External Attackers
- **Capabilities:** Public internet access, no internal knowledge
- **Motivations:** Financial theft, data exfiltration, service disruption
- **Mitigations:** Rate limiting, IP intelligence, API key authentication, RLS

#### Class 2: Compromised Merchants
- **Capabilities:** Valid API keys, tenant-specific access
- **Motivations:** Data exfiltration from other tenants, privilege escalation
- **Mitigations:** RLS policies, tenant isolation, data leakage interceptor

#### Class 3: Insiders
- **Capabilities:** Database access, infrastructure access
- **Motivations:** Data theft, sabotage, financial fraud
- **Mitigations:** Audit logging, multi-sig approvals, background worker role separation

#### Class 4: Smart Contract Attackers
- **Capabilities:** Blockchain interaction, transaction submission
- **Motivations:** Contract exploit, fund theft, logic manipulation
- **Mitigations:** Immutable terms validation, upgrade restrictions, multi-sig admin

### Attack Vectors

| Vector | Likelihood | Impact | Mitigation |
|--------|------------|--------|------------|
| SQL Injection | Low | Critical | Parameterized queries, RLS |
| Cross-Tenant Data Leakage | Medium | Critical | RLS + Application-layer interceptor |
| API Key Theft | Medium | High | HMAC signatures, IP restrictions |
| Smart Contract Exploit | Low | Critical | Immutable terms, audit trail |
| Database Breach | Low | Critical | Encryption at rest, RLS |
| DDoS Attack | High | Medium | Rate limiting, CDN, auto-scaling |
| Insider Threat | Low | Critical | Audit logs, multi-sig |

---

## System Boundaries

### Soroban Smart Contracts

**Boundary Definition:**
- **Interface:** Stellar RPC endpoints
- **Data Flow:** Immutable transaction submission and verification
- **Trust Level:** Zero-trust - all transactions cryptographically verified
- **Isolation:** Separate from application database, no direct database access

**Security Properties:**
- Immutable ledger prevents transaction tampering
- Cryptographic signatures required for all operations
- Contract upgrade requires multi-sig approval
- Immutable terms (total allocations) cannot be modified

**Contract Addresses:**
- Vault Registry: `SOROBAN_CONTRACT_ID` (environment variable)
- Network: `SOROBAN_NETWORK_PASSPHRASE` (Testnet/Mainnet)
- RPC: `SOROBAN_RPC_URL`

### PostgreSQL Database

**Boundary Definition:**
- **Interface:** Application layer via connection pool
- **Data Flow:** Read/write operations through RLS-filtered queries
- **Trust Level:** Trusted but verified - RLS provides defense-in-depth
- **Isolation:** Physical isolation for enterprise tenants (multi-database routing)

**Security Properties:**
- Row-Level Security enforces tenant isolation at database level
- All tables with `tenant_id` have RLS policies
- Background workers use `bypass_rls` role with audit logging
- Encrypted secrets stored separately in Kubernetes Secrets

**Protected Tables:**
```sql
subscriptions
billing_events
users
creators
creator_settings
videos
api_keys
api_key_audit_logs
```

**RLS Policy Pattern:**
```sql
CREATE POLICY {table}_tenant_policy ON {table}
  FOR ALL
  TO authenticated_user
  USING (tenant_id = current_setting('app.current_tenant_id', true));
```

### External World

**Boundary Definition:**
- **Interface:** Public API endpoints, webhooks, Stellar network
- **Data Flow:** Authenticated requests in, verified responses out
- **Trust Level:** Untrusted - all inputs validated
- **Isolation:** Network segmentation, firewall rules

**Security Properties:**
- All API requests require SEP-10 authentication or valid API key
- Webhook signatures verified using HMAC-SHA256
- Rate limiting per tenant and per IP
- IP intelligence filtering for malicious sources
- TLS 1.3 required for all connections

**External Integrations:**
- Stellar Network (Soroban RPC)
- S3 Storage (encrypted)
- Email Providers (SendGrid/SES)
- Payment Processors (Stripe)
- Webhook Endpoints (merchant-configured)

---

## Row-Level Security (RLS) Policies

### Architecture Overview

RLS provides database-level tenant isolation as the primary defense against cross-tenant data leakage. Application-layer middleware provides secondary verification.

### Implementation Details

**Middleware Integration:** `middleware/tenantRls.js`  
**Service Layer:** `src/services/rlsService.js`  
**Migration:** `migrations/knex/012_implement_rls_multi_tenancy.js`

### RLS-Enabled Tables

| Table | Policy Name | Filter | Indexes |
|-------|-------------|--------|---------|
| subscriptions | subscriptions_tenant_policy | `tenant_id = current_setting('app.current_tenant_id')` | idx_subscriptions_tenant_id, idx_subscriptions_tenant_active |
| billing_events | billing_events_tenant_policy | `tenant_id = current_setting('app.current_tenant_id')` | idx_billing_events_tenant_id, idx_billing_events_tenant_created |
| users | users_tenant_policy | `tenant_id = current_setting('app.current_tenant_id')` | idx_users_tenant_id |
| creators | creators_tenant_policy | `tenant_id = current_setting('app.current_tenant_id')` | idx_creators_tenant_id |
| creator_settings | creator_settings_tenant_policy | `tenant_id = current_setting('app.current_tenant_id')` | idx_creator_settings_tenant_id |
| videos | videos_tenant_policy | `tenant_id = current_setting('app.current_tenant_id')` | idx_videos_tenant_id, idx_videos_tenant_creator |
| api_keys | api_keys_tenant_policy | `tenant_id = current_setting('app.current_tenant_id')` | idx_api_keys_tenant_active, idx_api_keys_tenant_created |
| api_key_audit_logs | api_key_audit_logs_tenant_policy | `tenant_id = current_setting('app.current_tenant_id')` | idx_api_audit_logs_tenant_timestamp, idx_api_audit_logs_key_timestamp |

### Tenant Context Setting

**Function:** `set_tenant_context(tenant_id TEXT)`

```sql
CREATE OR REPLACE FUNCTION set_tenant_context(tenant_id TEXT)
  RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.current_tenant_id', tenant_id, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Application Usage:**
```javascript
await rlsService.setTenantContext(tenantId, client);
```

### Automatic Tenant ID Injection

**Trigger Function:** `set_tenant_id_from_context()`

```sql
CREATE OR REPLACE FUNCTION set_tenant_id_from_context()
  RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME IN ('subscriptions', 'billing_events', 'users', 'creators', 'creator_settings', 'videos') THEN
    NEW.tenant_id = COALESCE(NEW.tenant_id, current_setting('app.current_tenant_id', true));
    IF NEW.tenant_id IS NULL OR NEW.tenant_id = '' THEN
      RAISE EXCEPTION 'tenant_id cannot be null or empty';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Bypass Role for Background Workers

**Role:** `bypass_rls`

```sql
CREATE ROLE bypass_rls NOINHERIT;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO bypass_rls;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO bypass_rls;
```

**Usage:**
```javascript
const client = await rlsService.createBypassRLSClient();
// All queries bypass RLS
// Must be used only by authenticated background workers
```

### Secondary Defense: Data Leakage Interceptor

**Location:** `src/interceptors/tenant-data-leakage.interceptor.ts`

The interceptor recursively inspects all outbound JSON responses to verify that any entity containing a `tenant_id` matches the authenticated tenant.

**Features:**
- Recursive validation of nested objects and arrays
- P1 alerting on detection of foreign tenant data
- Bypass capability via `@IgnoreTenantCheck()` decorator for admin endpoints
- Performance optimized (< 1ms overhead per request)

### RLS Verification

**Test Function:** `verifyRLSForTenant(tenantId)`

```javascript
const verification = await rlsService.verifyRLSForTenant(tenantId);
// Returns: { success: boolean, tests: [], passed: number, failed: number }
```

**Test Cases:**
1. Can only access own subscriptions
2. Cannot access other tenants' data
3. Billing events isolation

---

## mTLS Mesh Architecture

### Implementation Status

**Status:** ✅ Fully Implemented with Istio Service Mesh  
**Configuration Files:** `k8s/istio/`  
**Network Policies:** `k8s/network-policies.yaml`  
**Database SSL:** `k8s/postgres-mtls-config.yaml`  
**Prometheus mTLS:** `k8s/prometheus-mtls-config.yaml`  
**Certificate Rotation:** `docs/CERTIFICATE_ROTATION_POLICIES.md`

### Zero-Trust Architecture

The AgreeStellar implements a Zero-Trust security model using Istio service mesh with strict mTLS enforced across all internal pod-to-pod communication.

**Trust Model:**
- No implicit trust between services
- All service-to-service communication requires mutual authentication
- Network policies block unencrypted traffic
- Database connections require client certificate verification

### Istio Service Mesh Configuration

**Installation:** `k8s/istio/istio-installation.yaml`

**Key Features:**
- Strict mTLS mode enabled by default
- Automatic sidecar injection for all pods
- Istio Citadel (CA) for certificate management
- 24-hour workload certificate validity with automatic rotation
- Trust domain: `substream.local`

**Peer Authentication Policies:** `k8s/istio/peer-authentication.yaml`

```yaml
# Global strict mTLS for all services
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default-mtls
  namespace: substream
spec:
  mtls:
    mode: STRICT
```

**Protected Services:**
- substream-backend
- substream-worker
- soroban-indexer
- postgres
- redis
- prometheus (permissive mode for scraping)

### Authorization Policies

**File:** `k8s/istio/authorization-policies.yaml`

**Access Control Rules:**
- Default deny-all policy
- API Gateway → Backend (HTTP methods)
- Backend → PostgreSQL (port 5432)
- Backend → Redis (port 6379)
- Backend → Soroban Indexer (internal API only)
- Worker → Backend (internal API only)
- Prometheus → All services (metrics scraping)

**Critical Operation Protection:**
```yaml
# Refund operations require additional verification
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: refund-operations-restriction
  namespace: substream
spec:
  selector:
    matchLabels:
      app: substream-backend
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - cluster.local/ns/substream/sa/substream-backend
    to:
    - operation:
        methods: ["POST"]
        paths: ["/api/payments/refund/*"]
    when:
    - key: source.ip
      values: ["10.0.0.0/8"]
    - key: request.headers[x-internal-service-token]
      values: ["INTERNAL_SERVICE_TOKEN"]
```

### Kubernetes Network Policies

**File:** `k8s/network-policies.yaml`

**Default Deny:**
- All ingress traffic denied by default
- All egress traffic denied by default
- Explicit allow rules for required communication

**Allowed Traffic:**
- DNS resolution (kube-system)
- Istio ingress gateway → Backend
- Backend → PostgreSQL (mTLS only)
- Backend → Redis (mTLS only)
- Backend → Soroban Indexer (mTLS only)
- Worker → Backend (mTLS only)
- Prometheus → All services (mTLS only)
- External Stellar RPC (HTTPS)
- External S3 (HTTPS)
- External email providers (HTTPS)

**Blocked Traffic:**
- Direct pod-to-pod without Istio sidecar
- Unencrypted internal traffic
- Unauthorized external access

### Database SSL Configuration

**File:** `k8s/postgres-mtls-config.yaml`

**PostgreSQL SSL Settings:**
```sql
ssl = on
ssl_cert_file = '/var/lib/postgresql/data/server.crt'
ssl_key_file = '/var/lib/postgresql/data/server.key'
ssl_ca_file = '/var/lib/postgresql/data/ca.crt'
ssl_min_protocol_version = 'TLSv1.2'
ssl_max_protocol_version = 'TLSv1.3'
```

**Client Certificate Verification:**
- Backend pods mount client certificates
- `sslmode=verify-full` enforced
- Client certificates required for all connections
- CA certificate validation

**Environment Variables:**
```bash
DATABASE_SSL_MODE=verify-full
DATABASE_SSL_CERT=/etc/postgresql-certs/tls.crt
DATABASE_SSL_KEY=/etc/postgresql-certs/tls.key
DATABASE_SSL_CA=/etc/postgresql-certs/ca.crt
```

### Prometheus mTLS Authentication

**File:** `k8s/prometheus-mtls-config.yaml`

**Scraping Configuration:**
```yaml
scrape_configs:
  - job_name: 'substream-backend'
    scheme: https
    tls_config:
      ca_file: /etc/prometheus/certs/ca.crt
      cert_file: /etc/prometheus/certs/client.crt
      key_file: /etc/prometheus/certs/client.key
      insecure_skip_verify: false
```

**Service Monitors:**
- substream-backend
- substream-worker
- soroban-indexer
- All with mTLS authentication

### Certificate Management

**Istio Citadel (Built-in CA):**
- Automatic workload certificate issuance
- 24-hour certificate validity
- Automatic rotation 2 hours before expiration
- Zero-downtime certificate rotation

**External CA Integration (Recommended for Production):**
- cert-manager for automated certificate management
- HashiCorp Vault for enterprise PKI
- 90-day certificate validity for external services

**Certificate Rotation:** See `docs/CERTIFICATE_ROTATION_POLICIES.md`

**Rotation Schedule:**
- Istio workload certificates: 24 hours (automatic)
- PostgreSQL server certificates: 90 days
- PostgreSQL client certificates: 90 days
- Prometheus client certificates: 90 days
- Root CA: 12 months

### Performance Impact

**Latency Benchmark:** `tests/mtls-latency-benchmark.test.js`

**Acceptable Thresholds:**
- mTLS overhead: < 5ms per request
- Database SSL overhead: < 10ms per connection
- Redis TLS overhead: < 5ms per connection

**Benchmark Results:**
```bash
npm test -- tests/mtls-latency-benchmark.test.js
```

**Expected Performance:**
- Mean overhead: 2-3ms
- 95th percentile: < 5ms
- 99th percentile: < 10ms
- No significant impact on user-facing latency

### Verification Commands

**Check mTLS status:**
```bash
# Check peer authentication policies
kubectl get peerauthentication -n substream

# Check authorization policies
kubectl get authorizationpolicies -n substream

# Check network policies
kubectl get networkpolicies -n substream
```

**Verify certificate expiration:**
```bash
# Check workload certificate
kubectl exec -it <pod-name> -n substream -- \
  openssl x509 -in /etc/certs/cert-chain.pem -noout -dates

# Check Istio agent status
kubectl exec -it <pod-name> -n substream -- \
  /usr/local/bin/pilot-agent request GET /healthz/ready
```

**Test mTLS connection:**
```bash
# Test backend to database
kubectl exec -it substream-backend-xxx -n substream -- \
  openssl s_client -connect postgres:5432 -showcerts

# Test Prometheus scraping
kubectl exec -it prometheus-xxx -n monitoring -- \
  curl -k https://substream-backend:3000/metrics
```

### Deployment Procedure

**1. Install Istio:**
```bash
kubectl create namespace istio-system
kubectl apply -f k8s/istio/istio-installation.yaml
```

**2. Enable automatic sidecar injection:**
```bash
kubectl label namespace substream istio-injection=enabled
kubectl label namespace monitoring istio-injection=enabled
```

**3. Apply mTLS policies:**
```bash
kubectl apply -f k8s/istio/peer-authentication.yaml
kubectl apply -f k8s/istio/authorization-policies.yaml
```

**4. Apply network policies:**
```bash
kubectl apply -f k8s/network-policies.yaml
```

**5. Configure database SSL:**
```bash
# Generate certificates
./scripts/generate-postgres-certs.sh

# Apply configuration
kubectl apply -f k8s/postgres-mtls-config.yaml
```

**6. Configure Prometheus mTLS:**
```bash
kubectl apply -f k8s/prometheus-mtls-config.yaml
```

**7. Verify deployment:**
```bash
# Check all pods have sidecars
kubectl get pods -n substream -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].name}{"\n"}{end}'

# Run latency benchmark
npm test -- tests/mtls-latency-benchmark.test.js
```

### Troubleshooting

**mTLS handshake failures:**
```bash
# Check Istiod logs
kubectl logs -n istio-system -l app=istiod --tail=100

# Check sidecar logs
kubectl logs -n substream <pod-name> -c istio-proxy --tail=100

# Check certificate status
kubectl exec -it <pod-name> -n substream -- \
  istioctl proxy-config secret <pod-name>
```

**Network policy blocking traffic:**
```bash
# Check network policy events
kubectl get events -n substream --field-selector reason=FailedToCreateNetworkPolicy

# Test connectivity
kubectl exec -it <pod-name> -n substream -- \
  nc -zv postgres 5432
```

**Database SSL errors:**
```bash
# Check PostgreSQL logs
kubectl logs -n substream postgres-0 --tail=100

# Verify certificate chain
kubectl exec -it postgres-0 -n substream -- \
  openssl s_client -connect localhost:5432 -showcerts
```

### Related Documentation

- [Certificate Rotation Policies](docs/CERTIFICATE_ROTATION_POLICIES.md)
- [Branch Protection Configuration](docs/BRANCH_PROTECTION_CONFIGURATION.md)
- [Istio Documentation](https://istio.io/latest/docs/concepts/security/)
- [Kubernetes Network Policies](https://kubernetes.io/docs/concepts/services-networking/network-policies/)

---

## Vault Secret Lifecycle

### Kubernetes Secrets Management

**Secrets File:** `k8s/secrets.yaml`

**Secret Categories:**

| Category | Secret Name | Rotation Policy | Storage |
|----------|-------------|-----------------|---------|
| Database | redis-password, db-encryption-key | 90 days | Kubernetes Secret |
| Storage | s3-access-key-id, s3-secret-access-key | 90 days | Kubernetes Secret |
| Authentication | creator-auth-secret, jwt-secret, cdn-token-secret | 180 days | Kubernetes Secret |
| Blockchain | soroban-source-secret | Manual (multi-sig) | Kubernetes Secret |
| Email | ses-api-key, sendgrid-api-key | 90 days | Kubernetes Secret |
| External APIs | ofac-api-key, ipinfo-api-key, maxmind-api-key, abuseipdb-api-key, ipqualityscore-api-key | 90 days | Kubernetes Secret |
| Webhooks | webhook-signing-secret | 180 days | Kubernetes Secret |
| Monitoring | sentry-dsn | 180 days | Kubernetes Secret |

### Secret Rotation Procedure

**Automated Rotation (90-day secrets):**

1. **Generate new secret:**
```bash
NEW_SECRET=$(openssl rand -base64 32)
echo -n "$NEW_SECRET" | base64
```

2. **Update Kubernetes secret:**
```bash
kubectl patch secret substream-secrets -p '{"data":{"redis-password":"'$(echo -n "$NEW_SECRET" | base64)'"}}'
```

3. **Rolling restart pods:**
```bash
kubectl rollout restart deployment substream-backend -n substream
kubectl rollout restart deployment substream-worker -n substream
```

4. **Verify connectivity:**
```bash
kubectl logs -l app=substream-backend -n substream --tail=50
```

**Manual Rotation (Soroban source secret):**

1. **Generate new keypair:**
```bash
stellar-keypair generate
```

2. **Multi-sig approval required** (see Security Council section)
3. **Update secret with multi-sig authorization:**
```bash
kubectl patch secret substream-secrets -p '{"data":{"soroban-source-secret":"'$(echo -n "$NEW_SECRET" | base64)'"}}'
```

4. **Verify contract interaction:**
```bash
npm test -- --testPathPattern=soroban
```

### Secret Access Control

**RBAC Configuration:**
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: secret-reader
  namespace: substream
rules:
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get"]
  resourceNames: ["substream-secrets"]
```

**Audit Logging:**
All secret access is logged to Kubernetes audit log and forwarded to SIEM.

### Secret Backup and Recovery

**Backup Procedure:**
```bash
kubectl get secret substream-secrets -n substream -o yaml > secrets-backup-$(date +%Y%m%d).yaml
gpg --encrypt --recipient security@substream.io secrets-backup-$(date +%Y%m%d).yaml
```

**Recovery Procedure:**
```bash
gpg --decrypt secrets-backup-YYYYMMDD.yaml.gpg > secrets-backup.yaml
kubectl apply -f secrets-backup.yaml
```

### HashiCorp Vault Integration (Future)

**Recommended Migration Path:**

1. **Deploy Vault:**
```bash
helm install vault hashicorp/vault -n vault
```

2. **Configure Kubernetes Auth:**
```bash
vault auth enable kubernetes
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc"
```

3. **Migrate secrets:**
```bash
vault kv put secret/substream/redis password="${REDIS_PASSWORD}"
vault kv put secret/substream/soroban source_secret="${SOROBAN_SOURCE_SECRET}"
```

4. **Update deployment to use Vault Agent:**
```yaml
containers:
- name: vault-agent
  image: hashicorp/vault:latest
  args: ["agent", "-config=/etc/vault/agent-config.hcl"]
```

---

## Webhook Signature Algorithms

### Algorithm Specification

**Algorithm:** HMAC-SHA256  
**Header:** `X-SubStream-Signature`  
**Secret:** Per-merchant `webhook_secret` stored in database

### Implementation

**Location:** `src/services/webhookDispatcher.js`

**Signature Generation:**
```javascript
generateSignature(payload, secret) {
  if (!secret) return 'unsigned';
  const crypto = require('crypto');
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}
```

**Webhook Headers:**
```http
POST /webhook HTTP/1.1
Host: merchant.example.com
Content-Type: application/json
X-SubStream-Event: payment_success
X-SubStream-Signature: sha256=abc123...
```

### Signature Verification (Merchant Side)

**Example Implementation:**
```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

### Security Properties

- **Timing-safe comparison:** Prevents timing attacks
- **Per-merchant secrets:** Compromise of one secret doesn't affect others
- **Payload canonicalization:** JSON stringification ensures consistency
- **HMAC over full payload:** Prevents tampering

### Webhook Secret Rotation

**Procedure:**
1. Generate new secret for merchant
2. Update merchant's `webhook_secret` in database
3. Notify merchant of new secret
4. Grace period: 7 days for merchant to update
5. Deprecate old secret

**SQL Query:**
```sql
UPDATE creators 
SET webhook_secret = $1, 
    webhook_secret_updated_at = NOW() 
WHERE id = $2;
```

### Replay Attack Prevention

**Timestamp Validation:**
```javascript
const maxAge = 5 * 60 * 1000; // 5 minutes
const webhookTimestamp = payload.timestamp;
if (Date.now() - webhookTimestamp > maxAge) {
  throw new Error('Webhook timestamp too old');
}
```

**Nonce Tracking:**
```sql
CREATE TABLE webhook_nonces (
  id SERIAL PRIMARY KEY,
  nonce VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX idx_webhook_nonces_nonce ON webhook_nonces(nonce);
CREATE INDEX idx_webhook_nonces_expires ON webhook_nonces(expires_at);
```

---

## Incident Response Runbook

### Scenario 1: Leaked Merchant API Key

**Severity:** P2  
**Response Time:** < 1 hour  
**Owner:** Security Operations Team

#### Detection

**Indicators:**
- Unusual API usage patterns (rate limit alerts)
- API key usage from unknown IP addresses
- Merchant reports unauthorized access
- Audit log anomalies

**Detection Queries:**
```sql
-- Check for unusual IP addresses
SELECT 
  key_id,
  ip_address,
  COUNT(*) as request_count,
  MIN(timestamp) as first_seen,
  MAX(timestamp) as last_seen
FROM api_key_audit_logs
WHERE timestamp > NOW() - INTERVAL '24 hours'
GROUP BY key_id, ip_address
HAVING COUNT(*) > 1000
ORDER BY request_count DESC;

-- Check for rapid key usage
SELECT 
  ak.name,
  ak.tenant_id,
  COUNT(aal.id) as requests_last_hour
FROM api_keys ak
JOIN api_key_audit_logs aal ON ak.id = aal.key_id
WHERE aal.timestamp > NOW() - INTERVAL '1 hour'
  AND aal.event = 'used'
GROUP BY ak.id, ak.name, ak.tenant_id
HAVING COUNT(aal.id) > 10000;
```

#### Containment

**Immediate Actions:**

1. **Revoke the compromised API key:**
```sql
UPDATE api_keys 
SET is_active = false, 
    updated_at = NOW() 
WHERE id = 'COMPROMISED_KEY_ID';

-- Log the revocation
INSERT INTO api_key_audit_logs (tenant_id, key_id, event, metadata)
SELECT tenant_id, 'COMPROMISED_KEY_ID', 'revoked', '{"reason": "security_incident", "auto_revoked": true}'
FROM api_keys 
WHERE id = 'COMPROMISED_KEY_ID';
```

2. **Block suspicious IP addresses:**
```bash
# Add to firewall rules
iptables -A INPUT -s SUSPICIOUS_IP -j DROP
# Or update cloud provider security groups
```

3. **Notify affected merchant:**
```bash
# Send security alert via email and Slack
# Include: incident ID, timeline, actions taken, next steps
```

#### Eradication

**Investigation Steps:**

1. **Identify data accessed:**
```sql
SELECT 
  event,
  COUNT(*) as count,
  MIN(timestamp) as first_access,
  MAX(timestamp) as last_access
FROM api_key_audit_logs
WHERE key_id = 'COMPROMISED_KEY_ID'
  AND timestamp > NOW() - INTERVAL '7 days'
GROUP BY event;
```

2. **Check for cross-tenant access attempts:**
```sql
-- Monitor RLS violation alerts
-- Check application logs for tenant data leakage interceptor alerts
```

3. **Review audit logs for privilege escalation:**
```sql
SELECT *
FROM api_key_audit_logs
WHERE key_id = 'COMPROMISED_KEY_ID'
  AND event IN ('permissions_updated', 'admin_access')
ORDER BY timestamp DESC;
```

#### Recovery

**Actions:**

1. **Generate new API key for merchant:**
```javascript
const newApiKey = crypto.randomBytes(32).toString('hex');
const hashedKey = await bcrypt.hash(newApiKey, 10);

await database.query(
  'INSERT INTO api_keys (tenant_id, name, hashed_key, permissions, is_active) VALUES ($1, $2, $3, $4, true)',
  [tenantId, 'Replaced Key', hashedKey, existingPermissions]
);
```

2. **Force password reset for affected users:**
```sql
UPDATE users 
SET password_reset_required = true,
    password_reset_token = gen_random_uuid(),
    password_reset_expires = NOW() + INTERVAL '24 hours'
WHERE tenant_id = 'AFFECTED_TENANT_ID';
```

3. **Enable enhanced monitoring:**
```bash
# Add additional rate limiting
# Enable IP whitelist for merchant
# Require MFA for admin actions
```

#### Post-Incident

**Documentation:**
- Create incident report with timeline
- Identify root cause (key storage, phishing, etc.)
- Update security policies if needed
- Schedule follow-up review in 30 days

**CLI Commands Summary:**
```bash
# Revoke key
kubectl exec -it postgres-0 -- psql -U postgres -d substream -c "UPDATE api_keys SET is_active = false WHERE id = 'KEY_ID';"

# Check recent usage
kubectl exec -it postgres-0 -- psql -U postgres -d substream -c "SELECT * FROM api_key_audit_logs WHERE key_id = 'KEY_ID' ORDER BY timestamp DESC LIMIT 100;"

# Generate new key
node scripts/generateApiKey.js --tenant-id TENANT_ID

# Restart services
kubectl rollout restart deployment substream-backend -n substream
```

---

### Scenario 2: Database Breach

**Severity:** P1  
**Response Time:** < 30 minutes  
**Owner:** Security Council + Incident Response Team

#### Detection

**Indicators:**
- Database connection anomalies
- Large data exports detected
- RLS bypass alerts
- Unusual query patterns
- Database performance degradation

**Detection Queries:**
```sql
-- Check for RLS bypass usage
SELECT 
  username,
  application_name,
  COUNT(*) as bypass_count,
  MIN(query_start) as first_bypass,
  MAX(query_start) as last_bypass
FROM pg_stat_statements
WHERE query LIKE '%SET ROLE bypass_rls%'
  AND query_start > NOW() - INTERVAL '24 hours'
GROUP BY username, application_name;

-- Check for large data exports
SELECT 
  schemaname,
  tablename,
  n_live_tup as row_count,
  n_dead_tup as dead_rows
FROM pg_stat_user_tables
WHERE n_live_tup > 1000000
ORDER BY n_live_tup DESC;

-- Monitor connection anomalies
SELECT 
  datname,
  usename,
  COUNT(*) as connection_count,
  MAX(query_start) as last_activity
FROM pg_stat_activity
WHERE state = 'active'
GROUP BY datname, usename
HAVING COUNT(*) > 10;
```

#### Containment

**Immediate Actions:**

1. **Lock down database access:**
```bash
# Stop application pods
kubectl scale deployment substream-backend --replicas=0 -n substream
kubectl scale deployment substream-worker --replicas=0 -n substream

# Block external database access
# Update security groups to allow only VPN access
```

2. **Enable database read-only mode:**
```sql
ALTER DATABASE substream SET default_transaction_read_only = on;
-- Or at transaction level
SET transaction_read_only = on;
```

3. **Change database credentials:**
```bash
# Generate new password
NEW_DB_PASS=$(openssl rand -base64 32)

# Update Kubernetes secret
kubectl patch secret substream-secrets -p '{"data":{"db-password":"'$(echo -n "$NEW_DB_PASS" | base64)'"}}' -n substream

# Update PostgreSQL user
kubectl exec -it postgres-0 -- psql -U postgres -c "ALTER USER substream_user WITH PASSWORD '$NEW_DB_PASS';"
```

4. **Initiate Security Council notification:**
```bash
# Trigger multi-sig emergency protocol
# Contact all Security Council members via verified channels
```

#### Eradication

**Investigation Steps:**

1. **Review PostgreSQL audit logs:**
```bash
# Enable detailed logging if not already
kubectl exec -it postgres-0 -- psql -U postgres -c "ALTER SYSTEM SET log_statement = 'all';"
kubectl exec -it postgres-0 -- psql -U postgres -c "SELECT pg_reload_conf();"

# Check logs
kubectl logs postgres-0 -n substream --tail=1000 | grep -i "error\|warning\|fatal"
```

2. **Identify compromised accounts:**
```sql
SELECT 
  usename,
  application_name,
  client_addr,
  COUNT(*) as connection_count
FROM pg_stat_activity
WHERE state = 'active'
GROUP BY usename, application_name, client_addr;
```

3. **Check for data exfiltration:**
```sql
-- Review query history
SELECT 
  query,
  calls,
  total_time,
  mean_time
FROM pg_stat_statements
WHERE query LIKE '%SELECT%'
  AND query LIKE '%%'
ORDER BY total_time DESC
LIMIT 100;
```

4. **Verify RLS integrity:**
```sql
-- Check if RLS is still enabled
SELECT 
  schemaname,
  tablename,
  rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND rowsecurity = false;

-- Check if policies exist
SELECT 
  schemaname,
  tablename,
  policyname
FROM pg_policies
WHERE schemaname = 'public';
```

#### Recovery

**Actions:**

1. **Restore from backup if data corruption detected:**
```bash
# Identify last known good backup
kubectl exec -it postgres-0 -- psql -U postgres -c "SELECT pg_backup_start_time();"

# Perform point-in-time recovery
kubectl exec -it postgres-0 -- psql -U postgres -c "SELECT pg_backup_stop();"
```

2. **Rotate all secrets:**
```bash
# Rotate database encryption key
# Rotate API keys
# Rotate webhook secrets
# Rotate JWT secret
# See Vault Secret Lifecycle section
```

3. **Re-enable services with enhanced monitoring:**
```bash
# Scale up with 1 replica first
kubectl scale deployment substream-backend --replicas=1 -n substream

# Monitor logs
kubectl logs -f -l app=substream-backend -n substream

# Gradually scale up if no issues
kubectl scale deployment substream-backend --replicas=3 -n substream
```

4. **Force password reset for all users:**
```sql
UPDATE users 
SET password_reset_required = true,
    password_reset_token = gen_random_uuid(),
    password_reset_expires = NOW() + INTERVAL '24 hours'
WHERE password_reset_required = false;
```

#### Post-Incident

**Documentation:**
- Full forensic analysis
- Data breach notification (if required by GDPR/CCPA)
- Security Council report
- External auditor notification
- Public statement (if necessary)

**CLI Commands Summary:**
```bash
# Emergency shutdown
kubectl scale deployment substream-backend --replicas=0 -n substream
kubectl scale deployment substream-worker --replicas=0 -n substream

# Database lockdown
kubectl exec -it postgres-0 -- psql -U postgres -c "ALTER DATABASE substream SET default_transaction_read_only = on;"

# Check active connections
kubectl exec -it postgres-0 -- psql -U postgres -c "SELECT * FROM pg_stat_activity WHERE state = 'active';"

# Kill suspicious connections
kubectl exec -it postgres-0 -- psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'suspicious_user';"

# Rotate credentials
kubectl patch secret substream-secrets -p '{"data":{"db-password":"'$(echo -n "$(openssl rand -base64 32)" | base64)'"}}' -n substream

# Recovery
kubectl scale deployment substream-backend --replicas=1 -n substream
kubectl logs -f -l app=substream-backend -n substream
```

---

### Scenario 3: Soroban Contract Exploit

**Severity:** P0 (Critical)  
**Response Time:** < 15 minutes  
**Owner:** Security Council (Multi-sig required)

#### Detection

**Indicators:**
- Unexpected contract state changes
- Large fund movements
- Failed transaction spikes
- Immutable terms modification attempts
- Anomalous function calls

**Detection Methods:**
```javascript
// Monitor contract events
const events = await sorobanEventIndexer.getRecentEvents();
const anomalies = events.filter(e => 
  e.function_name === 'upgrade_contract' ||
  e.function_name === 'modify_immutable_terms' ||
  e.value > 1000000 // Large value transfers
);

// Check for unexpected state changes
const currentTerms = await vaultManager.getImmutableTerms();
if (currentTerms.totalSupply !== expectedTotalSupply) {
  alertSecurityCouncil('Immutable terms modified!');
}
```

#### Containment

**Immediate Actions:**

1. **Pause all contract interactions:**
```bash
# Stop Soroban indexer worker
kubectl scale deployment soroban-indexer --replicas=0 -n substream

# Disable contract endpoints in application
kubectl patch configmap substream-config -p '{"data":{"soroban-enabled":"false"}}' -n substream
kubectl rollout restart deployment substream-backend -n substream
```

2. **Initiate Security Council emergency protocol:**
```bash
# Contact all multi-sig holders via verified channels
# Require unanimous approval for any contract action
# Document all decisions
```

3. **Freeze affected vaults if necessary:**
```javascript
// This requires multi-sig approval
const freezeTx = await vaultRegistryService.freezeVault(
  compromisedVaultId,
  adminPublicKey,
  adminSignature
);
```

#### Eradication

**Investigation Steps:**

1. **Analyze blockchain transactions:**
```bash
# Get recent contract transactions
stellar-sdk transactions --contract CONTRACT_ID --limit 100

# Analyze transaction details
stellar-sdk analyze-tx --tx-hash TRANSACTION_HASH
```

2. **Review contract upgrade history:**
```javascript
const upgradeHistory = await vaultManager.getUpgradeHistory();
// Verify all upgrades were authorized
// Check for unauthorized code changes
```

3. **Verify immutable terms integrity:**
```javascript
const currentTerms = await vaultManager.getImmutableTerms();
const expectedTerms = loadExpectedTermsFromBackup();

if (!termsMatch(currentTerms, expectedTerms)) {
  // CRITICAL: Immutable terms have been modified
  // This should be impossible under normal operation
  alertSecurityCouncil('CRITICAL: Immutable terms compromised!');
}
```

4. **Check for unauthorized admin actions:**
```sql
-- Review audit logs for admin operations
SELECT *
FROM contract_audit_logs
WHERE event_type IN ('upgrade', 'modify_terms', 'admin_action')
  AND timestamp > NOW() - INTERVAL '24 hours'
ORDER BY timestamp DESC;
```

#### Recovery

**Actions:**

1. **Emergency contract upgrade (if exploit is fixable):**
```javascript
// This requires multi-sig approval from all Security Council members
const upgradeResult = await vaultManager.upgradeContractLogic(
  newFixedCodeHash,
  adminPublicKey,
  adminSignature
);
```

2. **Deploy new contract instance (if exploit is unfixable):**
```javascript
// Deploy new contract with fixed code
const newContractId = await deployNewContract();

// Migrate state if possible
// Redirect all traffic to new contract
// Update environment variables
kubectl patch configmap substream-config -p '{"data":{"soroban-contract-id":"NEW_CONTRACT_ID"}}' -n substream
```

3. **Compensate affected users:**
```javascript
// Calculate losses
const losses = await calculateExploitLosses();

// Process compensation (requires multi-sig)
await processCompensation(losses);
```

4. **Post-mortem and public communication:**
```bash
# Prepare incident report
# Notify affected users
# Public statement with technical details
# Coordinate with Stellar network if necessary
```

#### Post-Incident

**Documentation:**
- Full blockchain analysis
- Smart contract audit report
- Security Council decision log
- Compensation plan
- Preventive measures

**CLI Commands Summary:**
```bash
# Pause contract interactions
kubectl scale deployment soroban-indexer --replicas=0 -n substream
kubectl patch configmap substream-config -p '{"data":{"soroban-enabled":"false"}}' -n substream

# Check contract state
node scripts/checkContractState.js

# Analyze blockchain
stellar-sdk transactions --contract $CONTRACT_ID --limit 50

# Emergency upgrade (requires multi-sig)
node scripts/emergencyContractUpgrade.js --new-code-hash NEW_HASH --admin-key KEY

# Deploy new contract
node scripts/deployNewContract.js

# Update configuration
kubectl patch configmap substream-config -p '{"data":{"soroban-contract-id":"NEW_ID"}}' -n substream
kubectl rollout restart deployment substream-backend -n substream

# Resume operations
kubectl scale deployment soroban-indexer --replicas=3 -n substream
kubectl patch configmap substream-config -p '{"data":{"soroban-enabled":"true"}}' -n substream
```

---

## Security Council Multi-Sig

### Council Members

**Multi-Sig Configuration:**
- **Threshold:** 3 of 5 signatures required
- **Network:** Stellar Mainnet
- **Contract:** Security Council Multi-Sig Wallet

**Contact Information:**

| Member | Role | Public Key | Email (PGP) | Telegram | Phone (Emergency) |
|--------|------|------------|-------------|----------|------------------|
| Alice Chen | Security Lead | GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX | alice@substream.io (0xABCD...) | @alice_substream | +1-555-0101 |
| Bob Smith | Protocol Engineer | GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX | bob@substream.io (0x1234...) | @bob_substream | +1-555-0102 |
| Carol Davis | Legal Counsel | GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX | carol@substream.io (0x5678...) | @carol_substream | +1-555-0103 |
| David Wilson | External Auditor | GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX | david@zealynx.io (0x9ABC...) | @david_zealynx | +1-555-0104 |
| Eve Brown | Treasury Manager | GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX | eve@substream.io (0xDEF0...) | @eve_substream | +1-555-0105 |

**Note:** Public keys are placeholders. Replace with actual keys before deployment.

### Multi-Sig Operations

**Contract Upgrade:**
```javascript
// Requires 3 of 5 signatures
const upgradeTx = await vaultManager.upgradeContractLogic(
  newCodeHash,
  adminPublicKey,
  adminSignature
);
```

**Emergency Freeze:**
```javascript
// Requires unanimous (5 of 5) signatures
const freezeTx = await vaultRegistryService.freezeVault(
  vaultId,
  adminPublicKey,
  adminSignature
);
```

**Secret Rotation:**
```javascript
// Requires 3 of 5 signatures
await rotateSorobanSecret(newSecret, signatures);
```

### Emergency Contact Protocol

**P0 Incident (Contract Exploit):**
1. Immediate call to all members
2. Secure conference line established
3. Decision documented with timestamps
4. Signatures collected via secure channel
5. Transaction submitted and verified

**P1 Incident (Database Breach):**
1. Notification via Slack + Email + SMS
2. 1-hour response window
3. 3 of 5 signatures required for containment actions

**P2 Incident (API Key Leak):**
1. Notification via Slack + Email
2. 4-hour response window
3. Security Lead can act unilaterally, report to Council within 24 hours

### Key Recovery

**If a Council member loses their key:**
1. Member reports loss via verified channel
2. Council votes to replace member (3 of 5)
3. New member onboarded with key generation ceremony
4. Multi-sig wallet updated with new signer
5. Old key removed from wallet

**Key Generation Ceremony:**
- In-person meeting with all Council members
- Air-gapped computer
- New key generated and verified
- Backup copies distributed securely
- Old key securely destroyed

---

## Branch Protection Rules

### GitHub Configuration

**Repository:** AgreeStellar-Network/Substream-cor

**Required Branch Protection Rules:**

#### Main Branch Protection

```yaml
branch: main
protection:
  required_pull_request_reviews:
    required_approving_review_count: 2
    dismiss_stale_reviews: true
    require_code_owner_reviews: true
    require_last_push_approval: true
  required_status_checks:
    strict: true
    contexts:
      - CI/CD Pipeline
      - Security Scan
      - Unit Tests
      - Integration Tests
      - RLS Security Tests
  enforce_admins: true
  restrictions:
    apps: []
    users: []
    teams:
      - core-team
  allow_deletions: false
  allow_force_pushes: false
```

#### Required Status Checks

**CI/CD Pipeline:**
- Build verification
- Linting (ESLint)
- Type checking (TypeScript)

**Security Scan:**
- Dependency vulnerability scan (npm audit)
- SAST (Static Application Security Testing)
- Secret detection (gitleaks)

**Testing:**
- Unit tests (jest)
- Integration tests
- RLS security tests
- Soroban contract tests

### Configuration Commands

**Set branch protection via GitHub CLI:**
```bash
gh api repos/:owner/:repo/branches/main/protection \
  --method PUT \
  -f required_pull_request_reviews[required_approving_review_count]=2 \
  -f required_pull_request_reviews[dismiss_stale_reviews]=true \
  -f required_pull_request_reviews[require_code_owner_reviews]=true \
  -f required_status_checks[strict]=true \
  -f enforce_admins=true \
  -f allow_deletions=false \
  -f allow_force_pushes=false
```

**Add required status checks:**
```bash
gh api repos/:owner/:repo/branches/main/protection/required_status_checks \
  --method PUT \
  -f strict=true \
  -f checks[]="CI/CD Pipeline" \
  -f checks[]="Security Scan" \
  -f checks[]="Unit Tests" \
  -f checks[]="Integration Tests" \
  -f checks[]="RLS Security Tests"
```

**Restrict who can push:**
```bash
gh api repos/:owner/:repo/branches/main/protection/restrictions \
  --method PUT \
  -f apps[]=github-actions \
  -f teams[]=core-team
```

### Verification

**Check current branch protection:**
```bash
gh api repos/:owner/:repo/branches/main/protection
```

**Expected Output:**
```json
{
  "url": "https://api.github.com/repos/AgreeStellar-Network/Substream-cor/branches/main/protection",
  "required_pull_request_reviews": {
    "required_approving_review_count": 2,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "require_last_push_approval": true
  },
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "CI/CD Pipeline",
      "Security Scan",
      "Unit Tests",
      "Integration Tests",
      "RLS Security Tests"
    ]
  },
  "enforce_admins": true,
  "allow_deletions": false,
  "allow_force_pushes": false
}
```

### Pre-Merge Checklist

Before any code is merged to main:

1. **Code Review:** At least 2 approvals from core team
2. **CI/CD:** All status checks passing
3. **Security:** No critical vulnerabilities detected
4. **Tests:** All tests passing (unit, integration, security)
5. **Documentation:** Updated if required
6. **Migration:** Database migrations tested in staging
7. **Rollback:** Rollback plan documented

---

## Audit Compliance

### SOC 2 Type II Compliance

**Trust Services Criteria:**

**Security:**
- Access control (RLS, API keys, multi-sig)
- Encryption at rest and in transit
- Incident response procedures
- Security monitoring and alerting

**Availability:**
- High availability architecture (multi-region)
- Disaster recovery procedures
- Backup and restore testing
- SLA monitoring

**Processing Integrity:**
- Data validation and verification
- Transaction logging and audit trails
- Error handling and monitoring
- Quality assurance processes

**Confidentiality:**
- Data encryption
- Access logging
- Privacy controls (GDPR)
- Data retention policies

**Privacy:**
- GDPR compliance
- Data subject rights (access, deletion, portability)
- Privacy impact assessments
- Consent management

### GDPR Compliance

**Data Subject Rights Implementation:**

**Right to Access:**
```javascript
// Endpoint: GET /api/user/data-export
// Returns all user data in machine-readable format
await gdprService.exportUserData(userAddress);
```

**Right to Deletion:**
```javascript
// Endpoint: DELETE /api/user/data
// Anonymizes all user data
await gdprService.anonymizeUserData(userAddress);
```

**Right to Rectification:**
```javascript
// Endpoint: PATCH /api/user/profile
// Allows users to update their data
await gdprService.updateUserData(userAddress, updates);
```

**Data Retention:**
- Subscription data: 7 years (legal requirement)
- Analytics data: 2 years
- Audit logs: 5 years
- Deleted user data: 30 days (grace period)

### ISO 27001 Compliance

**Information Security Management System:**

**Asset Management:**
- Asset inventory maintained
- Classification labeling
- Ownership defined
- Acceptable use policy

**Access Control:**
- Role-based access control
- Privileged access management
- Access review process
- Authentication mechanisms

**Cryptography:**
- Cryptographic policy
- Key management
- Encryption standards
- Key lifecycle

**Operations Security:**
- Operational procedures
- Malware protection
- Backup management
- Logging and monitoring

**Supplier Relationships:**
- Supplier security assessment
- Supplier agreements
- Supplier monitoring
- Supplier continuity

### Audit Trail

**Immutable Audit Log:**
```sql
CREATE TABLE security_audit_log (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  actor_id VARCHAR(255) NOT NULL,
  tenant_id VARCHAR(255),
  resource_type VARCHAR(100),
  resource_id VARCHAR(255),
  action VARCHAR(50) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  ip_address INET,
  user_agent TEXT,
  timestamp TIMESTAMP DEFAULT NOW() NOT NULL,
  metadata JSONB
);

CREATE INDEX idx_security_audit_timestamp ON security_audit_log(timestamp);
CREATE INDEX idx_security_audit_actor ON security_audit_log(actor_id);
CREATE INDEX idx_security_audit_tenant ON security_audit_log(tenant_id);
CREATE INDEX idx_security_audit_event ON security_audit_log(event_type);
```

**Audit Log Query:**
```sql
-- Get all security events for a tenant
SELECT *
FROM security_audit_log
WHERE tenant_id = $1
  AND timestamp > NOW() - INTERVAL '30 days'
ORDER BY timestamp DESC;

-- Get all admin actions
SELECT *
FROM security_audit_log
WHERE event_type IN ('admin_action', 'privilege_escalation', 'rls_bypass')
ORDER BY timestamp DESC
LIMIT 100;
```

### Penetration Testing

**Schedule:** Quarterly  
**Scope:** Full application stack  
**Provider:** External firm (e.g., Zealynx)

**Testing Areas:**
- Authentication and authorization
- API security
- Database security
- Smart contract security
- Infrastructure security
- Social engineering

**Remediation Timeline:**
- Critical: 24 hours
- High: 7 days
- Medium: 30 days
- Low: 90 days

---

## Appendix

### Security Contact Information

**Security Team:** security@substream.io  
**PGP Key:** 0xABCD1234... (published on keyserver)  
**Bug Bounty:** https://substream.io/security  
**Disclosures:** security@substream.io (PGP encrypted)

### Emergency Contacts

**P0 Incident:** Call all Security Council members  
**P1 Incident:** security@substream.io + Slack #security-emergency  
**P2 Incident:** security@substream.io + Slack #security

### Related Documents

- [Deployment Guide](DEPLOYMENT_GUIDE.md)
- [Security Architecture Implementations](docs/SECURITY_ARCHITECTURE_IMPLEMENTATIONS.md)
- [SEP-10 Authentication Guide](SEP10_AUTHENTICATION_GUIDE.md)
- [Incident Response Policy](internal/incident-response-policy.md)

### Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-04-26 | Security Team | Initial document for Zealynx audit |

---

**Document Classification:** Confidential  
**Distribution:** Security Council, External Auditors, Senior Management  
**Next Review:** 2026-10-26 (6 months)
