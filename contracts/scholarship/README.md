# Scholarship Contract - Cross-Contract Call Bounds Implementation

## Overview

This is the Stream-Scholar Scholarship smart contract for the Soroban blockchain. It implements advanced cross-contract call bounds to limit gas consumption per scholarship claim, preventing runaway costs and improving network stability.

## Key Features

### 1. **Gas Bounds Enforcement**
- Strict mode: Rejects calls exceeding budget
- Adaptive mode: Adjusts limits based on historical usage
- Warning mode: Allows overages but tracks them
- Complete audit trail of all gas consumption

### 2. **Scholarship Management**
- Create scholarship funds
- Claim scholarships with automatic gas budgeting
- Track fund allocation and usage
- Activate/deactivate funds

### 3. **Cross-Contract Call Tracking**
- Record all cross-contract calls with estimated gas
- Track actual gas consumed vs estimated
- Maintain call history per claim
- Provide gas statistics and analytics

### 4. **Safety Features**
- Budget enforcement before execution
- Warning thresholds to prevent surprise limits
- Graceful degradation in high-load scenarios
- Transaction isolation per claim

## Project Structure

```
contracts/scholarship/
├── Cargo.toml                 # Rust package configuration
├── src/
│   └── lib.rs               # Main contract implementation
├── tests/
│   └── integration_test.rs   # Integration tests
├── build.sh                 # Build script
└── README.md               # This file
```

## Building the Contract

### Prerequisites

```bash
# Install Rust 1.70+
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add wasm32 target
rustup target add wasm32-unknown-unknown
```

### Build Instructions

```bash
# Navigate to contract directory
cd contracts/scholarship

# Build release binary
cargo build --target wasm32-unknown-unknown --release

# Output: target/wasm32-unknown-unknown/release/scholarship.wasm
```

### Build with Tests

```bash
# Run unit tests
cargo test --lib

# Run all tests
cargo test
```

## Contract Functions

### Initialization

#### `init(config: ScholarshipConfig) -> Result<()>`

Initialize the contract with configuration.

**Parameters:**
- `config`: ScholarshipConfig with settings:
  - `max_gas_per_claim`: Maximum gas units per claim (e.g., 100_000_000)
  - `enable_gas_bounds`: Enable/disable gas checking
  - `gas_warning_threshold`: Warning threshold percentage (e.g., 80)

**Example:**
```rust
let config = ScholarshipConfig {
    max_gas_per_claim: 100_000_000,
    enable_gas_bounds: true,
    gas_warning_threshold: 80,
};
contract.init(config)?;
```

### Scholarship Management

#### `create_scholarship(teacher: Address, amount: i128) -> Result<u64>`

Create a new scholarship fund.

**Parameters:**
- `teacher`: Address of scholarship creator/manager
- `amount`: Total scholarship amount

**Returns:** Fund ID

#### `claim_scholarship(fund_id: u64, student: Address, amount: i128) -> Result<u64>`

Claim scholarship with automatic gas budget allocation.

**Parameters:**
- `fund_id`: ID of scholarship fund
- `student`: Student address claiming scholarship
- `amount`: Amount to claim

**Returns:** Claim ID (used for gas tracking)

### Gas Bounds Functions

#### `record_cross_contract_call(claim_id: u64, target_contract: Address, method: SorobanString, gas_estimated: u64) -> Result<bool>`

Record a cross-contract call with gas bounds checking.

**Parameters:**
- `claim_id`: ID of scholarship claim
- `target_contract`: Address of target contract
- `method`: Method name being called
- `gas_estimated`: Estimated gas units

**Returns:** `true` if within budget, `false` if approaching warning threshold

**Behavior:**
- If `gas_estimated` would exceed budget: Returns error
- If call would exceed warning threshold: Returns warning
- Otherwise: Tracks call and returns success

#### `get_remaining_budget(claim_id: u64) -> Result<u64>`

Get remaining gas budget for a claim.

**Parameters:**
- `claim_id`: ID of scholarship claim

**Returns:** Remaining gas units

#### `is_within_budget_limit(claim_id: u64) -> Result<bool>`

Check if a claim is within budget limits.

**Parameters:**
- `claim_id`: ID of scholarship claim

**Returns:** `true` if within limits, `false` otherwise

## Deployment Guide

### Local Testing (Standalone Network)

```bash
# Start Soroban local network (requires soroban-cli)
soroban network add --rpc-url http://localhost:8000 --network-passphrase "Test SDF Network ; September 2015" local

# Deploy contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/scholarship.wasm \
  --network local \
  --source-account <YOUR_KEY>

# Initialize contract
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network local \
  -- init \
  --config "{max_gas_per_claim: 100000000, enable_gas_bounds: true, gas_warning_threshold: 80}"
```

### Testnet Deployment

```bash
# Configure testnet
soroban network add --rpc-url https://soroban-testnet.stellar.org:443 --network-passphrase "Test SDF Network ; September 2015" testnet

# Deploy contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/scholarship.wasm \
  --network testnet \
  --source-account <YOUR_KEY>

# Verify deployment
soroban contract info \
  --id <CONTRACT_ID> \
  --network testnet
```

