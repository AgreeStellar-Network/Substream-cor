/**
 * sanctionsBlock middleware
 *
 * Rejects every authenticated request whose underlying wallet is BLOCKED by
 * the sanctions screening pipeline. Designed to be the cheapest possible
 * gate — relies on the SanctionsScreeningService's in-process LRU cache so
 * a typical hit is a single Map lookup, not a DB query.
 *
 * Mount AFTER the auth middleware (so req.user is populated) on every route
 * we want structurally protected, e.g.
 *
 *   app.use('/api', authenticateToken);
 *   app.use('/api', createSanctionsBlockMiddleware({ service: sanctionsScreeningService }));
 *
 * Non-authenticated requests are passed through — they are screened at SEP-10
 * verify time before they ever get a token.
 */
function createSanctionsBlockMiddleware({ service, getWalletAddress } = {}) {
  if (!service) {
    throw new Error(
      'createSanctionsBlockMiddleware: service (SanctionsScreeningService) is required'
    );
  }
  const extract = getWalletAddress || defaultExtract;

  return function sanctionsBlockMiddleware(req, res, next) {
    let walletAddress;
    try {
      walletAddress = extract(req);
    } catch (_e) {
      walletAddress = null;
    }

    if (!walletAddress) {
      return next();
    }

    let blocked;
    try {
      blocked = service.isBlocked(walletAddress);
    } catch (err) {
      // Don't fail-closed on a DB hiccup — log and continue. The screening
      // step at SEP-10 verify is the authoritative gate; this middleware is
      // a defence-in-depth net.
      // eslint-disable-next-line no-console
      console.warn(
        '[sanctionsBlock] isBlocked check failed:',
        err && err.message ? err.message : err
      );
      return next();
    }

    if (blocked) {
      return res.status(403).json({
        success: false,
        error: 'ACCOUNT_BLOCKED',
        message:
          'This account is blocked due to sanctions screening. Contact the compliance officer to request a review.',
      });
    }

    return next();
  };
}

function defaultExtract(req) {
  if (!req || !req.user) return null;
  return req.user.walletAddress || req.user.publicKey || req.user.address || null;
}

module.exports = {
  createSanctionsBlockMiddleware,
};
