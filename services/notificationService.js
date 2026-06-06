const EmailQueueService = require('./emailQueue');
const SESProvider = require('./emailProviders/SESProvider');
const SendGridProvider = require('./emailProviders/SendGridProvider');

/**
 * Unified Notification Service
 * Manages email notifications with provider abstraction and queueing
 */
class NotificationService {
  constructor(config = {}) {
    this.config = config;
    this.defaultProvider = config.defaultProvider || process.env.DEFAULT_EMAIL_PROVIDER || 'ses';
    this.providers = new Map();
    this.queueService = null;
    this.templateMappings = new Map();
    
    this.initialize();
  }

  /**
   * Initialize notification service
   */
  initialize() {
    try {
      // Initialize email queue
      this.queueService = new EmailQueueService({
        queueName: config.queueName || 'notification-queue',
        redis: config.redis,
        concurrency: config.concurrency || 5,
        rateLimitMax: config.rateLimitMax || 100,
        rateLimitDuration: config.rateLimitDuration || 60000
      });

      // Initialize providers
      this.initializeProviders();
      
      // Set default provider for queue
      const defaultProvider = this.providers.get(this.defaultProvider);
      if (defaultProvider) {
        this.queueService.setEmailProvider(defaultProvider);
      }

      console.log(`Notification service initialized with provider: ${this.defaultProvider}`);
      
    } catch (error) {
      console.error('Failed to initialize notification service:', error);
      throw error;
    }
  }

  /**
   * Initialize email providers
   */
  initializeProviders() {
    try {
      // Initialize AWS SES provider
      if (this.config.ses || process.env.AWS_ACCESS_KEY_ID) {
        const sesProvider = new SESProvider(this.config.ses || {});
        this.providers.set('ses', sesProvider);
        console.log('AWS SES provider initialized');
      }

      // Initialize SendGrid provider
      if (this.config.sendgrid || process.env.SENDGRID_API_KEY) {
        const sendGridProvider = new SendGridProvider(this.config.sendgrid || {});
        this.providers.set('sendgrid', sendGridProvider);
        console.log('SendGrid provider initialized');
      }

      if (this.providers.size === 0) {
        throw new Error('No email providers configured');
      }

    } catch (error) {
      console.error('Failed to initialize email providers:', error);
      throw error;
    }
  }

  /**
   * Send email using template
   * @param {Object} emailData - Email data
   * @param {Object} options - Send options
   * @returns {Promise<Object>} Send result
   */
  async sendEmail(emailData, options = {}) {
    try {
      const provider = options.provider || this.defaultProvider;
      const emailProvider = this.providers.get(provider);
      
      if (!emailProvider) {
        throw new Error(`Email provider not found: ${provider}`);
      }

      // Process template variables
      const processedData = this.processTemplateVariables(emailData);

      // Add to queue for async processing
      const jobResult = await this.queueService.addEmailJob(processedData, {
        provider,
        attempts: options.attempts || 3,
        delay: options.delay || 0,
        priority: options.priority || 0
      });

      return {
        success: true,
        jobId: jobResult.jobId,
        queue: jobResult.queue,
        provider,
        addedAt: jobResult.addedAt,
        message: 'Email queued for processing'
      };

    } catch (error) {
      console.error('Failed to send email:', error);
      throw error;
    }
  }

  /**
   * Send simple text/HTML email
   * @param {Object} emailData - Email data
   * @param {Object} options - Send options
   * @returns {Promise<Object>} Send result
   */
  async sendSimpleEmail(emailData, options = {}) {
    try {
      const provider = options.provider || this.defaultProvider;
      const emailProvider = this.providers.get(provider);
      
      if (!emailProvider) {
        throw new Error(`Email provider not found: ${provider}`);
      }

      // Add to queue for async processing
      const jobResult = await this.queueService.addSimpleEmailJob(emailData, {
        provider,
        attempts: options.attempts || 3,
        delay: options.delay || 0,
        priority: options.priority || 0
      });

      return {
        success: true,
        jobId: jobResult.jobId,
        queue: jobResult.queue,
        provider,
        addedAt: jobResult.addedAt,
        message: 'Simple email queued for processing'
      };

    } catch (error) {
      console.error('Failed to send simple email:', error);
      throw error;
    }
  }

