/**
 * Trace Context Propagation
 * Manages W3C Trace Context and B3 header propagation for cross-service calls
 */

const { context, trace } = require('@opentelemetry/api');
const { getTraceContextHeaders } = require('./tracingUtils');

/**
 * W3C Trace Context Propagator
 * Implements https://www.w3.org/TR/trace-context/
 */
class W3CTraceContextPropagator {
  /**
   * Extract trace context from headers
   * @param {Object} headers - HTTP headers
   * @returns {Object} - Trace context
   */
  static extract(headers) {
    if (!headers) return {};

    const traceparent = headers['traceparent'] || headers['trace-parent'];
    if (!traceparent) return {};

    // Format: 00-traceId-spanId-traceFlags
    const parts = traceparent.split('-');
    if (parts.length !== 4 || parts[0] !== '00') {
      return {};
    }

    return {
      version: parts[0],
      traceId: parts[1],
      spanId: parts[2],
      traceFlags: parts[3],
      tracestate: headers['tracestate'] || '',
    };
  }

  /**
   * Inject trace context into headers
   * @returns {Object} - Headers with trace context
   */
  static inject() {
    const span = trace.getActiveSpan();
    if (!span) return {};

    const spanContext = span.spanContext();
    const traceFlags = spanContext.traceFlags?.sampled ? '01' : '00';

    return {
      'traceparent': `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`,
      'tracestate': spanContext.tracestate || '',
    };
  }

  /**
   * Get propagation headers for outgoing requests
   * @returns {Object} - HTTP headers for propagation
   */
  static getHeaders() {
    return this.inject();
  }
}

/**
 * B3 Trace Context Propagator (for compatibility with Zipkin)
 */
class B3TraceContextPropagator {
  /**
   * Extract B3 trace context from headers
   * @param {Object} headers - HTTP headers
   * @returns {Object} - Trace context
   */
  static extract(headers) {
    if (!headers) return {};

    const b3 = headers['b3'];
    const b3TraceId = headers['x-b3-traceid'];
    const b3SpanId = headers['x-b3-spanid'];

    if (b3) {
      // Single header format: traceid-spanid-sampled-parentspanid
      const parts = b3.split('-');
      if (parts.length >= 2) {
        return {
          traceId: parts[0],
          spanId: parts[1],
          sampled: parts.length > 2 ? parts[2] === '1' : true,
          parentSpanId: parts.length > 3 ? parts[3] : undefined,
        };
      }
    }

    if (b3TraceId && b3SpanId) {
      // Multiple header format
      return {
        traceId: b3TraceId,
        spanId: b3SpanId,
        sampled: headers['x-b3-sampled'] === '1',
        parentSpanId: headers['x-b3-parentspanid'],
      };
    }

    return {};
  }

  /**
   * Inject B3 trace context into headers
   * @returns {Object} - B3 headers
   */
  static inject() {
    const span = trace.getActiveSpan();
    if (!span) return {};

    const spanContext = span.spanContext();
    const sampled = spanContext.traceFlags?.sampled ? '1' : '0';

    return {
      'x-b3-traceid': spanContext.traceId,
      'x-b3-spanid': spanContext.spanId,
      'x-b3-sampled': sampled,
    };
  }

  /**
   * Get B3 propagation headers
   * @returns {Object} - HTTP headers for propagation
   */
  static getHeaders() {
    return this.inject();
  }
}

/**
 * Multi-format propagator supporting both W3C and B3 formats
 */
class MultiFormatPropagator {
  /**
   * Extract trace context from headers (tries W3C first, then B3)
   * @param {Object} headers - HTTP headers
   * @returns {Object} - Trace context
   */
  static extract(headers) {
    if (!headers) return {};

    // Try W3C format first
    const w3cContext = W3CTraceContextPropagator.extract(headers);
    if (Object.keys(w3cContext).length > 0) {
      return { format: 'w3c', ...w3cContext };
    }

    // Fall back to B3 format
    const b3Context = B3TraceContextPropagator.extract(headers);
    if (Object.keys(b3Context).length > 0) {
      return { format: 'b3', ...b3Context };
    }

    return {};
  }

