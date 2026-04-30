const { SorobanEventArchiveService } = require('../services/sorobanEventArchiveService');

// Mock database with prepare/all/get/run/transaction pattern
describe('SorobanEventArchiveService', () => {
  let service;
  let mockDb;
  let mockPrepare;
  let mockRun;
  let mockAll;
  let mockGet;
  let capturedTransactions;

  beforeEach(() => {
    mockRun = jest.fn();
    mockAll = jest.fn();
    mockGet = jest.fn();
    mockPrepare = jest.fn().mockReturnValue({
      run: mockRun,
      all: mockAll,
      get: mockGet,
    });

    capturedTransactions = [];
    mockDb = {
      prepare: mockPrepare,
      transaction: (fn) => {
        const tx = () => {
          capturedTransactions.push(fn);
          return fn();
        };
        tx.default = fn;
        return tx;
      },
    };

    const mockDatabase = { db: mockDb };

    service = new SorobanEventArchiveService({
      retentionDays: 30,
      batchSize: 2,
      logger: { info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
    });
    service.setDatabase(mockDatabase);
  });

  describe('runArchival', () => {
    it('should archive events older than retention period', async () => {
      const oldDate = new Date('2024-01-01T00:00:00Z');
      const events = [
        {
          id: 'evt-1',
          contract_id: 'contract-1',
          transaction_hash: 'tx-1',
          event_index: 0,
          ledger_sequence: 100,
          event_type: 'Subscription',
          event_data: '{}',
          raw_xdr: null,
          ledger_timestamp: oldDate.toISOString(),
          ingested_at: oldDate.toISOString(),
          processed_at: null,
          status: 'pending',
          error_message: null,
          retry_count: 0,
        },
        {
          id: 'evt-2',
          contract_id: 'contract-1',
          transaction_hash: 'tx-2',
          event_index: 0,
          ledger_sequence: 101,
          event_type: 'Payment',
          event_data: '{}',
          raw_xdr: null,
          ledger_timestamp: oldDate.toISOString(),
          ingested_at: oldDate.toISOString(),
          processed_at: null,
          status: 'pending',
          error_message: null,
          retry_count: 0,
        },
      ];

      mockAll.mockReturnValue(events);

      const result = await service.runArchival();

      expect(result.archived).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(mockAll).toHaveBeenCalledTimes(1);

      // Verify insert into archive and delete from events happened for each event
      expect(mockRun).toHaveBeenCalledTimes(4); // 2 inserts + 2 deletes
    });

    it('should stop when no events are found', async () => {
      mockAll.mockReturnValue([]);

      const result = await service.runArchival();

      expect(result.archived).toBe(0);
      expect(mockAll).toHaveBeenCalledTimes(1);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('should handle batch failures gracefully', async () => {
      const oldDate = new Date('2024-01-01T00:00:00Z');
      const events = [
        {
          id: 'evt-1',
          contract_id: 'contract-1',
          transaction_hash: 'tx-1',
          event_index: 0,
          ledger_sequence: 100,
          event_type: 'Subscription',
          event_data: '{}',
          raw_xdr: null,
          ledger_timestamp: oldDate.toISOString(),
          ingested_at: oldDate.toISOString(),
          processed_at: null,
          status: 'pending',
          error_message: null,
          retry_count: 0,
        },
      ];

      mockAll.mockReturnValue(events);
      mockRun.mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await service.runArchival();

      expect(result.archived).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should process multiple batches if events exceed batch size', async () => {
      const oldDate = new Date('2024-01-01T00:00:00Z');
      const events = [
        {
          id: 'evt-1',
          contract_id: 'contract-1',
          transaction_hash: 'tx-1',
          event_index: 0,
          ledger_sequence: 100,
          event_type: 'Subscription',
          event_data: '{}',
          raw_xdr: null,
          ledger_timestamp: oldDate.toISOString(),
          ingested_at: oldDate.toISOString(),
          processed_at: null,
          status: 'pending',
          error_message: null,
          retry_count: 0,
        },
        {
          id: 'evt-2',
          contract_id: 'contract-1',
          transaction_hash: 'tx-2',
          event_index: 0,
          ledger_sequence: 101,
          event_type: 'Payment',
          event_data: '{}',
          raw_xdr: null,
          ledger_timestamp: oldDate.toISOString(),
          ingested_at: oldDate.toISOString(),
          processed_at: null,
          status: 'pending',
          error_message: null,
          retry_count: 0,
        },
      ];

      // First call returns 2 events, second call returns empty
      mockAll
        .mockReturnValueOnce(events)
        .mockReturnValueOnce([]);

      const result = await service.runArchival();

      expect(result.archived).toBe(2);
      expect(mockAll).toHaveBeenCalledTimes(2);
    });
  });

  describe('getArchiveStats', () => {
    it('should return archive statistics', async () => {
      mockGet
        .mockReturnValueOnce({ count: 100 })
        .mockReturnValueOnce({ count: 50 })
        .mockReturnValueOnce({ ts: '2024-01-01T00:00:00Z' })
        .mockReturnValueOnce({ ts: '2024-06-01T00:00:00Z' });

      const stats = await service.getArchiveStats();

      expect(stats.totalEvents).toBe(100);
      expect(stats.totalArchived).toBe(50);
      expect(stats.oldestEvent).toBe('2024-01-01T00:00:00Z');
      expect(stats.newestArchive).toBe('2024-06-01T00:00:00Z');
    });
  });

  describe('cleanupOldArchives', () => {
    it('should delete archives older than extended retention', async () => {
      mockRun.mockReturnValue({ changes: 25 });

      const result = await service.cleanupOldArchives(365);

      expect(result.deleted).toBe(25);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('should throw if database is not initialized', async () => {
      const uninitializedService = new SorobanEventArchiveService();
      await expect(uninitializedService.runArchival()).rejects.toThrow('Database not initialized');
    });
  });
});
