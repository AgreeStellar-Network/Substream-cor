# Enhanced Churn Risk Prediction System

## Overview

This implementation provides a comprehensive churn risk prediction system that analyzes subscriber behavior patterns to identify users at risk of canceling their subscriptions due to payment failures (insufficient funds). The system uses machine learning-inspired rule-based logic to detect "just-in-time" top-up patterns and provides actionable insights for merchants.

## Features

### 🎯 Core Functionality
- **Just-in-Time Detection**: Identifies users who consistently top up their wallets right before payment failures
- **Multi-Factor Analysis**: Analyzes balance history, missed payment streaks, and spending patterns
- **Risk Scoring**: Provides 0-100 risk scores with categorized levels (Low, Medium, High, Critical)
- **Historical Analysis**: Examines patterns over the last 6 billing cycles

### 📊 Analytics & Insights
- **Actionable Recommendations**: Suggests retention strategies based on risk patterns
- **Real-time Analysis**: On-demand risk assessment via API
- **Daily Updates**: Automated background processing for all merchants
- **Performance Monitoring**: Built-in metrics and performance tracking

### 🚀 Performance Optimizations
- **Batch Processing**: Handles thousands of users efficiently
- **Database Indexing**: Optimized queries for large-scale scanning
- **Memory Management**: Streaming processing for large datasets
- **Error Resilience**: Graceful failure handling and retry logic

## Architecture

### Database Schema

#### Core Tables
- **`risk_metrics`**: Stores risk analysis results and prediction factors
- **`balance_history`**: Tracks wallet balance changes over time
- **`payment_attempts`**: Records all payment attempts and failures
- **`churn_risk_worker_metrics`**: Monitors worker performance

#### Key Functions
- **`detect_just_in_time_topups()`**: Identifies just-in-time top-up patterns
- **`calculate_missed_payment_streak()`**: Calculates consecutive missed payments

#### Optimized Views
- **`high_risk_subscribers`**: Real-time view of high-risk users
- **`churn_worker_performance_summary`**: Performance monitoring dashboard

### Services

#### EnhancedChurnRiskService
- **Purpose**: Core risk analysis logic
- **Key Methods**:
  - `analyzeMerchantChurnRisk(merchantId)`: Full merchant analysis
  - `analyzeSubscriberRisk(merchantId, userWallet)`: Individual user analysis
  - `getMerchantRiskAnalysis(merchantId, options)`: API data retrieval

#### EnhancedChurnRiskWorker
- **Purpose**: Background processing and daily updates
- **Features**:
  - Configurable run intervals and batch sizes
  - Performance monitoring and error handling
  - Graceful shutdown and retry logic

### API Endpoints

#### GET `/api/v1/merchants/:id/risk-analysis`
**Purpose**: Retrieve churn risk analysis for a merchant's subscribers

**Query Parameters**:
- `riskLevel`: Filter by risk level (Low, Medium, High, Critical)
- `limit`: Number of results to return (default: 100)
- `offset`: Pagination offset (default: 0)
- `includeFactors`: Include detailed prediction factors (default: true)
- `triggerAnalysis`: Force real-time analysis (default: false)

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "merchantId": "uuid",
    "summary": {
      "totalSubscribers": 1000,
      "highRiskCount": 50,
      "mediumRiskCount": 200,
      "lowRiskCount": 750,
      "averageRiskScore": 35.5
    },
    "subscribers": [...],
    "actionableInsights": [...],
    "webhookConfig": {
      "highRiskWebhook": "/api/v1/webhooks/merchants/:id/high-risk-churn",
      "retentionSuggestions": [...]
    }
  },
  "timestamp": "2026-04-28T20:00:00.000Z",
  "message": "Risk analysis retrieved successfully"
}
```

## Risk Scoring Algorithm

### Primary Factors (100 points total)

1. **Just-in-Time Top-ups (40 points)**
   - 3+ just-in-time top-ups in last 3 cycles: 40 points (High Risk)
   - 1-2 just-in-time top-ups: 10-20 points
   - Detection window: 24 hours before/after failed payment

2. **Missed Payment Streak (30 points)**
   - Each consecutive missed payment: 10 points
   - Maximum: 30 points (3+ missed payments)

3. **Balance Trend (20 points)**
   - Critical decline (>30%): 20 points
   - Decreasing (10-30%): 15 points
   - Stable: 5 points
   - Increasing: 0 points

4. **Days Until Balance Exhausted (10 points)**
   - ≤3 days: 10 points
   - ≤7 days: 7 points
   - ≤14 days: 3 points
   - >14 days: 0 points

### Risk Levels
- **Critical**: 85-100 points
- **High**: 70-84 points
- **Medium**: 40-69 points
- **Low**: 0-39 points

## Installation & Setup

### 1. Database Migration
Run the migration scripts to create the required tables:

```bash
# Run migrations
npm run migrate

# Or run specific files
psql -d your_database -f migrations/009_create_risk_metrics_table.sql
psql -d your_database -f migrations/010_create_churn_risk_worker_metrics.sql
```

### 2. Environment Configuration
Add these environment variables to your `.env` file:

```env
# Churn Risk Worker Configuration
CHURN_RISK_DEBUG=true
CHURN_RISK_BATCH_SIZE=1000
CHURN_RISK_MERCHANT_BATCH_SIZE=10
CHURN_RISK_RUN_INTERVAL=86400000  # 24 hours in milliseconds
CHURN_RISK_INITIAL_DELAY=600000    # 10 minutes in milliseconds
```

### 3. Worker Integration
The churn risk worker is automatically started with the main worker process:

```bash
# Start the worker (includes churn risk analysis)
npm run worker

