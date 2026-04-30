/**
 * Structured Logging Service with Winston
 * 
 * Provides JSON-formatted logs with:
 * - Trace IDs for request correlation
 * - Wallet addresses for user tracking
 * - Contract IDs for blockchain operations
 * - Severity levels and contextual metadata
 */

const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
const { trace, context } = require('@opentelemetry/api');

// Custom format for structured logging
const { combine, timestamp, json, errors, splat } = winston.format;

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'ISO8601' }),
    splat(), // Support printf-style formatting
    json()
  ),
  defaultMeta: {
    service: 'substream-protocol',
    environment: process.env.NODE_ENV || 'development',
  },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production' 
        ? json() 
        : combine(
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.printf(({ level, message, timestamp, ...meta }) => {
              return `${timestamp} [${level.toUpperCase()}] ${message} ${
                Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''
              }`;
            })
          ),
    }),
    
    // File transport for error logs
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
    
    // File transport for all logs
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  ],
});

/**
 * Add trace context to log entries
 * @param {string} traceId - Unique trace identifier
 * @param {object} additionalContext - Additional context to add
 */
function createLoggerContext(traceId, additionalContext = {}) {
  return {
    traceId: traceId || uuidv4(),
    ...additionalContext,
  };
}

/**
 * Middleware to add trace ID to all requests
 */
function requestTracingMiddleware(req, res, next) {
  const activeSpan = trace.getSpan(context.active());
  const spanContext = activeSpan?.spanContext();
  const traceId = req.headers['x-trace-id'] || spanContext?.traceId || uuidv4();
  const spanId = spanContext?.spanId;

  // Add trace headers for downstream correlation
  res.setHeader('x-trace-id', traceId);
  if (spanId) {
    res.setHeader('x-span-id', spanId);
  }

  req.logger = logger.child({
    traceId,
    spanId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  // Preserve trace fields for downstream error handling
  req.logger.fields = { traceId, spanId };

  // Track request timing
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const context = {
      traceId,
      spanId,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
    };

    if (res.statusCode >= 500) {
      logger.error('Request failed', context);
    } else if (res.statusCode >= 400) {
      logger.warn('Client error', context);
    } else {
      logger.info('Request completed', context);
    }
  });

  next();
}

/**
 * Log wallet-related operations
 * @param {string} walletAddress - Stellar wallet address
 * @param {string} action - Action being performed
 * @param {object} metadata - Additional metadata
 */
function logWalletOperation(walletAddress, action, metadata = {}) {
  logger.info(`Wallet operation: ${action}`, {
    walletAddress: walletAddress.toLowerCase(),
    action,
    ...metadata,
  });
}

/**
 * Log smart contract interactions
 * @param {string} contractId - Soroban contract ID
 * @param {string} operation - Contract operation
 * @param {object} txHash - Transaction hash
 * @param {object} metadata - Additional metadata
 */
function logContractInteraction(contractId, operation, txHash, metadata = {}) {
  logger.info(`Contract interaction: ${operation}`, {
    contractId,
    operation,
    transactionHash: txHash,
    network: process.env.STELLAR_NETWORK_PASSPHRASE?.includes('Test') ? 'testnet' : 'mainnet',
    ...metadata,
  });
}

/**
 * Log authentication events
 * @param {string} walletAddress - Wallet address
 * @param {string} eventType - Event type (login, logout, failed, etc.)
 * @param {object} metadata - Additional metadata
 */
function logAuthEvent(walletAddress, eventType, metadata = {}) {
  const logLevel = eventType.includes('failed') ? 'warn' : 'info';
  
  logger[logLevel](`Authentication event: ${eventType}`, {
    walletAddress: walletAddress?.toLowerCase(),
    eventType,
    category: 'authentication',
    ...metadata,
  });
}

/**
 * Log payment/payout operations
 * @param {string} walletAddress - Recipient wallet
 * @param {number} amount - Amount in stroops
 * @param {string} asset - Asset type
 * @param {object} metadata - Additional metadata
 */
function logPayment(walletAddress, amount, asset, metadata = {}) {
  logger.info('Payment processed', {
    walletAddress: walletAddress.toLowerCase(),
    amount,
    asset,
    category: 'payment',
    ...metadata,
  });
}

/**
 * Log Sybil/fraud detection events
 * @param {string} deviceId - Device ID
 * @param {string} riskLevel - Risk level (low, medium, high, critical)
 * @param {array} flags - Array of flag identifiers
 * @param {object} metadata - Additional metadata
 */
function logFraudDetection(deviceId, riskLevel, flags, metadata = {}) {
  const logLevel = riskLevel === 'critical' ? 'error' : 
                   riskLevel === 'high' ? 'warn' : 'info';
  
  logger[logLevel]('Fraud detection alert', {
    deviceId,
    riskLevel,
    flags,
    category: 'fraud-prevention',
    ...metadata,
  });
}

/**
 * Log video processing events
 * @param {string} videoId - Video ID
 * @param {string} status - Processing status
 * @param {object} metadata - Additional metadata
 */
function logVideoProcessing(videoId, status, metadata = {}) {
  logger.info(`Video processing: ${status}`, {
    videoId,
    status,
    category: 'video-processing',
    ...metadata,
  });
}

/**
 * Log database operations
 * @param {string} operation - Database operation
 * @param {string} table - Table name
 * @param {object} metadata - Additional metadata
 */
function logDatabaseOperation(operation, table, metadata = {}) {
  logger.debug(`Database operation: ${operation}`, {
    operation,
    table,
    category: 'database',
    ...metadata,
  });
}

/**
 * Log migration events
 * @param {string} migrationName - Migration name
 * @param {string} status - Migration status
 * @param {object} metadata - Additional metadata
 */
function logMigration(migrationName, status, metadata = {}) {
  const logLevel = status === 'failed' ? 'error' : 'info';
  
  logger[logLevel](`Migration: ${status}`, {
    migrationName,
    status,
    category: 'migration',
    ...metadata,
  });
}

/**
 * Format error with stack trace and context
 * @param {Error} error - Error object
 * @param {object} context - Additional context
 */
function formatError(error, context = {}) {
  return {
    message: error.message,
    name: error.name,
    stack: error.stack,
    code: error.code,
    ...context,
  };
}

// Export utilities
module.exports = {
  logger,
  createLoggerContext,
  requestTracingMiddleware,
  logWalletOperation,
  logContractInteraction,
  logAuthEvent,
  logPayment,
  logFraudDetection,
  logVideoProcessing,
  logDatabaseOperation,
  logMigration,
  formatError,
};
