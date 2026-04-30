# Reconciliation Worker

A specialized worker that runs daily at UTC midnight to compare on-chain SubscriptionBilled events against merchant vault balances, ensuring financial data integrity for B2B trust.

## Overview

The Reconciliation Worker provides essential financial audit capabilities by:

1. **Daily Reconciliation**: Automatically runs at UTC midnight to compare aggregate SubscriptionBilled events with vault balances
2. **Discrepancy Detection**: Identifies "Discrepancy Gaps" where on-chain transactions exist but failed to register in the database
3. **Auto-Healing**: Attempts to resolve discrepancies by re-polling the Soroban RPC for specific transaction hashes
4. **Report Generation**: Creates daily JSON/CSV reports for each merchant, flagging unresolved state mismatches
5. **Financial Validation**: Mathematically validates MRR/Churn metrics against raw ledger state

## Architecture

### Core Components

- **ReconciliationWorker**: Main service orchestrating the reconciliation process
- **Database Schema**: Comprehensive tables for reports, discrepancies, and healing attempts
- **Event Aggregation**: Calculates daily totals from SubscriptionBilled events
- **Vault Integration**: Compares against merchant vault balances
- **Auto-Healing Engine**: Resolves data gaps through RPC re-polling
- **Report Generation**: Creates JSON/CSV reports with detailed analysis

### Database Schema

#### `reconciliation_reports`
- Daily reconciliation summaries per merchant
- Aggregated event totals and vault balances
- Discrepancy metrics and healing status
- Report file paths and processing metadata

#### `reconciliation_discrepancies`
- Detailed discrepancy records with resolution tracking
- Transaction references and amount differences
- Severity classification and suggested actions

#### `reconciliation_healing_attempts`
- Auto-healing attempt logs with strategies used
- RPC response data and success metrics
- Retry tracking and error information

## Installation & Setup

### 1. Database Migration

```bash
# Run the reconciliation schema migration
npm run migrate:up
```

### 2. Environment Configuration

Add these variables to your `.env` file:

```bash
# Reconciliation Worker Configuration
RECONCILIATION_ENABLED=true
RECONCILIATION_SCHEDULE_TIME=00:00
RECONCILIATION_TIMEZONE=UTC
RECONCILIATION_BATCH_SIZE=100
RECONCILIATION_MAX_PROCESSING_TIME_MS=1800000

# Discrepancy Thresholds
RECONCILIATION_DISCREPANCY_THRESHOLD_PERCENTAGE=0.01
RECONCILIATION_CRITICAL_DISCREPANCY_THRESHOLD_PERCENTAGE=1.0

# Auto-Healing Configuration
RECONCILIATION_AUTO_HEALING_ENABLED=true
RECONCILIATION_AUTO_HEALING_MAX_RETRIES=3
RECONCILIATION_AUTO_HEALING_RETRY_DELAY_MS=5000

# Reporting Configuration
RECONCILIATION_GENERATE_JSON_REPORT=true
RECONCILIATION_GENERATE_CSV_REPORT=true
RECONCILIATION_REPORT_RETENTION_DAYS=90
```

### 3. Running the Worker

```bash
# Production mode
npm run reconciliation

# Development mode with auto-restart
npm run reconciliation:dev

# Health check
npm run reconciliation:health
```

## Usage

### Daily Operation

The worker automatically runs at UTC midnight and processes all merchants:

1. **Event Aggregation**: Calculates total SubscriptionBilled events for the day
2. **Vault Balance**: Retrieves current merchant vault balances
3. **Discrepancy Detection**: Compares expected vs actual amounts
4. **Auto-Healing**: Attempts to resolve identified gaps
5. **Report Generation**: Creates JSON/CSV reports with findings

### Manual Execution

For testing or immediate reconciliation:

```bash
# Run reconciliation for all merchants
node worker.js --reconciliation

# Run with specific date (future enhancement)
node worker.js --reconciliation --date=2024-04-28
```

### Report Access

Reports are generated in `reports/reconciliation/` directory:

```
reports/reconciliation/
├── merchant_123_2024-04-28.json
├── merchant_123_2024-04-28.csv
├── merchant_456_2024-04-28.json
└── merchant_456_2024-04-28.csv
```

## Configuration Options

### Scheduling

```javascript
const config = {
  scheduleTime: '00:00',        // UTC time to run
  timezone: 'UTC',              // Timezone for scheduling
  batchSize: 100,               // Merchants per batch
  maxProcessingTimeMs: 1800000  // Max processing time (30 minutes)
};
```

### Thresholds

```javascript
const thresholds = {
  discrepancyThresholdPercentage: 0.01,        // 0.01% tolerance
  criticalDiscrepancyThresholdPercentage: 1.0, // 1% critical threshold
  maxDiscrepancyPercentage: 5.0,               // Max for auto-healing
  maxMissingEvents: 10,                        // Max events for healing
  maxHealingTimeMs: 600000                     // 10 minutes max healing
};
```

### Auto-Healing Strategies

```javascript
const strategies = {
  rePollRpc: true,           // Re-poll RPC for missing events
  reprocessLedger: true,     // Reprocess entire ledger range
  syncMissingEvents: true    // Sync specific missing events
};
```

## Report Format

### JSON Report Structure

