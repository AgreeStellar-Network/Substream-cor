'use strict';

/**
 * SumSub Webhook Handler
 *
 * POST /webhooks/sumsub
 *
 * SumSub sends a signed payload whenever an applicant's review status changes.
 * We verify the HMAC-SHA256 signature, map the SumSub review result to our
 * internal STATUS, then call CustomerService.updateVerificationStatus().
 *
 * Signature verification:
 *   X-App-Token  : SumSub app token (identifies the sender)
 *   X-App-Access-Sig : HMAC-SHA256(secret, timestamp + body)
 *   X-App-Access-Ts  : Unix timestamp (used in signature)
 *
 * Env vars:
 *   SUMSUB_WEBHOOK_SECRET  – shared secret for HMAC verification
 *   SUMSUB_APP_TOKEN       – expected app token header value
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { CustomerService, STATUS } = require('../src/services/customerService');
const logger = require('../src/utils/logger');

// SumSub reviewResult → internal STATUS
const REVIEW_RESULT_MAP = {
  GREEN: STATUS.APPROVED,
  RED: STATUS.REJECTED,
  // Intermediate states
  PENDING: STATUS.PENDING,
  RETRY: STATUS.NEEDS_INFO,
};

/**
 * Verify SumSub HMAC-SHA256 signature.
 * Signature = HMAC-SHA256(secret, timestamp + rawBody)
 */
function verifySignature(rawBody, timestamp, sig) {
  const secret = process.env.SUMSUB_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('[SumSub] SUMSUB_WEBHOOK_SECRET not set — skipping signature verification');
    return true; // allow in dev; enforce in prod via env
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

// Raw body is needed for HMAC verification — mount before express.json()
router.post(
  '/sumsub',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['x-app-access-sig'];
    const ts = req.headers['x-app-access-ts'];
    const appToken = req.headers['x-app-token'];

    // Validate app token if configured
    const expectedToken = process.env.SUMSUB_APP_TOKEN;
    if (expectedToken && appToken !== expectedToken) {
      logger.warn('[SumSub] Webhook rejected: invalid app token');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const rawBody = req.body.toString('utf8');

    if (sig && ts && !verifySignature(rawBody, ts, sig)) {
      logger.warn('[SumSub] Webhook rejected: invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const { applicantId, externalUserId, type, reviewResult } = payload;

    // We only care about applicantReviewed events
    if (type !== 'applicantReviewed') {
      return res.status(200).json({ received: true });
    }

    if (!externalUserId) {
      logger.warn('[SumSub] Webhook missing externalUserId', { applicantId });
      return res.status(400).json({ error: 'externalUserId required' });
    }

    const reviewAnswer = reviewResult?.reviewAnswer; // GREEN | RED
    const internalStatus = REVIEW_RESULT_MAP[reviewAnswer] || STATUS.PENDING;
    const rejectionReason = reviewResult?.rejectLabels?.join(', ') || null;

    try {
      const db = req.app.get('database');
      const svc = new CustomerService(db);
      await svc.updateVerificationStatus(externalUserId, internalStatus, {
        applicantId,
        rejectionReason,
      });

      logger.info('[SumSub] Verification status updated', {
        stellarAccount: externalUserId,
        status: internalStatus,
        applicantId,
      });

      return res.status(200).json({ received: true });
    } catch (err) {
      logger.error('[SumSub] Failed to update verification status', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
