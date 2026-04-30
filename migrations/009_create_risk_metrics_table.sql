-- Risk Metrics Table for Churn Prediction Analysis
-- Migration for Issue: Subscription Churn Risk Prediction System

-- Create Risk_Metrics table to store predictive analytics
CREATE TABLE IF NOT EXISTS risk_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    user_wallet_address VARCHAR(255) NOT NULL,
    risk_score INTEGER NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('Low', 'Medium', 'High', 'Critical')),
    prediction_factors JSONB NOT NULL DEFAULT '{}',
    
    -- Specific churn risk indicators
    missed_payment_streak INTEGER DEFAULT 0,
    just_in_time_topups_count INTEGER DEFAULT 0,
    balance_trend VARCHAR(20) DEFAULT 'stable' CHECK (balance_trend IN ('increasing', 'stable', 'decreasing', 'critical')),
    days_until_balance_exhausted INTEGER,
    
    -- Timestamps
    analysis_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_payment_date TIMESTAMP,
    last_topup_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Unique constraint on merchant-user combination per day
    UNIQUE(merchant_id, user_wallet_address, analysis_date)
);

-- Create Balance_History table to track wallet balance over time
CREATE TABLE IF NOT EXISTS balance_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    user_wallet_address VARCHAR(255) NOT NULL,
    balance DECIMAL(15,2) NOT NULL,
    previous_balance DECIMAL(15,2),
    change_amount DECIMAL(15,2),
    change_type VARCHAR(20) NOT NULL CHECK (change_type IN ('topup', 'payment', 'fee', 'adjustment')),
    transaction_hash VARCHAR(255),
    cycle_number INTEGER NOT NULL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create Payment_Attempts table to track missed payments
CREATE TABLE IF NOT EXISTS payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    user_wallet_address VARCHAR(255) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'USD',
    status VARCHAR(20) NOT NULL CHECK (status IN ('success', 'failed', 'pending')),
    failure_reason VARCHAR(255),
    retry_count INTEGER DEFAULT 0,
    cycle_number INTEGER NOT NULL,
    attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Risk_Metrics table
CREATE INDEX IF NOT EXISTS idx_risk_metrics_merchant_id ON risk_metrics(merchant_id);
CREATE INDEX IF NOT EXISTS idx_risk_metrics_user_wallet ON risk_metrics(user_wallet_address);
CREATE INDEX IF NOT EXISTS idx_risk_metrics_risk_level ON risk_metrics(risk_level);
CREATE INDEX IF NOT EXISTS idx_risk_metrics_analysis_date ON risk_metrics(analysis_date DESC);
CREATE INDEX IF NOT EXISTS idx_risk_metrics_merchant_risk_date ON risk_metrics(merchant_id, analysis_date DESC);
CREATE INDEX IF NOT EXISTS idx_risk_metrics_high_risk ON risk_metrics(risk_level) WHERE risk_level IN ('High', 'Critical');

