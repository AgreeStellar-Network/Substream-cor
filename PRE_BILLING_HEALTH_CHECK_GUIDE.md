# Pre-Billing Health Check System Guide

## Overview

The Pre-Billing Health Check system proactively prevents involuntary churn by warning users 3 days before their subscription payments are due to fail. This system checks wallet balances and authorization allowances, then sends automated warning emails to users who need to take action.

## Architecture

### Core Components

1. **SorobanBalanceChecker** (`services/sorobanBalanceChecker.js`)
   - Queries Soroban RPC for wallet balances
   - Verifies authorization allowances
   - Implements rate limiting and caching
   - Handles batch processing for efficiency

2. **PreBillingHealthCheck** (`services/preBillingHealthCheck.js`)
   - Orchestrates the health check process
   - Manages subscription queries and updates
   - Coordinates email notifications
   - Tracks warning timestamps

3. **PreBillingHealthWorker** (`workers/preBillingHealthWorker.js`)
   - Cron job scheduler using node-cron
   - Manages execution history and metrics
   - Provides monitoring and status endpoints
   - Handles graceful shutdown

4. **PreBillingEmailService** (`services/preBillingEmailService.js`)
   - Generates warning email templates
   - Formats balance and issue information
   - Supports both text and HTML email formats

5. **API Routes** (`routes/preBilling.js`)
   - RESTful endpoints for management
   - Manual trigger capabilities
   - Status and metrics endpoints
   - Wallet testing functionality

## Database Schema

### Subscriptions Table Enhancements

```sql
ALTER TABLE subscriptions ADD COLUMN next_billing_date TEXT;
ALTER TABLE subscriptions ADD COLUMN warning_sent_at TEXT;
ALTER TABLE subscriptions ADD COLUMN required_amount REAL DEFAULT 0;
```

### Indexes for Performance

```sql
CREATE INDEX idx_subscriptions_next_billing ON subscriptions(next_billing_date);
CREATE INDEX idx_subscriptions_warning_sent ON subscriptions(warning_sent_at);
```

## Configuration

### Environment Variables

```bash
# Soroban Configuration
SOROBAN_RPC_URL=https://horizon-testnet.stellar.org
SOROBAN_SOURCE_SECRET=SAK7KNG3LQJ6B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6S4K3B6
SUBSTREAM_CONTRACT_ID=CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Email Configuration
FROM_EMAIL=noreply@substream.app
SUPPORT_EMAIL=support@substream.app
FRONTEND_URL=https://app.substream.app

# Health Check Configuration
PRE_BILLING_CRON_SCHEDULE="0 2 * * *"  # Daily at 2 AM UTC
WARNING_THRESHOLD_DAYS=3
BATCH_SIZE=50
RUN_ON_START=false

# Database Configuration
DATABASE_PATH=./data/app.db
```

## API Endpoints

### Management Endpoints

#### Get Worker Status
```
GET /api/v1/pre-billing/status
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "isRunning": false,
    "lastRun": "2024-01-15T02:00:00.000Z",
    "runHistory": [...],
    "config": {
      "warningThresholdDays": 3,
      "batchSize": 50
    }
  }
}
```

#### Trigger Health Check
```
POST /api/v1/pre-billing/trigger
Authorization: Bearer <JWT_TOKEN>

{
  "targetDate": "2024-01-18T00:00:00.000Z", // Optional
  "options": {}
}
```

#### Get Upcoming Subscriptions
```
GET /api/v1/pre-billing/upcoming?daysAhead=3
Authorization: Bearer <JWT_TOKEN>
```

#### Test Wallet Health
```
POST /api/v1/pre-billing/test-wallet
Authorization: Bearer <JWT_TOKEN>

{
  "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
  "requiredAmount": 10000000
}
```

#### Get Metrics
```
GET /api/v1/pre-billing/metrics
Authorization: Bearer <JWT_TOKEN>
```

#### Health Check Endpoint
```
GET /api/v1/pre-billing/health
```

### Utility Endpoints

#### Send Test Email
```
POST /api/v1/pre-billing/send-test-email
Authorization: Bearer <JWT_TOKEN>

{
  "email": "test@example.com",
  "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
  "creatorId": "test-creator",
  "issues": [...]
}
```

