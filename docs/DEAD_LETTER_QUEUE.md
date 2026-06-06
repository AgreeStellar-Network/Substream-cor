# Dead-Letter Queue (DLQ) Documentation

## Overview

The Dead-Letter Queue (DLQ) system ensures that corrupted ledger blocks or unparsable XDR payloads do not crash the entire Soroban event indexer. When an event fails processing after multiple retry attempts, it's automatically routed to the DLQ for manual inspection and recovery.

## Architecture

### Components

1. **SorobanDeadLetterQueue** - Core DLQ service with BullMQ integration
2. **SlackAlertService** - Immediate notification system for DLQ events
3. **Database Schema** - Persistent storage with 14-day retention
4. **Admin API** - REST endpoints for DLQ management
5. **Retry Worker** - Background processing of retry attempts

### Data Flow

```
Event Processing Failure
        |
        v
Retry Logic (max 3 attempts)
        |
        v
Add to DLQ (if retries exhausted)
        |
        v
Slack Alert Sent
        |
        v
Manual Review & Retry (via Admin API)
```

## Database Schema

### soroban_dlq_items

Main table storing failed events with full context and error information.

```sql
CREATE TABLE soroban_dlq_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(64) NOT NULL,
    transaction_hash VARCHAR(64) NOT NULL,
    event_index INTEGER NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    raw_event_payload JSONB NOT NULL,
    raw_xdr TEXT,
    event_type VARCHAR(100),
    error_message TEXT NOT NULL,
    error_stack_trace TEXT,
    error_category VARCHAR(50) NOT NULL,
    original_attempt_count INTEGER NOT NULL DEFAULT 3,
    status VARCHAR(20) NOT NULL DEFAULT 'failed',
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
    UNIQUE (transaction_hash, event_index)
);
```

### soroban_dlq_retry_attempts

Detailed tracking of each retry attempt for debugging.

```sql
CREATE TABLE soroban_dlq_retry_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dlq_item_id UUID NOT NULL REFERENCES soroban_dlq_items(id),
    attempt_number INTEGER NOT NULL,
    attempted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    attempted_by VARCHAR(100) NOT NULL,
    success BOOLEAN NOT NULL DEFAULT false,
    error_message TEXT,
    execution_time_ms INTEGER
);
```

## Error Categories

### xdr_parsing
- **Severity**: Critical
- **Description**: Invalid or malformed XDR payload
- **Common Causes**: Contract changes, encoding issues
- **Alert Level**: Immediate Slack notification

### validation
- **Severity**: Error
- **Description**: Event data validation failures
- **Common Causes**: Missing required fields, invalid data types
- **Alert Level**: Error notification

### processing
- **Severity**: Warning
- **Description**: General processing errors
- **Common Causes**: Temporary system issues, edge cases
- **Alert Level**: Warning notification

### network
- **Severity**: Warning
- **Description**: Network connectivity issues
- **Common Causes**: RPC timeouts, connection failures
- **Alert Level**: Warning notification

### database
- **Severity**: Critical
- **Description**: Database operation failures
- **Common Causes**: Connection issues, constraint violations
- **Alert Level**: Critical notification

## Configuration

### Environment Variables

```bash
# DLQ Configuration
DLQ_MAX_RETRIES=3
DLQ_RETRY_DELAY=5000
DLQ_RETENTION_DAYS=14

# Redis Configuration (for BullMQ)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# Slack Alert Configuration
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_CHANNEL=#alerts
SLACK_USERNAME=Soroban DLQ Bot
SLACK_ICON_EMOJI=:warning:
SLACK_ALERTS_ENABLED=true
SLACK_RATE_LIMIT_MS=5000
```

### Advanced Configuration

```javascript
const config = {
  dlq: {
    maxRetries: 3,
    retryDelay: 5000,
    retentionDays: 14,
    redis: {
      host: 'localhost',
      port: 6379,
      password: process.env.REDIS_PASSWORD,
      db: 0
    }
  },
  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL,
    channel: '#alerts',
    username: 'Soroban DLQ Bot',
    iconEmoji: ':warning:',
    alertsEnabled: true,
    rateLimitMs: 5000
  }
};
```

## API Endpoints