```json
{
  "summary": {
    "merchantId": "merchant_123",
    "reportDate": "2024-04-28",
    "status": "matched",
    "expectedRevenue": "1500.00",
    "actualBalance": "1500.00",
    "totalEvents": 15,
    "discrepancies": 0,
    "processingTime": 2340
  },
  "dailyEvents": {
    "merchantId": "merchant_123",
    "date": "2024-04-28T00:00:00.000Z",
    "totalEvents": 15,
    "totalAmount": "1500.00",
    "ledgerRange": {
      "start": 123456,
      "end": 123789
    }
  },
  "vaultBalance": {
    "merchantId": "merchant_123",
    "timestamp": "2024-04-28T23:59:59.000Z",
    "totalValueUsd": "1500.00",
    "balances": [
      {
        "assetCode": "USDC",
        "balance": "1500.00",
        "valueUsd": "1500.00",
        "priceUsd": "1.00"
      }
    ]
  },
  "discrepancies": [],
  "generatedAt": "2024-04-28T23:59:59.000Z"
}
```

### CSV Report Columns

| Merchant ID | Report Date | Status | Total Events | Expected Revenue | Actual Balance | Discrepancy Amount | Discrepancy % | Generated At |
|-------------|-------------|--------|---------------|------------------|-----------------|-------------------|---------------|--------------|

## Monitoring & Alerting

### Health Check

```bash
npm run reconciliation:health
```

Response:
```json
{
  "status": "healthy",
  "isRunning": true,
  "stats": {
    "totalReports": 150,
    "successfulReports": 148,
    "failedReports": 2,
    "discrepanciesFound": 3,
    "healingAttempts": 3,
    "healingSuccesses": 2,
    "lastRunTime": "2024-04-28T00:05:23.000Z"
  }
}
```

### Metrics Tracking

The worker tracks key metrics:

- **Daily Reports**: Total, successful, failed reconciliations
- **Discrepancy Detection**: Number and severity of discrepancies found
- **Auto-Healing**: Success rate and processing time
- **Performance**: Average processing time per merchant

### Database Views

#### `reconciliation_daily_summary`
Daily reconciliation status across all merchants

#### `reconciliation_health_metrics`
30-day rolling metrics for monitoring

## Troubleshooting

### Common Issues

1. **Database Connection Errors**
   ```bash
   # Check database connectivity
   npm run health-check
   ```

2. **RPC Timeouts**
   ```bash
   # Check Soroban RPC health
   npm run soroban:health
   ```

3. **Missing Events**
   ```bash
   # Manual re-sync for specific date
   node worker.js --reconciliation --date=2024-04-28 --force-resync
   ```

### Debug Mode

Enable detailed logging:

```bash
DEBUG=reconciliation:* npm run reconciliation:dev
```

### Log Locations

- Application logs: `logs/reconciliation.log`
- Error logs: `logs/reconciliation-error.log`
- Report files: `reports/reconciliation/`

## API Integration

### Webhook Notifications

Configure webhook endpoints for real-time notifications:

```bash
RECONCILIATION_WEBHOOK_URL=https://your-api.com/reconciliation-webhook
RECONCILIATION_WEBHOOK_SECRET=your-webhook-secret
```

### Email Reports

Enable daily email reports:

```bash
RECONCILIATION_EMAIL_REPORTS=true
RECONCILIATION_EMAIL_RECIPIENTS=admin@company.com,finance@company.com
```

## Security Considerations

### Data Privacy

- All sensitive financial data is encrypted at rest
- Report files are stored with appropriate permissions
- Audit trails maintained for all reconciliation activities

### Access Control

- Reports are accessible only to authorized merchant accounts
- Admin access requires elevated permissions
- All API endpoints are authenticated and authorized

## Performance Optimization

### Batch Processing

- Processes merchants in configurable batches
- Parallel processing for independent merchants
- Memory-efficient streaming for large datasets

### Caching

- Vault balance snapshots cached for reconciliation period
- Event aggregation results cached to avoid re-computation
- Price data cached with appropriate TTL

### Database Optimization

- Optimized indexes for time-series queries
- Partitioned tables for historical data
- Materialized views for reporting metrics

## Future Enhancements

### Planned Features

1. **Real-time Reconciliation**: Continuous monitoring instead of daily batches
2. **Multi-Asset Support**: Extended support for additional asset types
3. **Advanced Analytics**: Machine learning for anomaly detection
4. **Custom Thresholds**: Per-merchant configurable discrepancy thresholds
5. **API Endpoints**: REST API for accessing reconciliation data

### Integration Opportunities

- **Accounting Systems**: Direct integration with QuickBooks, Xero
- **Compliance Tools**: Automated compliance reporting
- **Audit Platforms**: Integration with external audit systems
- **Monitoring Services**: Prometheus/Grafana dashboards

## Support & Maintenance

### Regular Maintenance

- Daily report cleanup (configurable retention)
- Database index optimization
- Log rotation and archival
- Performance monitoring and tuning

### Backup & Recovery

- Automated database backups
- Report file archival to cloud storage
- Disaster recovery procedures
- Data retention policies

## Contributing

When contributing to the Reconciliation Worker:

1. Follow existing code patterns and conventions
2. Add comprehensive tests for new features
3. Update documentation for any API changes
4. Ensure backward compatibility for report formats
5. Test with various merchant configurations

## License

This component is part of the SubStream Protocol Backend project and follows the same licensing terms.
