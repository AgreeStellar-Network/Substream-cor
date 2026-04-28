const { ReconciliationWorker } = require('./src/services/reconciliationWorker');
const { ReconciliationScheduler } = require('./src/services/reconciliationScheduler');
const { ReconciliationAnalyticsValidator } = require('./src/services/reconciliationAnalyticsValidator');
const { ReconciliationConfigService } = require('./src/services/reconciliationConfigService');
const { ReconciliationManager } = require('./src/services/reconciliationManager');

// Mock dependencies
const mockDatabase = {
  pool: {
    connect: jest.fn()
  },
  db: {
    prepare: jest.fn(),
    exec: jest.fn()
  }
};

const mockSorobanRpcService = {
  getTransaction: jest.fn(),
  parseTransactionEvents: jest.fn(),
  getEvents: jest.fn()
};

describe('Reconciliation Worker Tests', () => {
  let reconciliationWorker;
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockClient = {
      query: jest.fn(),
      release: jest.fn()
    };
    
    mockDatabase.pool.connect.mockResolvedValue(mockClient);
    
    reconciliationWorker = new ReconciliationWorker(
      mockDatabase, 
      mockSorobanRpcService, 
      { reportsDir: './test-reports' }
    );
  });

  describe('Constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(reconciliationWorker.database).toBe(mockDatabase);
      expect(reconciliationWorker.sorobanRpcService).toBe(mockSorobanRpcService);
      expect(reconciliationWorker.isRunning).toBe(false);
      expect(reconciliationWorker.stats.totalExecutions).toBe(0);
    });
  });

  describe('Reconciliation Logic', () => {
    test('should perform reconciliation between on-chain and database records', async () => {
      const onChainEvents = [
        {
          transaction_hash: '0x123',
          event_index: 0,
          amount: '10000000',
          event_data: { subscriberAddress: 'GABC...', creatorAddress: 'GDEF...', amount: '10000000' }
        }
      ];

      const databaseRecords = [
        {
          transaction_hash: '0x123',
          event_index: 0,
          amount: '10000000'
        }
      ];

      const config = {
        discrepancy_threshold_amount: 0.000001,
        discrepancy_threshold_percentage: 0.01
      };

      const result = await reconciliationWorker.performReconciliation(
        onChainEvents, 
        databaseRecords, 
        config
      );

      expect(result.discrepancies).toHaveLength(0);
      expect(result.missingInDatabase).toBe(0);
      expect(result.missingOnChain).toBe(0);
      expect(result.amountMismatches).toBe(0);
    });

    test('should detect missing database records', async () => {
      const onChainEvents = [
        {
          transaction_hash: '0x123',
          event_index: 0,
          amount: '10000000',
          event_data: { subscriberAddress: 'GABC...', creatorAddress: 'GDEF...', amount: '10000000' }
        }
      ];

      const databaseRecords = []; // Empty database

      const config = {
        discrepancy_threshold_amount: 0.000001,
        discrepancy_threshold_percentage: 0.01
      };

      const result = await reconciliationWorker.performReconciliation(
        onChainEvents, 
        databaseRecords, 
        config
      );

      expect(result.discrepancies).toHaveLength(1);
      expect(result.missingInDatabase).toBe(1);
      expect(result.discrepancies[0].discrepancy_type).toBe('missing_in_database');
    });

    test('should detect amount mismatches', async () => {
      const onChainEvents = [
        {
          transaction_hash: '0x123',
          event_index: 0,
          amount: '10000000',
          event_data: { subscriberAddress: 'GABC...', creatorAddress: 'GDEF...', amount: '10000000' }
        }
      ];

      const databaseRecords = [
        {
          transaction_hash: '0x123',
          event_index: 0,
          amount: '9000000' // Different amount
        }
      ];

      const config = {
        discrepancy_threshold_amount: 0.000001,
        discrepancy_threshold_percentage: 0.01
      };

      const result = await reconciliationWorker.performReconciliation(
        onChainEvents, 
        databaseRecords, 
        config
      );

      expect(result.discrepancies).toHaveLength(1);
      expect(result.amountMismatches).toBe(1);
      expect(result.discrepancies[0].discrepancy_type).toBe('amount_mismatch');
      expect(result.discrepancies[0].amount_difference).toBe(1000000);
    });
  });

  describe('Auto-Healing', () => {
    test('should attempt to heal missing database records', async () => {
      const discrepancies = [
        {
          discrepancy_type: 'missing_in_database',
          transaction_hash: '0x123',
          event_index: 0,
          healing_status: 'pending'
        }
      ];

      const config = {
        auto_heal_enabled: true,
        max_healing_attempts: 3
      };

      // Mock successful RPC response
      mockSorobanRpcService.getTransaction.mockResolvedValue({
        result: { events: [{ type: 'SubscriptionBilled' }] }
      });

      mockSorobanRpcService.parseTransactionEvents.mockResolvedValue([
        {
          type: 'SubscriptionBilled',
          transaction_hash: '0x123',
          event_index: 0,
          parsedData: { subscriberAddress: 'GABC...', creatorAddress: 'GDEF...', amount: '10000000' }
        }
      ]);

      const result = await reconciliationWorker.attemptAutoHealing(discrepancies, config);

      expect(result.healedCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(result.updatedDiscrepancies[0].healing_status).toBe('healed');
    });

    test('should handle healing failures gracefully', async () => {
      const discrepancies = [
        {
          discrepancy_type: 'missing_in_database',
          transaction_hash: '0x123',
          event_index: 0,
          healing_status: 'pending'
        }
      ];

      const config = {
        auto_heal_enabled: true,
        max_healing_attempts: 3
      };

      // Mock failed RPC response
      mockSorobanRpcService.getTransaction.mockRejectedValue(new Error('Transaction not found'));

      const result = await reconciliationWorker.attemptAutoHealing(discrepancies, config);

      expect(result.healedCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.updatedDiscrepancies[0].healing_status).toBe('failed');
    });
  });

  describe('Report Generation', () => {
    test('should generate JSON and CSV reports', async () => {
      const reconciliationResult = {
        discrepancies: [
          {
            discrepancy_type: 'missing_in_database',
            transaction_hash: '0x123',
            event_index: 0,
            amount_difference: 1000000,
            healing_status: 'healed',
            created_at: new Date()
          }
        ]
      };

      const reports = await reconciliationWorker.generateReports(
        'merchant123', 
        '2023-01-01', 
        reconciliationResult
      );

      expect(reports.jsonPath).toContain('reconciliation_report_2023-01-01.json');
      expect(reports.csvPath).toContain('reconciliation_report_2023-01-01.csv');
    });
  });
});