-- Indexes for Balance_History table
CREATE INDEX IF NOT EXISTS idx_balance_history_merchant_user ON balance_history(merchant_id, user_wallet_address);
CREATE INDEX IF NOT EXISTS idx_balance_history_cycle ON balance_history(cycle_number);
CREATE INDEX IF NOT EXISTS idx_balance_history_recorded_at ON balance_history(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_balance_history_merchant_cycle ON balance_history(merchant_id, cycle_number DESC);

-- Indexes for Payment_Attempts table
CREATE INDEX IF NOT EXISTS idx_payment_attempts_merchant_user ON payment_attempts(merchant_id, user_wallet_address);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON payment_attempts(status);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_cycle ON payment_attempts(cycle_number);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_attempted_at ON payment_attempts(attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_failed ON payment_attempts(merchant_id, user_wallet_address, attempted_at DESC) WHERE status = 'failed';

-- Create view for high-risk subscribers (for merchants)
CREATE OR REPLACE VIEW high_risk_subscribers AS
SELECT 
    rm.merchant_id,
    rm.user_wallet_address,
    rm.risk_score,
    rm.risk_level,
    rm.missed_payment_streak,
    rm.just_in_time_topups_count,
    rm.balance_trend,
    rm.days_until_balance_exhausted,
    rm.analysis_date,
    bh.balance as current_balance,
    pa.failure_reason as last_failure_reason
FROM risk_metrics rm
LEFT JOIN LATERAL (
    SELECT balance 
    FROM balance_history 
    WHERE merchant_id = rm.merchant_id 
      AND user_wallet_address = rm.user_wallet_address 
    ORDER BY recorded_at DESC 
    LIMIT 1
) bh ON true
LEFT JOIN LATERAL (
    SELECT failure_reason 
    FROM payment_attempts 
    WHERE merchant_id = rm.merchant_id 
      AND user_wallet_address = rm.user_wallet_address 
      AND status = 'failed'
    ORDER BY attempted_at DESC 
    LIMIT 1
) pa ON true
WHERE rm.risk_level IN ('High', 'Critical')
  AND rm.analysis_date >= CURRENT_DATE - INTERVAL '7 days';

-- Create function to calculate just-in-time topup detection
CREATE OR REPLACE FUNCTION detect_just_in_time_topups(
    p_merchant_id UUID,
    p_user_wallet VARCHAR(255),
    p_cycle_window INTEGER DEFAULT 3
) RETURNS INTEGER AS $$
DECLARE
    just_in_time_count INTEGER := 0;
    cycle_count INTEGER := 0;
    current_cycle INTEGER;
    payment_window_hours INTEGER := 24; -- Consider topup within 24h of payment as "just-in-time"
BEGIN
    -- Get the current cycle number
    SELECT MAX(cycle_number) INTO current_cycle
    FROM payment_attempts
    WHERE merchant_id = p_merchant_id
      AND user_wallet_address = p_user_wallet;
    
    -- Analyze last p_cycle_window cycles
    FOR cycle_count IN 0..p_cycle_window-1 LOOP
        DECLARE
            cycle_to_check INTEGER := current_cycle - cycle_count;
            topup_found BOOLEAN := FALSE;
            payment_failed BOOLEAN := FALSE;
            payment_time TIMESTAMP;
            topup_time TIMESTAMP;
        BEGIN
            -- Check if there was a failed payment in this cycle
            SELECT attempted_at, TRUE INTO payment_time, payment_failed
            FROM payment_attempts
            WHERE merchant_id = p_merchant_id
              AND user_wallet_address = p_user_wallet
              AND cycle_number = cycle_to_check
              AND status = 'failed'
            ORDER BY attempted_at DESC
            LIMIT 1;
            
            -- If payment failed, check for topup within 24 hours
            IF payment_failed THEN
                SELECT recorded_at, TRUE INTO topup_time, topup_found
                FROM balance_history
                WHERE merchant_id = p_merchant_id
                  AND user_wallet_address = p_user_wallet
                  AND change_type = 'topup'
                  AND recorded_at >= payment_time - INTERVAL '24 hours'
                  AND recorded_at <= payment_time + INTERVAL '24 hours'
                ORDER BY recorded_at DESC
                LIMIT 1;
                
                IF topup_found THEN
                    just_in_time_count := just_in_time_count + 1;
                END IF;
            END IF;
        END;
    END LOOP;
    
    RETURN just_in_time_count;
END;
$$ LANGUAGE plpgsql;

-- Create function to calculate missed payment streak
CREATE OR REPLACE FUNCTION calculate_missed_payment_streak(
    p_merchant_id UUID,
    p_user_wallet VARCHAR(255)
) RETURNS INTEGER AS $$
DECLARE
    missed_streak INTEGER := 0;
    current_cycle INTEGER;
    cycle_to_check INTEGER;
BEGIN
    -- Get the current cycle number
    SELECT MAX(cycle_number) INTO current_cycle
    FROM payment_attempts
    WHERE merchant_id = p_merchant_id
      AND user_wallet_address = p_user_wallet;
    
    -- Count consecutive failed payments backwards from current cycle
    FOR cycle_to_check IN REVERSE current_cycle..0 LOOP
        DECLARE
            cycle_has_success BOOLEAN := FALSE;
        BEGIN
            -- Check if there was any successful payment in this cycle
            SELECT EXISTS(
                SELECT 1 FROM payment_attempts
                WHERE merchant_id = p_merchant_id
                  AND user_wallet_address = p_user_wallet
                  AND cycle_number = cycle_to_check
                  AND status = 'success'
            ) INTO cycle_has_success;
            
            -- If we found a successful payment, break the streak
            IF cycle_has_success THEN
                EXIT;
            END IF;
            
            -- If this cycle had failed payments, increment streak
            IF EXISTS(
                SELECT 1 FROM payment_attempts
                WHERE merchant_id = p_merchant_id
                  AND user_wallet_address = p_user_wallet
                  AND cycle_number = cycle_to_check
                  AND status = 'failed'
            ) THEN
                missed_streak := missed_streak + 1;
            ELSE
                -- No payment attempts in this cycle, break the streak
                EXIT;
            END IF;
        END;
    END LOOP;
    
    RETURN missed_streak;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions (adjust as needed for your setup)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON risk_metrics TO app_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON balance_history TO app_user;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON payment_attempts TO app_user;
-- GRANT SELECT ON high_risk_subscribers TO app_user;
-- GRANT EXECUTE ON FUNCTION detect_just_in_time_topups TO app_user;
-- GRANT EXECUTE ON FUNCTION calculate_missed_payment_streak TO app_user;
