const NotificationService = require('./services/notificationService');
const EmailQueueService = require('./services/emailQueue');
const SESProvider = require('./services/emailProviders/SESProvider');
const SendGridProvider = require('./services/emailProviders/SendGridProvider');

// Mock BullMQ
jest.mock('bullmq', () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn().mockResolvedValue({
        id: 'mock-job-id',
        data: { type: 'sendEmail', data: {} },
        opts: {}
      }),
      getJob: jest.fn().mockResolvedValue({
        id: 'mock-job-id',
        getState: jest.fn().mockResolvedValue('completed'),
        progress: 100,
        data: { type: 'sendEmail', data: {} },
        timestamp: Date.now(),
        processedOn: Date.now(),
        finishedOn: Date.now(),
        returnvalue: { success: true, messageId: 'mock-message-id' }
      }),
      getJobs: jest.fn().mockResolvedValue([]),
      getWaiting: jest.fn().mockResolvedValue([]),
      getActive: jest.fn().mockResolvedValue([]),
      getCompleted: jest.fn().mockResolvedValue([]),
      getFailed: jest.fn().mockResolvedValue([]),
      getDelayed: jest.fn().mockResolvedValue([]),
      clean: jest.fn().mockResolvedValue(),
      pause: jest.fn().mockResolvedValue(),
      resume: jest.fn().mockResolvedValue(),
      close: jest.fn().mockResolvedValue(),
      on: jest.fn()
    })),
    Worker: jest.fn().mockImplementation(() => ({
      close: jest.fn().mockResolvedValue(),
      on: jest.fn()
    }))
  };
});

// Mock Redis
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    status: 'ready',
    quit: jest.fn().mockResolvedValue()
  }));
});

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  config: {
    update: jest.fn()
  },
  SES: jest.fn().mockImplementation(() => ({
    sendTemplatedEmail: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        MessageId: 'aws-ses-message-id'
      })
    }),
    sendEmail: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        MessageId: 'aws-ses-message-id'
      })
    }),
    getTemplate: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Template: {
          TemplateName: 'test-template',
          SubjectPart: 'Test Subject',
          TextPart: 'Test Text',
          HtmlPart: 'Test HTML',
          CreatedAt: new Date().toISOString()
        }
      })
    }),
    getSendQuota: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Max24HourSend: 1000,
        MaxSendRate: 10,
        SentLast24Hours: 100
      })
    })
  }))
}));

// Mock Axios for SendGrid
jest.mock('axios', () => {
  return jest.fn().mockImplementation(() => ({
    post: jest.fn().mockResolvedValue({
      headers: {
        'x-message-id': 'sendgrid-message-id',
        'x-request-id': 'sendgrid-request-id'
      },
      data: {}
    }),
    get: jest.fn().mockResolvedValue({
      data: {
        username: 'test-user',
        email: 'test@example.com',
        reputation: 95
      }
    }),
    interceptors: {
      response: {
        use: jest.fn()
      }
    }
  }));
});

