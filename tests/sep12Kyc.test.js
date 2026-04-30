'use strict';

/**
 * Tests for SEP-12 KYC layer:
 *  - KycEncryptionService  (encrypt / decrypt round-trip)
 *  - CustomerService       (getCustomer, putCustomer, requirement masking,
 *                           updateVerificationStatus, setMerchantRequirements)
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

// Prevent VaultService from trying to reach a real Vault instance
jest.mock('../src/services/vaultService', () => ({
  getVaultService: jest.fn(() => ({
    initialized: false,
    initialize: jest.fn().mockResolvedValue(undefined),
    getSecret: jest.fn().mockReturnValue(null),
  })),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

// 32-byte hex key for tests
const TEST_KEY = 'a'.repeat(64);

function makeDb(overrides = {}) {
  const rows = { customer_profiles: [], merchant_kyc_requirements: [] };

  const tableProxy = (tableName) => {
    const chain = {
      _table: tableName,
      _where: {},
      where(cond) { this._where = { ...this._where, ...cond }; return this; },
      first() {
        const match = rows[this._table].find((r) =>
          Object.entries(this._where).every(([k, v]) => r[k] === v)
        );
        return Promise.resolve(match || null);
      },
      insert(data) {
        const row = { id: `id-${Date.now()}-${Math.random()}`, ...data };
        rows[this._table].push(row);
        return Promise.resolve([row.id]);
      },
      update(data) {
        let count = 0;
        rows[this._table] = rows[this._table].map((r) => {
          if (Object.entries(this._where).every(([k, v]) => r[k] === v)) {
            count++;
            return { ...r, ...data };
          }
          return r;
        });
        return Promise.resolve(count);
      },
    };
    return chain;
  };

  const db = jest.fn((tableName) => tableProxy(tableName));
  db._rows = rows;
  Object.assign(db, overrides);
  return db;
}

// ── KycEncryptionService ───────────────────────────────────────────────────

describe('KycEncryptionService', () => {
  let KycEncryptionService;

  beforeEach(() => {
    jest.resetModules();
    process.env.KYC_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.VAULT_ENABLED;
    ({ KycEncryptionService } = require('../src/services/kycEncryptionService'));
  });

  it('encrypts and decrypts a string round-trip', async () => {
    const svc = new KycEncryptionService();
    const plaintext = 'Alice Wonderland';
    const cipher = await svc.encrypt(plaintext);
    expect(cipher).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    const decrypted = await svc.decrypt(cipher);
    expect(decrypted).toBe(plaintext);
  });

  it('returns null for null input', async () => {
    const svc = new KycEncryptionService();
    expect(await svc.encrypt(null)).toBeNull();
    expect(await svc.decrypt(null)).toBeNull();
  });

  it('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const svc = new KycEncryptionService();
    const c1 = await svc.encrypt('hello');
    const c2 = await svc.encrypt('hello');
    expect(c1).not.toBe(c2);
  });

  it('throws when key is missing', async () => {
    delete process.env.KYC_ENCRYPTION_KEY;
    const svc = new KycEncryptionService();
    await expect(svc.encrypt('test')).rejects.toThrow('KYC_ENCRYPTION_KEY');
  });

  it('throws on invalid ciphertext format', async () => {
    const svc = new KycEncryptionService();
    await expect(svc.decrypt('notvalidformat')).rejects.toThrow('Invalid ciphertext format');
  });
});

// ── CustomerService ────────────────────────────────────────────────────────

describe('CustomerService', () => {
  let CustomerService, STATUS;

  beforeEach(() => {
    jest.resetModules();
    process.env.KYC_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.VAULT_ENABLED;
    ({ CustomerService, STATUS } = require('../src/services/customerService'));
  });

  const ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

  describe('putCustomer', () => {
    it('creates a new profile and returns NEEDS_INFO', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      const result = await svc.putCustomer(ACCOUNT, { full_name: 'Alice' });
      expect(result.status).toBe(STATUS.NEEDS_INFO);
      expect(result.id).toBeDefined();
    });

    it('updates an existing profile', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      await svc.putCustomer(ACCOUNT, { full_name: 'Alice' });
      const result = await svc.putCustomer(ACCOUNT, { address: '123 Main St' });
      expect(result.status).toBe(STATUS.NEEDS_INFO);
    });

    it('resets APPROVED status to NEEDS_INFO on update', async () => {
      const db = makeDb();
      // Seed an approved profile
      db._rows.customer_profiles.push({
        id: 'existing-id',
        stellar_account: ACCOUNT,
        enc_full_name: null,
        enc_address: null,
        enc_date_of_birth: null,
        enc_id_photo_cid: null,
        verification_status: STATUS.APPROVED,
        sumsub_applicant_id: null,
        rejection_reason: null,
      });
      const svc = new CustomerService(db);
      const result = await svc.putCustomer(ACCOUNT, { full_name: 'Bob' });
      expect(result.status).toBe(STATUS.NEEDS_INFO);
    });
  });

  describe('getCustomer', () => {
    it('returns NEEDS_INFO with field descriptors for unknown account', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      const result = await svc.getCustomer(ACCOUNT);
      expect(result.status).toBe(STATUS.NEEDS_INFO);
      expect(result.fields).toBeDefined();
    });

    it('returns stored status when no merchant requirements', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      await svc.putCustomer(ACCOUNT, { full_name: 'Alice' });
      await svc.updateVerificationStatus(ACCOUNT, STATUS.APPROVED);
      const result = await svc.getCustomer(ACCOUNT);
      expect(result.status).toBe(STATUS.APPROVED);
    });
  });

  describe('requirement masking', () => {
    it('returns NEEDS_INFO when required id_photo is missing', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);

      // Set Tier_2 requirements: id_photo required
      await svc.setMerchantRequirements('merchant-1', 'Tier_2', {
        requires_full_name: true,
        requires_id_photo: true,
      });

      // Customer has only full_name
      await svc.putCustomer(ACCOUNT, { full_name: 'Alice' });
      await svc.updateVerificationStatus(ACCOUNT, STATUS.APPROVED);

      const result = await svc.getCustomer(ACCOUNT, 'merchant-1', 'Tier_2');
      expect(result.status).toBe(STATUS.NEEDS_INFO);
      expect(result.fields).toHaveProperty('id_photo_cid');
    });

    it('returns APPROVED when all required fields are present', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);

      await svc.setMerchantRequirements('merchant-1', 'Tier_1', {
        requires_full_name: true,
      });

      await svc.putCustomer(ACCOUNT, { full_name: 'Alice' });
      await svc.updateVerificationStatus(ACCOUNT, STATUS.APPROVED);

      const result = await svc.getCustomer(ACCOUNT, 'merchant-1', 'Tier_1');
      expect(result.status).toBe(STATUS.APPROVED);
      expect(result.fields).toBeUndefined();
    });

    it('ignores masking when no merchant requirements are configured', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);

      await svc.putCustomer(ACCOUNT, { full_name: 'Alice' });
      await svc.updateVerificationStatus(ACCOUNT, STATUS.APPROVED);

      // merchant-99 has no requirements row
      const result = await svc.getCustomer(ACCOUNT, 'merchant-99', 'Tier_1');
      expect(result.status).toBe(STATUS.APPROVED);
    });
  });

  describe('updateVerificationStatus', () => {
    it('updates status to APPROVED', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      await svc.putCustomer(ACCOUNT, { full_name: 'Alice' });
      await svc.updateVerificationStatus(ACCOUNT, STATUS.APPROVED, { applicantId: 'app-123' });
      const result = await svc.getCustomer(ACCOUNT);
      expect(result.status).toBe(STATUS.APPROVED);
    });

    it('updates status to REJECTED with reason', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      await svc.putCustomer(ACCOUNT, { full_name: 'Alice' });
      await svc.updateVerificationStatus(ACCOUNT, STATUS.REJECTED, {
        rejectionReason: 'Document expired',
      });
      const result = await svc.getCustomer(ACCOUNT);
      expect(result.status).toBe(STATUS.REJECTED);
      expect(result.message).toBe('Document expired');
    });

    it('throws on invalid status', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      await expect(svc.updateVerificationStatus(ACCOUNT, 'INVALID')).rejects.toThrow('Invalid status');
    });
  });

  describe('setMerchantRequirements', () => {
    it('creates requirements', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      await svc.setMerchantRequirements('m1', 'Tier_1', { requires_full_name: true });
      expect(db._rows.merchant_kyc_requirements).toHaveLength(1);
    });

    it('updates existing requirements', async () => {
      const db = makeDb();
      const svc = new CustomerService(db);
      await svc.setMerchantRequirements('m1', 'Tier_1', { requires_full_name: true });
      await svc.setMerchantRequirements('m1', 'Tier_1', { requires_full_name: false });
      // Should still be 1 row (updated, not duplicated)
      expect(db._rows.merchant_kyc_requirements).toHaveLength(1);
    });
  });
});
