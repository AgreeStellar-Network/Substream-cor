const request = require('supertest');

const { createApp } = require('./index');
const { loadConfig } = require('./src/config');
const { AppDatabase } = require('./src/db/appDatabase');
const { CdnTokenService } = require('./src/services/cdnTokenService');
const { CreatorAuthService } = require('./src/services/creatorAuthService');

describe('AgreeStellar API', () => {
  let database;
  let config;
  let creatorAuthService;
  let app;

  beforeEach(() => {
    config = loadConfig({
      DATABASE_FILENAME: ':memory:',
      CDN_BASE_URL: 'https://cdn.substream.test/private',
      CDN_TOKEN_SECRET: 'test-secret',
      CDN_TOKEN_TTL_SECONDS: '300',
      CREATOR_AUTH_SECRET: 'creator-test-secret',
      SOROBAN_CONTRACT_ID: 'CAOUX2FZ65IDC4F2X7LJJ2SVF23A35CCTZB7KVVN475JCLKTTU4CEY6L',
    });

    database = new AppDatabase(':memory:');
    database.ensureCreator('creator-1');
    database.ensureCreator('creator-2');
    database.seedCreatorSettings({
      creatorId: 'creator-1',
      flowRate: '100',
      currency: 'XLM',
    });
    database.seedVideo({
      id: 'video-1',
      creatorId: 'creator-1',
      title: 'Genesis Stream',
      visibility: 'private',
    });
    database.seedCoopSplit({
      id: 'split-1',
      creatorId: 'creator-1',
      splits: [
        { walletAddress: 'GAAA111', percentage: 60 },
        { walletAddress: 'GBBB222', percentage: 40 },
      ],
    });

    creatorAuthService = new CreatorAuthService(config);
    app = createApp({
      config,
      database,
      creatorAuthService,
      subscriptionVerifier: {
        verifySubscription: jest.fn().mockResolvedValue({
          active: true,
          status: 'active',
        }),
      },
    });
  });

  function authHeader(creatorId = 'creator-1') {
    return `Bearer ${creatorAuthService.issueToken({ creatorId })}`;
  }

  it('returns project information on GET /', async () => {
    const res = await request(app).get('/');

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('project', 'AgreeStellar');
    expect(res.body).toHaveProperty('status', 'Active');
  });

  it('issues a short-lived CDN token for an active subscriber', async () => {
    const res = await request(app).post('/api/cdn/token').send({
      walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      creatorAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR5Q',
      contentId: 'bafy-content',
      segmentPath: '/segments/episode-1/00001.ts',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('tokenType', 'Bearer');
    expect(res.body.playbackUrl).toContain('contentId=bafy-content');
  });

  it('rejects an expired CDN token', async () => {
    const expiredConfig = {
      ...config,
      cdn: {
        ...config.cdn,
        tokenTtlSeconds: -1,
      },
    };
    const tokenService = new CdnTokenService(expiredConfig);
    const { token } = tokenService.issueToken({
      walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      creatorAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBR5Q',
      contentId: 'bafy-content',
      segmentPath: '/segments/episode-1/00001.ts',
      subscription: { status: 'active' },
    });

    const expiredApp = createApp({
      config: expiredConfig,
      database,
      creatorAuthService: new CreatorAuthService(expiredConfig),
      subscriptionVerifier: {
        verifySubscription: jest.fn(),
      },
    });

    const res = await request(expiredApp)
      .get('/api/cdn/validate')
      .query({ token, contentId: 'bafy-content', segmentPath: '/segments/episode-1/00001.ts' });

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Token expired');
  });

  it('writes an audit entry when flow rate is updated', async () => {
    const before = database.listAuditLogsByCreatorId('creator-1');
    const res = await request(app)
      .patch('/api/creator/flow-rate')
      .set('Authorization', authHeader())
      .set('X-Forwarded-For', '198.51.100.3')
      .send({
        flowRate: '250',
        currency: 'USDC',
        timestamp: '1999-01-01T00:00:00.000Z',
        creatorId: 'creator-2',
      });

    const after = database.listAuditLogsByCreatorId('creator-1');

    expect(res.statusCode).toBe(200);
    expect(after).toHaveLength(before.length + 1);
    const latest = after[0];
    expect(latest.actionType).toBe('FLOW_RATE_UPDATED');
    expect(latest.creatorId).toBe('creator-1');
    expect(latest.entityType).toBe('creator_settings');
    expect(latest.entityId).toBe('creator-1');
    expect(latest.ipAddress).toBe('127.0.0.1');
    const metadata = JSON.parse(latest.metadataJson);
    expect(metadata.previous_flow_rate).toBe('100');
    expect(metadata.new_flow_rate).toBe('250');
    expect(latest.timestamp).not.toBe('1999-01-01T00:00:00.000Z');
  });

  it('writes an audit entry when video visibility changes', async () => {
    const res = await request(app)
      .patch('/api/creator/videos/video-1/visibility')
      .set('Authorization', authHeader())
      .send({ visibility: 'public' });

    expect(res.statusCode).toBe(200);
    const [latest] = database.listAuditLogsByCreatorId('creator-1');
    expect(latest.actionType).toBe('VIDEO_VISIBILITY_CHANGED');
    expect(latest.entityType).toBe('video');
    expect(latest.entityId).toBe('video-1');
    expect(JSON.parse(latest.metadataJson)).toMatchObject({
      previous_visibility: 'private',
      new_visibility: 'public',
    });
  });

  it('writes an audit entry when a co-op split is modified', async () => {
    const res = await request(app)
      .patch('/api/creator/coop-splits/split-1')
      .set('Authorization', authHeader())
      .send({
        splits: [
          { walletAddress: 'GAAA111', percentage: 50 },
          { walletAddress: 'GBBB222', percentage: 30 },
          { walletAddress: 'GCCC333', percentage: 20 },
        ],
      });

    expect(res.statusCode).toBe(200);
    const [latest] = database.listAuditLogsByCreatorId('creator-1');
    expect(latest.actionType).toBe('COOP_SPLIT_MODIFIED');
    expect(latest.entityType).toBe('coop_split');
    expect(latest.entityId).toBe('split-1');
    expect(JSON.parse(latest.metadataJson)).toMatchObject({
      previous_split: expect.objectContaining({ participants: 2 }),
      new_split: expect.objectContaining({ participants: 3 }),
    });
  });

  it('returns only the authenticated creators own audit log', async () => {
    await request(app)
      .patch('/api/creator/flow-rate')
      .set('Authorization', authHeader('creator-1'))
      .send({ flowRate: '300' });
    database.insertAuditLog({
      creatorId: 'creator-2',
      actionType: 'FLOW_RATE_UPDATED',
      entityType: 'creator_settings',
      entityId: 'creator-2',
      timestamp: new Date().toISOString(),
      ipAddress: '127.0.0.1',
      metadata: { previous_flow_rate: '5', new_flow_rate: '10' },
    });

    const res = await request(app)
      .get('/api/creator/audit-log')
      .set('Authorization', authHeader('creator-1'));

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].creator_id).toBe('creator-1');
  });

  it('exports the authenticated creators audit log as CSV', async () => {
    database.insertAuditLog({
      creatorId: 'creator-1',
      actionType: 'VIDEO_VISIBILITY_CHANGED',
      entityType: 'video',
      entityId: 'video-1',
      timestamp: '2026-03-23T10:00:00.000Z',
      ipAddress: '127.0.0.1',
      metadata: { previous_visibility: '=private', new_visibility: 'public' },
    });

    const res = await request(app)
      .get('/api/creator/audit-log/export?format=csv')
      .set('Authorization', authHeader());

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('"timestamp","action_type","entity_type","entity_id","ip_address","metadata"');
    expect(res.text).toContain('"VIDEO_VISIBILITY_CHANGED"');
    expect(res.text).toContain("'=private");
  });

  it('exports the authenticated creators audit log as PDF', async () => {
    database.insertAuditLog({
      creatorId: 'creator-1',
      actionType: 'COOP_SPLIT_MODIFIED',
      entityType: 'coop_split',
      entityId: 'split-1',
      timestamp: '2026-03-23T10:00:00.000Z',
      ipAddress: '127.0.0.1',
      metadata: { note: 'compliance review' },
    });

    const res = await request(app)
      .get('/api/creator/audit-log/export?format=pdf')
      .set('Authorization', authHeader())
      .buffer(true)
      .parse(binaryParser);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.toString('utf8')).toContain('AgreeStellar Creator Audit Log');
    expect(res.body.toString('utf8')).toContain('Creator: creator-1');
  });

  it('rejects unsupported export formats', async () => {
    const res = await request(app)
      .get('/api/creator/audit-log/export?format=json')
      .set('Authorization', authHeader());

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('format must be one of: csv, pdf');
  });

  it('blocks unauthenticated audit log access', async () => {
    const res = await request(app).get('/api/creator/audit-log');

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('does not expose update or delete routes for audit log entries', async () => {
    database.insertAuditLog({
      creatorId: 'creator-1',
      actionType: 'FLOW_RATE_UPDATED',
      entityType: 'creator_settings',
      entityId: 'creator-1',
      timestamp: new Date().toISOString(),
      ipAddress: '127.0.0.1',
      metadata: { previous_flow_rate: '100', new_flow_rate: '200' },
    });
    const [latest] = database.listAuditLogsByCreatorId('creator-1');

    const patchResponse = await request(app)
      .patch(`/api/creator/audit-log/${latest.id}`)
      .set('Authorization', authHeader())
      .send({ metadata: { changed: true } });
    const deleteResponse = await request(app)
      .delete(`/api/creator/audit-log/${latest.id}`)
      .set('Authorization', authHeader());

    expect(patchResponse.statusCode).toBe(404);
    expect(deleteResponse.statusCode).toBe(404);
  });

  it('creates a new audit row for repeated creator actions', async () => {
    await request(app)
      .patch('/api/creator/flow-rate')
      .set('Authorization', authHeader())
      .send({ flowRate: '200' });
    await request(app)
      .patch('/api/creator/flow-rate')
      .set('Authorization', authHeader())
      .send({ flowRate: '400' });

    const logs = database.listAuditLogsByCreatorId('creator-1');
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((row) => row.id)).size).toBe(2);
  });

  it('rolls back the parent action if audit persistence fails', async () => {
    const failingApp = createApp({
      config,
      database,
      creatorAuthService,
      subscriptionVerifier: {
        verifySubscription: jest.fn(),
      },
      auditLogService: {
        append: jest.fn(() => {
          throw new Error('Audit persistence failed');
        }),
        listByCreatorId: jest.fn(() => []),
      },
    });

    const res = await request(failingApp)
      .patch('/api/creator/videos/video-1/visibility')
      .set('Authorization', authHeader())
      .send({ visibility: 'public' });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Audit persistence failed');
    expect(database.getVideoById('video-1').visibility).toBe('private');
  });
});

function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}
