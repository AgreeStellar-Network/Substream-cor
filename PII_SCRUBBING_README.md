# PII Scrubbing System - Right to be Forgotten

## Overview

The PII (Personally Identifiable Information) Scrubbing System implements GDPR/CCPA compliant data deletion for the AgreeStellar. It automatically scrubs user personal data while preserving financial records for tax compliance.

## Features

- **Cryptographic Hashing**: One-way SHA-256 HMAC with secure salt prevents reversal
- **Financial Data Preservation**: Billing events retained with anonymized user identity
- **Automated Retention Policy**: Inactive users scrubbed after 3 years
- **Redis Cache Scrubbing**: Removes PII from all cache layers
- **Merchant Webhooks**: Notifies creators of user data deletion
- **Comprehensive Audit Trail**: Immutable logging for compliance
- **Deep Integration Tests**: Verifies users cannot be identified post-scrub

## Architecture

### Components

1. **PIIScrubbingService** (`src/services/piiScrubbingService.js`)
   - Core scrubbing logic
   - Cryptographic hashing
   - Database operations
   - Redis cache clearing
   - Webhook notifications

2. **Compliance API** (`routes/compliance.js`)
   - POST `/api/v1/compliance/forget` - User-initiated deletion
   - GET `/api/v1/compliance/forget/:walletAddress/status` - Verification
   - POST `/api/v1/compliance/forget/batch` - Admin batch scrubbing
   - GET `/api/v1/compliance/audit` - Audit log retrieval
   - POST `/api/v1/compliance/export` - Data portability

3. **Background Worker** (`workers/piiScrubbingWorker.js`)
   - Automated scrubbing of inactive users
   - Configurable retention period
   - Dry-run support

4. **Integration Tests** (`piiScrubbing.test.js`)
   - Cryptographic hashing verification
   - Database scrubbing validation
   - Identification prevention tests
   - Audit logging verification

## Quick Start

### 1. Configuration

Add to your `.env` file:

```bash
# PII Scrubbing Configuration
PII_SCRUBBING_SALT=your-secure-random-salt-min-32-bytes
INACTIVE_RETENTION_YEARS=3
PII_SCRUBBING_ENABLED=true
PII_SCRUBBING_CRON_SCHEDULE=0 2 * * 0
```

**Important**: Generate a secure salt:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Integrate API Routes

Add to your main application (`index.js`):

```javascript
const complianceRoutes = require('./routes/compliance');
app.use('/api/v1/compliance', complianceRoutes);
```

### 3. Run Manual Scrubbing

```bash
# Scrub inactive users (3+ years)
npm run pii-scrub

# Dry run to count inactive users
npm run pii-scrub:dry-run

# Custom retention period
node workers/piiScrubbingWorker.js 5
```

### 4. Run Tests

```bash
npm run test:pii
```

## API Endpoints

### POST /api/v1/compliance/forget

Initiates the Right to be Forgotten process for a user.

**Request Body:**
```json
{
  "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
  "reason": "user_request",
  "requestedBy": "user"
}
```

**Response:**
```json
{
  "success": true,
  "scrubId": "uuid-v4",
  "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
  "duration": 1234,
  "dbResult": {
    "success": true,
    "tablesScrubbed": [...]
  },
  "redisResult": {
    "success": true,
    "keysScrubbed": 5
  },
  "webhookResult": {
    "success": true,
    "webhooksSent": 2
  }
}
```

### GET /api/v1/compliance/forget/:walletAddress/status

Check the scrubbing status of a user.

**Response:**
```json
{
  "success": true,
  "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
  "anonymizedAddress": "GD5DQ6ZQZ_abc123...",
  "tables": {
    "subscriptions": {
      "found": true,
      "emailScrubbed": true,
      "addressAnonymized": true
    }
  },
  "isScrubbed": true
}
```

### POST /api/v1/compliance/forget/batch

Admin-only endpoint to batch scrub inactive users.

**Request Body:**
```json
{
  "years": 3,
  "dryRun": false
}
```

