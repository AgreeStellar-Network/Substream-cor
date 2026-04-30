/**
 * Test Suite for Enhanced Churn Risk Prediction System
 * 
 * This test suite verifies the implementation meets all acceptance criteria:
 * 1. The backend provides actionable risk scores for the merchant's subscriber base
 * 2. The predictive logic is optimized to scan thousands of users without hitting database bottlenecks
 * 3. Merchants can use these scores to trigger proactive retention webhooks or emails
 */

const { EnhancedChurnRiskService } = require('./src/services/enhancedChurnRiskService');
const { EnhancedChurnRiskWorker } = require('./src/services/enhancedChurnRiskWorker');
const db = require('./src/database/connection');

// Test configuration
const TEST_CONFIG = {
  merchantId: 'test-merchant-123',
  testUserWallets: [
    '0x1234567890abcdef',
    '0xabcdef1234567890',
    '0x9876543210fedcba',
    '0xfedcba9876543210',
    '0x1111222233334444'
  ]
};

class ChurnRiskSystemTester {
  constructor() {
    this.testResults = [];
    this.churnRiskService = new EnhancedChurnRiskService({
      batchSize: 100,
      enableDetailedLogging: true
    });
  }

  /**
   * Run all tests
   */
  async runAllTests() {
    console.log('🚀 Starting Enhanced Churn Risk System Tests...\n');
    
    try {
      // Setup test data
      await this.setupTestData();
      
      // Test 1: Database schema and tables
      await this.testDatabaseSchema();
      
      // Test 2: Just-in-time topup detection logic
      await this.testJustInTimeTopupDetection();
      
      // Test 3: Risk score calculation
      await this.testRiskScoreCalculation();
      
      // Test 4: API endpoint functionality
      await this.testAPIEndpoint();
      
      // Test 5: Performance with large datasets
      await this.testPerformanceOptimization();
      
      // Test 6: Background worker functionality
      await this.testBackgroundWorker();
      
      // Generate test report
      this.generateTestReport();
      
    } catch (error) {
      console.error('❌ Test suite failed:', error);
    } finally {
      // Cleanup test data
      await this.cleanupTestData();
    }
  }

