/**
 * Example Service Implementations with Tracing
 * Demonstrates how to integrate distributed tracing into real services
 */

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const {
  createModuleTracer,
  createDbSpan,
  createHttpSpan,
  createBlockchainSpan
} = require('../utils/tracingUtils');
const {
  setupAxiosTracing,
  MultiFormatPropagator,
  getContextHeaders
} = require('../utils/traceContextPropagation');
const {
  createAuthTracing,
  createDatabaseTracing,
  createHttpClientTracing
} = require('../utils/serviceInstrumentation');

// ============================================================================
// EXAMPLE 1: Auth Service with Tracing
// ============================================================================

class AuthServiceWithTracing {
  constructor(db, redis, logger) {
    this.db = db;
    this.redis = redis;
    this.logger = logger;
    this.tracer = createModuleTracer('auth-service');
    this.authTracing = createAuthTracing();
    this.dbTracing = createDatabaseTracing();
  }

  /**
   * Login with SIWE signature verification
   */
  async loginWithSignature(address, signature, message, nonce) {
    const rootSpan = this.tracer.startSpan('auth.login_with_signature', {
      attributes: {
        'user.address': address,
        'auth.method': 'SIWE'
      }
    });

    try {
      // Step 1: Verify nonce
      const nonceSpan = this.tracer.startSpan('auth.verify_nonce');
      const storedNonce = await this.redis.get(`nonce:${address}`);
      
      if (storedNonce !== nonce) {
        nonceSpan.recordException(new Error('Invalid nonce'));
        nonceSpan.end();
        throw new Error('Invalid or expired nonce');
      }
      nonceSpan.end();

      // Step 2: Verify signature
      const sigVerifySpan = this.tracer.startSpan('auth.verify_signature');
      const isValidSignature = await this.verifySiweSignature(message, signature, address);
      
      if (!isValidSignature) {
        sigVerifySpan.recordException(new Error('Invalid signature'));
        sigVerifySpan.end();
        throw new Error('Invalid signature');
      }
      sigVerifySpan.end();

      // Step 3: Get or create user
      const userSpan = this.tracer.startSpan('auth.get_or_create_user');
      let user = await this.db.query('SELECT * FROM users WHERE address = $1', [address]);
      
      if (user.rows.length === 0) {
        const insertResult = await this.db.query(
          'INSERT INTO users (address, created_at) VALUES ($1, NOW()) RETURNING *',
          [address]
        );
        user = insertResult.rows[0];
        userSpan.setAttribute('user.created', true);
      } else {
        user = user.rows[0];
        userSpan.setAttribute('user.created', false);
      }
      userSpan.end();

      // Step 4: Generate tokens
      const tokenSpan = this.tracer.startSpan('auth.generate_tokens');
      const accessToken = this.generateJwt(user.id, 'access');
      const refreshToken = this.generateJwt(user.id, 'refresh');
      tokenSpan.end();

      // Step 5: Clean up nonce
      await this.redis.del(`nonce:${address}`);

      rootSpan.setAttributes({
        'user.id': user.id,
        'auth.success': true
      });

      return {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          address: user.address
        }
      };
    } catch (error) {
      rootSpan.recordException(error);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      this.logger.error('Login failed', { address, error: error.message });
      throw error;
    } finally {
      rootSpan.end();
    }
  }

  verifySiweSignature(message, signature, address) {
    // Implementation here
    return true;
  }

  generateJwt(userId, type) {
    // Implementation here
    return 'jwt-token';
  }
}

// ============================================================================
// EXAMPLE 2: Content Service with Database Tracing
// ============================================================================

class ContentServiceWithTracing {
  constructor(db, cache, ipfsClient, logger) {
    this.db = db;
    this.cache = cache;
    this.ipfsClient = ipfsClient;
    this.logger = logger;
    this.tracer = createModuleTracer('content-service');
    this.dbTracing = createDatabaseTracing();
  }

