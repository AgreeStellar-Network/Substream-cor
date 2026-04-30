const { getRedisClient, circuitBreaker } = require('../config/redis');

/**
 * Cache Utility
 * Provides a standardized way to cache analytical queries with automated invalidation.
 *
 * Stale-data fallback strategy
 * ─────────────────────────────
 * Every time a value is written to the primary key (TTL = `ttl`), a second
 * "stale" copy is written under `<key>:stale` with a much longer TTL
 * (default 24 h).  When Redis is healthy but the primary key has expired,
 * the normal flow runs.  When Redis is unavailable (circuit breaker OPEN) or
 * the primary key is missing and the DB fetch fails, the stale copy is
 * returned so callers always get *something* rather than an error.
 */
class CacheManager {
  constructor(config = {}) {
    this.redis = getRedisClient();
    this.defaultTtl = config.defaultTtl || 900;           // 15 min
    this.staleTtl = config.staleTtl || 86400;             // 24 h
    this.prefix = config.prefix || 'cache:';
  }

  /**
   * Get or set cache value with stale-data fallback.
   *
   * @param {string}   key
   * @param {Function} fetchFn  Async function that returns fresh data.
   * @param {number}   [ttl]    Primary TTL in seconds.
   * @returns {Promise<*>}
   */
  async wrap(key, fetchFn, ttl = this.defaultTtl) {
    const fullKey = `${this.prefix}${key}`;
    const staleKey = `${fullKey}:stale`;

    // ── 1. Fast-path: circuit breaker is OPEN → serve stale immediately ──
    if (!circuitBreaker.isHealthy()) {
      return this._serveStale(staleKey, fetchFn, 'circuit-open');
    }

    try {
      // ── 2. Try primary cache ──────────────────────────────────────────
      const cached = await this.redis.get(fullKey);
      if (cached) {
        circuitBreaker.recordSuccess();
        return JSON.parse(cached);
      }

      // ── 3. Cache miss – fetch fresh data ─────────────────────────────
      const data = await fetchFn();

      // ── 4. Write primary + stale copies ──────────────────────────────
      await this._writeBoth(fullKey, staleKey, data, ttl);
      circuitBreaker.recordSuccess();

      return data;
    } catch (error) {
      circuitBreaker.recordFailure();
      console.error(`[Cache] Error for key ${fullKey}:`, error.message);

      // ── 5. Redis error → try stale, then live DB ──────────────────────
      return this._serveStale(staleKey, fetchFn, 'redis-error');
    }
  }

  /**
   * Invalidate cache for a specific key (primary only; stale is intentionally kept).
   * @param {string} key
   */
  async invalidate(key) {
    const fullKey = `${this.prefix}${key}`;
    try {
      await this.redis.del(fullKey);
    } catch (error) {
      console.error(`[Cache] Failed to invalidate ${fullKey}:`, error.message);
    }
  }

  /**
   * Invalidate all analytical caches for a creator.
   * Useful when a new BillingEvent arrives.
   * @param {string} creatorId
   */
  async invalidateCreatorAnalytics(creatorId) {
    const pattern = `${this.prefix}analytics:${creatorId}:*`;
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        // Only delete primary keys; stale copies remain as safety net
        const primaryKeys = keys.filter((k) => !k.endsWith(':stale'));
        if (primaryKeys.length > 0) {
          await this.redis.del(...primaryKeys);
        }
      }
    } catch (error) {
      console.error(`[Cache] Failed to invalidate creator analytics for ${creatorId}:`, error.message);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Write data to both the primary key and the long-lived stale key.
   */
  async _writeBoth(fullKey, staleKey, data, ttl) {
    try {
      const serialized = JSON.stringify(data);
      const pipeline = this.redis.pipeline();
      pipeline.set(fullKey, serialized, 'EX', ttl);
      pipeline.set(staleKey, serialized, 'EX', this.staleTtl);
      await pipeline.exec();
    } catch (error) {
      console.error(`[Cache] Failed to write cache for ${fullKey}:`, error.message);
    }
  }

  /**
   * Attempt to return stale data; if unavailable, fall back to a live DB fetch.
   *
   * @param {string}   staleKey
   * @param {Function} fetchFn
   * @param {string}   reason   Label for logging.
   */
  async _serveStale(staleKey, fetchFn, reason) {
    try {
      const stale = await this.redis.get(staleKey);
      if (stale) {
        console.warn(`[Cache] Serving stale data (${reason}) for key ${staleKey}`);
        return JSON.parse(stale);
      }
    } catch (_) {
      // Redis is truly unreachable – fall through to live fetch
    }

    // Last resort: hit the DB directly
    console.warn(`[Cache] No stale data available (${reason}), falling back to live fetch`);
    return fetchFn();
  }
}

module.exports = new CacheManager();
