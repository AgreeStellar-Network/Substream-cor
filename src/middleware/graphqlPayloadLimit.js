/**
 * GraphQL Payload Size Limit Middleware
 * Specialized middleware for GraphQL query complexity and payload size limits
 */
class GraphQLPayloadLimitMiddleware {
  constructor(options = {}) {
    this.maxQueryLength = options.maxQueryLength || 10000; // Max GraphQL query string length
    this.maxVariablesSize = options.maxVariablesSize || 1024 * 1024; // 1MB for variables
    this.maxQueryDepth = options.maxQueryDepth || 10; // Maximum query depth
    this.maxComplexity = options.maxComplexity || 1000; // Maximum query complexity points
    this.enableLogging = options.enableLogging !== false;
  }

  /**
   * Express middleware for GraphQL requests
   */
  middleware() {
    return (req, res, next) => {
      if (!req.path.includes('/graphql') && !req.path.includes('/graphiql')) {
        return next();
      }

      try {
        const body = req.body;
        
        if (!body || typeof body !== 'object') {
          return res.status(400).json({
            error: 'Invalid GraphQL Request',
            message: 'Request body must be a valid object'
          });
        }

        // Validate query length
        if (body.query && typeof body.query === 'string') {
          if (body.query.length > this.maxQueryLength) {
            const error = {
              error: 'GraphQL Query Too Large',
              message: `Query length (${body.query.length} chars) exceeds maximum allowed (${this.maxQueryLength} chars)`,
              maxLength: this.maxQueryLength,
              receivedLength: body.query.length
            };

            if (this.enableLogging) {
              console.warn('[GraphQL] Query length violation:', {
                ip: req.ip,
                path: req.path,
                ...error
              });
            }

            return res.status(413).json(error);
          }

          // Analyze query complexity
          const complexityAnalysis = this.analyzeQueryComplexity(body.query);
          if (complexityAnalysis.depth > this.maxQueryDepth) {
            const error = {
              error: 'GraphQL Query Too Complex',
              message: `Query depth (${complexityAnalysis.depth}) exceeds maximum allowed (${this.maxQueryDepth})`,
              maxDepth: this.maxQueryDepth,
              receivedDepth: complexityAnalysis.depth
            };

            return res.status(413).json(error);
          }

          if (complexityAnalysis.complexity > this.maxComplexity) {
            const error = {
              error: 'GraphQL Query Too Complex',
              message: `Query complexity (${complexityAnalysis.complexity}) exceeds maximum allowed (${this.maxComplexity})`,
              maxComplexity: this.maxComplexity,
              receivedComplexity: complexityAnalysis.complexity
            };

            return res.status(413).json(error);
          }
        }

        // Validate variables size
        if (body.variables) {
          const variablesSize = JSON.stringify(body.variables).length;
          if (variablesSize > this.maxVariablesSize) {
            const error = {
              error: 'GraphQL Variables Too Large',
              message: `Variables size (${variablesSize} bytes) exceeds maximum allowed (${this.maxVariablesSize} bytes)`,
              maxSize: this.maxVariablesSize,
              receivedSize: variablesSize
            };

            return res.status(413).json(error);
          }
        }

        if (this.enableLogging) {
          console.log(`[GraphQL] Validated request - Query: ${body.query?.length || 0} chars, Variables: ${JSON.stringify(body.variables || {}).length} bytes`);
        }

        next();
      } catch (error) {
        console.error('[GraphQL] Payload validation error:', error);
        return res.status(500).json({
          error: 'GraphQL Validation Error',
          message: 'Failed to validate GraphQL request'
        });
      }
    };
  }

  /**
   * Analyze GraphQL query complexity
   * This is a simplified analysis - in production you might want to use a more sophisticated library
   */
  analyzeQueryComplexity(query) {
    const analysis = {
      depth: 0,
      complexity: 0
    };

    try {
      // Simple depth analysis by counting nested braces
      let currentDepth = 0;
      let maxDepth = 0;
      
      for (let i = 0; i < query.length; i++) {
        const char = query[i];
        if (char === '{') {
          currentDepth++;
          maxDepth = Math.max(maxDepth, currentDepth);
        } else if (char === '}') {
          currentDepth--;
        }
      }
      
      analysis.depth = maxDepth;

      // Simple complexity calculation based on field count and depth
      const fieldMatches = query.match(/\w+\s*{/g) || [];
      const fieldCount = fieldMatches.length;
      
      // Complexity = base field count + depth penalty
      analysis.complexity = fieldCount + (maxDepth * 10);

      // Add penalty for potential expensive operations
      const expensiveOperations = ['connection', 'edges', 'node', 'subscriptions', 'transactions'];
      for (const operation of expensiveOperations) {
        if (query.toLowerCase().includes(operation)) {
          analysis.complexity += 50;
        }
      }

    } catch (error) {
      console.error('[GraphQL] Complexity analysis failed:', error);
      // Default to high complexity if analysis fails
      analysis.complexity = this.maxComplexity + 1;
    }

    return analysis;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig) {
    Object.assign(this, newConfig);
  }
}

module.exports = { GraphQLPayloadLimitMiddleware };
