const cors = require('cors');

/**
 * Dynamic CORS middleware that restricts access based on merchant-whitelisted domains.
 */
class MerchantCorsMiddleware {
  /**
   * @param {object} database AppDatabase instance
   */
  constructor(database) {
    this.database = database;
    this.cache = new Map();
    this.cacheTimeout = 60 * 1000; // 1 minute cache for performance
  }

  /**
   * Get the CORS options delegate for Express.
   */
  corsOptionsDelegate() {
    return async (req, callback) => {
      let corsOptions = { origin: false }; // Default: deny
      
      try {
        const origin = req.header('Origin');
        const merchantId = this.extractMerchantId(req);

        // If no origin, it's not a cross-origin request (e.g. server-to-server or curl)
        // Note: For strict security, you might want to require an origin if you expect browser clients.
        if (!origin) {
          corsOptions = { origin: true };
          return callback(null, corsOptions);
        }

        // If no merchant ID identified, use global defaults or deny
        if (!merchantId) {
          // You might allow public origins for some routes, or just deny all unknown
          corsOptions = { origin: process.env.NODE_ENV === 'development' };
          return callback(null, corsOptions);
        }

        const allowedOrigins = await this.getAllowedOrigins(merchantId);

        if (allowedOrigins && (allowedOrigins.includes(origin) || allowedOrigins.includes('*'))) {
          corsOptions = { 
            origin: true,
            credentials: true,
            methods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
            allowedHeaders: 'Content-Type,Authorization,X-Merchant-ID,X-Requested-With,Accept'
          };
        } else {
          corsOptions = { origin: false };
        }
      } catch (error) {
        console.error('Merchant CORS middleware error:', error);
        corsOptions = { origin: false };
      }

      callback(null, corsOptions);
    };
  }

  /**
   * Extract merchant ID from request.
   * Checks header, query param, and path.
   */
  extractMerchantId(req) {
    // 1. Check custom header
    const headerId = req.header('X-Merchant-ID');
    if (headerId) return headerId;

    // 2. Check query parameter
    if (req.query && req.query.merchantId) return req.query.merchantId;

    // 3. Check path (e.g. /api/v1/merchants/:id/...)
    const merchantIdMatch = req.path.match(/\/api\/(?:v\d+\/)?merchants\/([^\/]+)/);
    if (merchantIdMatch && merchantIdMatch[1]) return merchantIdMatch[1];

    return null;
  }

  /**
   * Get allowed origins for a merchant from database with caching.
   */
  async getAllowedOrigins(merchantId) {
    const cached = this.cache.get(merchantId);
    if (cached && (Date.now() - cached.timestamp < this.cacheTimeout)) {
      return cached.origins;
    }

    try {
      const merchant = this.database.getMerchantById(merchantId);
      if (!merchant) return null;

      let origins = [];
      if (merchant.allowed_origins) {
        try {
          origins = JSON.parse(merchant.allowed_origins);
        } catch (e) {
          // If not a JSON array, maybe it's a comma-separated string
          origins = merchant.allowed_origins.split(',').map(o => o.trim());
        }
      }

      this.cache.set(merchantId, {
        origins,
        timestamp: Date.now()
      });

      return origins;
    } catch (error) {
      console.error(`Database error fetching merchant ${merchantId}:`, error);
      return null;
    }
  }
}

module.exports = { MerchantCorsMiddleware };
