/**
 * Tracing Utilities for Distributed Tracing
 * Provides helper functions and decorators for comprehensive span instrumentation
 */

const { context, trace, SpanStatusCode } = require('@opentelemetry/api');
const { getTracer, withSpan, setSpanAttributes, recordSpanException } = require('./opentelemetry');

/**
 * Create a tracer for a specific module
 * @param {string} moduleName - The name of the module
 * @returns {Tracer} - The configured tracer
 */
function createModuleTracer(moduleName) {
  return getTracer(moduleName);
}

/**
 * Get trace ID from current span context
 * @returns {string} - The trace ID or 'unknown'
 */
function getTraceId() {
  const span = trace.getActiveSpan();
  const spanContext = span?.spanContext?.();
  return spanContext?.traceId || 'unknown';
}

/**
 * Get span ID from current span context
 * @returns {string} - The span ID or 'unknown'
 */
function getSpanId() {
  const span = trace.getActiveSpan();
  const spanContext = span?.spanContext?.();
  return spanContext?.spanId || 'unknown';
}

/**
 * Get W3C trace context header
 * @returns {string} - The trace context header value
 */
function getTraceContextHeader() {
  const span = trace.getActiveSpan();
  const spanContext = span?.spanContext?.();
  if (!spanContext) return '';

  const { traceId, spanId, traceFlags } = spanContext;
  const sampled = traceFlags?.sampled ? '01' : '00';
  return `00-${traceId}-${spanId}-${sampled}`;
}

/**
 * Extract trace context from headers
 * @param {Object} headers - HTTP headers
 * @returns {Object} - Extracted trace context or empty object
 */
function extractTraceContext(headers) {
  if (!headers) return {};

  const traceparent = headers['traceparent'] || headers['trace-parent'];
  const tracestate = headers['tracestate'];

  if (!traceparent) return {};

  // Parse W3C Trace Context format: 00-traceId-spanId-traceFlags
  const parts = traceparent.split('-');
  if (parts.length !== 4) return {};

  return {
    traceId: parts[1],
    spanId: parts[2],
    traceFlags: parts[3],
    tracestate: tracestate || '',
  };
}

/**
 * Create X-Trace-Context header for cross-service calls
 * @returns {Object} - Headers object with trace context
 */
function getTraceContextHeaders() {
  const headers = {};
  const traceparent = getTraceContextHeader();

  if (traceparent) {
    headers['traceparent'] = traceparent;
  }

  return headers;
}

/**
 * Wrap an async function with automatic span creation
 * @param {string} spanName - Name of the span
 * @param {Function} fn - Async function to wrap
 * @param {Object} options - Span options (attributes, kind, etc.)
 * @returns {Function} - Wrapped async function
 */
