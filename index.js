const dotenv = require('dotenv');
const { initTracing } = require('./src/utils/opentelemetry');

dotenv.config();
initTracing({ serviceName: 'substream-protocol-backend', serviceVersion: '1.0.0' });

const express = require('express');
const cors = require('cors');
const promClient = require('prom-client');

// Initialize Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Custom metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Business metrics
const totalMrrProcessed = new promClient.Gauge({
  name: 'total_mrr_processed_today',
  help: 'Total Monthly Recurring Revenue processed today',
  registers: [register],
});

// Soroban indexer lag
const sorobanIndexerLag = new promClient.Gauge({
  name: 'soroban_indexer_ledger_lag',
  help: 'Number of ledgers the indexer is behind the Stellar network',
  registers: [register],
});

// Database connections
const activeDbConnections = new promClient.Gauge({
  name: 'database_connections_active',
  help: 'Number of active database connections',
  registers: [register],
});

// Initialize structured logging and error tracking
const { logger, requestTracingMiddleware } = require('./src/utils/logger');
const { errorTracking } = require('./src/utils/errorTracking');

// Initialize error tracking
errorTracking.initialize();

// Initialize Vault service if enabled
const { getVaultService, resetVaultService } = require('./src/services/vaultService');
let vaultService = null;

if (process.env.VAULT_ENABLED === 'true') {
  vaultService = getVaultService({
    vaultAddr: process.env.VAULT_ADDR || 'http://vault:8200',
    vaultRole: process.env.VAULT_ROLE || 'substream-backend',
    authPath: process.env.VAULT_AUTH_PATH || 'auth/kubernetes',
    secretPath: process.env.VAULT_SECRET_PATH || 'secret/data/substream',
    dbPath: process.env.VAULT_DB_PATH || 'database/creds/substream-role'
  });
  console.log('[Vault] Vault integration enabled');
}

// SIGHUP signal handler for hot-reloading secrets
if (process.env.VAULT_ENABLED === 'true' && vaultService) {
  process.on('SIGHUP', async () => {
    console.log('[Vault] Received SIGHUP signal, reloading secrets...');
    try {
      await vaultService.reloadSecrets();
      console.log('[Vault] Successfully reloaded secrets on SIGHUP');
    } catch (error) {
      console.error('[Vault] Failed to reload secrets on SIGHUP:', error.message);
    }
  });
}

