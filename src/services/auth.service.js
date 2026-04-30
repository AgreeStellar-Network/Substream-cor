const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * Enhanced Authentication Service with strict JWT expiration and rotation
 */
class AuthService {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    this.jwtIssuer = process.env.JWT_ISSUER || 'stellar-privacy';
    this.jwtAudience = process.env.JWT_AUDIENCE || 'stellar-api';
    
    // Strict security configuration
    this.accessTokenExpiration = process.env.JWT_ACCESS_TOKEN_EXPIRATION || '15m'; // 15 minutes
    this.refreshTokenExpiration = process.env.JWT_REFRESH_TOKEN_EXPIRATION || '7d'; // 7 days
    this.apiKeyExpiration = process.env.JWT_API_KEY_EXPIRATION || '30d'; // 30 days
    this.sessionTokenExpiration = process.env.JWT_SESSION_TOKEN_EXPIRATION || '1h'; // 1 hour
    
    // Token rotation settings
    this.rotationThreshold = process.env.JWT_ROTATION_THRESHOLD || '5m'; // Rotate tokens 5 minutes before expiry
    this.maxRefreshTokens = parseInt(process.env.JWT_MAX_REFRESH_TOKENS) || 5; // Max refresh tokens per user
    
    // In-memory token blacklist (in production, use Redis)
    this.tokenBlacklist = new Map();
    this.refreshTokens = new Map(); // userId -> array of refresh tokens
    
