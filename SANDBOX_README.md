# AgreeStellar Sandbox Environment

A comprehensive developer sandbox environment for testing AgreeStellar integrations without real money transactions.

## Overview

The SubStream Sandbox provides developers with a complete testing environment that simulates all protocol features using zero-value tokens and testnet blockchain operations. This allows for safe development and testing without financial risk.

## Features

### ✅ Core Sandbox Features
- **Environment Toggle**: Switch between sandbox (testnet) and production (mainnet) modes
- **Zero-Value Tokens**: Test all features with zero-value tokens
- **Mock Payment API**: Simulate successful payments and subscription events
- **Failure Simulation**: Test error handling with configurable failure scenarios
- **Database Isolation**: Sandbox data is completely isolated from production data
- **Testnet Integration**: Full Stellar Testnet support with automatic account funding

### 🛠️ Developer Tools
- **Web Dashboard**: Browser-based interface for sandbox management
- **CLI Tool**: Command-line interface for automation and scripting
- **Postman Collection**: Ready-to-use API requests for testing
- **Webhook Testing**: Test webhook delivery with mock events

## Quick Start

### 1. Enable Sandbox Mode

Set the following environment variables in your `.env` file:

```bash
# Enable sandbox environment
SANDBOX_ENABLED=true
SANDBOX_MODE=testnet

# Testnet configuration
SANDBOX_STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SANDBOX_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
SANDBOX_SOROBAN_RPC_URL=https://soroban-rpc.testnet.stellar.gateway.fm

# Sandbox features
SANDBOX_MOCK_PAYMENTS_ENABLED=true
SANDBOX_FAILURE_SIMULATION_ENABLED=true
SANDBOX_ZERO_VALUE_TOKENS_ENABLED=true
```

### 2. Start the Backend

```bash
npm start
```

### 3. Access the Dashboard

Open your browser and navigate to:
```
http://localhost:3000/sandbox-dashboard.html
```

### 4. Create a Testnet Account

Use the dashboard or CLI to create a funded testnet account:

```bash
node tools/substream-cli.js create-testnet-account
```

## API Reference

### Sandbox Status

```http
GET /api/sandbox/status
```

Returns the current sandbox configuration and status.

### Mock Payment

```http
POST /api/sandbox/mock-payment
Authorization: Bearer <token>

{
  "subscriptionId": "test_subscription_123",
  "creatorAddress": "GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7",
  "subscriberAddress": "GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A",
  "amount": 0,
  "tier": "bronze",
  "metadata": {}
}
```

Creates a mock `SubscriptionBilled` event that triggers webhooks and updates the internal indexer.

### Simulate Failure

```http
POST /api/sandbox/simulate-failure
Authorization: Bearer <token>

{
  "subscriptionId": "test_subscription_123",
  "failureType": "insufficient_funds"
}
```

Simulates a payment failure for testing error handling and retry logic.

### Testnet Account

```http
POST /api/sandbox/testnet-account
Authorization: Bearer <token>
```

Creates a new Stellar testnet account and funds it using the friendbot.

### Mock Events

```http
GET /api/sandbox/mock-events?limit=50&offset=0
Authorization: Bearer <token>
```

Retrieves the history of mock events created in the sandbox.

```http
DELETE /api/sandbox/mock-events
Authorization: Bearer <token>
```

Clears all mock events from the sandbox.

## CLI Tool Usage

### Installation

The CLI tool is located at `tools/substream-cli.js`. Make it executable:

```bash
chmod +x tools/substream-cli.js
```

### Configuration

Set your API endpoint and authentication token:

```bash
node tools/substream-cli.js config baseURL http://localhost:3000
node tools/substream-cli.js config authToken your-jwt-token
```

### Common Commands

```bash
# Check sandbox status
node tools/substream-cli.js status

# Create a mock payment
node tools/substream-cli.js mock-payment \
  --subscription-id "test_123" \
  --creator-address "GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7" \
  --subscriber-address "GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A" \
  --amount 0 \
  --tier bronze

# Simulate a payment failure
node tools/substream-cli.js simulate-failure \
  --subscription-id "test_123" \
  --failure-type insufficient_funds

# Create a testnet account
node tools/substream-cli.js create-testnet-account

# View mock events
node tools/substream-cli.js events --limit 10

# Clear all events
node tools/substream-cli.js clear-events

# Test webhook delivery
node tools/substream-cli.js test-webhook \
  --webhook-url "https://webhook.site/your-id" \
  --event-type SubscriptionBilled
```

## Postman Collection

Import the provided Postman collection from `tools/postman/sandbox-api.postman_collection.json`:

1. Open Postman
2. Click "Import" → "File"
3. Select the collection file
4. Set the `baseUrl` and `stellarAuthToken` variables

## Testing Scenarios

### 1. Basic Subscription Flow

```bash
# 1. Create testnet accounts for creator and subscriber
node tools/substream-cli.js create-testnet-account
node tools/substream-cli.js create-testnet-account

# 2. Create a mock subscription payment
node tools/substream-cli.js mock-payment \
  --subscription-id "basic_test_001" \
  --creator-address "CREATOR_PUBLIC_KEY" \
  --subscriber-address "SUBSCRIBER_PUBLIC_KEY" \
  --tier bronze

# 3. Check the events
node tools/substream-cli.js events
```

### 2. Failure Testing

```bash
# Test insufficient funds failure
node tools/substream-cli.js simulate-failure \
  --subscription-id "failure_test_001" \
  --failure-type insufficient_funds

# Test network error
node tools/substream-cli.js simulate-failure \
  --subscription-id "failure_test_002" \
  --failure-type network_error
```

