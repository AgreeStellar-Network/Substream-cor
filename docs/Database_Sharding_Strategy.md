# Database Sharding Strategy RFC

## RFC: Database Horizontal Sharding Strategy for AgreeStellar

**Author:** AgreeStellar Team  
**Status:** Draft  
**Created:** March 2026  
**Target:** Multi-Master Database Architecture  

## Executive Summary

This RFC outlines a comprehensive horizontal sharding strategy for the Substream-cor to support long-term scalability. After analyzing the current SQLite-based architecture and projected growth patterns, we recommend **creator_id-based sharding** as the primary strategy, with geo-region as a secondary consideration for future optimization.

## Current Architecture Analysis

### Database Schema Overview
The current implementation uses SQLite with the following core entities:

- **creators** - Creator profiles and metadata
- **videos** - Video content and metadata  
- **subscriptions** - User subscription relationships
- **creator_audit_logs** - Audit trail for creator actions
- **comments** - User comments on content
- **creator_settings** - Creator-specific configuration
- **transcoding_results** - Video processing results
- **coop_splits** - Revenue sharing configurations

### Current Limitations
- Single SQLite database file limits concurrent writes
- No horizontal scaling capability
- Geographic latency issues for global user base
- Single point of failure
- Limited to local file system storage

## Sharding Strategy Analysis

### Option 1: Creator ID-Based Sharding (RECOMMENDED)

**Advantages:**
- **Data Locality**: All creator-related data (videos, subscriptions, comments, audit logs) resides on the same shard
- **Query Performance**: Most queries are creator-scoped, minimizing cross-shard joins
- **Simple Migration Path**: Clear sharding key exists in all relevant tables
- **Load Distribution**: Natural distribution based on creator activity patterns
- **Business Logic Alignment**: Maps directly to the creator-centric business model

**Disadvantages:**
- Popular creators may create "hot shards"
- Requires rebalancing mechanisms for creator growth

**Implementation:**
```sql
-- Sharding key: creator_id
-- Shard mapping: hash(creator_id) % shard_count

-- Example shard assignment:
-- Shard 0: creators with hash(creator_id) % 8 = 0
-- Shard 1: creators with hash(creator_id) % 8 = 1
-- ...
-- Shard 7: creators with hash(creator_id) % 8 = 7
```

### Option 2: Geographic Region-Based Sharding

**Advantages:**
- **Latency Optimization**: Data stored closer to users
- **Compliance**: Data residency requirements
- **Regional Failover**: Natural disaster recovery boundaries

**Disadvantages:**
- **Cross-Region Queries**: Creator content accessed globally requires cross-shard queries
- **Complex Migration**: Geographic data movement is expensive
- **Uneven Distribution**: Population density creates imbalanced loads
- **Business Logic Mismatch**: Creators are global, not regional

**Implementation:**
```sql
-- Sharding key: geo_region (derived from user IP or self-reported)
-- Shard mapping: direct mapping to geographic regions

-- Example shard assignment:
-- Shard 0: North America
-- Shard 1: Europe  
-- Shard 2: Asia Pacific
-- Shard 3: Other regions
```

## Recommended Strategy: Hybrid Approach

### Phase 1: Creator ID-Based Sharding (Primary)
- Implement consistent hashing on creator_id
- Start with 8 shards, expandable to 32+
- Use PostgreSQL for each shard

### Phase 2: Geographic Optimization (Secondary)
- Replicate shards across geographic regions for read performance
- Implement write routing to primary region
- Add read replicas for latency optimization

## Technical Architecture

### Database Technology Stack

**Primary Database:** PostgreSQL 15+
- Proven horizontal scaling capabilities
- Advanced partitioning and indexing
- Strong consistency guarantees
- Extensive tooling ecosystem

**Connection Management:** PgBouncer
- Connection pooling
- Load balancing
- Automatic failover

**Shard Routing:** Custom Shard Router Service
- Consistent hash ring implementation
- Shard health monitoring
- Automatic rebalancing triggers

### Hardware Requirements

