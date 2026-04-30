// src/services/webhookDispatcherService.js
const crypto = require('crypto');
const knexFactory = require('knex');
const { Queue } = require('bullmq');
const { getRedisConnection } = require('../config/redis');

class WebhookDispatcherService {
  constructor() {
    this.queue = new Queue('merchant-webhooks', {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
      }
    });
    this.knex = knexFactory(require('../../knexfile')[process.env.NODE_ENV || 'development']);
  }

  /**
   * Dispatch webhook with HMAC signature
   */
  async dispatch(eventType, payload, merchantId, subscriptionId = null) {
    if (!merchantId) return;

    const merchant = await this.getMerchantWithSecret(merchantId);
    if (!merchant?.webhook_url || !merchant?.webhook_secret) {
      console.warn(`[Webhook] Merchant ${merchantId} missing webhook_url or webhook_secret`);
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000); // Unix timestamp (seconds)

    // Add timestamp and nonce to payload for replay protection
    const signedPayload = {
      ...payload,
      timestamp,
      nonce: crypto.randomBytes(16).toString('hex') // Add nonce for additional security
    };

    const signature = this.generateHMACSignature(signedPayload, merchant.webhook_secret);

    const jobData = {
      eventType,
      payload: signedPayload,
      webhookUrl: merchant.webhook_url,
      merchantId,
      subscriptionId,
      signature,
      timestamp
    };

    await this.queue.add('dispatch-webhook', jobData);
    console.log(`[Webhook] Queued signed ${eventType} for merchant ${merchantId}`);
  }

  generateHMACSignature(payload, secret) {
    // Normalize payload to ensure consistent signature generation
    const normalizedPayload = this.normalizePayload(payload);
    const payloadStr = JSON.stringify(normalizedPayload);
    
    return crypto
      .createHmac('sha256', secret)
      .update(payloadStr, 'utf8')
      .digest('hex');
  }

  /**
   * Normalize payload object for consistent signature generation
   * @param {Object} payload 
   * @returns {Object}
   */
  normalizePayload(payload) {
    if (typeof payload !== 'object' || payload === null) {
      return payload;
    }

    const normalized = {};
    const keys = Object.keys(payload).sort(); // Sort keys for consistent ordering
    
    for (const key of keys) {
      if (typeof payload[key] === 'object' && payload[key] !== null && !Array.isArray(payload[key])) {
        normalized[key] = this.normalizePayload(payload[key]); // Recursively normalize nested objects
      } else {
        normalized[key] = payload[key];
      }
    }
    
    return normalized;
  }

  /**
   * Verify webhook signature with timing-safe comparison
   * @param {Object} payload
   * @param {string} signature
   * @param {string} secret
   * @returns {boolean}
   */
  verifyHMACSignature(payload, signature, secret) {
    if (!secret || !signature) return false;
    
    const expectedSignature = this.generateHMACSignature(payload, secret);
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  async getMerchantWithSecret(merchantId) {
    const merchant = await this.knex('merchants')
      .where({ id: merchantId })
      .select('webhook_url', 'webhook_secret')
      .first();
    return merchant;
  }

  async close() {
    await this.queue.close();
    await this.knex.destroy();
  }
}

module.exports = { WebhookDispatcherService };