describe('Reconciliation Scheduler Tests', () => {
  let scheduler;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    scheduler = new ReconciliationScheduler(
      mockDatabase, 
      mockSorobanRpcService, 
      { 
        schedule: '0 0 * * *', 
        autoStart: false,
        worker: { reportsDir: './test-reports' }
      }
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Constructor', () => {
    test('should initialize with correct configuration', () => {
      expect(scheduler.database).toBe(mockDatabase);
      expect(scheduler.sorobanRpcService).toBe(mockSorobanRpcService);
      expect(scheduler.isRunning).toBe(false);
      expect(scheduler.schedule).toBe('0 0 * * *');
    });
  });

  describe('Scheduling', () => {
    test('should calculate next run time correctly', () => {
      const nextRunTime = scheduler.getNextRunTime();
      expect(nextRunTime).toBeInstanceOf(Date);
      expect(nextRunTime.getUTCHours()).toBe(0);
      expect(nextRunTime.getUTCMinutes()).toBe(0);
    });

    test('should update statistics correctly', () => {
      scheduler.updateAverageRunTime(100);
      expect(scheduler.stats.averageRunTime).toBe(100);

      scheduler.updateAverageRunTime(200);
      expect(scheduler.stats.averageRunTime).toBe(150);
    });
  });
});

describe('Reconciliation Analytics Validator Tests', () => {
  let validator;

  beforeEach(() => {
    jest.clearAllMocks();
    
    validator = new ReconciliationAnalyticsValidator(
      mockDatabase, 
      mockSorobanRpcService, 
      { tolerancePercentage: 0.01 }
    );
  });

  describe('MRR Validation', () => {
    test('should validate MRR correctly with matching data', async () => {
      const analyticalMRR = {
        totalMRR: 1000,
        activeSubscribers: 10,
        averageRevenuePerUser: 100
      };

      const onChainMRR = {
        totalMRR: 1000,
        activeSubscribers: 10,
        averageRevenuePerUser: 100
      };

      mockClient.query.mockResolvedValue({ rows: [] });
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const result = validator.validateMRRComparison(
        analyticalMRR, 
        onChainMRR, 
        'merchant123', 
        new Date()
      );

      expect(result.isValid).toBe(true);
      expect(result.discrepancies).toHaveLength(0);
    });

    test('should detect MRR discrepancies', async () => {
      const analyticalMRR = {
        totalMRR: 1000,
        activeSubscribers: 10,
        averageRevenuePerUser: 100
      };

      const onChainMRR = {
        totalMRR: 900, // 10% difference
        activeSubscribers: 10,
        averageRevenuePerUser: 90
      };

      const result = validator.validateMRRComparison(
        analyticalMRR, 
        onChainMRR, 
        'merchant123', 
        new Date()
      );

      expect(result.isValid).toBe(false);
      expect(result.discrepancies.length).toBeGreaterThan(0);
      expect(result.discrepancies[0].metric).toBe('totalMRR');
    });
  });

  describe('Cache Management', () => {
    test('should cache validation results', () => {
      const testData = { isValid: true };
      const cacheKey = 'test_key';

      validator.setCache(cacheKey, testData);
      const cached = validator.getFromCache(cacheKey);

      expect(cached).toEqual(testData);
    });

    test('should return null for expired cache entries', () => {
      const testData = { isValid: true };
      const cacheKey = 'test_key';

      // Set cache with very short timeout
      validator.cacheTimeout = 1;
      validator.setCache(cacheKey, testData);

      // Wait for cache to expire
      setTimeout(() => {
        const cached = validator.getFromCache(cacheKey);
        expect(cached).toBeNull();
      }, 10);
    });
  });
});

