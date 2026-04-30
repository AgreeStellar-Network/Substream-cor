const Database = require('better-sqlite3');
const request = require('supertest');
const express = require('express');

const {
  SanctionsScreeningService,
  ACCOUNT_STATUS,
  RISK_LEVEL,
  EVENT_TYPE,
  REVIEW_STATUS,
} = require('./src/services/sanctionsScreeningService');
const { StaticListSanctionsProvider } = require('./src/services/sanctionsProviders');
const { createSanctionsBlockMiddleware } = require('./middleware/sanctionsBlock');
const createSanctionsComplianceRoutes = require('./routes/sanctionsCompliance');

function makeDatabase() {
  return { db: new Database(':memory:') };
}

function makeService({ provider, failClosed, database } = {}) {
  return new SanctionsScreeningService({
    database: database || makeDatabase(),
    provider: provider || new StaticListSanctionsProvider({
      list: ['GBADBADADDRESSAAAA', 'GSANCTIONEDABCXYZ'],
    }),
    failClosed,
    logger: { warn: () => {}, error: () => {} },
    blockCacheTtlMs: 1000,
  });
}

describe('SanctionsScreeningService', () => {
  test('allows clean addresses, records SCREEN_PASS audit, and saves an ACTIVE row', async () => {
    const service = makeService();

    const result = await service.screenAddress('GCLEAN111', {
      triggeringAction: 'sep10_verify',
      ipAddress: '1.1.1.1',
    });

    expect(result.allowed).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.status).toBe(ACCOUNT_STATUS.ACTIVE);
    expect(service.isBlocked('GCLEAN111')).toBe(false);

    const status = service.getAccountStatus('GCLEAN111');
    expect(status.accountStatus).toBe(ACCOUNT_STATUS.ACTIVE);
    expect(status.lastAuditId).toMatch(/^sec_/);

    const audit = service.getAuditTrail('GCLEAN111');
    expect(audit[0].eventType).toBe(EVENT_TYPE.SCREEN_PASS);
    expect(audit[0].triggeringAction).toBe('sep10_verify');
    expect(audit[0].ipAddress).toBe('1.1.1.1');
  });

  test('blocks high-risk addresses, queues a review, and writes BLOCKED + SCREEN_FLAGGED audits', async () => {
    const service = makeService();

    const result = await service.screenAddress('GBADBADADDRESSAAAA', {
      triggeringAction: 'sep10_verify',
    });

    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.status).toBe(ACCOUNT_STATUS.BLOCKED);
    expect(result.riskLevel).toBe(RISK_LEVEL.HIGH);
    expect(result.flaggedLists).toContain('OFAC SDN');
    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(true);

    const audit = service.getAuditTrail('GBADBADADDRESSAAAA');
    const events = audit.map((row) => row.eventType);
    expect(events).toContain(EVENT_TYPE.SCREEN_FLAGGED);
    expect(events).toContain(EVENT_TYPE.BLOCKED);
    expect(events).toContain(EVENT_TYPE.REVIEW_QUEUED);

    const queue = service.listReviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].walletAddress).toBe('GBADBADADDRESSAAAA');
    expect(queue[0].status).toBe(REVIEW_STATUS.OPEN);
    expect(queue[0].flaggedLists).toContain('OFAC SDN');
  });

  test('re-screening an already-blocked wallet short-circuits without hitting the provider', async () => {
    let providerCalls = 0;
    const provider = {
      name: 'spy',
      screenAddress: async (addr) => {
        providerCalls += 1;
        return addr === 'GBADBADADDRESSAAAA'
          ? {
              riskLevel: 'HIGH',
              riskScore: 100,
              flaggedLists: ['OFAC SDN'],
              reason: 'sdn',
              provider: 'spy',
            }
          : { riskLevel: 'LOW', riskScore: 0, flaggedLists: [], reason: null, provider: 'spy' };
      },
    };
    const service = makeService({ provider });

    await service.screenAddress('GBADBADADDRESSAAAA');
    expect(providerCalls).toBe(1);

    // Second screen of the same blocked wallet should not call provider.
    const repeat = await service.screenAddress('GBADBADADDRESSAAAA');
    expect(repeat.allowed).toBe(false);
    expect(repeat.cached).toBe(true);
    expect(providerCalls).toBe(1);
  });

  test('isBlocked is fast-cached and idempotent', async () => {
    const service = makeService();

    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(false); // not yet screened
    await service.screenAddress('GBADBADADDRESSAAAA');
    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(true);

    // Cache hit on subsequent calls (same value, no DB error).
    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(true);
    expect(service.isBlocked('GCLEAN_OTHER')).toBe(false);
  });

  test('assertNotBlocked throws an ACCOUNT_BLOCKED error and logs a webhook audit', async () => {
    const service = makeService();
    await service.screenAddress('GBADBADADDRESSAAAA');

    expect(() =>
      service.assertNotBlocked('GBADBADADDRESSAAAA', { actor: 'webhook-dispatcher' })
    ).toThrow(/ACCOUNT_BLOCKED|blocked/i);

    const audit = service.getAuditTrail('GBADBADADDRESSAAAA');
    expect(audit.some((row) => row.eventType === EVENT_TYPE.WEBHOOK_BLOCKED)).toBe(true);
  });

  test('markFalsePositive unblocks, records FALSE_POSITIVE + UNBLOCKED audits, closes the queue', async () => {
    const service = makeService();
    await service.screenAddress('GBADBADADDRESSAAAA');
    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(true);

    const result = await service.markFalsePositive({
      walletAddress: 'GBADBADADDRESSAAAA',
      reviewedBy: 'officer@compliance',
      decisionNotes: 'Customer is a homonym; verified KYC.',
    });

    expect(result.status).toBe(ACCOUNT_STATUS.ACTIVE);
    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(false);

    const audit = service.getAuditTrail('GBADBADADDRESSAAAA');
    const events = audit.map((row) => row.eventType);
    expect(events).toContain(EVENT_TYPE.FALSE_POSITIVE);
    expect(events).toContain(EVENT_TYPE.UNBLOCKED);

    const queue = service.listReviewQueue({ status: 'open' });
    expect(queue).toHaveLength(0);
    const cleared = service.listReviewQueue({ status: 'cleared' });
    expect(cleared).toHaveLength(1);
    expect(cleared[0].reviewedBy).toBe('officer@compliance');
  });

  test('confirmSanction keeps the block but closes the review ticket', async () => {
    const service = makeService();
    await service.screenAddress('GBADBADADDRESSAAAA');

    await service.confirmSanction({
      walletAddress: 'GBADBADADDRESSAAAA',
      reviewedBy: 'officer@compliance',
      decisionNotes: 'Confirmed match against OFAC SDN entry.',
    });

    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(true);
    const queue = service.listReviewQueue({ status: 'confirmed' });
    expect(queue).toHaveLength(1);
  });

  test('provider error fails open by default, fails closed when configured', async () => {
    const erroringProvider = {
      name: 'broken',
      screenAddress: async () => {
        throw new Error('upstream timeout');
      },
    };

    const openService = makeService({ provider: erroringProvider });
    const open = await openService.screenAddress('GANYWALLETOPEN');
    expect(open.allowed).toBe(true);
    expect(open.providerError).toBe('upstream timeout');
    expect(open.riskLevel).toBe(RISK_LEVEL.UNKNOWN);

    const closedService = makeService({ provider: erroringProvider, failClosed: true });
    const closed = await closedService.screenAddress('GANYWALLETCLOSED');
    expect(closed.allowed).toBe(false);
    expect(closed.status).toBe(ACCOUNT_STATUS.PENDING_REVIEW);

    const audit = closedService.getAuditTrail('GANYWALLETCLOSED');
    expect(audit[0].eventType).toBe(EVENT_TYPE.PROVIDER_ERROR);
  });

  test('addresses are normalized (case-insensitive) so middleware lookups always agree', async () => {
    const service = makeService();
    await service.screenAddress('gbadbadaddressaaaa'); // lowercase input
    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(true);
    expect(service.isBlocked('gbadbadaddressaaaa')).toBe(true);
  });
});

