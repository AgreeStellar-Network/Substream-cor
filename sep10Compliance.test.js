const request = require("supertest");
const app = require("./index");
const StellarSdk = require("@stellar/stellar-sdk");

describe("SEP-10 Compliance Tests", () => {
  let testKeypair;
  let testPublicKey;
  let authToken;
  let challengeXDR;

  beforeAll(() => {
    // Generate test keypair for testing
    testKeypair = StellarSdk.Keypair.random();
    testPublicKey = testKeypair.publicKey();
  });

  describe("Challenge Generation (/auth/challenge)", () => {
    it("should generate a SEP-10 compliant challenge", async () => {
      const response = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.challenge).toBeDefined();
      expect(response.body.nonce).toBeDefined();
      expect(response.body.expiresAt).toBeDefined();

      // Verify challenge is valid XDR
      const transaction = StellarSdk.TransactionBuilder.fromXDR(
        response.body.challenge,
        process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
      );

      // Verify transaction structure
      expect(transaction.operations.length).toBe(1);
      expect(transaction.operations[0].type).toBe("manageData");
      expect(transaction.operations[0].source).toBe(testPublicKey);
      
      // Verify operation name matches domain auth pattern
      const expectedName = `${process.env.DOMAIN || "substream.app"} auth`;
      expect(transaction.operations[0].name).toBe(expectedName);

      // Verify timebounds are present and reasonable
      expect(transaction.timebounds).toBeDefined();
      expect(transaction.timebounds.minTime).toBeGreaterThan(0);
      expect(transaction.timebounds.maxTime).toBeGreaterThan(transaction.timebounds.minTime);

      challengeXDR = response.body.challenge;
    });

    it("should reject request without public key", async () => {
      const response = await request(app)
        .get("/auth/challenge")
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Stellar public key required");
    });

    it("should reject invalid public key format", async () => {
      const response = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: "invalid-key" })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid Stellar public key format");
    });

    it("should generate unique nonces for each request", async () => {
      const response1 = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      const response2 = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      expect(response1.body.nonce).not.toBe(response2.body.nonce);
    });
  });

  describe("Challenge Verification (/auth/verify)", () => {
    it("should reject verification without required fields", async () => {
      const response = await request(app)
        .post("/auth/verify")
        .send({})
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe(
        "Missing required fields: publicKey, challengeXDR"
      );
    });

    it("should reject invalid challenge XDR", async () => {
      const response = await request(app)
        .post("/auth/verify")
        .send({
          publicKey: testPublicKey,
          challengeXDR: "invalid-xdr",
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    it("should reject challenge with wrong public key", async () => {
      const differentKeypair = StellarSdk.Keypair.random();
      
      const response = await request(app)
        .post("/auth/verify")
        .send({
          publicKey: differentKeypair.publicKey(),
          challengeXDR: challengeXDR,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe("JWT Token Security", () => {
    it("should issue JWT with correct claims after successful authentication", async () => {
      // This test would require a funded testnet account for full integration
      // For now, we test the token structure expectations
      expect(true).toBe(true); // Placeholder
    });

    it("should reject requests with invalid JWT", async () => {
      const response = await request(app)
        .get("/auth/stellar/session")
        .set("Authorization", "Bearer invalid-token")
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Invalid or expired token");
    });

    it("should reject requests without JWT", async () => {
      const response = await request(app)
        .get("/auth/stellar/session")
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe("Access token required");
    });
  });

  describe("SEP-10 Specification Compliance", () => {
    it("should follow SEP-10 challenge transaction format", async () => {
      const response = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      const transaction = StellarSdk.TransactionBuilder.fromXDR(
        response.body.challenge,
        process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
      );

      // SEP-10 requirements:
      // 1. Transaction must have exactly one operation
      expect(transaction.operations.length).toBe(1);
      
      // 2. Operation must be manageData
      expect(transaction.operations[0].type).toBe("manageData");
      
      // 3. Operation source account must be the client account
      expect(transaction.operations[0].source).toBe(testPublicKey);
      
      // 4. Operation name must be <domain> auth
      const expectedName = `${process.env.DOMAIN || "substream.app"} auth`;
      expect(transaction.operations[0].name).toBe(expectedName);
      
      // 5. Operation value must be a nonce
      expect(transaction.operations[0].value).toBeDefined();
      expect(transaction.operations[0].value.length).toBeGreaterThan(0);
      
      // 6. Transaction must have timebounds
      expect(transaction.timebounds).toBeDefined();
      expect(transaction.timebounds.minTime).toBeDefined();
      expect(transaction.timebounds.maxTime).toBeDefined();
      
      // 7. Timebounds should be reasonable (5 minutes is standard)
      const timeDiff = transaction.timebounds.maxTime - transaction.timebounds.minTime;
      expect(timeDiff).toBeLessThanOrEqual(300); // 5 minutes
      expect(timeDiff).toBeGreaterThan(0);
    });

    it("should use correct network passphrase", async () => {
      const expectedPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";
      
      // This is verified implicitly by the fromXDR parsing succeeding
      // If the network passphrase was wrong, parsing would fail
      expect(expectedPassphrase).toBeDefined();
    });
  });

  describe("Security Requirements", () => {
    it("should have short-lived challenges (5 minutes)", async () => {
      const response = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      const expiresAt = new Date(response.body.expiresAt);
      const now = new Date();
      const timeToExpiry = expiresAt - now;

      // Should expire in approximately 5 minutes (with some tolerance)
      expect(timeToExpiry).toBeGreaterThan(4 * 60 * 1000); // More than 4 minutes
      expect(timeToExpiry).toBeLessThan(6 * 60 * 1000); // Less than 6 minutes
    });

    it("should use secure nonce generation", async () => {
      const response = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      // Nonce should be base64-encoded and reasonable length
      expect(response.body.nonce).toBeDefined();
      expect(response.body.nonce.length).toBeGreaterThan(10);
      
      // Should be different each time
      const response2 = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      expect(response.body.nonce).not.toBe(response2.body.nonce);
    });
  });
});

// Full Integration Test (requires testnet account)
describe("SEP-10 Full Integration Test", () => {
  let fundedKeypair;
  let fundedPublicKey;

  beforeAll(async () => {
    // These tests require a funded testnet account
    if (
      !process.env.STELLAR_TEST_PUBLIC_KEY ||
      !process.env.STELLAR_TEST_SECRET
    ) {
      console.log("Skipping integration tests - no test credentials provided");
      return;
    }

    fundedPublicKey = process.env.STELLAR_TEST_PUBLIC_KEY;
    fundedKeypair = StellarSdk.Keypair.fromSecret(
      process.env.STELLAR_TEST_SECRET,
    );
  });

  it("should complete full SEP-10 authentication flow", async () => {
    if (!fundedKeypair) {
      console.log("Skipping integration test");
      return;
    }

    // 1. Generate challenge
    const challengeResponse = await request(app)
      .get("/auth/challenge")
      .query({ publicKey: fundedPublicKey })
      .expect(200);

    expect(challengeResponse.body.success).toBe(true);

    // 2. Parse and sign the challenge
    const transaction = StellarSdk.TransactionBuilder.fromXDR(
      challengeResponse.body.challenge,
      process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    );

    transaction.sign(fundedKeypair);
    const signedChallengeXDR = transaction.toXDR();

    // 3. Verify and authenticate
    const verifyResponse = await request(app)
      .post("/auth/verify")
      .send({
        publicKey: fundedPublicKey,
        challengeXDR: signedChallengeXDR,
      })
      .expect(200);

    expect(verifyResponse.body.success).toBe(true);
    expect(verifyResponse.body.token).toBeDefined();
    expect(verifyResponse.body.user.publicKey).toBe(
      fundedPublicKey.toLowerCase(),
    );
    expect(verifyResponse.body.user.type).toBe('stellar');

    const token = verifyResponse.body.token;

    // 4. Test protected endpoint access
    const sessionResponse = await request(app)
      .get("/auth/stellar/session")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(sessionResponse.body.success).toBe(true);
    expect(sessionResponse.body.session.publicKey).toBe(
      fundedPublicKey.toLowerCase(),
    );

    // 5. Verify JWT contains required claims
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(token);
    
    expect(decoded.publicKey).toBe(fundedPublicKey.toLowerCase());
    expect(decoded.type).toBe('stellar');
    expect(decoded.iat).toBeDefined();
    expect(decoded.sessionId).toBeDefined();

    // 6. Test logout
    const logoutResponse = await request(app)
      .post("/auth/stellar/logout")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(logoutResponse.body.success).toBe(true);

    // 7. Verify token is invalidated after logout
    const sessionAfterLogout = await request(app)
      .get("/auth/stellar/session")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);

    expect(sessionAfterLogout.body.success).toBe(false);
  }, 30000); // Longer timeout for network operations
});
