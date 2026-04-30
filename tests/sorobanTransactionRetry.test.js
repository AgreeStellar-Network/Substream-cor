'use strict';

const { SorobanTransactionRetry, isRetryable } = require('../src/services/sorobanTransactionRetry');

// Silence logger output during tests
const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Speed up tests by replacing sleep with an immediate resolve
jest.spyOn(SorobanTransactionRetry.prototype, '_sleep').mockResolvedValue(undefined);

describe('isRetryable', () => {
  test.each([
    ['timeout error', new Error('Request timeout'), true],
    ['network error', new Error('network failure'), true],
    ['ECONNRESET', new Error('ECONNRESET'), true],
    ['ECONNREFUSED', new Error('ECONNREFUSED'), true],
    ['ETIMEDOUT', new Error('ETIMEDOUT'), true],
    ['rate limit', new Error('rate limit exceeded'), true],
    ['503', new Error('503 Service Unavailable'), true],
    ['502', new Error('502 Bad Gateway'), true],
    ['504', new Error('504 Gateway Timeout'), true],
    ['txBAD_SEQ', new Error('txBAD_SEQ'), true],
    ['txINSUFFICIENT_FEE', new Error('txINSUFFICIENT_FEE'), true],
    ['unknown error', new Error('something unexpected'), true],
    ['txNO_ACCOUNT', new Error('txNO_ACCOUNT'), false],
    ['txBAD_AUTH', new Error('txBAD_AUTH'), false],
    ['txINSUFFICIENT_BALANCE', new Error('txINSUFFICIENT_BALANCE'), false],
    ['contract error', new Error('contract execution error'), false],
    ['simulation failed', new Error('simulation failed: bad args'), false],
    ['circuit breaker open', new Error('Circuit breaker is OPEN'), false],
  ])('%s → retryable=%s', (_label, error, expected) => {
    expect(isRetryable(error)).toBe(expected);
  });
});

