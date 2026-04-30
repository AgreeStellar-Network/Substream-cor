const { getRedisClient, circuitBreaker } = require('../config/redis');

/**
 * Service for caching and retrieving global statistics with Redis.
 * Implements a 60-second TTL with background refresh to prevent database hammering.
 */
class GlobalStatsService {
  constructor(database, redisClient = null) {
    this.database = database;
    this.redis = redisClient || getRedisClient();
    this.cacheKeys = {
      totalValueLocked: 'global_stats:tvl',
      trendingCreators: 'global_stats:trending_creators',
      totalUsers: 'global_stats:total_users',
      totalCreators: 'global_stats:total_creators',
      totalVideos: 'global_stats:total_videos',
      totalSubscriptions: 'global_stats:total_subscriptions',
      lastUpdated: 'global_stats:last_updated'
    };
    // Stale keys mirror the primary keys but survive much longer (24 h).
    this.staleKeys = Object.fromEntries(
      Object.entries(this.cacheKeys).map(([k, v]) => [k, `${v}:stale`])
    );
    this.ttlSeconds = 60;
    this.staleTtlSeconds = 86400; // 24 h
  }

  /**
   * Get cached global stats or compute them if cache is empty.
   * Falls back to stale data when Redis is unavailable, and to a live DB
   * query only when no stale copy exists either.
   * @returns {Promise<Object>} Global statistics object
   */
  async getGlobalStats() {
    // Fast-path: circuit breaker is OPEN → serve stale immediately
    if (!circuitBreaker.isHealthy()) {
      const stale = await this._getStaleStats();
      if (stale) {
        console.warn('[GlobalStats] Redis circuit open – serving stale stats');
        return stale;
      }
      // No stale data yet; compute from DB (cold start scenario)
      return this.computeFreshStats();
    }

    try {
      const cached = await this.getCachedStats();
      if (cached) return cached;
      return await this.computeAndCacheStats();
    } catch (error) {
      console.error('[GlobalStats] Redis error, attempting stale fallback:', error.message);
      circuitBreaker.recordFailure();

      const stale = await this._getStaleStats();
      if (stale) {
        console.warn('[GlobalStats] Serving stale stats due to Redis error');
        return stale;
      }

      // Last resort: compute directly from DB without caching
      console.warn('[GlobalStats] No stale data – falling back to live DB query');
      return this.computeFreshStats();
    }
  }

  /**
   * Retrieve cached stats from Redis.
   * @returns {Promise<Object|null>} Cached stats or null if not found
   */
  async getCachedStats() {
    try {
      const cached = await this.redis.get(this.cacheKeys.totalValueLocked);
      if (!cached) return null;

      const stats = {
        totalValueLocked: JSON.parse(cached),
        trendingCreators: JSON.parse(await this.redis.get(this.cacheKeys.trendingCreators) || '[]'),
        totalUsers: parseInt(await this.redis.get(this.cacheKeys.totalUsers) || '0'),
        totalCreators: parseInt(await this.redis.get(this.cacheKeys.totalCreators) || '0'),
        totalVideos: parseInt(await this.redis.get(this.cacheKeys.totalVideos) || '0'),
        totalSubscriptions: parseInt(await this.redis.get(this.cacheKeys.totalSubscriptions) || '0'),
        lastUpdated: await this.redis.get(this.cacheKeys.lastUpdated)
      };

      return stats;
    } catch (error) {
      console.error('Error retrieving cached stats:', error);
      return null;
    }
  }

  /**
   * Compute fresh stats and cache them.
   * @returns {Promise<Object>} Freshly computed statistics
   */
  async computeAndCacheStats() {
    const stats = await this.computeFreshStats();
    await this.cacheStats(stats);
    return stats;
  }

  /**
   * Compute fresh statistics from the database.
   * @returns {Promise<Object>} Fresh statistics
   */
  async computeFreshStats() {
    const now = new Date().toISOString();

    const [
      totalValueLocked,
      trendingCreators,
      totalUsers,
      totalCreators,
      totalVideos,
      totalSubscriptions
    ] = await Promise.all([
      this.computeTotalValueLocked(),
      this.computeTrendingCreators(),
      this.computeTotalUsers(),
      this.computeTotalCreators(),
      this.computeTotalVideos(),
      this.computeTotalSubscriptions()
    ]);

    return {
      totalValueLocked,
      trendingCreators,
      totalUsers,
      totalCreators,
      totalVideos,
      totalSubscriptions,
      lastUpdated: now
    };
  }

