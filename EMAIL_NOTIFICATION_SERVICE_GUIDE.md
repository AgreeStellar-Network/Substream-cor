# Email Notification Service Guide

## Overview

The Email Notification Service provides a reliable, scalable system for dispatching transactional emails to users. It features provider abstraction (AWS SES/SendGrid), asynchronous processing with BullMQ, exponential backoff for rate limiting, and comprehensive template variable mapping for personalized communications.

## Architecture

### Core Components

1. **BaseEmailProvider** (`services/emailProviders/BaseEmailProvider.js`)
   - Abstract interface for email providers
   - Standardized error handling and response formatting
   - Email validation and normalization
   - Rate limit detection and retry logic

2. **SESProvider** (`services/emailProviders/SESProvider.js`)
   - AWS Simple Email Service integration
   - Template and simple email support
   - Comprehensive SES API features
   - Rate limit handling

3. **SendGridProvider** (`services/emailProviders/SendGridProvider.js`)
   - SendGrid API integration
   - Dynamic template support
   - Advanced features (validation, suppression)
   - Rate limit handling

4. **EmailQueueService** (`services/emailQueue.js`)
   - BullMQ-based asynchronous processing
   - Exponential backoff retry logic
   - Rate limiting and concurrency control
   - Job status tracking

5. **NotificationService** (`services/notificationService.js`)
   - Unified service with provider abstraction
   - Template variable mapping system
   - Provider switching and management
   - Predefined templates

6. **API Routes** (`routes/notifications.js`)
   - RESTful endpoints for email management
   - Queue monitoring and control
   - Provider management
   - Template management

## Configuration

### Environment Variables

```bash
# Email Provider Configuration
DEFAULT_EMAIL_PROVIDER=ses  # or 'sendgrid'

# AWS SES Configuration
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_SESSION_TOKEN=your-session-token  # Optional

# SendGrid Configuration
SENDGRID_API_KEY=your-sendgrid-api-key

# Redis Configuration (for BullMQ)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password
REDIS_DB=0

# Queue Configuration
NOTIFICATION_QUEUE_NAME=notification-queue
NOTIFICATION_CONCURRENCY=5
NOTIFICATION_RATE_LIMIT_MAX=100
NOTIFICATION_RATE_LIMIT_DURATION=60000

# Default Email Configuration
DEFAULT_FROM_EMAIL=noreply@substream.app
```

### Service Configuration

```javascript
const notificationService = new NotificationService({
  defaultProvider: 'ses',
  ses: {
    region: 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  sendgrid: {
    apiKey: process.env.SENDGRID_API_KEY
  },
  redis: {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD
  },
  queueName: 'notification-queue',
  concurrency: 5,
  rateLimitMax: 100,
  rateLimitDuration: 60000,
  globalTemplateMappings: {
    companyName: 'AgreeStellar',
    website: 'https://substream.app'
  }
});
```

## API Endpoints

### Email Sending

#### Send Template Email
```
POST /api/v1/notifications/send
Authorization: Bearer <JWT_TOKEN>

{
  "to": "user@example.com",
  "from": "noreply@example.com",
  "subject": "Welcome to SubStream",
  "templateId": "welcome-template",
  "templateData": {
    "name": "John Doe",
    "plan": "premium"
  },
  "provider": "ses",
  "options": {
    "attempts": 3,
    "delay": 0,
    "priority": 0
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "uuid-1234",
    "queue": "notification-queue",
    "provider": "ses",
    "addedAt": "2024-01-15T10:00:00.000Z",
    "message": "Email queued for processing"
  }
}
```

#### Send Simple Email
```
POST /api/v1/notifications/send-simple
Authorization: Bearer <JWT_TOKEN>

{
  "to": "user@example.com",
  "from": "noreply@example.com",
  "subject": "Simple Email",
  "text": "This is a plain text email",
  "html": "<p>This is an HTML email</p>"
}
```

#### Send Bulk Email
```
POST /api/v1/notifications/send-bulk
Authorization: Bearer <JWT_TOKEN>

{
  "recipients": [
    {
      "email": "user1@example.com",
      "templateData": { "name": "User 1" }
    },
    {
      "email": "user2@example.com",
      "templateData": { "name": "User 2" }
    }
  ],
  "from": "noreply@example.com",
  "subject": "Bulk Announcement",
  "templateId": "announcement-template",
  "templateData": {
    "company": "AgreeStellar"
  }
}
```

