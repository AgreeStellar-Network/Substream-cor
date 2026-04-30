const { SeasonalPauseService } = require('./seasonalPauseService');

const DEFAULT_PLAN_CHUNK = 100;

/**
 * bulk_pause_execution
 *
 * The asynchronous job a merchant submits when they need to halt billing for
 * an off-season. It chunks the plan list, calls SeasonalPauseService.bulkPause
 * for each chunk inside its own transaction, and reports per-chunk progress.
 *
 * The job is intentionally split from the service so that:
 *   - REST/webhook callers can run it inline (synchronously) for small
 *     merchants, or
 *   - A queue worker (Bull/RabbitMQ) can dequeue jobs and call .execute(...)
 *     for enterprise-scale merchants pausing tens of thousands of plans.
 */
class BulkPauseExecutionJob {
  /**
   * @param {{
   *   seasonalPauseService: SeasonalPauseService,
   *   logger?: any,
   *   planChunkSize?: number,
   * }} options
   */
  constructor({ seasonalPauseService, logger, planChunkSize } = {}) {
    if (!seasonalPauseService) throw new Error('seasonalPauseService is required');
    this.seasonalPauseService = seasonalPauseService;
    this.logger = logger || console;
    this.planChunkSize = planChunkSize || DEFAULT_PLAN_CHUNK;
  }

  /**
   * Execute a bulk pause job.
   *
   * @param {{
   *   merchantId: string,
   *   planIds: string[],
   *   reason?: string,
   *   expectedResumeAt?: string|Date|null,
   *   pausedBy?: string,
   *   onChunkComplete?: (progress: { processed: number, total: number, pauses: any[] }) => void,
   * }} job
   */
  async execute(job) {
    if (!job) throw new Error('job payload is required');

    const planIds = Array.isArray(job.planIds) ? job.planIds.slice() : [];
    if (planIds.length === 0) throw new Error('planIds must be a non-empty array');

    const startedAt = new Date().toISOString();
    const allPauses = [];
    let processed = 0;
    let totalSubscriptionsAffected = 0;
    const failures = [];

    for (let i = 0; i < planIds.length; i += this.planChunkSize) {
      const chunk = planIds.slice(i, i + this.planChunkSize);

      try {
        const { pauses, totalSubscriptionsAffected: chunkAffected } =
          await this.seasonalPauseService.bulkPause({
            merchantId: job.merchantId,
            planIds: chunk,
            reason: job.reason,
            expectedResumeAt: job.expectedResumeAt,
            pausedBy: job.pausedBy,
          });

        allPauses.push(...pauses);
        processed += chunk.length;
        totalSubscriptionsAffected += chunkAffected;

        if (typeof job.onChunkComplete === 'function') {
          try {
            job.onChunkComplete({
              processed,
              total: planIds.length,
              pauses,
              chunkAffected,
            });
          } catch (cbError) {
            this.logger.warn &&
              this.logger.warn(
                'BulkPauseExecutionJob.onChunkComplete callback threw:',
                cbError.message
              );
          }
        }
      } catch (error) {
        // Record per-chunk failure but keep going so a single bad plan id
        // can't block the rest of an off-season halt for 99k other users.
        failures.push({
          planIds: chunk,
          error: error.message,
        });
        this.logger.error &&
          this.logger.error('BulkPauseExecutionJob chunk failed', {
            merchantId: job.merchantId,
            chunkSize: chunk.length,
            error: error.message,
          });
      }
    }

    const completedAt = new Date().toISOString();

    return {
      merchantId: job.merchantId,
      startedAt,
      completedAt,
      requestedPlanCount: planIds.length,
      processedPlanCount: processed,
      successfulPlanCount: allPauses.length,
      failedPlanCount: failures.reduce((s, f) => s + f.planIds.length, 0),
      totalSubscriptionsAffected,
      pauses: allPauses,
      failures,
    };
  }
}

module.exports = { BulkPauseExecutionJob };