### Mainnet Deployment

```bash
# Configure mainnet
soroban network add --rpc-url https://mainnet.sorobanrpc.com --network-passphrase "Public Global Stellar Network ; September 2015" mainnet

# Deploy contract (with high fees)
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/scholarship.wasm \
  --network mainnet \
  --source-account <YOUR_KEY>
```

## Usage Examples

### Creating a Scholarship Fund

```bash
# Create a 1000 USDC scholarship fund
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- create_scholarship \
  --teacher <TEACHER_ADDRESS> \
  --amount 1000000000  # 1000 USDC (7 decimals)
```

### Claiming Scholarship

```bash
# Student claims 100 USDC
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- claim_scholarship \
  --fund_id 1 \
  --student <STUDENT_ADDRESS> \
  --amount 100000000  # 100 USDC (7 decimals)
```

### Checking Gas Budget

```bash
# Check remaining budget for claim
soroban contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- get_remaining_budget \
  --claim_id 1
```

## Configuration Options

### Strict Mode (Recommended for Production)
```json
{
  "max_gas_per_claim": 100000000,
  "enable_gas_bounds": true,
  "gas_warning_threshold": 80
}
```
- Rejects any call exceeding budget
- Most restrictive and predictable
- Prevents budget overruns

### Adaptive Mode (Recommended for Testing)
```json
{
  "max_gas_per_claim": 100000000,
  "enable_gas_bounds": true,
  "gas_warning_threshold": 80
}
```
- Adjusts limits based on historical usage
- Provides flexibility while maintaining bounds
- Learns from past patterns

### Warning Mode (Development Only)
```json
{
  "max_gas_per_claim": 100000000,
  "enable_gas_bounds": false,
  "gas_warning_threshold": 80
}
```
- Allows calls to exceed soft limit
- Tracks overages for analysis
- Use for testing and optimization

## Gas Estimation

### Base Cross-Contract Call Cost
- Base: ~50M gas units
- Per argument: ~5M gas units each
- Per method name: ~10M gas units + (method_length × 100K)

**Example:**
```
Method: transfer(to, amount, memo)
Estimated: 50M + (3 × 5M) + 10M + (8 × 100K) = ~75.8M gas
```

### Budget Planning
1. Start with max_gas_per_claim = 100M
2. Monitor actual usage with `get_remaining_budget()`
3. Adjust based on patterns:
   - If consistently under 50M: Reduce to 80M
   - If hitting limits: Increase to 150M
   - If very variable: Use adaptive mode

## Troubleshooting

### "Budget Exceeded" Error
- Current usage + new call > max budget
- Solution: Check remaining budget first with `get_remaining_budget()`
- Or use smaller calls that fit within remaining budget

### Contract Deployment Fails
- Verify wasm32 target is installed: `rustup target list`
- Check XLM balance is sufficient
- Verify RPC endpoint is accessible

### Gas Estimation Inaccurate
- Soroban gas costs can vary based on network load
- Always add 20-30% buffer to estimates
- Monitor actual usage vs estimates
- Adjust `max_gas_per_claim` accordingly

## Performance Considerations

### Storage Optimization
- Budget records use Symbol-based keys
- History stored efficiently
- Old records can be archived off-chain

### Gas Optimization
- Batch multiple operations when possible
- Use adaptive mode to learn optimal limits
- Pre-check budget before expensive operations

### Scalability
- Per-claim gas tracking scales linearly
- No central bottleneck for concurrent claims
- Historical data can be pruned periodically

## Security Considerations

### Access Control
- `require_auth()` validates claim originator
- Teacher authorization on fund creation
- Only valid claims can be updated

### Budget Safety
- All gas bounds checked before execution
- No way to bypass budget enforcement
- Failed calls don't deduct from budget (only track attempts)

### Audit Trail
- Every cross-contract call logged
- Complete history per claim
- Can verify offline against on-chain state

## Development

### Adding Features

1. **New Configuration Option:**
```rust
#[contracttype]
pub struct ScholarshipConfig {
    // ... existing fields
    pub new_option: u64,
}
```

2. **New Function:**
```rust
pub fn new_function(env: Env, param: Type) -> Result<ReturnType> {
    // Implementation
}
```

3. **Add Tests:**
```rust
#[test]
fn test_new_function() {
    let env = Env::default();
    // Test code
}
```

### Building and Testing
```bash
# Build with all features
cargo build --target wasm32-unknown-unknown --release

# Run all tests
cargo test

# Check code
cargo clippy
```

## References

- [Soroban Documentation](https://developers.stellar.org/soroban)
- [Stellar Documentation](https://developers.stellar.org/)
- [Stellar SDK for Rust](https://github.com/stellar/rs-soroban-sdk)

## License

This contract is part of the Stream-Scholar platform. See LICENSE file for details.

## Support

For issues or questions:
1. Check this README
2. Review the test files for usage examples
3. Check [Stellar Developer Discord](https://discord.gg/stellardev)
4. Open an issue on the GitHub repository