**Response:**
```json
{
  "success": true,
  "batchId": "uuid-v4",
  "totalUsers": 100,
  "successful": 95,
  "failed": 5,
  "errors": [...]
}
```

### POST /api/v1/compliance/export

Export a user's data for GDPR data portability.

**Request Body:**
```json
{
  "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ"
}
```

**Response:**
```json
{
  "success": true,
  "exportId": "uuid-v4",
  "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
  "exportedAt": "2026-04-26T14:00:00Z",
  "subscriptions": [...],
  "comments": [...],
  "auditLogs": [...]
}
```

## Database Tables Scrubbed

The following PII fields are scrubbed across these tables:

| Table | Fields Scrubbed | Financial Data Preserved |
|-------|----------------|-------------------------|
| subscriptions | user_email, wallet_address | balance, daily_spend, creator_id |
| creator_audit_logs | ip_address | All other fields |
| api_key_audit_logs | ip_address | All other fields |
| data_export_tracking | requester_email | All other fields |
| privacy_preferences | share_email_with_merchants | All other fields |
| comments | user_address | content, timestamps |
| leaderboard_entries | fan_address | scores, timestamps |
| social_tokens | user_address | tokens, timestamps |

## Cryptographic Security

### Hashing Algorithm

- **Algorithm**: SHA-256 HMAC
- **Salt**: 32-byte secure salt from environment variable
- **Format**: Hexadecimal string (64 characters)

### Wallet Address Anonymization

**Original**: `GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ`

**Anonymized**: `GD5DQ6ZQZ_abc123def456...`

- First 8 characters preserved for debugging
- Remaining characters replaced with hash
- Irreversible without salt

### Email Anonymization

**Original**: `user@example.com`

**Anonymized**: `scrubbed_[hash]@anon.example.com`

- Full email replaced with hash
- Domain standardized to anon.example.com
- Irreversible without salt

## Redis Cache Scrubbing

The following Redis key patterns are scrubbed:

- `user:{walletAddress}:*`
- `profile:{walletAddress}:*`
- `subscription:{walletAddress}:*`
- `creator:{walletAddress}:*`
- `session:{walletAddress}:*`
- `cache:{walletAddress}:*`

## Merchant Webhooks

When a user invokes their right to be forgotten, affected merchants receive a webhook:

**Webhook Payload:**
```json
{
  "event": "user.forget",
  "timestamp": "2026-04-26T14:00:00Z",
  "scrub_id": "uuid-v4",
  "data": {
    "anonymized_wallet_address": "GD5DQ6ZQZ_abc123...",
    "reason": "user_request",
    "scrubbed_at": "2026-04-26T14:00:00Z"
  }
}
```

**Security**: Webhooks are signed with the merchant's webhook secret.

## Automated Retention Policy

### Configuration

- **Default Retention**: 3 years of inactivity
- **Cron Schedule**: Weekly on Sunday at 2 AM
- **Dry Run**: Supported for testing

### Cron Job Setup

Add to your crontab:

```bash
# Weekly PII scrubbing of inactive users
0 2 * * 0 cd /path/to/app && npm run pii-scrub
```

Or use a process manager like PM2:

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'pii-scrubbing-worker',
    script: './workers/piiScrubbingWorker.js',
    args: '3',
    cron_restart: '0 2 * * 0',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
```

## Audit Logging

All scrubbing operations are logged to `creator_audit_logs`:

**Audit Entry Structure:**
```json
{
  "id": "uuid-v4",
  "action_type": "pii_scrub",
  "entity_type": "user",
  "entity_id": "GD5DQ6ZQZ_abc123...",
  "timestamp": "2026-04-26T14:00:00Z",
  "ip_address": "system",
  "metadata_json": {
    "scrubId": "uuid-v4",
    "original_wallet_hash": "sha256-hash",
    "reason": "user_request",
    "requestedBy": "user",
    "dbResult": {...},
    "redisResult": {...},
    "webhookResult": {...}
  }
}
```

**Retention**: 5 years for compliance

## Testing

### Run Integration Tests

```bash
npm run test:pii
```

### Test Coverage

The test suite verifies:

- **Cryptographic Security**: Hash consistency and uniqueness
- **Database Scrubbing**: All PII fields across all tables
- **Identification Prevention**: Users cannot be identified post-scrub
- **Financial Data Preservation**: Tax records remain intact
- **Audit Logging**: Complete audit trail creation
- **Idempotency**: Safe to run multiple times
- **Inactive User Detection**: Correct identification of stale accounts
- **Batch Processing**: Multiple users scrubbed correctly

### Verification Endpoint

After scrubbing, verify the operation:

```bash
curl -X GET \
  http://localhost:3000/api/v1/compliance/forget/GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ/status
