/**
 * Swagger/OpenAPI Specification Generator
 * 
 * Automatically generates API documentation from JSDoc comments
 * and route definitions. Hosted at /api/docs with interactive "Try it out" feature.
 */

const swaggerAutogen = require('swagger-autogen')();
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const outputFile = './swagger_output.json';
const yamlOutputFile = './swagger_output.yaml';

// Files containing API routes to document
const routeFiles = [
  './index.js',
  './routes/auth.js',
  './routes/stellarAuth.js',
  './routes/subscription.js',
  './routes/payouts.js',
  './routes/video.js',
  './routes/globalStats.js',
  './routes/price.js',
  './routes/device.js',
  './routes/user.js',
  './routes/posts.js',
  './routes/comments.js',
  './routes/badges.js',
  './routes/analytics.js',
  './routes/feed.js',
  './routes/content.js',
  './routes/storage.js',
  './routes/vault.js',
  './routes/vesting.js',
  './routes/tax.js',
  './routes/legalAgreements.js',
  './routes/registry.js',
];

// Base API documentation
const doc = {
  info: {
    version: '1.0.0',
    title: 'AgreeStellar API',
    description: `
# AgreeStellar - Decentralized Streaming Platform API

Complete API documentation for the AgreeStellar, a decentralized streaming platform built on Stellar/Soroban.

## Features

- **Decentralized Payments**: Stellar-based subscription management
- **Video Streaming**: HLS transcoding and CDN integration
- **Fraud Prevention**: Device fingerprinting and Sybil attack detection
- **Analytics**: Real-time creator and subscriber analytics
- **Smart Contracts**: Soroban contract integration

## Authentication

Most endpoints require authentication using one of these methods:

### Sign-In With Stellar (SIWS)
\`\`\`javascript
// 1. Get challenge
GET /auth/stellar/challenge?publicKey=G...

// 2. Sign with wallet
const signed = signChallenge(challenge);

// 3. Login
POST /auth/stellar/login
{
  "publicKey": "G...",
  "challengeXDR": "signed-xdr"
}

// 4. Use token
Authorization: Bearer <token>
\`\`\`

## Rate Limiting

API requests are rate-limited using a leaky bucket algorithm:
- **Default**: 60 requests per minute per wallet
- **Burst**: Up to 100 requests
- **Block Duration**: 5 minutes when exceeded

## Response Format

All responses follow this structure:
\`\`\`json
{
  "success": true,
  "data": { ... },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
\`\`\`

## Error Handling

Errors include detailed information for debugging:
\`\`\`json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": { ... }
}
\`\`\`
    `,
  },
  host: process.env.API_HOST || 'localhost:3000',
  basePath: '/api',
  schemes: ['http', 'https'],
  consumes: ['application/json'],
  produces: ['application/json'],
  tags: [
    {
      name: 'Authentication',
      description: 'Stellar wallet authentication and session management',
    },
    {
      name: 'Subscriptions',
      description: 'Manage creator subscriptions and payment flows',
    },
    {
      name: 'Video',
      description: 'Video upload, transcoding, and streaming',
    },
    {
      name: 'Creator',
      description: 'Creator profile and content management',
    },
    {
      name: 'Analytics',
      description: 'Statistics and analytics for creators',
    },
    {
      name: 'Payouts',
      description: 'Payment processing and payout management',
    },
    {
      name: 'Device',
      description: 'Device fingerprinting and fraud prevention',
    },
    {
      name: 'Security',
      description: 'Security-related endpoints including Sybil detection',
    },
    {
      name: 'Fraud Prevention',
      description: 'Multi-accounting detection and prevention',
    },
    {
      name: 'Admin',
      description: 'Administrative endpoints',
    },
  ],
  securityDefinitions: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'JWT token obtained from /auth/stellar/login',
    },
    stellarAuth: {
      type: 'apiKey',
      name: 'Authorization',
      in: 'header',
      description: 'Bearer token with format: Bearer <JWT_TOKEN>',
    },
  },
  definitions: {
    // Common data structures
    Creator: {
      id: 'creator-uuid',
      publicKey: 'G...',
      createdAt: '2024-01-01T00:00:00.000Z',
      subscriberCount: 1250,
      flowRate: '1000000',
      currency: 'USDC',
    },
    Subscription: {
      creatorId: 'creator-uuid',
      walletAddress: 'G...',
      active: true,
      subscribedAt: '2024-01-01T00:00:00.000Z',
      tierLevel: 'gold',
      balance: '5000000',
      dailySpend: '100000',
    },
    Video: {
      id: 'video-uuid',
      creatorId: 'creator-uuid',
      title: 'My Video',
      description: 'Video description',
      status: 'processing',
      visibility: 'public',
      createdAt: '2024-01-01T00:00:00.000Z',
    },
    DeviceFingerprint: {
      deviceId: 'dev_abc123...',
      fingerprint: 'sha256-hash',
      confidence: 95,
      riskLevel: 'low',
      components: {},
    },
    SybilAnalysis: {
      deviceId: 'dev_abc123...',
      riskLevel: 'critical',
      riskScore: 85,
      walletCount: 12,
      wallets: ['G...', 'G...'],
      flags: ['CRITICAL_MULTI_WALLET'],
      flagged: true,
    },
    Payout: {
      id: 'payout-uuid',
      creatorId: 'creator-uuid',
      amount: '1000000',
      asset: 'USDC',
      recipientAddress: 'G...',
      status: 'pending',
      transactionHash: 'tx-hash',
    },
    ErrorResponse: {
      success: false,
      error: 'Error message',
      code: 'ERROR_CODE',
    },
  },
  parameters: {
    // Common parameters
    walletAddress: {
      name: 'walletAddress',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Stellar wallet address (G...)',
      example: 'GBZKMBXW5VHZQ7YKJ5VXQZ5VXQZ5VXQZ5VXQZ5VXQZ5VXQZ5VXQZ',
    },
    creatorId: {
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Creator unique identifier',
    },
    videoId: {
      name: 'videoId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Video unique identifier',
    },
    limit: {
      name: 'limit',
      in: 'query',
      required: false,
      schema: { type: 'integer', default: 20 },
      description: 'Number of results per page',
    },
    offset: {
      name: 'offset',
      in: 'query',
      required: false,
      schema: { type: 'integer', default: 0 },
      description: 'Pagination offset',
    },
  },
};

/**
 * Generate Swagger specification
 */
async function generateSwagger() {
  console.log('[Swagger] Generating API documentation...');
  
  try {
    // Filter existing files
    const existingFiles = routeFiles.filter((file) => fs.existsSync(file));
    
    if (existingFiles.length === 0) {
      console.warn('[Swagger] No route files found. Skipping generation.');
      return;
    }
    
    // Generate spec
    await swaggerAutogen(outputFile)(doc, existingFiles);
    
    console.log(`[Swagger] Generated ${outputFile}`);
    
    // Also generate YAML version
    const jsonSpec = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    const yamlSpec = yaml.dump(jsonSpec, { indent: 2 });
    fs.writeFileSync(yamlOutputFile, yamlSpec, 'utf8');
    
    console.log(`[Swagger] Generated ${yamlOutputFile}`);
    console.log(`[Swagger] Documented ${existingFiles.length} route files`);
    
  } catch (error) {
    console.error('[Swagger] Generation failed:', error);
  }
}

// Auto-generate on module load if in development
if (process.env.NODE_ENV === 'development' || process.env.GENERATE_SWAGGER === 'true') {
  generateSwagger();
}

module.exports = { generateSwagger, outputFile, yamlOutputFile };
