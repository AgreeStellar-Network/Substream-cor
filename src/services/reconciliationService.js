const crypto = require('crypto');

/**
 * Reconciliation Service
 * Resolves discrepancies between on-chain payments and internal ERP bank statements.
 */
class ReconciliationService {
  constructor(database, logger = console) {
    this.database = database;
    this.logger = logger;
  }

  /**
   * Get discrepancy and generate a side-by-side comparison of Ledger vs Internal state
   * @param {string} discrepancyId 
   */
  async getDiscrepancy(discrepancyId) {
    const query = `SELECT * FROM reconciliation_gaps WHERE id = ?`;
    const gap = this.database.db.prepare(query).get(discrepancyId);

    if (!gap) {
      throw new Error(`Discrepancy with id ${discrepancyId} not found`);
    }

    const ledgerState = JSON.parse(gap.ledger_state || '{}');
    const internalState = JSON.parse(gap.internal_state || '{}');

    // Trace lifecycle to find exactly where failure occurred
    const trace = await this.traceLifecycle(gap);

    return {
      discrepancyId: gap.id,
      transactionHash: gap.transaction_hash,
      merchantId: gap.merchant_id,
      status: gap.status,
      comparison: {
        ledgerState,
        internalState
      },
      trace
    };
  }

  /**
   * Traces the lifecycle: Indexer_Detected -> Webhook_Dispatched -> Merchant_ACK
   * and flags where the failure occurred.
   * @param {Object} gap 
   */
  async traceLifecycle(gap) {
    const trace = {
      indexerDetected: false,
      webhookDispatched: false,
      merchantAck: false,
      failurePoint: null,
      failureReason: null
    };

    // 1. Check if indexer detected
    const sorobanEvent = this.database.db.prepare(
      `SELECT * FROM soroban_events WHERE transaction_hash = ?`
    ).get(gap.transaction_hash);

    if (sorobanEvent) {
      trace.indexerDetected = true;
    } else {
      trace.failurePoint = 'Indexer_Detected';
      trace.failureReason = 'RPC node skipped block or indexer lagging';
      return trace;
    }

    // Since we don't have a dedicated webhook_logs table, we infer from gap failure_stage
    if (gap.failure_stage === 'Webhook_Dispatched') {
      trace.indexerDetected = true;
      trace.webhookDispatched = false;
      trace.failurePoint = 'Webhook_Dispatched';
      trace.failureReason = 'Internal Server Error or Queue failure';
      return trace;
    } else if (gap.failure_stage === 'Merchant_ACK') {
      trace.indexerDetected = true;
      trace.webhookDispatched = true;
      trace.merchantAck = false;
      trace.failurePoint = 'Merchant_ACK';
      trace.failureReason = 'Merchant server returned 504 or 500';
      return trace;
    }

    // Default to gap failure stage if set
    if (gap.failure_stage) {
      trace.failurePoint = gap.failure_stage;
      trace.failureReason = 'Unknown failure in ' + gap.failure_stage;
    }

    return trace;
  }

  /**
   * Manually overrides the status of a transaction and logs it.
   * @param {string} discrepancyId 
   * @param {string} newStatus 
   * @param {string} reason 
   * @param {string} accountantId 
   */
  async forceSync(discrepancyId, newStatus, reason, accountantId) {
    return this.database.transaction(() => {
      const gap = this.database.db.prepare(
        `SELECT * FROM reconciliation_gaps WHERE id = ?`
      ).get(discrepancyId);

      if (!gap) {
        throw new Error(`Discrepancy with id ${discrepancyId} not found`);
      }

      const previousStatus = gap.status;

      // 1. Update gap status
      this.database.db.prepare(
        `UPDATE reconciliation_gaps SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(newStatus, discrepancyId);

      // 2. Log to audit trail
      const auditId = crypto.randomUUID();
      this.database.db.prepare(
        `INSERT INTO accountant_audit_trail 
         (id, discrepancy_id, accountant_id, action, previous_status, new_status, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(auditId, discrepancyId, accountantId, 'FORCE_SYNC', previousStatus, newStatus, reason);

      return {
        success: true,
        discrepancyId,
        newStatus,
        auditId
      };
    });
  }
}

module.exports = { ReconciliationService };
