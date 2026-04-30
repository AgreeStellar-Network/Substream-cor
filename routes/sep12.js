'use strict';

/**
 * SEP-12 Customer Identification Routes
 *
 * GET  /sep12/customer          – retrieve KYC status (with requirement masking)
 * PUT  /sep12/customer          – submit / update PII fields
 * PUT  /sep12/customer/requirements – admin: set merchant KYC requirements
 *
 * All endpoints require a valid JWT (authenticateToken).
 * The authenticated wallet address is used as the Stellar account unless an
 * admin explicitly passes ?account= (future extension).
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { CustomerService } = require('../src/services/customerService');
const logger = require('../src/utils/logger');

// Stellar public key regex (G + 55 uppercase alphanumeric chars)
const STELLAR_ACCOUNT_RE = /^G[A-Z0-9]{55}$/;

function getService(req) {
  const db = req.app.get('database');
  return new CustomerService(db);
}

// ─── GET /sep12/customer ────────────────────────────────────────────────────

/**
 * @query account       Stellar public key (defaults to authenticated user)
 * @query merchant_id   Optional – enables requirement masking
 * @query tier          Optional – tier name for requirement masking
 */
router.get('/customer', authenticateToken, async (req, res) => {
  try {
    const account = req.query.account || req.user?.id;
    if (!account || !STELLAR_ACCOUNT_RE.test(account)) {
      return res.status(400).json({ error: 'Invalid or missing Stellar account' });
    }

    const { merchant_id, tier } = req.query;
    const svc = getService(req);
    const result = await svc.getCustomer(account, merchant_id || null, tier || null);

    return res.json(result);
  } catch (err) {
    logger.error('[SEP-12] GET /customer error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /sep12/customer ────────────────────────────────────────────────────

/**
 * @body account        Stellar public key (defaults to authenticated user)
 * @body full_name      string
 * @body address        string
 * @body date_of_birth  string  YYYY-MM-DD
 * @body id_photo_cid   string  IPFS CID
 */
router.put('/customer', authenticateToken, async (req, res) => {
  try {
    const account = req.body.account || req.user?.id;
    if (!account || !STELLAR_ACCOUNT_RE.test(account)) {
      return res.status(400).json({ error: 'Invalid or missing Stellar account' });
    }

    const { full_name, address, date_of_birth, id_photo_cid } = req.body;
    const fields = {};
    if (full_name !== undefined) fields.full_name = full_name;
    if (address !== undefined) fields.address = address;
    if (date_of_birth !== undefined) fields.date_of_birth = date_of_birth;
    if (id_photo_cid !== undefined) fields.id_photo_cid = id_photo_cid;

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No KYC fields provided' });
    }

    const svc = getService(req);
    const result = await svc.putCustomer(account, fields);

    return res.status(202).json(result);
  } catch (err) {
    logger.error('[SEP-12] PUT /customer error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /sep12/customer/requirements ──────────────────────────────────────

/**
 * Admin endpoint: define which fields a merchant requires for a given tier.
 *
 * @body merchant_id
 * @body tier_name
 * @body requires_full_name       boolean
 * @body requires_address         boolean
 * @body requires_date_of_birth   boolean
 * @body requires_id_photo        boolean
 */
router.put('/customer/requirements', authenticateToken, async (req, res) => {
  try {
    const { merchant_id, tier_name, ...rest } = req.body;
    if (!merchant_id || !tier_name) {
      return res.status(400).json({ error: 'merchant_id and tier_name are required' });
    }

    const allowed = ['requires_full_name', 'requires_address', 'requires_date_of_birth', 'requires_id_photo'];
    const requirements = {};
    for (const key of allowed) {
      if (rest[key] !== undefined) requirements[key] = Boolean(rest[key]);
    }

    const svc = getService(req);
    await svc.setMerchantRequirements(merchant_id, tier_name, requirements);

    return res.json({ success: true, merchant_id, tier_name, requirements });
  } catch (err) {
    logger.error('[SEP-12] PUT /customer/requirements error', { error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
