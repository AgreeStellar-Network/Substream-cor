-- Reconciliation Reports Database Schema
-- This migration creates tables for daily reconciliation reports and discrepancy tracking

-- Drop existing tables if they exist (for clean migration)
DROP TABLE IF EXISTS reconciliation_reports CASCADE;
DROP TABLE IF EXISTS reconciliation_discrepancies CASCADE;
DROP TABLE IF EXISTS reconciliation_healing_attempts CASCADE;

-- Table to store daily reconciliation reports for each merchant
CREATE TABLE reconciliation_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id VARCHAR(64) NOT NULL,
    report_date DATE NOT NULL,
    
    -- Aggregated SubscriptionBilled events for the day
    total_subscription_events INTEGER NOT NULL DEFAULT 0,
    total_subscription_amount DECIMAL(20, 8) NOT NULL DEFAULT 0,
    
    -- Vault balance information
    vault_balance_usd DECIMAL(20, 8) NOT NULL DEFAULT 0,
    vault_balance_native DECIMAL(20, 8) NOT NULL DEFAULT 0,
    vault_asset_code VARCHAR(20) NOT NULL DEFAULT 'XLM',
    
    -- Reconciliation status
    reconciliation_status VARCHAR(20) NOT NULL DEFAULT 'pending' 
        CHECK (reconciliation_status IN ('pending', 'matched', 'discrepancy_found', 'healing', 'failed')),
    
    -- Discrepancy information
    discrepancy_amount DECIMAL(20, 8) NOT NULL DEFAULT 0,
    discrepancy_percentage DECIMAL(10, 4) NOT NULL DEFAULT 0,
    
    -- Healing information
    healing_attempts INTEGER NOT NULL DEFAULT 0,
    healing_status VARCHAR(20) NOT NULL DEFAULT 'none'
        CHECK (healing_status IN ('none', 'in_progress', 'completed', 'failed')),
    
    -- Report files
    report_json_path VARCHAR(500),
    report_csv_path VARCHAR(500),
    
    -- Metadata
    processing_time_ms INTEGER,
    ledger_range_start BIGINT,
    ledger_range_end BIGINT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Constraints
    UNIQUE (merchant_id, report_date)
);

-- Table to store specific discrepancies found during reconciliation
CREATE TABLE reconciliation_discrepancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID NOT NULL REFERENCES reconciliation_reports(id) ON DELETE CASCADE,
    
    -- Discrepancy details
    discrepancy_type VARCHAR(50) NOT NULL 
        CHECK (discrepancy_type IN ('missing_event', 'extra_balance', 'amount_mismatch', 'timing_gap')),
    
    -- Transaction information
    transaction_hash VARCHAR(64),
    ledger_sequence BIGINT,
    event_index INTEGER,
    
    -- Expected vs actual values
    expected_amount DECIMAL(20, 8),
    actual_amount DECIMAL(20, 8),
    difference_amount DECIMAL(20, 8),
    
    -- Resolution information
    resolution_status VARCHAR(20) NOT NULL DEFAULT 'unresolved'
        CHECK (resolution_status IN ('unresolved', 'auto_healed', 'manual_review', 'false_positive')),
    
    -- Healing attempt reference
    healing_attempt_id UUID REFERENCES reconciliation_healing_attempts(id),
    
    -- Notes and metadata
    notes TEXT,
    raw_event_data JSONB,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMP WITH TIME ZONE
);

-- Table to track auto-healing attempts for discrepancies
CREATE TABLE reconciliation_healing_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID NOT NULL REFERENCES reconciliation_reports(id) ON DELETE CASCADE,
    
    -- Healing attempt details
    healing_strategy VARCHAR(50) NOT NULL 
        CHECK (healing_strategy IN ('re_poll_rpc', 'reprocess_ledger', 'sync_missing_events')),
    
    -- Target information
    target_transaction_hash VARCHAR(64),
    target_ledger_sequence BIGINT,
    target_event_index INTEGER,
    
    -- Attempt status
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
    
    -- Results
    events_found INTEGER NOT NULL DEFAULT 0,
    events_synced INTEGER NOT NULL DEFAULT 0,
    balance_adjusted DECIMAL(20, 8) NOT NULL DEFAULT 0,
    
    -- Error information
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    
    -- Timing
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    
    -- Raw response data for debugging
    rpc_response JSONB,
    healing_details JSONB
);

-- Create indexes for efficient querying
CREATE INDEX idx_reconciliation_reports_merchant_id 
ON reconciliation_reports (merchant_id);

CREATE INDEX idx_reconciliation_reports_report_date 
ON reconciliation_reports (report_date);

CREATE INDEX idx_reconciliation_reports_status 
ON reconciliation_reports (reconciliation_status);

CREATE INDEX idx_reconciliation_reports_merchant_date 
ON reconciliation_reports (merchant_id, report_date DESC);

CREATE INDEX idx_reconciliation_discrepancies_report_id 
ON reconciliation_discrepancies (report_id);