#### Update Next Billing Date
```
PUT /api/v1/pre-billing/next-billing-date
Authorization: Bearer <JWT_TOKEN>

{
  "creatorId": "creator-123",
  "walletAddress": "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
  "nextBillingDate": "2024-01-18T00:00:00.000Z",
  "requiredAmount": 10000000
}
```

## Cron Job Setup

### Option 1: Standalone Process

```bash
# Run as daemon
node scripts/runPreBillingHealthCheck.js

# Run once
node scripts/runPreBillingHealthCheck.js --run-once

# Test specific wallet
node scripts/runPreBillingHealthCheck.js --test-wallet GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ
```

### Option 2: System Cron

```bash
# Edit crontab
crontab -e

# Add daily job at 2 AM UTC
0 2 * * * /usr/bin/node /path/to/substream-backend/scripts/runPreBillingHealthCheck.js --run-once >> /var/log/pre-billing-health-check.log 2>&1
```

### Option 3: Docker Cron

```dockerfile
# Dockerfile
FROM node:18-alpine

# ... other setup ...

# Add cron job
RUN echo "0 2 * * * cd /app && node scripts/runPreBillingHealthCheck.js --run-once" >> /etc/crontabs/root

# Install cron and run
RUN apk add --no-cache dcron
CMD crond -f
```

## Email Templates

### Pre-Billing Warning Template

The system automatically generates emails with the following structure:

**Subject:** Action Required: Your Substream payment will fail in 3 days

**Content:**
- Subscription details (creator, billing date, required amount)
- Specific issues found (insufficient balance, missing authorization)
- Actionable links to resolve issues
- Important notes about subscription cancellation

### Email Variables

```javascript
{
  walletAddress: "GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ",
  creatorId: "creator-123",
  nextBillingDate: "2024-01-18T00:00:00.000Z",
  requiredAmount: 10000000,
  issues: [
    {
      type: "insufficient_balance",
      message: "Your wallet balance (0.200000 XLM) is insufficient to cover the required payment (1.000000 XLM).",
      balance: 2000000,
      required: 10000000
    }
  ],
  warningDays: 3
}
```

## Soroban Integration

### Balance Checking

The system queries the Soroban RPC to get account balances:

```javascript
const account = await server.getAccount(walletAddress);
const balance = extractBalance(account);
```

### Authorization Verification

The system simulates contract calls to verify authorization:

```javascript
const simulation = await simulateContractCall(
  sourceKeypair,
  contractId,
  'check_authorization',
  [walletAddress]
);
```

### Rate Limiting

To respect RPC rate limits:
- 1 request per minute per wallet
- 2-second delays between batches
- 30-second cache timeout
- Batch processing (default 50 wallets)

## Monitoring and Metrics

### Performance Metrics

- **Total Runs**: Number of health check executions
- **Success Rate**: Percentage of successful runs
- **Average Duration**: Average processing time
- **Total Processed**: Total subscriptions processed
- **Total Warnings**: Total warnings sent
- **Total Errors**: Total errors encountered

### Health Check Endpoint

```bash
curl https://api.substream.app/api/v1/pre-billing/health
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2024-01-15T10:00:00.000Z",
    "worker": {
      "isRunning": false,
      "lastRun": "2024-01-15T02:00:00.000Z",
      "uptime": 3600
    },
    "metrics": {
      "totalRuns": 30,
      "successRate": 96.7,
      "avgDuration": 1250
    }
  }
}
```

## Error Handling

### Common Error Scenarios

1. **RPC Connection Failed**
   - Retry with exponential backoff
   - Log error and continue with next batch
   - Mark subscriptions as failed for this run

2. **Email Service Down**
   - Queue emails for retry
   - Continue processing other subscriptions
   - Log error for manual follow-up

3. **Database Connection Lost**
   - Abort current run
   - Log critical error
   - Trigger alert for manual intervention

4. **Invalid Wallet Address**
   - Skip subscription
   - Log warning
   - Continue with next subscription

### Error Recovery

The system implements comprehensive error handling:

```javascript
try {
  const result = await processSubscription(subscription);
  return result;
} catch (error) {
  console.error(`Failed to process subscription:`, error);
  return {
    success: false,
    error: error.message,
    subscription: subscription.id
  };
}
```

## Testing

### Unit Tests

