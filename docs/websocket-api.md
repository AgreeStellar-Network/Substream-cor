# AgreeStellar WebSocket API Documentation

## Overview

The AgreeStellar WebSocket API provides real-time event streaming for merchant dashboards. This API enables instant notifications for payment events, trial conversions, and payment failures.

## Authentication

### SEP-10 JWT Authentication

All WebSocket connections must be authenticated using SEP-10 JSON Web Tokens (JWTs).

#### Connection Headers

```javascript
// Option 1: Using auth parameter
const socket = io('ws://localhost:3001/merchant', {
  auth: {
    token: 'your-sep-10-jwt-token'
  }
});

// Option 2: Using Authorization header
const socket = io('ws://localhost:3001/merchant', {
  extraHeaders: {
    Authorization: 'Bearer your-sep-10-jwt-token'
  }
});
```

#### Token Requirements

- **Algorithm**: RS256 or ES256
- **Claims**:
  - `sub` (required): Stellar public key of the merchant
  - `exp` (required): Token expiration timestamp
  - `iat` (optional): Token issued at timestamp

#### Token Validation

The server validates tokens by:
1. Verifying cryptographic signature
2. Checking token expiration
3. Extracting Stellar public key from `sub` claim
4. Assigning connection to merchant-specific room

## Connection Endpoints

### Primary WebSocket Endpoint

```
ws://localhost:3001/merchant
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WS_PORT` | WebSocket server port | `3001` |
| `JWT_SECRET` | JWT verification secret | Required |
| `CORS_ORIGIN` | CORS allowed origins | `*` |
| `REDIS_PUBSUB_URL` | Redis Pub/Sub connection | `redis://localhost:6379` |

## Event Types

### 1. Payment Success (`payment_success`)

Emitted when a successful pull payment is processed.

#### Payload Schema

```typescript
interface PaymentSuccessPayload {
  stellarPublicKey: string;
  planId: string;
  amount: string;
  timestamp: string;
  transactionHash: string;
}
```

#### Example

```javascript
socket.on('payment_success', (data) => {
  console.log('Payment received:', data);
  // data.type: 'payment_success'
  // data.data: PaymentSuccessPayload
  // data.timestamp: ISO string
});
```

### 2. Payment Failure (`payment_failed`)

Emitted when a payment fails. Supports batching for high-volume failures.

#### Individual Failure Payload

```typescript
interface PaymentFailedPayload {
  stellarPublicKey: string;
  planId: string;
  userId: string;
  failureReason: string;
  timestamp: string;
  deepLinkRef: string;
}
```

#### Batched Failure Payload

```typescript
interface BatchedPaymentFailedPayload {
  stellarPublicKey: string;
  failures: PaymentFailedPayload[];
  batchId: string;
  timestamp: string;
  totalCount: number;
}
```

#### Failure Reason Codes

| Code | Description |
|------|-------------|
| `INSUFFICIENT_FUNDS` | Account lacks sufficient balance |
| `ACCOUNT_FROZEN` | Account is frozen |
| `ACCOUNT_SUSPENDED` | Account is suspended |
| `INVALID_SIGNATURE` | Transaction signature is invalid |
| `NETWORK_ERROR` | Network connectivity issue |
| `TIMEOUT` | Transaction timed out |
| `RATE_LIMITED` | Rate limit exceeded |

#### Example

```javascript
socket.on('payment_failed', (data) => {
  if (data.data.failures) {
    // Batched failures
    console.log(`${data.data.totalCount} payment failures:`, data.data.failures);
  } else {
    // Individual failure
    console.log('Payment failed:', data.data);
  }
});
```

### 3. Trial Conversion (`trial_converted`)

Emitted when a trial user converts to a paid plan.

#### Payload Schema

```typescript
interface TrialConvertedPayload {
  stellarPublicKey: string;
  planId: string;
  userId: string;
  timestamp: string;
}
```

#### Example

```javascript
socket.on('trial_converted', (data) => {
  console.log('Trial converted:', data);
});
```

## Heartbeat & Connection Management

### Ping-Pong Mechanism

The server sends periodic `ping` messages to detect zombie connections.

#### Client Response

```javascript
socket.on('ping', (data) => {
  console.log('Ping received:', data.timestamp);
  // Server automatically handles pong response
});
```

### Connection Events

#### Connected Event

```javascript
socket.on('connected', (data) => {
  console.log('Connected to AgreeStellar');
  console.log('Merchant ID:', data.merchantId);
});
```

#### Error Events

```javascript
socket.on('error', (error) => {
  console.error('WebSocket error:', error.message);
});
```

#### Token Expiration

```javascript
socket.on('token_expired', (data) => {
  console.log('Token expired:', data.message);
  // Client should reconnect with fresh token
});
```

#### Connection Timeout

```javascript
socket.on('timeout', (data) => {
  console.log('Connection timeout:', data.message);
  // Client should reconnect
});
```

## Security Features

### Room Isolation

Each merchant is assigned to a dedicated room named after their Stellar public key. This ensures:
- **Cross-tenant data leakage prevention**: Merchants only receive their own events
- **Mathematical isolation**: Room assignments are cryptographically bound to public keys
- **No broadcast overlap**: Events are routed only to intended recipients

### Token Expiration Handling

- Active token validation on long-lived connections
- Automatic disconnection when tokens expire
- Real-time token expiration checks during heartbeat

### Connection Limits

- **Connection timeout**: 5 minutes of inactivity
- **Heartbeat interval**: 30 seconds
- **Automatic cleanup**: Zombie connections are purged

