const request = require('supertest');
const app = require('../index');

describe('Usage Quota System Tests', () => {
  const STANDARD_API_KEY = 'sk_test_standard_1234567890abcdef';
  const PREMIUM_API_KEY = 'sk_test_premium_1234567890abcdef';

  describe('API Key Authentication', () => {
    test('Should reject requests without API key', async () => {
      const response = await request(app)
        .get('/api/v1/usage-quota/status')
        .expect(401);

      expect(response.body.error).toBe('API key required');
    });

    test('Should reject requests with invalid API key', async () => {
      const response = await request(app)
        .get('/api/v1/usage-quota/status')
        .set('X-API-Key', 'invalid_key')
        .expect(401);

      expect(response.body.error).toBe('Invalid API key');
    });

    test('Should accept requests with valid standard API key', async () => {
      const response = await request(app)
        .get('/api/v1/usage-quota/status')
        .set('X-API-Key', STANDARD_API_KEY)
        .expect(200);

      expect(response.body.usage.tier).toBe('standard');
    });

    test('Should accept requests with valid premium API key', async () => {
      const response = await request(app)
        .get('/api/v1/usage-quota/status')
        .set('X-API-Key', PREMIUM_API_KEY)
        .expect(200);

      expect(response.body.usage.tier).toBe('premium');
    });
  });

  describe('Rate Limiting Headers', () => {
    test('Should include rate limit headers in responses', async () => {
      const response = await request(app)
        .get('/api/v1/usage-quota/status')
        .set('X-API-Key', STANDARD_API_KEY)
        .expect(200);

      expect(response.headers).toHaveProperty('x-ratelimit-limit-hourly');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining-hourly');
      expect(response.headers).toHaveProperty('x-ratelimit-limit-monthly');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining-monthly');
      expect(response.headers).toHaveProperty('x-api-tier');
    });

    test('Should show correct limits for standard tier', async () => {
      const response = await request(app)
        .get('/api/v1/usage-quota/status')
        .set('X-API-Key', STANDARD_API_KEY)
        .expect(200);

      expect(response.headers['x-ratelimit-limit-hourly']).toBe('1000');
      expect(response.headers['x-ratelimit-limit-monthly']).toBe('10000');
    });

    test('Should show correct limits for premium tier', async () => {
      const response = await request(app)
        .get('/api/v1/usage-quota/status')
        .set('X-API-Key', PREMIUM_API_KEY)
        .expect(200);

      expect(response.headers['x-ratelimit-limit-hourly']).toBe('10000');
      expect(response.headers['x-ratelimit-limit-monthly']).toBe('100000');
    });
  });

  describe('Usage Tracking', () => {
    test('Should track API usage for analytics', async () => {
      // Make multiple requests
      await request(app)
        .get('/api/v1/usage-quota/data')
        .set('X-API-Key', STANDARD_API_KEY)
        .expect(200);

      await request(app)
        .post('/api/v1/usage-quota/transactions')
        .set('X-API-Key', STANDARD_API_KEY)
        .send({ transaction: 'sample_tx_data' })
        .expect(200);

      // Check analytics
      const response = await request(app)
        .get('/api/v1/usage-quota/analytics')
        .set('X-API-Key', STANDARD_API_KEY)
        .expect(200);

      expect(response.body.tier).toBe('standard');
      expect(response.body.usage).toBeDefined();
      expect(response.body.usage.hourly.used).toBeGreaterThan(0);
    });
  });

  describe('Billing Integration', () => {
    test('Should handle billing webhook with invalid signature', async () => {
      const response = await request(app)
        .post('/api/v1/usage-quota/billing/webhook')
        .set('X-Webhook-Signature', 'invalid_signature')
        .set('X-Event-Type', 'subscription.created')
        .send({ customer_id: 'test_id' })
        .expect(400);

      expect(response.body.error).toBe('Webhook processing failed');
    });

    test('Should verify on-chain payment endpoint', async () => {
      const response = await request(app)
        .post('/api/v1/usage-quota/billing/verify-payment')
        .set('X-API-Key', STANDARD_API_KEY)
        .send({
          transaction_hash: '0xvalid1234567890',
          expected_amount: 99.99,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('API Endpoints', () => {
    test('Should return AgreeStellar data', async () => {
      const response = await request(app)
        .get('/api/v1/usage-quota/data')
        .set('X-API-Key', PREMIUM_API_KEY)
        .expect(200);

      expect(response.body.protocol).toBe('SubStream');
      expect(response.body.data).toBeDefined();
      expect(response.body.request_info.tier).toBe('premium');
    });

    test('Should handle transaction submission', async () => {
      const response = await request(app)
        .post('/api/v1/usage-quota/transactions')
        .set('X-API-Key', PREMIUM_API_KEY)
        .send({ transaction: 'sample_transaction_data' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.transaction_id).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    test('Should return 400 for missing transaction data', async () => {
      const response = await request(app)
        .post('/api/v1/usage-quota/transactions')
        .set('X-API-Key', STANDARD_API_KEY)
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Invalid request');
    });

    test('Should return 400 for invalid payment verification', async () => {
      const response = await request(app)
        .post('/api/v1/usage-quota/billing/verify-payment')
        .set('X-API-Key', STANDARD_API_KEY)
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Invalid request');
    });
  });
});
