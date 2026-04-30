const { ReconciliationWorker } = require('./src/services/reconciliationWorker');
const { merchantService } = require('./src/services/merchantService');
const { AppDatabase } = require('./src/db/appDatabase');

// Mock dependencies
jest.mock('./src/services/merchantService');
jest.mock('./src/db/appDatabase');
jest.mock('./src/services/sorobanRpcService');

describe('ReconciliationWorker', () => {
  let reconciliationWorker;
  let mockDatabase;
  let mockRpcService;
  let mockLogger;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    
    // Mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };

    // Mock database
    mockDatabase = {
      query: jest.fn(),
      close: jest.fn()
    };

    // Mock RPC service
    mockRpcService = {
      getEvents: jest.fn(),
      getLatestLedger: jest.fn()
    };

    // Create worker instance with mocked dependencies
    reconciliationWorker = new ReconciliationWorker(null, {
      logger: mockLogger,
      database: mockDatabase,
      rpcService: mockRpcService
    });
  });

  describe('Constructor', () => {
    it('should initialize with default configuration', () => {
      expect(reconciliationWorker.config).toBeDefined();
      expect(reconciliationWorker.isRunning).toBe(false);
      expect(reconciliationWorker.stats).toBeDefined();
    });

    it('should accept custom configuration', () => {
      const customConfig = {
        scheduleTime: '01:00',
        discrepancyThresholdPercentage: 0.05
      };
      
      const worker = new ReconciliationWorker(customConfig, {
        logger: mockLogger,
        database: mockDatabase
      });

      expect(worker.reconciliationConfig.scheduleTime).toBe('01:00');
    });
  });

  describe('getDailyAggregatedEvents', () => {
    it('should return aggregated events for a merchant', async () => {
      const mockDate = new Date('2024-04-28');
      const merchantId = 'merchant_123';
      
      const mockResult = {
        rows: [{
          total_events: '10',
          total_amount: '1000.50',
          min_ledger: '123456',
          max_ledger: '123789',
          processed_events: '9',
          failed_events: '1'
        }]
      };

      mockDatabase.query.mockResolvedValue(mockResult);

      const result = await reconciliationWorker.getDailyAggregatedEvents(merchantId, mockDate);

      expect(result).toEqual({
        merchantId,
        date: mockDate,
        totalEvents: 10,
        totalAmount: '1000.50',
        processedEvents: 9,
        failedEvents: 1,
        ledgerRange: {
          start: 123456,
          end: 123789
        }
      });

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('COUNT(*) as total_events'),
        [expect.any(Date), expect.any(Date), merchantId]
      );
    });

    it('should handle database errors gracefully', async () => {
      const mockDate = new Date('2024-04-28');
      const merchantId = 'merchant_123';
      
      mockDatabase.query.mockRejectedValue(new Error('Database connection failed'));

      await expect(reconciliationWorker.getDailyAggregatedEvents(merchantId, mockDate))
        .rejects.toThrow('Database connection failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get daily aggregated events',
        expect.objectContaining({
          merchantId,
          date: mockDate,
          error: 'Database connection failed'
        })
      );
    });
  });

  describe('getVaultBalance', () => {
    it('should return vault balance for a merchant', async () => {
      const merchantId = 'merchant_123';
      
      const mockBalances = [
        {
          assetCode: 'USDC',
          assetIssuer: 'issuer123',
          balance: '1500.00'
        },
        {
          assetCode: 'XLM',
          balance: '100.00'
        }
      ];

      merchantService.getMerchantBalances.mockResolvedValue(mockBalances);
      
      // Mock the helper methods
      jest.spyOn(reconciliationWorker, 'convertToUsd').mockResolvedValue('1500.00');
      jest.spyOn(reconciliationWorker, 'getAssetPrice').mockResolvedValue('1.00');

      const result = await reconciliationWorker.getVaultBalance(merchantId);

      expect(result).toEqual({
        merchantId,
        timestamp: expect.any(Date),
        balances: [
          {
            assetCode: 'USDC',
            assetIssuer: 'issuer123',
            balance: '1500.00',
            valueUsd: '1500.00',
            priceUsd: '1.00'
          },
          {
            assetCode: 'XLM',
            balance: '100.00',
            valueUsd: '1500.00',
            priceUsd: '1.00'
          }
        ],
        totalValueUsd: '3000.00',
        totalValueNative: '200.00',
        vaultAssetCode: 'USDC'
      });

      expect(merchantService.getMerchantBalances).toHaveBeenCalledWith(merchantId);
    });

    it('should handle empty balances', async () => {
      const merchantId = 'merchant_123';
      
      merchantService.getMerchantBalances.mockResolvedValue([]);

      const result = await reconciliationWorker.getVaultBalance(merchantId);

      expect(result.totalValueUsd).toBe('0');
      expect(result.totalValueNative).toBe('0');
      expect(result.balances).toHaveLength(0);
    });
  });

  describe('detectDiscrepancies', () => {
    it('should detect no discrepancies when amounts match', async () => {
      const dailyEvents = {
        totalAmount: '1000.00',
        totalEvents: 10,
        failedEvents: 0
      };

      const vaultBalance = {
        totalValueUsd: '1000.00'
      };

      const discrepancies = await reconciliationWorker.detectDiscrepancies(dailyEvents, vaultBalance);

      expect(discrepancies).toHaveLength(0);
    });

    it('should detect discrepancy when amounts differ beyond threshold', async () => {
      const dailyEvents = {
        totalAmount: '1000.00',
        totalEvents: 10,
        failedEvents: 0
      };

      const vaultBalance = {
        totalValueUsd: '1001.00' // 0.1% difference
      };

      const discrepancies = await reconciliationWorker.detectDiscrepancies(dailyEvents, vaultBalance);

      expect(discrepancies).toHaveLength(1);
      expect(discrepancies[0].type).toBe('extra_balance');
      expect(discrepancies[0].severity).toBe('medium');
      expect(discrepancies[0].differenceAmount).toBe('1.00');
    });

    it('should detect timing gaps when failed events exist', async () => {
      const dailyEvents = {
        totalAmount: '1000.00',
        totalEvents: 10,
        failedEvents: 2
      };

      const vaultBalance = {
        totalValueUsd: '1000.00'
      };

      const discrepancies = await reconciliationWorker.detectDiscrepancies(dailyEvents, vaultBalance);

      expect(discrepancies).toHaveLength(1);
      expect(discrepancies[0].type).toBe('timing_gap');
      expect(discrepancies[0].severity).toBe('medium');
    });
  });

  describe('createReconciliationReport', () => {
    it('should create a reconciliation report in database', async () => {
      const merchantId = 'merchant_123';
      const reportDate = new Date('2024-04-28');
      const dailyEvents = { totalAmount: '1000.00', totalEvents: 10 };
      const vaultBalance = { totalValueUsd: '1000.00', vaultAssetCode: 'USDC' };
      const discrepancies = [];

      const mockInsertResult = { rows: [{ id: 'report_123' }] };
      mockDatabase.query.mockResolvedValue(mockInsertResult);

      const result = await reconciliationWorker.createReconciliationReport(
        merchantId, reportDate, dailyEvents, vaultBalance, discrepancies
      );

      expect(result.id).toBe('report_123');
      expect(result.merchantId).toBe(merchantId);
      expect(result.status).toBe('matched');

      expect(mockDatabase.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO reconciliation_reports'),
        expect.arrayContaining([
          merchantId,
          reportDate,
          10,
          '1000.00',
          '1000.00',
          expect.any(String),
          'USDC',
          'matched',
          '0',
          0,
          0,
          'none',
          expect.any(Number),
          expect.any(Number)
        ])
      );
    });

    it('should handle discrepancy status when discrepancies exist', async () => {
      const merchantId = 'merchant_123';
      const reportDate = new Date('2024-04-28');
      const dailyEvents = { totalAmount: '1000.00', totalEvents: 10 };
      const vaultBalance = { totalValueUsd: '1001.00', vaultAssetCode: 'USDC' };
      const discrepancies = [{
        type: 'extra_balance',
        differenceAmount: '1.00',
        differencePercentage: 0.1
      }];

      const mockInsertResult = { rows: [{ id: 'report_123' }] };
      mockDatabase.query.mockResolvedValue(mockInsertResult);

      const result = await reconciliationWorker.createReconciliationReport(
        merchantId, reportDate, dailyEvents, vaultBalance, discrepancies
      );

      expect(result.status).toBe('discrepancy_found');
    });
  });

  describe('attemptAutoHealing', () => {
    it('should attempt healing for missing events', async () => {
      const reportId = 'report_123';
      const discrepancies = [
        { type: 'missing_event', context: { ledgerRange: { start: 123456, end: 123789 } } }
      ];

      // Mock healing attempt creation
      jest.spyOn(reconciliationWorker, 'createHealingAttempt').mockResolvedValue({ id: 'heal_123' });
      jest.spyOn(reconciliationWorker, 'healMissingEvents').mockResolvedValue();
      jest.spyOn(reconciliationWorker, 'updateReportStatus').mockResolvedValue();

      await reconciliationWorker.attemptAutoHealing(reportId, discrepancies);

      expect(reconciliationWorker.createHealingAttempt).toHaveBeenCalledWith(
        reportId,
        're_poll_rpc',
        discrepancies[0]
      );
      expect(reconciliationWorker.healMissingEvents).toHaveBeenCalledWith('heal_123', discrepancies[0]);
      expect(reconciliationWorker.updateReportStatus).toHaveBeenCalledWith(reportId, 'healing');
    });

    it('should skip healing when disabled', async () => {
      reconciliationWorker.reconciliationConfig.autoHealing.enabled = false;
      
      const reportId = 'report_123';
      const discrepancies = [{ type: 'missing_event' }];

      jest.spyOn(reconciliationWorker, 'createHealingAttempt').mockResolvedValue({ id: 'heal_123' });

      await reconciliationWorker.attemptAutoHealing(reportId, discrepancies);

      expect(reconciliationWorker.createHealingAttempt).not.toHaveBeenCalled();
    });
  });

  describe('healMissingEvents', () => {
    it('should successfully heal missing events', async () => {
      const reportId = 'report_123';
      const discrepancy = {
        context: { ledgerRange: { start: 123456, end: 123789 } }
      };

      const mockEvents = [
        { transactionHash: 'tx123', eventIndex: 0 },
        { transactionHash: 'tx124', eventIndex: 1 }
      ];

      // Mock healing attempt creation
      jest.spyOn(reconciliationWorker, 'createHealingAttempt').mockResolvedValue({ id: 'heal_123' });
      jest.spyOn(reconciliationWorker, 'updateHealingAttempt').mockResolvedValue();
      jest.spyOn(reconciliationWorker, 'processMissingEvent').mockResolvedValue();

      mockRpcService.getEvents.mockResolvedValue(mockEvents);

      await reconciliationWorker.healMissingEvents(reportId, discrepancy);

      expect(mockRpcService.getEvents).toHaveBeenCalledWith(
        123456,
        123789,
        ['SubscriptionBilled']
      );
      expect(reconciliationWorker.processMissingEvent).toHaveBeenCalledTimes(2);
      expect(reconciliationWorker.updateHealingAttempt).toHaveBeenCalledWith(
        'heal_123',
        'completed',
        expect.objectContaining({
          eventsFound: 2,
          eventsSynced: 2
        })
      );
    });

    it('should handle healing failures', async () => {
      const reportId = 'report_123';
      const discrepancy = {
        context: { ledgerRange: { start: 123456, end: 123789 } }
      };

      jest.spyOn(reconciliationWorker, 'createHealingAttempt').mockResolvedValue({ id: 'heal_123' });
      jest.spyOn(reconciliationWorker, 'updateHealingAttempt').mockResolvedValue();

      mockRpcService.getEvents.mockRejectedValue(new Error('RPC timeout'));

      await expect(reconciliationWorker.healMissingEvents(reportId, discrepancy))
        .rejects.toThrow('RPC timeout');

      expect(reconciliationWorker.updateHealingAttempt).toHaveBeenCalledWith(
        'heal_123',
        'failed',
        expect.objectContaining({
          errorMessage: 'RPC timeout'
        })
      );
    });
  });

  describe('generateReportFiles', () => {
    it('should generate JSON and CSV reports', async () => {
      const report = {
        id: 'report_123',
        merchantId: 'merchant_123',
        reportDate: new Date('2024-04-28'),
        status: 'matched',
        processingTimeMs: 5000
      };

      const dailyEvents = { totalEvents: 10, totalAmount: '1000.00' };
      const vaultBalance = { totalValueUsd: '1000.00' };
      const discrepancies = [];

      // Mock file system operations
      jest.spyOn(require('fs').promises, 'mkdir').mockResolvedValue();
      jest.spyOn(require('fs').promises, 'writeFile').mockResolvedValue();
      jest.spyOn(reconciliationWorker, 'generateCsvReport').mockResolvedValue();

      await reconciliationWorker.generateReportFiles(report, dailyEvents, vaultBalance, discrepancies);

      expect(require('fs').promises.mkdir).toHaveBeenCalledWith(
        expect.stringContaining('reports/reconciliation'),
        { recursive: true }
      );
      expect(require('fs').promises.writeFile).toHaveBeenCalled();
      expect(reconciliationWorker.generateCsvReport).toHaveBeenCalled();
    });
  });

  describe('Utility Methods', () => {
    it('should calculate discrepancy severity correctly', () => {
      expect(reconciliationWorker.getDiscrepancySeverity(0.5)).toBe('high');
      expect(reconciliationWorker.getDiscrepancySeverity(0.1)).toBe('medium');
      expect(reconciliationWorker.getDiscrepancySeverity(0.01)).toBe('low');
      expect(reconciliationWorker.getDiscrepancySeverity(2.0)).toBe('critical');
    });

    it('should provide appropriate suggested actions', () => {
      const critical = reconciliationWorker.getSuggestedAction('critical', 2.0);
      expect(critical).toContain('IMMEDIATE ATTENTION REQUIRED');

      const high = reconciliationWorker.getSuggestedAction('high', 0.5);
      expect(high).toContain('Auto-healing attempted');

      const low = reconciliationWorker.getSuggestedAction('low', 0.01);
      expect(low).toContain('Monitor for patterns');
    });

    it('should perform decimal arithmetic correctly', () => {
      expect(reconciliationWorker.addDecimal('100.50', '200.75')).toBe('301.25');
      expect(reconciliationWorker.subtractDecimal('200.75', '100.50')).toBe('100.25');
    });
  });

  describe('Stats and Monitoring', () => {
    it('should track statistics correctly', () => {
      const initialStats = reconciliationWorker.getStats();
      
      expect(initialStats).toHaveProperty('totalReports');
      expect(initialStats).toHaveProperty('successfulReports');
      expect(initialStats).toHaveProperty('failedReports');
      expect(initialStats).toHaveProperty('discrepanciesFound');
      expect(initialStats).toHaveProperty('healingAttempts');
      expect(initialStats).toHaveProperty('healingSuccesses');
    });

    it('should update stats during operations', async () => {
      const merchantId = 'merchant_123';
      const reportDate = new Date('2024-04-28');
      
      // Mock successful reconciliation
      jest.spyOn(reconciliationWorker, 'getDailyAggregatedEvents').mockResolvedValue({
        totalEvents: 10,
        totalAmount: '1000.00'
      });
      jest.spyOn(reconciliationWorker, 'getVaultBalance').mockResolvedValue({
        totalValueUsd: '1000.00'
      });
      jest.spyOn(reconciliationWorker, 'detectDiscrepancies').mockResolvedValue([]);
      jest.spyOn(reconciliationWorker, 'createReconciliationReport').mockResolvedValue({
        id: 'report_123',
        status: 'matched'
      });
      jest.spyOn(reconciliationWorker, 'generateReportFiles').mockResolvedValue();
      jest.spyOn(reconciliationWorker, 'updateReportStatus').mockResolvedValue();

      await reconciliationWorker.reconcileMerchant(merchantId);

      const stats = reconciliationWorker.getStats();
      expect(stats.totalReports).toBe(1);
      expect(stats.successfulReports).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle merchant reconciliation failures gracefully', async () => {
      const merchantId = 'merchant_123';
      
      jest.spyOn(reconciliationWorker, 'getDailyAggregatedEvents')
        .mockRejectedValue(new Error('Database error'));

      await expect(reconciliationWorker.reconcileMerchant(merchantId))
        .rejects.toThrow('Database error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Reconciliation failed for merchant ${merchantId}`,
        expect.objectContaining({
          error: 'Database error'
        })
      );
    });

    it('should continue processing other merchants if one fails', async () => {
      // Mock getAllMerchants to return two merchants
      jest.spyOn(reconciliationWorker, 'getAllMerchants').mockResolvedValue([
        { id: 'merchant_123' },
        { id: 'merchant_456' }
      ]);

      // Mock first merchant to fail, second to succeed
      jest.spyOn(reconciliationWorker, 'reconcileMerchant')
        .mockRejectedValueOnce(new Error('First merchant failed'))
        .mockResolvedValueOnce({ id: 'report_456' });

      await reconciliationWorker.runDailyReconciliation();

      expect(reconciliationWorker.stats.failedReports).toBe(1);
      expect(reconciliationWorker.stats.successfulReports).toBe(1);
    });
  });
});