### POST /admin/dlq/retry
Manually retry a specific DLQ item.

```bash
curl -X POST http://localhost:3000/admin/dlq/retry \
  -H "Content-Type: application/json" \
  -d '{"dlqId": "dlq_123456789"}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "dlqId": "dlq_123456789",
    "jobId": "retry-job-456",
    "status": "retrying"
  }
}
```

### POST /admin/dlq/batch-retry
Retry multiple DLQ items.

```bash
curl -X POST http://localhost:3000/admin/dlq/batch-retry \
  -H "Content-Type: application/json" \
  -d '{"dlqIds": ["dlq_1", "dlq_2", "dlq_3"]}'
```

### GET /admin/dlq/items
List DLQ items with filtering.

```bash
curl "http://localhost:3000/admin/dlq/items?status=failed&limit=10&offset=0"
```

### GET /admin/dlq/item/:dlqId
Get detailed information about a specific DLQ item.

```bash
curl "http://localhost:3000/admin/dlq/item/dlq_123456789"
```

### POST /admin/dlq/resolve
Mark a DLQ item as manually resolved.

```bash
curl -X POST http://localhost:3000/admin/dlq/resolve \
  -H "Content-Type: application/json" \
  -d '{"dlqId": "dlq_123456789", "resolutionNotes": "Fixed XDR parsing issue"}'
```

### GET /admin/dlq/stats
Get DLQ statistics and health information.

```bash
curl "http://localhost:3000/admin/dlq/stats"
```

### GET /admin/dlq/health
Health check for the DLQ system.

```bash
curl "http://localhost:3000/admin/dlq/health"
```

## Slack Integration

### Alert Format

Slack alerts include detailed information about the failure:

- **Event Details**: Transaction hash, event index, ledger sequence
- **Error Information**: Category, message, stack trace
- **Retry Information**: Original attempt count
- **Action Buttons**: View details, retry event

### Alert Severity

- **Critical**: XDR parsing, database issues (red color)
- **Error**: Validation failures (red color)
- **Warning**: Network, processing issues (orange color)

### Rate Limiting

To prevent alert fatigue, Slack alerts are rate-limited to one every 5 seconds by default.

## Monitoring

### Health Metrics

The DLQ system exposes the following metrics:

- **dlq_items_added_total** - Total items added to DLQ
- **dlq_items_retried_total** - Total items retried
- **dlq_items_resolved_total** - Total items resolved
- **dlq_items_expired_total** - Total items expired
- **dlq_alerts_sent_total** - Total alerts sent
- **dlq_retry_duration_seconds** - Retry processing time

### Database Views

#### soroban_dlq_summary
Overall DLQ statistics:
```sql
SELECT * FROM soroban_dlq_summary;
```

#### soroban_dlq_error_categories
Error category breakdown:
```sql
SELECT * FROM soroban_dlq_error_categories;
```

#### soroban_dlq_recent_failures
Recent failures (last 24 hours):
```sql
SELECT * FROM soroban_dlq_recent_failures;
```

## Automatic Cleanup

### Expiration Process

- Items automatically expire after 14 days
- Expired items are marked as 'expired' status
- Very old items (30+ days) are permanently deleted

### Cleanup Schedule

- Automatic cleanup runs every 6 hours
- Manual cleanup can be triggered via API:
```bash
curl -X POST http://localhost:3000/admin/dlq/cleanup
```

## Troubleshooting

### Common Issues

1. **High DLQ Volume**
   - Check for systematic issues (contract changes, network problems)
   - Review error categories for patterns
   - Consider increasing retry limits for transient errors

2. **Missing Slack Alerts**
   - Verify webhook URL is correct
   - Check rate limiting settings
   - Test webhook connectivity

3. **Retry Failures**
   - Review error messages and stack traces
   - Check if underlying issue has been resolved
   - Consider manual resolution for persistent issues

### Debug Mode

Enable debug logging for detailed troubleshooting:

```bash
LOG_LEVEL=debug npm run soroban
```

### Performance Monitoring

Monitor DLQ performance with these queries:

