# Stripe-to-Substream Migration Guide

## Overview

The Stripe-to-Substream Migration Data Importer enables Web2 SaaS merchants to seamlessly migrate their existing customer base from Stripe to the AgreeStellar Web3 ecosystem. This feature dramatically lowers the barrier to entry for enterprise merchants wanting to transition from credit card payments to cryptocurrency subscriptions.

## Architecture

### Core Components

1. **StripeMigrationService** (`services/stripeMigrationService.js`)
   - CSV parsing and validation
   - Plan mapping logic
   - Migration link generation
   - Database operations

2. **Merchant API Routes** (`routes/merchants.js`)
   - File upload handling
   - Migration job management
   - Link verification and completion

3. **Migration Database Schema**
   - Migration jobs tracking
   - Customer migration records
   - Plan mappings storage

## API Endpoints

### Primary Migration Flow

#### 1. Import Stripe Data
```
POST /api/v1/merchants/import/stripe
Content-Type: multipart/form-data
Authorization: Bearer <JWT_TOKEN>

Form Data:
- csvFile: <STRIPE_EXPORT_CSV>
- planMappings: <JSON_STRING>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "uuid-1234",
    "summary": {
      "total": 1000,
      "processed": 950,
      "failed": 50
    },
    "message": "Stripe import processed successfully"
  }
}
```

#### 2. Get Migration Status
```
GET /api/v1/merchants/migration/{jobId}/status
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "uuid-1234",
    "status": "completed",
    "totalRecords": 1000,
    "processedRecords": 950,
    "failedRecords": 50,
    "createdAt": "2024-01-01T12:00:00.000Z",
    "completedAt": "2024-01-01T12:05:00.000Z",
    "records": [...]
  }
}
```

#### 3. Verify Migration Link
```
GET /api/v1/merchants/migration/verify?record=<ID>&email=<EMAIL>&ts=<TIMESTAMP>&sig=<SIGNATURE>
```

#### 4. Complete Migration
```
POST /api/v1/merchants/migration/complete
Content-Type: application/json

{
  "recordId": "uuid-5678",
  "stellarPublicKey": "GABC..."
}
```

### Plan Management

#### Save Plan Mappings
```
POST /api/v1/merchants/plan-mappings
Authorization: Bearer <JWT_TOKEN>

{
  "mappings": {
    "stripe_plan_basic": "creator123_basic",
    "stripe_plan_pro": "creator123_pro",
    "stripe_plan_enterprise": "creator123_enterprise"
  }
}
```

#### Get Plan Mappings
```
GET /api/v1/merchants/plan-mappings
Authorization: Bearer <JWT_TOKEN>
```

## Stripe CSV Export Format

### Supported Column Formats

The system is flexible and supports various Stripe export formats:

#### Standard Format
```
Customer Email,Subscription Plan,Renewal Date,Status
john.doe@example.com,premium_basic,2024-02-15,active
jane.smith@example.com,premium_pro,2024-02-20,active
```

#### Alternative Format
```
Email,Plan,Next Billing Date,Subscription Status
user1@test.com,plan_a,2024-02-15,active
user2@test.com,plan_b,2024-02-20,trialing
```

### Supported Columns

| Column Name | Variations | Required | Description |
|-------------|------------|----------|-------------|
| Customer Email | Email, customer_email, email | Yes | Customer's email address |
| Subscription Plan | Plan, Subscription Plan, plan, subscription_plan | Yes | Stripe plan ID |
| Renewal Date | Next Billing Date, renewal_date, next_billing_date | No | Next renewal date |
| Status | Subscription Status, status, subscription_status | No | Subscription status |

### Data Validation

- **Email Format**: Valid email addresses only
- **Status Filter**: Only processes 'active' and 'trialing' subscriptions
- **Missing Data**: Skips rows with missing required fields
- **Malformed Data**: Gracefully handles invalid formats

## Plan Mapping Configuration

### Mapping Structure

```json
{
  "stripe_plan_id_1": "substream_plan_id_1",
  "stripe_plan_id_2": "substream_plan_id_2",
  "stripe_plan_id_3": "substream_plan_id_3"
}
```

### Example Mappings

```json
{
  "price_1NQxZzZxZxZxZxZxZxZxZxZ": "creator123_basic_monthly",
  "price_2NQxZzZxZxZxZxZxZxZxZ": "creator123_pro_monthly",
  "price_3NQxZzZxZxZxZxZxZxZxZ": "creator123_enterprise_monthly"
}
```

### Finding Stripe Plan IDs

1. Go to Stripe Dashboard
2. Navigate to Products & Pricing
3. Click on a product
4. Copy the Price ID (starts with `price_`)
5. Map to your SubStream plan ID

## Migration Link System

### Link Generation

Migration links are cryptographically signed URLs that:
- Expire after 24 hours
- Contain customer email verification
- Include timestamp and signature
- Are single-use

### Link Structure
```
https://app.substream.app/migrate?record=<UUID>&email=<EMAIL>&ts=<TIMESTAMP>&sig=<SIGNATURE>
```

### User Flow

1. **Merchant**: Uploads CSV and gets migration links
2. **Customer**: Receives email with migration link
3. **Customer**: Clicks link and connects Stellar wallet
4. **System**: Links email to wallet and creates subscription

## Error Handling

### CSV Processing Errors

| Error Type | Handling |
|------------|----------|
| Invalid Email | Row skipped, logged |
| Missing Plan | Row skipped, logged |
| No Plan Mapping | Row marked as failed |
| Malformed Date | Date set to null |
| Invalid Status | Row skipped if not active/trialing |

### API Error Responses

