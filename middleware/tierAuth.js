/**
 * @module middleware/tierAuth
 * @description Attaches subscription tier from the existing SubStream JWT
 * to every request, and provides a `requireTier` factory for gating routes.
 *
 * The JWT issued by routes/auth.js already carries an `address` and `tier`
 * field (set to 'bronze' on login). This middleware reads those fields so
 * the rest of the app never has to touch the token directly.
 *
 * Tier hierarchy (lowest → highest):
 *   guest  →  bronze  →  silver  →  gold
 *
 * Usage in routes:
 *   const { requireTier } = require('../middleware/tierAuth');
 *   router.get('/gold-only', requireTier('gold'), handler);
 */

const jwt = require('jsonwebtoken');

/** Ordered tier levels — array index is the tier's numeric rank. */
const TIER_LEVELS = ['guest', 'bronze', 'silver', 'gold'];

/**
 * Returns the numeric rank of a tier string.
 * Unknown or missing tiers fall back to 'guest' (rank 0).
 *
 * @param {string} tier
 * @returns {number}
 */
function tierRank(tier) {
  const idx = TIER_LEVELS.indexOf((tier || 'guest').toLowerCase());
  return idx === -1 ? 0 : idx;
}

/**
 * Global middleware — attaches `req.user = { address, tier }` to every request.
 *
 * - Valid JWT  →  req.user populated from token claims
 * - No token   →  req.user = { address: null, tier: 'guest' }
 * - Bad token  →  req.user = { address: null, tier: 'guest' }
 *
 * Never calls res.status(401) — downstream middleware decides whether a
 * guest is permitted on a given route.
 *
 * @type {import('express').RequestHandler}
 */
function attachTier(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    req.user = { address: null, tier: 'guest' };
    return next();
  }

  try {
    const secret = process.env.JWT_SECRET || 'dev-secret';
    const decoded = jwt.verify(token, secret);
    const tenantId = decoded.tenant_id || decoded.tenantId || decoded.organizationId || null;

    req.user = {
      // routes/auth.js stores the wallet address as `address`
      address: decoded.address || decoded.publicKey || decoded.sub || null,
      // routes/auth.js sets tier at login time; default to 'bronze' if missing
      tier: (decoded.tier || 'bronze').toLowerCase(),
      tenant_id: tenantId,
      email: decoded.email || null,
      role: decoded.role || null,
      permissions: Array.isArray(decoded.permissions) ? decoded.permissions : [],
    };
  } catch {
    // Expired or tampered token — treat as unauthenticated guest
    req.user = { address: null, tier: 'guest' };
  }

  next();
}

/**
 * Route-level middleware factory.
 * Returns a handler that rejects requests whose tier is below `minimumTier`.
 *
 * Must be used on routes that already have `attachTier` in the chain
 * (registered globally in index.js, so this is always true).
 *
 * On failure responds 403 with:
 *   - `error`   — human-readable message
 *   - `required` — the minimum tier needed
 *   - `current`  — the user's actual tier
 *   - `upgrade`  — a suggestion message for the frontend to display
 *   - `preview`  — null here; content routes populate this when applicable
 *
 * @param {'bronze'|'silver'|'gold'} minimumTier
 * @returns {import('express').RequestHandler}
 */
function requireTier(minimumTier) {
  return (req, res, next) => {
    const userRank = tierRank(req.user?.tier);
    const requiredRank = tierRank(minimumTier);

    if (userRank >= requiredRank) return next();

    return res.status(403).json({
      success: false,
      error: 'Insufficient subscription tier',
      required: minimumTier,
      current: req.user?.tier || 'guest',
      upgrade: buildUpgradeMessage(req.user?.tier, minimumTier),
      preview: null,
    });
  };
}

/**
 * Build a human-readable upgrade suggestion.
 *
 * @param {string} current   - User's current tier
 * @param {string} required  - Minimum tier needed
 * @returns {string}
 */
function buildUpgradeMessage(current, required) {
  const label = (t) => {
    const s = (t || 'guest').toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  return `Upgrade from ${label(current)} to ${label(required)} to access this content.`;
}

module.exports = { attachTier, requireTier, tierRank, TIER_LEVELS };