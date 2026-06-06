const StellarSdk = require("@stellar/stellar-sdk");
const SandboxService = require('./sandboxService');

class StellarAuthService {
  constructor() {
    this.sandboxService = new SandboxService();
    this.challenges = new Map(); // In production, use Redis
    this.initializeConfig();
  }

  async initializeConfig() {
    await this.sandboxService.initialize();
    const stellarConfig = this.sandboxService.getStellarConfig();
    
    this.networkPassphrase = stellarConfig.networkPassphrase;
    this.serverUrl = stellarConfig.horizonUrl;
    this.server = new StellarSdk.Horizon.Server(this.serverUrl);
    
    console.log('[StellarAuth] Initialized with config:', {
      network: this.networkPassphrase.includes('Test') ? 'testnet' : 'mainnet',
      url: this.serverUrl,
      sandbox: this.sandboxService.isSandboxMode
    });
  }

  /**
   * Generate SEP-10 challenge for Stellar authentication
   * @param {string} publicKey - Stellar public key
   * @param {string} domain - Server domain
   * @returns {Object} Challenge transaction details
   */
  async generateChallenge(publicKey, domain = "substream.app") {
    try {
      // Validate public key format
      const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);

      // Generate nonce
      const nonce = this.generateNonce();

      // Create challenge transaction
      const account = await this.server.loadAccount(publicKey);

      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
        timebounds: {
          minTime: Math.floor(Date.now() / 1000),
          maxTime: Math.floor(Date.now() / 1000) + 300, // 5 minutes
        },
      })
        .addOperation(
          StellarSdk.Operation.manageData({
            name: `${domain} auth`,
            value: nonce,
            source: publicKey,
          }),
        )
        .build();

      // Store challenge details
      this.challenges.set(publicKey, {
        nonce,
        transactionHash: transaction.hash(),
        timestamp: Date.now(),
        used: false,
      });

      return {
        success: true,
        challenge: transaction.toXDR(),
        nonce,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
    } catch (error) {
      console.error("Error generating challenge:", error);
      throw new Error("Failed to generate challenge");
    }
  }

  /**
   * Verify SEP-10 challenge signature
   * @param {string} challengeXDR - Signed challenge transaction XDR
   * @param {string} publicKey - Stellar public key
   * @returns {Object} Verification result
   */
  async verifyChallenge(challengeXDR, publicKey) {
    try {
      // Parse the signed transaction
      const transaction = StellarSdk.TransactionBuilder.fromXDR(
        challengeXDR,
        this.networkPassphrase,
      );

      // Verify the transaction structure
      if (transaction.operations.length !== 1) {
        throw new Error("Invalid transaction structure");
      }

      const operation = transaction.operations[0];

      // Verify it's a manageData operation
      if (operation.type !== "manageData") {
        throw new Error("Invalid operation type");
      }

      // Verify the operation source account
      if (operation.source !== publicKey) {
        throw new Error("Operation source does not match public key");
      }

      // Verify the operation name matches our domain
      const expectedName = `${process.env.DOMAIN || "substream.app"} auth`;
      if (operation.name !== expectedName) {
        throw new Error("Invalid operation name");
      }

      // Get stored challenge
      const storedChallenge = this.challenges.get(publicKey);

      if (!storedChallenge || storedChallenge.used) {
        throw new Error("Challenge not found or already used");
      }

      // Verify nonce matches
      const nonce = operation.value.toString("base64");
      if (nonce !== storedChallenge.nonce) {
        throw new Error("Nonce mismatch");
      }

      // Verify challenge expiration (5 minutes)
      if (Date.now() - storedChallenge.timestamp > 5 * 60 * 1000) {
        this.challenges.delete(publicKey);
        throw new Error("Challenge expired");
      }

      // Verify transaction signature
      const hash = transaction.hash();
      const signatures = transaction.signatures;

      if (signatures.length === 0) {
        throw new Error("No signatures found");
      }

      // Verify the signature using the public key
      const keypair = StellarSdk.Keypair.fromPublicKey(publicKey);
      const isValid = keypair.verify(hash, signatures[0].signature());

      if (!isValid) {
        throw new Error("Invalid signature");
      }

      // Mark challenge as used
      storedChallenge.used = true;

      // Check if account is active and not merged
      await this.verifyAccountStatus(publicKey);

      return {
        success: true,
        publicKey: publicKey.toLowerCase(),
        verified: true,
      };
    } catch (error) {
      console.error("Error verifying challenge:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify Stellar account status (active, not merged)
   * @param {string} publicKey - Stellar public key
   */
  async verifyAccountStatus(publicKey) {
    try {
      const account = await this.server.loadAccount(publicKey);

      // Check if account is merged (has no balance and no operations)
      if (account.balance() === "0" && account.sequence === "0") {
        throw new Error("Account appears to be merged");
      }

      // Additional checks can be added here
      return true;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        throw new Error("Account not found");
      }
      throw error;
    }
  }

  /**
   * Generate secure nonce for challenge
   * @returns {string} Random nonce
   */
  generateNonce() {
    return StellarSdk.StrKey.encodeEd25519PublicKey(
      StellarSdk.Keypair.random().publicKey(),
    ).substring(0, 32);
  }

  /**
   * Clean up expired challenges
   */
  cleanupExpiredChallenges() {
    const now = Date.now();
    for (const [publicKey, challenge] of this.challenges.entries()) {
      if (now - challenge.timestamp > 5 * 60 * 1000) {
        // 5 minutes
        this.challenges.delete(publicKey);
      }
    }
  }

  /**
   * Get challenge status
   * @param {string} publicKey - Stellar public key
   */
  getChallengeStatus(publicKey) {
    const challenge = this.challenges.get(publicKey);
    if (!challenge) {
      return { exists: false };
    }

    return {
      exists: true,
      used: challenge.used,
      expired: Date.now() - challenge.timestamp > 5 * 60 * 1000,
      timestamp: challenge.timestamp,
    };
  }
}

module.exports = StellarAuthService;