// Graceful shutdown handler
const cleanup = async () => {
  console.log('[Shutdown] Cleaning up resources...');
  if (vaultService) {
    try {
      await vaultService.cleanup();
      console.log('[Vault] Vault service cleaned up');
    } catch (error) {
      console.error('[Vault] Error during cleanup:', error.message);
    }
  }
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

const { AppDatabase } = require('./src/db/appDatabase');
const { loadConfig } = require('./src/config');
const { CdnTokenService, TokenValidationError } = require('./src/services/cdnTokenService');
const { CreatorActionService } = require('./src/services/creatorActionService');
const { CreatorAuditLogService } = require('./src/services/creatorAuditLogService');
const { CreatorAuthService } = require('./src/services/creatorAuthService');
const { SorobanSubscriptionVerifier } = require('./src/services/sorobanSubscriptionVerifier');
const EnhancedSorobanService = require('./services/enhancedSorobanService');
const EndpointMonitoringService = require('./services/endpointMonitoringService');
const { createEndpointMonitoringMiddleware, createErrorMonitoringMiddleware, addRequestStartTime } = require('./middleware/endpointMonitoring');
const { SubscriptionService } = require('./src/services/subscriptionService');
const { SubscriptionExpiryChecker } = require('./src/services/subscriptionExpiryChecker');
const { IPIntelligenceService } = require('./src/services/ipIntelligenceService');
const { IPBlockingService } = require('./src/services/ipBlockingService');
const { IPMonitoringService } = require('./src/services/ipMonitoringService');
const { IPIntelligenceMiddleware } = require('./src/middleware/ipIntelligenceMiddleware');
const { BehavioralBiometricService } = require('./src/services/behavioralBiometricService');
const { BotDetectionClassifier } = require('./src/services/botDetectionClassifier');
const VideoProcessingWorker = require('./src/services/videoProcessingWorker');
const { BackgroundWorkerService } = require('./src/services/backgroundWorkerService');
const { GlobalStatsService } = require('./src/services/globalStatsService');
const GlobalStatsWorker = require('./src/services/globalStatsWorker');
const CollaborationRevenueService = require('./services/collaborationRevenueService');
const CollaborationWatchTimeMiddleware = require('./middleware/collaborationWatchTime');
const createVideoRoutes = require('./routes/video');
const createGlobalStatsRouter = require('./routes/globalStats');
const createDeviceRoutes = require('./routes/device');
const createSwaggerRoutes = require('./routes/swagger');
const createCollaborationRoutes = require('./routes/collaborations');
const { buildAuditLogCsv } = require('./src/utils/export/auditLogCsv');
const { buildAuditLogPdf } = require('./src/utils/export/auditLogPdf');
const { getRequestIp } = require('./src/utils/requestIp');
const { getRedisClient, closeRedisClient } = require('./src/config/redis');
const { createRateLimiter } = require('./middleware/rateLimiter');
const createPrivacyRoutes = require('./routes/privacy');
const createReconciliationRoutes = require('./routes/admin/reconciliation');
const { setupApolloServer } = require('./src/graphql');


// Initialize payload size limit middleware
const { PayloadSizeLimitMiddleware } = require('./src/middleware/payloadSizeLimit');
const { GraphQLPayloadLimitMiddleware } = require('./src/middleware/graphqlPayloadLimit');

// Tier middleware — attaches req.user.tier to every request
const { attachTier } = require('./middleware/tierAuth');
const { MerchantCorsMiddleware } = require('./src/middleware/merchantCorsMiddleware');

/**
 * Create the Express application with injectable services for testing.
 *
 * @param {object} [dependencies={}] Optional service overrides.
 * @returns {import('express').Express}
 */
async function createApp(dependencies = {}) {
  const app = express();
  const config = dependencies.config || await loadConfig(process.env, vaultService);
  const database = dependencies.database || new AppDatabase(config.database.filename);
  const cronService = require('./services/cronService');
  cronService.setDatabase(database);
  const auditLogService =
    dependencies.auditLogService || new CreatorAuditLogService(database);
  const creatorActionService =
    dependencies.creatorActionService ||
    new CreatorActionService(database, auditLogService);
  const creatorAuthService =
    dependencies.creatorAuthService || new CreatorAuthService(config);
  const subscriptionVerifier =
    dependencies.subscriptionVerifier || new SorobanSubscriptionVerifier(config);
  
  // Initialize enhanced Soroban service with circuit breaker
  const enhancedSorobanService = 
    dependencies.enhancedSorobanService || new EnhancedSorobanService(config);
  app.set('enhancedSorobanService', enhancedSorobanService);
  
  // Initialize endpoint monitoring service
  const endpointMonitoringService = 
    dependencies.endpointMonitoringService || new EndpointMonitoringService(config);
  app.set('endpointMonitoringService', endpointMonitoringService);
  const tokenService = dependencies.tokenService || new CdnTokenService(config);

  // ── Global middleware ──────────────────────────────────────────────────────
  const merchantCors = new MerchantCorsMiddleware(database);
  app.use(cors(merchantCors.corsOptionsDelegate()));
  
  // Initialize payload size limit middleware with security-focused configuration
  const payloadSizeLimit = new PayloadSizeLimitMiddleware({
    jsonLimit: process.env.PAYLOAD_JSON_LIMIT || 1024 * 1024, // 1MB for JSON
    urlencodedLimit: process.env.PAYLOAD_URLENCODED_LIMIT || 1024 * 1024, // 1MB for URL-encoded
    textLimit: process.env.PAYLOAD_TEXT_LIMIT || 1024 * 1024, // 1MB for text
    rawLimit: process.env.PAYLOAD_RAW_LIMIT || 10 * 1024 * 1024, // 10MB for raw/binary
    graphqlLimit: process.env.PAYLOAD_GRAPHQL_LIMIT || 2 * 1024 * 1024, // 2MB for GraphQL
    fileLimit: process.env.PAYLOAD_FILE_LIMIT || 50 * 1024 * 1024, // 50MB for file uploads
    strictMode: process.env.NODE_ENV === 'production', // Enable strict mode in production
    enableLogging: process.env.PAYLOAD_LOGGING !== 'false' // Enable logging by default
  });
  
  // Initialize GraphQL payload limit middleware
  const graphqlPayloadLimit = new GraphQLPayloadLimitMiddleware({
    maxQueryLength: parseInt(process.env.GRAPHQL_MAX_QUERY_LENGTH) || 10000,
    maxVariablesSize: parseInt(process.env.GRAPHQL_MAX_VARIABLES_SIZE) || 1024 * 1024,
    maxQueryDepth: parseInt(process.env.GRAPHQL_MAX_QUERY_DEPTH) || 10,
    maxComplexity: parseInt(process.env.GRAPHQL_MAX_COMPLEXITY) || 1000,
    enableLogging: process.env.GRAPHQL_LOGGING !== 'false'
  });
  
  // Apply payload size limits before body parsing
  app.use(payloadSizeLimit.middleware());
  
  // Apply GraphQL-specific limits for GraphQL endpoints
  app.use('/graphql', graphqlPayloadLimit.middleware());
  
  // Remove the default express.json() and express.urlencoded() as they are now handled by the payload limit middleware
  // app.use(express.json({ limit: '10mb' }));
  // app.use(express.urlencoded({ extended: true }));

  // Request tracing middleware must be registered early for trace propagation
  app.use(requestTracingMiddleware);

  // Add request start time for accurate monitoring
  app.use(addRequestStartTime);

  // Endpoint monitoring middleware
  app.use(createEndpointMonitoringMiddleware(endpointMonitoringService));

  // Prometheus metrics middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = (Date.now() - start) / 1000;
      const route = req.route ? req.route.path : req.path;
      httpRequestDuration
        .labels(req.method, route, res.statusCode.toString())
        .observe(duration);
      httpRequestsTotal
        .labels(req.method, route, res.statusCode.toString())
        .inc();
    });
    next();
  });

  // Attach req.user = { address, tier } to every request.
  // Never rejects — unauthenticated requests get tier = 'guest'.
  app.use(attachTier);
  // Notification and email utilities
  const { NotificationService } = require('./src/services/notificationService');
  const { sendEmail } = require('./src/utils/email');
  const notificationService = dependencies.notificationService || new NotificationService(database);

  const subscriptionService =
    dependencies.subscriptionService || new SubscriptionService({
      database,
      auditLogService,
      notificationService,
      emailUtil: { sendEmail },
    });
  dependencies.subscriptionService || new SubscriptionService({ database, auditLogService, config });
  const subscriptionExpiryChecker =
    dependencies.subscriptionExpiryChecker ||
    new SubscriptionExpiryChecker({
      database,
      lowBalanceEmailService: dependencies.lowBalanceEmailService,
    });

  // Initialize background worker service for async processing
  const backgroundWorker = dependencies.backgroundWorker || new BackgroundWorkerService(config.rabbitmq);

  // Initialize federation service for ActivityPub integration
  const federationService = dependencies.federationService || new FederationService(config, database, backgroundWorker);

  // Initialize federation worker for background processing
  const federationWorker = dependencies.federationWorker || new FederationWorker(config, database, federationService);

  // expose the service on the express app so external routers can access it
  app.set('database', database);
  app.set('subscriptionService', subscriptionService);
  app.set('subscriptionExpiryChecker', subscriptionExpiryChecker);
  app.set('backgroundWorker', backgroundWorker);
  app.set('federationService', federationService);
  app.set('federationWorker', federationWorker);

  // Initialize and start AML scanner if enabled
  let amlScannerWorker = null;
  if (config.aml && config.aml.enabled) {
    amlScannerWorker = dependencies.amlScannerWorker || new AMLScannerWorker(database, config.aml);
    app.set('amlScannerWorker', amlScannerWorker);

    amlScannerWorker.start().catch(error => {
      console.error('Failed to start AML scanner worker:', error);
    });
  }



    // Start federation worker if ActivityPub is enabled
    if (config.activityPub?.enabled !== false) {
      const federationWorker = dependencies.federationWorker || new FederationWorker(database, config);
      federationWorker.start().catch(error => {
        console.error('Failed to start federation worker:', error);
      });
    }

    // Start leaderboard worker if enabled
    if (config.leaderboard?.enabled !== false) {
      const leaderboardWorker = dependencies.leaderboardWorker || new LeaderboardWorker(config, database, getRedisClient(), EngagementLeaderboardService);
      leaderboardWorker.start().catch(error => {
        console.error('Failed to start leaderboard worker:', error);
      });

      console.log('IP Intelligence services initialized');
    }

    const dayInMs = 24 * 60 * 60 * 1000;
    const subscriptionExpiryCheckerInterval = setInterval(async () => {
      try {
        await subscriptionExpiryChecker.runDailyCheck();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(
          'Subscription expiry checker failed:',
          error && error.message ? error.message : error,
        );
      }
    }, dayInMs);

    if (typeof subscriptionExpiryCheckerInterval.unref === 'function') {
      subscriptionExpiryCheckerInterval.unref();
    }

    app.set('subscriptionExpiryCheckerInterval', subscriptionExpiryCheckerInterval);

    const videoWorker = dependencies.videoWorker || new VideoProcessingWorker(config, database);

    // Initialize social token gating service and middleware
    const socialTokenService = dependencies.socialTokenService || new SocialTokenGatingService(config, database, getRedisClient());
    const socialTokenMiddleware = dependencies.socialTokenMiddleware || new SocialTokenGatingMiddleware(socialTokenService, database, getRedisClient());

    // Initialize collaboration revenue service and watch time middleware
    const collaborationService = dependencies.collaborationService || new CollaborationRevenueService(config, database, getRedisClient());
    const collaborationWatchTimeMiddleware = dependencies.collaborationWatchTimeMiddleware || new CollaborationWatchTimeMiddleware(collaborationService, database);

    // Initialize global stats service and worker
    const globalStatsService = dependencies.globalStatsService || new GlobalStatsService(database);
    const globalStatsWorker = dependencies.globalStatsWorker || new GlobalStatsWorker(database, {
      refreshInterval: process.env.GLOBAL_STATS_REFRESH_INTERVAL ? parseInt(process.env.GLOBAL_STATS_REFRESH_INTERVAL) : 60000,
      initialDelay: process.env.GLOBAL_STATS_INITIAL_DELAY ? parseInt(process.env.GLOBAL_STATS_INITIAL_DELAY) : 5000
    });

    // Initialize leaderboard service and worker
    const redisClient = getRedisClient();
    const leaderboardService = dependencies.leaderboardService || new EngagementLeaderboardService(config, database, redisClient);
    const leaderboardWorker = dependencies.leaderboardWorker || new LeaderboardWorker(config, database, redisClient, leaderboardService);

    // Initialize subdomain and SSL services
    const subdomainService = dependencies.subdomainService || new SubdomainService(database, config);
    const sslCertificateService = dependencies.sslCertificateService || new SslCertificateService(config);
    const subdomainMiddleware = dependencies.subdomainMiddleware || new SubdomainMiddleware(database, config);

    // expose services on the express app so external routers can access them
    app.set('subscriptionService', subscriptionService);
    app.set('subscriptionExpiryChecker', subscriptionExpiryChecker);
    app.set('backgroundWorker', backgroundWorker);
    app.set('globalStatsService', globalStatsService);
    app.set('globalStatsWorker', globalStatsWorker);
    app.set('leaderboardService', leaderboardService);
    app.set('leaderboardWorker', leaderboardWorker);
    app.set('socialTokenService', socialTokenService);
    app.set('socialTokenMiddleware', socialTokenMiddleware);
    app.set('subdomainService', subdomainService);
    app.set('sslCertificateService', sslCertificateService);
    app.set('collaborationService', collaborationService);
    app.set('collaborationWatchTimeMiddleware', collaborationWatchTimeMiddleware);

    // Initialize and start predictive churn analysis worker
    const { PredictiveChurnAnalysisWorker } = require('./src/services/predictiveChurnAnalysisWorker');
    const churnAnalysisWorker = dependencies.churnAnalysisWorker || new PredictiveChurnAnalysisWorker(database, {
      checkInterval: process.env.CHURN_ANALYSIS_INTERVAL ? parseInt(process.env.CHURN_ANALYSIS_INTERVAL) : 3600000,
    });
    app.set('churnAnalysisWorker', churnAnalysisWorker);
    churnAnalysisWorker.start().catch(error => {
      console.error('Failed to start PredictiveChurnAnalysisWorker:', error);
    });

    // Start global stats worker
    globalStatsWorker.start().catch(error => {
      console.error('Failed to start global stats worker:', error);
    });

    // Start federation worker if ActivityPub is enabled
  if (config.activityPub?.enabled !== false) {
    federationWorker.start().catch(error => {
      console.error('Failed to start federation worker:', error);
    });
  }



    // Subscription events webhook
    app.use('/api/subscription', require('./routes/subscription'));
    // Payouts API
    app.use('/api/payouts', require('./routes/payouts'));
    // Sandbox API
    app.use('/api/sandbox', require('./routes/sandbox'));

    // Tax reporting API
    app.use('/tax', require('./routes/tax'));

    // Social token gating endpoints
    app.use('/api/social-token', createSocialTokenRoutes());

    // Global stats endpoints
    app.use('/api/global-stats', createGlobalStatsRouter({ database, globalStatsService }));

    // Creator collaboration endpoints
    app.use('/api/collaborations', createCollaborationRoutes());

    // Privacy preference endpoints
    app.use('/api/v1/users', createPrivacyRoutes({ database }));

    // Subdomain management endpoints
    app.use('/api/subdomains', createSubdomainRoutes({ database, config, subdomainService, sslCertificateService }));

    // Price feed endpoints
    const createPriceRouter = require('./routes/price');
    app.use('/api/price-feed', createPriceRouter());

    // Social token gating endpoints
    app.use('/api/social-token', createSocialTokenRoutes());

    app.use((req, res, next) => {
      req.config = config;
      req.database = database;
      req.subscriptionVerifier = subscriptionVerifier;
      next();
    });

    // Leaky-bucket rate limiting per wallet address (requires Redis).
    if (dependencies.rateLimiter) {
      app.use('/api', dependencies.rateLimiter);
    } else if (process.env.REDIS_URL || process.env.REDIS_HOST) {
      app.use('/api', createRateLimiter({
        redis: getRedisClient(),
        bucketCapacity: Number(process.env.RATE_LIMIT_CAPACITY || 60),
        leakRatePerSecond: Number(process.env.RATE_LIMIT_LEAK_RATE || 1),
        blockDurationSeconds: Number(process.env.RATE_LIMIT_BLOCK_SECONDS || 300),
        sybilThreshold: Number(process.env.SYBIL_THRESHOLD || 3),
      }));
    }

    // ── Health / root ──────────────────────────────────────────────────────────
    app.get('/', (req, res) => {
      res.json({
        project: 'SubStream Protocol',
        status: 'Active',
        contract: config.soroban.contractId,
        version: '1.0.0',
        endpoints: {
          auth: '/auth',
          content: '/content',
          analytics: '/analytics',
          storage: '/storage',
          posts: '/posts',
          health: '/health',
        },
      });
    });

    app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        services: {
          auth: 'active',
          content: 'active',
          analytics: 'active',
          storage: 'active',
          posts: 'active',
        },
      });
    });

    // ── Auth routes ────────────────────────────────────────────────────────────
    app.use('/auth', require('./routes/auth'));
    app.use('/auth', require('./routes/stellarAuth'));

    // ── SEP-12 Customer Identification (KYC) routes ─────────────────────────────
    app.use('/sep12', require('./routes/sep12'));

    // ── SumSub KYC Webhook ───────────────────────────────────────────────────────
    app.use('/webhooks', require('./routes/sumsubWebhook'));

    // ── SEP-24 Interactive Flow routes ───────────────────────────────────────────
    app.use('/sep24', require('./routes/sep24'));

    // ── Global Reputation System routes ────────────────────────────────────────
    app.use('/api/reputation', require('./routes/globalReputation'));

    // ── Soroban Health and Circuit Breaker routes ───────────────────────────────
    app.use('/api/soroban', require('./routes/sorobanHealth'));

    // ── Endpoint Monitoring and Alerting routes ─────────────────────────────────
    app.use('/api/monitoring', require('./routes/monitoring'));

    // ── Tier-gated content routes ──────────────────────────────────────────────
    // attachTier already ran globally; routes/content.js uses requireTier
    // on individual endpoints as needed.
    app.use('/content', require('./routes/content'));

    // ── Other feature routes ───────────────────────────────────────────────────
    app.use('/analytics', require('./routes/analytics'));
    app.use('/storage', require('./routes/storage'));
    app.use('/posts', require('./routes/posts'));

    // ── Usage Quota and Monetization routes ───────────────────────────────────────
    app.use('/api/v1/usage-quota', require('./routes/usageQuota'));

    // ── CDN token endpoints ────────────────────────────────────────────────────
    app.post('/api/cdn/token', async (req, res) => {
      const requiredFields = ['walletAddress', 'creatorAddress', 'contentId', 'segmentPath'];
      const missingFields = requiredFields.filter((field) => !req.body?.[field]);

      if (missingFields.length > 0) {
        return res.status(400).json({ error: 'Missing required fields', missingFields });
      }

      try {
        const accessRequest = {
          walletAddress: req.body.walletAddress,
          creatorAddress: req.body.creatorAddress,
          contentId: req.body.contentId,
          segmentPath: req.body.segmentPath,
        };

        // Check if content requires social token gating
        const socialTokenService = req.app.get('socialTokenService');
        let socialTokenAccess = null;

        if (socialTokenService) {
          socialTokenAccess = await socialTokenService.checkContentAccess(
            accessRequest.walletAddress,
            accessRequest.contentId
          );

          // If social token gating is required and access is denied, return error
          if (socialTokenAccess.requiresToken && !socialTokenAccess.hasAccess) {
            return res.status(403).json({
              error: 'Social token requirements not met',
              code: 'INSUFFICIENT_SOCIAL_TOKENS',
              details: {
                assetCode: socialTokenAccess.assetCode,
                assetIssuer: socialTokenAccess.assetIssuer,
                minimumBalance: socialTokenAccess.minimumBalance,
                reason: socialTokenAccess.reason
              }
            });
          }
        }

        // Verify subscription (existing logic)
        const subscription = await subscriptionVerifier.verifySubscription(accessRequest);

        if (!subscription.active) {
          return res.status(403).json({
            error: 'Active on-chain subscription required',
            creatorAddress: accessRequest.creatorAddress,
            contentId: accessRequest.contentId,
          });
        }

        // Issue token with social token metadata if applicable
        const tokenData = {
          walletAddress: accessRequest.walletAddress,
          creatorAddress: accessRequest.creatorAddress,
          contentId: accessRequest.contentId,
          segmentPath: accessRequest.segmentPath,
          subscription,
        };

        // Add social token session info if required
        if (socialTokenAccess && socialTokenAccess.requiresToken && socialTokenAccess.hasAccess) {
          const sessionData = await socialTokenService.startBalanceReverification(
            null, // Will generate session ID
            accessRequest.walletAddress,
            accessRequest.contentId
          );
          tokenData.socialTokenSession = {
            sessionId: sessionData.sessionId,
            verificationInterval: socialTokenAccess.verificationInterval,
            assetInfo: {
              code: socialTokenAccess.assetCode,
              issuer: socialTokenAccess.assetIssuer,
              minimumBalance: socialTokenAccess.minimumBalance
            }
          };
        }

        const issuedToken = tokenService.issueToken(tokenData);

        return res.status(200).json({
          token: issuedToken.token,
          tokenType: 'Bearer',
          expiresInSeconds: issuedToken.expiresInSeconds,
          expiresAt: issuedToken.expiresAt,
          playbackUrl: tokenService.buildPlaybackUrl({
            contentId: accessRequest.contentId,
            segmentPath: accessRequest.segmentPath,
            token: issuedToken.token,
          }),
          socialTokenSession: tokenData.socialTokenSession || null
        });
      } catch (error) {
        return res.status(error.statusCode || 503).json({
          error: error.message || 'Unable to verify subscription',
        });
      }
    });

    app.all('/api/cdn/validate', (req, res) => {
      const token = extractToken(req);

      if (!token) {
        return res.status(400).json({ error: 'Missing CDN access token' });
      }

      try {
        const decoded = tokenService.verifyToken(token, {
          contentId: req.query.contentId || req.body?.contentId,
          segmentPath: req.query.segmentPath || req.body?.segmentPath,
        });

        return res.status(200).json({
          valid: true,
          expiresAt: new Date(decoded.exp * 1000).toISOString(),
          claims: {
            walletAddress: decoded.sub,
            creatorAddress: decoded.creatorAddress,
            contentId: decoded.contentId,
            segmentPath: decoded.segmentPath,
          },
        });
      } catch (error) {
        const statusCode = error instanceof TokenValidationError ? 401 : 400;
        return res.status(statusCode).json({
          valid: false,
          error: error.message || 'Invalid CDN access token',
        });
      }
    });

    // ── Creator action endpoints ───────────────────────────────────────────────
    app.patch(
      '/api/creator/flow-rate',
      requireCreatorAuth(creatorAuthService),
      async (req, res) => {
        if (!isPresent(req.body?.flowRate)) {
          return res.status(400).json({ success: false, error: 'flowRate is required' });
        }
        try {
          const result = creatorActionService.updateFlowRate({
            creatorId: req.creator.id,
            flowRate: normalizeScalar(req.body.flowRate),
            currency: isPresent(req.body.currency) ? String(req.body.currency) : null,
            ipAddress: getRequestIp(req),
          });
          return res.status(200).json({ success: true, data: result });
        } catch (error) {
          return handleActionError(res, error);
        }
      },
    );

    app.patch(
      '/api/creator/videos/:videoId/visibility',
      requireCreatorAuth(creatorAuthService),
      async (req, res) => {
        if (!isPresent(req.body?.visibility)) {
          return res.status(400).json({ success: false, error: 'visibility is required' });
        }
        try {
          const result = creatorActionService.updateVideoVisibility({
            creatorId: req.creator.id,
            videoId: req.params.videoId,
            visibility: String(req.body.visibility),
            ipAddress: getRequestIp(req),
          });
          return res.status(200).json({ success: true, data: result });
        } catch (error) {
          return handleActionError(res, error);
        }
      },
    );

    app.patch(
      '/api/creator/coop-splits/:splitId',
      requireCreatorAuth(creatorAuthService),
      async (req, res) => {
        if (!req.body?.splits || !Array.isArray(req.body.splits) || req.body.splits.length === 0) {
          return res
            .status(400)
            .json({ success: false, error: 'splits must be a non-empty array' });
        }
        try {
          const result = creatorActionService.updateCoopSplit({
            creatorId: req.creator.id,
            splitId: req.params.splitId,
            splits: req.body.splits,
            ipAddress: getRequestIp(req),
          });
          return res.status(200).json({ success: true, data: result });
        } catch (error) {
          return handleActionError(res, error);
        }
      },
    );

    app.get(
      '/api/creator/audit-log',
      requireCreatorAuth(creatorAuthService),
      (req, res) => {
        const logs = auditLogService.listByCreatorId(req.creator.id);
        return res.status(200).json({ success: true, data: logs });
      },
    );

    app.get(
      '/api/creator/audit-log/export',
      requireCreatorAuth(creatorAuthService),
      (req, res) => {
        const format = String(req.query.format || '').toLowerCase();

        if (!['csv', 'pdf'].includes(format)) {
          return res.status(400).json({ success: false, error: 'format must be one of: csv, pdf' });
        }

        const logs = auditLogService.listByCreatorId(req.creator.id);
        const exportTimestamp = new Date().toISOString();

        if (format === 'csv') {
          const csv = buildAuditLogCsv(logs);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="creator-audit-log-${req.creator.id}.csv"`,
          );
          return res.status(200).send(csv);
        }

        const pdf = buildAuditLogPdf({
          creatorId: req.creator.id,
          exportedAt: exportTimestamp,
          logs,
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="creator-audit-log-${req.creator.id}.pdf"`,
        );
        return res.status(200).send(pdf);
      }
    );

    app.get('/api/creator/:id/stats', (req, res) => {
      try {
        const creatorId = req.params.id;
        const subscriberCount = database.getCreatorSubscriberCount(creatorId);
        return res.status(200).json({ success: true, data: { creatorId, subscriberCount } });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message || 'Failed to fetch stats' });
      }
    });


        // ── Error handlers ─────────────────────────────────────────────────────────
        app.use(createErrorMonitoringMiddleware(endpointMonitoringService));
        app.use((err, req, res, next) => {
          console.error('Unhandled error:', err);
          res.status(500).json({ success: false, error: 'Internal server error' });
        });

        // Video routes
        app.use('/api/videos', createVideoRoutes(config, database, videoWorker));

        // Merchant treasury routes
        app.use('/api/v1/merchants', require('./routes/merchants'));

        // Device fingerprinting endpoints for fraud prevention
        if (process.env.REDIS_URL || process.env.REDIS_HOST) {
          const deviceService = new DeviceFingerprintService(getRedisClient());
          app.set('deviceFingerprintService', deviceService);
          app.use('/api/device', createDeviceRoutes);
        }

        // API Documentation with Swagger UI
        app.use('/api/docs', createSwaggerRoutes);

        // IP Intelligence management routes
          if (ipIntelligenceService) {
            app.use('/api/ip-intelligence', createIPIntelligenceRoutes({
              ipIntelligenceService,
              ipBlockingService,
              ipMonitoringService
            }));
          }

          // Behavioral biometric management routes
          if (behavioralService) {
            app.use('/api/behavioral', createBehavioralBiometricRoutes({
              behavioralService
            }));
          }

          // 404 handler
          app.use((req, res) => {
            res.status(404).json({ success: false, error: 'Endpoint not found' });
          });

          // Health check endpoint
          app.get('/health', async (req, res) => {
            const health = {
              status: 'Healthy',
              timestamp: new Date().toISOString(),
              version: '1.0.0',
              services: {
                database: 'Unknown',
                redis: 'Unknown',
                rabbitmq: 'Unknown',
                stellar: 'Unknown',
                ipIntelligence: 'Unknown',
                behavioralBiometric: 'Unknown'
              },
            };

            let isDegraded = false;

            // Check Database
            try {
              database.db.prepare('SELECT 1').get();
              health.services.database = 'Connected';
            } catch (error) {
              health.services.database = 'Offline';
              isDegraded = true;
            }

            // Check Redis
            try {
              if (process.env.REDIS_URL || process.env.REDIS_HOST) {
                const redisClient = getRedisClient();
                const ping = await redisClient.ping();
                health.services.redis = ping === 'PONG' ? 'Connected' : 'Offline';
                if (ping !== 'PONG') isDegraded = true;
              } else {
                health.services.redis = 'Not Configured';
              }
            } catch (error) {
              health.services.redis = 'Offline';
              isDegraded = true;
            }

            // Check RabbitMQ
            try {
              if (backgroundWorker && backgroundWorker.rabbitmq) {
                const status = backgroundWorker.getStatus();
                health.services.rabbitmq = status.connected ? 'Connected' : 'Offline';
                if (!status.connected) isDegraded = true;
              } else {
                health.services.rabbitmq = 'Not Configured';
              }
            } catch (error) {
              health.services.rabbitmq = 'Offline';
              isDegraded = true;
            }

            // Check Stellar/Soroban
            try {
              if (subscriptionVerifier && subscriptionVerifier.server) {
                await subscriptionVerifier.server.getLatestLedger();
                health.services.stellar = 'Connected';
              } else {
                health.services.stellar = 'Not Configured';
              }
            } catch (error) {
              health.services.stellar = 'Offline';
              isDegraded = true;
            }

            // Check IP Intelligence
            try {
              if (ipIntelligenceService) {
                const stats = ipIntelligenceService.getServiceStats();
                health.services.ipIntelligence = 'Running';
              } else {
                health.services.ipIntelligence = 'Not Configured';
              }
            } catch (error) {
              health.services.ipIntelligence = 'Error';
              isDegraded = true;
            }

            // Check Behavioral Biometric
            try {
              if (behavioralService) {
                const stats = behavioralService.getServiceStats();
                health.services.behavioralBiometric = 'Running';
              } else {
                health.services.behavioralBiometric = 'Not Configured';
              }
            } catch (error) {
              health.services.behavioralBiometric = 'Error';
              isDegraded = true;
            }

            if (isDegraded) {
              health.status = 'Degraded';
            }

            return res.status(isDegraded ? 200 : 200).json(health); // Reporting degraded status still returns 200 for status page transparency
          });

          app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

          // Global error handler with Sentry integration
          app.use((err, req, res, next) => {
            // Log error with structured logging
            const errorContext = {
              traceId: req.logger?.fields?.traceId,
              method: req.method,
              path: req.path,
              walletAddress: req.user?.publicKey || req.body?.walletAddress,
              endpoint: req.originalUrl,
            };

            // Capture with Sentry
            errorTracking.captureException(err, errorContext);

            // Return error response
            res.status(err.statusCode || err.status || 500).json({
              success: false,
              error: process.env.NODE_ENV === 'production'
                ? 'Internal server error'
                : err.message,
              ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
            });
          });

  return app;
}


