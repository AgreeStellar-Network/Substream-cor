/**
 * Migration: Create soroban_events_archive table for automated data archiving
 * Issue: Add automated data archiving for historical subscription events to maintain database query performance
 * Focus Area: Backend Reliability, Security Hardening, and Soroban Integration Optimization
 */

CREATE TABLE IF NOT EXISTS soroban_events_archive (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  ledger_sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_data TEXT NOT NULL,
  raw_xdr TEXT,
  ledger_timestamp TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_soroban_archive_contract_id ON soroban_events_archive (contract_id);
CREATE INDEX IF NOT EXISTS idx_soroban_archive_ledger_timestamp ON soroban_events_archive (ledger_timestamp);
CREATE INDEX IF NOT EXISTS idx_soroban_archive_event_type ON soroban_events_archive (event_type);
CREATE INDEX IF NOT EXISTS idx_soroban_archive_archived_at ON soroban_events_archive (archived_at);
