const crypto = require('crypto');
const xml = require('xml');

class FeedService {
  constructor() {
    this.accessTokens = new Map();
    this.tokenRotationInterval = 24 * 60 * 60 * 1000; // 24 hours
  }

  generateAccessToken(userAddress) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + this.tokenRotationInterval;
    
    this.accessTokens.set(userAddress, {
      token,
      expiresAt,
      lastRotated: Date.now()
    });
    
    return token;
  }

  validateAccessToken(userAddress, token) {
    const tokenData = this.accessTokens.get(userAddress);
    if (!tokenData) return false;
    
    if (Date.now() > tokenData.expiresAt) {
      this.accessTokens.delete(userAddress);
      return false;
    }
    
    return tokenData.token === token;
  }

  rotateToken(userAddress) {
    const oldTokenData = this.accessTokens.get(userAddress);
    if (oldTokenData && Date.now() - oldTokenData.lastRotated < this.tokenRotationInterval) {
      return oldTokenData.token;
    }
    
    return this.generateAccessToken(userAddress);
  }

  async generateRSSFeed(userAddress, contentType = 'podcast') {
    const token = this.generateAccessToken(userAddress);
    const feedUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/feed/${userAddress}/${token}`;
    
    // Get user's authorized content based on their tier
    const authorizedContent = await this.getAuthorizedContent(userAddress);
    
    const feedItems = authorizedContent.map(content => ({
      title: content.title,
      description: content.description,
      url: `${process.env.BASE_URL || 'http://localhost:3000'}/content/${content.id}`,
      guid: content.id,
      pubDate: new Date(content.createdAt).toUTCString(),
      enclosure: contentType === 'podcast' ? {
        url: content.audioUrl,
        type: 'audio/mpeg',
        length: content.duration
      } : {
        url: content.videoUrl,
        type: 'video/mp4',
        length: content.fileSize
      }
    }));

    const rssXml = xml({
      rss: [
        { _attr: { version: '2.0', 'xmlns:atom': 'http://www.w3.org/2005/Atom' } },
        {
          channel: [
            { title: `AgreeStellar Feed - ${userAddress}` },
            { description: `Your personalized ${contentType} feed from AgreeStellar` },
            { link: feedUrl },
            { 'atom:link': { _attr: { href: feedUrl, rel: 'self', type: 'application/rss+xml' } } },
            { lastBuildDate: new Date().toUTCString() },
            { generator: 'AgreeStellar Feed Generator' },
            ...feedItems.map(item => ({
              item: [
                { title: item.title },
                { description: item.description },
                { link: item.url },
                { guid: { _attr: { isPermaLink: 'false' }, _content: item.guid } },
                { pubDate: item.pubDate },
                { enclosure: { _attr: item.enclosure } }
              ]
            }))
          ]
        }
      ]
    }, { declaration: true });

    return rssXml;
  }

  async generateAtomFeed(userAddress, contentType = 'podcast') {
    const token = this.generateAccessToken(userAddress);
    const feedUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/feed/${userAddress}/${token}`;
    
    const authorizedContent = await this.getAuthorizedContent(userAddress);
    
    const feedEntries = authorizedContent.map(content => ({
      title: content.title,
      content: content.description,
      id: `urn:uuid:${content.id}`,
      link: { _attr: { href: `${process.env.BASE_URL || 'http://localhost:3000'}/content/${content.id}` } },
      published: new Date(content.createdAt).toISOString(),
      updated: new Date(content.updatedAt || content.createdAt).toISOString()
    }));

    const atomXml = xml({
      feed: [
        { _attr: { xmlns: 'http://www.w3.org/2005/Atom' } },
        { title: `AgreeStellar Feed - ${userAddress}` },
        { subtitle: `Your personalized ${contentType} feed from AgreeStellar` },
        { link: { _attr: { href: feedUrl, rel: 'self', type: 'application/atom+xml' } } },
        { updated: new Date().toISOString() },
        { id: `urn:uuid:${userAddress}` },
        { generator: 'AgreeStellar Feed Generator' },
        ...feedEntries.map(entry => ({
          entry: [
            { title: entry.title },
            { content: { _attr: { type: 'text' }, _content: entry.content } },
            { id: entry.id },
            { link: entry.link },
            { published: entry.published },
            { updated: entry.updated }
          ]
        }))
      ]
    }, { declaration: true });

    return atomXml;
  }

  async getAuthorizedContent(userAddress) {
    // This would integrate with the existing content service
    // to get content based on user's subscription tier
    const contentService = require('./contentService');
    const userTier = await this.getUserTier(userAddress);
    
    // Mock data for now - in real implementation, this would query the database
    return [
      {
        id: 'content_001',
        title: 'Episode 1: Introduction to SubStream',
        description: 'Learn about the AgreeStellar and how it revolutionizes content creation',
        createdAt: '2024-01-15T10:00:00Z',
        updatedAt: '2024-01-15T10:00:00Z',
        audioUrl: 'https://example.com/audio/episode1.mp3',
        videoUrl: 'https://example.com/video/episode1.mp4',
        duration: 1800,
        fileSize: 50000000,
        requiredTier: userTier
      },
      {
        id: 'content_002',
        title: 'Episode 2: Advanced Features',
        description: 'Deep dive into advanced features of the AgreeStellar',
        createdAt: '2024-01-22T14:30:00Z',
        updatedAt: '2024-01-22T14:30:00Z',
        audioUrl: 'https://example.com/audio/episode2.mp3',
        videoUrl: 'https://example.com/video/episode2.mp4',
        duration: 2400,
        fileSize: 75000000,
        requiredTier: userTier
      }
    ];
  }

  async getUserTier(userAddress) {
    // This would integrate with the existing auth/user service
    // to determine the user's subscription tier
    return 'bronze'; // Default for demo
  }

  cleanupExpiredTokens() {
    const now = Date.now();
    for (const [userAddress, tokenData] of this.accessTokens.entries()) {
      if (now > tokenData.expiresAt) {
        this.accessTokens.delete(userAddress);
      }
    }
  }
}

module.exports = new FeedService();
