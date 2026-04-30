/**
 * Knex.js Configuration for Zero-Downtime Migrations
 * 
 * This configuration supports:
 * - Pre-deploy hooks (before migrations)
 * - Post-deploy hooks (after migrations)
 * - Blue-green deployment strategies
 * - Health checks during migrations
 */

module.exports = {
  client: 'better-sqlite3',
  connection: {
    filename: process.env.DATABASE_FILENAME || './data/substream.db',
  },
  useNullAsDefault: true,
  migrations: {
    directory: './migrations/knex',
    extension: 'js',
    stub: './migrations/stubs/migration.stub',
    loadExtensions: ['.js'],
  },
  seeds: {
    directory: './seeds',
  },
  pool: {
    min: 2,
    max: 20,
    acquireTimeoutMillis: 30000,
    createTimeoutMillis: 5000,
    destroyTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
    createRetryIntervalMillis: 200,
    afterCreate: (conn, done) => {
      // Enable WAL mode for better concurrent read performance
      conn.exec('PRAGMA journal_mode = WAL;');
      conn.exec('PRAGMA busy_timeout = 5000;');
      done(null, conn);
    },
  },
};
