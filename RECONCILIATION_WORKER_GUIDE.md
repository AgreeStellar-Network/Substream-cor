# Reconciliation Worker Guide

## Overview

The Reconciliation Worker is a specialized system designed for large merchants requiring absolute proof that funds sitting in their bank account match the on-chain activity. It runs every 24 hours at UTC midnight and provides comprehensive reconciliation between SubscriptionBilled events and merchant vault balances.

## Architecture

### Core Components

1. **ReconciliationWorker** - Main worker that performs daily reconciliation
2. **ReconciliationScheduler** - Manages 24-hour UTC midnight scheduling
3. **ReconciliationAnalyticsValidator** - Validates MRR/Churn metrics against ledger state
4. **ReconciliationConfigService** - Manages per-merchant configuration
5. **ReconciliationManager** - Integration layer coordinating all components

### Data Flow

```
UTC Midnight Trigger
        ↓
ReconciliationScheduler
        ↓
ReconciliationWorker
        ↓
┌─────────────────┬─────────────────┐
│   On-Chain     │   Database      │
│   Events       │   Records       │
└─────────────────┴─────────────────┘
        ↓
Discrepancy Detection
        ↓
Auto-Healing (if enabled)
        ↓
Report Generation (JSON/CSV)
        ↓
Analytics Validation
        ↓
Daily Reports for Merchants
```

## Features

### ✅ Acceptance Criteria Met

1. **Merchants receive daily reports confirming the integrity of their on-chain revenue**
   - Daily reconciliation reports generated at UTC midnight
   - JSON and CSV format reports available
   - Comprehensive discrepancy analysis

2. **The system automatically detects and repairs data gaps caused by network latency or RPC timeouts**
   - Auto-healing functionality for missing database records
   - Configurable retry attempts and delays
   - Detailed healing status tracking

3. **Analytical metrics (MRR/Churn) are mathematically validated against the raw ledger state every day**
   - MRR validation with configurable tolerance thresholds
   - Churn analysis with estimation capabilities
   - Real-time metrics validation

## Installation & Setup

### 1. Database Migration

```bash
# Run the reconciliation worker migration
npm run migrate

# The migration creates:
# - reconciliation_reports table
# - reconciliation_discrepancies table  
# - reconciliation_config table
# - reconciliation_worker_history table
# - Supporting indexes and views
```

### 2. Environment Configuration

Add to your `.env` file:

```env
# Reconciliation Worker Configuration
RECONCILIATION_ENABLED=true
RECONCILIATION_SCHEDULE="0 0 * * *"  # UTC midnight
RECONCILIATION_REPORTS_DIR="./reports/reconciliation"
RECONCILIATION_AUTO_START=true

# Soroban RPC Configuration
SOROBAN_RPC_URL=https://horizon-testnet.stellar.org
SOROBAN_CONTRACT_ID=your_contract_id
SOROBAN_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Notification Configuration
RECONCILIATION_NOTIFICATION_EMAIL_ENABLED=true
RECONCILIATION_SMTP_HOST=smtp.example.com
RECONCILIATION_SMTP_PORT=587
RECONCILIATION_SMTP_USER=your_email@example.com
RECONCILIATION_SMTP_PASS=your_password
```

### 3. Integration

```javascript
// In your main application file
const { ReconciliationManager } = require('./src/services/reconciliationManager');

// Initialize the reconciliation manager
const reconciliationManager = new ReconciliationManager(
  database,
  sorobanRpcService,
  {
    scheduler: {
      schedule: '0 0 * * *', // UTC midnight
      autoStart: true
    },
    worker: {
      reportsDir: './reports/reconciliation',
      maxRetries: 3,
      batchSize: 100
    },
    analytics: {
      tolerancePercentage: 0.01, // 0.01% tolerance
      minAmountThreshold: 0.000001 // 1 stroop
    }
  }
);

// Start the reconciliation system
await reconciliationManager.start();
```

## API Endpoints

