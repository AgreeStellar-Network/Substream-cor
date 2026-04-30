const request = require('supertest');
const express = require('express');
const { AppDatabase } = require('../src/db/appDatabase');
const createReconciliationRoutes = require('../routes/admin/reconciliation');

describe('Reconciliation Drill-Down API', () => {
  let app;
  let database;

  beforeAll(() => {
    // In-memory database for testing
    database = new AppDatabase(':memory:');
    
    // Create necessary tables manually for test since we don't run full migrations
    database.db.prepare(\`
      CREATE TABLE IF NOT EXISTS reconciliation_gaps (
        id TEXT PRIMARY KEY,
        transaction_hash TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        ledger_state TEXT NOT NULL,
        internal_state TEXT NOT NULL,
        failure_stage TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    \`).run();

    database.db.prepare(\`
      CREATE TABLE IF NOT EXISTS accountant_audit_trail (
        id TEXT PRIMARY KEY,
        discrepancy_id TEXT NOT NULL,
        accountant_id TEXT NOT NULL,
        action TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        reason TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    \`).run();

    database.db.prepare(\`
      CREATE TABLE IF NOT EXISTS soroban_events (
        id TEXT PRIMARY KEY,
        contract_id TEXT,
        transaction_hash TEXT NOT NULL,
        event_index INTEGER,
        ledger_sequence INTEGER,
        event_type TEXT,
        event_data TEXT,
        raw_xdr TEXT,
        ledger_timestamp TEXT,
        ingested_at TEXT,
        status TEXT,
        retry_count INTEGER
      )
    \`).run();

    app = express();
    app.use(express.json());
    app.use('/api/admin/reconciliation', createReconciliationRoutes(database));
  });

  beforeEach(() => {
    database.db.prepare('DELETE FROM accountant_audit_trail').run();
    database.db.prepare('DELETE FROM reconciliation_gaps').run();
    database.db.prepare('DELETE FROM soroban_events').run();
  });

  describe('GET /api/admin/reconciliation/:discrepancyId/drill-down', () => {
    it('should return 404 if discrepancy not found', async () => {
      const res = await request(app).get('/api/admin/reconciliation/nonexistent/drill-down');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return discrepancy details and trace webhook failure', async () => {
      // Seed indexer event
      database.db.prepare(\`
        INSERT INTO soroban_events (id, transaction_hash) VALUES ('evt_1', 'tx_hash_123')
      \`).run();

      // Seed discrepancy gap pointing to webhook failure
      database.db.prepare(\`
        INSERT INTO reconciliation_gaps (id, transaction_hash, merchant_id, ledger_state, internal_state, failure_stage)
        VALUES ('gap_1', 'tx_hash_123', 'merch_1', '{"amount":100}', '{"amount":0}', 'Webhook_Dispatched')
      \`).run();

      const res = await request(app).get('/api/admin/reconciliation/gap_1/drill-down');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.discrepancyId).toBe('gap_1');
      
      // Trace validation
      expect(res.body.data.trace.indexerDetected).toBe(true);
      expect(res.body.data.trace.webhookDispatched).toBe(false);
      expect(res.body.data.trace.failurePoint).toBe('Webhook_Dispatched');
    });

    it('should trace merchant ack failure', async () => {
      database.db.prepare(\`
        INSERT INTO soroban_events (id, transaction_hash) VALUES ('evt_2', 'tx_hash_456')
      \`).run();

      database.db.prepare(\`
        INSERT INTO reconciliation_gaps (id, transaction_hash, merchant_id, ledger_state, internal_state, failure_stage)
        VALUES ('gap_2', 'tx_hash_456', 'merch_2', '{"amount":200}', '{"amount":0}', 'Merchant_ACK')
      \`).run();

      const res = await request(app).get('/api/admin/reconciliation/gap_2/drill-down');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.trace.webhookDispatched).toBe(true);
      expect(res.body.data.trace.merchantAck).toBe(false);
      expect(res.body.data.trace.failurePoint).toBe('Merchant_ACK');
    });

    it('should trace indexer failure if missing from soroban_events', async () => {
      database.db.prepare(\`
        INSERT INTO reconciliation_gaps (id, transaction_hash, merchant_id, ledger_state, internal_state, failure_stage)
        VALUES ('gap_3', 'tx_hash_789', 'merch_3', '{"amount":300}', '{"amount":0}', 'Indexer_Detected')
      \`).run();

      const res = await request(app).get('/api/admin/reconciliation/gap_3/drill-down');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.trace.indexerDetected).toBe(false);
      expect(res.body.data.trace.failurePoint).toBe('Indexer_Detected');
    });
  });

  describe('POST /api/admin/reconciliation/:discrepancyId/force-sync', () => {
    it('should override status and log to audit trail', async () => {
      database.db.prepare(\`
        INSERT INTO reconciliation_gaps (id, transaction_hash, merchant_id, ledger_state, internal_state, failure_stage, status)
        VALUES ('gap_sync_1', 'tx_123', 'merch_1', '{}', '{}', 'Webhook_Dispatched', 'pending')
      \`).run();

      const res = await request(app)
        .post('/api/admin/reconciliation/gap_sync_1/force-sync')
        .send({
          newStatus: 'resolved',
          reason: 'Verified manually with merchant',
          accountantId: 'acc_001'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify gap updated
      const updatedGap = database.db.prepare(\`SELECT status FROM reconciliation_gaps WHERE id = 'gap_sync_1'\`).get();
      expect(updatedGap.status).toBe('resolved');

      // Verify audit trail
      const auditLog = database.db.prepare(\`SELECT * FROM accountant_audit_trail WHERE discrepancy_id = 'gap_sync_1'\`).get();
      expect(auditLog).toBeDefined();
      expect(auditLog.action).toBe('FORCE_SYNC');
      expect(auditLog.previous_status).toBe('pending');
      expect(auditLog.new_status).toBe('resolved');
      expect(auditLog.accountant_id).toBe('acc_001');
      expect(auditLog.reason).toBe('Verified manually with merchant');
    });

    it('should return 400 if reason or newStatus is missing', async () => {
      const res = await request(app)
        .post('/api/admin/reconciliation/gap_sync_1/force-sync')
        .send({
          newStatus: 'resolved'
          // missing reason
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
