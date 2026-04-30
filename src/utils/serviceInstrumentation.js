/**
 * Service Instrumentation Factory
 * Provides mixin/wrapper functions to add tracing to service methods
 */

const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const { createModuleTracer } = require('./tracingUtils');

/**
 * Service class wrapper for automatic method tracing
 * @param {Class} ServiceClass - The service class to wrap
 * @param {string} serviceName - Name of the service for tracing
 * @returns {Proxy} - Proxied service with tracing
 */
function createTracedService(ServiceClass, serviceName) {
  const tracer = createModuleTracer(serviceName);

  return new Proxy(ServiceClass, {
    construct(target, args) {
      const instance = new target(...args);

      return new Proxy(instance, {
        get(targetInstance, prop) {
          const original = targetInstance[prop];

          // Only wrap functions
          if (typeof original !== 'function') {
            return original;
          }

          // Return wrapped function
          return function tracedMethod(...methodArgs) {
            const methodName = `${serviceName}.${String(prop)}`;
            const span = tracer.startSpan(methodName, {
              attributes: {
                'service.name': serviceName,
                'service.method': String(prop),
              },
            });

            try {
              const result = context.with(trace.setSpan(context.active(), span), () => {
                return original.apply(targetInstance, methodArgs);
              });

              // Handle promises
              if (result instanceof Promise) {
                return result
                  .then((value) => {
                    span.setStatus({ code: SpanStatusCode.OK });
                    return value;
                  })
                  .catch((error) => {
                    span.recordException(error);
                    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                    throw error;
                  })
                  .finally(() => span.end());
              }

              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            } catch (error) {
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
              throw error;
            } finally {
              if (!(result instanceof Promise)) {
                span.end();
              }
            }
          };
        },
      });
    },
  });
}

/**
 * Wrap individual service methods with tracing
 * @param {Object} service - Service instance
 * @param {string} serviceName - Service name for tracing
 * @param {string[]} methodNames - Methods to trace
 * @returns {Object} - Service with wrapped methods
 */