  /**
   * Cache statistics in Redis with TTL.
   * Also writes long-lived stale copies used as fallback during outages.
   * @param {Object} stats Statistics to cache
   */
  async cacheStats(stats) {
    try {
      const pipeline = this.redis.pipeline();

      // Primary keys (short TTL)
      pipeline.setex(this.cacheKeys.totalValueLocked, this.ttlSeconds, JSON.stringify(stats.totalValueLocked));
      pipeline.setex(this.cacheKeys.trendingCreators, this.ttlSeconds, JSON.stringify(stats.trendingCreators));
      pipeline.setex(this.cacheKeys.totalUsers, this.ttlSeconds, stats.totalUsers.toString());
      pipeline.setex(this.cacheKeys.totalCreators, this.ttlSeconds, stats.totalCreators.toString());
      pipeline.setex(this.cacheKeys.totalVideos, this.ttlSeconds, stats.totalVideos.toString());
      pipeline.setex(this.cacheKeys.totalSubscriptions, this.ttlSeconds, stats.totalSubscriptions.toString());
      pipeline.setex(this.cacheKeys.lastUpdated, this.ttlSeconds, stats.lastUpdated);

      // Stale copies (long TTL – survive Redis restarts / outages)
      pipeline.setex(this.staleKeys.totalValueLocked, this.staleTtlSeconds, JSON.stringify(stats.totalValueLocked));
      pipeline.setex(this.staleKeys.trendingCreators, this.staleTtlSeconds, JSON.stringify(stats.trendingCreators));
      pipeline.setex(this.staleKeys.totalUsers, this.staleTtlSeconds, stats.totalUsers.toString());
      pipeline.setex(this.staleKeys.totalCreators, this.staleTtlSeconds, stats.totalCreators.toString());
      pipeline.setex(this.staleKeys.totalVideos, this.staleTtlSeconds, stats.totalVideos.toString());
      pipeline.setex(this.staleKeys.totalSubscriptions, this.staleTtlSeconds, stats.totalSubscriptions.toString());
      pipeline.setex(this.staleKeys.lastUpdated, this.staleTtlSeconds, stats.lastUpdated);

      await pipeline.exec();
      circuitBreaker.recordSuccess();
      console.log('Global stats cached successfully');
    } catch (error) {
      console.error('Error caching stats:', error);
      circuitBreaker.recordFailure();
    }
  }

  /**
   * Read stale fallback stats from Redis.
   * Returns null if stale data is unavailable or Redis is unreachable.
   * @returns {Promise<Object|null>}
   */
  async _getStaleStats() {
    try {
      const tvl = await this.redis.get(this.staleKeys.totalValueLocked);
      if (!tvl) return null;

      return {
        totalValueLocked: JSON.parse(tvl),
        trendingCreators: JSON.parse(await this.redis.get(this.staleKeys.trendingCreators) || '[]'),
        totalUsers: parseInt(await this.redis.get(this.staleKeys.totalUsers) || '0'),
        totalCreators: parseInt(await this.redis.get(this.staleKeys.totalCreators) || '0'),
        totalVideos: parseInt(await this.redis.get(this.staleKeys.totalVideos) || '0'),
        totalSubscriptions: parseInt(await this.redis.get(this.staleKeys.totalSubscriptions) || '0'),
        lastUpdated: await this.redis.get(this.staleKeys.lastUpdated),
        stale: true,
      };
    } catch (error) {
      console.error('[GlobalStats] Failed to read stale stats:', error.message);
      return null;
    }
  }

  /**
   * Compute Total Value Locked (sum of all active subscription flow rates).
   * @returns {Promise<number>} Total value locked
   */
  async computeTotalValueLocked() {
    try {
      const query = `
        SELECT SUM(CAST(cs.flow_rate AS REAL)) as totalFlow
        FROM creator_settings cs
        JOIN creators c ON cs.creator_id = c.id
        WHERE c.subscriber_count > 0
      `;
      
      const result = this.database.db.prepare(query).get();
      return result?.totalFlow || 0;
    } catch (error) {
      console.error('Error computing TVL:', error);
      return 0;
    }
  }

  /**
   * Compute trending creators based on subscriber growth and activity.
   * @returns {Promise<Array>} Array of trending creators
   */
  async computeTrendingCreators() {
    try {
      const query = `
        SELECT 
          c.id,
          c.subscriber_count,
          COUNT(v.id) as video_count,
          MAX(v.created_at) as latest_video_date
        FROM creators c
        LEFT JOIN videos v ON c.id = v.creator_id AND v.visibility = 'public'
        WHERE c.subscriber_count > 0
        GROUP BY c.id, c.subscriber_count
        ORDER BY 
          c.subscriber_count DESC,
          video_count DESC,
          latest_video_date DESC
        LIMIT 10
      `;
      
      const creators = this.database.db.prepare(query).all();
      
      return creators.map(creator => ({
        id: creator.id,
        subscriberCount: creator.subscriber_count,
        videoCount: creator.video_count,
        latestVideoDate: creator.latest_video_date,
        trendingScore: this.calculateTrendingScore(creator)
      }));
    } catch (error) {
      console.error('Error computing trending creators:', error);
      return [];
    }
  }