// ── Private helpers ────────────────────────────────────────────────────────

function extractToken(req) {
        const authHeader = req.headers.authorization || '';
        if (authHeader.startsWith('Bearer ')) return authHeader.slice('Bearer '.length).trim();
        return req.query.token || req.body?.token || null;
      }

function requireCreatorAuth(creatorAuthService) {
        return (req, res, next) => {
          const token = extractToken(req);
          if (!token) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
          }
          try {
            req.creator = creatorAuthService.verifyToken(token);
            return next();
          } catch (error) {
            return res.status(401).json({ success: false, error: error.message });
          }
        };
      }

function normalizeScalar(value) {
        return String(value).trim();
      }

function isPresent(value) {
        return value !== undefined && value !== null && String(value).trim() !== '';
      }

function handleActionError(res, error) {
        return res
          .status(error.statusCode || 500)
          .json({ success: false, error: error.message || 'Request failed' });
      }

// ── Bootstrap ──────────────────────────────────────────────────────────────

if (require.main === module) {
      // Async bootstrap to initialize Apollo Server and Vault
      (async () => {
        try {
          // Initialize Vault if enabled
          if (vaultService) {
            try {
              await vaultService.initialize();
              console.log('[Vault] Vault service initialized successfully');
            } catch (vaultError) {
              console.error('[Vault] Vault initialization failed, continuing with environment variables:', vaultError.message);
            }
          }

          // Create app with Vault support
          const app = await createApp();
          const config = await loadConfig(process.env, vaultService);
          const port = config.port;

          // Setup GraphQL endpoint with Apollo Server
          const database = new AppDatabase(config.database.filename);
          await setupApolloServer(app, database);
          console.log('GraphQL endpoint available at /graphql');

          // Start Express server
          app.listen(port, () => console.log(`SubStream API running on port ${port}`));
        } catch (error) {
          console.error('Failed to start server:', error);
          process.exit(1);
        }
      })();
    }

    module.exports = app;
    module.exports.createApp = createApp;