```bash
# Run all tests
npm test preBillingHealthCheck.test.js

# Run specific test suite
npm test -- --testNamePattern="Soroban Balance Checker"
```

### Integration Tests

```bash
# Test with mocked RPC
npm test -- --testNamePattern="Acceptance Criteria"

# Test email templates
npm test -- --testNamePattern="Email Service"
```

### Manual Testing

```bash
# Test specific wallet
node scripts/runPreBillingHealthCheck.js --test-wallet GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ

# Send test email
curl -X POST http://localhost:3000/api/v1/pre-billing/send-test-email \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# Trigger manual run
curl -X POST http://localhost:3000/api/v1/pre-billing/trigger \
  -H "Authorization: Bearer <TOKEN>"
```

## Security Considerations

### RPC Security

- Use HTTPS endpoints for RPC connections
- Validate SSL certificates
- Implement connection timeouts
- Rate limit RPC requests

### Data Protection

- Encrypt sensitive configuration
- Use environment variables for secrets
- Implement access controls for API endpoints
- Log security events

### Email Security

- Validate email addresses
- Sanitize email content
- Implement rate limiting on email sending
- Use SPF/DKIM for email authentication

## Performance Optimization

### Database Optimization

- Use appropriate indexes
- Implement connection pooling
- Batch database operations
- Clean up old records

### RPC Optimization

- Implement caching
- Use batch processing
- Respect rate limits
- Implement retry logic

### Memory Management

- Process in batches
- Clean up expired cache entries
- Monitor memory usage
- Implement garbage collection

## Troubleshooting

### Common Issues

1. **RPC Timeout Errors**
   - Check RPC URL connectivity
   - Verify network configuration
   - Increase timeout values

2. **Email Not Sending**
   - Verify email service configuration
   - Check SMTP settings
   - Validate email addresses

3. **High Memory Usage**
   - Reduce batch size
   - Clear cache more frequently
   - Monitor memory leaks

4. **Slow Processing**
   - Optimize database queries
   - Increase batch size
   - Check RPC performance

### Debug Mode

Enable debug logging:

```bash
DEBUG=pre-billing:* node scripts/runPreBillingHealthCheck.js --run-once
```

### Log Analysis

```bash
# View recent logs
tail -f /var/log/pre-billing-health-check.log

# Filter errors
grep "ERROR" /var/log/pre-billing-health-check.log

# Analyze performance
grep "completed in" /var/log/pre-billing-health-check.log
```

## Future Enhancements

1. **Advanced Analytics**
   - Predictive failure modeling
   - Churn risk scoring
   - Payment success analytics

2. **Multi-Chain Support**
   - Support for other blockchains
   - Cross-chain balance checking
   - Multi-token support

3. **Smart Notifications**
   - SMS notifications
   - Push notifications
   - In-app notifications

4. **Automated Resolution**
   - Auto-topup suggestions
   - Wallet re-authorization
   - Payment retry logic

5. **Enhanced Monitoring**
   - Real-time dashboards
   - Alert integration
   - Performance metrics

## Deployment Guide

### Production Deployment

1. **Environment Setup**
   ```bash
   export NODE_ENV=production
   export SOROBAN_RPC_URL=https://rpc.stellar.org
   export WARNING_THRESHOLD_DAYS=3
   export BATCH_SIZE=100
   ```

2. **Database Migration**
   ```bash
   # Run database migrations
   node scripts/migrateDatabase.js
   ```

3. **Service Deployment**
   ```bash
   # Deploy as systemd service
   sudo cp pre-billing-health-check.service /etc/systemd/system/
   sudo systemctl enable pre-billing-health-check
   sudo systemctl start pre-billing-health-check
   ```

4. **Monitoring Setup**
   ```bash
   # Set up monitoring
   npm install -g pm2
   pm2 start scripts/runPreBillingHealthCheck.js --name pre-billing-health
   pm2 monit
   ```

### Scaling Considerations

- **Horizontal Scaling**: Multiple worker instances
- **Database Scaling**: Read replicas for queries
- **RPC Scaling**: Multiple RPC endpoints
- **Email Scaling**: Queue-based email sending

This comprehensive pre-billing health check system provides proactive user communication, reduces involuntary churn, and saves gas costs by preventing failed transactions. The system is designed for high reliability, scalability, and maintainability.
