-- Reconciliation Worker Database Schema
-- This migration creates tables for daily reconciliation reporting and discrepancy tracking

-- Table to store daily reconciliation reports for each merchant
CREATE TABLE IF NOT EXISTS reconciliation_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id VARCHAR(64) NOT NULL,
    report_date DATE NOT NULL,
    
    -- Summary metrics
    total_subscription_billed_events BIGINT NOT NULL DEFAULT 0,
    total_on_chain_amount DECIMAL(20,7) NOT NULL DEFAULT 0,
    total_database_amount DECIMAL(20,7) NOT NULL DEFAULT 0,
    total_discrepancies BIGINT NOT NULL DEFAULT 0,
    
    -- Discrepancy breakdown
    missing_in_database BIGINT NOT NULL DEFAULT 0,
    missing_on_chain BIGINT NOT NULL DEFAULT 0,
    amount_mismatches BIGINT NOT NULL DEFAULT 0,
    
    -- Auto-healing results
    auto_healed_count BIGINT NOT NULL DEFAULT 0,
    failed_to_heal_count BIGINT NOT NULL DEFAULT 0,
    
    -- Status and timing
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    
    -- Report data (JSON)
    report_data JSONB,
    
    -- Constraints
    UNIQUE (merchant_id, report_date)
);

-- Table to track specific discrepancy gaps for detailed analysis
CREATE TABLE IF NOT EXISTS reconciliation_discrepancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reconciliation_report_id UUID NOT NULL REFERENCES reconciliation_reports(id) ON DELETE CASCADE,
    
    -- Discrepancy details
    discrepancy_type VARCHAR(20) NOT NULL CHECK (discrepancy_type IN ('missing_in_database', 'missing_on_chain', 'amount_mismatch')),
    transaction_hash VARCHAR(64),
    event_index INTEGER,
    
    -- Event details (if available)
    subscription_billed_event JSONB,
    database_record JSONB,
    
    -- Amount comparison (for amount mismatches)
    on_chain_amount DECIMAL(20,7),
    database_amount DECIMAL(20,7),
    amount_difference DECIMAL(20,7),
    
    -- Healing status
    healing_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (healing_status IN ('pending', 'attempted', 'healed', 'failed')),
    healing_attempts INTEGER NOT NULL DEFAULT 0,
    healing_error TEXT,
    healed_at TIMESTAMP WITH TIME ZONE,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Table to store reconciliation configuration for each merchant
CREATE TABLE IF NOT EXISTS reconciliation_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id VARCHAR(64) NOT NULL UNIQUE,
    
    -- Configuration
    enabled BOOLEAN NOT NULL DEFAULT true,
    auto_heal_enabled BOOLEAN NOT NULL DEFAULT true,
    max_healing_attempts INTEGER NOT NULL DEFAULT 3,
    healing_retry_delay_minutes INTEGER NOT NULL DEFAULT 5,
    
    -- Thresholds
    discrepancy_threshold_amount DECIMAL(20,7) NOT NULL DEFAULT 0.000001, -- 1 stroop minimum
    discrepancy_threshold_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.01, -- 0.01%
    
    -- Notification settings
    notify_on_discrepancy BOOLEAN NOT NULL DEFAULT true,
    notify_on_healing_failure BOOLEAN NOT NULL DEFAULT true,
    notification_email TEXT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Table to track reconciliation worker execution history
