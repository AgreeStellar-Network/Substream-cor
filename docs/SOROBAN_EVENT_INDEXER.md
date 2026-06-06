# Soroban Event Indexer Documentation

## Overview

The Soroban Event Indexer is a robust background worker that continuously polls the Soroban RPC for specific blockchain events and stores them in the database with idempotent guarantees. This system ensures reliable tracking of subscription billing, trial starts, and payment failures on the Stellar/Soroban network.

## Architecture

### Core Components

1. **SorobanEventIndexer** - Main orchestrator that coordinates event ingestion
2. **SorobanRpcService** - RPC client with circuit breaker and retry logic
3. **SorobanXdrParser** - XDR payload parsing utilities
4. **SorobanEventPublisher** - Pub/Sub integration for internal event distribution
5. **SorobanIndexerWorker** - Worker process management and monitoring

### Data Flow

```
Soroban Network -> RPC Service -> XDR Parser -> Event Indexer -> Database
                                                    |
                                                    v
                                            Event Publisher -> RabbitMQ
```

## Configuration

### Environment Variables

```bash
# Soroban Configuration
SOROBAN_RPC_URL=https://rpc.stellar.org
SOROBAN_NETWORK_PASSPHRASE=Public Network
SOROBAN_CONTRACT_ID=CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L

# Database Configuration
DATABASE_FILENAME=./data/substream-cor.sqlite

# RabbitMQ Configuration (for event publishing)
RABBITMQ_URL=amqp://localhost:5672
RABBITMQ_EVENT_EXCHANGE=soroban_events
RABBITMQ_EVENT_QUEUE=soroban_events_queue

# Logging Configuration
LOG_LEVEL=info
```

### Advanced Configuration

```javascript
const config = {
  soroban: {
    rpcUrl: 'https://rpc.stellar.org',
    networkPassphrase: 'Public Network',
    contractId: 'CONTRACT_ID',
    maxRetries: 5,
    baseDelay: 1000,
    maxDelay: 30000,
    failureThreshold: 5,
    resetTimeout: 60000,
    requestsPerSecond: 10
  },
  processingInterval: 5000, // 5 seconds
  eventTypes: ['SubscriptionBilled', 'TrialStarted', 'PaymentFailed']
};
```

## Database Schema

### soroban_ingestion_state

Tracks the last processed ledger for each contract to enable safe resumption after restarts.

```sql
CREATE TABLE soroban_ingestion_state (
    id SERIAL PRIMARY KEY,
    contract_id VARCHAR(64) NOT NULL,
    last_ingested_ledger BIGINT NOT NULL DEFAULT 0,
    last_ingested_timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (contract_id)
);
```

### soroban_events

Stores processed events with idempotent constraints to prevent duplicates.

```sql
CREATE TABLE soroban_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(64) NOT NULL,
    transaction_hash VARCHAR(64) NOT NULL,
    event_index INTEGER NOT NULL,
    ledger_sequence BIGINT NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    event_data JSONB NOT NULL,
    raw_xdr TEXT,
    ledger_timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    ingested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (transaction_hash, event_index)
);
```

## Event Types

### SubscriptionBilled

Triggered when a subscription payment is successfully processed.

```json
{
  "eventType": "SubscriptionBilled",
  "subscriberAddress": "GABC123...",
  "creatorAddress": "GDEF456...",
  "amount": "10000000",
  "currency": "XLM",
  "billingPeriod": "monthly",
  "nextBillingDate": "2023-02-01T00:00:00Z",
  "subscriptionId": "sub_123"
}
```

### TrialStarted

Triggered when a user starts a trial subscription.

```json
{
  "eventType": "TrialStarted",
  "subscriberAddress": "GABC123...",
  "creatorAddress": "GDEF456...",
  "trialDuration": 86400,
  "trialEndDate": "2023-01-08T00:00:00Z",
  "subscriptionId": "sub_123"
}
```

### PaymentFailed

Triggered when a subscription payment fails.

```json
{
  "eventType": "PaymentFailed",
  "subscriberAddress": "GABC123...",
  "creatorAddress": "GDEF456...",
  "amount": "10000000",
  "currency": "XLM",
  "reason": "insufficient_funds",
  "retryCount": 1,
  "nextRetryDate": "2023-01-02T00:00:00Z",
  "subscriptionId": "sub_123"
}
```

## Running the Indexer

### Development

```bash
# Start the Soroban indexer in development mode
npm run soroban:dev

# Health check
npm run soroban:health
```

### Production

```bash
# Start the Soroban indexer
npm run soroban

# Run as background process
nohup npm run soroban > logs/soroban-indexer.log 2>&1 &
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run migrate
CMD ["npm", "run", "soroban"]
```

## Monitoring

### Health Check Endpoint

```bash
curl http://localhost:3000/health/soroban
```

Response:
```json
{
  "healthy": true,
  "status": {
    "isRunning": true,
    "currentLedger": 12345,
    "lastProcessedLedger": 12344,
    "eventsProcessed": 1000,
    "eventsFailed": 5,
    "duplicatesSkipped": 10,
    "uptime": 3600000,
    "eventsPerSecond": "0.28"
  },
  "indexerHealth": {
    "healthy": true,
    "responseTime": 150
  },
  "timestamp": "2023-01-01T12:00:00.000Z"
}
```

