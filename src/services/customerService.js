'use strict';

/**
 * SEP-12 Customer Service
 *
 * Implements the core KYC business logic:
 *  - getCustomer(stellarAccount, merchantId, tierName)
 *      Returns the customer's SEP-12 status with requirement masking applied.
 *      If the merchant requires fields that are missing the status is NEEDS_INFO
 *      regardless of the stored verification_status.
 *
 *  - putCustomer(stellarAccount, fields)
 *      Upserts encrypted PII fields and resets status to NEEDS_INFO so the
 *      SumSub webhook can re-approve after new data is submitted.
 *
 *  - setMerchantRequirements(merchantId, tierName, requirements)
 *      Upserts the field-requirement matrix for a merchant/tier.
 *
 *  - updateVerificationStatus(stellarAccount, status, extra)
 *      Called by the SumSub webhook handler to update status asynchronously.
 */

const { getKycEncryptionService } = require('./kycEncryptionService');
const logger = require('../utils/logger');

// SEP-12 status values
const STATUS = {
  NEEDS_INFO: 'NEEDS_INFO',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
};

class CustomerService {
  /**
   * @param {import('knex').Knex} db
   */
  constructor(db) {
    this.db = db;
    this.enc = getKycEncryptionService();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * GET /customer — returns masked SEP-12 customer record.
   *
   * @param {string} stellarAccount
   * @param {string|null} merchantId  – when provided, requirement masking is applied
   * @param {string|null} tierName
   * @returns {Promise<object>} SEP-12 GET /customer response body
   */
  async getCustomer(stellarAccount, merchantId = null, tierName = null) {
    const profile = await this.db('customer_profiles')
      .where({ stellar_account: stellarAccount })
      .first();

    if (!profile) {
      // SEP-12: unknown customer → NEEDS_INFO with all fields required
      return {
        id: null,
        status: STATUS.NEEDS_INFO,
        fields: this._allFieldDescriptors('optional'),
      };
    }

    // Decrypt PII to determine which fields are present
    const present = await this._presentFields(profile);

    // Apply requirement masking
    let effectiveStatus = profile.verification_status;
    let missingFields = {};

    if (merchantId && tierName) {
      const reqs = await this._getRequirements(merchantId, tierName);
      missingFields = this._computeMissingFields(present, reqs);
      if (Object.keys(missingFields).length > 0) {
        effectiveStatus = STATUS.NEEDS_INFO;
      }
    }

    return {
      id: profile.id,
      status: effectiveStatus,
      ...(effectiveStatus === STATUS.REJECTED && { message: profile.rejection_reason }),
      fields: Object.keys(missingFields).length > 0 ? missingFields : undefined,
      provided_fields: Object.keys(present).filter((k) => present[k]),
    };
  }

  /**
   * PUT /customer — upsert encrypted PII fields.
   *
   * @param {string} stellarAccount
   * @param {object} fields  { full_name?, address?, date_of_birth?, id_photo_cid? }
   * @returns {Promise<object>} { id, status }
   */
  async putCustomer(stellarAccount, fields) {
    const encFields = await this._encryptFields(fields);

    const existing = await this.db('customer_profiles')
      .where({ stellar_account: stellarAccount })
      .first();

    if (existing) {
      await this.db('customer_profiles')
        .where({ stellar_account: stellarAccount })
        .update({
          ...encFields,
          // Re-open for review only if currently APPROVED/REJECTED
          verification_status:
            existing.verification_status === STATUS.APPROVED ||
            existing.verification_status === STATUS.REJECTED
              ? STATUS.NEEDS_INFO
              : existing.verification_status,
          updated_at: new Date().toISOString(),
        });
      return { id: existing.id, status: STATUS.NEEDS_INFO };
    }

    const [id] = await this.db('customer_profiles').insert({
      stellar_account: stellarAccount,
      ...encFields,
      verification_status: STATUS.NEEDS_INFO,
    });

    // SQLite returns the rowid; Postgres returns the id string via returning()
    const created = await this.db('customer_profiles')
      .where({ stellar_account: stellarAccount })
      .first();

    return { id: created.id, status: STATUS.NEEDS_INFO };
  }

  /**
   * Upsert merchant KYC requirements for a tier.
   *
   * @param {string} merchantId
   * @param {string} tierName
   * @param {{ requires_full_name?, requires_address?, requires_date_of_birth?, requires_id_photo? }} requirements
   */
  async setMerchantRequirements(merchantId, tierName, requirements) {
    const existing = await this.db('merchant_kyc_requirements')
      .where({ merchant_id: merchantId, tier_name: tierName })
      .first();

    if (existing) {
      await this.db('merchant_kyc_requirements')
        .where({ merchant_id: merchantId, tier_name: tierName })
        .update({ ...requirements, updated_at: new Date().toISOString() });
    } else {
      await this.db('merchant_kyc_requirements').insert({
        merchant_id: merchantId,
        tier_name: tierName,
        ...requirements,
      });
    }
  }

  /**
   * Called by the SumSub webhook to update verification status.
   *
   * @param {string} stellarAccount
   * @param {string} status  APPROVED | REJECTED | PENDING
   * @param {{ applicantId?: string, rejectionReason?: string }} extra
   */
  async updateVerificationStatus(stellarAccount, status, extra = {}) {
    if (!Object.values(STATUS).includes(status)) {
      throw new Error(`Invalid status: ${status}`);
    }

    const update = {
      verification_status: status,
      updated_at: new Date().toISOString(),
    };
    if (extra.applicantId) update.sumsub_applicant_id = extra.applicantId;
    if (extra.rejectionReason) update.rejection_reason = extra.rejectionReason;

    const rows = await this.db('customer_profiles')
      .where({ stellar_account: stellarAccount })
      .update(update);

    if (rows === 0) {
      logger.warn('[CustomerService] updateVerificationStatus: account not found', { stellarAccount });
    }
    return rows;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async _encryptFields(fields) {
    const map = {
      full_name: 'enc_full_name',
      address: 'enc_address',
      date_of_birth: 'enc_date_of_birth',
      id_photo_cid: 'enc_id_photo_cid',
    };
    const result = {};
    for (const [plain, enc] of Object.entries(map)) {
      if (fields[plain] !== undefined) {
        result[enc] = fields[plain] ? await this.enc.encrypt(fields[plain]) : null;
      }
    }
    return result;
  }

  async _presentFields(profile) {
    return {
      full_name: !!profile.enc_full_name,
      address: !!profile.enc_address,
      date_of_birth: !!profile.enc_date_of_birth,
      id_photo_cid: !!profile.enc_id_photo_cid,
    };
  }

  async _getRequirements(merchantId, tierName) {
    return this.db('merchant_kyc_requirements')
      .where({ merchant_id: merchantId, tier_name: tierName })
      .first();
  }

  _computeMissingFields(present, reqs) {
    if (!reqs) return {};
    const missing = {};
    if (reqs.requires_full_name && !present.full_name) {
      missing.full_name = { description: 'Full legal name', optional: false };
    }
    if (reqs.requires_address && !present.address) {
      missing.address = { description: 'Residential address', optional: false };
    }
    if (reqs.requires_date_of_birth && !present.date_of_birth) {
      missing.date_of_birth = { description: 'Date of birth (YYYY-MM-DD)', optional: false };
    }
    if (reqs.requires_id_photo && !present.id_photo_cid) {
      missing.id_photo_cid = { description: 'IPFS CID of government-issued ID photo', optional: false };
    }
    return missing;
  }

  _allFieldDescriptors(optionality) {
    const optional = optionality === 'optional';
    return {
      full_name: { description: 'Full legal name', optional },
      address: { description: 'Residential address', optional },
      date_of_birth: { description: 'Date of birth (YYYY-MM-DD)', optional },
      id_photo_cid: { description: 'IPFS CID of government-issued ID photo', optional },
    };
  }
}

module.exports = { CustomerService, STATUS };