```

## Compliance

### GDPR (General Data Protection Regulation)

- **Article 17**: Right to erasure ("right to be forgotten") ✅
- **Article 20**: Right to data portability ✅
- **Recital 39**: Data minimization ✅

### CCPA (California Consumer Privacy Act)

- **Right to delete** ✅
- **Right to know** ✅
- **Right to opt-out** ✅

### Other Regulations

- **LGPD** (Brazil) - Right to deletion ✅
- **POPIA** (South Africa) - Right to deletion ✅

## Security Considerations

### Salt Management

- **Storage**: Environment variable (never in code)
- **Generation**: Cryptographically random (32 bytes)
- **Rotation**: Rotate annually or on compromise
- **Backup**: Secure backup with access controls

### Access Control

- **API Endpoints**: Admin authentication for batch operations
- **Webhook Secrets**: Per-merchant secrets for verification
- **Audit Logs**: Admin-only access to audit trail

### Data Recovery

- **Irreversible**: One-way hashing prevents reversal
- **Backups**: Scrubbed data propagates to backups
- **Legal Holds**: Separate process for legal preservation

## Troubleshooting

### Scrubbing Fails

**Symptoms**: API returns 500 error

**Solutions**:
1. Check database connectivity
2. Verify salt is configured
3. Check Redis connection
4. Review audit logs for specific errors

### Webhooks Not Sent

**Symptoms**: Merchants not notified

**Solutions**:
1. Verify webhook URLs in creators table
2. Check webhook secrets
3. Review webhook service logs
4. Test webhook endpoint manually

### Redis Keys Not Scrubbed

**Symptoms**: Old data in cache

**Solutions**:
1. Verify Redis connection
2. Check key patterns match
3. Manually flush Redis if needed
4. Verify Redis client configuration

### Audit Logs Missing

**Symptoms**: No audit entries created

**Solutions**:
1. Check audit_log_service configuration
2. Verify database write permissions
3. Check for database errors
4. Review service logs

## Performance

### Scrubbing Duration

- **Single User**: ~1-2 seconds
- **100 Users**: ~30-60 seconds
- **1000 Users**: ~5-10 minutes

### Optimization Tips

- Use batch operations for large datasets
- Schedule during low-traffic periods
- Monitor database performance during scrubbing
- Use read replicas for audit queries

## Monitoring

### Key Metrics

- Scrubbing operations per day
- Average scrubbing duration
- Failed scrubbing attempts
- Webhook delivery rate
- Redis keys scrubbed

### Alerts

Configure alerts for:
- High failure rate (>5%)
- Long scrubbing duration (>10 minutes)
- Webhook delivery failures
- Database errors during scrubbing

## Documentation

- [Privacy Policy - Data Retention](./docs/PRIVACY_POLICY_DATA_RETENTION.md)
- [GDPR Compliance Guide](./docs/GDPR_COMPLIANCE.md)
- [API Documentation](./docs/API_DOCUMENTATION.md)

## Support

For issues or questions:
- **Email**: privacy@substream.protocol
- **GitHub Issues**: [Substream-cor](https://github.com/AgreeStellar-Network/Substream-cor/issues)
- **Documentation**: [Full Documentation](./docs)

## License

MIT

## Changelog

### v1.0.0 (April 26, 2026)
- Initial release
- Cryptographic PII scrubbing
- Automated retention policy
- Redis cache scrubbing
- Merchant webhook notifications
- Comprehensive audit logging
- Deep integration tests
