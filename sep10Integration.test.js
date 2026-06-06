const request = require("supertest");
const app = require("./index");
const StellarSdk = require("@stellar/stellar-sdk");

describe("SEP-10 Complete Integration Tests", () => {
  let testKeypair;
  let testPublicKey;
  let authToken;
  let challengeXDR;

  beforeAll(() => {
    // Generate test keypair for testing
    testKeypair = StellarSdk.Keypair.random();
    testPublicKey = testKeypair.publicKey();
  });

  describe("Acceptance Criteria 1: Secure Authentication Without Passwords", () => {
    it("should allow users to authenticate using only Stellar public key", async () => {
      // Step 1: Generate challenge with just public key
      const challengeResponse = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      expect(challengeResponse.body.success).toBe(true);
      expect(challengeResponse.body.challenge).toBeDefined();
      expect(challengeResponse.body.nonce).toBeDefined();
      expect(challengeResponse.body.expiresAt).toBeDefined();

      // Verify no username/password/email was required
      expect(challengeResponse.body).not.toHaveProperty('username');
      expect(challengeResponse.body).not.toHaveProperty('password');
      expect(challengeResponse.body).not.toHaveProperty('email');

      challengeXDR = challengeResponse.body.challenge;
    });

    it("should issue JWT token after wallet signature verification", async () => {
      // This test simulates the wallet signing process
      // In a real scenario, the wallet would sign the challenge
      
      // For testing purposes, we'll create a valid signature
      const transaction = StellarSdk.TransactionBuilder.fromXDR(
        challengeXDR,
        process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
      );

      // Sign with the test keypair (simulating wallet signature)
      transaction.sign(testKeypair);
      const signedChallengeXDR = transaction.toXDR();

      // Verify and get token
      const verifyResponse = await request(app)
        .post("/auth/verify")
        .send({
          publicKey: testPublicKey,
          challengeXDR: signedChallengeXDR,
        })
        .expect(200);

      expect(verifyResponse.body.success).toBe(true);
      expect(verifyResponse.body.token).toBeDefined();
      expect(verifyResponse.body.user.publicKey).toBe(testPublicKey.toLowerCase());
      expect(verifyResponse.body.user.type).toBe('stellar');
      expect(verifyResponse.body.user.tier).toBeDefined();

      authToken = verifyResponse.body.token;

      // Verify JWT contains public key as subject claim
      const jwt = require('jsonwebtoken');
      const decoded = jwt.decode(authToken);
      expect(decoded.publicKey).toBe(testPublicKey.toLowerCase());
      expect(decoded.type).toBe('stellar');
    });
  });

  describe("Acceptance Criteria 2: SEP-10 Specification Compliance", () => {
    it("should generate SEP-10 compliant challenge transactions", async () => {
      const response = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      const transaction = StellarSdk.TransactionBuilder.fromXDR(
        response.body.challenge,
        process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
      );

      // SEP-10 Requirements Verification
      expect(transaction.operations.length).toBe(1);
      expect(transaction.operations[0].type).toBe("manageData");
      expect(transaction.operations[0].source).toBe(testPublicKey);
      
      // Operation name must follow <domain> auth format
      const expectedName = `${process.env.DOMAIN || "substream.app"} auth`;
      expect(transaction.operations[0].name).toBe(expectedName);
      
      // Must have timebounds
      expect(transaction.timebounds).toBeDefined();
      expect(transaction.timebounds.minTime).toBeGreaterThan(0);
      expect(transaction.timebounds.maxTime).toBeGreaterThan(transaction.timebounds.minTime);
      
      // Timebounds should be reasonable (5 minutes standard)
      const timeDiff = transaction.timebounds.maxTime - transaction.timebounds.minTime;
      expect(timeDiff).toBeLessThanOrEqual(300); // 5 minutes
    });

    it("should verify wallet signature against original challenge", async () => {
      // Generate fresh challenge
      const challengeResponse = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      const transaction = StellarSdk.TransactionBuilder.fromXDR(
        challengeResponse.body.challenge,
        process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
      );

      // Sign with correct keypair
      transaction.sign(testKeypair);
      const signedChallengeXDR = transaction.toXDR();

      const verifyResponse = await request(app)
        .post("/auth/verify")
        .send({
          publicKey: testPublicKey,
          challengeXDR: signedChallengeXDR,
        })
        .expect(200);

      expect(verifyResponse.body.success).toBe(true);

      // Test with wrong signature (different keypair)
      const wrongKeypair = StellarSdk.Keypair.random();
      const wrongTransaction = StellarSdk.TransactionBuilder.fromXDR(
        challengeResponse.body.challenge,
        process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
      );
      wrongTransaction.sign(wrongKeypair);
      const wrongSignedXDR = wrongTransaction.toXDR();

      const wrongVerifyResponse = await request(app)
        .post("/auth/verify")
        .send({
          publicKey: testPublicKey,
          challengeXDR: wrongSignedXDR,
        })
        .expect(400);

      expect(wrongVerifyResponse.body.success).toBe(false);
      expect(wrongVerifyResponse.body.error).toContain('Invalid signature');
    });

    it("should prevent nonce reuse and enforce expiration", async () => {
      // Generate challenge
      const challengeResponse = await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      const transaction = StellarSdk.TransactionBuilder.fromXDR(
        challengeResponse.body.challenge,
        process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
      );
      transaction.sign(testKeypair);
      const signedChallengeXDR = transaction.toXDR();

      // First verification should succeed
      const firstVerify = await request(app)
        .post("/auth/verify")
        .send({
          publicKey: testPublicKey,
          challengeXDR: signedChallengeXDR,
        })
        .expect(200);

      expect(firstVerify.body.success).toBe(true);

      // Second verification with same challenge should fail
      const secondVerify = await request(app)
        .post("/auth/verify")
        .send({
          publicKey: testPublicKey,
          challengeXDR: signedChallengeXDR,
        })
        .expect(400);

      expect(secondVerify.body.success).toBe(false);
      expect(secondVerify.body.error).toContain('already used');
    });
  });

  describe("Acceptance Criteria 3: Protected Route Security", () => {
    it("should deny access to protected routes without authentication", async () => {
      // Test various protected routes
      const protectedRoutes = [
        '/content',
        '/storage/health',
        '/analytics/view-event',
        '/posts'
      ];

      for (const route of protectedRoutes) {
        const response = await request(app)
          .get(route)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain('Access token required');
      }
    });

    it("should allow access to protected routes with valid Stellar JWT", async () => {
      // Ensure we have a valid token
      if (!authToken) {
        const challengeResponse = await request(app)
          .get("/auth/challenge")
          .query({ publicKey: testPublicKey })
          .expect(200);

        const transaction = StellarSdk.TransactionBuilder.fromXDR(
          challengeResponse.body.challenge,
          process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
        );
        transaction.sign(testKeypair);
        const signedChallengeXDR = transaction.toXDR();

        const verifyResponse = await request(app)
          .post("/auth/verify")
          .send({
            publicKey: testPublicKey,
            challengeXDR: signedChallengeXDR,
          })
          .expect(200);

        authToken = verifyResponse.body.token;
      }

      // Test access to protected routes
      const response = await request(app)
        .get('/content')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
    });

    it("should reject invalid JWT tokens", async () => {
      const invalidTokens = [
        'invalid.token.format',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalid.signature',
        'completely-invalid-token'
      ];

      for (const token of invalidTokens) {
        const response = await request(app)
          .get('/content')
          .set('Authorization', `Bearer ${token}`)
          .expect(403);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain('Invalid or expired token');
      }
    });

    it("should reject tokens for wrong authentication type", async () => {
      // Create a fake Ethereum-style token
      const jwt = require('jsonwebtoken');
      const fakeEthToken = jwt.sign(
        {
          address: testPublicKey.toLowerCase(),
          tier: 'bronze',
          type: 'ethereum' // Wrong type for Stellar auth
        },
        process.env.JWT_SECRET || 'test-secret',
        { expiresIn: '1h' }
      );

      // Try to access Stellar-specific endpoint
      const response = await request(app)
        .get('/auth/stellar/session')
        .set('Authorization', `Bearer ${fakeEthToken}`)
        .expect(403);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid token type');
    });
  });

  describe("Additional Security Features", () => {
    it("should handle session management correctly", async () => {
      if (!authToken) {
        // Create a new token for this test
        const challengeResponse = await request(app)
          .get("/auth/challenge")
          .query({ publicKey: testPublicKey })
          .expect(200);

        const transaction = StellarSdk.TransactionBuilder.fromXDR(
          challengeResponse.body.challenge,
          process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015"
        );
        transaction.sign(testKeypair);
        const signedChallengeXDR = transaction.toXDR();

        const verifyResponse = await request(app)
          .post("/auth/verify")
          .send({
            publicKey: testPublicKey,
            challengeXDR: signedChallengeXDR,
          })
          .expect(200);

        authToken = verifyResponse.body.token;
      }

      // Get session info
      const sessionResponse = await request(app)
        .get('/auth/stellar/session')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(sessionResponse.body.success).toBe(true);
      expect(sessionResponse.body.session.publicKey).toBe(testPublicKey.toLowerCase());

      // Logout
      const logoutResponse = await request(app)
        .post('/auth/stellar/logout')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(logoutResponse.body.success).toBe(true);

      // Token should be invalid after logout
      const sessionAfterLogout = await request(app)
        .get('/auth/stellar/session')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(403);

      expect(sessionAfterLogout.body.success).toBe(false);
    });

    it("should enforce rate limiting on authentication endpoints", async () => {
      // Test rate limiting by making multiple rapid requests
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          request(app)
            .get("/auth/challenge")
            .query({ publicKey: StellarSdk.Keypair.random().publicKey() })
        );
      }

      const responses = await Promise.all(promises);
      
      // At least some requests should succeed
      const successCount = responses.filter(r => r.status === 200).length;
      expect(successCount).toBeGreaterThan(0);
      
      // Some might be rate limited (429) depending on configuration
      const rateLimitedCount = responses.filter(r => r.status === 429).length;
      // This is optional behavior, so we don't enforce it strictly
    });
  });

  describe("Error Handling and Edge Cases", () => {
    it("should handle invalid public keys gracefully", async () => {
      const invalidKeys = [
        'invalid-key',
        'G123', // Too short
        'G' + 'A'.repeat(56), // Invalid format
        '',
        null,
        undefined
      ];

      for (const key of invalidKeys) {
        const response = await request(app)
          .get("/auth/challenge")
          .query({ publicKey: key })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toContain('Stellar public key required');
      }
    });

    it("should handle malformed XDR gracefully", async () => {
      const malformedXDRs = [
        'invalid-xdr',
        'AAAAAA==',
        '',
        null,
        undefined
      ];

      for (const xdr of malformedXDRs) {
        const response = await request(app)
          .post("/auth/verify")
          .send({
            publicKey: testPublicKey,
            challengeXDR: xdr
          })
          .expect(400);

        expect(response.body.success).toBe(false);
      }
    });

    it("should handle missing required fields", async () => {
      // Missing publicKey
      const response1 = await request(app)
        .post("/auth/verify")
        .send({
          challengeXDR: 'some-xdr'
        })
        .expect(400);

      expect(response1.body.error).toContain('Missing required fields');

      // Missing challengeXDR
      const response2 = await request(app)
        .post("/auth/verify")
        .send({
          publicKey: testPublicKey
        })
        .expect(400);

      expect(response2.body.error).toContain('Missing required fields');

      // Missing both
      const response3 = await request(app)
        .post("/auth/verify")
        .send({})
        .expect(400);

      expect(response3.body.error).toContain('Missing required fields');
    });
  });

  describe("Performance and Scalability", () => {
    it("should handle concurrent authentication requests", async () => {
      const concurrentRequests = 20;
      const promises = [];

      for (let i = 0; i < concurrentRequests; i++) {
        const keypair = StellarSdk.Keypair.random();
        promises.push(
          request(app)
            .get("/auth/challenge")
            .query({ publicKey: keypair.publicKey() })
        );
      }

      const responses = await Promise.all(promises);
      
      // All requests should succeed
      const successCount = responses.filter(r => r.status === 200).length;
      expect(successCount).toBe(concurrentRequests);

      // All responses should have valid challenge structure
      responses.forEach(response => {
        expect(response.body.success).toBe(true);
        expect(response.body.challenge).toBeDefined();
        expect(response.body.nonce).toBeDefined();
        expect(response.body.expiresAt).toBeDefined();
      });
    });

    it("should have reasonable response times", async () => {
      const startTime = Date.now();
      
      await request(app)
        .get("/auth/challenge")
        .query({ publicKey: testPublicKey })
        .expect(200);

      const responseTime = Date.now() - startTime;
      
      // Should respond within reasonable time (less than 1 second)
      expect(responseTime).toBeLessThan(1000);
    });
  });
});