#### Initial Configuration (8 Shards)

**Per Shard Node Specifications:**
- **CPU:** 8 vCPU (Intel Xeon or AMD EPYC)
- **Memory:** 32GB RAM
- **Storage:** 1TB NVMe SSD (RAID 10)
- **Network:** 10Gbps network interface
- **Backup:** Additional 1TB for snapshots and WAL

**Shared Infrastructure:**
- **Router Nodes:** 3x (2CPU, 4GB RAM, 100GB SSD)
- **Monitoring:** 1x dedicated monitoring node
- **Backup Storage:** 10TB network-attached storage

**Total Initial Hardware:**
- Compute: 64 vCPU, 256GB RAM
- Storage: 8TB primary + 8TB backup
- Network: 80Gbps aggregate bandwidth

#### Scaling to 32 Shards

**Additional Requirements:**
- Linear scaling of compute and storage
- Increased network bandwidth to 320Gbps
- Additional router nodes for load distribution

### Software Architecture Changes

#### 1. Database Abstraction Layer

```javascript
// New: ShardAwareDatabaseClient
class ShardAwareDatabaseClient {
  constructor(shardConfig) {
    this.shardRouter = new ShardRouter(shardConfig);
    this.connectionPools = this.initializePools(shardConfig);
  }

  async query(creatorId, sql, params) {
    const shardId = this.shardRouter.getShard(creatorId);
    const pool = this.connectionPools[shardId];
    return pool.query(sql, params);
  }

  async transaction(creatorId, callback) {
    const shardId = this.shardRouter.getShard(creatorId);
    const pool = this.connectionPools[shardId];
    return pool.transaction(callback);
  }
}
```

#### 2. Shard Router Service

```javascript
class ShardRouter {
  constructor(shardCount) {
    this.shardCount = shardCount;
    this.ring = new ConsistentHashRing(shardCount);
    this.healthChecker = new ShardHealthChecker();
  }

  getShard(creatorId) {
    return this.ring.getShard(creatorId);
  }

  async getHealthyShard(creatorId) {
    const primaryShard = this.getShard(creatorId);
    if (await this.healthChecker.isHealthy(primaryShard)) {
      return primaryShard;
    }
    return this.getFailoverShard(primaryShard);
  }
}
```

#### 3. Migration Strategy

**Phase 1: Dual-Write Period (4 weeks)**
- Continue writing to SQLite
- Begin writing to PostgreSQL shards
- Validate data consistency

**Phase 2: Read Migration (2 weeks)**
- Route reads to PostgreSQL shards
- Maintain SQLite as backup
- Performance validation

**Phase 3: Cutover (1 week)**
- Final data synchronization
- Switch all traffic to shards
- Decommission SQLite

#### 4. Service Updates Required

**AppDatabase Class Modifications:**
- Replace SQLite with PostgreSQL client
- Add shard-aware query methods
- Implement cross-shard transaction handling

**API Layer Changes:**
- Add creator_id to all relevant requests
- Implement shard routing middleware
- Update error handling for shard failures

**Background Services:**
- Video processing worker updates
- Subscription expiry checker modifications
- Analytics service shard aggregation

### Multi-Master Architecture Preparation

#### Master-Master Replication Setup

**Configuration:**
- Primary shards in different geographic regions
- Logical replication using PostgreSQL's built-in features
- Conflict resolution based on timestamp and creator_id

**Conflict Resolution Strategy:**
```sql
-- Example: Last-write-wins with creator_id tie-breaker
CREATE TABLE subscriptions (
  creator_id TEXT,
  wallet_address TEXT,
  updated_at TIMESTAMP,
  PRIMARY KEY (creator_id, wallet_address)
) WITH (PRIMARY_KEY_USING_INDEX = true);

-- Replication conflict resolution
ALTER TABLE subscriptions 
  REPLICA IDENTITY FULL;
```

#### Global Transaction Coordination

**Two-Phase Commit Implementation:**
- Coordinator service for cross-shard transactions
- Timeout and rollback mechanisms
- Compensation transaction patterns