  /**
   * Calculate trending score for a creator.
   * @param {Object} creator Creator data
   * @returns {number} Trending score
   */
  calculateTrendingScore(creator) {
    const subscriberWeight = 0.5;
    const videoWeight = 0.3;
    const recencyWeight = 0.2;
    
    let recencyScore = 0;
    if (creator.latest_video_date) {
      const daysSinceLatestVideo = (Date.now() - new Date(creator.latest_video_date).getTime()) / (1000 * 60 * 60 * 24);
      recencyScore = Math.max(0, 1 - daysSinceLatestVideo / 30); // Decay over 30 days
    }
    
    return (
      creator.subscriber_count * subscriberWeight +
      creator.video_count * videoWeight +
      recencyScore * 100 * recencyWeight
    );
  }

  /**
   * Compute total number of unique users (subscribers).
   * @returns {Promise<number>} Total users
   */
  async computeTotalUsers() {
    try {
      const query = `SELECT COUNT(DISTINCT wallet_address) as totalUsers FROM subscriptions WHERE active = 1`;
      const result = this.database.db.prepare(query).get();
      return result?.totalUsers || 0;
    } catch (error) {
      console.error('Error computing total users:', error);
      return 0;
    }
  }

  /**
   * Compute total number of creators.
   * @returns {Promise<number>} Total creators
   */
  async computeTotalCreators() {
    try {
      const query = `SELECT COUNT(*) as totalCreators FROM creators`;
      const result = this.database.db.prepare(query).get();
      return result?.totalCreators || 0;
    } catch (error) {
      console.error('Error computing total creators:', error);
      return 0;
    }
  }

  /**
   * Compute total number of videos.
   * @returns {Promise<number>} Total videos
   */
  async computeTotalVideos() {
    try {
      const query = `SELECT COUNT(*) as totalVideos FROM videos`;
      const result = this.database.db.prepare(query).get();
      return result?.totalVideos || 0;
    } catch (error) {
      console.error('Error computing total videos:', error);
      return 0;
    }
  }

  /**
   * Compute total number of active subscriptions.
   * @returns {Promise<number>} Total subscriptions
   */
  async computeTotalSubscriptions() {
    try {
      const query = `SELECT COUNT(*) as totalSubscriptions FROM subscriptions WHERE active = 1`;
      const result = this.database.db.prepare(query).get();
      return result?.totalSubscriptions || 0;
    } catch (error) {
      console.error('Error computing total subscriptions:', error);
      return 0;
    }
  }

  /**
   * Refresh the cache manually.
   * @returns {Promise<Object>} Fresh statistics
   */
  async refreshCache() {
    console.log('Manually refreshing global stats cache...');
    return await this.computeAndCacheStats();
  }

  /**
   * Clear all cached global stats.
   */
  async clearCache() {
    try {
      const keys = Object.values(this.cacheKeys);
      await this.redis.del(...keys);
      console.log('Global stats cache cleared');
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }

  /**
   * Get cache status and metadata.
   * @returns {Promise<Object>} Cache status information
   */
  async getCacheStatus() {
    try {
      const lastUpdated = await this.redis.get(this.cacheKeys.lastUpdated);
      const ttl = await this.redis.ttl(this.cacheKeys.totalValueLocked);
      const staleLastUpdated = await this.redis.get(this.staleKeys.lastUpdated);
      const staleTtl = await this.redis.ttl(this.staleKeys.totalValueLocked);

      return {
        lastUpdated: lastUpdated ? new Date(lastUpdated).toISOString() : null,
        ttlSeconds: ttl,
        cacheKeys: this.cacheKeys,
        ttlConfig: this.ttlSeconds,
        stale: {
          lastUpdated: staleLastUpdated ? new Date(staleLastUpdated).toISOString() : null,
          ttlSeconds: staleTtl,
          ttlConfig: this.staleTtlSeconds,
        },
        circuitBreaker: {
          state: circuitBreaker.state,
          failures: circuitBreaker.failures,
          threshold: circuitBreaker.threshold,
        },
      };
    } catch (error) {
      console.error('Error getting cache status:', error);
      return {
        circuitBreaker: {
          state: circuitBreaker.state,
          failures: circuitBreaker.failures,
          threshold: circuitBreaker.threshold,
        },
      };
    }
  }
}

module.exports = GlobalStatsService;
