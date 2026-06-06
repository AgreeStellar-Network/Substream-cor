# ActivityPub Bridge for AgreeStellar

## Overview

The ActivityPub bridge enables AgreeStellar to interoperate with the Fediverse (Mastodon, Lemmy, PeerTube, etc.), ensuring SubStream is not a content silo. When creators post new content, announcements are automatically federated to their followers across the decentralized social web.

## Features

- **Automatic Content Federation**: New content announcements are sent to Fediverse followers
- **Teaser Generation**: Content previews with links back to SubStream-gated content
- **Creator Actor Profiles**: Each creator gets an ActivityPub actor representing them
- **Follower Management**: Handles follow/unfollow requests from Fediverse instances
- **Engagement Tracking**: Records likes, shares, and comments from the Fediverse
- **Background Processing**: Asynchronous federation queue with retry logic
- **Web3 Integration**: Links to Stellar blockchain accounts and SubStream profiles

## Architecture

### Core Components

1. **ActivityPubService** (`services/activityPubService.js`)
   - Core ActivityPub protocol implementation
   - Actor profile generation
   - Content announcement creation
   - HTTP signature handling

2. **FederationService** (`services/federationService.js`)
   - Queue management for federation
   - Creator initialization
   - Background job coordination

3. **FederationWorker** (`src/services/federationWorker.js`)
   - Background processing of federation queue
   - Retry logic and error handling
   - Queue statistics and cleanup

4. **ActivityPub Routes** (`routes/activityPub.js`)
   - WebFinger endpoint for actor discovery
   - Actor endpoints (inbox, outbox, followers)
   - NodeInfo for Fediverse discovery

### Database Schema

- `activitypub_actors`: Creator actor profiles and keys
- `activitypub_followers`: Fediverse followers tracking
- `activitypub_activities`: Sent federation activities
- `activitypub_engagements`: Received interactions
- `federation_queue`: Background processing queue

## Configuration

Add these environment variables to your `.env` file:

```bash
# ActivityPub Federation Configuration
ACTIVITYPUB_ENABLED=true
ACTIVITYPUB_BASE_URL=https://your-domain.com
ACTIVITYPUB_WORKER_INTERVAL=30000
ACTIVITYPUB_MAX_RETRIES=3
ACTIVITYPUB_SIGNING_SECRET=your-activitypub-signing-secret-key
```

### Environment Variables

- `ACTIVITYPUB_ENABLED`: Enable/disable federation (default: true)
- `ACTIVITYPUB_BASE_URL`: Base URL for ActivityPub endpoints
- `ACTIVITYPUB_WORKER_INTERVAL`: Queue processing interval in milliseconds (default: 30000)
- `ACTIVITYPUB_MAX_RETRIES`: Maximum retry attempts for failed federation (default: 3)
- `ACTIVITYPUB_SIGNING_SECRET`: Secret for deterministic key generation

## API Endpoints

### Fediverse Endpoints

- `GET /.well-known/webfinger` - WebFinger actor discovery
- `GET /.well-known/nodeinfo` - NodeInfo discovery
- `GET /nodeinfo/2.1` - NodeInfo schema
- `GET /ap/actor/:address` - Actor profile
- `POST /ap/actor/:address/inbox` - Actor inbox
- `GET /ap/actor/:address/outbox` - Actor outbox
- `GET /ap/actor/:address/followers` - Actor followers

### Management Endpoints

- `POST /ap/federate/:contentId` - Manual federation trigger

## Content Federation Flow

1. **Content Creation**: Creator posts new content via SubStream API
2. **Automatic Queuing**: Content is automatically queued for federation
3. **Background Processing**: Federation worker processes queue items
4. **Actor Generation**: Creator's ActivityPub actor is created/updated
5. **Announcement Creation**: ActivityPub announcement with teaser is generated
6. **Federation**: Announcement sent to all Fediverse followers
7. **Engagement Tracking**: Interactions are recorded for analytics

## Teaser Generation

Content announcements include:

- **Teaser Text**: First 200 characters of content description
- **Direct Link**: Link back to SubStream content page
- **Creator Attribution**: Link to creator's SubStream profile
- **Metadata**: Title, tags, thumbnail if available
- **Blockchain Links**: Reference to Stellar account

Example announcement format:
```html
<p>New video content available on AgreeStellar...</p>
<p><a href="https://substream.protocol/content/123" target="_blank">Watch full content on SubStream 🔗</a></p>
<p><small>Posted by <a href="https://substream.protocol/creator/GABC..." target="_blank">@creator_name</a> on AgreeStellar</small></p>
```

## Fediverse Compatibility

The implementation is compatible with:

- **Mastodon**: Full support for posts, follows, likes, shares
- **Lemmy**: Community posts and discussions
- **PeerTube**: Video content federation
- **Pleroma**: ActivityPub-compliant instances
- **Misskey**: Japanese Fediverse platform
- **Other ActivityPub instances**: Standard protocol compliance

