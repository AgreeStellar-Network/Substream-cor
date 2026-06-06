const express = require('express');
const router = express.Router();
const ActivityPubService = require('../services/activityPubService');
const { logger } = require('../utils/logger');

/**
 * ActivityPub routes for Fediverse interoperability
 * Provides WebFinger, actor endpoints, inbox/outbox, and content federation
 */

// Middleware to parse ActivityPub content types
router.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT') {
    const contentType = req.headers['content-type'];
    if (contentType && (contentType.includes('activity+json') || contentType.includes('ld+json'))) {
      express.json()(req, res, next);
      return;
    }
  }
  next();
});

/**
 * WebFinger endpoint for actor discovery
 * GET /.well-known/webfinger?resource=acct:username@domain
 */
router.get('/.well-known/webfinger', async (req, res) => {
  try {
    const { resource } = req.query;
    
    if (!resource || !resource.startsWith('acct:')) {
      return res.status(400).json({
        error: 'Invalid resource parameter. Expected: acct:username@domain'
      });
    }

    // Extract creator address from resource
    const [, address] = resource.split(':')[1].split('@');
    if (!address) {
      return res.status(400).json({
        error: 'Invalid resource format'
      });
    }

    // Get creator from database
    const creator = req.database.getCreator(address);
    if (!creator) {
      return res.status(404).json({
        error: 'Creator not found'
      });
    }

    const activityPubService = new ActivityPubService(req.config, req.database);
    const actorId = activityPubService.generateActorId(address);

    const webFingerResponse = {
      subject: `acct:creator_${address.slice(0, 8)}@${activityPubService.domain}`,
      aliases: [actorId],
      links: [
        {
          rel: 'self',
          type: 'application/activity+json',
          href: actorId
        },
        {
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
          href: `${req.config.frontend?.baseUrl || 'https://substream.protocol'}/creator/${address}`
        }
      ]
    };

    res.set('Content-Type', 'application/jrd+json');
    res.json(webFingerResponse);

  } catch (error) {
    logger.error('WebFinger error', { error: error.message, resource: req.query.resource });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Actor endpoint
 * GET /ap/actor/:address
 */
router.get('/ap/actor/:address', async (req, res) => {
  try {
    const { address } = req.params;
    
    // Get creator from database
    const creator = req.database.getCreator(address);
    if (!creator) {
      return res.status(404).json({
        error: 'Creator not found'
      });
    }

    const activityPubService = new ActivityPubService(req.config, req.database);
    const actorProfile = activityPubService.generateActorProfile(creator);

    res.set('Content-Type', 'application/activity+json');
    res.json(actorProfile);

  } catch (error) {
    logger.error('Actor endpoint error', { error: error.message, address: req.params.address });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Actor inbox endpoint
 * POST /ap/actor/:address/inbox
 */
router.post('/ap/actor/:address/inbox', async (req, res) => {
  try {
    const { address } = req.params;
    const activity = req.body;

    // Verify signature
    const activityPubService = new ActivityPubService(req.config, req.database);
    const isValid = await activityPubService.verifySignature(req);
    
    if (!isValid) {
      return res.status(401).json({
        error: 'Invalid signature'
      });
    }

    // Get creator
    const creator = req.database.getCreator(address);
    if (!creator) {
      return res.status(404).json({
        error: 'Creator not found'
      });
    }

    // Process incoming activity
    await handleIncomingActivity(activity, creator, req.database, activityPubService);

    res.status(200).json({ success: true });

  } catch (error) {
    logger.error('Inbox error', { error: error.message, address: req.params.address });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Actor outbox endpoint
 * GET /ap/actor/:address/outbox
 */
router.get('/ap/actor/:address/outbox', async (req, res) => {
  try {
    const { address } = req.params;
    const { page } = req.query;
    
    // Get creator from database
    const creator = req.database.getCreator(address);
    if (!creator) {
      return res.status(404).json({
        error: 'Creator not found'
      });
    }

    const activityPubService = new ActivityPubService(req.config, req.database);
    const actorId = activityPubService.generateActorId(address);

    if (page) {
      // Return paginated items
      const items = await getOutboxItems(address, req.database, page);
      res.set('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actorId}/outbox?page=${page}`,
        type: 'OrderedCollectionPage',
        partOf: `${actorId}/outbox`,
        orderedItems: items
      });
    } else {
      // Return collection info
      const totalItems = await getOutboxItemCount(address, req.database);
      res.set('Content-Type', 'application/activity+json');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${actorId}/outbox`,
        type: 'OrderedCollection',
        totalItems,
        first: `${actorId}/outbox?page=1`
      });
    }

  } catch (error) {
    logger.error('Outbox error', { error: error.message, address: req.params.address });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Followers endpoint
 * GET /ap/actor/:address/followers
 */
router.get('/ap/actor/:address/followers', async (req, res) => {
  try {
    const { address } = req.params;
    
    // Get creator from database
    const creator = req.database.getCreator(address);
    if (!creator) {
      return res.status(404).json({
        error: 'Creator not found'
      });
    }

    const activityPubService = new ActivityPubService(req.config, req.database);
    const actorId = activityPubService.generateActorId(address);
    const followers = await activityPubService.getFollowers(address);

    res.set('Content-Type', 'application/activity+json');
    res.json({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${actorId}/followers`,
      type: 'OrderedCollection',
      totalItems: followers.length,
      items: followers
    });

  } catch (error) {
    logger.error('Followers error', { error: error.message, address: req.params.address });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Manual federation trigger endpoint
 * POST /ap/federate/:contentId
 */
router.post('/ap/federate/:contentId', async (req, res) => {
  try {
    const { contentId } = req.params;
    
    // Get content from database
    const content = req.database.getContent(contentId);
    if (!content) {
      return res.status(404).json({
        error: 'Content not found'
      });
    }

    // Get creator
    const creator = req.database.getCreator(content.creator_address);
    if (!creator) {
      return res.status(404).json({
        error: 'Creator not found'
      });
    }

    const activityPubService = new ActivityPubService(req.config, req.database);
    const result = await activityPubService.federateContent(creator, content);

    res.json({
      success: true,
      result
    });

  } catch (error) {
    logger.error('Federation trigger error', { error: error.message, contentId: req.params.contentId });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * NodeInfo endpoint for Fediverse discovery
 * GET /.well-known/nodeinfo
 */
router.get('/.well-known/nodeinfo', (req, res) => {
  const baseUrl = req.config.activityPub?.baseUrl || process.env.ACTIVITYPUB_BASE_URL || 'https://substream.protocol';
  
  res.json({
    links: [
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
        href: `${baseUrl}/nodeinfo/2.1`
      }
    ]
  });
});

/**
 * NodeInfo schema endpoint
 * GET /nodeinfo/2.1
 */
router.get('/nodeinfo/2.1', (req, res) => {
  const baseUrl = req.config.activityPub?.baseUrl || process.env.ACTIVITYPUB_BASE_URL || 'https://substream.protocol';
  
  res.set('Content-Type', 'application/json; profile=http://nodeinfo.diaspora.software/ns/schema/2.1#');
  res.json({
    version: '2.1',
    software: {
      name: 'substream-cor',
      version: '1.0.0',
      repository: 'https://github.com/AgreeStellar-Network/Substream-cor'
    },
    protocols: ['activitypub'],
    services: {
      outbound: ['atom1.0'],
      inbound: ['atom1.0']
    },
    openRegistrations: false,
    usage: {
      users: {
        total: 0, // Would be calculated from database
        activeMonth: 0,
        activeHalfyear: 0
      },
      localPosts: 0, // Would be calculated from database
      localComments: 0
    },
    metadata: {
      nodeName: 'AgreeStellar',
      nodeDescription: 'Web3 video streaming platform with ActivityPub federation',
      maintainer: {
        name: 'SubStream Team',
        email: 'team@substream.protocol'
      }
    }
  });
});

/**
 * Handle incoming ActivityPub activities
 */
async function handleIncomingActivity(activity, creator, database, activityPubService) {
  logger.info('Processing incoming ActivityPub activity', {
    type: activity.type,
    actor: activity.actor,
    target: creator.address
  });

  switch (activity.type) {
    case 'Follow':
      await handleFollow(activity, creator, database);
      break;
    case 'Undo':
      if (activity.object?.type === 'Follow') {
        await handleUnfollow(activity, creator, database);
      }
      break;
    case 'Like':
    case 'Announce':
      await handleEngagement(activity, creator, database);
      break;
    default:
      logger.info('Unhandled activity type', { type: activity.type });
  }
}

/**
 * Handle Follow activity
 */
async function handleFollow(activity, creator, database) {
  try {
    // Store follower in database
    database.addFollower({
      creator_address: creator.address,
      follower_actor: activity.actor,
      follower_inbox: activity.inbox,
      follow_activity_id: activity.id,
      created_at: new Date().toISOString()
    });

    // Send Accept activity back
    const acceptActivity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${activityPubService.generateActorId(creator.address)}/accept/${activity.id}`,
      type: 'Accept',
      actor: activityPubService.generateActorId(creator.address),
      object: activity
    };

    // Send to follower's inbox
    await activityPubService.sendToInbox(acceptActivity, activity.inbox, creator.address);

    logger.info('Follow accepted', { 
      follower: activity.actor, 
      creator: creator.address 
    });

  } catch (error) {
    logger.error('Failed to handle follow', { error: error.message });
  }
}

/**
 * Handle Unfollow activity
 */
async function handleUnfollow(activity, creator, database) {
  try {
    // Remove follower from database
    database.removeFollower({
      creator_address: creator.address,
      follower_actor: activity.object.actor
    });

    logger.info('Unfollow processed', { 
      follower: activity.object.actor, 
      creator: creator.address 
    });

  } catch (error) {
    logger.error('Failed to handle unfollow', { error: error.message });
  }
}

/**
 * Handle engagement activities (Like, Announce, etc.)
 */
async function handleEngagement(activity, creator, database) {
  try {
    // Store engagement in database for analytics
    database.addEngagement({
      creator_address: creator.address,
      activity_type: activity.type,
      activity_actor: activity.actor,
      activity_object: activity.object,
      created_at: new Date().toISOString()
    });

    logger.info('Engagement recorded', { 
      type: activity.type, 
      actor: activity.actor, 
      creator: creator.address 
    });

  } catch (error) {
    logger.error('Failed to handle engagement', { error: error.message });
  }
}

/**
 * Get outbox items for pagination
 */
async function getOutboxItems(address, database, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  return database.getCreatorContent(address, { limit, offset });
}

/**
 * Get total outbox item count
 */
async function getOutboxItemCount(address, database) {
  return database.getCreatorContentCount(address);
}

module.exports = router;