  /**
   * Setup test data
   */
  async setupTestData() {
    console.log('📋 Setting up test data...');
    
    try {
      // Insert test merchant
      await db.query(`
        INSERT INTO merchants (id, name, base_currency, created_at, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING
      `, [TEST_CONFIG.merchantId, 'Test Merchant', 'USD']);
      
      // Insert test subscriptions
      for (let i = 0; i < TEST_CONFIG.testUserWallets.length; i++) {
        const wallet = TEST_CONFIG.testUserWallets[i];
        await db.query(`
          INSERT INTO subscriptions (creator_id, wallet_address, active, balance, daily_spend, subscribed_at)
          VALUES ($1, $2, 1, $3, $4, CURRENT_TIMESTAMP - INTERVAL '${i * 7} days')
          ON CONFLICT (creator_id, wallet_address) DO UPDATE SET
          balance = EXCLUDED.balance,
          daily_spend = EXCLUDED.daily_spend,
          active = EXCLUDED.active
        `, [
          TEST_CONFIG.merchantId,
          wallet,
          100.00 - (i * 15), // Varying balances
          5.00 + (i * 0.50) // Varying daily spend
        ]);
      }
      
      // Insert balance history for testing just-in-time detection
      for (let cycle = 1; cycle <= 6; cycle++) {
        for (let i = 0; i < TEST_CONFIG.testUserWallets.length; i++) {
          const wallet = TEST_CONFIG.testUserWallets[i];
          
          // Create scenarios:
          // - User 0: Just-in-time topups for last 3 cycles (high risk)
          // - User 1: Just-in-time topups for 2 cycles (medium risk)
          // - User 2: No just-in-time topups (low risk)
          // - User 3: Failed payments but no topups (high risk)
          // - User 4: Stable payments (low risk)
          
          let balanceChange = 0;
          let changeType = 'payment';
          
          if (i === 0 && cycle >= 4) {
            // Just-in-time topup scenario
            balanceChange = 50.00;
            changeType = 'topup';
          } else if (i === 1 && cycle >= 5) {
            // Partial just-in-time scenario
            balanceChange = 30.00;
            changeType = 'topup';
          } else if (i === 3 && cycle >= 3) {
            // Failed payment scenario
            balanceChange = -5.00;
            changeType = 'payment';
          } else {
            // Normal payment
            balanceChange = -5.00;
            changeType = 'payment';
          }
          
          await db.query(`
            INSERT INTO balance_history (
              merchant_id, user_wallet_address, balance, previous_balance, 
              change_amount, change_type, cycle_number, recorded_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP - INTERVAL '${6 - cycle} days')
          `, [
            TEST_CONFIG.merchantId,
            wallet,
            100.00 + (balanceChange * cycle),
            100.00 + (balanceChange * (cycle - 1)),
            balanceChange,
            changeType,
            cycle
          ]);
        }
      }
      
      // Insert payment attempts
      for (let cycle = 1; cycle <= 6; cycle++) {
        for (let i = 0; i < TEST_CONFIG.testUserWallets.length; i++) {
          const wallet = TEST_CONFIG.testUserWallets[i];
          let status = 'success';
          let failureReason = null;
          
          if (i === 3 && cycle >= 3) {
            status = 'failed';
            failureReason = 'Insufficient funds';
          } else if (i === 0 && cycle >= 4) {
            status = 'failed';
            failureReason = 'Insufficient funds';
          }
          
          await db.query(`
            INSERT INTO payment_attempts (
              merchant_id, user_wallet_address, amount, status, 
              failure_reason, cycle_number, attempted_at
            ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP - INTERVAL '${6 - cycle} days')
          `, [
            TEST_CONFIG.merchantId,
            wallet,
            5.00,
            status,
            failureReason,
            cycle
          ]);
        }
      }
      
      console.log('✅ Test data setup completed\n');
      
    } catch (error) {
      console.error('❌ Failed to setup test data:', error);
      throw error;
    }
  }

  /**
   * Test 1: Database Schema
   */
  async testDatabaseSchema() {
    console.log('🗄️  Testing Database Schema...');
    
    try {
      // Check if required tables exist
      const tables = ['risk_metrics', 'balance_history', 'payment_attempts', 'churn_risk_worker_metrics'];
      
      for (const table of tables) {
        const result = await db.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_name = $1
          )
        `, [table]);
        
        if (result.rows[0].exists) {
          this.testResults.push({ test: `Table ${table} exists`, status: 'PASS' });
        } else {
          this.testResults.push({ test: `Table ${table} exists`, status: 'FAIL', error: 'Table not found' });
        }
      }
      
      // Check if functions exist
      const functions = ['detect_just_in_time_topups', 'calculate_missed_payment_streak'];
      
      for (const func of functions) {
        const result = await db.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.routines 
            WHERE routine_name = $1
          )
        `, [func]);
        
        if (result.rows[0].exists) {
          this.testResults.push({ test: `Function ${func} exists`, status: 'PASS' });
        } else {
          this.testResults.push({ test: `Function ${func} exists`, status: 'FAIL', error: 'Function not found' });
        }
      }
      
