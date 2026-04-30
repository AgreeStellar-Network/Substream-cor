
const axios = require('axios');
const { PrivacyService } = require('./privacyService');

/**
 * Webhook Dispatcher
 * Handles sending webhooks to merchants with privacy scrubbing
 */
class WebhookDispatcher {
  constructor(database, logger = console, sanctionsScreeningService = null) {
    this.database = database;
    this.logger = logger;
    this.privacyService = new PrivacyService(database);
    // Optional — when present, dispatch is refused for BLOCKED wallets so a
    // sanctioned account can't trigger downstream merchant systems.
    this.sanctionsScreeningService = sanctionsScreeningService;
  }

  /**
   * Dispatch a webhook event to a merchant
   * @param {string} creatorId
   * @param {string} walletAddress
   * @param {string} eventType
   * @param {Object} payload
   */
  async dispatch(creatorId, walletAddress, eventType, payload) {
    try {
      // Sanctions gate: refuse to dispatch webhooks tied to a BLOCKED wallet.
      // Cached/synchronous so the hot path is a single Map lookup.
      if (
        walletAddress &&
        this.sanctionsScreeningService &&
        this.sanctionsScreeningService.isBlocked(walletAddress)
      ) {
        this.logger.warn(
          `Webhook suppressed for BLOCKED wallet ${walletAddress} (event ${eventType})`
        );
        return { success: false, error: 'ACCOUNT_BLOCKED' };
      }

      // 1. Get merchant's webhook URL
      // We assume creators/merchants have a webhook_url configured in their profile
      const merchant = await this.database.getCreator(creatorId);
      if (!merchant || !merchant.webhook_url) {
        this.logger.debug(`No webhook URL configured for merchant ${creatorId}`);
        return;
      }

      // 2. Scrub payload based on user's privacy preferences
      const scrubbedPayload = await this.privacyService.scrubPayload(walletAddress, {
        ...payload,
        event_type: eventType,
        wallet_address: walletAddress
      });

      // 3. Send the webhook with enhanced security
      this.logger.info(`Sending webhook to ${merchant.webhook_url}`, {
        creatorId,
        eventType,
        walletAddress
      });

      // Add timestamp for replay protection
      const timestamp = Math.floor(Date.now() / 1000);
      const signedPayload = {
        ...scrubbedPayload,
        timestamp,
        nonce: crypto.randomBytes(16).toString('hex') // Add nonce for additional security
      };

      const signature = this.generateSignature(signedPayload, merchant.webhook_secret);

      const response = await axios.post(merchant.webhook_url, signedPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-SubStream-Event': eventType,
          'X-SubStream-Signature': signature,
          'X-SubStream-Timestamp': timestamp.toString(),
          'X-SubStream-Nonce': signedPayload.nonce
        },
        timeout: 5000 // 5 seconds timeout
      });

      this.logger.info(`Webhook sent successfully to ${merchant.webhook_url}`, {
        status: response.status
      });

      return { success: true, status: response.status };
    } catch (error) {
      this.logger.error(`Failed to send webhook for ${creatorId}`, {
        error: error.message,
        url: error.config?.url
      });
      // Optionally queue for retry or alert
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate HMAC signature for webhook payload verification
   * @param {Object} payload 
   * @param {string} secret 
   * @returns {string}
   */
  generateSignature(payload, secret) {
    if (!secret) return 'unsigned';
    const crypto = require('crypto');
    
    // Normalize payload to prevent signature variations due to key ordering
    const normalizedPayload = this.normalizePayload(payload);
    const payloadString = JSON.stringify(normalizedPayload);
    
    return crypto
      .createHmac('sha256', secret)
      .update(payloadString, 'utf8')
      .digest('hex');
  }

  /**
   * Normalize payload object to ensure consistent signature generation
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
   * Verify webhook signature from merchant
   * @param {Object} payload
   * @param {string} signature
   * @param {string} secret
   * @returns {boolean}
   */
  verifySignature(payload, signature, secret) {
    if (!secret || !signature) return false;
    
    const expectedSignature = this.generateSignature(payload, secret);
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }
}

module.exports = { WebhookDispatcher };