## Scaling Architecture

### Redis Pub/Sub Integration

The WebSocket gateway uses Redis Pub/Sub for horizontal scaling:

1. **Event Publishing**: Any pod can publish events to Redis channels
2. **Universal Subscription**: All WebSocket pods subscribe to Redis channels
3. **Cross-pod Communication**: Events are distributed across all instances
4. **Load Distribution**: Clients can connect to any available pod

### Redis Channels

| Channel | Purpose | Payload |
|---------|---------|---------|
| `payment_success` | Successful payments | `PaymentSuccessPayload` |
| `payment_failed` | Failed payments | `PaymentFailedPayload` |
| `trial_converted` | Trial conversions | `TrialConvertedPayload` |

### Failure Handling

- **Reconnection**: Automatic Redis reconnection with exponential backoff
- **Buffering**: Events are buffered during Redis outages
- **Graceful degradation**: Service continues with local events during Redis failures

## SDK Examples

### JavaScript/TypeScript Client

```typescript
import { io, Socket } from 'socket.io-client';

class SubStreamWebSocket {
  private socket: Socket;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.socket = io('ws://localhost:3001/merchant', {
      auth: { token }
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.socket.on('connected', (data) => {
      console.log('Connected:', data);
    });

    this.socket.on('payment_success', (data) => {
      this.handlePaymentSuccess(data);
    });

    this.socket.on('payment_failed', (data) => {
      this.handlePaymentFailure(data);
    });

    this.socket.on('trial_converted', (data) => {
      this.handleTrialConversion(data);
    });

    this.socket.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    this.socket.on('token_expired', () => {
      this.reconnect();
    });
  }

  private handlePaymentSuccess(data: any) {
    // Update UI with successful payment
    console.log('Payment success:', data);
  }

  private handlePaymentFailure(data: any) {
    // Show payment failure notification
    console.log('Payment failure:', data);
  }

  private handleTrialConversion(data: any) {
    // Update trial conversion metrics
    console.log('Trial conversion:', data);
  }

  private reconnect() {
    // Implement token refresh and reconnection logic
    const newToken = this.refreshToken();
    this.socket = io('ws://localhost:3001/merchant', {
      auth: { token: newToken }
    });
  }

  disconnect() {
    this.socket.disconnect();
  }
}

// Usage
const client = new SubStreamWebSocket('your-sep-10-jwt-token');
```

## Testing

### Integration Tests

The WebSocket API includes comprehensive integration tests covering:
- Authentication scenarios
- Real-time event delivery
- Cross-tenant isolation
- Redis scaling
- Error handling

Run tests with:
```bash
npm run test:ws
```

### Security Tests

Security tests verify:
- JWT token validation
- Cross-tenant data leakage prevention
- Token expiration handling
- Unauthorized connection rejection

## Error Codes

| Error | Description | Action |
|-------|-------------|--------|
| `AUTHENTICATION_FAILED` | Invalid or missing token | Provide valid SEP-10 JWT |
| `TOKEN_EXPIRED` | Authentication token expired | Refresh token and reconnect |
| `CONNECTION_TIMEOUT` | Inactivity timeout | Reconnect to server |
| `REDIS_ERROR` | Redis connectivity issue | Service continues with local events |

## Monitoring & Observability

### Connection Metrics

- Active connections per merchant
- Connection duration statistics
- Token expiration events
- Error rates by type

### Event Metrics

- Events per second (EPS)
- Event delivery latency
- Batch processing statistics
- Redis queue depth

### Health Check

```bash
curl http://localhost:3001/health
```

Returns WebSocket gateway health status including Redis connectivity.

## Deployment Considerations

### Kubernetes Configuration

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: websocket-gateway
spec:
  replicas: 3
  selector:
    matchLabels:
      app: websocket-gateway
  template:
    metadata:
      labels:
        app: websocket-gateway
    spec:
      containers:
      - name: websocket-gateway
        image: substream/websocket-gateway:latest
        ports:
        - containerPort: 3001
        env:
        - name: REDIS_PUBSUB_URL
          value: "redis://redis-cluster:6379"
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: jwt-secret
              key: secret
```

### Redis Requirements

- **Dedicated Instance**: Separate Redis cluster for Pub/Sub
- **Memory**: 2GB minimum for production
- **Persistence**: Disabled for Pub/Sub (memory-only)
- **Clustering**: Enabled for horizontal scaling

## Rate Limiting

### Connection Limits

- **Per Merchant**: 100 concurrent connections
- **Per IP**: 50 concurrent connections
- **Global**: 10,000 concurrent connections

### Event Rate Limits

- **Payment Events**: 1000 events/second per merchant
- **Batch Processing**: 10 events/second threshold
- **Burst Capacity**: 5000 events/second for 1 minute

## Troubleshooting

### Common Issues

1. **Connection Rejected**
   - Check JWT token validity
   - Verify `sub` claim contains Stellar public key
   - Ensure token is not expired

2. **Missing Events**
   - Verify Redis connectivity
   - Check merchant room assignment
   - Review event payload format

3. **Performance Issues**
   - Monitor Redis memory usage
   - Check connection pool size
   - Review batch processing metrics

### Debug Logging

Enable debug logging:
```bash
DEBUG=socket.io:* npm run start:ws:dev
```

## Version History

### v1.0.0
- Initial WebSocket gateway implementation
- SEP-10 JWT authentication
- Redis Pub/Sub scaling
- Real-time payment events
- Dunning alert system
- Comprehensive test suite