#### Send Predefined Template
```
POST /api/v1/notifications/send-template
Authorization: Bearer <JWT_TOKEN>

{
  "templateType": "welcome",
  "to": "user@example.com",
  "templateData": {
    "name": "John Doe",
    "plan": "premium"
  }
}
```

### Job Management

#### Get Job Status
```
GET /api/v1/notifications/job/:jobId
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "uuid-1234",
    "state": "completed",
    "progress": 100,
    "createdAt": "2024-01-15T10:00:00.000Z",
    "processedOn": "2024-01-15T10:00:05.000Z",
    "finishedOn": "2024-01-15T10:00:05.000Z",
    "returnvalue": {
      "success": true,
      "messageId": "aws-ses-message-id",
      "provider": "SESProvider"
    }
  }
}
```

### Queue Management

#### Get Queue Statistics
```
GET /api/v1/notifications/queue/stats
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "queueName": "notification-queue",
    "stats": {
      "waiting": 5,
      "active": 2,
      "completed": 100,
      "failed": 3,
      "delayed": 1,
      "total": 111
    }
  }
}
```

#### Get Recent Jobs
```
GET /api/v1/notifications/queue/jobs?state=completed&start=0&end=50
Authorization: Bearer <JWT_TOKEN>
```

#### Pause/Resume Queue
```
POST /api/v1/notifications/queue/pause
POST /api/v1/notifications/queue/resume
Authorization: Bearer <JWT_TOKEN>
```

#### Clear Queue
```
POST /api/v1/notifications/queue/clear
Authorization: Bearer <JWT_TOKEN>

{
  "state": "waiting"
}
```

### Provider Management

#### Get Available Providers
```
GET /api/v1/notifications/providers
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "availableProviders": ["ses", "sendgrid"],
    "defaultProvider": "ses",
    "providerStats": {
      "ses": {
        "name": "SESProvider",
        "service": "AWS SES",
        "region": "us-east-1"
      },
      "sendgrid": {
        "name": "SendGridProvider",
        "service": "SendGrid",
        "baseUrl": "https://api.sendgrid.com/v3"
      }
    }
  }
}
```

#### Switch Provider
```
POST /api/v1/notifications/providers/switch
Authorization: Bearer <JWT_TOKEN>

{
  "provider": "sendgrid"
}
```

#### Test Provider Connection
```
POST /api/v1/notifications/providers/test
Authorization: Bearer <JWT_TOKEN>

{
  "provider": "ses"
}
```

### Template Management

#### Get Template Mappings
```
GET /api/v1/notifications/templates
Authorization: Bearer <JWT_TOKEN>
```

#### Add Template Mapping
```
POST /api/v1/notifications/templates
Authorization: Bearer <JWT_TOKEN>

{
  "templateId": "custom-welcome",
  "mapping": {
    "defaultVariables": {
      "appName": "My App",
      "supportEmail": "support@example.com"
    }
  }
}
```

#### Remove Template Mapping
```
DELETE /api/v1/notifications/templates/:templateId
Authorization: Bearer <JWT_TOKEN>
```

### Monitoring

#### Get Health Status
```
GET /api/v1/notifications/health
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "defaultProvider": "ses",
    "availableProviders": ["ses", "sendgrid"],
    "queue": {
      "queueName": "notification-queue",
      "provider": "ses",
      "redisConnected": true,
      "workerActive": true
    },
    "providers": { ... },
    "templateMappings": 5
  }
}
```

#### Get Comprehensive Statistics
```
GET /api/v1/notifications/stats
Authorization: Bearer <JWT_TOKEN>
```

## Template System

### Predefined Templates

The service includes predefined templates for common use cases:

#### Welcome Template
```javascript
{
  "templateId": "welcome",
  "defaultVariables": {
    "appName": "AgreeStellar",
    "supportEmail": "support@substream.app",
    "currentYear": 2024
  }
}
```

