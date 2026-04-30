const express = require('express');
const router = express.Router();
const StellarAuthService = require('../services/stellarAuthService');
const { 
  generateStellarToken, 
  authenticateStellarToken, 
  switchWallet, 
  invalidateSession,
  validateAccountSessions,
  getSessionInfo,
  setAuthCookie,
  clearAuthCookie
} = require('../middleware/stellarAuth');

const stellarService = new StellarAuthService();

/**
 * Generate SEP-10 challenge for Stellar authentication
 * GET /auth/challenge?publicKey=...
 */
router.get('/challenge', async (req, res) => {
  try {
    const { publicKey } = req.query;
    
    if (!publicKey) {
      return res.status(400).json({
        success: false,
        error: 'Stellar public key required'
      });
    }

    // Validate public key format
    try {
      const { StellarSdk } = require('@stellar/stellar-sdk');
      StellarSdk.Keypair.fromPublicKey(publicKey);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Stellar public key format'
      });
    }

    const result = await stellarService.generateChallenge(publicKey);
    
    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('Challenge generation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate challenge'
    });
  }
});

/**
 * Verify SEP-10 challenge and authenticate
 * POST /auth/verify
 */
router.post('/verify', async (req, res) => {
  try {
    const { publicKey, challengeXDR } = req.body;
    
    if (!publicKey || !challengeXDR) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: publicKey, challengeXDR'
      });
    }

    // Verify the challenge
    const verification = await stellarService.verifyChallenge(challengeXDR, publicKey);

    if (!verification.success) {
      return res.status(400).json({
        success: false,
        error: verification.error
      });
    }

    // OFAC / global-sanctions screening — must complete BEFORE we issue a
    // JWT, otherwise a flagged wallet would have a valid token in the wild.
    const sanctionsService = req.app.get('sanctionsScreeningService');
    if (sanctionsService) {
      try {
        const screen = await sanctionsService.screenAddress(publicKey, {
          triggeringAction: 'sep10_verify',
          ipAddress: req.ip,
        });
        if (!screen.allowed) {
          return res.status(403).json({
            success: false,
            error: 'ACCOUNT_BLOCKED',
            message:
              'This wallet is blocked by sanctions screening. Contact compliance for review.',
            auditId: screen.auditId,
          });
        }
      } catch (screenError) {
        console.error('Sanctions screening error during SEP-10 verify:', screenError);
        // Treat unexpected service errors as fail-closed at the gate.
        return res.status(503).json({
          success: false,
          error: 'Sanctions screening unavailable; please retry shortly.',
        });
      }
    }

    // Determine user tier (in production, fetch from database)
    // For now, assign bronze tier to all users
    const userTier = 'bronze';
    
    // Generate JWT token
    const token = generateStellarToken(publicKey, userTier);
    
    // Set HttpOnly cookie
    setAuthCookie(res, token);
    
    res.json({
      success: true,
      token,
      user: {
        publicKey: publicKey.toLowerCase(),
        tier: userTier,
        type: 'stellar'
      },
      expiresIn: 86400 // 24 hours
    });

  } catch (error) {
    console.error('Stellar login error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

/**
 * Switch to a different Stellar wallet
 * POST /auth/stellar/switch
 */
router.post('/stellar/switch', authenticateStellarToken, async (req, res) => {
  try {
    const { newPublicKey, challengeXDR } = req.body;
    
    if (!newPublicKey || !challengeXDR) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: newPublicKey, challengeXDR'
      });
    }

    const oldPublicKey = req.user.publicKey;
    
    // Verify the new challenge
    const verification = await stellarService.verifyChallenge(challengeXDR, newPublicKey);
    
    if (!verification.success) {
      return res.status(400).json({
        success: false,
        error: verification.error
      });
    }

    // Switch wallet
    await switchWallet(oldPublicKey, newPublicKey);
    
    // Generate new token for the new wallet
    const userTier = req.user.tier; // Keep existing tier
    const newToken = generateStellarToken(newPublicKey, userTier);
    
    // Set new cookie
    setAuthCookie(res, newToken);
    
    res.json({
      success: true,
      token: newToken,
      user: {
        publicKey: newPublicKey.toLowerCase(),
        tier: userTier,
        type: 'stellar'
      },
      message: 'Wallet switched successfully'
    });

  } catch (error) {
    console.error('Wallet switch error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to switch wallet'
    });
  }
});

/**
 * Get current session information
 * GET /auth/stellar/session
 */
router.get('/stellar/session', authenticateStellarToken, (req, res) => {
  const sessionInfo = getSessionInfo(req.user.publicKey);
  
  res.json({
    success: true,
    session: sessionInfo
  });
});

/**
 * Logout and invalidate session
 * POST /auth/stellar/logout
 */
router.post('/stellar/logout', authenticateStellarToken, (req, res) => {
  try {
    invalidateSession(req.user.publicKey);
    clearAuthCookie(res);
    
    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to logout'
    });
  }
});

/**
 * Validate all active sessions (admin endpoint)
 * POST /auth/stellar/validate-sessions
 */
router.post('/stellar/validate-sessions', async (req, res) => {
  try {
    const invalidAccounts = await validateAccountSessions();
    
    res.json({
      success: true,
      invalidatedSessions: invalidAccounts,
      message: `Invalidated ${invalidAccounts.length} sessions for inactive/merged accounts`
    });

  } catch (error) {
    console.error('Session validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate sessions'
    });
  }
});

/**
 * Get challenge status
 * GET /auth/stellar/challenge-status?publicKey=...
 */
router.get('/stellar/challenge-status', (req, res) => {
  try {
    const { publicKey } = req.query;
    
    if (!publicKey) {
      return res.status(400).json({
        success: false,
        error: 'Public key required'
      });
    }

    const status = stellarService.getChallengeStatus(publicKey);
    
    res.json({
      success: true,
      status
    });

  } catch (error) {
    console.error('Challenge status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get challenge status'
    });
  }
});

module.exports = router;