  /**
   * Send bulk email to multiple recipients
   * @param {Object} bulkData - Bulk email data
   * @param {Object} options - Send options
   * @returns {Promise<Object>} Send result
   */
  async sendBulkEmail(bulkData, options = {}) {
    try {
      const provider = options.provider || this.defaultProvider;
      const emailProvider = this.providers.get(provider);
      
      if (!emailProvider) {
        throw new Error(`Email provider not found: ${provider}`);
      }

      // Process recipients with template variables
      const processedRecipients = bulkData.recipients.map(recipient => ({
        email: recipient.email,
        templateData: this.processTemplateVariables({
          templateData: recipient.templateData || {}
        }).templateData
      }));

      // Add to queue for async processing
      const jobResult = await this.queueService.addBulkEmailJob({
        recipients: processedRecipients,
        from: bulkData.from,
        subject: bulkData.subject,
        templateId: bulkData.templateId,
        templateData: this.processTemplateVariables(bulkData).templateData,
        options: bulkData.options
      }, {
        provider,
        attempts: options.attempts || 5,
        delay: options.delay || 0,
        priority: options.priority || 0
      });

      return {
        success: true,
        jobId: jobResult.jobId,
        queue: jobResult.queue,
        provider,
        totalRecipients: bulkData.recipients.length,
        addedAt: jobResult.addedAt,
        message: 'Bulk email queued for processing'
      };

    } catch (error) {
      console.error('Failed to send bulk email:', error);
      throw error;
    }
  }

  /**
   * Process template variables and apply mappings
   * @param {Object} emailData - Email data with template variables
   * @returns {Object} Processed email data
   */
  processTemplateVariables(emailData) {
    const processed = { ...emailData };
    
    if (emailData.templateData) {
      processed.templateData = this.applyTemplateMappings(emailData.templateData);
    }

    // Apply default template mappings
    if (processed.templateId && this.templateMappings.has(processed.templateId)) {
      const mapping = this.templateMappings.get(processed.templateId);
      processed.templateData = {
        ...mapping.defaultVariables,
        ...processed.templateData
      };
    }

    return processed;
  }

  /**
   * Apply template variable mappings
   * @param {Object} variables - Template variables
   * @returns {Object} Mapped variables
   */
  applyTemplateMappings(variables) {
    const mapped = { ...variables };

    // Apply global mappings
    if (this.config.globalTemplateMappings) {
      Object.keys(this.config.globalTemplateMappings).forEach(key => {
        if (mapped[key] === undefined) {
          mapped[key] = this.config.globalTemplateMappings[key];
        }
      });
    }

    // Apply function-based mappings
    Object.keys(mapped).forEach(key => {
      const value = mapped[key];
      if (typeof value === 'function') {
        mapped[key] = value();
      } else if (typeof value === 'object' && value !== null) {
        mapped[key] = this.applyTemplateMappings(value);
      }
    });

    return mapped;
  }

  /**
   * Add template mapping
   * @param {string} templateId - Template ID
   * @param {Object} mapping - Template mapping
   */
  addTemplateMapping(templateId, mapping) {
    this.templateMappings.set(templateId, mapping);
  }

  /**
   * Remove template mapping
   * @param {string} templateId - Template ID
   */
  removeTemplateMapping(templateId) {
    this.templateMappings.delete(templateId);
  }

  /**
   * Get template mapping
   * @param {string} templateId - Template ID
   * @returns {Object} Template mapping
   */
  getTemplateMapping(templateId) {
    return this.templateMappings.get(templateId);
  }

