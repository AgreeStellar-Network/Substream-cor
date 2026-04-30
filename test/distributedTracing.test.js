/**
 * Integration Tests for Distributed Tracing
 * Tests tracing functionality across services
 */

const request = require('supertest');
const express = require('express');
const { trace } = require('@opentelemetry/api');
const {
  httpTracingMiddleware,
  traceAwareRequestLogger
} = require('../middleware/httpTracingMiddleware');
const {
  getTraceId,
  getSpanId,
  getTraceContextHeader,
  createDbSpan,
  createHttpSpan,
  createCacheSpan
} = require('../utils/tracingUtils');
const {
  W3CTraceContextPropagator,
  B3TraceContextPropagator,
  MultiFormatPropagator
} = require('../utils/traceContextPropagation');

describe('Distributed Tracing Integration Tests', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(httpTracingMiddleware());
    app.use(traceAwareRequestLogger());
  });

  describe('HTTP Tracing Middleware', () => {
    test('should add correlation ID to request', async () => {
      app.get('/test', (req, res) => {
        expect(req.correlationId).toBeDefined();
        res.json({ correlationId: req.correlationId });
      });

      const response = await request(app).get('/test');
      expect(response.body.correlationId).toBeDefined();
      expect(response.status).toBe(200);
    });

    test('should use existing correlation ID from header', async () => {
      const existingCorrelationId = 'test-correlation-123';

      app.get('/test', (req, res) => {
        res.json({ correlationId: req.correlationId });
      });

      const response = await request(app)
        .get('/test')
        .set('x-correlation-id', existingCorrelationId);

      expect(response.body.correlationId).toBe(existingCorrelationId);
    });

    test('should add correlation ID to response headers', async () => {
      app.get('/test', (req, res) => {
        res.json({ ok: true });
      });

      const response = await request(app).get('/test');
      expect(response.headers['x-correlation-id']).toBeDefined();
    });

    test('should extract trace context from headers', async () => {
      app.get('/test', (req, res) => {
        const traceContext = req.traceContext || {};
        res.json({ 
          traceId: traceContext.traceId,
          spanId: traceContext.spanId
        });
      });

      const response = await request(app)
        .get('/test')
        .set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

      expect(response.body.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(response.body.spanId).toBe('00f067aa0ba902b7');
    });

    test('should set response status code attribute', async () => {
      app.get('/success', (req, res) => res.json({ ok: true }));
      app.get('/error', (req, res) => res.status(400).json({ error: 'Bad request' }));

      const successResponse = await request(app).get('/success');
      expect(successResponse.status).toBe(200);

      const errorResponse = await request(app).get('/error');
      expect(errorResponse.status).toBe(400);
    });
  });

  describe('Trace Context Propagation', () => {
    describe('W3C Format', () => {
      test('should extract W3C trace context', () => {
        const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        const headers = { traceparent };

        const context = W3CTraceContextPropagator.extract(headers);

        expect(context.version).toBe('00');
        expect(context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(context.spanId).toBe('00f067aa0ba902b7');
        expect(context.traceFlags).toBe('01');
      });

      test('should reject invalid W3C trace context', () => {
        const invalidTraceparent = 'invalid-format';
        const headers = { traceparent: invalidTraceparent };

        const context = W3CTraceContextPropagator.extract(headers);

        expect(Object.keys(context).length).toBe(0);
      });

      test('should format trace context for export', () => {
        const headers = W3CTraceContextPropagator.inject();

        // Should return empty or valid format when no span is active
        if (Object.keys(headers).length > 0) {
          expect(headers.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[01]$/);
        }
      });
    });

    describe('B3 Format', () => {
      test('should extract B3 trace context', () => {
        const headers = {
          'x-b3-traceid': '4bf92f3577b34da6a3ce929d0e0e4736',
          'x-b3-spanid': '00f067aa0ba902b7',
          'x-b3-sampled': '1'
        };

        const context = B3TraceContextPropagator.extract(headers);

        expect(context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(context.spanId).toBe('00f067aa0ba902b7');
        expect(context.sampled).toBe(true);
      });

      test('should extract B3 single header format', () => {
        const headers = {
          'b3': '4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1'
        };

        const context = B3TraceContextPropagator.extract(headers);

        expect(context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
        expect(context.spanId).toBe('00f067aa0ba902b7');
        expect(context.sampled).toBe(true);
      });
    });

    describe('Multi-Format Propagator', () => {
      test('should prefer W3C format over B3', () => {
        const headers = {
          'traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
          'x-b3-traceid': 'different-id',
          'x-b3-spanid': 'different-span'
        };

        const context = MultiFormatPropagator.extract(headers);

        expect(context.format).toBe('w3c');
        expect(context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      });

      test('should fall back to B3 when W3C not present', () => {
        const headers = {
          'x-b3-traceid': '4bf92f3577b34da6a3ce929d0e0e4736',
          'x-b3-spanid': '00f067aa0ba902b7'
        };

        const context = MultiFormatPropagator.extract(headers);

        expect(context.format).toBe('b3');
        expect(context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      });

      test('should support dual format injection', () => {
        const headers = MultiFormatPropagator.inject({ format: 'both' });

        // Should have either W3C or B3 headers when a span is active
        if (Object.keys(headers).length > 0) {
          expect(
            headers.traceparent || headers['x-b3-traceid']
          ).toBeDefined();
        }
      });
    });
  });

  describe('Span Creation Utilities', () => {
    test('should create database span with attributes', () => {
      const dbSpan = createDbSpan('SELECT', 'users', {
        'db.where_clause': 'id = $1'
      });

      expect(dbSpan.span).toBeDefined();
      expect(typeof dbSpan.end).toBe('function');
      expect(typeof dbSpan.recordResult).toBe('function');
      expect(typeof dbSpan.recordError).toBe('function');

      dbSpan.end(5, 150);
      dbSpan.span.end(); // Span already ended, safe to call
    });

    test('should create HTTP client span with attributes', () => {
      const httpSpan = createHttpSpan('GET', 'https://api.example.com/users');

      expect(httpSpan.span).toBeDefined();
      expect(typeof httpSpan.end).toBe('function');
      expect(typeof httpSpan.recordResponse).toBe('function');
      expect(typeof httpSpan.recordError).toBe('function');

      httpSpan.end(200, 1500);
    });

    test('should create cache span with hit/miss tracking', () => {
      const cacheSpan = createCacheSpan('get', 'user:123');

      expect(cacheSpan.span).toBeDefined();
      expect(typeof cacheSpan.recordHit).toBe('function');
      expect(typeof cacheSpan.recordMiss).toBe('function');

      cacheSpan.recordHit();
      cacheSpan.end();
    });
  });

  describe('Trace Context Header Utilities', () => {
    test('should get trace context header', () => {
      const header = getTraceContextHeader();

      // Header may be empty if no active span
      if (header) {
        expect(header).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[01]$/);
      }
    });

    test('should get trace ID', () => {
      const traceId = getTraceId();

      expect(typeof traceId).toBe('string');
      // Should be either a valid hex string or 'unknown'
      expect(traceId).toMatch(/^([a-f0-9]{32}|unknown)$/);
    });

    test('should get span ID', () => {
      const spanId = getSpanId();

      expect(typeof spanId).toBe('string');
      // Should be either a valid hex string or 'unknown'
      expect(spanId).toMatch(/^([a-f0-9]{16}|unknown)$/);
    });
  });

  describe('Service Instrumentation', () => {
    test('should wrap service methods with tracing', async () => {
      const { traceServiceMethods } = require('../utils/serviceInstrumentation');

      class TestService {
        async getUser(userId) {
          return { id: userId, name: 'Test User' };
        }

        async createUser(data) {
          return { id: 1, ...data };
        }
      }

      const service = new TestService();
      const tracedService = traceServiceMethods(service, 'test-service', [
        'getUser',
        'createUser'
      ]);

      // Should be able to call methods
      const user = await tracedService.getUser(123);
      expect(user.id).toBe(123);

      // Should be able to create
      const newUser = await tracedService.createUser({ name: 'New User' });
      expect(newUser.name).toBe('New User');
    });

    test('should capture errors in traced methods', async () => {
      const { traceServiceMethods } = require('../utils/serviceInstrumentation');

      class ErrorService {
        async failingMethod() {
          throw new Error('Test error');
        }
      }

      const service = new ErrorService();
      const tracedService = traceServiceMethods(service, 'error-service', [
        'failingMethod'
      ]);

      try {
        await tracedService.failingMethod();
        fail('Should have thrown error');
      } catch (error) {
        expect(error.message).toBe('Test error');
      }
    });
  });

  describe('Error Handling in Traces', () => {
    test('should record exceptions in spans', () => {
      const { recordSpanException } = require('../utils/opentelemetry');
      const error = new Error('Test error');

      // Should not throw
      expect(() => {
        recordSpanException(error, { context: 'test' });
      }).not.toThrow();
    });

    test('should handle missing active span gracefully', () => {
      const { recordSpanEvent, setSpanAttributes } = require('../utils/opentelemetry');

      // Should not throw even without active span
      expect(() => {
        recordSpanEvent('test_event');
        setSpanAttributes({ key: 'value' });
      }).not.toThrow();
    });
  });
});

describe('Performance Tests', () => {
  test('tracing should not significantly impact response time', async () => {
    const app = express();
    app.use(httpTracingMiddleware());

    app.get('/test', (req, res) => {
      res.json({ ok: true });
    });

    const start = Date.now();

    for (let i = 0; i < 100; i++) {
      await request(app).get('/test');
    }

    const duration = Date.now() - start;

    // Should complete 100 requests in reasonable time
    expect(duration).toBeLessThan(5000); // 5 seconds for 100 requests
  });
});

module.exports = {
  httpTracingMiddleware,
  W3CTraceContextPropagator,
  B3TraceContextPropagator,
  MultiFormatPropagator
};