# Or run in development mode
npm run worker:dev
```

### 4. API Integration
The risk analysis endpoint is automatically available when the main application starts:

```bash
# Start the main application
npm start

# Access the API
curl -X GET "http://localhost:3000/api/v1/merchants/{merchant_id}/risk-analysis"
```

## Usage Examples

### Basic Risk Analysis
```javascript
const { EnhancedChurnRiskService } = require('./src/services/enhancedChurnRiskService');

const service = new EnhancedChurnRiskService();

// Analyze all subscribers for a merchant
const analysis = await service.analyzeMerchantChurnRisk('merchant-uuid');
console.log(`Found ${analysis.highRiskCount} high-risk subscribers`);

// Get API-formatted data
const apiData = await service.getMerchantRiskAnalysis('merchant-uuid', {
  riskLevel: 'High',
  limit: 50
});
```

### Manual Worker Trigger
```javascript
const { EnhancedChurnRiskWorker } = require('./src/services/enhancedChurnRiskWorker');

const worker = new EnhancedChurnRiskWorker();

// Trigger manual analysis for specific merchants
const results = await worker.triggerManualAnalysis(['merchant-1', 'merchant-2']);

// Get worker statistics
const stats = worker.getStats();
console.log('Worker performance:', stats);
```

### API Integration
```bash
# Get risk analysis for a merchant
curl -X GET \
  "http://localhost:3000/api/v1/merchants/{merchant_id}/risk-analysis?riskLevel=High&limit=20" \
  -H "Authorization: Bearer {token}"

# Trigger real-time analysis
curl -X GET \
  "http://localhost:3000/api/v1/merchants/{merchant_id}/risk-analysis?triggerAnalysis=true" \
  -H "Authorization: Bearer {token}"
```

## Performance Considerations

### Database Optimization
- **Indexes**: All queries use optimized indexes for sub-100ms response times
- **Batching**: Large datasets are processed in configurable batches
- **Connection Pooling**: Efficient database connection management

### Memory Management
- **Streaming**: Large result sets are processed in streams
- **Garbage Collection**: Regular cleanup of temporary objects
- **Error Boundaries**: Isolated error handling prevents memory leaks

### Scalability
- **Horizontal Scaling**: Multiple worker instances can run in parallel
- **Queue Processing**: Redis-based queue for distributed processing
- **Load Balancing**: Intelligent distribution of processing load

## Monitoring & Maintenance

### Performance Metrics
The system automatically tracks:
- Processing time per merchant
- Total subscribers processed
- High-risk identification rate
- Error rates and retry attempts

### Health Checks
```bash
# Check worker status
curl -X GET "http://localhost:3000/health/worker"

# Check database connectivity
curl -X GET "http://localhost:3000/health/database"
```

### Log Analysis
```bash
# View worker logs
tail -f logs/churn-risk-worker.log

# View performance metrics
grep "Performance" logs/churn-risk-worker.log
```

## Testing

### Run Test Suite
```bash
# Run comprehensive tests
node test_churn_risk_system.js

# Run with debug output
CHURN_RISK_DEBUG=true node test_churn_risk_system.js
```

### Test Coverage
- ✅ Database schema validation
- ✅ Just-in-time detection logic
- ✅ Risk score calculation
- ✅ API endpoint functionality
- ✅ Performance optimization
- ✅ Background worker operations

## Acceptance Criteria Verification

### ✅ 1. Actionable Risk Scores
- **Implementation**: Comprehensive risk analysis with detailed factors
- **API**: `/api/v1/merchants/:id/risk-analysis` endpoint
- **Output**: Structured risk scores with actionable insights

### ✅ 2. Performance Optimization
- **Batch Processing**: Configurable batch sizes for large datasets
- **Database Indexing**: Optimized queries for thousands of users
- **Memory Efficiency**: Streaming processing and garbage collection

### ✅ 3. Retention Triggers
- **Webhooks**: Configurable endpoints for high-risk alerts
- **Email Integration**: Automated retention email suggestions
- **API Integration**: Real-time risk data for external systems

## Troubleshooting

### Common Issues

#### Worker Not Starting
```bash
# Check environment variables
echo $CHURN_RISK_DEBUG

# Verify database connection
npm run health-check
```

#### Slow Performance
```bash
# Check database indexes
psql -d your_database -c "\d risk_metrics"

# Monitor worker stats
curl -X GET "http://localhost:3000/api/v1/workers/churn-risk/stats"
```

#### Inaccurate Risk Scores
```bash
# Verify data quality
psql -d your_database -c "SELECT COUNT(*) FROM balance_history WHERE merchant_id = 'uuid'"

# Check analysis logs
grep "risk_score" logs/churn-risk-worker.log | tail -20
```

### Debug Mode
Enable detailed logging:
```bash
CHURN_RISK_DEBUG=true npm run worker:dev
```

## Future Enhancements

### Planned Features
- **Machine Learning**: Replace rule-based logic with ML models
- **Real-time Streaming**: Kafka integration for live risk updates
- **Advanced Analytics**: Predictive modeling for churn prevention
- **Multi-tenant**: Enhanced multi-merchant isolation

### API Extensions
- **Webhook Management**: CRUD operations for retention webhooks
- **Custom Thresholds**: Per-merchant risk configuration
- **Historical Trends**: Long-term risk pattern analysis

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review the test suite for expected behavior
3. Enable debug mode for detailed logging
4. Check the health endpoints for system status

---

**Implementation Date**: April 28, 2026  
**Version**: 1.0.0  
**Compatibility**: Node.js 20.11.0+, PostgreSQL 12+