  /**
   * Switch email provider
   * @param {string} provider - Provider name
   * @returns {Object} Switch result
   */
  switchProvider(provider) {
    try {
      const emailProvider = this.providers.get(provider);
      
      if (!emailProvider) {
        throw new Error(`Email provider not found: ${provider}`);
      }

      this.defaultProvider = provider;
      this.queueService.setEmailProvider(emailProvider);
      
      return {
        success: true,
        provider,
        switchedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('Failed to switch provider:', error);
      throw error;
    }
  }

  /**
   * Get job status
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Job status
   */
  async getJobStatus(jobId) {
    return await this.queueService.getJobStatus(jobId);
  }

  /**
   * Get queue statistics
   * @returns {Promise<Object>} Queue statistics
   */
  async getQueueStats() {
    return await this.queueService.getQueueStats();
  }

  /**
   * Get recent jobs
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Recent jobs
   */
  async getRecentJobs(options = {}) {
    return await this.queueService.getRecentJobs(options);
  }

  /**
   * Get provider statistics
   * @param {string} provider - Provider name (optional)
   * @returns {Object} Provider statistics
   */
  getProviderStats(provider = null) {
    if (provider) {
      const emailProvider = this.providers.get(provider);
      if (!emailProvider) {
        throw new Error(`Email provider not found: ${provider}`);
      }
      return emailProvider.getStats();
    }

    // Return stats for all providers
    const stats = {};
    this.providers.forEach((emailProvider, name) => {
      stats[name] = emailProvider.getStats();
    });
    
    return stats;
  }

  /**
   * Test provider connection
   * @param {string} provider - Provider name (optional)
   * @returns {Promise<Object>} Test results
   */
  async testProviderConnection(provider = null) {
    const providersToTest = provider ? [provider] : Array.from(this.providers.keys());
    const results = {};

    for (const providerName of providersToTest) {
      const emailProvider = this.providers.get(providerName);
      if (emailProvider) {
        try {
          results[providerName] = await emailProvider.testConnection();
        } catch (error) {
          results[providerName] = {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
          };
        }
      }
    }

    return results;
  }

  /**
   * Get available providers
   * @returns {Array<string>} Available provider names
   */
  getAvailableProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * Get service health status
   * @returns {Object} Health status
   */
  getHealthStatus() {
    const queueHealth = this.queueService.getHealthStatus();
    const providerStats = this.getProviderStats();
    
    return {
      status: queueHealth.provider !== 'none' ? 'healthy' : 'degraded',
      defaultProvider: this.defaultProvider,
      availableProviders: this.getAvailableProviders(),
      queue: queueHealth,
      providers: providerStats,
      templateMappings: this.templateMappings.size,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Create predefined email templates
   */
  createPredefinedTemplates() {
    // Welcome email template
    this.addTemplateMapping('welcome', {
      defaultVariables: {
        appName: 'AgreeStellar',
        supportEmail: 'support@substream.app',
        currentYear: new Date().getFullYear()
      }
    });

    // Payment failure template
    this.addTemplateMapping('payment_failure', {
      defaultVariables: {
        appName: 'AgreeStellar',
        supportEmail: 'support@substream.app',
        billingUrl: 'https://app.substream.app/billing'
      }
    });

    // Low balance warning template
    this.addTemplateMapping('low_balance_warning', {
      defaultVariables: {
        appName: 'AgreeStellar',
        supportEmail: 'support@substream.app',
        addFundsUrl: 'https://app.substream.app/wallet/add-funds'
      }
    });

    // Subscription expired template
    this.addTemplateMapping('subscription_expired', {
      defaultVariables: {
        appName: 'AgreeStellar',
        supportEmail: 'support@substream.app',
        renewUrl: 'https://app.substream.app/subscriptions'
      }
    });

    // Pre-billing health check template
    this.addTemplateMapping('pre_billing_warning', {
      defaultVariables: {
        appName: 'AgreeStellar',
        supportEmail: 'support@substream.app',
        warningDays: 3
      }
    });
  }

  /**
   * Send predefined template email
   * @param {string} templateType - Template type
   * @param {Object} emailData - Email data
   * @param {Object} options - Send options
   * @returns {Promise<Object>} Send result
   */
  async sendTemplateEmail(templateType, emailData, options = {}) {
    const templateMapping = this.getTemplateMapping(templateType);
    
    if (!templateMapping) {
      throw new Error(`Template mapping not found: ${templateType}`);
    }

    // Merge template variables
    const mergedData = {
      ...emailData,
      templateData: {
        ...templateMapping.defaultVariables,
        ...emailData.templateData
      }
    };

    return await this.sendEmail(mergedData, options);
  }

  /**
   * Close notification service
   */
  async close() {
    try {
      if (this.queueService) {
        await this.queueService.close();
      }
      
      console.log('Notification service closed');
      
    } catch (error) {
      console.error('Failed to close notification service:', error);
      throw error;
    }
  }
}

module.exports = NotificationService;