```sql
-- DLQ items by hour
SELECT 
  DATE_TRUNC('hour', created_at) as hour,
  COUNT(*) as items,
  error_category
FROM soroban_dlq_items 
WHERE created_at >= NOW() - INTERVAL '24 hours'
GROUP BY hour, error_category
ORDER BY hour DESC;

-- Retry success rate
SELECT 
  error_category,
  COUNT(*) as total_items,
  COUNT(CASE WHEN status = 'resolved' THEN 1 END) as resolved,
  ROUND(COUNT(CASE WHEN status = 'resolved' THEN 1 END) * 100.0 / COUNT(*), 2) as success_rate
FROM soroban_dlq_items
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY error_category;
```

## Security

### Access Control

- Admin endpoints should be protected with authentication
- Consider IP whitelisting for DLQ management endpoints
- Audit all manual retry and resolution actions

### Data Privacy

- Raw event payloads may contain sensitive data
- Consider data retention policies for compliance
- Implement access logging for DLQ item viewing

## Testing

### Unit Tests

Run the comprehensive test suite:

```bash
# Run all DLQ tests
npm run test -- --testPathPattern=dlq

# Run with coverage
npm run test -- --testPathPattern=dlq --coverage
```

### Test Scenarios

The test suite covers:
- DLQ item addition and storage
- Retry logic and limits
- Slack alert functionality
- Admin API endpoints
- Error categorization
- Database operations
- Cleanup processes

### Integration Tests

Test malformed payloads:

```javascript
// Test XDR parsing failure
const malformedXdrEvent = {
  id: 'test-malformed',
  body: 'invalid-xdr-data',
  // ... other fields
};

// Should be routed to DLQ after 3 retries
const result = await indexer.processEvent(malformedXdrEvent);
expect(result).toBe(false);

// Verify item in DLQ
const dlqItems = await dlqService.listDlqItems({ 
  errorCategory: 'xdr_parsing' 
});
expect(dlqItems).toHaveLength(1);
```

## Best Practices

### Prevention

1. **Input Validation**: Validate XDR before processing
2. **Circuit Breakers**: Prevent cascading failures
3. **Monitoring**: Early detection of issues
4. **Testing**: Comprehensive test coverage

### Recovery

1. **Manual Review**: Investigate root causes
2. **Hotfixes**: Deploy fixes for systematic issues
3. **Batch Retry**: Reprocess multiple items after fixes
4. **Documentation**: Record resolution patterns

### Maintenance

1. **Regular Cleanup**: Prevent database bloat
2. **Monitor Alerts**: Respond to critical issues promptly
3. **Update Configurations**: Adjust retry limits and thresholds
4. **Review Metrics**: Identify trends and improvements

## Migration Guide

### From Previous System

If migrating from a simple error logging system:

1. **Database Migration**: Run the DLQ schema migration
2. **Configuration**: Add DLQ environment variables
3. **Code Integration**: Replace error handling with DLQ integration
4. **Monitoring**: Update dashboards with DLQ metrics
5. **Documentation**: Train team on DLQ management

### Configuration Migration

```javascript
// Old approach
try {
  await processEvent(event);
} catch (error) {
  console.error('Event processing failed:', error);
  // Continue processing
}

// New DLQ approach
try {
  await processEvent(event);
} catch (error) {
  await dlqService.addFailedEvent(event, error, retryCount);
  // Continue processing, event is in DLQ for recovery
}
```

## API Reference

### SorobanDeadLetterQueue

```javascript
const dlqService = new SorobanDeadLetterQueue(config, {
  logger,
  database,
  alertService,
  indexer
});

// Initialize
await dlqService.initialize();

// Add failed event
const result = await dlqService.addFailedEvent(event, error, attemptCount);

// Retry item
await dlqService.retryDlqItem(dlqId, 'admin');

// List items
const items = await dlqService.listDlqItems(options);

// Get statistics
const stats = await dlqService.getStats();
```

### SlackAlertService

```javascript
const slackService = new SlackAlertService(config, logger);

// Send DLQ alert
await slackService.sendDlqAlert(dlqItem, error);

// Send custom alert
await slackService.sendCustomAlert('Title', 'Message', 'warning', details);

// Test connection
await slackService.testConnection();
```

## License

This DLQ system is part of the Substream-cor and follows the same licensing terms as the main project.
