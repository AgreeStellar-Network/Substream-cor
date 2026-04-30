const express = require('express');

/**
 * Payload Size Limit Middleware
 * Prevents memory exhaustion attacks by limiting request payload sizes
 */
class PayloadSizeLimitMiddleware {
  constructor(options = {}) {
    // Default limits (in bytes)
    this.limits = {
      json: options.jsonLimit || 1024 * 1024, // 1MB default for JSON
      urlencoded: options.urlencodedLimit || 1024 * 1024, // 1MB default for URL-encoded
      text: options.textLimit || 1024 * 1024, // 1MB default for text
      raw: options.rawLimit || 10 * 1024 * 1024, // 10MB default for raw/binary
      graphql: options.graphqlLimit || 2 * 1024 * 1024, // 2MB default for GraphQL
      file: options.fileLimit || 50 * 1024 * 1024, // 50MB default for file uploads
      ...options.customLimits
    };

    // Strict mode for additional security
    this.strictMode = options.strictMode || false;
    
    // Enable request logging for monitoring
    this.enableLogging = options.enableLogging !== false;
  }

  /**
   * Express middleware factory
   */
  middleware() {
    const self = this;

    return (req, res, next) => {
      // Skip payload size checking for health checks and metrics endpoints
      if (this.isSystemEndpoint(req.path)) {
        return next();
      }

      // Get content type
      const contentType = req.headers['content-type'] || '';
      
      // Determine appropriate limit based on content type and endpoint
      const limit = this.getLimitForRequest(req, contentType);
      
      if (this.enableLogging) {
        console.log(`[PayloadLimit] ${req.method} ${req.path} - Content-Type: ${contentType}, Limit: ${limit} bytes`);
      }

      // Check content-length header if available (early rejection)
      const contentLength = req.headers['content-length'];
      if (contentLength && parseInt(contentLength, 10) > limit) {
        const error = {
          error: 'Payload Too Large',
          message: `Request payload size (${contentLength} bytes) exceeds limit (${limit} bytes)`,
          maxSize: limit,
          receivedSize: parseInt(contentLength, 10)
        };

        if (this.strictMode) {
          // In strict mode, log the attempt for security monitoring
          this.logSecurityViolation(req, error);
        }

        return res.status(413).json(error);
      }

      // Apply appropriate express body parser with size limit
      this.applyBodyParser(req, res, next, contentType, limit);
    };
  }

  /**
   * Determine appropriate limit for the request
   */
  getLimitForRequest(req, contentType) {
    // GraphQL specific limits
    if (req.path.includes('/graphql') || contentType.includes('application/graphql')) {
      return this.limits.graphql;
    }

    // File upload endpoints
    if (req.path.includes('/upload') || req.path.includes('/file')) {
      return this.limits.file;
    }

    // Content type based limits
    if (contentType.includes('application/json')) {
      return this.limits.json;
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      return this.limits.urlencoded;
    } else if (contentType.includes('text/')) {
      return this.limits.text;
    } else {
      return this.limits.raw;
    }
  }

  /**
   * Apply appropriate body parser with size limit
   */
  applyBodyParser(req, res, next, contentType, limit) {
    try {
      // JSON parser with size limit
      if (contentType.includes('application/json')) {
        express.json({ limit: limit })(req, res, (err) => {
          if (err) {
            return this.handlePayloadError(req, res, err, limit);
          }
          next();
        });
      }
      // URL-encoded parser with size limit
      else if (contentType.includes('application/x-www-form-urlencoded')) {
        express.urlencoded({ limit: limit, extended: true })(req, res, (err) => {
          if (err) {
            return this.handlePayloadError(req, res, err, limit);
          }
          next();
        });
      }
      // Text parser with size limit
      else if (contentType.includes('text/')) {
        express.text({ limit: limit, type: contentType })(req, res, (err) => {
          if (err) {
            return this.handlePayloadError(req, res, err, limit);
          }
          next();
        });
      }
      // Raw parser for other content types
      else {
        express.raw({ limit: limit, type: contentType })(req, res, (err) => {
          if (err) {
            return this.handlePayloadError(req, res, err, limit);
          }
          next();
        });
      }
    } catch (error) {
      this.handlePayloadError(req, res, error, limit);
    }
  }

  /**
   * Handle payload parsing errors
   */
  handlePayloadError(req, res, error, limit) {
    const errorResponse = {
      error: 'Payload Processing Error',
      message: 'Failed to process request payload',
      maxSize: limit,
      timestamp: new Date().toISOString()
    };

    if (error.type === 'entity.too.large') {
      errorResponse.error = 'Payload Too Large';
      errorResponse.message = `Request payload exceeds maximum allowed size of ${limit} bytes`;
      
      if (this.strictMode) {
        this.logSecurityViolation(req, errorResponse);
      }
      
      return res.status(413).json(errorResponse);
    }

    if (error.type === 'entity.parse.failed') {
      errorResponse.error = 'Invalid Payload Format';
      errorResponse.message = 'Request payload contains invalid data format';
      
      if (this.strictMode) {
        this.logSecurityViolation(req, errorResponse);
      }
      
      return res.status(400).json(errorResponse);
    }

    // Log unexpected errors
    console.error('[PayloadLimit] Unexpected error:', error);
    return res.status(500).json(errorResponse);
  }

  /**
   * Check if endpoint is a system endpoint that should bypass limits
   */
  isSystemEndpoint(path) {
    const systemEndpoints = [
      '/health',
      '/metrics',
      '/status',
      '/ping',
      '/readiness',
      '/liveness'
    ];

    return systemEndpoints.some(endpoint => path.includes(endpoint));
  }

  /**
   * Log security violations for monitoring
   */
  logSecurityViolation(req, error) {
    const violation = {
      timestamp: new Date().toISOString(),
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      method: req.method,
      path: req.path,
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      error: error.error,
      message: error.message
    };

    console.warn('[Security] Payload size limit violation:', violation);
    
    // In production, you might want to send this to a security monitoring service
    // or SIEM system for threat detection
  }

  /**
   * Get current limits configuration
   */
  getLimits() {
    return { ...this.limits };
  }

  /**
   * Update limits configuration
   */
  updateLimits(newLimits) {
    this.limits = { ...this.limits, ...newLimits };
  }
}

module.exports = { PayloadSizeLimitMiddleware };
