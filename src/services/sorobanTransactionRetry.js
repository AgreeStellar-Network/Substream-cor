'use strict';

/**
 * Retryable error codes/messages for Soroban transaction submissions.
 * Network-level and transient RPC errors are retryable; contract logic errors are not.
 */
const RETRYABLE_PATTERNS = [
  /timeout/i,
  /network/i,
  /connection/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /rate.?limit/i,
  /too many requests/i,
  /503/,
  /502/,
  /504/,
  /try_again_later/i,
  /txBAD_SEQ/i,          // sequence number mismatch — rebuild and retry
  /txINSUFFICIENT_FEE/i, // fee too low — bump and retry
];

const NON_RETRYABLE_PATTERNS = [
  /txNO_ACCOUNT/i,
  /txBAD_AUTH/i,
  /txINSUFFICIENT_BALANCE/i,
  /contract.*error/i,
  /simulation.*failed/i,
  /Circuit breaker is OPEN/i,
];

/**
 * Determine whether an error is worth retrying.
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryable(error) {
  const msg = error.message || '';
  if (NON_RETRYABLE_PATTERNS.some(p => p.test(msg))) return false;
  if (RETRYABLE_PATTERNS.some(p => p.test(msg))) return true;
  // Default: retry on unknown errors (network glitches, etc.)
  return true;
}

/**
 * Soroban Transaction Retry Service
 *
 * Provides automated retry logic with full exponential backoff + jitter for
 * smart contract transaction submissions (sendTransaction).  Separates
 * transaction-submission retries from generic RPC-call retries so callers
 * can tune them independently.
 *
 * Key design decisions:
 *  - Full jitter (random in [0, cap]) prevents thundering-herd on shared RPC nodes.
 *  - Non-retryable errors (bad auth, insufficient balance, contract logic) surface
 *    immediately without wasting retry budget.
 *  - pollTransaction uses its own backoff so the combined wait stays bounded.
 */
class SorobanTransactionRetry {
  /**
   * @param {object} [options]
   * @param {number} [options.maxRetries=5]          Max submission attempts.
   * @param {number} [options.baseDelay=1000]         Initial backoff in ms.
   * @param {number} [options.maxDelay=30000]         Backoff cap in ms.
   * @param {number} [options.pollMaxAttempts=20]     Max poll iterations.
   * @param {number} [options.pollBaseDelay=1000]     Initial poll delay in ms.
   * @param {number} [options.pollMaxDelay=10000]     Poll delay cap in ms.
   * @param {object} [options.logger=console]
   */
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelay = options.baseDelay ?? 1000;
    this.maxDelay = options.maxDelay ?? 30000;
    this.pollMaxAttempts = options.pollMaxAttempts ?? 20;
    this.pollBaseDelay = options.pollBaseDelay ?? 1000;
    this.pollMaxDelay = options.pollMaxDelay ?? 10000;
    this.logger = options.logger ?? console;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Submit a signed transaction with exponential backoff retry.
   *
   * @param {Function} submitFn  Async function that calls server.sendTransaction(tx)
   *                             and returns the RPC response.
   * @param {object}   [context] Metadata attached to log messages.
   * @returns {Promise<object>}  The successful sendTransaction response.
   */
  async submitWithRetry(submitFn, context = {}) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await submitFn();

        if (attempt > 0) {
          this.logger.info('Transaction submitted successfully after retries', {
            ...context,
            attempt,
          });
        }

        return response;
      } catch (error) {
        lastError = error;

        if (!isRetryable(error)) {
          this.logger.error('Non-retryable transaction error — aborting', {
            ...context,
            error: error.message,
          });
          throw error;
        }

        if (attempt === this.maxRetries) {
          this.logger.error('Transaction submission failed after max retries', {
            ...context,
            maxRetries: this.maxRetries,
            error: error.message,
          });
          throw error;
        }

        const delay = this._jitteredDelay(attempt);
        this.logger.warn('Transaction submission failed, retrying', {
          ...context,
          attempt: attempt + 1,
          maxRetries: this.maxRetries,
          retryInMs: delay,
          error: error.message,
        });

        await this._sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Poll for transaction confirmation with exponential backoff.
   *
   * @param {Function} pollFn   Async function that calls server.getTransaction(hash)
   *                            and returns the RPC response.
   * @param {object}   [context]
   * @returns {Promise<object>} The confirmed transaction response.
   */
  async pollForConfirmation(pollFn, context = {}) {
    for (let attempt = 0; attempt < this.pollMaxAttempts; attempt++) {
      const response = await pollFn();

      if (response.status === 'SUCCESS') {
        return response;
      }

      if (response.status === 'FAILED') {
        const error = new Error(
          `Transaction failed on-chain: ${response.resultXdr || response.status}`
        );
        error.txResponse = response;
        throw error;
      }

      // status === 'NOT_FOUND' or 'PENDING' — keep polling
      if (attempt < this.pollMaxAttempts - 1) {
        const delay = this._jitteredDelay(attempt, this.pollBaseDelay, this.pollMaxDelay);
        this.logger.info('Transaction pending, polling again', {
          ...context,
          attempt: attempt + 1,
          pollMaxAttempts: this.pollMaxAttempts,
          retryInMs: delay,
          status: response.status,
        });
        await this._sleep(delay);
      }
    }

    throw new Error(
      `Transaction not confirmed after ${this.pollMaxAttempts} poll attempts`
    );
  }

  /**
   * Convenience: submit a transaction and wait for on-chain confirmation.
   *
   * @param {Function} submitFn  See submitWithRetry.
   * @param {Function} pollFn    See pollForConfirmation.
   * @param {object}   [context]
   * @returns {Promise<object>}  The confirmed transaction response.
   */
  async submitAndConfirm(submitFn, pollFn, context = {}) {
    const submitResponse = await this.submitWithRetry(submitFn, context);
    return this.pollForConfirmation(pollFn, { ...context, txHash: submitResponse.hash });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Full-jitter exponential backoff: random value in [0, min(cap, base * 2^attempt)].
   * Avoids thundering herd while still bounding maximum wait.
   */
  _jitteredDelay(
    attempt,
    base = this.baseDelay,
    cap = this.maxDelay
  ) {
    const ceiling = Math.min(cap, base * Math.pow(2, attempt));
    return Math.floor(Math.random() * ceiling);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { SorobanTransactionRetry, isRetryable };
