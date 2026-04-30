/**
 * HTTP Tracing Middleware
 * Provides automatic HTTP request/response tracing with correlation ID tracking
 */

const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const { v4: uuidv4 } = require('uuid');
const {
  createModuleTracer,
  extractTraceContext,
  getTraceContextHeaders,
} = require('./tracingUtils');

const CORRELATION_ID_HEADER = 'x-correlation-id';
const TRACE_CONTEXT_HEADER = 'traceparent';

/**
 * Middleware for Express to add HTTP tracing
 * @param {Object} options - Configuration options
 * @returns {Function} - Express middleware
 */
function httpTracingMiddleware(options = {}) {
  const tracer = createModuleTracer('http-server');

  return (req, res, next) => {
    // Get or create correlation ID
    let correlationId = req.get(CORRELATION_ID_HEADER) || uuidv4();
    req.correlationId = correlationId;
    req.traceContext = extractTraceContext(req.headers);

    // Set correlation ID in response headers
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    res.setHeader('x-trace-id', req.traceContext.traceId || 'unknown');

    // Create span for this HTTP request
    const span = tracer.startSpan(`${req.method} ${req.path}`, {
      attributes: {
        'http.method': req.method,
        'http.url': `${req.protocol}://${req.get('host')}${req.originalUrl}`,
        'http.target': req.path,
        'http.host': req.hostname,
        'http.scheme': req.protocol,
        'http.client_ip': getClientIp(req),
        'http.user_agent': req.get('user-agent') || 'unknown',
        'http.server_name': req.hostname,
        'correlation.id': correlationId,
      },
    });

    // If trace context was provided, add it to span
    if (req.traceContext && req.traceContext.traceId) {
      span.setAttribute('trace.parent_id', req.traceContext.spanId);
    }

    // Store original end method
    const originalEnd = res.end;

    // Override res.end to capture response information
    res.end = function endWithTracing(...args) {
      // Set response status code and content length
      span.setAttributes({
        'http.status_code': res.statusCode,
        'http.response_content_length': res.get('content-length') || 0,
      });

      // Set span status based on HTTP status code
      if (res.statusCode >= 400) {
        const statusMessage = `HTTP ${res.statusCode}`;
        span.setStatus({
          code: res.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
          message: statusMessage,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      // End the span
      span.end();

      // Call original end method
      return originalEnd.apply(res, args);
    };

    // Run the rest of the request in the span context
    context.with(trace.setSpan(context.active(), span), () => {
      next();
    });
  };
}

/**
 * Middleware to propagate trace context in responses
 * @returns {Function} - Express middleware
 */
function traceContextResponseMiddleware() {
  return (req, res, next) => {
    // Attach trace context headers to response
    const traceHeaders = getTraceContextHeaders();
    Object.entries(traceHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    next();
  };
}

/**
 * Extract client IP from request
 * @param {Object} req - Express request object
 * @returns {string} - Client IP address
 */
function getClientIp(req) {
  return (
    req.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.get('x-real-ip') ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.ip ||
    'unknown'
  );
}

/**
 * Create a request logger with trace context
 * @returns {Function} - Express middleware
 */
function traceAwareRequestLogger() {
  return (req, res, next) => {
    const startTime = Date.now();
    const originalEnd = res.end;

    res.end = function endWithLogging(...args) {
      const duration = Date.now() - startTime;
      const span = trace.getActiveSpan();
      const traceId = span?.spanContext?.()?.traceId || 'unknown';
      const spanId = span?.spanContext?.()?.spanId || 'unknown';
      const correlationId = req.correlationId || 'unknown';

      console.log('[HTTP] Request completed', {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        traceId,
        spanId,
        correlationId,
        userAgent: req.get('user-agent'),
        clientIp: getClientIp(req),
      });

      return originalEnd.apply(res, args);
    };

    next();
  };
}

/**
 * NestJS Guard for tracing (if using NestJS)
 * Usage: @UseGuards(TracingGuard)
 */
class TracingGuard {
  canActivate(context) {
    const req = context.switchToHttp().getRequest();
    const tracer = createModuleTracer('nestjs-guard');

    // Similar to httpTracingMiddleware logic
    let correlationId = req.get(CORRELATION_ID_HEADER) || uuidv4();
    req.correlationId = correlationId;
    req.traceContext = extractTraceContext(req.headers);

    const span = tracer.startSpan(`${req.method} ${req.path}`);
    span.setAttributes({
      'http.method': req.method,
      'http.url': req.originalUrl,
      'correlation.id': correlationId,
    });

    // Store span in request for later retrieval
    req.span = span;

    return true;
  }
}

module.exports = {
  httpTracingMiddleware,
  traceContextResponseMiddleware,
  traceAwareRequestLogger,
  TracingGuard,
  getClientIp,
  CORRELATION_ID_HEADER,
  TRACE_CONTEXT_HEADER,
};
