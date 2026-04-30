'use strict';

/**
 * KYC Encryption Service
 *
 * Encrypts / decrypts PII fields using AES-256-GCM.
 * The encryption key is sourced from HashiCorp Vault when VAULT_ENABLED=true,
 * falling back to the KYC_ENCRYPTION_KEY environment variable for local dev.
 *
 * Ciphertext format (base64-encoded, colon-delimited):
 *   <iv_hex>:<authTag_hex>:<ciphertext_hex>
 */

const crypto = require('crypto');
const { getVaultService } = require('./vaultService');
const logger = require('../utils/logger');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits

class KycEncryptionService {
  constructor() {
    this._key = null;
  }

  /**
   * Lazily resolve the AES key.
   * Vault is preferred; env var is the fallback.
   */
  async _getKey() {
    if (this._key) return this._key;

    if (process.env.VAULT_ENABLED === 'true') {
      try {
        const vault = getVaultService();
        if (!vault.initialized) await vault.initialize();
        const secret = vault.getSecret('KYC_ENCRYPTION_KEY');
        if (secret) {
          this._key = Buffer.from(secret, 'hex');
          if (this._key.length !== KEY_LENGTH) {
            throw new Error('Vault KYC_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
          }
          return this._key;
        }
      } catch (err) {
        logger.warn('[KycEncryption] Vault key fetch failed, falling back to env', { error: err.message });
      }
    }

    const envKey = process.env.KYC_ENCRYPTION_KEY;
    if (!envKey) {
      throw new Error('KYC_ENCRYPTION_KEY is not set. Provide it via Vault or environment variable.');
    }
    this._key = Buffer.from(envKey, 'hex');
    if (this._key.length !== KEY_LENGTH) {
      throw new Error('KYC_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
    }
    return this._key;
  }

  /**
   * Encrypt a plaintext string.
   * @param {string} plaintext
   * @returns {Promise<string>} "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
   */
  async encrypt(plaintext) {
    if (plaintext == null) return null;
    const key = await this._getKey();
    const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt a ciphertext produced by encrypt().
   * @param {string} ciphertext "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
   * @returns {Promise<string>}
   */
  async decrypt(ciphertext) {
    if (ciphertext == null) return null;
    const key = await this._getKey();
    const parts = ciphertext.split(':');
    if (parts.length !== 3) throw new Error('Invalid ciphertext format');
    const [ivHex, authTagHex, encHex] = parts;
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /** Invalidate cached key (e.g. after Vault rotation). */
  resetKey() {
    this._key = null;
  }
}

// Singleton
let instance = null;
function getKycEncryptionService() {
  if (!instance) instance = new KycEncryptionService();
  return instance;
}

module.exports = { KycEncryptionService, getKycEncryptionService };
