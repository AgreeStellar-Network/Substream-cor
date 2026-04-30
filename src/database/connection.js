const { Pool } = require('pg');
const { getPgPoolConfig } = require('./poolConfig');
require('dotenv').config();

class DatabaseConnection {
  constructor() {
    this.pool = new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ...getPgPoolConfig(),
    });

    this.pool.on('error', (error) => {
      console.error('Unexpected PostgreSQL pool error', { error: error.message });
    });
  }

  async query(text, params) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;
      console.log('Executed query', { text, duration, rows: result.rowCount });
      return result;
    } catch (error) {
      console.error('Database query error', { text, error: error.message });
      throw error;
    }
  }

  async getClient() {
    return await this.pool.connect();
  }

  getPoolStats() {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = new DatabaseConnection();