### Metrics

The indexer exposes the following metrics:

- **events_processed_total** - Total number of events successfully processed
- **events_failed_total** - Total number of events that failed processing
- **duplicates_skipped_total** - Total number of duplicate events skipped
- **ledgers_processed_total** - Total number of ledgers processed
- **processing_duration_seconds** - Time taken to process events
- **rpc_request_duration_seconds** - RPC request latency
- **circuit_breaker_state** - Circuit breaker state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)

### Logging

The indexer uses Winston for structured logging with the following levels:

- **error** - Critical errors that require attention
- **warn** - Warning messages for non-critical issues
- **info** - General operational information
- **debug** - Detailed debugging information

Log files:
- `logs/soroban-indexer.log` - All logs
- `logs/soroban-indexer-error.log` - Error logs only

## Error Handling

### Circuit Breaker

The RPC client implements a circuit breaker pattern to prevent cascading failures:

- **CLOSED** - Normal operation, requests pass through
- **OPEN** - All requests fail immediately after threshold
- **HALF_OPEN** - Limited requests allowed to test recovery

### Retry Logic

Exponential backoff with jitter:

```javascript
delay = min(baseDelay * 2^attempt + random(0, 1000), maxDelay)
```

### Idempotency

The system ensures idempotency through:

1. **Database Constraints** - `UNIQUE(transaction_hash, event_index)`
2. **Duplicate Detection** - Pre-insertion checks
3. **Safe Resume** - Ledger-based positioning

## Testing

### Unit Tests

```bash
# Run all Soroban-related tests
npm run test:soroban

# Run tests with coverage
npm run test:soroban -- --coverage
```

### Integration Tests

```bash
# Run integration tests with mock RPC
npm run test:integration -- --testPathPattern=soroban
```

### Test Coverage

- XDR parsing logic
- RPC client retry mechanisms
- Event ingestion idempotency
- Database operations
- Event publishing

## Performance

### Throughput

- **Target**: 100+ events per second
- **Batch Size**: 10 ledgers per batch
- **Processing Interval**: 5 seconds

### Memory Usage

- **Base Memory**: ~50MB
- **Event Buffer**: ~10MB
- **RPC Cache**: ~20MB

### Database Optimization

- **Indexes**: Optimized for event lookups and pagination
- **Partitioning**: Consider time-based partitioning for large datasets
- **Vacuum**: Regular cleanup of old events

## Security

### Input Validation

- XDR payload validation
- Event type whitelisting
- Data structure validation

### Access Control

- Database connection restrictions
- RPC endpoint authentication
- Event publishing permissions

## Troubleshooting

### Common Issues

1. **RPC Connection Failures**
   - Check network connectivity
   - Verify RPC endpoint availability
   - Monitor circuit breaker state

2. **Database Locks**
   - Check for long-running transactions
   - Monitor connection pool usage
   - Verify disk space

3. **Event Parsing Errors**
   - Validate XDR format
   - Check contract compatibility
   - Review parser logs

### Debug Mode

```bash
# Enable debug logging
LOG_LEVEL=debug npm run soroban

# Run with specific ledger range
LEDGER_START=1000 LEDGER_END=2000 npm run soroban
```

## Migration Guide

### From v1.0 to v2.0

1. **Database Migration**
   ```sql
   -- Run migration script
   npm run migrate:up 003_create_soroban_event_indexer.sql
   ```

2. **Configuration Update**
   - Add new environment variables
   - Update RPC endpoints
   - Configure event publishing

3. **Deployment**
   - Update application code
   - Restart indexer service
   - Monitor health status

## API Reference

### SorobanEventIndexer

```javascript
const indexer = new SorobanEventIndexer(config, dependencies);

// Start indexing
await indexer.start();

// Stop indexing
await indexer.stop();

// Get statistics
const stats = indexer.getStats();

// Health check
const health = await indexer.getHealthStatus();
```

### SorobanRpcService

```javascript
const rpc = new SorobanRpcService(config);

// Get latest ledger
const ledger = await rpc.getLatestLedger();

// Get events
const events = await rpc.getEvents(startLedger, endLedger);

// Health check
const health = await rpc.getHealthStatus();
```

### SorobanXdrParser

```javascript
const parser = new SorobanXdrParser();

// Parse event
const parsed = parser.parseEvent(event);

// Validate data
const validation = parser.validateEventData(parsedEvent);
```

## Contributing

### Development Setup

```bash
# Clone repository
git clone <repository>
cd substream-cor

# Install dependencies
npm install

# Run database migrations
npm run migrate

# Start development server
npm run soroban:dev
```

### Code Style

- Use TypeScript for new code
- Follow ESLint configuration
- Write unit tests for all functions
- Document public APIs

### Pull Request Process

1. Create feature branch
2. Add tests for new functionality
3. Ensure all tests pass
4. Update documentation
5. Submit pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
