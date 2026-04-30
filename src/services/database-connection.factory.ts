import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantRouterService } from './tenant-router.service';
import { getKnexPoolConfig, readPositiveInt } from '../database/poolConfig';

@Injectable()
export class DatabaseConnectionFactory {
  private readonly connectionPool = new Map<string, Knex>();
  private readonly maxCachedPools = readPositiveInt(process.env.DB_TENANT_POOL_CACHE_MAX, 10);
  private readonly tenantPoolMax = readPositiveInt(process.env.DB_TENANT_POOL_MAX, 4);

  constructor(private readonly tenantRouter: TenantRouterService) {}

  /**
   * Get a database connection for a specific tenant
   */
  async getConnection(tenantId: string): Promise<Knex> {
    const connectionString = await this.tenantRouter.getTenantDatabase(tenantId);
    
    // Check if connection already exists in pool
    if (this.connectionPool.has(connectionString)) {
      const connection = this.connectionPool.get(connectionString)!;
      this.connectionPool.delete(connectionString);
      this.connectionPool.set(connectionString, connection);
      return connection;
    }

    // Create new connection
    const connection = this.createConnection(connectionString);
    
    await this.evictOldestConnectionIfNeeded();

    // Add to pool
    this.connectionPool.set(connectionString, connection);
    
    return connection;
  }

  /**
   * Get a connection for the shared database (for system operations)
   */
  async getSharedConnection(): Promise<Knex> {
    const connectionString = await this.tenantRouter.getSharedDatabase();
    
    if (this.connectionPool.has(connectionString)) {
      const connection = this.connectionPool.get(connectionString)!;
      this.connectionPool.delete(connectionString);
      this.connectionPool.set(connectionString, connection);
      return connection;
    }

    const connection = this.createConnection(connectionString);
    await this.evictOldestConnectionIfNeeded();
    this.connectionPool.set(connectionString, connection);
    
    return connection;
  }

  /**
   * Create a new Knex connection
   */
  private createConnection(connectionString: string): Knex {
    // Parse connection string to extract configuration
    const config = this.parseConnectionString(connectionString);
    
    return require('knex')({
      client: 'pg',
      connection: config,
      pool: getKnexPoolConfig(process.env, { max: this.tenantPoolMax }),
      migrations: {
        directory: './migrations/knex',
        tableName: 'knex_migrations',
      },
    });
  }

  /**
   * Parse database connection string
   */
  private parseConnectionString(connectionString: string): any {
    // Handle different connection string formats
    if (connectionString.startsWith('postgres://')) {
      // PostgreSQL connection string format
      const url = new URL(connectionString);
      return {
        host: url.hostname,
        port: parseInt(url.port) || 5432,
        user: url.username,
        password: url.password,
        database: url.pathname.substring(1), // Remove leading slash
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      };
    } else if (connectionString.startsWith('postgresql://')) {
      // Alternative PostgreSQL connection string format
      const url = new URL(connectionString);
      return {
        host: url.hostname,
        port: parseInt(url.port) || 5432,
        user: url.username,
        password: url.password,
        database: url.pathname.substring(1),
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      };
    } else {
      // Assume it's a configuration object in JSON format
      try {
        return JSON.parse(connectionString);
      } catch (error) {
        throw new Error(`Invalid connection string format: ${connectionString}`);
      }
    }
  }

  /**
   * Close all connections in the pool
   */
  async closeAllConnections(): Promise<void> {
    const closePromises = Array.from(this.connectionPool.values()).map(
      (connection) => connection.destroy(),
    );
    
    await Promise.all(closePromises);
    this.connectionPool.clear();
  }

  /**
   * Get connection pool statistics
   */
  getPoolStats(): { [key: string]: any } {
    const stats: { [key: string]: any } = {};
    
    this.connectionPool.forEach((connection, connectionString) => {
      const pool = connection.client?.pool;
      if (pool) {
        stats[this.maskConnectionString(connectionString)] = {
          used: pool.numUsed(),
          free: pool.numFree(),
          pending: pool.numPendingAcquires(),
          total: pool.numUsed() + pool.numFree(),
        };
      }
    });

    return stats;
  }

  private maskConnectionString(connectionString: string): string {
    try {
      const url = new URL(connectionString);
      return `${url.protocol}//${url.hostname}:${url.port || '5432'}/${url.pathname.substring(1)}`;
    } catch {
      return 'database-config';
    }
  }

  private async evictOldestConnectionIfNeeded(): Promise<void> {
    if (this.connectionPool.size < this.maxCachedPools) {
      return;
    }

    const oldestConnectionString = this.connectionPool.keys().next().value;
    if (!oldestConnectionString) {
      return;
    }

    const oldestConnection = this.connectionPool.get(oldestConnectionString);
    this.connectionPool.delete(oldestConnectionString);

    if (oldestConnection) {
      await oldestConnection.destroy();
    }
  }

  /**
   * Test connection health
   */
  async testConnection(tenantId: string): Promise<boolean> {
    try {
      const connection = await this.getConnection(tenantId);
      await connection.raw('SELECT 1');
      return true;
    } catch (error) {
      console.error(`Connection test failed for tenant ${tenantId}:`, error);
      return false;
    }
  }

  /**
   * Remove a connection from the pool (useful for tenant migration)
   */
  removeConnection(connectionString: string): void {
    const connection = this.connectionPool.get(connectionString);
    if (connection) {
      connection.destroy();
      this.connectionPool.delete(connectionString);
    }
  }
}
