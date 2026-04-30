const cron = require('node-cron');
const badgeService = require('./badgeService');
const gdprService = require('./gdprService');
const { SorobanEventArchiveService } = require('./sorobanEventArchiveService');

class CronService {
  constructor() {
    this.jobs = new Map();
    this.archiveService = new SorobanEventArchiveService();
    this.setupDefaultJobs();
  }

  /**
   * Set the database instance for services that require it
   * @param {AppDatabase} database 
   */
  setDatabase(database) {
    this.archiveService.setDatabase(database);
  }

  setupDefaultJobs() {
    // Run badge milestone check daily at 2 AM UTC
    this.scheduleJob('daily-badge-check', '0 2 * * *', async () => {
      console.log('Running daily badge milestone check...');
      try {
        await badgeService.runDailyMilestoneCheck();
        console.log('Daily badge milestone check completed successfully');
      } catch (error) {
        console.error('Error in daily badge milestone check:', error);
      }
    });

    // Clean up expired exports daily at 3 AM UTC
    this.scheduleJob('cleanup-exports', '0 3 * * *', async () => {
      console.log('Running daily export cleanup...');
      try {
        const expiredFiles = await gdprService.cleanupExpiredExports();
        console.log(`Cleaned up ${expiredFiles.length} expired export files`);
      } catch (error) {
        console.error('Error in export cleanup:', error);
      }
    });

    // Rotate feed tokens every 6 hours
    this.scheduleJob('rotate-feed-tokens', '0 */6 * * *', async () => {
      console.log('Running feed credential rotation...');
      try {
        const feedService = require('./feedService');
        feedService.cleanupExpiredTokens();
        console.log('Feed credential rotation completed');
      } catch (error) {
        console.error('Error in feed credential rotation:', error);
      }
    });

    // Archive historical Soroban subscription events daily at 4 AM UTC
    this.scheduleJob('archive-soroban-events', '0 4 * * *', async () => {
      console.log('Running Soroban event archival...');
      try {
        const result = await this.archiveService.runArchival();
        console.log(`Archived ${result.archived} historical subscription events`);
        if (result.errors.length > 0) {
          console.warn(`Archival completed with ${result.errors.length} errors`);
        }
      } catch (error) {
        console.error('Error in Soroban event archival:', error);
      }
    });

    // Clean up old archived events monthly (1st of month at 5 AM UTC)
    this.scheduleJob('cleanup-old-archives', '0 5 1 * *', async () => {
      console.log('Running old archive cleanup...');
      try {
        const result = await this.archiveService.cleanupOldArchives();
        console.log(`Permanently deleted ${result.deleted} old archived events`);
      } catch (error) {
        console.error('Error in old archive cleanup:', error);
      }
    });
  }

  scheduleJob(name, schedule, task) {
    // Stop existing job if it exists
    if (this.jobs.has(name)) {
      this.jobs.get(name).stop();
    }

    const job = cron.schedule(schedule, task, {
      scheduled: true,
      timezone: 'UTC'
    });

    this.jobs.set(name, job);
    console.log(`Scheduled job '${name}' with schedule: ${schedule}`);

    return job;
  }

  stopJob(name) {
    if (this.jobs.has(name)) {
      this.jobs.get(name).stop();
      this.jobs.delete(name);
      console.log(`Stopped job '${name}'`);
      return true;
    }
    return false;
  }

  stopAllJobs() {
    for (const [name, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    console.log('All cron jobs stopped');
  }

  getJobStatus() {
    const status = {};
    for (const [name, job] of this.jobs) {
      status[name] = {
        running: job.running || false,
        scheduled: true
      };
    }
    return status;
  }

  // Manual job execution for testing
  async executeJob(name) {
    switch (name) {
      case 'daily-badge-check':
        await badgeService.runDailyMilestoneCheck();
        break;
      case 'cleanup-exports':
        await gdprService.cleanupExpiredExports();
        break;
      case 'rotate-feed-tokens':
        const feedService = require('./feedService');
        feedService.cleanupExpiredTokens();
        break;
      case 'archive-soroban-events':
        await this.archiveService.runArchival();
        break;
      case 'cleanup-old-archives':
        await this.archiveService.cleanupOldArchives();
        break;
      default:
        throw new Error(`Unknown job: ${name}`);
    }
  }
}

module.exports = new CronService();