  /**
   * Get content with caching and filtering
   */
  async getContentById(contentId, userId, userTier) {
    const rootSpan = this.tracer.startSpan('content.get_by_id', {
      attributes: {
        'content.id': contentId,
        'user.id': userId,
        'user.tier': userTier
      }
    });

    try {
      // Step 1: Check cache
      const cacheSpan = this.tracer.startSpan('content.cache_lookup');
      const cacheKey = `content:${contentId}`;
      let content = await this.cache.get(cacheKey);
      
      if (content) {
        cacheSpan.setAttribute('cache.hit', true);
        cacheSpan.end();
      } else {
        cacheSpan.setAttribute('cache.hit', false);
        cacheSpan.end();

        // Step 2: Query database
        const dbSpan = this.dbTracing.traceQuery('SELECT', 'content', 
          'SELECT * FROM content WHERE id = $1'
        );
        const result = await this.db.query(
          'SELECT * FROM content WHERE id = $1',
          [contentId]
        );
        dbSpan.end(result.rowCount);

        if (result.rows.length === 0) {
          throw new Error('Content not found');
        }

        content = result.rows[0];

        // Cache for 1 hour
        await this.cache.set(cacheKey, content, 3600);
      }

      // Step 3: Apply tier-based filtering
      const filterSpan = this.tracer.startSpan('content.apply_access_filter');
      const filteredContent = this.applyTierFilter(content, userTier);
      filterSpan.setAttribute('content.tier_required', content.required_tier);
      filterSpan.setAttribute('content.filtered', userTier < content.required_tier);
      filterSpan.end();

      // Step 4: Track view event
      const viewSpan = this.tracer.startSpan('content.track_view');
      await this.db.query(
        'INSERT INTO content_views (content_id, user_id, viewed_at) VALUES ($1, $2, NOW())',
        [contentId, userId]
      );
      viewSpan.end();

      rootSpan.setAttributes({
        'content.tier_required': content.required_tier,
        'content.size_bytes': content.size || 0
      });

      return filteredContent;
    } catch (error) {
      rootSpan.recordException(error);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      rootSpan.end();
    }
  }

  /**
   * List content with pagination
   */
  async listContent(userId, userTier, limit = 20, offset = 0) {
    const rootSpan = this.tracer.startSpan('content.list', {
      attributes: {
        'user.id': userId,
        'user.tier': userTier,
        'pagination.limit': limit,
        'pagination.offset': offset
      }
    });

    try {
      // Query with access control
      const querySpan = this.dbTracing.traceQuery('SELECT', 'content',
        'SELECT * FROM content WHERE required_tier <= $1 LIMIT $2 OFFSET $3'
      );

      const result = await this.db.query(
        'SELECT * FROM content WHERE required_tier <= $1 LIMIT $2 OFFSET $3',
        [userTier, limit, offset]
      );

      querySpan.end(result.rowCount);

      rootSpan.setAttribute('content.returned_count', result.rowCount);

      return {
        items: result.rows.map(content => this.applyTierFilter(content, userTier)),
        total: result.rowCount,
        limit,
        offset
      };
    } catch (error) {
      rootSpan.recordException(error);
      throw error;
    } finally {
      rootSpan.end();
    }
  }

  applyTierFilter(content, userTier) {
    // Implementation
    return content;
  }
}

// ============================================================================
// EXAMPLE 3: IPFS Storage Service with External Call Tracing
// ============================================================================

class IpfsStorageServiceWithTracing {
  constructor(ipfsClient, axios, logger) {
    this.ipfsClient = ipfsClient;
    this.axios = axios;
    this.logger = logger;
    this.tracer = createModuleTracer('ipfs-service');
    this.httpTracing = createHttpClientTracing();

    // Setup axios with tracing
    setupAxiosTracing(this.axios, { format: 'w3c' });
  }

  /**
   * Pin content to multiple regions
   */
  async pinContent(contentHash, regions = ['pinata', 'web3.storage']) {
    const rootSpan = this.tracer.startSpan('ipfs.pin_content', {
      attributes: {
        'content.hash': contentHash,
        'ipfs.regions': regions.length
      }
    });

    const results = {};

    try {
      for (const region of regions) {
        const regionSpan = this.tracer.startSpan(`ipfs.pin_to_${region}`, {
          attributes: {
            'ipfs.region': region
          }
        });

        try {
          const tracer = this.httpTracing.traceRequest('POST', 
            this.getRegionEndpoint(region), region
          );

          const response = await this.axios.post(
            this.getRegionEndpoint(region),
            { hashToPin: contentHash },
            {
              headers: {
                'Authorization': `Bearer ${process.env[`${region.toUpperCase()}_API_KEY`]}`,
                ...getContextHeaders(null, 'w3c')
              }
            }
          );

          tracer.end(response.status, response.data ? JSON.stringify(response.data).length : 0);
          results[region] = { success: true, data: response.data };
          regionSpan.end();
        } catch (error) {
          results[region] = { success: false, error: error.message };
          regionSpan.recordException(error);
          regionSpan.end();
        }
      }

      const successCount = Object.values(results).filter(r => r.success).length;
      rootSpan.setAttribute('ipfs.successful_pins', successCount);
      rootSpan.setAttribute('ipfs.failed_pins', regions.length - successCount);

      return results;
    } catch (error) {
      rootSpan.recordException(error);
      throw error;
    } finally {
      rootSpan.end();
    }
  }

