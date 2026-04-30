/**
 * Database Credential Manager
 * 
 * Manages dynamic database credentials from HashiCorp Vault with automatic rotation.
 * Credentials are automatically refreshed every 24 hours (or 1 hour before expiry).
 * This ensures that production secrets are never long-lived and are automatically rotated.
 */

const { Pool } = require('pg');
const { getVaultService } = require('./vaultService');
const { getPgPoolConfig } = require('../database/poolConfig');

class DatabaseCredentialManager {
  constructor(options = {}) {
    this.vaultService = options.vaultService || null;
    this.rotationInterval = options.rotationInterval || 24 * 60 * 60 * 1000; // 24 hours
    this.rotationTimer = null;
    this.currentCredentials = null;
    this.currentPool = null;
    this.isRotating = false;
  }

  /**
   * Initialize the credential manager
   */
  async initialize() {
    if (!this.vaultService) {
      console.warn('[DatabaseCredentialManager] Vault service not provided, using static credentials');
      return;
    }

    try {
      await this.vaultService.initialize();
      await this.rotateCredentials();
      this.startRotationTimer();
      console.log('[DatabaseCredentialManager] Initialized with dynamic credentials');
    } catch (error) {
      console.error('[DatabaseCredentialManager] Initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * Start the automatic rotation timer
   */
  startRotationTimer() {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
    }

    this.rotationTimer = setInterval(async () => {
      try {
        await this.rotateCredentials();
        console.log('[DatabaseCredentialManager] Credentials rotated successfully');
      } catch (error) {
        console.error('[DatabaseCredentialManager] Rotation failed:', error.message);
      }
    }, this.rotationInterval);

    console.log(`[DatabaseCredentialManager] Rotation timer started (interval: ${this.rotationInterval}ms)`);
  }

  /**
   * Rotate database credentials
   */
  async rotateCredentials() {
    if (this.isRotating) {
      console.log('[DatabaseCredentialManager] Rotation already in progress, skipping');
      return;
    }

    this.isRotating = true;

    try {
      // Get new credentials from Vault
      const newCredentials = await this.vaultService.loadDatabaseCredentials();

      if (!newCredentials || !newCredentials.username || !newCredentials.password) {
        throw new Error('Invalid credentials received from Vault');
      }

      console.log('[DatabaseCredentialManager] New credentials received from Vault');

      // Close existing pool if it exists
      if (this.currentPool) {
        try {
          await this.currentPool.end();
          console.log('[DatabaseCredentialManager] Old connection pool closed');
        } catch (error) {
          console.error('[DatabaseCredentialManager] Error closing old pool:', error.message);
        }
      }

      // Create new connection pool with fresh credentials
      this.currentCredentials = newCredentials;
      this.currentPool = new Pool({
        user: newCredentials.username,
        password: newCredentials.password,
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || 'substream',
        ...getPgPoolConfig(),
      });

      this.currentPool.on('error', (error) => {
        console.error('[DatabaseCredentialManager] Unexpected PostgreSQL pool error:', error.message);
      });

      // Test the new connection
      const client = await this.currentPool.connect();
      await client.query('SELECT 1');
      client.release();

      console.log('[DatabaseCredentialManager] New connection pool created and tested');
    } catch (error) {
      console.error('[DatabaseCredentialManager] Credential rotation failed:', error.message);
      throw error;
    } finally {
      this.isRotating = false;
    }
  }

  /**
   * Get the current connection pool
   */
  getPool() {
    if (!this.currentPool) {
      throw new Error('Database pool not initialized. Call initialize() first.');
    }
    return this.currentPool;
  }

  /**
   * Get current credentials (for debugging only)
   */
  getCurrentCredentials() {
    return this.currentCredentials;
  }

  /**
   * Manually trigger credential rotation
   */
  async manualRotation() {
    console.log('[DatabaseCredentialManager] Manual rotation triggered');
    await this.rotateCredentials();
  }

  /**
   * Stop the credential manager
   */
  async stop() {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }

    if (this.currentPool) {
      try {
        await this.currentPool.end();
        console.log('[DatabaseCredentialManager] Connection pool closed');
      } catch (error) {
        console.error('[DatabaseCredentialManager] Error closing pool:', error.message);
      }
      this.currentPool = null;
    }

    console.log('[DatabaseCredentialManager] Stopped');
  }

  /**
   * Check if credentials need rotation based on expiry time
   */
  shouldRotate() {
    if (!this.currentCredentials || !this.currentCredentials.leaseDuration) {
      return true;
    }

    const expiryTime = Date.now() + (this.currentCredentials.leaseDuration * 1000);
    const rotateBefore = expiryTime - (60 * 60 * 1000); // Rotate 1 hour before expiry

    return Date.now() >= rotateBefore;
  }

  /**
   * Get time until next rotation
   */
  getTimeUntilRotation() {
    if (!this.currentCredentials || !this.currentCredentials.leaseDuration) {
      return 0;
    }

    const expiryTime = Date.now() + (this.currentCredentials.leaseDuration * 1000);
    const rotateBefore = expiryTime - (60 * 60 * 1000); // Rotate 1 hour before expiry

    return Math.max(0, rotateBefore - Date.now());
  }
}

// Singleton instance
let credentialManagerInstance = null;

/**
 * Get or create the DatabaseCredentialManager singleton
 */
function getDatabaseCredentialManager(options = {}) {
  if (!credentialManagerInstance) {
    credentialManagerInstance = new DatabaseCredentialManager(options);
  }
  return credentialManagerInstance;
}

/**
 * Reset the DatabaseCredentialManager singleton (useful for testing)
 */
function resetDatabaseCredentialManager() {
  if (credentialManagerInstance) {
    credentialManagerInstance.stop().catch(err => {
      console.error('[DatabaseCredentialManager] Error during cleanup:', err.message);
    });
  }
  credentialManagerInstance = null;
}

module.exports = {
  DatabaseCredentialManager,
  getDatabaseCredentialManager,
  resetDatabaseCredentialManager
};