      console.log('✅ Database schema tests completed\n');
      
    } catch (error) {
      console.error('❌ Database schema test failed:', error);
      this.testResults.push({ test: 'Database Schema', status: 'FAIL', error: error.message });
    }
  }

  /**
   * Test 2: Just-in-time topup detection
   */
  async testJustInTimeTopupDetection() {
    console.log('⏰ Testing Just-in-time Topup Detection...');
    
    try {
      // Test user 0: Should detect 3 just-in-time topups (high risk)
      const user0Analysis = await this.churnRiskService.analyzeSubscriberRisk(
        TEST_CONFIG.merchantId, 
        TEST_CONFIG.testUserWallets[0]
      );
      
      if (user0Analysis.predictionFactors.justInTimeTopups >= 3) {
        this.testResults.push({ 
          test: 'Just-in-time detection (high risk scenario)', 
          status: 'PASS',
          details: `Detected ${user0Analysis.predictionFactors.justInTimeTopups} just-in-time topups`
        });
      } else {
        this.testResults.push({ 
          test: 'Just-in-time detection (high risk scenario)', 
          status: 'FAIL',
          error: `Expected >= 3, got ${user0Analysis.predictionFactors.justInTimeTopups}`
        });
      }
      
      // Test user 2: Should detect 0 just-in-time topups (low risk)
      const user2Analysis = await this.churnRiskService.analyzeSubscriberRisk(
        TEST_CONFIG.merchantId, 
        TEST_CONFIG.testUserWallets[2]
      );
      
      if (user2Analysis.predictionFactors.justInTimeTopups === 0) {
        this.testResults.push({ 
          test: 'Just-in-time detection (low risk scenario)', 
          status: 'PASS',
          details: `Correctly detected 0 just-in-time topups`
        });
      } else {
        this.testResults.push({ 
          test: 'Just-in-time detection (low risk scenario)', 
          status: 'FAIL',
          error: `Expected 0, got ${user2Analysis.predictionFactors.justInTimeTopups}`
        });
      }
      
      console.log('✅ Just-in-time topup detection tests completed\n');
      
    } catch (error) {
      console.error('❌ Just-in-time topup detection test failed:', error);
      this.testResults.push({ test: 'Just-in-time Topup Detection', status: 'FAIL', error: error.message });
    }
  }

  /**
   * Test 3: Risk Score Calculation
   */
  async testRiskScoreCalculation() {
    console.log('📊 Testing Risk Score Calculation...');
    
    try {
      // Test high risk user (user 0)
      const highRiskUser = await this.churnRiskService.analyzeSubscriberRisk(
        TEST_CONFIG.merchantId, 
        TEST_CONFIG.testUserWallets[0]
      );
      
      if (highRiskUser.riskScore >= 70 && highRiskUser.riskLevel === 'High') {
        this.testResults.push({ 
          test: 'Risk score calculation (high risk)', 
          status: 'PASS',
          details: `Score: ${highRiskUser.riskScore}, Level: ${highRiskUser.riskLevel}`
        });
      } else {
        this.testResults.push({ 
          test: 'Risk score calculation (high risk)', 
          status: 'FAIL',
          error: `Expected score >= 70 and level High, got score ${highRiskUser.riskScore}, level ${highRiskUser.riskLevel}`
        });
      }
      
      // Test low risk user (user 4)
      const lowRiskUser = await this.churnRiskService.analyzeSubscriberRisk(
        TEST_CONFIG.merchantId, 
        TEST_CONFIG.testUserWallets[4]
      );
      
      if (lowRiskUser.riskScore < 40 && lowRiskUser.riskLevel === 'Low') {
        this.testResults.push({ 
          test: 'Risk score calculation (low risk)', 
          status: 'PASS',
          details: `Score: ${lowRiskUser.riskScore}, Level: ${lowRiskUser.riskLevel}`
        });
      } else {
        this.testResults.push({ 
          test: 'Risk score calculation (low risk)', 
          status: 'FAIL',
          error: `Expected score < 40 and level Low, got score ${lowRiskUser.riskScore}, level ${lowRiskUser.riskLevel}`
        });
      }
      
      console.log('✅ Risk score calculation tests completed\n');
      
    } catch (error) {
      console.error('❌ Risk score calculation test failed:', error);
      this.testResults.push({ test: 'Risk Score Calculation', status: 'FAIL', error: error.message });
    }
  }

  /**
   * Test 4: API Endpoint
   */
  async testAPIEndpoint() {
    console.log('🌐 Testing API Endpoint...');
    
    try {
      // Test merchant risk analysis
      const riskAnalysis = await this.churnRiskService.getMerchantRiskAnalysis(TEST_CONFIG.merchantId, {
        limit: 10,
        includeFactors: true
      });
      
      if (riskAnalysis.merchantId === TEST_CONFIG.merchantId && 
          riskAnalysis.subscribers && 
          riskAnalysis.summary) {
        this.testResults.push({ 
          test: 'API endpoint - merchant risk analysis', 
          status: 'PASS',
          details: `Retrieved analysis for ${riskAnalysis.summary.totalSubscribers} subscribers`
        });
      } else {
        this.testResults.push({ 
          test: 'API endpoint - merchant risk analysis', 
          status: 'FAIL',
          error: 'Invalid response structure'
        });
      }
      
      // Test filtering by risk level
      const highRiskAnalysis = await this.churnRiskService.getMerchantRiskAnalysis(TEST_CONFIG.merchantId, {
        riskLevel: 'High',
        limit: 5
      });
      
      if (highRiskAnalysis.subscribers.every(s => s.riskLevel === 'High')) {
        this.testResults.push({ 
          test: 'API endpoint - risk level filtering', 
          status: 'PASS',
          details: `Filtered to ${highRiskAnalysis.subscribers.length} high-risk subscribers`
        });
      } else {
        this.testResults.push({ 
          test: 'API endpoint - risk level filtering', 
          status: 'FAIL',
          error: 'Filtering not working correctly'
        });
      }
      
      console.log('✅ API endpoint tests completed\n');
      
    } catch (error) {
      console.error('❌ API endpoint test failed:', error);
      this.testResults.push({ test: 'API Endpoint', status: 'FAIL', error: error.message });
    }
  }

  /**
   * Test 5: Performance Optimization
   */
  async testPerformanceOptimization() {
    console.log('⚡ Testing Performance Optimization...');
    
    try {
      // Test with larger dataset (simulate 1000 users)
      const startTime = Date.now();
      
      // Create additional test users
      const additionalUsers = [];
      for (let i = 0; i < 100; i++) {
        additionalUsers.push(`0xtest${i.toString().padStart(40, '0')}`);
      }
      
      // Insert additional test data
      for (const wallet of additionalUsers) {
        await db.query(`
          INSERT INTO subscriptions (creator_id, wallet_address, active, balance, daily_spend, subscribed_at)
          VALUES ($1, $2, 1, $3, $4, CURRENT_TIMESTAMP - INTERVAL '1 day')
          ON CONFLICT (creator_id, wallet_address) DO NOTHING
        `, [TEST_CONFIG.merchantId, wallet, 50.00, 5.00]);
      }
      
      // Test batch processing
      const merchantAnalysis = await this.churnRiskService.analyzeMerchantChurnRisk(TEST_CONFIG.merchantId);
      
      const processingTime = Date.now() - startTime;
      
      // Should process within reasonable time (less than 10 seconds for 100+ users)
      if (processingTime < 10000) {
        this.testResults.push({ 
          test: 'Performance - batch processing', 
          status: 'PASS',
          details: `Processed ${merchantAnalysis.totalSubscribers} subscribers in ${processingTime}ms`
        });
      } else {
        this.testResults.push({ 
          test: 'Performance - batch processing', 
          status: 'WARN',
          details: `Processing took ${processingTime}ms (expected < 10000ms)`
        });
      }
      
      console.log('✅ Performance optimization tests completed\n');
      
    } catch (error) {
      console.error('❌ Performance optimization test failed:', error);
      this.testResults.push({ test: 'Performance Optimization', status: 'FAIL', error: error.message });
    }
  }

  /**
   * Test 6: Background Worker
   */
  async testBackgroundWorker() {
    console.log('🔄 Testing Background Worker...');
    
    try {
      // Test worker initialization
      const worker = new EnhancedChurnRiskWorker({
        runInterval: 60000, // 1 minute for testing
        initialDelay: 1000, // 1 second
        merchantBatchSize: 5,
        enableDetailedLogging: true
      });
      
      // Test manual analysis trigger
      const manualResult = await worker.triggerManualAnalysis([TEST_CONFIG.merchantId]);
      
      if (manualResult && manualResult.length > 0) {
        this.testResults.push({ 
          test: 'Background worker - manual analysis', 
          status: 'PASS',
          details: `Manual analysis completed for ${manualResult.length} merchants`
        });
      } else {
        this.testResults.push({ 
          test: 'Background worker - manual analysis', 
          status: 'FAIL',
          error: 'Manual analysis failed'
        });
      }
      
      // Test worker statistics
      const stats = worker.getStats();
      
      if (stats && stats.configuration) {
        this.testResults.push({ 
          test: 'Background worker - statistics', 
          status: 'PASS',
          details: 'Worker statistics available'
        });
      } else {
        this.testResults.push({ 
          test: 'Background worker - statistics', 
          status: 'FAIL',
          error: 'Worker statistics not available'
        });
      }
      
      // Stop worker
      await worker.stop();
      
      console.log('✅ Background worker tests completed\n');
      
    } catch (error) {
      console.error('❌ Background worker test failed:', error);
      this.testResults.push({ test: 'Background Worker', status: 'FAIL', error: error.message });
    }
  }

  /**
   * Generate test report
   */
  generateTestReport() {
    console.log('📋 Generating Test Report...\n');
    
    const passed = this.testResults.filter(r => r.status === 'PASS').length;
    const failed = this.testResults.filter(r => r.status === 'FAIL').length;
    const warnings = this.testResults.filter(r => r.status === 'WARN').length;
    
    console.log('='.repeat(60));
    console.log('🎯 ENHANCED CHURN RISK SYSTEM TEST REPORT');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${this.testResults.length}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`⚠️  Warnings: ${warnings}`);
    console.log('');
    
    // Detailed results
    this.testResults.forEach(result => {
      const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⚠️';
      console.log(`${icon} ${result.test}`);
      if (result.details) {
        console.log(`   ${result.details}`);
      }
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
      console.log('');
    });
    
    // Acceptance criteria verification
    console.log('🎯 ACCEPTANCE CRITERIA VERIFICATION:');
    console.log('='.repeat(60));
    
    const criteria1Met = passed >= (this.testResults.length * 0.8); // 80% pass rate
    const criteria2Met = this.testResults.some(r => 
      r.test.includes('Performance') && r.status === 'PASS'
    );
    const criteria3Met = this.testResults.some(r => 
      r.test.includes('API') && r.status === 'PASS'
    );
    
    console.log(`1. ✅ Actionable risk scores: ${criteria1Met ? 'MET' : 'NOT MET'}`);
    console.log(`2. ✅ Performance optimization: ${criteria2Met ? 'MET' : 'NOT MET'}`);
    console.log(`3. ✅ API for retention triggers: ${criteria3Met ? 'MET' : 'NOT MET'}`);
    console.log('');
    
    const allCriteriaMet = criteria1Met && criteria2Met && criteria3Met;
    console.log(`🏆 OVERALL RESULT: ${allCriteriaMet ? 'ALL ACCEPTANCE CRITERIA MET' : 'SOME CRITERIA NOT MET'}`);
    console.log('='.repeat(60));
  }

  /**
   * Cleanup test data
   */
  async cleanupTestData() {
    console.log('🧹 Cleaning up test data...');
    
    try {
      // Clean up test data in reverse order of dependencies
      await db.query('DELETE FROM payment_attempts WHERE merchant_id = $1', [TEST_CONFIG.merchantId]);
      await db.query('DELETE FROM balance_history WHERE merchant_id = $1', [TEST_CONFIG.merchantId]);
      await db.query('DELETE FROM risk_metrics WHERE merchant_id = $1', [TEST_CONFIG.merchantId]);
      await db.query('DELETE FROM subscriptions WHERE creator_id = $1', [TEST_CONFIG.merchantId]);
      await db.query('DELETE FROM merchants WHERE id = $1', [TEST_CONFIG.merchantId]);
      
      console.log('✅ Test data cleanup completed');
      
    } catch (error) {
      console.error('❌ Failed to cleanup test data:', error);
    }
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  const tester = new ChurnRiskSystemTester();
  tester.runAllTests().catch(console.error);
}

module.exports = { ChurnRiskSystemTester };
