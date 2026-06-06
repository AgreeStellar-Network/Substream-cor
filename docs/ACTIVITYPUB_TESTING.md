# ActivityPub Federation Test Suite

## Test Environment Setup

Before running ActivityPub tests, ensure:

1. Database migrations are run:
```bash
npm run migrate
```

2. ActivityPub configuration is set:
```bash
ACTIVITYPUB_ENABLED=true
ACTIVITYPUB_BASE_URL=http://localhost:3000
```

3. Test database is available:
```bash
DATABASE_FILENAME=./test/test-activitypub.sqlite
```

## Manual Testing Guide

### 1. WebFinger Discovery Test

Test WebFinger endpoint for actor discovery:

```bash
# Replace GABC... with actual creator address
curl "http://localhost:3000/.well-known/webfinger?resource=acct:creator_GABCDEF123456789@localhost"
```

Expected response:
```json
{
  "subject": "acct:creator_GABCDEF12@localhost",
  "aliases": ["http://localhost:3000/ap/actor/GABCDEF123456789"],
  "links": [
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "http://localhost:3000/ap/actor/GABCDEF123456789"
    }
  ]
}
```

### 2. Actor Profile Test

Test ActivityPub actor endpoint:

```bash
curl -H "Accept: application/activity+json" "http://localhost:3000/ap/actor/GABCDEF123456789"
```

Expected response:
```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    "https://w3id.org/security/v1"
  ],
  "id": "http://localhost:3000/ap/actor/GABCDEF123456789",
  "type": "Person",
  "preferredUsername": "creator_GABCDEF12",
  "name": "Creator Name",
  "summary": "Content creator on AgreeStellar",
  "inbox": "http://localhost:3000/ap/actor/GABCDEF123456789/inbox",
  "outbox": "http://localhost:3000/ap/actor/GABCDEF123456789/outbox",
  "followers": "http://localhost:3000/ap/actor/GABCDEF123456789/followers"
}
```

### 3. NodeInfo Test

Test NodeInfo endpoint for Fediverse discovery:

```bash
curl "http://localhost:3000/.well-known/nodeinfo"
```

Expected response:
```json
{
  "links": [
    {
      "rel": "http://nodeinfo.diaspora.software/ns/schema/2.1",
      "href": "http://localhost:3000/nodeinfo/2.1"
    }
  ]
}
```

### 4. Content Federation Test

Test manual content federation:

```bash
# First create content via API
curl -X POST "http://localhost:3000/api/content" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Video",
    "description": "This is a test video for ActivityPub federation",
    "federate": true
  }'

# Then manually trigger federation
curl -X POST "http://localhost:3000/ap/federate/content123"
```

### 5. Follow/Unfollow Test

Test follow handling (requires ActivityPub signature):

```bash
# This requires proper HTTP signature, use Mastodon or other Fediverse client
# to test actual follow functionality
```

## Automated Tests

### Unit Tests

```bash
npm test -- --testPathPattern=activitypub
```

### Integration Tests

```bash
npm run test:integration -- activitypub
```

## Test Data Setup

### Create Test Creator

```sql
INSERT INTO creators (
  id, address, name, bio, created_at
) VALUES (
  'test-creator-1',
  'GABCDEF1234567890123456789012345678901234',
  'Test Creator',
  'A test creator for ActivityPub federation',
  '2024-01-01T00:00:00.000Z'
);
```

### Create Test Content

```sql
INSERT INTO content (
  id, creator_address, title, description, type, tags, created_at
) VALUES (
  'test-content-1',
  'GABCDEF1234567890123456789012345678901234',
  'Test Video',
  'This is a test video for ActivityPub federation testing',
  'video',
  '["test", "activitypub", "substream"]',
  '2024-01-01T12:00:00.000Z'
);
```

## Federation Queue Testing

### Check Queue Status

```javascript
// In Node.js console
const federationWorker = app.get('federationWorker');
console.log(federationWorker.getQueueStats());
```

### Process Queue Manually

```javascript
// Process specific queue item
await federationWorker.processJob(queueId);

// Process entire queue
await federationService.processFederationQueue();
```

## Mastodon Testing

### Setup Test Mastodon Instance

1. Use a test Mastodon instance (mastodon.social, fosstodon.org, etc.)
2. Create test account
3. Follow SubStream creator: `@creator_GABCDEF12@your-domain.com`

### Verify Federation

1. Check Mastodon timeline for SubStream posts
2. Verify post content includes teaser and link
3. Test interactions (like, boost, reply)

## Lemmy Testing

### Setup Test Lemmy Community

1. Use test Lemmy instance (lemmy.ml, beehaw.org, etc.)
2. Create test community
3. Share SubStream content to community

### Verify Federation

1. Check community posts for SubStream content
2. Verify content formatting
3. Test comments and voting

## Error Scenarios Testing

### Test Failed Federation

1. Create content with invalid data
2. Verify queue item marked as failed
3. Check retry logic

### Test Signature Verification

1. Send unsigned request to inbox
2. Verify 401 Unauthorized response
3. Send properly signed request

### Test Rate Limiting

1. Send rapid requests to federation endpoints
2. Verify rate limiting is applied
3. Check 429 Too Many Requests responses

## Performance Testing

### Load Testing

```bash
# Use Apache Bench or similar tool
ab -n 1000 -c 10 "http://localhost:3000/ap/actor/test-address"
```

### Queue Performance

```javascript
// Add many items to queue
for (let i = 0; i < 1000; i++) {
  await federationService.queueContentForFederation(testContent);
}

// Measure processing time
const start = Date.now();
await federationService.processFederationQueue();
console.log(`Processed in ${Date.now() - start}ms`);
```

## Monitoring During Tests

### Log Analysis

```bash
# Monitor ActivityPub logs
tail -f logs/app.log | grep "activitypub\|federation"

# Check for errors
grep -i "error.*activitypub" logs/app.log
```

### Database Monitoring

```sql
-- Check queue size
SELECT status, COUNT(*) as count 
FROM federation_queue 
GROUP BY status;

-- Check federation success rate
SELECT 
  COUNT(*) as total,
  COUNT(CASE WHEN status = 'sent' THEN 1 END) as successful,
  COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
FROM activitypub_activities;
```

## Troubleshooting Test Issues

### Common Problems

1. **Database Migration Issues**
   ```bash
   npm run migrate:rollback
   npm run migrate
   ```

2. **Configuration Issues**
   ```bash
   # Verify environment variables
   echo $ACTIVITYPUB_ENABLED
   echo $ACTIVITYPUB_BASE_URL
   ```

3. **Port Conflicts**
   ```bash
   # Check if port 3000 is in use
   lsof -i :3000
   ```

4. **Missing Dependencies**
   ```bash
   npm install
   npm audit fix
   ```

## Test Checklist

- [ ] WebFinger endpoint returns correct actor info
- [ ] Actor profile includes all required fields
- [ ] NodeInfo endpoints work correctly
- [ ] Content creation triggers federation
- [ ] Federation queue processes items
- [ ] Failed items are retried appropriately
- [ ] HTTP signatures are verified
- [ ] Rate limiting is enforced
- [ ] Database schema is correct
- [ ] Background worker runs continuously
- [ ] Mastodon federation works
- [ ] Lemmy federation works
- [ ] Error handling is robust
- [ ] Performance is acceptable

## Test Reports

Document test results in:

- `test-results/activitypub-unit.json`
- `test-results/activitypub-integration.json`
- `test-results/federation-performance.json`

Include metrics:
- Success/failure rates
- Processing times
- Queue sizes
- Error frequencies
