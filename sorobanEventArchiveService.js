const { AppDatabase } = require('../src/db/appDatabase');

/**
 * Soroban Event Archive Service
 * Handles automated archiving of historical subscription events to maintain
 * database query performance. Events older than the retention period are moved
 * from soroban_events to soroban_events_archive.
 */
class SorobanEventArchiveService {
  constructor(config = {}) {
    this.retentionDays = config.retentionDays || 90;
    this.batchSize = config.batchSize || 1000;
    this.logger = config.logger || console;
    this.database = config.database || null;
  }

  /**
   * Initialize the service with a database instance
   * @param {AppDatabase} database 
   */
  setDatabase(database) {
    this.database = database;
  }

  /**
   * Run the archival process.
   * Moves events older than retentionDays from soroban_events to soroban_events_archive.
   * @returns {{archived: number, errors: string[]}}
   */
  async runArchival() {
    if (!this.database || !this.database.db) {
      throw new Error('Database not initialized');
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);
    const cutoffIso = cutoffDate.toISOString();

    this.logger.info('Starting Soroban event archival', {
      retentionDays: this.retentionDays,
      cutoffDate: cutoffIso,
      batchSize: this.batchSize,
    });

    const errors = [];
    let totalArchived = 0;
    let batchCount = 0;

    try {
      while (true) {
        batchCount++;

        // Find events to archive
        const eventsToArchive = this.database.db
          .prepare(
            `SELECT * FROM soroban_events 
             WHERE ledger_timestamp < ? 
             ORDER BY ledger_timestamp ASC 
             LIMIT ?`
          )
          .all(cutoffIso, this.batchSize);

        if (!eventsToArchive || eventsToArchive.length === 0) {
          break;
        }

        this.logger.debug(`Archiving batch ${batchCount}`, {
          batchSize: eventsToArchive.length,
        });

        // Use a transaction for each batch
        const archiveBatch = this.database.transaction(() => {
          for (const event of eventsToArchive) {
            // Insert into archive
            this.database.db
              .prepare(
                `INSERT INTO soroban_events_archive (
                  id, contract_id, transaction_hash, event_index, ledger_sequence,
                  event_type, event_data, raw_xdr, ledger_timestamp, ingested_at,
                  processed_at, status, error_message, retry_count, archived_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                event.id,
                event.contract_id,
                event.transaction_hash,
                event.event_index,
                event.ledger_sequence,
                event.event_type,
                event.event_data,
                event.raw_xdr,
                event.ledger_timestamp,
                event.ingested_at,
                event.processed_at,
                event.status,
                event.error_message,
                event.retry_count,
                new Date().toISOString()
              );

            // Delete from main events table
            this.database.db
              .prepare('DELETE FROM soroban_events WHERE id = ?')
              .run(event.id);
          }
          return eventsToArchive.length;
        });

        try {
          const archivedInBatch = archiveBatch();
          totalArchived += archivedInBatch;
        } catch (error) {
          this.logger.error('Batch archival failed', {
            batch: batchCount,
            error: error.message,
          });
          errors.push(`Batch ${batchCount}: ${error.message}`);
          // Stop processing to avoid partial data issues
          break;
        }
      }

      this.logger.info('Soroban event archival completed', {
        totalArchived,
        batchesProcessed: batchCount - 1,
        errors: errors.length,
      });

      return {
        archived: totalArchived,
        errors,
      };
    } catch (error) {
      this.logger.error('Archival process failed', { error: error.message });
      throw error;
    }
  }

  /**
   * Get archive statistics for monitoring
   * @returns {{totalEvents: number, totalArchived: number, oldestEvent: string|null, newestArchive: string|null}}
   */
  async getArchiveStats() {
    if (!this.database || !this.database.db) {
      throw new Error('Database not initialized');
    }

    const totalEvents = this.database.db
      .prepare('SELECT COUNT(*) as count FROM soroban_events')
      .get().count;

    const totalArchived = this.database.db
      .prepare('SELECT COUNT(*) as count FROM soroban_events_archive')
      .get().count;

    const oldestEvent = this.database.db
      .prepare('SELECT MIN(ledger_timestamp) as ts FROM soroban_events')
      .get().ts;

    const newestArchive = this.database.db
      .prepare('SELECT MAX(archived_at) as ts FROM soroban_events_archive')
      .get().ts;

    return {
      totalEvents,
      totalArchived,
      oldestEvent,
      newestArchive,
    };
  }

  /**
   * Clean up very old archived events (hard delete after extended retention)
   * @param {number} extendedRetentionDays - days to keep in archive before permanent deletion
   * @returns {{deleted: number}}
   */
  async cleanupOldArchives(extendedRetentionDays = 365) {
    if (!this.database || !this.database.db) {
      throw new Error('Database not initialized');
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - extendedRetentionDays);
    const cutoffIso = cutoffDate.toISOString();

    const result = this.database.db
      .prepare('DELETE FROM soroban_events_archive WHERE archived_at < ?')
      .run(cutoffIso);

    const deleted = result.changes || 0;
    this.logger.info('Cleaned up old archived events', { deleted, cutoffDate: cutoffIso });

    return { deleted };
  }
}

module.exports = { SorobanEventArchiveService };