## Implementation Timeline

### Phase 1: Foundation (Weeks 1-4)
- [ ] Set up PostgreSQL cluster (8 shards)
- [ ] Implement shard router service
- [ ] Create database abstraction layer
- [ ] Develop migration tools

### Phase 2: Data Migration (Weeks 5-8)
- [ ] Implement dual-write mechanism
- [ ] Migrate historical data
- [ ] Validate data consistency
- [ ] Performance testing

### Phase 3: Service Migration (Weeks 9-12)
- [ ] Update all services to use sharded database
- [ ] Implement cross-shard query optimization
- [ ] Add monitoring and alerting
- [ ] Documentation and training

### Phase 4: Multi-Master Preparation (Weeks 13-16)
- [ ] Set up master-master replication
- [ ] Implement conflict resolution
- [ ] Geographic distribution planning
- [ ] Disaster recovery testing

## Monitoring and Observability

### Key Metrics

**Shard-Level Metrics:**
- Query latency per shard
- Connection pool utilization
- Disk space usage
- Replication lag

**Cross-Shard Metrics:**
- Query distribution across shards
- Hot shard identification
- Cross-shard transaction success rate
- Failover frequency

**Alerting Thresholds:**
- Shard latency > 100ms (warning), > 500ms (critical)
- Disk usage > 80% (warning), > 90% (critical)
- Replication lag > 10 seconds
- Connection pool > 80% utilization

### Dashboard Requirements

- Real-time shard health status
- Query performance analytics
- Data distribution visualization
- Migration progress tracking

## Risk Assessment and Mitigation

### Technical Risks

**Risk:** Cross-shard transaction complexity
**Mitigation:** Minimize cross-shard operations, implement compensation patterns

**Risk:** Hot shard formation
**Mitigation:** Implement automatic rebalancing, monitor shard distribution

**Risk:** Data consistency during migration
**Mitigation:** Extensive testing, gradual rollout, rollback procedures

### Operational Risks

**Risk:** Increased operational complexity
**Mitigation:** Comprehensive documentation, automated tooling, training

**Risk:** Performance degradation during migration
**Mitigation:** Load testing, gradual traffic shifting, performance monitoring

## Cost Analysis

### Infrastructure Costs (Annual)

**Initial Setup (8 Shards):**
- Compute: $48,000 ($500/month per node × 8 nodes × 12 months)
- Storage: $24,000 ($250/month per TB × 8TB × 12 months)
- Network: $12,000 ($125/month × 12 months)
- **Total Phase 1:** $84,000

**Scaled Setup (32 Shards):**
- Compute: $192,000 (4x increase)
- Storage: $96,000 (4x increase)
- Network: $48,000 (4x increase)
- **Total Phase 2:** $336,000

### Development Costs

**Engineering Effort:**
- Database engineers: 2 FTE × 4 months = 8 person-months
- Backend engineers: 3 FTE × 2 months = 6 person-months
- DevOps engineers: 1 FTE × 2 months = 2 person-months
- **Total Effort:** 16 person-months

## Conclusion

The recommended creator_id-based sharding strategy provides the best balance of performance, scalability, and implementation complexity for the AgreeStellar. The phased approach allows for gradual migration while maintaining system availability and data integrity.

The hybrid approach, combining creator-based sharding with geographic optimization, positions the platform for both horizontal scaling and global performance requirements.

**Next Steps:**
1. Stakeholder review and approval
2. Infrastructure procurement
3. Team assignment and timeline finalization
4. Begin Phase 1 implementation

---

**Appendix A: Detailed Schema Mapping**

**Primary Shard Tables (creator_id scoped):**
- creators
- videos
- subscriptions
- creator_audit_logs
- creator_settings
- coop_splits

**Global Tables (replicated across all shards):**
- System configuration
- Global user registry (if implemented)
- Cross-shard transaction logs

**Appendix B: Sample Migration Scripts**

[Detailed migration scripts would be provided in the implementation phase]

**Appendix C: Performance Benchmarks**

[Benchmark results from testing environment]