describe('Reconciliation Config Service Tests', () => {
  let configService;

  beforeEach(() => {
    jest.clearAllMocks();
    
    configService = new ReconciliationConfigService(mockDatabase);
  });

  describe('Configuration Management', () => {
    test('should return default configuration for new merchant', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const config = await configService.getMerchantConfig('merchant123');

      expect(config.merchant_id).toBe('merchant123');
      expect(config.enabled).toBe(true);
      expect(config.auto_heal_enabled).toBe(true);
    });

    test('should validate configuration correctly', () => {
      const validConfig = {
        discrepancy_threshold_amount: 0.000001,
        discrepancy_threshold_percentage: 0.01,
        max_healing_attempts: 3,
        healing_retry_delay_minutes: 5,
        notification_email: 'test@example.com'
      };

      const validation = configService.validateConfig(validConfig);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    test('should reject invalid configuration', () => {
      const invalidConfig = {
        discrepancy_threshold_amount: -1, // Negative amount
        discrepancy_threshold_percentage: 101, // Over 100%
        max_healing_attempts: 15, // Over limit
        healing_retry_delay_minutes: 0, // Too low
        notification_email: 'invalid-email'
      };

      const validation = configService.validateConfig(invalidConfig);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
  });
});

describe('Reconciliation Manager Tests', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    
    manager = new ReconciliationManager(
      mockDatabase, 
      mockSorobanRpcService, 
      { reportsDir: './test-reports' }
    );
  });

  describe('Manager Integration', () => {
    test('should initialize sub-services correctly', () => {
      expect(manager.configService).toBeInstanceOf(ReconciliationConfigService);
      expect(manager.analyticsValidator).toBeInstanceOf(ReconciliationAnalyticsValidator);
      expect(manager.isRunning).toBe(false);
    });

    test('should update statistics correctly', () => {
      manager.updateStats({
        totalReconciliations: 1,
        totalDiscrepanciesFound: 5
      });

      expect(manager.stats.totalReconciliations).toBe(1);
      expect(manager.stats.totalDiscrepanciesFound).toBe(5);
    });

    test('should convert data to CSV format', () => {
      const testData = [
        {
          merchant_id: 'merchant1',
          report_date: '2023-01-01',
          status: 'completed',
          total_discrepancies: 0
        },
        {
          merchant_id: 'merchant2',
          report_date: '2023-01-01',
          status: 'completed',
          total_discrepancies: 2
        }
      ];

      const csv = manager.convertToCsv(testData);
      
      expect(csv).toContain('merchant_id,report_date,status,total_discrepancies');
      expect(csv).toContain('merchant1,2023-01-01,completed,0');
      expect(csv).toContain('merchant2,2023-01-01,completed,2');
    });
  });

  describe('Health Check', () => {
    test('should return healthy status when running', async () => {
      manager.isRunning = true;
      manager.startTime = new Date();

      // Mock successful status checks
      mockClient.query.mockResolvedValue({ rows: [{ count: 1 }] });
      mockDatabase.pool.connect.mockResolvedValue(mockClient);

      const health = await manager.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.status).toBeDefined();
    });

    test('should return unhealthy status when not running', async () => {
      manager.isRunning = false;

      const health = await manager.healthCheck();

      expect(health.healthy).toBe(false);
    });
  });
});

describe('Integration Tests', () => {
  test('should handle end-to-end reconciliation flow', async () => {
    // Mock all database calls
    mockClient.query.mockResolvedValue({ rows: [] });
    mockDatabase.pool.connect.mockResolvedValue(mockClient);

    // Create manager
    const manager = new ReconciliationManager(
      mockDatabase, 
      mockSorobanRpcService, 
      { reportsDir: './test-reports' }
    );

    // Mock successful reconciliation
    const mockReport = {
      id: 'report123',
      merchant_id: 'merchant123',
      report_date: '2023-01-01',
      total_discrepancies: 0,
      auto_healed_count: 0,
      status: 'completed'
    };

    mockClient.query.mockResolvedValue({ rows: [mockReport] });

    // Test getting merchant report
    const report = await manager.getMerchantReport('merchant123', '2023-01-01');

    expect(report).toBeDefined();
    expect(report.merchant_id).toBe('merchant123');
    expect(report.status).toBe('completed');
  });

  test('should handle errors gracefully', async () => {
    const manager = new ReconciliationManager(
      mockDatabase, 
      mockSorobanRpcService, 
      { reportsDir: './test-reports' }
    );

    // Mock database error
    mockDatabase.pool.connect.mockRejectedValue(new Error('Database connection failed'));

    await expect(manager.getSystemSummary()).rejects.toThrow('Database connection failed');
  });
});