```json
{
  "success": false,
  "error": "Error description"
}
```

### Common Error Codes

| Status Code | Description |
|-------------|-------------|
| 400 | Bad Request (invalid data, missing fields) |
| 401 | Unauthorized (no token) |
| 403 | Forbidden (invalid token, access denied) |
| 404 | Not Found (job not found) |
| 413 | Payload Too Large (file > 50MB) |
| 422 | Unprocessable Entity (invalid CSV) |
| 500 | Internal Server Error |

## Security Considerations

### Migration Link Security

- **HMAC Signatures**: Links signed with secret key
- **Timestamp Validation**: Links expire after 24 hours
- **Single Use**: Each link can only be used once
- **Email Verification**: Email embedded in signature

### Data Protection

- **File Cleanup**: Temporary files deleted after processing
- **Input Validation**: All inputs validated and sanitized
- **Rate Limiting**: API endpoints rate limited
- **Authentication**: All endpoints require valid JWT

### Best Practices

1. **Secure Secret**: Use strong `MIGRATION_SECRET` environment variable
2. **HTTPS Only**: Always use HTTPS in production
3. **Limited Uploads**: Set reasonable file size limits
4. **Audit Logging**: Log all migration activities
5. **Regular Cleanup**: Clean up old migration records

## Performance Considerations

### Large File Handling

- **Streaming Parser**: Processes files line by line
- **Memory Efficient**: Low memory footprint
- **Batch Processing**: Records processed in batches
- **Progress Tracking**: Real-time progress updates

### Database Optimization

- **Indexes**: Proper indexes on migration tables
- **Transactions**: Batch operations in transactions
- **Connection Pooling**: Efficient database connections
- **Cleanup Jobs**: Regular cleanup of old records

## Testing

### Unit Tests

```bash
# Run migration tests
npm test -- stripeMigration.test.js
```

### Test Coverage

- CSV parsing with various formats
- Plan mapping logic
- Migration link generation/verification
- Error handling scenarios
- API endpoint functionality

### Sample Test Data

```csv
Customer Email,Subscription Plan,Renewal Date,Status
test1@example.com,basic_plan,2024-02-15,active
test2@example.com,pro_plan,2024-02-20,trialing
test3@example.com,enterprise_plan,2024-02-25,active
```

## Monitoring and Analytics

### Migration Metrics

- **Total Jobs**: Number of migration jobs created
- **Success Rate**: Percentage of successful migrations
- **Processing Time**: Average time per migration
- **Error Rate**: Percentage of failed records

### Dashboard Integration

Migration data can be integrated into analytics dashboards:

```javascript
// Example: Get migration statistics
const stats = await migrationService.getMigrationStats(merchantId);
```

## Troubleshooting

### Common Issues

1. **CSV Parsing Fails**
   - Check file format (must be CSV)
   - Verify column headers
   - Ensure valid email formats

2. **Plan Mapping Errors**
   - Verify all Stripe plans have mappings
   - Check SubStream plan IDs exist
   - Validate mapping JSON format

3. **Migration Link Issues**
   - Check `MIGRATION_SECRET` environment variable
   - Verify timestamp is within 24 hours
   - Ensure URL encoding is correct

4. **Database Errors**
   - Check database connection
   - Verify table schemas
   - Check for constraint violations

### Debug Mode

Enable debug logging:
```bash
DEBUG=migration:* npm run dev
```

### Support

For issues related to:
- **Stripe Export**: https://stripe.com/docs/reports/csv-exports
- **Stellar Integration**: https://github.com/stellar/js-stellar-sdk
- **API Issues**: Create GitHub issue with logs

## Future Enhancements

1. **Advanced Mapping**: AI-powered plan mapping suggestions
2. **Bulk Operations**: Batch processing of multiple files
3. **Real-time Sync**: Real-time Stripe webhook integration
4. **Analytics Dashboard**: Built-in migration analytics
5. **Email Templates**: Customizable migration email templates
6. **Multi-tenant**: Support for multiple merchant accounts
7. **Webhook Support**: Automated migration completion webhooks

## Migration Checklist

### Pre-Migration

- [ ] Export customer data from Stripe
- [ ] Create SubStream plans
- [ ] Configure plan mappings
- [ ] Test with small sample
- [ ] Set up email templates

### Migration Process

- [ ] Upload CSV file
- [ ] Monitor processing status
- [ ] Send migration links to customers
- [ ] Track completion rates
- [ ] Handle support requests

### Post-Migration

- [ ] Verify all subscriptions created
- [ ] Update billing systems
- [ ] Cancel Stripe subscriptions
- [ ] Monitor customer satisfaction
- [ ] Analyze migration metrics

## Integration Examples

### Frontend Integration (React)

```javascript
// Upload CSV file
const uploadStripeCSV = async (file, planMappings) => {
  const formData = new FormData();
  formData.append('csvFile', file);
  formData.append('planMappings', JSON.stringify(planMappings));

  const response = await fetch('/api/v1/merchants/import/stripe', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  return response.json();
};

// Check migration status
const checkMigrationStatus = async (jobId) => {
  const response = await fetch(`/api/v1/merchants/migration/${jobId}/status`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  return response.json();
};
```

### Email Template Example

```html
<h1>Migrate to Web3 with SubStream</h1>
<p>Hi {{customerName}},</p>
<p>We're migrating to Web3! Click below to connect your wallet and continue your subscription:</p>
<a href="{{migrationLink}}">Connect Wallet</a>
<p>This link expires in 24 hours.</p>
```

This comprehensive migration system provides enterprise-grade functionality for seamless Web2 to Web3 migration, ensuring high success rates and excellent user experience.
