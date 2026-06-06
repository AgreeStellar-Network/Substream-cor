const crypto = require('crypto');
const { logger } = require('../utils/logger');

/**
 * ActivityPub Service for SubStream-Fediverse interoperability
 * Handles federation of content announcements to Mastodon, Lemmy, etc.
 */
class ActivityPubService {
  constructor(config, database) {
    this.config = config;
    this.database = database;
    this.baseUrl = config.activityPub?.baseUrl || process.env.ACTIVITYPUB_BASE_URL || 'https://substream.protocol';
    this.domain = new URL(this.baseUrl).hostname;
  }

  /**
   * Generate a unique ActivityPub actor ID for a creator
   */
  generateActorId(creatorAddress) {
    return `${this.baseUrl}/ap/actor/${creatorAddress}`;
  }

  /**
   * Generate ActivityPub actor profile for a creator
   */
  generateActorProfile(creator) {
    const actorId = this.generateActorId(creator.address);
    const publicKeyId = `${actorId}#main-key`;

    return {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://w3id.org/security/v1'
      ],
      id: actorId,
      type: 'Person',
      preferredUsername: `creator_${creator.address.slice(0, 8)}`,
      name: creator.name || `Creator ${creator.address.slice(0, 8)}`,
      summary: creator.bio || `Content creator on AgreeStellar - Web3 video platform`,
      inbox: `${actorId}/inbox`,
      outbox: `${actorId}/outbox`,
      followers: `${actorId}/followers`,
      following: `${actorId}/following`,
      url: this.baseUrl,
      publicKey: {
        id: publicKeyId,
        owner: actorId,
        publicKeyPem: this.getCreatorPublicKey(creator.address)
      },
      icon: creator.avatar ? {
        type: 'Image',
        url: creator.avatar
      } : undefined,
      image: creator.banner ? {
        type: 'Image',
        url: creator.banner
      } : undefined,
      attachment: [
        {
          type: 'PropertyValue',
          name: 'SubStream Profile',
          value: `<a href="${this.baseUrl}/creator/${creator.address}" target="_blank" rel="nofollow noopener noreferrer">View on SubStream</a>`
        },
        {
          type: 'PropertyValue',
          name: 'Blockchain',
          value: `<a href="https://stellar.expert/explorer/public/account/${creator.address}" target="_blank" rel="nofollow noopener noreferrer">Stellar Account</a>`
        }
      ]
    };
  }

  /**
   * Get or generate RSA key pair for creator
   */
  getCreatorKeyPair(creatorAddress) {
    // In production, these should be stored securely in database
    // For now, generate deterministic keys based on creator address
    const seed = crypto.createHash('sha256').update(creatorAddress + this.config.secret).digest();
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    
    return { publicKey, privateKey };
  }

  /**
   * Get public key for ActivityPub actor
   */
  getCreatorPublicKey(creatorAddress) {
    const { publicKey } = this.getCreatorKeyPair(creatorAddress);
    return publicKey;
  }

  /**
   * Create ActivityPub announcement for new content
   */
  createContentAnnouncement(creator, content) {
    const actorId = this.generateActorId(creator.address);
    const contentUrl = `${this.baseUrl}/content/${content.id}`;
    
    // Generate teaser text (first 200 characters of content)
    const teaser = content.description 
      ? content.description.slice(0, 200) + (content.description.length > 200 ? '...' : '')
      : `New content available on AgreeStellar`;

    const announcement = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${this.baseUrl}/ap/announce/${content.id}`,
      type: 'Announce',
      actor: actorId,
      object: {
        id: `${this.baseUrl}/ap/note/${content.id}`,
        type: 'Note',
        attributedTo: actorId,
        content: this.buildAnnouncementContent(creator, content, teaser),
        name: content.title || 'New Content',
        summary: teaser,
        url: contentUrl,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        cc: [`${actorId}/followers`],
        attachment: content.thumbnail ? [{
          type: 'Image',
          url: content.thumbnail,
          name: content.title || 'Content thumbnail'
        }] : [],
        tag: this.generateContentTags(content)
      },
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      cc: [`${actorId}/followers`],
      published: new Date(content.created_at || Date.now()).toISOString()
    };

    return announcement;
  }

  /**
   * Build announcement content with link back to SubStream
   */
  buildAnnouncementContent(creator, content, teaser) {
    const contentUrl = `${this.baseUrl}/content/${content.id}`;
    const creatorUrl = `${this.baseUrl}/creator/${creator.address}`;
    
    return `<p>${teaser}</p>
<p><a href="${contentUrl}" target="_blank" rel="nofollow noopener noreferrer">Watch full content on SubStream 🔗</a></p>
<p><small>Posted by <a href="${creatorUrl}" target="_blank" rel="nofollow noopener noreferrer">@${creator.name || creator.address.slice(0, 8)}</a> on AgreeStellar</small></p>`;
  }

  /**
   * Generate relevant tags for content
   */
  generateContentTags(content) {
    const tags = [];
    
    // Add content type tags
    if (content.type) {
      tags.push({
        type: 'Hashtag',
        name: `#${content.type}`,
        href: `${this.baseUrl}/tag/${content.type}`
      });
    }

    // Add custom tags if present
    if (content.tags && Array.isArray(content.tags)) {
      content.tags.forEach(tag => {
        tags.push({
          type: 'Hashtag',
          name: `#${tag}`,
          href: `${this.baseUrl}/tag/${tag}`
        });
      });
    }

    // Add platform tags
    tags.push(
      {
        type: 'Hashtag',
        name: '#SubStream',
        href: `${this.baseUrl}/tag/SubStream`
      },
      {
        type: 'Hashtag',
        name: '#Web3',
        href: `${this.baseUrl}/tag/Web3`
      }
    );

    return tags;
  }

  /**
   * Sign HTTP request for ActivityPub federation
   */
  async signRequest(request, creatorAddress) {
    const { privateKey } = this.getCreatorKeyPair(creatorAddress);
    const keyId = `${this.generateActorId(creatorAddress)}#main-key`;
    
    // Create signature string
    const date = new Date().toUTCString();
    const method = request.method;
    const path = new URL(request.url).pathname + new URL(request.url).search;
    
    const signingString = `(request-target): ${method.toLowerCase()} ${path}\nhost: ${this.domain}\ndate: ${date}`;
    
    // Generate signature
    const signature = crypto.createSign('rsa-sha256')
      .update(signingString)
      .sign(privateKey, 'base64');
    
    // Add headers to request
    request.headers.set('Date', date);
    request.headers.set('Host', this.domain);
    request.headers.set('Signature', `keyId="${keyId}",headers="(request-target) host date",signature="${signature}"`);
    
    return request;
  }

  /**
   * Send activity to remote inbox
   */
  async sendToInbox(activity, inboxUrl, creatorAddress) {
    try {
      logger.info('Sending ActivityPub activity', { 
        activityId: activity.id, 
        inboxUrl, 
        creatorAddress 
      });

      const response = await fetch(inboxUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/activity+json',
          'Accept': 'application/activity+json, application/ld+json'
        },
        body: JSON.stringify(activity)
      });

      // Sign the request
      const signedRequest = await this.signRequest({
        method: 'POST',
        url: inboxUrl,
        headers: new Headers({
          'Content-Type': 'application/activity+json',
          'Accept': 'application/activity+json, application/ld+json'
        })
      }, creatorAddress);

      if (!response.ok) {
        throw new Error(`Failed to send to inbox: ${response.status} ${response.statusText}`);
      }

      logger.info('ActivityPub activity sent successfully', { 
        activityId: activity.id, 
        inboxUrl 
      });

      return await response.json();
    } catch (error) {
      logger.error('Failed to send ActivityPub activity', { 
        error: error.message, 
        activityId: activity.id, 
        inboxUrl 
      });
      throw error;
    }
  }

  /**
   * Get creator's followers list
   */
  async getFollowers(creatorAddress) {
    try {
      // This would query the database for followers
      // For now, return empty array
      return [];
    } catch (error) {
      logger.error('Failed to get followers', { error: error.message, creatorAddress });
      return [];
    }
  }

  /**
   * Federate content announcement to followers
   */
  async federateContent(creator, content) {
    try {
      const announcement = this.createContentAnnouncement(creator, content);
      const followers = await this.getFollowers(creator.address);
      
      // Send to follower inboxes
      const federationPromises = followers.map(async (follower) => {
        if (follower.inbox) {
          return this.sendToInbox(announcement, follower.inbox, creator.address);
        }
      });

      // Also send to shared inboxes if available
      const sharedInboxes = [...new Set(followers.map(f => f.sharedInbox).filter(Boolean))];
      sharedInboxes.forEach(inbox => {
        federationPromises.push(this.sendToInbox(announcement, inbox, creator.address));
      });

      const results = await Promise.allSettled(federationPromises);
      
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      logger.info('Content federation completed', {
        contentId: content.id,
        creatorAddress: creator.address,
        successful,
        failed,
        totalFollowers: followers.length
      });

      return { successful, failed, total: followers.length };
    } catch (error) {
      logger.error('Failed to federate content', { 
        error: error.message, 
        contentId: content.id, 
        creatorAddress: creator.address 
      });
      throw error;
    }
  }

  /**
   * Verify ActivityPub signature
   */
  async verifySignature(request) {
    try {
      const signature = request.headers.get('Signature');
      if (!signature) {
        throw new Error('Missing signature header');
      }

      // Parse signature header
      const params = signature.split(',').reduce((acc, part) => {
        const [key, value] = part.split('=');
        acc[key] = value.replace(/"/g, '');
        return acc;
      }, {});

      // Get public key from keyId
      const keyId = params.keyId;
      const publicKey = await this.getPublicKeyFromKeyId(keyId);
      
      if (!publicKey) {
        throw new Error('Public key not found');
      }

      // Verify signature
      const verification = crypto.createVerify('rsa-sha256');
      verification.update(this.buildSigningString(request, params.headers));
      
      return verification.verify(publicKey, params.signature, 'base64');
    } catch (error) {
      logger.error('Signature verification failed', { error: error.message });
      return false;
    }
  }

  /**
   * Get public key from keyId
   */
  async getPublicKeyFromKeyId(keyId) {
    try {
      // Extract creator address from keyId
      const match = keyId.match(/\/actor\/([^#]+)/);
      if (!match) {
        throw new Error('Invalid keyId format');
      }
      
      const creatorAddress = match[1];
      return this.getCreatorPublicKey(creatorAddress);
    } catch (error) {
      logger.error('Failed to get public key from keyId', { error: error.message, keyId });
      return null;
    }
  }

  /**
   * Build signing string for verification
   */
  buildSigningString(request, headers) {
    const parts = headers.split(' ').map(header => {
      const value = request.headers.get(header.toLowerCase());
      return `${header.toLowerCase()}: ${value}`;
    });
    
    return parts.join('\n');
  }
}

module.exports = ActivityPubService;