  /**
   * Retrieve content with failover
   */
  async getContent(contentHash, preferredRegion = 'pinata') {
    const rootSpan = this.tracer.startSpan('ipfs.get_content', {
      attributes: {
        'content.hash': contentHash,
        'ipfs.preferred_region': preferredRegion
      }
    });

    const regions = [preferredRegion, ...this.getRegions().filter(r => r !== preferredRegion)];

    try {
      for (const region of regions) {
        const attemptSpan = this.tracer.startSpan(`ipfs.fetch_attempt_${region}`, {
          attributes: {
            'ipfs.region': region,
            'ipfs.attempt': regions.indexOf(region) + 1
          }
        });

        try {
          const url = `${this.getRegionUrl(region)}/ipfs/${contentHash}`;
          const tracer = this.httpTracing.traceRequest('GET', url, region);

          const response = await this.axios.get(url, {
            timeout: 5000,
            headers: {
              ...getContextHeaders(null, 'w3c')
            }
          });

          tracer.end(response.status, response.data?.length || 0);
          rootSpan.setAttribute('ipfs.retrieved_from', region);
          attemptSpan.end();

          return response.data;
        } catch (error) {
          attemptSpan.recordException(error);
          attemptSpan.end();
          this.logger.warn(`Failed to fetch from ${region}`, { error: error.message });
        }
      }

      throw new Error('Failed to retrieve content from all regions');
    } catch (error) {
      rootSpan.recordException(error);
      throw error;
    } finally {
      rootSpan.end();
    }
  }

  getRegionEndpoint(region) {
    const endpoints = {
      'pinata': 'https://api.pinata.cloud/pinning/pinByHash',
      'web3.storage': 'https://api.web3.storage/upload'
    };
    return endpoints[region];
  }

  getRegionUrl(region) {
    const urls = {
      'pinata': 'https://gateway.pinata.cloud',
      'web3.storage': 'https://w3s.link'
    };
    return urls[region];
  }

  getRegions() {
    return ['pinata', 'web3.storage'];
  }
}

// ============================================================================
// EXAMPLE 4: Stellar Blockchain Service with Chain Tracing
// ============================================================================

class StellarServiceWithTracing {
  constructor(stellarServer, logger) {
    this.stellarServer = stellarServer;
    this.logger = logger;
    this.tracer = createModuleTracer('stellar-service');
  }

  /**
   * Get subscription verification from blockchain
   */
  async verifySubscription(accountId, productId) {
    const rootSpan = this.tracer.startSpan('stellar.verify_subscription', {
      attributes: {
        'stellar.account': accountId,
        'product.id': productId
      }
    });

    try {
      // Step 1: Fetch account data
      const fetchSpan = this.tracer.startSpan('stellar.fetch_account');
      const account = await this.stellarServer.loadAccount(accountId);
      fetchSpan.end();

      // Step 2: Check data entries
      const dataSpan = this.tracer.startSpan('stellar.check_data_entries');
      const dataEntries = account.data_attr;
      const subscriptionKey = `subscription_${productId}`;
      
      if (!dataEntries[subscriptionKey]) {
        throw new Error('Subscription not found');
      }

      const subscriptionData = JSON.parse(
        Buffer.from(dataEntries[subscriptionKey], 'base64').toString()
      );
      dataSpan.end();

      // Step 3: Verify expiration
      const verifySpan = this.tracer.startSpan('stellar.verify_expiration');
      const expiresAt = new Date(subscriptionData.expiresAt);
      const isValid = expiresAt > new Date();

      verifySpan.setAttributes({
        'subscription.expires_at': expiresAt.toISOString(),
        'subscription.valid': isValid
      });
      verifySpan.end();

      rootSpan.setAttributes({
        'subscription.valid': isValid,
        'subscription.tier': subscriptionData.tier
      });

      return {
        valid: isValid,
        tier: subscriptionData.tier,
        expiresAt
      };
    } catch (error) {
      rootSpan.recordException(error);
      rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      rootSpan.end();
    }
  }

