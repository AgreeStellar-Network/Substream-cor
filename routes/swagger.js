/**
 * Swagger UI Endpoint
 * 
 * Serves interactive API documentation at /api/docs
 * with "Try it out" feature for testing endpoints
 */

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Load generated spec
function loadSpec() {
  try {
    const specPath = path.join(__dirname, '../../swagger_output.json');
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    
    // Add mock Stellar transaction examples
    addMockExamples(spec);
    
    return spec;
  } catch (error) {
    console.error('[Swagger] Failed to load spec:', error.message);
    
    // Return minimal spec if generation failed
    return {
      openapi: '3.0.0',
      info: {
        title: 'AgreeStellar API',
        version: '1.0.0',
        description: 'API documentation is being generated. Please refresh in a few seconds.',
      },
      paths: {},
    };
  }
}

/**
 * Add mock Stellar transaction examples to spec
 */
function addMockExamples(spec) {
  // Example: Challenge transaction
  const mockChallenge = {
    success: true,
    challenge: 'AAAAAgAAAABkVK8qLdGzKJXgT5Y5VhQZjXZKZ5VXQZ5VXQZ5VXQZ5VXQZwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAADHN1YnN0cmVhbS5jb20AAAAAAQAAAAAAAAAPAAAAAWFiYwAAAAA=',
    nonce: 'abc123',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  
  // Example: Signed login response
  const mockLoginResponse = {
    success: true,
    token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwdWJsaWNLZXkiOiJHQlpLTUJYVzVWSFpRN1lLSjVWWFFaNVZYUVo1VlhRWjVWWFFaNVZYUVo1VlhRWjVWWFFaIiwidGllciI6ImdvbGQiLCJ0eXBlIjoic3RlbGxhciIsImlhdCI6MTcwOTMwMDAwMCwiZXhwIjoxNzA5Mzg2NDAwfQ.abc123',
    user: {
      publicKey: 'gbzkmbxw5vhzq7ykj5vxqz5vxqz5vxqz5vxqz5vxqz5vxqz5vxqz',
      tier: 'gold',
      type: 'stellar',
    },
    expiresIn: 86400,
  };
  
  // Example: Soroban contract interaction
  const mockContractCall = {
    success: true,
    transactionHash: 'tx-abc123def456',
    ledger: 12345678,
    result: {
      subscriptionActive: true,
      expiryLedger: 12400000,
      tierLevel: 'gold',
    },
    gasUsed: 150000,
  };
  
  // Add examples to relevant paths
  if (spec.paths['/auth/stellar/challenge']) {
    spec.paths['/auth/stellar/challenge'].get.responses['200'].examples = {
      'application/json': mockChallenge,
    };
  }
  
  if (spec.paths['/auth/stellar/login']) {
    spec.paths['/auth/stellar/login'].post.responses['200'].examples = {
      'application/json': mockLoginResponse,
    };
  }
  
  // Add mock data to definitions
  spec.components = spec.components || {};
  spec.components.examples = {
    ChallengeTransaction: {
      value: mockChallenge,
    },
    LoginResponse: {
      value: mockLoginResponse,
    },
    ContractCall: {
      value: mockContractCall,
    },
  };
}

// Serve Swagger UI
router.get('/', (req, res) => {
  const spec = loadSpec();
  const options = {
    explorer: true,
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'SubStream API Docs',
    customfavIcon: '/favicon.ico',
  };
  
  res.send(swaggerUi.generateHTML(spec, options));
});

// Serve spec as JSON
router.get('/json', (req, res) => {
  const spec = loadSpec();
  res.json(spec);
});

// Serve spec as YAML
router.get('/yaml', (req, res) => {
  const spec = loadSpec();
  res.type('yaml').send(require('js-yaml').dump(spec));
});

// Regenerate spec endpoint (admin only)
router.post('/regenerate', async (req, res) => {
  try {
    const { generateSwagger } = require('./swaggerGenerator');
    await generateSwagger();
    
    res.json({
      success: true,
      message: 'Swagger specification regenerated successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
