const { MerchantCorsMiddleware } = require('./src/middleware/merchantCorsMiddleware');
const Database = require('better-sqlite3');
const fs = require('fs');

async function test() {
  const dbPath = './data/test-cors.db';
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE merchants (
      id TEXT PRIMARY KEY,
      name TEXT,
      allowed_origins TEXT
    )
  `);

  const merchantId = 'm1';
  const origins = ['https://merchant.com', 'https://shop.merchant.com'];
  db.prepare('INSERT INTO merchants (id, name, allowed_origins) VALUES (?, ?, ?)').run(
    merchantId, 'Test Merchant', JSON.stringify(origins)
  );

  const mockDb = {
    getMerchantById: (id) => db.prepare('SELECT * FROM merchants WHERE id = ?').get(id)
  };

  const middleware = new MerchantCorsMiddleware(mockDb);

  // Test 1: Identify merchant via header
  const req1 = {
    header: (name) => {
      if (name === 'X-Merchant-ID') return merchantId;
      if (name === 'Origin') return 'https://merchant.com';
      return null;
    },
    path: '/api/v1/some-route',
    query: {}
  };

  const options1 = await new Promise(resolve => middleware.corsOptionsDelegate()(req1, (err, opts) => resolve(opts)));
  console.log('Test 1 (Allowed Origin):', options1.origin === true ? 'PASS' : 'FAIL');

  // Test 2: Denied origin
  const req2 = {
    header: (name) => {
      if (name === 'X-Merchant-ID') return merchantId;
      if (name === 'Origin') return 'https://hacker.com';
      return null;
    },
    path: '/api/v1/some-route',
    query: {}
  };

  const options2 = await new Promise(resolve => middleware.corsOptionsDelegate()(req2, (err, opts) => resolve(opts)));
  console.log('Test 2 (Denied Origin):', options2.origin === false ? 'PASS' : 'FAIL');

  // Test 3: Path extraction
  const req3 = {
    header: (name) => {
      if (name === 'Origin') return 'https://merchant.com';
      return null;
    },
    path: `/api/v1/merchants/${merchantId}/treasury`,
    query: {}
  };

  const options3 = await new Promise(resolve => middleware.corsOptionsDelegate()(req3, (err, opts) => resolve(opts)));
  console.log('Test 3 (Path Extraction):', options3.origin === true ? 'PASS' : 'FAIL');

  db.close();
  fs.unlinkSync(dbPath);
}

test().catch(console.error);