describe('Email Notification Service', () => {
  let notificationService;
  let mockConfig;

  beforeEach(() => {
    mockConfig = {
      defaultProvider: 'ses',
      ses: {
        region: 'us-east-1',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
      },
      sendgrid: {
        apiKey: 'test-api-key'
      },
      redis: {
        host: 'localhost',
        port: 6379
      }
    };

    notificationService = new NotificationService(mockConfig);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Service Initialization', () => {
    it('should initialize with both providers', () => {
      expect(notificationService.getAvailableProviders()).toContain('ses');
      expect(notificationService.getAvailableProviders()).toContain('sendgrid');
      expect(notificationService.defaultProvider).toBe('ses');
    });

    it('should throw error when no providers configured', () => {
      expect(() => {
        new NotificationService({});
      }).toThrow('No email providers configured');
    });

    it('should initialize queue service', () => {
      expect(notificationService.queueService).toBeDefined();
      expect(notificationService.queueService.queueName).toBe('notification-queue');
    });
  });

  describe('Email Sending', () => {
    it('should queue email with default provider', async () => {
      const emailData = {
        to: 'test@example.com',
        from: 'noreply@example.com',
        subject: 'Test Email',
        templateId: 'test-template',
        templateData: { name: 'John' }
      };

      const result = await notificationService.sendEmail(emailData);

      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
      expect(result.provider).toBe('ses');
      expect(result.message).toBe('Email queued for processing');
    });

    it('should queue email with specified provider', async () => {
      const emailData = {
        to: 'test@example.com',
        from: 'noreply@example.com',
        subject: 'Test Email',
        templateId: 'test-template',
        templateData: { name: 'John' }
      };

      const result = await notificationService.sendEmail(emailData, { provider: 'sendgrid' });

      expect(result.success).toBe(true);
      expect(result.provider).toBe('sendgrid');
    });

    it('should throw error for invalid provider', async () => {
      const emailData = {
        to: 'test@example.com',
        from: 'noreply@example.com',
        subject: 'Test Email',
        templateId: 'test-template',
        templateData: { name: 'John' }
      };

      await expect(notificationService.sendEmail(emailData, { provider: 'invalid' }))
        .rejects.toThrow('Email provider not found: invalid');
    });

    it('should queue simple email', async () => {
      const emailData = {
        to: 'test@example.com',
        from: 'noreply@example.com',
        subject: 'Test Simple Email',
        text: 'This is a test email',
        html: '<p>This is a test email</p>'
      };

      const result = await notificationService.sendSimpleEmail(emailData);

      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
      expect(result.message).toBe('Simple email queued for processing');
    });

    it('should queue bulk email', async () => {
      const bulkData = {
        recipients: [
          { email: 'user1@example.com', templateData: { name: 'User 1' } },
          { email: 'user2@example.com', templateData: { name: 'User 2' } }
        ],
        from: 'noreply@example.com',
        subject: 'Bulk Email',
        templateId: 'bulk-template',
        templateData: { company: 'Test Corp' }
      };

      const result = await notificationService.sendBulkEmail(bulkData);

      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
      expect(result.totalRecipients).toBe(2);
      expect(result.message).toBe('Bulk email queued for processing');
    });
  });

  describe('Template Variable Mapping', () => {
    it('should apply template mappings', () => {
      notificationService.addTemplateMapping('welcome', {
        defaultVariables: {
          appName: 'Test App',
          supportEmail: 'support@test.com'
        }
      });

      const mapping = notificationService.getTemplateMapping('welcome');
      expect(mapping.defaultVariables.appName).toBe('Test App');
      expect(mapping.defaultVariables.supportEmail).toBe('support@test.com');
    });

    it('should remove template mapping', () => {
      notificationService.addTemplateMapping('test', { test: 'value' });
      expect(notificationService.getTemplateMapping('test')).toBeDefined();

      notificationService.removeTemplateMapping('test');
      expect(notificationService.getTemplateMapping('test')).toBeUndefined();
    });

    it('should process template variables', () => {
      notificationService.addTemplateMapping('welcome', {
        defaultVariables: {
          appName: 'Test App',
          currentYear: () => new Date().getFullYear()
        }
      });

      const emailData = {
        templateId: 'welcome',
        templateData: { name: 'John' }
      };

      const processed = notificationService.processTemplateVariables(emailData);

      expect(processed.templateData.appName).toBe('Test App');
      expect(processed.templateData.currentYear).toBe(new Date().getFullYear());
      expect(processed.templateData.name).toBe('John');
    });

    it('should apply global mappings', () => {
      const service = new NotificationService({
        ...mockConfig,
        globalTemplateMappings: {
          companyName: 'Test Company',
          website: 'https://test.com'
        }
      });

      const emailData = {
        templateData: { name: 'John' }
      };

      const processed = service.processTemplateVariables(emailData);

      expect(processed.templateData.companyName).toBe('Test Company');
      expect(processed.templateData.website).toBe('https://test.com');
      expect(processed.templateData.name).toBe('John');
    });
  });

  describe('Provider Management', () => {
    it('should switch provider successfully', () => {
      const result = notificationService.switchProvider('sendgrid');

      expect(result.success).toBe(true);
      expect(result.provider).toBe('sendgrid');
      expect(notificationService.defaultProvider).toBe('sendgrid');
    });

    it('should throw error when switching to invalid provider', () => {
      expect(() => {
        notificationService.switchProvider('invalid');
      }).toThrow('Email provider not found: invalid');
    });

    it('should get provider statistics', () => {
      const stats = notificationService.getProviderStats();
      
      expect(stats).toHaveProperty('ses');
      expect(stats).toHaveProperty('sendgrid');
      expect(stats.ses).toHaveProperty('name', 'SESProvider');
      expect(stats.sendgrid).toHaveProperty('name', 'SendGridProvider');
    });

    it('should get specific provider statistics', () => {
      const stats = notificationService.getProviderStats('ses');
      
      expect(stats).toHaveProperty('name', 'SESProvider');
      expect(stats).toHaveProperty('service', 'AWS SES');
    });

    it('should test provider connections', async () => {
      const results = await notificationService.testProviderConnection();

      expect(results).toHaveProperty('ses');
      expect(results).toHaveProperty('sendgrid');
      expect(results.ses.success).toBe(true);
      expect(results.sendgrid.success).toBe(true);
    });
  });

  describe('Predefined Templates', () => {
    it('should create predefined templates', () => {
      notificationService.createPredefinedTemplates();

      const welcomeMapping = notificationService.getTemplateMapping('welcome');
      expect(welcomeMapping.defaultVariables.appName).toBe('AgreeStellar');
      expect(welcomeMapping.defaultVariables.supportEmail).toBe('support@substream.app');

      const paymentFailureMapping = notificationService.getTemplateMapping('payment_failure');
      expect(paymentFailureMapping.defaultVariables.appName).toBe('AgreeStellar');
      expect(paymentFailureMapping.defaultVariables.billingUrl).toBe('https://app.substream.app/billing');
    });

    it('should send predefined template email', async () => {
      notificationService.createPredefinedTemplates();

      const result = await notificationService.sendTemplateEmail('welcome', {
        to: 'test@example.com',
        from: 'noreply@example.com',
        templateData: { name: 'John' }
      });

      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
    });

    it('should throw error for unknown template type', async () => {
      await expect(notificationService.sendTemplateEmail('unknown', {}))
        .rejects.toThrow('Template mapping not found: unknown');
    });
  });

  describe('Queue Management', () => {
    it('should get job status', async () => {
      const result = await notificationService.getJobStatus('test-job-id');

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('test-job-id');
      expect(result.state).toBe('completed');
    });

    it('should get queue statistics', async () => {
      const result = await notificationService.getQueueStats();

      expect(result.success).toBe(true);
      expect(result.queueName).toBe('notification-queue');
      expect(result.stats).toHaveProperty('waiting');
      expect(result.stats).toHaveProperty('active');
      expect(result.stats).toHaveProperty('completed');
      expect(result.stats).toHaveProperty('failed');
    });

    it('should get recent jobs', async () => {
      const result = await notificationService.getRecentJobs();

      expect(result.success).toBe(true);
      expect(result.state).toBe('completed');
      expect(Array.isArray(result.jobs)).toBe(true);
    });
  });

  describe('Health Status', () => {
    it('should return healthy status', () => {
      const status = notificationService.getHealthStatus();

      expect(status.status).toBe('healthy');
      expect(status.defaultProvider).toBe('ses');
      expect(status.availableProviders).toContain('ses');
      expect(status.availableProviders).toContain('sendgrid');
      expect(status.queue).toBeDefined();
      expect(status.providers).toBeDefined();
      expect(status.templateMappings).toBe(0);
    });

    it('should return degraded status when no provider', () => {
      const service = new NotificationService({
        defaultProvider: 'invalid',
        ses: mockConfig.ses,
        sendgrid: mockConfig.sendgrid
      });

      // Remove all providers to simulate degraded state
      service.providers.clear();
      service.defaultProvider = 'none';

      const status = service.getHealthStatus();
      expect(status.status).toBe('degraded');
    });
  });

  describe('Error Handling', () => {
    it('should handle missing required fields', async () => {
      const invalidEmailData = {
        to: 'test@example.com'
        // Missing from, subject, templateId
      };

      await expect(notificationService.sendEmail(invalidEmailData))
        .rejects.toThrow();
    });

    it('should handle invalid email addresses', async () => {
      const invalidEmailData = {
        to: 'invalid-email',
        from: 'test@example.com',
        subject: 'Test',
        templateId: 'test'
      };

      await expect(notificationService.sendEmail(invalidEmailData))
        .rejects.toThrow('Invalid recipient email');
    });

    it('should handle provider initialization failure', () => {
      expect(() => {
        new NotificationService({
          defaultProvider: 'ses'
          // No provider configs
        });
      }).toThrow('No email providers configured');
    });
  });
});