describe('sanctionsBlock middleware', () => {
  test('returns 403 ACCOUNT_BLOCKED for a blocked wallet on req.user', async () => {
    const service = makeService();
    await service.screenAddress('GBADBADADDRESSAAAA');

    const app = express();
    app.use((req, _res, next) => {
      req.user = { publicKey: 'GBADBADADDRESSAAAA', tier: 'bronze' };
      next();
    });
    app.use(createSanctionsBlockMiddleware({ service }));
    app.get('/protected', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/protected');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('ACCOUNT_BLOCKED');
  });

  test('passes through clean wallets', async () => {
    const service = makeService();
    await service.screenAddress('GCLEAN777');

    const app = express();
    app.use((req, _res, next) => {
      req.user = { publicKey: 'GCLEAN777', tier: 'bronze' };
      next();
    });
    app.use(createSanctionsBlockMiddleware({ service }));
    app.get('/protected', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/protected');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('passes through unauthenticated requests (no req.user)', async () => {
    const service = makeService();
    const app = express();
    app.use(createSanctionsBlockMiddleware({ service }));
    app.get('/public', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/public');
    expect(res.status).toBe(200);
  });
});

describe('sanctionsCompliance routes', () => {
  let service;
  let app;

  beforeEach(async () => {
    service = makeService();
    await service.screenAddress('GBADBADADDRESSAAAA');

    app = express();
    app.use(express.json());
    app.set('sanctionsScreeningService', service);
    app.use('/api/compliance/sanctions', createSanctionsComplianceRoutes());
  });

  test('GET /queue lists open review tickets', async () => {
    const res = await request(app).get('/api/compliance/sanctions/queue');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].walletAddress).toBe('GBADBADADDRESSAAAA');
    expect(res.body.data[0].status).toBe(REVIEW_STATUS.OPEN);
  });

  test('POST /:address/false-positive clears the ticket and unblocks the wallet', async () => {
    const res = await request(app)
      .post('/api/compliance/sanctions/GBADBADADDRESSAAAA/false-positive')
      .send({
        reviewedBy: 'officer@compliance',
        decisionNotes: 'Confirmed homonym',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(ACCOUNT_STATUS.ACTIVE);

    expect(service.isBlocked('GBADBADADDRESSAAAA')).toBe(false);
  });

  test('POST /:address/false-positive requires reviewedBy', async () => {
    const res = await request(app)
      .post('/api/compliance/sanctions/GBADBADADDRESSAAAA/false-positive')
      .send({});
    expect(res.status).toBe(400);
  });

  test('GET /:address/audit returns the chronological audit trail', async () => {
    const res = await request(app).get(
      '/api/compliance/sanctions/GBADBADADDRESSAAAA/audit'
    );
    expect(res.status).toBe(200);
    const events = res.body.data.map((row) => row.eventType);
    expect(events).toContain(EVENT_TYPE.SCREEN_FLAGGED);
    expect(events).toContain(EVENT_TYPE.BLOCKED);
  });

  test('POST /:address/false-positive returns 409 when wallet is not blocked', async () => {
    // Already cleared.
    await service.markFalsePositive({
      walletAddress: 'GBADBADADDRESSAAAA',
      reviewedBy: 'officer@compliance',
    });

    const res = await request(app)
      .post('/api/compliance/sanctions/GBADBADADDRESSAAAA/false-positive')
      .send({ reviewedBy: 'officer@compliance' });
    expect(res.status).toBe(409);
  });
});