  /**
   * Submit transaction with tracing
   */
  async submitTransaction(transaction) {
    const txSpan = this.tracer.startSpan('stellar.submit_transaction');

    try {
      const result = await this.stellarServer.submitTransaction(transaction);

      txSpan.setAttributes({
        'stellar.tx_hash': result.hash,
        'stellar.ledger': result.ledger,
        'stellar.envelope_xdr': transaction.toEnvelope().toXDR('base64').substring(0, 100)
      });

      return result;
    } catch (error) {
      txSpan.recordException(error);
      if (error.response?.extras?.result_codes) {
        txSpan.setAttribute('stellar.error_codes', 
          JSON.stringify(error.response.extras.result_codes)
        );
      }
      throw error;
    } finally {
      txSpan.end();
    }
  }
}

// ============================================================================
// EXAMPLE 5: Analytics Service with Event Tracing
// ============================================================================

class AnalyticsServiceWithTracing {
  constructor(db, redis, eventBus, logger) {
    this.db = db;
    this.redis = redis;
    this.eventBus = eventBus;
    this.logger = logger;
    this.tracer = createModuleTracer('analytics-service');
    this.dbTracing = createDatabaseTracing();
  }

  /**
   * Record video view event
   */
  async recordViewEvent(videoId, userId, watchTime, totalDuration) {
    const eventSpan = this.tracer.startSpan('analytics.record_view_event', {
      attributes: {
        'video.id': videoId,
        'user.id': userId,
        'video.watch_time': watchTime,
        'video.total_duration': totalDuration
      }
    });

    try {
      // Calculate engagement metrics
      const engagementSpan = this.tracer.startSpan('analytics.calculate_engagement');
      const engagementPercent = (watchTime / totalDuration) * 100;
      engagementSpan.setAttribute('engagement.percent', Math.round(engagementPercent));
      engagementSpan.end();

      // Store in database
      const dbSpan = this.dbTracing.traceQuery('INSERT', 'analytics_events',
        'INSERT INTO analytics_events (video_id, user_id, watch_time, total_duration, engagement_percent) VALUES ($1, $2, $3, $4, $5)'
      );

      await this.db.query(
        'INSERT INTO analytics_events (video_id, user_id, watch_time, total_duration, engagement_percent) VALUES ($1, $2, $3, $4, $5)',
        [videoId, userId, watchTime, totalDuration, engagementPercent]
      );

      dbSpan.end(1);

      // Update cache statistics
      const cacheSpan = this.tracer.startSpan('analytics.update_cache');
      const cacheKey = `video_stats:${videoId}`;
      const stats = await this.redis.hgetall(cacheKey);
      
      await this.redis.hset(cacheKey, {
        ...stats,
        last_view: new Date().toISOString(),
        total_views: (parseInt(stats.total_views || 0) + 1).toString(),
        avg_watch_time: ((parseInt(stats.avg_watch_time || 0) + watchTime) / 2).toString()
      });

      cacheSpan.end();

      eventSpan.setAttribute('analytics.engagement_percent', engagementPercent);
      return { engagementPercent, stored: true };
    } catch (error) {
      eventSpan.recordException(error);
      throw error;
    } finally {
      eventSpan.end();
    }
  }

  /**
   * Generate heatmap with aggregation
   */
  async generateHeatmap(videoId) {
    const heatmapSpan = this.tracer.startSpan('analytics.generate_heatmap', {
      attributes: {
        'video.id': videoId
      }
    });

    try {
      // Query aggregated data
      const querySpan = this.dbTracing.traceQuery('SELECT', 'analytics_events',
        'SELECT timestamp_bucket(INTERVAL 1 minute, created_at) as minute, COUNT(*) as views FROM analytics_events WHERE video_id = $1 GROUP BY minute'
      );

      const result = await this.db.query(
        'SELECT timestamp_bucket(INTERVAL \'1 minute\'::interval, created_at) as minute, COUNT(*) as views FROM analytics_events WHERE video_id = $1 GROUP BY minute ORDER BY minute',
        [videoId]
      );

      querySpan.end(result.rowCount);

      // Process heatmap data
      const processSpan = this.tracer.startSpan('analytics.process_heatmap_data');
      const heatmapData = result.rows.map(row => ({
        timestamp: row.minute,
        views: parseInt(row.views)
      }));
      processSpan.setAttribute('heatmap.data_points', heatmapData.length);
      processSpan.end();

      heatmapSpan.setAttribute('analytics.heatmap_points', heatmapData.length);
      return heatmapData;
    } catch (error) {
      heatmapSpan.recordException(error);
      throw error;
    } finally {
      heatmapSpan.end();
    }
  }
}

module.exports = {
  AuthServiceWithTracing,
  ContentServiceWithTracing,
  IpfsStorageServiceWithTracing,
  StellarServiceWithTracing,
  AnalyticsServiceWithTracing
};