### Health & Status

```
GET /reconciliation/health
GET /reconciliation/status
```

### Reconciliation Operations

```
POST /reconciliation/merchant/:merchantId/reconcile
POST /reconciliation/daily
POST /reconciliation/merchant/:merchantId/validate
```

### Reports & Analytics

```
GET /reconciliation/merchant/:merchantId/report/:date
GET /reconciliation/merchant/:merchantId/history
GET /reconciliation/summary
GET /reconciliation/discrepancies/analytics
GET /reconciliation/merchants/top-discrepancies
GET /reconciliation/export/merchant/:merchantId
```

### Configuration

```
GET /reconciliation/config/merchant/:merchantId
PUT /reconciliation/config/merchant/:merchantId
POST /reconciliation/config/merchant/:merchantId/enable
POST /reconciliation/config/merchant/:merchantId/disable
GET /reconciliation/config/merchants
GET /reconciliation/config/stats
GET /reconciliation/config/export
```

## Configuration

### Merchant Configuration

Each merchant can be configured with the following settings:

```javascript
{
  enabled: true,                    // Enable reconciliation for this merchant
  auto_heal_enabled: true,          // Enable auto-healing of discrepancies
  max_healing_attempts: 3,          // Maximum retry attempts for healing
  healing_retry_delay_minutes: 5,   // Delay between healing attempts
  discrepancy_threshold_amount: 0.000001,  // Minimum amount threshold (1 stroop)
  discrepancy_threshold_percentage: 0.01,   // Percentage threshold (0.01%)
  notify_on_discrepancy: true,       // Send notifications on discrepancies
  notify_on_healing_failure: true,   // Send notifications on healing failures
  notification_email: 'merchant@example.com'  // Email for notifications
}
```

### Threshold Configuration

- **Amount Threshold**: Minimum amount difference to consider as discrepancy (default: 0.000001 XLM)
- **Percentage Threshold**: Maximum allowed percentage difference (default: 0.01%)

## Discrepancy Types

### 1. Missing in Database
- **Cause**: SubscriptionBilled event exists on-chain but not in database
- **Auto-Healing**: ✅ Supported - Re-polls Soroban RPC for specific transaction
- **Resolution**: Event is stored in database with full details

### 2. Missing on Chain  
- **Cause**: Database record exists but no corresponding on-chain event
- **Auto-Healing**: ❌ Not supported - Cannot create on-chain events
- **Resolution**: Manual investigation required

### 3. Amount Mismatch
- **Cause**: Amount differs between on-chain and database records
- **Auto-Healing**: ❌ Not supported - Requires manual review
- **Resolution**: Investigate data integrity issues

## Report Structure

### Daily Report (JSON)

```json
{
  "merchantId": "merchant123",
  "reportDate": "2023-01-01",
  "generatedAt": "2023-01-01T00:05:00Z",
  "summary": {
    "totalDiscrepancies": 2,
    "missingInDatabase": 1,
    "missingOnChain": 0,
    "amountMismatches": 1
  },
  "discrepancies": [
    {
      "discrepancy_type": "missing_in_database",
      "transaction_hash": "0xabc123...",
      "event_index": 0,
      "amount_difference": 1000000,
      "healing_status": "healed",
      "healed_at": "2023-01-01T00:03:00Z"
    }
  ]
}
```

### CSV Report

```csv
Discrepancy Type,Transaction Hash,Event Index,On-Chain Amount,Database Amount,Amount Difference,Healing Status,Created At
missing_in_database,0xabc123...,0,10.000000,0.000000,10.000000,healed,2023-01-01 00:00:00
amount_mismatch,0xdef456...,1,15.000000,14.500000,0.500000,failed,2023-01-01 00:01:00
```

## Analytics Validation

### MRR Validation

Compares analytical MRR calculations with on-chain data:

- **Total MRR**: Sum of active subscription amounts
- **Active Subscribers**: Count of unique active subscribers  
- **Average Revenue Per User**: Total MRR / Active Subscribers