CREATE TABLE IF NOT EXISTS reconciliation_worker_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Execution details
    execution_date DATE NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
    
    -- Summary statistics
    total_merchants_processed INTEGER NOT NULL DEFAULT 0,
    total_reports_generated INTEGER NOT NULL DEFAULT 0,
    total_discrepancies_found INTEGER NOT NULL DEFAULT 0,
    total_auto_healed INTEGER NOT NULL DEFAULT 0,
    
    -- Error tracking
    error_message TEXT,
    error_details JSONB,
    
    -- Performance metrics
    processing_time_seconds INTEGER,
    
    -- Constraints
    UNIQUE (execution_date)
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_merchant_date 
ON reconciliation_reports (merchant_id, report_date DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_status 
ON reconciliation_reports (status);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_date 
ON reconciliation_reports (report_date DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_report_id 
ON reconciliation_discrepancies (reconciliation_report_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_type 
ON reconciliation_discrepancies (discrepancy_type);

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_healing_status 
ON reconciliation_discrepancies (healing_status);

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_transaction 
ON reconciliation_discrepancies (transaction_hash, event_index);

CREATE INDEX IF NOT EXISTS idx_reconciliation_config_enabled 
ON reconciliation_config (enabled) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_reconciliation_worker_history_date 
ON reconciliation_worker_history (execution_date DESC);

-- GIN index for efficient JSONB queries
CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_data_gin 
ON reconciliation_reports USING GIN (report_data);

CREATE INDEX IF NOT EXISTS idx_reconciliation_discrepancies_event_gin 
ON reconciliation_discrepancies USING GIN (subscription_billed_event);

-- Create a view for daily reconciliation summary
CREATE OR REPLACE VIEW reconciliation_daily_summary AS
SELECT 
    report_date,
    COUNT(*) as total_merchants,
    COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_reports,
    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_reports,
    SUM(total_discrepancies) as total_discrepancies,
    SUM(auto_healed_count) as total_auto_healed,
    SUM(failed_to_heal_count) as total_failed_to_heal,
    SUM(total_on_chain_amount) as total_on_chain_volume,
    SUM(total_database_amount) as total_database_volume
FROM reconciliation_reports
GROUP BY report_date
ORDER BY report_date DESC;

-- Create a view for discrepancy analytics
CREATE OR REPLACE VIEW reconciliation_discrepancy_analytics AS
SELECT 
    DATE_TRUNC('month', created_at) as month,
    discrepancy_type,
    COUNT(*) as discrepancy_count,
    COUNT(CASE WHEN healing_status = 'healed' THEN 1 END) as healed_count,
    COUNT(CASE WHEN healing_status = 'failed' THEN 1 END) as failed_heal_count,
    AVG(amount_difference) as avg_amount_difference,
    SUM(amount_difference) as total_amount_difference
FROM reconciliation_discrepancies
WHERE discrepancy_type IN ('amount_mismatch', 'missing_in_database', 'missing_on_chain')
GROUP BY DATE_TRUNC('month', created_at), discrepancy_type
ORDER BY month DESC, discrepancy_type;

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_reconciliation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updated_at
CREATE TRIGGER trigger_reconciliation_discrepancies_updated_at
    BEFORE UPDATE ON reconciliation_discrepancies
    FOR EACH ROW
    EXECUTE FUNCTION update_reconciliation_updated_at();

CREATE TRIGGER trigger_reconciliation_config_updated_at
    BEFORE UPDATE ON reconciliation_config
    FOR EACH ROW
    EXECUTE FUNCTION update_reconciliation_updated_at();

-- Add table comments for documentation
COMMENT ON TABLE reconciliation_reports IS 'Daily reconciliation reports comparing on-chain events with database records';
COMMENT ON TABLE reconciliation_discrepancies IS 'Detailed tracking of individual discrepancies found during reconciliation';
COMMENT ON TABLE reconciliation_config IS 'Per-merchant configuration for reconciliation settings';
COMMENT ON TABLE reconciliation_worker_history IS 'Execution history of the daily reconciliation worker';

COMMENT ON COLUMN reconciliation_reports.total_on_chain_amount IS 'Total amount from SubscriptionBilled events on-chain';
COMMENT ON COLUMN reconciliation_reports.total_database_amount IS 'Total amount from corresponding database records';
COMMENT ON COLUMN reconciliation_discrepancies.discrepancy_type IS 'Type of discrepancy: missing_in_database, missing_on_chain, or amount_mismatch';
COMMENT ON COLUMN reconciliation_discrepancies.healing_status IS 'Status of auto-healing attempts: pending, attempted, healed, or failed';

-- Update table statistics for optimal query planning
ANALYZE reconciliation_reports;
ANALYZE reconciliation_discrepancies;
ANALYZE reconciliation_config;
ANALYZE reconciliation_worker_history;
