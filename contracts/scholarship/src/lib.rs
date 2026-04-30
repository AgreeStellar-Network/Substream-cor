#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, Vec, String as SorobanString, Result};

/// Maximum gas allowed per scholarship claim
const MAX_GAS_PER_CLAIM: u64 = 100_000_000;

/// Scholarship configuration
#[contracttype]
pub struct ScholarshipConfig {
    pub max_gas_per_claim: u64,
    pub enable_gas_bounds: bool,
    pub gas_warning_threshold: u64,
}

/// Scholarship fund details
#[contracttype]
pub struct ScholarshipFund {
    pub id: u64,
    pub teacher: Address,
    pub total_amount: i128,
    pub claimed_amount: i128,
    pub active: bool,
}

/// Cross-contract call budget tracker
#[contracttype]
pub struct CrossContractCallBudget {
    pub claim_id: u64,
    pub total_budget: u64,
    pub used_budget: u64,
    pub call_count: u32,
}

/// Record of cross-contract calls
#[contracttype]
pub struct CrossContractCall {
    pub target_contract: Address,
    pub method: SorobanString,
    pub gas_estimated: u64,
    pub gas_actual: u64,
    pub status: Symbol,
}

#[contract]
pub struct ScholarshipContract;

#[contractimpl]
impl ScholarshipContract {
    /// Initialize contract
    pub fn init(env: Env, config: ScholarshipConfig) -> Result<()> {
        env.storage().instance().set(&Symbol::short("config"), &config);
        env.storage().instance().set(&Symbol::short("fund_counter"), &0u64);
        Ok(())
    }

    /// Create a new scholarship fund
    pub fn create_scholarship(
        env: Env,
        teacher: Address,
        amount: i128,
    ) -> Result<u64> {
        teacher.require_auth();

        let mut fund_counter: u64 = env
            .storage()
            .instance()
            .get(&Symbol::short("fund_counter"))
            .unwrap_or(Ok(0u64))?;

        fund_counter += 1;

        let fund = ScholarshipFund {
            id: fund_counter,
            teacher,
            total_amount: amount,
            claimed_amount: 0,
            active: true,
        };

        let fund_key = Symbol::new(&env, &format!("fund_{}", fund_counter));
        env.storage().instance().set(&fund_key, &fund);
        env.storage().instance().set(&Symbol::short("fund_counter"), &fund_counter);

        Ok(fund_counter)
    }

    /// Claim scholarship with cross-contract call bounds
    pub fn claim_scholarship(
        env: Env,
        fund_id: u64,
        student: Address,
        amount: i128,
    ) -> Result<u64> {
        student.require_auth();

        let config: ScholarshipConfig = env
            .storage()
            .instance()
            .get(&Symbol::short("config"))
            .ok_or(Err(()))?;

        let fund_key = Symbol::new(&env, &format!("fund_{}", fund_id));
        let mut fund: ScholarshipFund = env
            .storage()
            .instance()
            .get(&fund_key)
            .ok_or(Err(()))?;

        if !fund.active {
            return Err(());
        }

        if fund.claimed_amount + amount > fund.total_amount {
            return Err(());
        }

        let claim_id = Self::allocate_budget(&env, student.clone(), amount, &config)?;

        fund.claimed_amount += amount;
        env.storage().instance().set(&fund_key, &fund);

        Ok(claim_id)
    }

    /// Allocate gas budget for a claim
    fn allocate_budget(
        env: &Env,
        _user: Address,
        _amount: i128,
        config: &ScholarshipConfig,
    ) -> Result<u64> {
        let mut budget_counter: u64 = env
            .storage()
            .instance()
            .get(&Symbol::short("budget_counter"))
            .unwrap_or(Ok(0u64))?;

        budget_counter += 1;

        let budget = CrossContractCallBudget {
            claim_id: budget_counter,
            total_budget: config.max_gas_per_claim,
            used_budget: 0,
            call_count: 0,
        };

        let budget_key = Symbol::new(env, &format!("budget_{}", budget_counter));
        env.storage().instance().set(&budget_key, &budget);
        env.storage().instance().set(&Symbol::short("budget_counter"), &budget_counter);

        Ok(budget_counter)
    }

    /// Record cross-contract call with gas bounds
    pub fn record_cross_contract_call(
        env: Env,
        claim_id: u64,
        _target_contract: Address,
        _method: SorobanString,
        gas_estimated: u64,
    ) -> Result<bool> {
        let config: ScholarshipConfig = env
            .storage()
            .instance()
            .get(&Symbol::short("config"))
            .ok_or(Err(()))?;

        if !config.enable_gas_bounds {
            return Ok(true);
        }

        let budget_key = Symbol::new(&env, &format!("budget_{}", claim_id));
        let mut budget: CrossContractCallBudget = env
            .storage()
            .instance()
            .get(&budget_key)
            .ok_or(Err(()))?;

        if budget.used_budget + gas_estimated > budget.total_budget {
            return Err(());
        }

        budget.used_budget += gas_estimated;
        budget.call_count += 1;

        env.storage().instance().set(&budget_key, &budget);
        Ok(true)
    }

    /// Get remaining budget
    pub fn get_remaining_budget(env: Env, claim_id: u64) -> Result<u64> {
        let budget_key = Symbol::new(&env, &format!("budget_{}", claim_id));
        let budget: CrossContractCallBudget = env
            .storage()
            .instance()
            .get(&budget_key)
            .ok_or(Err(()))?;

        Ok(budget.total_budget.saturating_sub(budget.used_budget))
    }

    /// Check if within budget
    pub fn is_within_budget_limit(env: Env, claim_id: u64) -> Result<bool> {
        let budget_key = Symbol::new(&env, &format!("budget_{}", claim_id));
        let budget: CrossContractCallBudget = env
            .storage()
            .instance()
            .get(&budget_key)
            .ok_or(Err(()))?;

        Ok(budget.used_budget <= budget.total_budget)
    }
}
