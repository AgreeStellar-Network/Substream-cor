const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { ConsoleSpanExporter, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { diag, DiagConsoleLogger, DiagLogLevel, context, trace } = require('@opentelemetry/api');

function parseOtlpHeaders(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') {
    return undefined;
  }

  return Object.fromEntries(
    headerValue
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => pair.split('=').map((value) => value.trim()))
      .filter((tuple) => tuple.length === 2)
  );
}

function createTraceExporter() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

  if (endpoint) {
    return new OTLPTraceExporter({ url: endpoint, headers });
  }

  return new ConsoleSpanExporter();
}

function getDiagLevel() {
  const level = (process.env.OTEL_DIAG_LEVEL || 'error').toUpperCase();
  return DiagLogLevel[level] || DiagLogLevel.ERROR;
}

function initTracing(options = {}) {
  if (process.env.OTEL_DISABLED === 'true' || global.__substreamOtelInitialized) {
    return;
  }

  diag.setLogger(new DiagConsoleLogger(), getDiagLevel());

  const serviceName = process.env.OTEL_SERVICE_NAME || options.serviceName || 'substream-protocol-backend';
  const serviceVersion = process.env.OTEL_SERVICE_VERSION || options.serviceVersion || '1.0.0';
  const deploymentEnvironment = process.env.NODE_ENV || 'development';

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: deploymentEnvironment,
    }),
    traceExporter: createTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingPaths: process.env.OTEL_IGNORE_PATHS ? process.env.OTEL_IGNORE_PATHS.split(',') : ['/health', '/metrics'],
          requestHook: (span, request) => {
            if (span && request) {
              span.setAttribute('http.client_ip', request.socket?.remoteAddress || 'unknown');
            }
          },
          responseHook: (span, response) => {
            if (span && response) {
              span.setAttribute('http.response_content_length', response.headers?.['content-length'] || 'unknown');
            }
          },
        },
        '@opentelemetry/instrumentation-express': {
          requestHook: (span, info) => {
            if (span && info) {
              span.setAttribute('http.route', info.route || info.request?.url || '/');
              span.setAttribute('http.method', info.request?.method || 'GET');
            }
          },
        },
        '@opentelemetry/instrumentation-pg': {
          enabled: true,
          responseHook: (span, result) => {
            if (span && result) {
              span.setAttribute('db.row_count', result.rowCount || 0);
            }
          },
        },
        '@opentelemetry/instrumentation-redis': {
          enabled: true,
          responseHook: (span, result) => {
            if (span && result) {
              span.setAttribute('redis.response', typeof result === 'string' ? result : 'OK');
            }
          },
        },
        '@opentelemetry/instrumentation-amqp': {
          enabled: true,
        },
      }),
    ],
  });

  Promise.resolve(sdk.start())
    .then(() => {
      console.log('[Tracing] OpenTelemetry initialized', {
        serviceName,
        serviceVersion,
        environment: deploymentEnvironment,
      });

      // Store SDK globally for span processor management
      global.__substreamOtelSdk = sdk;
    })
    .catch((error) => {
      console.error('[Tracing] Failed to initialize OpenTelemetry', error);
    });

  const shutdown = async () => {
    try {
      await sdk.shutdown();
      console.log('[Tracing] OpenTelemetry shutdown complete');
    } catch (error) {
      console.error('[Tracing] OpenTelemetry shutdown failed', error);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  global.__substreamOtelInitialized = true;
}

/**
 * Get the current active tracer
 * @param {string} moduleName - The name of the module/service
 * @returns {Tracer} - The OpenTelemetry tracer
 */
function getTracer(moduleName) {
  return trace.getTracer(moduleName, '1.0.0');
}

/**
 * Get the current trace context
 * @returns {Context} - The OpenTelemetry context
 */
function getContext() {
  return context.active();
}

/**
 * Create a new span and execute a function within that span's context
 * @param {string} spanName - The name of the span
 * @param {Function} fn - The function to execute within the span
 * @param {Object} attributes - Optional attributes to add to the span
 * @param {Object} options - Additional span options (kind, attributes)
 * @returns {*} - The return value of the function
 */
function withSpan(spanName, fn, attributes = {}, options = {}) {
  const tracer = getTracer('substream-backend');
  const span = tracer.startSpan(spanName, options);

  // Add attributes
  Object.keys(attributes).forEach((key) => {
    span.setAttributes({ [key]: attributes[key] });
  });

  try {
    return context.with(trace.setSpan(context.active(), span), () => {
      return fn(span);
    });
  } catch (error) {
    span.recordException(error);
    span.setStatus({ code: 2 }); // ERROR status code
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Add an event to the current active span
 * @param {string} eventName - The name of the event
 * @param {Object} attributes - Optional attributes for the event
 */
function recordSpanEvent(eventName, attributes = {}) {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(eventName, attributes);
  }
}

/**
 * Set attributes on the current active span
 * @param {Object} attributes - The attributes to set
 */
function setSpanAttributes(attributes) {
  const span = trace.getActiveSpan();
  if (span && attributes) {
    span.setAttributes(attributes);
  }
}

/**
 * Record an exception in the current active span
 * @param {Error} error - The error to record
 * @param {Object} attributes - Optional attributes
 */
function recordSpanException(error, attributes = {}) {
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(error);
    if (Object.keys(attributes).length > 0) {
      span.setAttributes(attributes);
    }
  }
}

module.exports = {
  initTracing,
  getTracer,
  getContext,
  withSpan,
  recordSpanEvent,
  setSpanAttributes,
  recordSpanException,
};
