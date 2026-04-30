#![no_std]

use soroban_sdk::{contracttype, Address, Env, Symbol, Vec, String as SorobanString};

/// Gas bounds enforcement mode
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GasBoundsMode {
    Strict,     // Reject any call that exceeds budget
    Adaptive,   // Adjust limits based on historical usage
    Warning,    // Warn but allow, track overages
}

/// Gas tracking statistics for analysis and optimization
#[contracttype]
pub struct GasStatistics {
    pub total_claims: u64,
    pub total_gas_allocated: u64,
    pub total_gas_used: u64,
    pub max_gas_per_claim: u64,
    pub avg_gas_per_claim: u64,
    pub peak_gas_usage: u64,
    pub claims_within_limit: u64,
    pub claims_exceeded_limit: u64,
}

/// Gas quota per student with historical tracking
#[contracttype]
pub struct StudentGasQuota {
    pub student: Address,
    pub total_quota: u64,
    pub used_quota: u64,
    pub last_reset: u64,
    pub claim_history: Vec<ClaimGasRecord>,
}

/// Individual claim gas record
#[contracttype]
pub struct ClaimGasRecord {
    pub claim_id: u64,
    pub gas_allocated: u64,
    pub gas_used: u64,
    pub cross_contract_calls: u32,
    pub completion_status: Symbol, // "success", "partial", "failed", "reverted"
}

/// Gas optimization hint for upcoming calls
#[contracttype]
pub struct GasOptimizationHint {
    pub method_name: SorobanString,
    pub estimated_gas: u64,
    pub historical_avg: u64,
    pub peak_observed: u64,
    pub recommendation: SorobanString,
}

/// Gas bounds manager for scholarship claims
pub struct GasBoundsManager;

impl GasBoundsManager {
    /// Calculate adaptive gas limit based on historical data
    pub fn calculate_adaptive_limit(
        env: &Env,
        student: &Address,
        base_limit: u64,
        mode: GasBoundsMode,
    ) -> u64 {
        if mode == GasBoundsMode::Strict {
            return base_limit;
        }

        // Retrieve student gas statistics
        let stats_key = Symbol::new(env, &format!("stats_{}", student));
        let stats_result: Result<StudentGasQuota, _> = env
            .storage()
            .instance()
            .get(&stats_key)
            .map(|v| v)
            .ok_or(());

        if let Ok(stats) = stats_result {
            if stats.total_quota > 0 && stats.claim_history.len() > 0 {
                // Calculate average gas usage
                let avg_used = stats.used_quota / stats.claim_history.len() as u64;

                // Apply adaptive multiplier (1.2x to 1.5x average for buffer)
                let adaptive_factor = if avg_used > 0 {
                    let utilization = (stats.used_quota * 100) / stats.total_quota;
                    if utilization > 80 {
                        // High usage, tighter limits
                        120 // 1.2x
                    } else if utilization > 50 {
                        // Moderate usage
                        130 // 1.3x
                    } else {
                        // Low usage, more generous
                        150 // 1.5x
                    }
                } else {
                    100 // Use base limit
                };

                return (base_limit * adaptive_factor) / 100;
            }
        }

        base_limit
    }

    /// Estimate gas for a cross-contract call
    pub fn estimate_call_gas(
        _env: &Env,
        method: &SorobanString,
        arg_count: u32,
    ) -> u64 {
        // Base gas cost for cross-contract call
        let base_cost = 50_000_000u64;

        // Add per-argument cost
        let arg_cost = 5_000_000u64 * arg_count as u64;

        // Add per-method-name cost (variable based on method complexity)
        // This is a simplified estimation; real costs depend on contract implementation
        let method_cost = (method.len() as u64 * 100_000) + 10_000_000;

        base_cost + arg_cost + method_cost
    }

    /// Track gas consumption with historical averaging
    pub fn record_gas_usage(
        env: &Env,
        student: &Address,
        claim_id: u64,
        gas_allocated: u64,
        gas_used: u64,
        call_count: u32,
    ) {
        let stats_key = Symbol::new(env, &format!("stats_{}", student));

        let mut quota: StudentGasQuota = env
            .storage()
            .instance()
            .get(&stats_key)
            .unwrap_or(StudentGasQuota {
                student: student.clone(),
                total_quota: 0,
                used_quota: 0,
                last_reset: 0,
                claim_history: Vec::new(env),
            });

        let record = ClaimGasRecord {
            claim_id,
            gas_allocated,
            gas_used,
            cross_contract_calls: call_count,
            completion_status: if gas_used <= gas_allocated {
                Symbol::short("success")
            } else {
                Symbol::short("partial")
            },
        };

        quota.claim_history.push_back(record);
        quota.total_quota += gas_allocated;
        quota.used_quota += gas_used;

        env.storage().instance().set(&stats_key, &quota);
    }

    /// Get optimization hint for method
    pub fn get_optimization_hint(
        env: &Env,
        method: &SorobanString,
    ) -> Option<GasOptimizationHint> {
        let hint_key = Symbol::new(env, &format!("hint_{}", method));

        env.storage()
            .instance()
            .get(&hint_key)
            .ok()
    }

    /// Analyze gas usage patterns and provide recommendations
    pub fn analyze_gas_pattern(
        env: &Env,
        student: &Address,
    ) -> Result<GasStatistics, ()> {
        let stats_key = Symbol::new(env, &format!("stats_{}", student));

        let quota: StudentGasQuota = env
            .storage()
            .instance()
            .get(&stats_key)
            .ok_or(())?;

        let claim_count = quota.claim_history.len() as u64;
        let avg_gas = if claim_count > 0 {
            quota.used_quota / claim_count
        } else {
            0
        };

        let mut peak = 0u64;
        let mut within_limit = 0u64;
        let mut exceeded_limit = 0u64;

        for record in quota.claim_history.iter() {
            if record.gas_used > peak {
                peak = record.gas_used;
            }
            if record.gas_used <= record.gas_allocated {
                within_limit += 1;
            } else {
                exceeded_limit += 1;
            }
        }

        Ok(GasStatistics {
            total_claims: claim_count,
            total_gas_allocated: quota.total_quota,
            total_gas_used: quota.used_quota,
            max_gas_per_claim: quota.total_quota / claim_count.max(1),
            avg_gas_per_claim: avg_gas,
            peak_gas_usage: peak,
            claims_within_limit: within_limit,
            claims_exceeded_limit: exceeded_limit,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_call_gas() {
        let env = soroban_sdk::Env::default();
        let method = SorobanString::from_slice(&env, b"test_method");

        let gas = GasBoundsManager::estimate_call_gas(&env, &method, 3);
        assert!(gas > 0);
        assert!(gas > 50_000_000); // Should be more than base cost
    }

    #[test]
    fn test_adaptive_limit_strict_mode() {
        let env = soroban_sdk::Env::default();
        let student = soroban_sdk::Address::random(&env);
        let base_limit = 100_000_000;

        let limit = GasBoundsManager::calculate_adaptive_limit(
            &env,
            &student,
            base_limit,
            GasBoundsMode::Strict,
        );

        assert_eq!(limit, base_limit);
    }
}