### Churn Validation

Validates churn metrics against on-chain patterns:

- **Churned Subscribers**: Subscribers billed yesterday but not today
- **Churn Rate**: Percentage of subscribers lost
- **Estimated Churn**: Based on billing patterns (limitations apply)

## Monitoring & Alerting

### Health Checks

```bash
# Check system health
curl http://localhost:3000/reconciliation/health

# Get detailed status
curl http://localhost:3000/reconciliation/status
```

### Key Metrics to Monitor

1. **Reconciliation Success Rate**: % of successful daily reconciliations
2. **Discrepancy Rate**: % of transactions with discrepancies
3. **Auto-Healing Success Rate**: % of discrepancies automatically healed
4. **Processing Time**: Average time for daily reconciliation

### Alert Conditions

- Daily reconciliation fails
- Discrepancy rate exceeds threshold
- Auto-healing failure rate increases
- Processing time exceeds SLA

## Troubleshooting

### Common Issues

1. **Reconciliation Fails**
   - Check database connectivity
   - Verify Soroban RPC availability
   - Review error logs for specific issues

2. **High Discrepancy Rate**
   - Check event indexer is running properly
   - Verify database transaction integrity
   - Review network latency issues

3. **Auto-Healing Failures**
   - Verify Soroban RPC node accessibility
   - Check transaction hash validity
   - Review healing retry configuration

### Debug Mode

Enable debug logging:

```env
DEBUG=reconciliation:*
```

### Manual Reconciliation

Run reconciliation manually for testing:

```bash
# Run for specific merchant
curl -X POST http://localhost:3000/reconciliation/merchant/merchant123/reconcile

# Run full daily reconciliation
curl -X POST http://localhost:3000/reconciliation/daily
```

## Performance Considerations

### Optimization Tips

1. **Batch Processing**: Configure appropriate batch sizes for large merchant volumes
2. **Database Indexing**: Ensure proper indexes on transaction_hash and event_index
3. **Connection Pooling**: Use connection pooling for database operations
4. **Caching**: Enable analytics validation caching to reduce redundant calculations

### Scaling

- **Horizontal Scaling**: Multiple scheduler instances can run with proper coordination
- **Vertical Scaling**: Increase memory and CPU for large merchant bases
- **Database Scaling**: Consider read replicas for reporting queries

## Security

### Data Protection

- All sensitive transaction data is encrypted at rest
- API endpoints require proper authentication
- Report access is restricted to authorized merchants

### Audit Trail

- All reconciliation activities are logged
- Discrepancy resolution is tracked
- Configuration changes are audited

## Compliance

### B2B Trust Features

- **Immutable Reports**: Reports cannot be modified after generation
- **Cryptographic Verification**: Transaction hashes provide proof of authenticity
- **Complete Audit Trail**: Full history of all reconciliation activities

### Regulatory Considerations

- **Data Retention**: Configurable retention policies for compliance
- **Export Capabilities**: CSV/JSON export for regulatory reporting
- **Privacy Controls**: PII protection in reports and logs

## Support & Maintenance

### Regular Maintenance

1. **Weekly**: Review discrepancy trends and patterns
2. **Monthly**: Update configuration thresholds as needed
3. **Quarterly**: Archive old reports and optimize database

### Support Contact

For issues with the Reconciliation Worker:
- Technical issues: Create GitHub issue with detailed logs
- Configuration questions: Contact support team
- Emergency issues: Use emergency contact channel

## Version History

### v1.0.0 (Current)
- Initial release with core reconciliation functionality
- Auto-healing for missing database records
- Daily report generation (JSON/CSV)
- Analytics validation for MRR/Churn
- RESTful API endpoints
- Merchant configuration management

### Future Enhancements
- Real-time reconciliation capabilities
- Advanced analytics and forecasting
- Multi-currency support
- Enhanced notification channels
- Machine learning for anomaly detection