describe('SorobanTransactionRetry', () => {
  let retry;

  beforeEach(() => {
    jest.clearAllMocks();
    retry = new SorobanTransactionRetry({
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 1000,
      pollMaxAttempts: 5,
      pollBaseDelay: 100,
      pollMaxDelay: 1000,
      logger: silentLogger,
    });
  });

  // -------------------------------------------------------------------------
  describe('submitWithRetry', () => {
    test('succeeds on first attempt without retrying', async () => {
      const submitFn = jest.fn().mockResolvedValue({ hash: 'abc', status: 'PENDING' });

      const result = await retry.submitWithRetry(submitFn);

      expect(result).toEqual({ hash: 'abc', status: 'PENDING' });
      expect(submitFn).toHaveBeenCalledTimes(1);
    });

    test('retries on retryable error and succeeds', async () => {
      const submitFn = jest.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('network failure'))
        .mockResolvedValue({ hash: 'abc', status: 'PENDING' });

      const result = await retry.submitWithRetry(submitFn);

      expect(result).toEqual({ hash: 'abc', status: 'PENDING' });
      expect(submitFn).toHaveBeenCalledTimes(3);
    });

    test('throws immediately on non-retryable error', async () => {
      const submitFn = jest.fn().mockRejectedValue(new Error('txBAD_AUTH'));

      await expect(retry.submitWithRetry(submitFn)).rejects.toThrow('txBAD_AUTH');
      expect(submitFn).toHaveBeenCalledTimes(1);
    });

    test('throws after exhausting max retries', async () => {
      const submitFn = jest.fn().mockRejectedValue(new Error('timeout'));

      await expect(retry.submitWithRetry(submitFn)).rejects.toThrow('timeout');
      // 1 initial + maxRetries attempts
      expect(submitFn).toHaveBeenCalledTimes(retry.maxRetries + 1);
    });

    test('logs warning on each retry attempt', async () => {
      const submitFn = jest.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({ hash: 'x' });

      await retry.submitWithRetry(submitFn, { txId: 'test-1' });

      expect(silentLogger.warn).toHaveBeenCalledWith(
        'Transaction submission failed, retrying',
        expect.objectContaining({ txId: 'test-1', attempt: 1 })
      );
    });

    test('logs error on non-retryable failure', async () => {
      const submitFn = jest.fn().mockRejectedValue(new Error('txNO_ACCOUNT'));

      await expect(retry.submitWithRetry(submitFn, { txId: 'test-2' })).rejects.toThrow();

      expect(silentLogger.error).toHaveBeenCalledWith(
        'Non-retryable transaction error — aborting',
        expect.objectContaining({ txId: 'test-2' })
      );
    });

    test('logs success info when retries were needed', async () => {
      const submitFn = jest.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue({ hash: 'y' });

      await retry.submitWithRetry(submitFn, { txId: 'test-3' });

      expect(silentLogger.info).toHaveBeenCalledWith(
        'Transaction submitted successfully after retries',
        expect.objectContaining({ txId: 'test-3', attempt: 1 })
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('pollForConfirmation', () => {
    test('returns immediately on SUCCESS', async () => {
      const pollFn = jest.fn().mockResolvedValue({ status: 'SUCCESS', resultXdr: 'xdr' });

      const result = await retry.pollForConfirmation(pollFn);

      expect(result.status).toBe('SUCCESS');
      expect(pollFn).toHaveBeenCalledTimes(1);
    });

    test('throws on FAILED status', async () => {
      const pollFn = jest.fn().mockResolvedValue({ status: 'FAILED', resultXdr: 'err' });

      await expect(retry.pollForConfirmation(pollFn)).rejects.toThrow(
        'Transaction failed on-chain'
      );
    });

    test('polls through PENDING until SUCCESS', async () => {
      const pollFn = jest.fn()
        .mockResolvedValueOnce({ status: 'PENDING' })
        .mockResolvedValueOnce({ status: 'NOT_FOUND' })
        .mockResolvedValue({ status: 'SUCCESS' });

      const result = await retry.pollForConfirmation(pollFn);

      expect(result.status).toBe('SUCCESS');
      expect(pollFn).toHaveBeenCalledTimes(3);
    });

    test('throws after exhausting poll attempts', async () => {
      const pollFn = jest.fn().mockResolvedValue({ status: 'PENDING' });

      await expect(retry.pollForConfirmation(pollFn)).rejects.toThrow(
        `Transaction not confirmed after ${retry.pollMaxAttempts} poll attempts`
      );
      expect(pollFn).toHaveBeenCalledTimes(retry.pollMaxAttempts);
    });

    test('attaches txResponse to FAILED error', async () => {
      const txResponse = { status: 'FAILED', resultXdr: 'bad' };
      const pollFn = jest.fn().mockResolvedValue(txResponse);

      const error = await retry.pollForConfirmation(pollFn).catch(e => e);

      expect(error.txResponse).toBe(txResponse);
    });
  });

  // -------------------------------------------------------------------------
  describe('submitAndConfirm', () => {
    test('submits then polls and returns confirmed response', async () => {
      const submitFn = jest.fn().mockResolvedValue({ hash: 'abc123', status: 'PENDING' });
      const pollFn = jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'abc123' });

      const result = await retry.submitAndConfirm(submitFn, pollFn, { op: 'test' });

      expect(result.status).toBe('SUCCESS');
      expect(submitFn).toHaveBeenCalledTimes(1);
      expect(pollFn).toHaveBeenCalledTimes(1);
    });

    test('propagates submission error', async () => {
      const submitFn = jest.fn().mockRejectedValue(new Error('txBAD_AUTH'));
      const pollFn = jest.fn();

      await expect(retry.submitAndConfirm(submitFn, pollFn)).rejects.toThrow('txBAD_AUTH');
      expect(pollFn).not.toHaveBeenCalled();
    });

    test('propagates poll failure', async () => {
      const submitFn = jest.fn().mockResolvedValue({ hash: 'abc', status: 'PENDING' });
      const pollFn = jest.fn().mockResolvedValue({ status: 'FAILED', resultXdr: 'err' });

      await expect(retry.submitAndConfirm(submitFn, pollFn)).rejects.toThrow(
        'Transaction failed on-chain'
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('_jitteredDelay', () => {
    test('returns value within [0, cap]', () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = retry._jitteredDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(retry.maxDelay);
      }
    });

    test('never exceeds maxDelay regardless of attempt count', () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        expect(retry._jitteredDelay(attempt)).toBeLessThanOrEqual(retry.maxDelay);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('constructor defaults', () => {
    test('uses sensible defaults when no options provided', () => {
      const defaultRetry = new SorobanTransactionRetry();
      expect(defaultRetry.maxRetries).toBe(5);
      expect(defaultRetry.baseDelay).toBe(1000);
      expect(defaultRetry.maxDelay).toBe(30000);
      expect(defaultRetry.pollMaxAttempts).toBe(20);
      expect(defaultRetry.pollBaseDelay).toBe(1000);
      expect(defaultRetry.pollMaxDelay).toBe(10000);
    });
  });
});