CREATE INDEX idx_reconciliation_discrepancies_type 
ON reconciliation_discrepancies (discrepancy_type);

CREATE INDEX idx_reconciliation_discrepancies_status 
ON reconciliation_discrepancies (resolution_status);

CREATE INDEX idx_reconciliation_discrepancies_transaction 
ON reconciliation_discrepancies (transaction_hash, ledger_sequence);

CREATE INDEX idx_reconciliation_healing_attempts_report_id 
ON reconciliation_healing_attempts (report_id);

CREATE INDEX idx_reconciliation_healing_attempts_status 
ON reconciliation_healing_attempts (status);

CREATE INDEX idx_reconciliation_healing_attempts_transaction 
ON reconciliation_healing_attempts (target_transaction_hash, target_ledger_sequence);

-- GIN index for JSONB columns
CREATE INDEX idx_reconciliation_discrepancies_data_gin 
ON reconciliation_discrepancies USING GIN (raw_event_data);

CREATE INDEX idx_reconciliation_healing_attempts_details_gin 
ON reconciliation_healing_attempts USING GIN (healing_details);

-- Create views for monitoring and analytics
CREATE OR REPLACE VIEW reconciliation_daily_summary AS
SELECT 
    rr.merchant_id,
    rr.report_date,
    rr.reconciliation_status,
    rr.total_subscription_events,
    rr.total_subscription_amount,
    rr.vault_balance_usd,
    rr.discrepancy_amount,
    rr.discrepancy_percentage,
    rr.healing_status,
    COUNT(rd.id) as discrepancy_count,
    COUNT(CASE WHEN rd.resolution_status = 'unresolved' THEN 1 END) as unresolved_count,
    COUNT(rha.id) as healing_attempts_count,
    rr.processing_time_ms,
    rr.completed_at
FROM reconciliation_reports rr
LEFT JOIN reconciliation_discrepancies rd ON rr.id = rd.report_id
LEFT JOIN reconciliation_healing_attempts rha ON rr.id = rha.report_id
GROUP BY rr.id, rr.merchant_id, rr.report_date, rr.reconciliation_status, 
         rr.total_subscription_events, rr.total_subscription_amount, rr.vault_balance_usd,
         rr.discrepancy_amount, rr.discrepancy_percentage, rr.healing_status,
         rr.processing_time_ms, rr.completed_at
ORDER BY rr.report_date DESC;

CREATE OR REPLACE VIEW reconciliation_health_metrics AS
SELECT 
    DATE_TRUNC('day', report_date) as date,
    COUNT(*) as total_reports,
    COUNT(CASE WHEN reconciliation_status = 'matched' THEN 1 END) as matched_reports,
    COUNT(CASE WHEN reconciliation_status = 'discrepancy_found' THEN 1 END) as discrepancy_reports,
    COUNT(CASE WHEN healing_status = 'completed' THEN 1 END) as healed_reports,
    AVG(discrepancy_percentage) as avg_discrepancy_percentage,
    SUM(discrepancy_amount) as total_discrepancy_amount,
    AVG(processing_time_ms) as avg_processing_time_ms
FROM reconciliation_reports
WHERE report_date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', report_date)
ORDER BY date DESC;

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_reconciliation_timestamps()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updated_at
CREATE TRIGGER trigger_reconciliation_reports_updated_at
    BEFORE UPDATE ON reconciliation_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_reconciliation_timestamps();

CREATE TRIGGER trigger_reconciliation_discrepancies_updated_at
    BEFORE UPDATE ON reconciliation_discrepancies
    FOR EACH ROW
    EXECUTE FUNCTION update_reconciliation_timestamps();

CREATE TRIGGER trigger_reconciliation_healing_attempts_updated_at
    BEFORE UPDATE ON reconciliation_healing_attempts
    FOR EACH ROW
    EXECUTE FUNCTION update_reconciliation_timestamps();

-- Add table comments for documentation
COMMENT ON TABLE reconciliation_reports IS 'Daily reconciliation reports comparing on-chain events with vault balances';
COMMENT ON TABLE reconciliation_discrepancies IS 'Specific discrepancies found during reconciliation with resolution tracking';
COMMENT ON TABLE reconciliation_healing_attempts IS 'Auto-healing attempts to resolve discrepancies';

COMMENT ON COLUMN reconciliation_reports.discrepancy_amount IS 'Absolute difference between expected and actual amounts';
COMMENT ON COLUMN reconciliation_reports.discrepancy_percentage IS 'Percentage difference relative to expected amount';
COMMENT ON COLUMN reconciliation_discrepancies.discrepancy_type IS 'Type of discrepancy: missing_event, extra_balance, amount_mismatch, or timing_gap';
COMMENT ON COLUMN reconciliation_healing_attempts.healing_strategy IS 'Strategy used: re_poll_rpc, reprocess_ledger, or sync_missing_events';

-- Update table statistics for optimal query planning
ANALYZE reconciliation_reports;
ANALYZE reconciliation_discrepancies;
ANALYZE reconciliation_healing_attempts;