function traceServiceMethods(service, serviceName, methodNames) {
  const tracer = createModuleTracer(serviceName);

  methodNames.forEach((methodName) => {
    if (typeof service[methodName] !== 'function') {
      return;
    }

    const originalMethod = service[methodName];

    service[methodName] = function tracedMethod(...args) {
      const spanName = `${serviceName}.${methodName}`;
      const span = tracer.startSpan(spanName, {
        attributes: {
          'service.name': serviceName,
          'service.method': methodName,
        },
      });

      try {
        const result = context.with(trace.setSpan(context.active(), span), () => {
          return originalMethod.apply(this, args);
        });

        // Handle promises
        if (result instanceof Promise) {
          return result
            .then((value) => {
              span.setStatus({ code: SpanStatusCode.OK });
              return value;
            })
            .catch((error) => {
              span.recordException(error);
              span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
              throw error;
            })
            .finally(() => span.end());
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw error;
      } finally {
        if (!(result instanceof Promise)) {
          span.end();
        }
      }
    };
  });

  return service;
}

/**
 * Create tracing for authentication operations
 * @returns {Object} - Tracing utilities for auth
 */
function createAuthTracing() {
  const tracer = createModuleTracer('auth-service');

  return {
    traceGenerateToken: (userId, tokenType = 'access') => {
      const span = tracer.startSpan('auth.generate_token', {
        attributes: {
          'auth.token_type': tokenType,
          'auth.user_id': userId,
        },
      });

      return {
        span,
        end: () => span.end(),
        recordTokenGeneration: (expiresIn) => {
          span.setAttribute('auth.token_expires_in', expiresIn);
        },
      };
    },

    traceVerifyToken: (tokenType = 'access') => {
      const span = tracer.startSpan('auth.verify_token', {
        attributes: {
          'auth.token_type': tokenType,
        },
      });

      return {
        span,
        end: () => span.end(),
        recordTokenValid: (userId, claims) => {
          span.setAttributes({
            'auth.user_id': userId,
            'auth.token_claims': JSON.stringify(claims || {}),
          });
        },
        recordTokenInvalid: (reason) => {
          span.setAttribute('auth.token_invalid_reason', reason);
          span.setStatus({ code: SpanStatusCode.ERROR, message: `Invalid token: ${reason}` });
        },
      };
    },

    traceLogin: (address) => {
      const span = tracer.startSpan('auth.login', {
        attributes: {
          'auth.address': address,
        },
      });

      return {
        span,
        end: () => span.end(),
        recordSuccess: () => {
          span.setStatus({ code: SpanStatusCode.OK });
        },
        recordFailure: (reason) => {
          span.setAttribute('auth.login_failure_reason', reason);
          span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        },
      };
    },
  };
}

/**
 * Create tracing for database operations
 * @returns {Object} - Tracing utilities for database
 */
function createDatabaseTracing() {
  const tracer = createModuleTracer('database-service');

  return {
    traceQuery: (operation, table, query) => {
      const span = tracer.startSpan(`db.${operation.toLowerCase()}`, {
        attributes: {
          'db.system': 'postgresql',
          'db.operation': operation,
          'db.table': table,
          'db.statement': query.substring(0, 500), // Limit length
        },
      });

      const startTime = Date.now();

      return {
        span,
        end: (rowCount = 0) => {
          const duration = Date.now() - startTime;
          span.setAttributes({
            'db.rows_affected': rowCount,
            'db.duration_ms': duration,
          });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        },
        error: (err) => {
          const duration = Date.now() - startTime;
          span.recordException(err);
          span.setAttributes({
            'db.error_message': err.message,
            'db.error_code': err.code,
            'db.duration_ms': duration,
          });
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          span.end();
        },
      };
    },

    traceTransaction: (name) => {
      const span = tracer.startSpan(`db.transaction`, {
        attributes: {
          'db.transaction_name': name,
        },
      });

      return {
        span,
        end: () => {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        },
        error: (err) => {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          span.end();
        },
      };
    },
  };
}

/**
 * Create tracing for cache operations
 * @returns {Object} - Tracing utilities for cache
 */
function createCacheTracing() {
  const tracer = createModuleTracer('cache-service');

  return {
    traceGet: (key) => {
      const span = tracer.startSpan('cache.get', {
        attributes: {
          'cache.key': key,
          'cache.operation': 'get',
        },
      });

      return {
        span,
        end: (hit, value = null) => {
          span.setAttributes({
            'cache.hit': hit,
            'cache.value_size': value ? JSON.stringify(value).length : 0,
          });
          span.end();
        },
      };
    },

    traceSet: (key, ttl) => {
      const span = tracer.startSpan('cache.set', {
        attributes: {
          'cache.key': key,
          'cache.operation': 'set',
          'cache.ttl_seconds': ttl || -1,
        },
      });

      return {
        span,
        end: () => span.end(),
        error: (err) => {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        },
      };
    },

    traceDel: (key) => {
      const span = tracer.startSpan('cache.delete', {
        attributes: {
          'cache.key': key,
        },
      });

      return {
        span,
        end: () => span.end(),
      };
    },
  };
}

/**
 * Create tracing for queue operations
 * @returns {Object} - Tracing utilities for queues
 */
function createQueueTracing() {
  const tracer = createModuleTracer('queue-service');

  return {
    tracePublish: (queue, messageType) => {
      const span = tracer.startSpan('queue.publish', {
        attributes: {
          'queue.name': queue,
          'queue.operation': 'publish',
          'queue.message_type': messageType,
        },
      });

      return {
        span,
        end: (messageId) => {
          if (messageId) {
            span.setAttribute('queue.message_id', messageId);
          }
          span.end();
        },
        error: (err) => {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        },
      };
    },

    traceConsume: (queue, messageType) => {
      const span = tracer.startSpan('queue.consume', {
        attributes: {
          'queue.name': queue,
          'queue.operation': 'consume',
          'queue.message_type': messageType,
        },
      });

      const startTime = Date.now();

      return {
        span,
        end: () => {
          span.setAttribute('queue.processing_time_ms', Date.now() - startTime);
          span.end();
        },
        error: (err) => {
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        },
      };
    },
  };
}

/**
 * Create tracing for HTTP client calls
 * @returns {Object} - Tracing utilities for HTTP clients
 */
function createHttpClientTracing() {
  const tracer = createModuleTracer('http-client');

  return {
    traceRequest: (method, url, service = 'external') => {
      const span = tracer.startSpan(`http.client.${method.toLowerCase()}`, {
        attributes: {
          'http.method': method,
          'http.url': url,
          'http.service': service,
        },
      });

      const startTime = Date.now();

      return {
        span,
        end: (statusCode, responseSize = 0) => {
          const duration = Date.now() - startTime;
          span.setAttributes({
            'http.status_code': statusCode,
            'http.duration_ms': duration,
            'http.response_size': responseSize,
          });

          if (statusCode >= 400) {
            span.setStatus({
              code: statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
              message: `HTTP ${statusCode}`,
            });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }

          span.end();
        },
        error: (err, statusCode) => {
          const duration = Date.now() - startTime;
          span.recordException(err);
          span.setAttributes({
            'http.error': err.message,
            'http.status_code': statusCode || 0,
            'http.duration_ms': duration,
          });
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
        },
      };
    },
  };
}

module.exports = {
  createTracedService,
  traceServiceMethods,
  createAuthTracing,
  createDatabaseTracing,
  createCacheTracing,
  createQueueTracing,
  createHttpClientTracing,
};