### 3. Webhook Testing

```bash
# Test webhook delivery
node tools/substream-cli.js test-webhook \
  --webhook-url "https://your-webhook-endpoint.com/webhook" \
  --event-type SubscriptionBilled \
  --payload '{"subscriptionId":"webhook_test_001","amount":0}'
```

## Database Schema Isolation

The sandbox environment uses database schema prefixes to ensure complete data isolation:

- **Production**: Uses standard table names (`creators`, `subscriptions`, etc.)
- **Sandbox**: Uses prefixed table names (`sandbox_creators`, `sandbox_subscriptions`, etc.)

This ensures that sandbox operations never affect production data, even when using the same database instance.

## Failure Simulation

The sandbox provides configurable failure simulation rules:

### Default Rules

```json
{
  "random_failure": {
    "enabled": true,
    "probability": 0.1,
    "types": ["insufficient_funds", "network_error", "timeout"]
  },
  "grace_period": {
    "enabled": true,
    "duration": 259200000,
    "warnings": [86400000, 43200000]
  }
}
```

### Updating Rules

```bash
# Update failure probability to 15%
curl -X PUT http://localhost:3000/api/sandbox/failure-rules/random_failure \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "probability": 0.15,
    "types": ["insufficient_funds", "network_error", "timeout", "account_locked"]
  }'
```

## Zero-Value Tokens

When zero-value tokens are enabled, all payment operations default to 0 amount transactions. This allows for:

- Testing subscription logic without financial risk
- Validating webhook integrations
- Testing tier access controls
- Verifying billing workflows

## Environment Variables

### Core Sandbox Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_ENABLED` | `false` | Enable sandbox mode |
| `SANDBOX_MODE` | `testnet` | Network mode (testnet/mainnet) |
| `SANDBOX_DB_SCHEMA_PREFIX` | `sandbox_` | Database table prefix |

### Stellar Testnet Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | Stellar testnet passphrase |
| `SANDBOX_STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Testnet horizon endpoint |
| `SANDBOX_SOROBAN_RPC_URL` | `https://soroban-rpc.testnet.stellar.gateway.fm` | Testnet Soroban RPC |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_MOCK_PAYMENTS_ENABLED` | `true` | Enable mock payment API |
| `SANDBOX_FAILURE_SIMULATION_ENABLED` | `true` | Enable failure simulation |
| `SANDBOX_ZERO_VALUE_TOKENS_ENABLED` | `true` | Enforce zero-value tokens |

## Security Considerations

### Testnet vs Production

- **Never** use testnet private keys in production
- **Always** validate environment before processing real transactions
- **Ensure** sandbox mode is disabled in production deployments

### Authentication

The sandbox API requires the same authentication as production endpoints. Use your existing JWT tokens or Stellar authentication.

### Data Isolation

- Sandbox data uses separate database schemas
- Mock events are stored in sandbox-specific tables
- Testnet accounts are separate from mainnet accounts

## Troubleshooting

### Common Issues

1. **Sandbox not enabled**
   - Check `SANDBOX_ENABLED=true` in your environment
   - Restart the backend after changing configuration

2. **Testnet account funding fails**
   - Verify testnet friendbot is available
   - Check network connectivity to testnet endpoints

3. **Mock payments not triggering webhooks**
   - Verify webhook URLs are accessible
   - Check webhook secret configuration

4. **Database schema conflicts**
   - Ensure proper schema prefixes are configured
   - Check database permissions for schema creation

### Debug Mode

Enable debug logging by setting:

```bash
LOG_LEVEL=debug
```

This will provide detailed logs about sandbox operations, including:
- Environment configuration changes
- Mock event creation and processing
- Database schema operations
- API request/response details

## Integration Examples

### JavaScript/Node.js

```javascript
const axios = require('axios');

// Create a mock payment
async function createMockPayment() {
  try {
    const response = await axios.post('http://localhost:3000/api/sandbox/mock-payment', {
      subscriptionId: 'test_subscription_001',
      creatorAddress: 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7',
      subscriberAddress: 'GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A',
      amount: 0,
      tier: 'bronze'
    }, {
      headers: {
        'Authorization': 'Bearer ' + yourJwtToken
      }
    });
    
    console.log('Mock payment created:', response.data);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}
```

### Python

```python
import requests

def create_mock_payment():
    url = 'http://localhost:3000/api/sandbox/mock-payment'
    headers = {'Authorization': f'Bearer {jwt_token}'}
    data = {
        'subscriptionId': 'test_subscription_001',
        'creatorAddress': 'GD5DJQDKEZ6BDJQ3MHLQZSYXO5VJ5D7',
        'subscriberAddress': 'GB3K4PLCEQ6D5XQ5K2A6Z5FQ7Y8Z9A',
        'amount': 0,
        'tier': 'bronze'
    }
    
    response = requests.post(url, json=data, headers=headers)
    if response.status_code == 200:
        print('Mock payment created:', response.json())
    else:
        print('Error:', response.json())
```

## Support

For issues and questions about the sandbox environment:

1. Check this README for common solutions
2. Review the API documentation
3. Enable debug logging for detailed error information
4. Contact the development team with specific error details

## Contributing

When contributing to the sandbox environment:

1. Test all changes in sandbox mode first
2. Ensure database isolation is maintained
3. Update documentation for new features
4. Add tests for new sandbox functionality

---

**Note**: The sandbox environment is for development and testing only. Never use sandbox credentials or data in production environments.