## Security Considerations

- **HTTP Signatures**: All outgoing requests are signed with RSA keys
- **Deterministic Keys**: Creator keys are generated deterministically from wallet address
- **Private Key Storage**: RSA private keys stored securely in database
- **Signature Verification**: Incoming requests are verified before processing
- **Rate Limiting**: Federation endpoints respect existing rate limiting

## Monitoring and Analytics

### Federation Statistics

Track federation effectiveness via:

```javascript
const stats = await federationService.getFederationStats(creatorAddress);
// Returns: { total_activities, successful_activities, failed_activities, followers }
```

### Queue Monitoring

Monitor federation queue health:

```javascript
const queueStats = federationWorker.getQueueStats();
// Returns: { total, pending, processing, completed, failed }
```

### Engagement Analytics

Track Fediverse engagement:

```sql
-- Query engagement by type
SELECT 
  activity_type,
  COUNT(*) as count,
  activity_actor
FROM activitypub_engagements 
WHERE creator_address = ? 
GROUP BY activity_type, activity_actor;
```

## Troubleshooting

### Common Issues

1. **Federation Not Working**
   - Check `ACTIVITYPUB_ENABLED=true` in environment
   - Verify `ACTIVITYPUB_BASE_URL` is correct
   - Check federation worker is running

2. **Missing Actor Profiles**
   - Run database migration: `npm run migrate`
   - Initialize creator: `federationService.initializeCreator(address)`

3. **Failed Federation**
   - Check federation queue: `federationWorker.getQueueStats()`
   - Review error logs for specific failures
   - Verify target instance accessibility

4. **Signature Verification Failures**
   - Check `ACTIVITYPUB_SIGNING_SECRET` is set
   - Verify deterministic key generation
   - Check clock synchronization

### Debug Mode

Enable debug logging:

```bash
DEBUG=activitypub:* npm start
```

## Testing

### Unit Tests

```bash
npm test -- --testPathPattern=activitypub
```

### Integration Tests

```bash
npm run test:integration -- activitypub
```

### Manual Testing

1. **Test WebFinger Discovery**
   ```bash
   curl "https://your-domain.com/.well-known/webfinger?resource=acct:creator_GABC...@your-domain.com"
   ```

2. **Test Actor Profile**
   ```bash
   curl "https://your-domain.com/ap/actor/GABC..."
   ```

3. **Test Manual Federation**
   ```bash
   curl -X POST "https://your-domain.com/ap/federate/content123"
   ```

## Migration Guide

### From Previous Version

1. Run database migration:
   ```bash
   npm run migrate
   ```

2. Update environment variables:
   ```bash
   # Add new ActivityPub variables
   ACTIVITYPUB_ENABLED=true
   ACTIVITYPUB_BASE_URL=https://your-domain.com
   ```

3. Restart application:
   ```bash
   npm restart
   ```

### Existing Content

Existing content is not automatically federated. To federate existing content:

```javascript
// For each content item
await federationService.queueContentForFederation(content);
```

## Performance Considerations

- **Queue Processing**: Default 30-second intervals, adjust based on volume
- **Batch Size**: Processes 10 items per queue run
- **Retry Logic**: Exponential backoff with 5-minute maximum delay
- **Database Indexing**: Optimized indexes on frequently queried fields
- **Memory Usage**: Federation worker uses minimal memory

## Future Enhancements

Planned improvements:

1. **Enhanced Content Types**: Support for more content formats
2. **Community Federation**: Lemmy community integration
3. **Threaded Comments**: Fediverse comment threading
4. **Rich Media**: Audio, images, and mixed content
5. **Analytics Dashboard**: Built-in federation analytics
6. **OAuth2 Integration**: Third-party app access
7. **Content Warnings**: Sensitive content handling
8. **Custom Emojis**: Platform-specific emoji support

## Contributing

When contributing to the ActivityPub bridge:

1. Follow ActivityPub specification (W3C Recommendation)
2. Test with multiple Fediverse platforms
3. Ensure backward compatibility
4. Add comprehensive tests
5. Update documentation

## Resources

- [ActivityPub W3C Specification](https://www.w3.org/TR/activitypub/)
- [Fediverse Documentation](https://fediverse.party/)
- [Mastodon API Documentation](https://docs.joinmastodon.org/)
- [WebFinger RFC 7033](https://tools.ietf.org/html/rfc7033)
- [NodeInfo Protocol](https://nodeinfo.diaspora.software/)

## Support

For ActivityPub bridge issues:

1. Check existing GitHub issues
2. Review troubleshooting section
3. Enable debug logging
4. Provide federation logs
5. Include target instance details

---

This ActivityPub bridge transforms SubStream into a truly interoperable Web3-social platform, enabling creators to reach audiences across the entire Fediverse while maintaining their monetization layer on Stellar.
