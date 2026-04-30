const Redis = require("ioredis");

let redisClient = null;

/**
 * Circuit breaker state for Redis.
 * Tracks consecutive failures and opens the circuit to avoid hammering
 * an unavailable Redis instance. Automatically half-opens after a cooldown
 * period so the next request can probe whether Redis has recovered.
 *
 * States:
 *   CLOSED  – Redis is healthy; all operations proceed normally.
 *   OPEN    – Redis is unhealthy; operations fail fast without attempting.
 *   HALF_OPEN – Cooldown elapsed; one probe request is allowed through.
 */
const circuitBreaker = {
  state: "CLOSED",          // "CLOSED" | "OPEN" | "HALF_OPEN"
  failures: 0,
  threshold: Number(process.env.REDIS_CB_THRESHOLD || 5),   // failures before opening
  cooldownMs: Number(process.env.REDIS_CB_COOLDOWN_MS || 30000), // 30 s
  openedAt: null,

  /** Record a successful Redis operation. */
  recordSuccess() {
    this.failures = 0;
    if (this.state !== "CLOSED") {
      console.log("[Redis] Circuit breaker CLOSED – Redis recovered");
    }
    this.state = "CLOSED";
    this.openedAt = null;
  },

  /** Record a failed Redis operation. */
  recordFailure() {
    this.failures += 1;
    if (this.state === "CLOSED" && this.failures >= this.threshold) {
      this.state = "OPEN";
      this.openedAt = Date.now();
      console.warn(
        `[Redis] Circuit breaker OPEN after ${this.failures} consecutive failures`
      );
    }
  },

  /**
   * Returns true when a Redis call should be attempted.
   * Transitions OPEN → HALF_OPEN once the cooldown has elapsed.
   */
  isHealthy() {
    if (this.state === "CLOSED") return true;
    if (this.state === "HALF_OPEN") return true; // allow the probe
    // OPEN – check cooldown
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = "HALF_OPEN";
      console.log("[Redis] Circuit breaker HALF_OPEN – probing Redis");
      return true;
    }
    return false;
  },
};

/**
 * Create or return the singleton Redis client.
 *
 * Supports configuration via environment variables:
 *   REDIS_URL   – full connection string (e.g. redis://user:pass@host:6379)
 *   REDIS_HOST  – hostname (default 127.0.0.1)
 *   REDIS_PORT  – port     (default 6379)
 *   REDIS_PASSWORD – password (optional)
 *   REDIS_DB    – database index (default 0)
 *
 * @param {object} [opts] Override options forwarded to ioredis.
 * @returns {import('ioredis').Redis}
 */
function getRedisClient(opts = {}) {
  if (redisClient) return redisClient;

  const url = process.env.REDIS_URL;

  if (url) {
    redisClient = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      ...opts,
    });
  } else {
    redisClient = new Redis({
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: Number(process.env.REDIS_DB || 0),
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      ...opts,
    });
  }

  redisClient.on("error", (err) => {
    console.error("[Redis] connection error:", err.message);
    circuitBreaker.recordFailure();
  });

  redisClient.on("ready", () => {
    circuitBreaker.recordSuccess();
  });

  return redisClient;
}

/**
 * Gracefully close the Redis connection (e.g. during shutdown).
 */
async function closeRedisClient() {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

/**
 * Replace the singleton – useful for injecting a mock in tests.
 */
function setRedisClient(client) {
  redisClient = client;
}

module.exports = { getRedisClient, closeRedisClient, setRedisClient, circuitBreaker };