  /**
   * Inject trace context into headers (both W3C and B3 formats)
   * @param {Object} options - Options (format: 'w3c', 'b3', or 'both')
   * @returns {Object} - HTTP headers
   */
  static inject(options = {}) {
    const format = options.format || 'w3c';
    const headers = {};

    if (format === 'w3c' || format === 'both') {
      Object.assign(headers, W3CTraceContextPropagator.inject());
    }

    if (format === 'b3' || format === 'both') {
      Object.assign(headers, B3TraceContextPropagator.inject());
    }

    return headers;
  }

  /**
   * Get headers for outgoing requests
   * @param {Object} options - Options (format: 'w3c', 'b3', or 'both')
   * @returns {Object} - HTTP headers
   */
  static getHeaders(options = {}) {
    return this.inject(options);
  }
}

/**
 * Create axios interceptor for trace propagation
 * @param {Object} axiosInstance - Axios instance
 * @param {Object} options - Propagator options
 */
function setupAxiosTracing(axiosInstance, options = {}) {
  axiosInstance.interceptors.request.use((config) => {
    const propagateFormat = options.format || 'w3c';
    const headers = MultiFormatPropagator.getHeaders({ format: propagateFormat });
    config.headers = { ...config.headers, ...headers };

    // Store timing info
    config.metadata = {
      startTime: Date.now(),
      url: config.url,
      method: config.method,
    };

    return config;
  });

  axiosInstance.interceptors.response.use(
    (response) => {
      if (response.config.metadata) {
        const duration = Date.now() - response.config.metadata.startTime;
        response.config.metadata.duration = duration;
      }
      return response;
    },
    (error) => {
      if (error.config?.metadata) {
        const duration = Date.now() - error.config.metadata.startTime;
        error.config.metadata.duration = duration;
      }
      throw error;
    }
  );

  return axiosInstance;
}

/**
 * Create fetch wrapper for trace propagation
 * @param {Object} options - Options
 * @returns {Function} - Wrapped fetch function
 */
function createTracedFetch(options = {}) {
  const propagateFormat = options.format || 'w3c';

  return async function tracedFetch(url, fetchOptions = {}) {
    const headers = MultiFormatPropagator.getHeaders({ format: propagateFormat });
    const finalOptions = {
      ...fetchOptions,
      headers: {
        ...fetchOptions.headers,
        ...headers,
      },
    };

    return fetch(url, finalOptions);
  };
}

/**
 * Attach trace context to HTTP client request options
 * @param {Object} options - Existing request options
 * @param {string} format - Trace format ('w3c', 'b3', or 'both')
 * @returns {Object} - Updated options with trace headers
 */
function attachTraceContext(options = {}, format = 'w3c') {
  const headers = MultiFormatPropagator.getHeaders({ format });
  return {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...headers,
    },
  };
}

/**
 * Extract correlation ID from request
 * @param {Object} req - Express request or similar
 * @returns {string} - Correlation ID or generated UUID
 */
function getCorrelationId(req) {
  if (!req) return undefined;

  return (
    req.get?.('x-correlation-id') ||
    req.headers?.['x-correlation-id'] ||
    req.correlationId
  );
}

/**
 * Create headers object with both trace context and correlation ID
 * @param {string} correlationId - Correlation ID
 * @param {string} format - Trace format
 * @returns {Object} - Complete headers object
 */
function getContextHeaders(correlationId, format = 'w3c') {
  const headers = {
    ...MultiFormatPropagator.getHeaders({ format }),
  };

  if (correlationId) {
    headers['x-correlation-id'] = correlationId;
  }

  return headers;
}

module.exports = {
  W3CTraceContextPropagator,
  B3TraceContextPropagator,
  MultiFormatPropagator,
  setupAxiosTracing,
  createTracedFetch,
  attachTraceContext,
  getCorrelationId,
  getContextHeaders,
};
