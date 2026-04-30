-- Churn Risk Worker Metrics Table
-- Migration for monitoring the daily churn risk analysis performance

CREATE TABLE IF NOT EXISTS churn_risk_worker_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    subscriber_count INTEGER NOT NULL DEFAULT 0,
    high_risk_count INTEGER NOT NULL DEFAULT 0,
    processing_time_ms INTEGER NOT NULL,
    success BOOLEAN NOT NULL DEFAULT true,
    error_message TEXT,
    processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance monitoring
CREATE INDEX IF NOT EXISTS idx_churn_worker_metrics_merchant_id ON churn_risk_worker_metrics(merchant_id);
CREATE INDEX IF NOT EXISTS idx_churn_worker_metrics_processed_at ON churn_risk_worker_metrics(processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_churn_worker_metrics_success ON churn_risk_worker_metrics(success);
CREATE INDEX IF NOT EXISTS idx_churn_worker_metrics_merchant_date ON churn_risk_worker_metrics(merchant_id, processed_at DESC);

-- Create view for worker performance monitoring
CREATE OR REPLACE VIEW churn_worker_performance_summary AS
SELECT 
    DATE(processed_at) as analysis_date,
    COUNT(*) as total_merchants_processed,
    SUM(subscriber_count) as total_subscribers_processed,
    SUM(high_risk_count) as total_high_risk_identified,
    AVG(processing_time_ms) as avg_processing_time_ms,
    MAX(processing_time_ms) as max_processing_time_ms,
    COUNT(CASE WHEN success = true THEN 1 END) as successful_runs,
    COUNT(CASE WHEN success = false THEN 1 END) as failed_runs,
    ROUND(
        COUNT(CASE WHEN success = true THEN 1 END) * 100.0 / 
        NULLIF(COUNT(*), 0), 2
    ) as success_rate_percentage
FROM churn_risk_worker_metrics
WHERE processed_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(processed_at)
ORDER BY analysis_date DESC;

-- Create view for merchant-specific performance trends
CREATE OR REPLACE VIEW merchant_risk_trends AS
SELECT 
    merchant_id,
    DATE(processed_at) as analysis_date,
    subscriber_count,
    high_risk_count,
    ROUND(
        high_risk_count * 100.0 / 
        NULLIF(subscriber_count, 0), 2
    ) as high_risk_percentage,
    processing_time_ms,
    success
FROM churn_risk_worker_metrics
WHERE processed_at >= CURRENT_DATE - INTERVAL '30 days'
ORDER BY merchant_id, analysis_date DESC;

-- Grant permissions (adjust as needed for your setup)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON churn_risk_worker_metrics TO app_user;
-- GRANT SELECT ON churn_worker_performance_summary TO app_user;
-- GRANT SELECT ON merchant_risk_trends TO app_user;