describe('Email Providers', () => {
  describe('BaseEmailProvider', () => {
    const BaseEmailProvider = require('./services/emailProviders/BaseEmailProvider');

    class TestProvider extends BaseEmailProvider {
      async sendEmail() { return { success: true }; }
      async sendSimpleEmail() { return { success: true }; }
      async getTemplate() { return { name: 'test' }; }
    }

    it('should validate email addresses', () => {
      const provider = new TestProvider();
      
      expect(provider.validateEmail('test@example.com')).toBe(true);
      expect(provider.validateEmail('invalid-email')).toBe(false);
      expect(provider.validateEmail('')).toBe(false);
    });

    it('should normalize email data', () => {
      const provider = new TestProvider({ defaultFrom: 'default@example.com' });
      
      const normalized = provider.normalizeEmailData({
        to: 'test@example.com',
        subject: 'Test',
        templateId: 'test'
      });

      expect(normalized.from).toBe('default@example.com');
      expect(normalized.to).toBe('test@example.com');
      expect(normalized.subject).toBe('Test');
      expect(normalized.templateId).toBe('test');
    });

    it('should throw error for missing required fields', () => {
      const provider = new TestProvider();
      
      expect(() => {
        provider.normalizeEmailData({});
      }).toThrow('Recipient email (to) is required');
    });

    it('should create standardized success response', () => {
      const provider = new TestProvider();
      const response = provider.createSuccess({ messageId: 'test-id' });
      
      expect(response.success).toBe(true);
      expect(response.messageId).toBe('test-id');
      expect(response.provider).toBe('TestProvider');
      expect(response.timestamp).toBeDefined();
    });

    it('should create standardized error response', () => {
      const provider = new TestProvider();
      const error = new Error('Test error');
      const response = provider.createError(error);
      
      expect(response.success).toBe(false);
      expect(response.error).toBe('Test error');
      expect(response.provider).toBe('TestProvider');
      expect(response.timestamp).toBeDefined();
    });
  });

  describe('SES Provider', () => {
    const SESProvider = require('./services/emailProviders/SESProvider');

    it('should initialize with config', () => {
      const provider = new SESProvider({
        region: 'us-west-2',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
      });

      expect(provider.region).toBe('us-west-2');
      expect(provider.name).toBe('SESProvider');
    });

    it('should detect rate limit errors', () => {
      const provider = new SESProvider(mockConfig.ses);
      
      const throttlingError = { code: 'ThrottlingException' };
      expect(provider.isRateLimitError(throttlingError)).toBe(true);
      
      const tooManyRequestsError = { code: 'TooManyRequestsException' };
      expect(provider.isRateLimitError(tooManyRequestsError)).toBe(true);
      
      const normalError = { code: 'InvalidParameter' };
      expect(provider.isRateLimitError(normalError)).toBe(false);
    });

    it('should extract retry after time', () => {
      const provider = new SESProvider(mockConfig.ses);
      
      const throttlingError = { code: 'ThrottlingException' };
      expect(provider.getRetryAfter(throttlingError)).toBe(30);
      
      const rateLimitError = { message: 'maximum send rate exceeded' };
      expect(provider.getRetryAfter(rateLimitError)).toBe(60);
    });

    it('should send templated email', async () => {
      const provider = new SESProvider(mockConfig.ses);
      
      const result = await provider.sendEmail({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        templateId: 'test-template',
        templateData: { name: 'John' }
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('aws-ses-message-id');
      expect(result.provider).toBe('SESProvider');
    });

    it('should send simple email', async () => {
      const provider = new SESProvider(mockConfig.ses);
      
      const result = await provider.sendSimpleEmail({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        text: 'Test content'
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('aws-ses-message-id');
    });

    it('should get template', async () => {
      const provider = new SESProvider(mockConfig.ses);
      
      const result = await provider.getTemplate('test-template');

      expect(result.name).toBe('test-template');
      expect(result.subject).toBe('Test Subject');
    });

    it('should test connection', async () => {
      const provider = new SESProvider(mockConfig.ses);
      
      const result = await provider.testConnection();

      expect(result.success).toBe(true);
      expect(result.data.Max24HourSend).toBe(1000);
    });
  });

  describe('SendGrid Provider', () => {
    const SendGridProvider = require('./services/emailProviders/SendGridProvider');

    it('should initialize with config', () => {
      const provider = new SendGridProvider({
        apiKey: 'test-api-key'
      });

      expect(provider.apiKey).toBe('test-api-key');
      expect(provider.name).toBe('SendGridProvider');
    });

    it('should throw error without API key', () => {
      expect(() => {
        new SendGridProvider({});
      }).toThrow('SendGrid API key is required');
    });

    it('should detect rate limit errors', () => {
      const provider = new SendGridProvider({ apiKey: 'test-key' });
      
      const rateLimitError = { code: 429 };
      expect(provider.isRateLimitError(rateLimitError)).toBe(true);
      
      const tooManyRequestsError = { code: 'Too Many Requests' };
      expect(provider.isRateLimitError(tooManyRequestsError)).toBe(true);
      
      const normalError = { code: 400 };
      expect(provider.isRateLimitError(normalError)).toBe(false);
    });

    it('should send templated email', async () => {
      const provider = new SendGridProvider({ apiKey: 'test-key' });
      
      const result = await provider.sendEmail({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        templateId: 'test-template-id',
        templateData: { name: 'John' }
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('sendgrid-message-id');
      expect(result.provider).toBe('SendGridProvider');
    });

    it('should send simple email', async () => {
      const provider = new SendGridProvider({ apiKey: 'test-key' });
      
      const result = await provider.sendSimpleEmail({
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        text: 'Test content'
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('sendgrid-message-id');
    });

    it('should get template', async () => {
      const provider = new SendGridProvider({ apiKey: 'test-key' });
      
      const result = await provider.getTemplate('test-template-id');

      expect(result.id).toBe('test-template-id');
      expect(result.versions).toBeDefined();
    });

    it('should test connection', async () => {
      const provider = new SendGridProvider({ apiKey: 'test-key' });
      
      const result = await provider.testConnection();

      expect(result.success).toBe(true);
      expect(result.data.username).toBe('test-user');
    });
  });
});

describe('Email Queue Service', () => {
  let queueService;

  beforeEach(() => {
    queueService = new EmailQueueService({
      queueName: 'test-email-queue',
      redis: {
        host: 'localhost',
        port: 6379
      }
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Queue Operations', () => {
    it('should add email job', async () => {
      const emailData = {
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        templateId: 'test-template',
        templateData: { name: 'John' }
      };

      const result = await queueService.addEmailJob(emailData);

      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
      expect(result.queue).toBe('test-email-queue');
    });

    it('should add simple email job', async () => {
      const emailData = {
        to: 'test@example.com',
        from: 'sender@example.com',
        subject: 'Test',
        text: 'Test content'
      };

      const result = await queueService.addSimpleEmailJob(emailData);

      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
      expect(result.queue).toBe('test-email-queue');
    });

    it('should add bulk email job', async () => {
      const bulkData = {
        recipients: [
          { email: 'user1@example.com' },
          { email: 'user2@example.com' }
        ],
        from: 'sender@example.com',
        subject: 'Bulk Test',
        templateId: 'bulk-template',
        templateData: { company: 'Test Corp' }
      };

      const result = await queueService.addBulkEmailJob(bulkData);

      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
      expect(result.queue).toBe('test-email-queue');
    });

    it('should get job status', async () => {
      const result = await queueService.getJobStatus('test-job-id');

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('test-job-id');
      expect(result.state).toBe('completed');
    });

    it('should get queue statistics', async () => {
      const result = await queueService.getQueueStats();

      expect(result.success).toBe(true);
      expect(result.queueName).toBe('test-email-queue');
      expect(result.stats).toBeDefined();
    });

    it('should get recent jobs', async () => {
      const result = await queueService.getRecentJobs();

      expect(result.success).toBe(true);
      expect(result.state).toBe('completed');
      expect(Array.isArray(result.jobs)).toBe(true);
    });
  });

  describe('Queue Management', () => {
    it('should pause queue', async () => {
      const result = await queueService.pauseQueue();

      expect(result.success).toBe(true);
      expect(result.queueName).toBe('test-email-queue');
      expect(result.pausedAt).toBeDefined();
    });

    it('should resume queue', async () => {
      const result = await queueService.resumeQueue();

      expect(result.success).toBe(true);
      expect(result.queueName).toBe('test-email-queue');
      expect(result.resumedAt).toBeDefined();
    });

    it('should clear queue', async () => {
      const result = await queueService.clearQueue({ state: 'waiting' });

      expect(result.success).toBe(true);
      expect(result.queueName).toBe('test-email-queue');
      expect(result.clearedState).toBe('waiting');
    });
  });

  describe('Health Status', () => {
    it('should return health status', () => {
      const status = queueService.getHealthStatus();

      expect(status.queueName).toBe('test-email-queue');
      expect(status.redisConnected).toBe(true);
      expect(status.config).toBeDefined();
      expect(status.timestamp).toBeDefined();
    });
  });
});

describe('Acceptance Criteria Tests', () => {
  let notificationService;

  beforeEach(() => {
    notificationService = new NotificationService({
      defaultProvider: 'ses',
      ses: {
        region: 'us-east-1',
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
      },
      sendgrid: {
        apiKey: 'test-api-key'
      },
      redis: {
        host: 'localhost',
        port: 6379
      }
    });
  });

  it('Acceptance 1: Reliable, scalable system for dispatching transactional emails', async () => {
    // Test that emails are queued successfully
    const emailData = {
      to: 'user@example.com',
      from: 'noreply@example.com',
      subject: 'Welcome to SubStream',
      templateId: 'welcome',
      templateData: { name: 'John Doe', plan: 'premium' }
    };

    const result = await notificationService.sendEmail(emailData);

    expect(result.success).toBe(true);
    expect(result.jobId).toBeDefined();
    expect(result.message).toBe('Email queued for processing');

    // Test that queue is working
    const queueStats = await notificationService.getQueueStats();
    expect(queueStats.success).toBe(true);
    expect(queueStats.queueName).toBe('notification-queue');

    // Test that providers are available and working
    const providerStats = notificationService.getProviderStats();
    expect(providerStats).toHaveProperty('ses');
    expect(providerStats).toHaveProperty('sendgrid');

    const connectionTests = await notificationService.testProviderConnection();
    expect(connectionTests.ses.success).toBe(true);
    expect(connectionTests.sendgrid.success).toBe(true);
  });

  it('Acceptance 2: Asynchronous queue protects API performance from provider latency', async () => {
    const startTime = Date.now();

    // Send multiple emails quickly
    const emailPromises = [];
    for (let i = 0; i < 10; i++) {
      emailPromises.push(
        notificationService.sendEmail({
          to: `user${i}@example.com`,
          from: 'noreply@example.com',
          subject: `Email ${i}`,
          templateId: 'welcome',
          templateData: { name: `User ${i}` }
        })
      );
    }

    const results = await Promise.all(emailPromises);
    const endTime = Date.now();

    // All emails should be queued quickly (under 100ms for 10 emails)
    expect(endTime - startTime).toBeLessThan(100);

    // All should succeed
    results.forEach(result => {
      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();
    });

    // Queue should have jobs waiting
    const queueStats = await notificationService.getQueueStats();
    expect(queueStats.stats.waiting).toBeGreaterThanOrEqual(10);
  });

  it('Acceptance 3: Template variables are mapped correctly for personalized communications', () => {
    // Create template mapping with variables
    notificationService.addTemplateMapping('personalized_welcome', {
      defaultVariables: {
        appName: 'AgreeStellar',
        supportEmail: 'support@substream.app',
        currentYear: () => new Date().getFullYear()
      }
    });

    // Test template variable processing
    const emailData = {
      templateId: 'personalized_welcome',
      templateData: {
        userName: 'John Doe',
        planType: 'Premium',
        signupDate: '2024-01-15'
      }
    };

    const processed = notificationService.processTemplateVariables(emailData);

    expect(processed.templateData.appName).toBe('AgreeStellar');
    expect(processed.templateData.supportEmail).toBe('support@substream.app');
    expect(processed.templateData.currentYear).toBe(new Date().getFullYear());
    expect(processed.templateData.userName).toBe('John Doe');
    expect(processed.templateData.planType).toBe('Premium');
    expect(processed.templateData.signupDate).toBe('2024-01-15');

    // Test function-based variables
    notificationService.addTemplateMapping('dynamic', {
      defaultVariables: {
        currentTime: () => new Date().toISOString(),
        randomNumber: () => Math.floor(Math.random() * 1000)
      }
    });

    const dynamicData = {
      templateId: 'dynamic',
      templateData: { name: 'Test User' }
    };

    const processedDynamic = notificationService.processTemplateVariables(dynamicData);
    expect(typeof processedDynamic.templateData.currentTime).toBe('string');
    expect(typeof processedDynamic.templateData.randomNumber).toBe('number');
  });
});
