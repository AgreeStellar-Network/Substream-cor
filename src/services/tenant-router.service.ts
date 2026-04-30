import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';

export interface TenantDatabaseConfig {
  tenantId: string;
  tier: 'standard' | 'enterprise';
  connectionString: string;
  maxConnections?: number;
  connectionTimeout?: number;
}

export interface DatabaseCluster {
  id: string;
  type: 'shared' | 'enterprise';
  connectionString: string;
  maxConnections: number;
  currentConnections: number;
  tenants: string[];
}

@Injectable()
export class TenantRouterService {
  private readonly ENTERPRISE_TIER = 'enterprise';
  private readonly SHARED_DB_KEY = 'shared_cluster';
  private readonly TENANT_REGISTRY_KEY = 'tenant_db_registry';
  private readonly CLUSTER_STATS_KEY = 'cluster_stats';

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  /**
   * Get the appropriate database connection string for a tenant
   */
  async getTenantDatabase(tenantId: string): Promise<string> {
    // Check if tenant exists in registry
    const tenantConfig = await this.getTenantConfig(tenantId);
    
    if (!tenantConfig) {
      throw new Error(`Tenant ${tenantId} not found in registry`);
    }

    // For enterprise tenants, return their dedicated database
    if (tenantConfig.tier === this.ENTERPRISE_TIER) {
      return tenantConfig.connectionString;
    }

    // For standard tenants, return shared database
    return await this.getSharedDatabase();
  }

  /**
   * Register a new tenant with their database configuration
   */
  async registerTenant(config: TenantDatabaseConfig): Promise<void> {
    const tenantKey = `${this.TENANT_REGISTRY_KEY}:${config.tenantId}`;
    
    await this.redis.hset(tenantKey, {
      tier: config.tier,
      connectionString: config.connectionString,
      maxConnections: config.maxConnections?.toString() || '20',
      connectionTimeout: config.connectionTimeout?.toString() || '30000',
      registeredAt: new Date().toISOString(),
    });

    // Update cluster statistics
    await this.updateClusterStats(config.tier, config.connectionString, 'add');
  }

  /**
   * Migrate a tenant from shared to enterprise database
   */
  async migrateToEnterprise(
    tenantId: string,
    enterpriseConnectionString: string,
  ): Promise<void> {
    const currentConfig = await this.getTenantConfig(tenantId);
    
    if (!currentConfig) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    if (currentConfig.tier === this.ENTERPRISE_TIER) {
      throw new Error(`Tenant ${tenantId} is already on enterprise tier`);
    }

    // Start migration process
    const migrationKey = `migration:${tenantId}:${Date.now()}`;
    
    await this.redis.hset(migrationKey, {
      status: 'in_progress',
      fromDb: currentConfig.connectionString,
      toDb: enterpriseConnectionString,
      startedAt: new Date().toISOString(),
    });

    try {
      // Update tenant configuration
      await this.registerTenant({
        tenantId,
        tier: 'enterprise',
        connectionString: enterpriseConnectionString,
        maxConnections: 50, // Higher limit for enterprise
        connectionTimeout: 60000, // Longer timeout for enterprise
      });

      // Update cluster statistics
      await this.updateClusterStats('standard', currentConfig.connectionString, 'remove');
      await this.updateClusterStats('enterprise', enterpriseConnectionString, 'add');

      // Mark migration as complete
      await this.redis.hset(migrationKey, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });

      // Clean up old migration records after 24 hours
      await this.redis.expire(migrationKey, 86400);

    } catch (error) {
      // Mark migration as failed
      await this.redis.hset(migrationKey, {
        status: 'failed',
        error: error.message,
        failedAt: new Date().toISOString(),
      });
      
      throw error;
    }
  }

  /**
   * Get tenant configuration from Redis
   */
  private async getTenantConfig(tenantId: string): Promise<TenantDatabaseConfig | null> {
    const tenantKey = `${this.TENANT_REGISTRY_KEY}:${tenantId}`;
    const config = await this.redis.hgetall(tenantKey);
    
    if (!config || Object.keys(config).length === 0) {
      return null;
    }

    return {
      tenantId,
      tier: config.tier as 'standard' | 'enterprise',
      connectionString: config.connectionString,
      maxConnections: config.maxConnections ? parseInt(config.maxConnections) : undefined,
      connectionTimeout: config.connectionTimeout ? parseInt(config.connectionTimeout) : undefined,
    };
  }

  /**
   * Get shared database connection string
   */
  async getSharedDatabase(): Promise<string> {
    const sharedConfig = await this.redis.hgetall(this.SHARED_DB_KEY);
    
    if (!sharedConfig.connectionString) {
      throw new Error('Shared database configuration not found');
    }

    return sharedConfig.connectionString;
  }

  /**
   * Update cluster statistics
   */
  private async updateClusterStats(
    tier: string,
    connectionString: string,
    operation: 'add' | 'remove',
  ): Promise<void> {
    const clusterKey = `${this.CLUSTER_STATS_KEY}:${tier}:${this.hashConnectionString(connectionString)}`;
    
    if (operation === 'add') {
      await this.redis.hincrby(clusterKey, 'tenantCount', 1);
    } else {
      await this.redis.hincrby(clusterKey, 'tenantCount', -1);
    }

    // Set expiration for stats (24 hours)
    await this.redis.expire(clusterKey, 86400);
  }

  /**
   * Hash connection string for consistent key generation
   */
  private hashConnectionString(connectionString: string): string {
    // Simple hash function for demonstration
    // In production, use a proper cryptographic hash
    let hash = 0;
    for (let i = 0; i < connectionString.length; i++) {
      const char = connectionString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString();
  }

  /**
   * Get cluster statistics for monitoring
   */
  async getClusterStats(): Promise<DatabaseCluster[]> {
    const stats: DatabaseCluster[] = [];
    
    // Get all cluster stat keys
    const keys = await this.redis.keys(`${this.CLUSTER_STATS_KEY}:*`);
    
    for (const key of keys) {
      const parts = key.split(':');
      const tier = parts[2];
      const connectionHash = parts[3];
      
      const clusterData = await this.redis.hgetall(key);
      
      if (clusterData.tenantCount) {
        stats.push({
          id: connectionHash,
          type: tier as 'shared' | 'enterprise',
          connectionString: '', // Don't expose connection strings in stats
          maxConnections: tier === 'enterprise' ? 50 : 20,
          currentConnections: parseInt(clusterData.tenantCount),
          tenants: [], // Would need to be populated separately if needed
        });
      }
    }

    return stats;
  }

  /**
   * Check if a tenant is on enterprise tier
   */
  async isEnterpriseTenant(tenantId: string): Promise<boolean> {
    const config = await this.getTenantConfig(tenantId);
    return config?.tier === this.ENTERPRISE_TIER;
  }

  /**
   * Initialize shared database configuration
   */
  async initializeSharedDatabase(connectionString: string): Promise<void> {
    await this.redis.hset(this.SHARED_DB_KEY, {
      connectionString,
      type: 'shared',
      maxConnections: '20',
      initializedAt: new Date().toISOString(),
    });
  }
}