#### Payment Failure Template
```javascript
{
  "templateId": "payment_failure",
  "defaultVariables": {
    "appName": "AgreeStellar",
    "supportEmail": "support@substream.app",
    "billingUrl": "https://app.substream.app/billing"
  }
}
```

#### Low Balance Warning Template
```javascript
{
  "templateId": "low_balance_warning",
  "defaultVariables": {
    "appName": "AgreeStellar",
    "supportEmail": "support@substream.app",
    "addFundsUrl": "https://app.substream.app/wallet/add-funds"
  }
}
```

#### Pre-Billing Health Check Template
```javascript
{
  "templateId": "pre_billing_warning",
  "defaultVariables": {
    "appName": "AgreeStellar",
    "supportEmail": "support@substream.app",
    "warningDays": 3
  }
}
```

### Custom Templates

You can create custom templates with dynamic variables:

```javascript
notificationService.addTemplateMapping('custom_template', {
  defaultVariables: {
    companyName: 'Your Company',
    website: 'https://yourcompany.com',
    logoUrl: 'https://yourcompany.com/logo.png',
    currentYear: () => new Date().getFullYear(),
    timestamp: () => new Date().toISOString()
  }
});
```

### Template Variable Processing

The system supports various variable types:

- **Static Variables**: Simple key-value pairs
- **Function Variables**: Dynamic values generated at send time
- **Nested Objects**: Complex data structures
- **Global Mappings**: Variables applied to all templates
- **Template-Specific Mappings**: Variables for specific templates

## Rate Limiting and Retry Logic

### Exponential Backoff

The system implements intelligent retry logic with exponential backoff:

```javascript
{
  "attempts": 3,
  "backoff": {
    "type": "exponential",
    "delay": 2000  // Start with 2 seconds
  }
}
```

### Rate Limit Detection

Each provider detects rate limit errors:

#### AWS SES Rate Limits
- `ThrottlingException`: 30 seconds retry
- `TooManyRequestsException`: 60 seconds retry
- `SendingPausedException`: 60 seconds retry

#### SendGrid Rate Limits
- HTTP 429: Uses `Retry-After` header or defaults to 60 seconds

### Queue Rate Limiting

The queue itself implements rate limiting:

```javascript
{
  "limiter": {
    "max": 100,        // Max jobs per duration
    "duration": 60000  // 1 minute
  }
}
```

## Error Handling

### Standardized Error Responses

All errors follow a consistent format:

```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "isRateLimit": false,
  "retryAfter": null,
  "timestamp": "2024-01-15T10:00:00.000Z",
  "context": { ... }
}
```

### Error Types

1. **Validation Errors**: Missing required fields, invalid data
2. **Provider Errors**: AWS SES/SendGrid API errors
3. **Queue Errors**: BullMQ processing errors
4. **Rate Limit Errors**: Provider rate limits
5. **Configuration Errors**: Missing configuration

## Monitoring and Observability

### Metrics

The system provides comprehensive metrics:

- **Queue Metrics**: Waiting, active, completed, failed jobs
- **Provider Metrics**: Success rates, error rates, response times
- **Template Metrics**: Usage statistics, variable mapping
- **Health Metrics**: Service status, connection status

### Logging

All operations are logged with appropriate levels:

- **INFO**: Successful operations, queue status
- **WARN**: Rate limits, retries, degraded performance
- **ERROR**: Failed operations, provider errors
- **DEBUG**: Detailed processing information

### Health Checks

Multiple health check endpoints:

- `/api/v1/notifications/health`: Service health
- `/api/v1/notifications/providers/test`: Provider connections
- `/api/v1/notifications/queue/stats`: Queue status

## Security Considerations

### API Security

- **Authentication**: JWT token required for all endpoints
- **Authorization**: Role-based access control
- **Input Validation**: All inputs validated and sanitized
- **Rate Limiting**: API-level rate limiting

### Data Protection

- **Sensitive Data**: API keys and secrets stored in environment variables
- **Template Data**: User data processed securely
- **Audit Trail**: All email operations logged
- **Data Retention**: Configurable job retention policies

### Provider Security

