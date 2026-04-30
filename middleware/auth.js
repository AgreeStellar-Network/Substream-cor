const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');
const { AuthService } = require('../src/services/auth.service');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Initialize enhanced authentication service
const authService = new AuthService();

// Generate nonce for SIWE
const generateNonce = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

// Store nonces (in production, use Redis)
const nonces = new Map();

// Verify SIWE signature
const verifySignature = (message, signature, address) => {
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === address.toLowerCase();
  } catch (error) {
    return false;
  }
};

// Generate JWT token (using enhanced service)
const generateToken = (address, tier = 'bronze') => {
  const member = {
    id: address.toLowerCase(),
    email: `${address.toLowerCase()}@example.com`,
    organizationId: 'default',
    role: 'user',
    permissions: ['read']
  };
  
  return authService.generateAccessToken(member);
};

// Generate refresh token
const generateRefreshToken = (address) => {
  return authService.generateRefreshToken(address.toLowerCase(), null);
};

// Enhanced JWT verification middleware with rotation support
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'Access token required' 
    });
  }

  try {
    const payload = authService.verifyAccessToken(token);
    
    // Check if token needs rotation
    if (authService.shouldRotateToken(token)) {
      // Add rotation hint to response headers
      res.set('X-Token-Rotation-Required', 'true');
    }
    
    req.user = {
      id: payload.sub,
      email: payload.email,
      organizationId: payload.organizationId,
      role: payload.role,
      permissions: payload.permissions,
      sessionId: payload.sessionId,
      jti: payload.jti
    };
    
    next();
  } catch (error) {
    return res.status(403).json({ 
      success: false, 
      error: error.message || 'Invalid or expired token' 
    });
  }
};

// Tier-based access middleware
const requireTier = (requiredTier) => {
  const tierHierarchy = { bronze: 1, silver: 2, gold: 3 };
  
  return (req, res, next) => {
    const userTier = req.user?.tier || 'bronze';
    
    if (tierHierarchy[userTier] < tierHierarchy[requiredTier]) {
      return res.status(403).json({ 
        success: false, 
        error: `Access denied. ${requiredTier} tier required.` 
      });
    }
    
    next();
  };
};

// Token rotation endpoint handler
const rotateTokens = async (req, res) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return res.status(400).json({
      success: false,
      error: 'Refresh token required'
    });
  }
  
  try {
    const tokens = await authService.rotateTokens(refreshToken);
    
    res.json({
      success: true,
      data: tokens,
      message: 'Tokens rotated successfully'
    });
  } catch (error) {
    res.status(403).json({
      success: false,
      error: error.message || 'Token rotation failed'
    });
  }
};

// Token revocation endpoint
const revokeToken = (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(400).json({
      success: false,
      error: 'Token required'
    });
  }
  
  try {
    const payload = authService.verifyAccessToken(token);
    authService.blacklistToken(payload.jti);
    
    res.json({
      success: true,
      message: 'Token revoked successfully'
    });
  } catch (error) {
    res.status(403).json({
      success: false,
      error: error.message || 'Token revocation failed'
    });
  }
};

module.exports = {
  generateNonce,
  nonces,
  verifySignature,
  generateToken,
  generateRefreshToken,
  authenticateToken,
  rotateTokens,
  revokeToken,
  requireTier,
  authService // Export service for direct access
};