function traceAsync(spanName, fn, options = {}) {
  return async function tracedAsyncFn(...args) {
    const tracer = createModuleTracer('substream-backend');
    const span = tracer.startSpan(spanName, options.spanOptions || {});

    if (options.attributes) {
      span.setAttributes(options.attributes);
    }

    try {
      return await context.with(trace.setSpan(context.active(), span), async () => {
        return fn(...args);
      });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  };
}

/**
 * Wrap a sync function with automatic span creation
 * @param {string} spanName - Name of the span
 * @param {Function} fn - Sync function to wrap
 * @param {Object} options - Span options (attributes, kind, etc.)
 * @returns {Function} - Wrapped sync function
 */
function traceSync(spanName, fn, options = {}) {
  return function tracedSyncFn(...args) {
    const tracer = createModuleTracer('substream-backend');
    const span = tracer.startSpan(spanName, options.spanOptions || {});

    if (options.attributes) {
      span.setAttributes(options.attributes);
    }

    try {
      return context.with(trace.setSpan(context.active(), span), () => {
        return fn(...args);
      });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  };
}

/**
 * Decorator for tracing async methods in classes
 * @param {Object} target - The class prototype
 * @param {string} propertyKey - The method name
 * @param {Object} descriptor - The property descriptor
 * @returns {Object} - The modified descriptor
 */
function Traceable(target, propertyKey, descriptor) {
  const originalMethod = descriptor.value;

  descriptor.value = async function tracedMethod(...args) {
    const spanName = `${target.constructor.name}.${propertyKey}`;
    return traceAsync(spanName, originalMethod.bind(this), {
      attributes: {
        'code.function': propertyKey,
        'code.namespace': target.constructor.name,
      },
    })(...args);
  };

  return descriptor;
}

/**
 * Create a span for database operations
 * @param {string} operation - The operation name (query, insert, update, delete)
 * @param {string} table - The table name
 * @param {Object} attributes - Additional attributes
 * @returns {Object} - Span utilities
 */
function createDbSpan(operation, table, attributes = {}) {
  const spanName = `db.${operation}`;
  const tracer = createModuleTracer('substream-backend');
  const span = tracer.startSpan(spanName);

  const baseAttributes = {
    'db.system': 'postgresql',
    'db.operation': operation,
    'db.table': table,
    ...attributes,
  };

  span.setAttributes(baseAttributes);

  return {
    span,
    recordResult: (rowCount = 0, duration = 0) => {
      span.setAttributes({
        'db.result.rows': rowCount,
        'db.result.duration_ms': Math.round(duration),
      });
    },
    recordError: (error, query = '') => {
      span.recordException(error);
      if (query) {
        span.setAttribute('db.statement', query.substring(0, 500)); // Limit query length
      }
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    },
    end: () => span.end(),
  };
}

/**
 * Create a span for HTTP client calls
 * @param {string} method - HTTP method
 * @param {string} url - Target URL
 * @param {Object} attributes - Additional attributes
 * @returns {Object} - Span utilities
 */
function createHttpSpan(method, url, attributes = {}) {
  const spanName = `http.client.${method.toLowerCase()}`;
  const tracer = createModuleTracer('substream-backend');
  const span = tracer.startSpan(spanName);

  const baseAttributes = {
    'http.method': method,
    'http.url': url,
    'http.client': true,
    ...attributes,
  };

  span.setAttributes(baseAttributes);

  return {
    span,
    recordResponse: (statusCode, duration = 0, size = 0) => {
      span.setAttributes({
        'http.status_code': statusCode,
        'http.duration_ms': Math.round(duration),
        'http.response_size': size,
      });
    },
    recordError: (error, statusCode) => {
      span.recordException(error);
      if (statusCode) {
        span.setAttribute('http.status_code', statusCode);
      }
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    },
    end: () => span.end(),
  };
}

/**
 * Create a span for cache operations
 * @param {string} operation - The operation (get, set, delete, etc.)
 * @param {string} key - The cache key
 * @param {Object} attributes - Additional attributes
 * @returns {Object} - Span utilities
 */
function createCacheSpan(operation, key, attributes = {}) {
  const spanName = `cache.${operation}`;
  const tracer = createModuleTracer('substream-backend');
  const span = tracer.startSpan(spanName);

  const baseAttributes = {
    'cache.system': 'redis',
    'cache.operation': operation,
    'cache.key': key,
    ...attributes,
  };

  span.setAttributes(baseAttributes);

  return {
    span,
    recordHit: () => span.setAttribute('cache.hit', true),
    recordMiss: () => span.setAttribute('cache.hit', false),
    recordError: (error) => {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    },
    end: () => span.end(),
  };
}

/**
 * Create a span for queue operations
 * @param {string} operation - The operation (publish, consume, etc.)
 * @param {string} queue - The queue name
 * @param {Object} attributes - Additional attributes
 * @returns {Object} - Span utilities
 */
function createQueueSpan(operation, queue, attributes = {}) {
  const spanName = `queue.${operation}`;
  const tracer = createModuleTracer('substream-backend');
  const span = tracer.startSpan(spanName);

  const baseAttributes = {
    'queue.system': 'rabbitmq',
    'queue.operation': operation,
    'queue.name': queue,
    ...attributes,
  };

  span.setAttributes(baseAttributes);

  return {
    span,
    recordCount: (count) => span.setAttribute('queue.message_count', count),
    recordError: (error) => {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    },
    end: () => span.end(),
  };
}

/**
 * Create a span for blockchain operations
 * @param {string} operation - The operation name
 * @param {string} network - The blockchain network (stellar, ethereum, etc.)
 * @param {Object} attributes - Additional attributes
 * @returns {Object} - Span utilities
 */
function createBlockchainSpan(operation, network, attributes = {}) {
  const spanName = `blockchain.${operation}`;
  const tracer = createModuleTracer('substream-backend');
  const span = tracer.startSpan(spanName);

  const baseAttributes = {
    'blockchain.network': network,
    'blockchain.operation': operation,
    ...attributes,
  };

  span.setAttributes(baseAttributes);

  return {
    span,
    recordTxHash: (txHash) => span.setAttribute('blockchain.tx_hash', txHash),
    recordLedger: (ledgerNum) => span.setAttribute('blockchain.ledger', ledgerNum),
    recordError: (error, code) => {
      span.recordException(error);
      if (code) {
        span.setAttribute('blockchain.error_code', code);
      }
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    },
    end: () => span.end(),
  };
}

module.exports = {
  createModuleTracer,
  getTraceId,
  getSpanId,
  getTraceContextHeader,
  extractTraceContext,
  getTraceContextHeaders,
  traceAsync,
  traceSync,
  Traceable,
  createDbSpan,
  createHttpSpan,
  createCacheSpan,
  createQueueSpan,
  createBlockchainSpan,
};