- **AWS SES**: IAM roles with least privilege
- **SendGrid**: API key restrictions and IP allowlists
- **Redis**: Authentication and TLS encryption
- **HTTPS**: All external communications encrypted

## Performance Optimization

### Queue Optimization

- **Concurrency**: Configurable worker concurrency
- **Batching**: Bulk email processing
- **Prioritization**: Job priority levels
- **Memory Management**: Efficient job processing

### Provider Optimization

- **Connection Pooling**: Reuse provider connections
- **Caching**: Template and configuration caching
- **Timeouts**: Configurable request timeouts
- **Retry Logic**: Intelligent retry strategies

### Database Optimization

- **Indexes**: Optimized database queries
- **Connection Pooling**: Database connection reuse
- **Query Optimization**: Efficient data retrieval
- **Cleanup**: Automatic cleanup of old data

## Testing

### Unit Tests

```bash
# Run all notification tests
npm test notificationService.test.js

# Run provider-specific tests
npm test -- --testNamePattern="SES Provider"
npm test -- --testNamePattern="SendGrid Provider"
```

### Integration Tests

```bash
# Run queue integration tests
npm test -- --testNamePattern="Email Queue"

# Run API endpoint tests
npm test -- --testNamePattern="API Endpoints"
```

### Acceptance Tests

The acceptance criteria are tested with:

```bash
npm test -- --testNamePattern="Acceptance Criteria"
```

### Mock Testing

All providers are mocked for testing:

```javascript
// Mock AWS SES
jest.mock('aws-sdk');

// Mock SendGrid
jest.mock('axios');

// Mock BullMQ
jest.mock('bullmq');
```

## Deployment

### Production Deployment

1. **Environment Setup**
   ```bash
   export NODE_ENV=production
   export DEFAULT_EMAIL_PROVIDER=ses
   export AWS_REGION=us-east-1
   export REDIS_HOST=your-redis-host
   ```

2. **Service Initialization**
   ```javascript
   const notificationService = new NotificationService({
     defaultProvider: process.env.DEFAULT_EMAIL_PROVIDER,
     concurrency: parseInt(process.env.NOTIFICATION_CONCURRENCY) || 10
   });
   ```

3. **Queue Worker**
   ```bash
   # Start queue worker
   node workers/notificationWorker.js
   ```

### Docker Deployment

```dockerfile
FROM node:18-alpine

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV DEFAULT_EMAIL_PROVIDER=ses

# Start application
CMD ["node", "index.js"]
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: notification-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: notification-service
  template:
    metadata:
      labels:
        app: notification-service
    spec:
      containers:
      - name: notification-service
        image: substream/notification-service:latest
        env:
        - name: DEFAULT_EMAIL_PROVIDER
          value: "ses"
        - name: REDIS_HOST
          value: "redis-service"
```

## Troubleshooting

### Common Issues

1. **Email Not Sending**
   - Check provider configuration
   - Verify API keys and credentials
   - Check queue status and job details

2. **Rate Limit Errors**
   - Monitor rate limit headers
   - Adjust queue concurrency
   - Implement provider switching

3. **Queue Processing Issues**
   - Check Redis connection
   - Verify worker status
   - Monitor queue statistics

4. **Template Issues**
   - Validate template variables
   - Check template mappings
   - Verify provider template existence

### Debug Mode

Enable debug logging:

```bash
DEBUG=notification:* node index.js
```

### Log Analysis

```bash
# View notification logs
tail -f logs/notification.log

# Filter errors
grep "ERROR" logs/notification.log

# Monitor queue status
grep "queue" logs/notification.log
```

## Future Enhancements

1. **Advanced Templates**
   - Visual template editor
   - A/B testing support
   - Template versioning

2. **Multi-Channel Support**
   - SMS notifications
   - Push notifications
   - In-app notifications

3. **Advanced Analytics**
   - Open tracking
   - Click tracking
   - Engagement analytics

4. **Enhanced Security**
   - Email encryption
   - Advanced authentication
   - Compliance features

5. **Performance Features**
   - Distributed processing
   - Load balancing
   - Auto-scaling

This comprehensive email notification service provides enterprise-grade functionality with provider abstraction, reliable queue processing, and extensive customization options for all transactional email needs.