    // Start cleanup interval
    this.startCleanup();
  }

  /**
   * Generate short-lived access token with strict expiration
   */
  generateAccessToken(member) {
    const now = Math.floor(Date.now() / 1000);
    const expirationTime = this.parseExpiration(this.accessTokenExpiration);
    
    const payload = {
      sub: member.id,
      email: member.email,
      organizationId: member.organizationId,
      role: member.role,
      permissions: member.permissions,
      tenantId: member.organizationId,
      sessionId: this.generateSessionId(),
      iat: now,
      exp: now + expirationTime,
      jti: this.generateJwtId(),
      iss: this.jwtIssuer,
      aud: this.jwtAudience,
      type: 'access'
    };

    return jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: this.accessTokenExpiration
    });
  }

  /**
   * Generate refresh token with rotation support
   */
  generateRefreshToken(memberId, accessTokenJti) {
    const now = Math.floor(Date.now() / 1000);
    const expirationTime = this.parseExpiration(this.refreshTokenExpiration);
    
    const payload = {
      sub: memberId,
      type: 'refresh',
      accessTokenJti, // Link to access token for rotation
      iat: now,
      exp: now + expirationTime,
      jti: this.generateJwtId()
    };

    const refreshToken = jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256'
    });
    
    // Store refresh token for rotation tracking
    this.storeRefreshToken(memberId, refreshToken, accessTokenJti);
    
    return refreshToken;
  }

  /**
   * Verify access token with strict validation
   */
  verifyAccessToken(token) {
    try {
      const payload = jwt.verify(token, this.jwtSecret, {
        issuer: this.jwtIssuer,
        audience: this.jwtAudience,
        algorithms: ['HS256']
      });
      
      // Check token type
      if (payload.type !== 'access') {
        throw new Error('Invalid token type');
      }
      
      // Check if token is blacklisted
      if (this.isTokenBlacklisted(payload.jti)) {
        throw new Error('Token has been revoked');
      }
      
      return payload;
    } catch (error) {
      throw new Error('Invalid or expired access token');
    }
  }

  /**
   * Verify refresh token with rotation support
   */
  verifyRefreshToken(refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret, {
        algorithms: ['HS256']
      });
      
      if (payload.type !== 'refresh') {
        throw new Error('Invalid refresh token');
      }
      
      // Check if refresh token is still valid and not revoked
      if (!this.isValidRefreshToken(payload.sub, refreshToken)) {
        throw new Error('Refresh token has been revoked or is invalid');
      }
      
      return payload;
    } catch (error) {
      throw new Error('Invalid or expired refresh token');
    }
  }

  generateApiKey(memberId, permissions = []) {
    const apiKeyId = this.generateApiKeyId();
    const payload = {
      sub: memberId,
      type: 'api_key',
      permissions,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60), // 1 year
      jti: apiKeyId
    };

    const apiKey = jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256'
    });

    return {
      apiKey,
      apiKeyId,
      expiresAt: new Date(payload.exp * 1000)
    };
  }

  verifyApiKey(apiKey) {
    try {
      const payload = jwt.verify(apiKey, this.jwtSecret, {
        algorithms: ['HS256']
      });
      
      if (payload.type !== 'api_key') {
        throw new Error('Invalid API key');
      }
      
      return payload;
    } catch (error) {
      throw new Error('Invalid API key');
    }
  }

  generateSessionToken(member) {
    const sessionId = this.generateSessionId();
    const payload = {
      sub: member.id,
      type: 'session',
      sessionId,
      organizationId: member.organizationId,
      tenantId: member.organizationId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (8 * 60 * 60), // 8 hours
      jti: sessionId
    };

    return jwt.sign(payload, this.jwtSecret, {
      algorithm: 'HS256'
    });
  }

  revokeToken(tokenId) {
    // In a real implementation, you would add the token to a revocation list
    // For now, we'll just return success
    return true;
  }

  isTokenRevoked(tokenId) {
    // In a real implementation, you would check against a revocation list
    return false;
  }

  validateStellarSignature(publicKey, signature, message) {
    // In a real implementation, you would verify the Stellar signature
    // For now, we'll just validate the format
    if (!publicKey || !signature || !message) {
      return false;
    }

    // Validate Stellar public key format
    if (!/^G[A-Z0-9]{55}$/.test(publicKey)) {
      return false;
    }

    // Validate signature format
    if (!/^[a-fA-F0-9]{128}$/.test(signature)) {
      return false;
    }

    // TODO: Implement actual Stellar signature verification
    // This would use the Stellar SDK to verify the signature
    return true;
  }

  generateSecureToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
  }

  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  generateJwtId() {
    return crypto.randomBytes(16).toString('hex');
  }

  generateApiKeyId() {
    return `api_${crypto.randomBytes(16).toString('hex')}`;
  }

  generateInvitationToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  hashPassword(password) {
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return { salt, hash };
  }

  verifyPassword(password, salt, hash) {
    const crypto = require('crypto');
    const hashVerify = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return hash === hashVerify;
  }

  extractTokenFromHeader(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.substring(7);
  }

  decodeTokenWithoutVerification(token) {
    try {
      return jwt.decode(token, { complete: true });
    } catch (error) {
      return null;
    }
  }

  getTokenExpiration(token) {
    try {
      const decoded = jwt.decode(token);
      return decoded.exp ? new Date(decoded.exp * 1000) : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Parse expiration string to seconds
   */
  parseExpiration(expiration) {
    const units = {
      's': 1,
      'm': 60,
      'h': 3600,
      'd': 86400
    };
    
    const match = expiration.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error('Invalid expiration format');
    }
    
    const [, value, unit] = match;
    return parseInt(value) * units[unit];
  }

  /**
   * Store refresh token for rotation tracking
   */
  storeRefreshToken(memberId, refreshToken, accessTokenJti) {
    if (!this.refreshTokens.has(memberId)) {
      this.refreshTokens.set(memberId, []);
    }
    
    const tokens = this.refreshTokens.get(memberId);
    
    // Remove oldest token if we exceed the max limit
    if (tokens.length >= this.maxRefreshTokens) {
      const oldestToken = tokens.shift();
      this.blacklistToken(oldestToken.jti);
    }
    
    tokens.push({
      token: refreshToken,
      jti: this.generateJwtId(),
      accessTokenJti,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + (this.parseExpiration(this.refreshTokenExpiration) * 1000))
    });
  }

  /**
   * Check if refresh token is valid
   */
  isValidRefreshToken(memberId, refreshToken) {
    const tokens = this.refreshTokens.get(memberId);
    if (!tokens) return false;
    
    return tokens.some(t => t.token === refreshToken && t.expiresAt > new Date());
  }

  /**
   * Revoke refresh token
   */
  revokeRefreshToken(memberId, refreshToken) {
    const tokens = this.refreshTokens.get(memberId);
    if (!tokens) return;
    
    const tokenIndex = tokens.findIndex(t => t.token === refreshToken);
    if (tokenIndex !== -1) {
      const token = tokens[tokenIndex];
      this.blacklistToken(token.jti);
      tokens.splice(tokenIndex, 1);
    }
  }

  /**
   * Add token to blacklist
   */
  blacklistToken(jti) {
    this.tokenBlacklist.set(jti, {
      blacklistedAt: new Date(),
      expiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)) // Keep in blacklist for 24 hours
    });
  }

  /**
   * Check if token is blacklisted
   */
  isTokenBlacklisted(jti) {
    const blacklisted = this.tokenBlacklist.get(jti);
    if (!blacklisted) return false;
    
    // Remove expired blacklist entries
    if (blacklisted.expiresAt < new Date()) {
      this.tokenBlacklist.delete(jti);
      return false;
    }
    
    return true;
  }

  /**
   * Get member by ID (stub implementation)
   */
  async getMemberById(memberId) {
    // In a real implementation, fetch from database
    return {
      id: memberId,
      email: `${memberId}@example.com`,
      organizationId: 'org-1',
      role: 'member',
      permissions: ['read', 'write']
    };
  }

  /**
   * Start cleanup interval
   */
  startCleanup() {
    setInterval(() => {
      this.cleanup();
    }, 60 * 60 * 1000); // Clean up every hour
  }

  /**
   * Clean up expired tokens
   */
  cleanup() {
    const now = new Date();
    
    // Clean up blacklisted tokens
    for (const [jti, entry] of this.tokenBlacklist.entries()) {
      if (entry.expiresAt < now) {
        this.tokenBlacklist.delete(jti);
      }
    }
    
    // Clean up expired refresh tokens
    for (const [memberId, tokens] of this.refreshTokens.entries()) {
      const validTokens = tokens.filter(token => token.expiresAt > now);
      if (validTokens.length !== tokens.length) {
        this.refreshTokens.set(memberId, validTokens);
      }
    }
    
    console.log('[AuthService] Cleanup completed');
  }

  /**
   * Revoke all tokens for a user
   */
  revokeAllTokens(memberId) {
    // Blacklist all refresh tokens for the user
    const tokens = this.refreshTokens.get(memberId);
    if (tokens) {
      tokens.forEach(token => {
        this.blacklistToken(token.jti);
      });
      this.refreshTokens.delete(memberId);
    }
  }

  /**
   * Rotate tokens - generate new access and refresh tokens
   */
  async rotateTokens(refreshToken) {
    try {
      const payload = this.verifyRefreshToken(refreshToken);
      
      // Revoke the old refresh token
      this.revokeRefreshToken(payload.sub, refreshToken);
      
      // Get member information (in a real implementation, fetch from database)
      const member = await this.getMemberById(payload.sub);
      if (!member) {
        throw new Error('Member not found');
      }
      
      // Generate new tokens
      const newAccessToken = this.generateAccessToken(member);
      const newRefreshToken = this.generateRefreshToken(member.id, payload.jti);
      
      // Blacklist the old access token if it exists
      if (payload.accessTokenJti) {
        this.blacklistToken(payload.accessTokenJti);
      }
      
      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        tokenType: 'Bearer',
        expiresIn: this.parseExpiration(this.accessTokenExpiration)
      };
    } catch (error) {
      throw new Error('Token rotation failed: ' + error.message);
    }
  }

  /**
   * Check if token needs rotation
   */
  shouldRotateToken(token) {
    try {
      const decoded = jwt.decode(token);
      if (!decoded || !decoded.exp) {
        return false;
      }
      
      const now = Math.floor(Date.now() / 1000);
      const rotationThreshold = this.parseExpiration(this.rotationThreshold);
      
      return (decoded.exp - now) <= rotationThreshold;
    } catch (error) {
      return false;
    }
  }
}

module.exports = { AuthService };
