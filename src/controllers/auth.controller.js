const { AuthService } = require('../services/auth.service');
const { OrganizationService } = require('../services/organization.service');
const { rbacMiddleware } = require('../middleware/rbac.middleware');
const { validateDto } = require('../middleware/validate-dto.middleware');
const { LoginDto, VerifyStellarSignatureDto, CreateApiKeyDto } = require('../dto/auth.dto');

class AuthController {
  constructor() {
    this.authService = new AuthService();
    this.organizationService = new OrganizationService();
  }

  async login(req, res) {
    try {
      const { stellarPublicKey, organizationSlug, signature } = req.body;

      // Validate input
      if (!stellarPublicKey || !organizationSlug) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Stellar public key and organization slug are required',
          timestamp: new Date().toISOString()
        });
      }

      // Validate Stellar public key format
      if (!/^G[A-Z0-9]{55}$/.test(stellarPublicKey)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid Stellar public key format',
          timestamp: new Date().toISOString()
        });
      }

      // Find organization by slug
      const organization = await this.organizationService.getOrganizationBySlug(organizationSlug);
      if (!organization) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Organization not found',
          timestamp: new Date().toISOString()
        });
      }

      // Find member by Stellar public key in this organization
      const member = await this.organizationService.getMemberByStellarPublicKey(
        organization.id, 
        stellarPublicKey
      );

      if (!member) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid credentials or member not found',
          timestamp: new Date().toISOString()
        });
      }

      if (member.status !== 'ACTIVE') {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Account is not active',
          timestamp: new Date().toISOString()
        });
      }

      // In a real implementation, verify the cryptographic signature here
      if (signature) {
        const isValidSignature = this.authService.validateStellarSignature(
          stellarPublicKey, 
          signature, 
          'login_challenge'
        );
        
        if (!isValidSignature) {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid signature',
            timestamp: new Date().toISOString()
          });
        }
      }

      // Update last login
      await this.organizationService.updateMember(member.id, {
        lastLoginAt: new Date()
      });

      // Generate JWT token
      const token = this.authService.generateMemberToken(member);
      const refreshToken = this.authService.generateRefreshToken(member.id);

      // Set secure HTTP-only cookie with refresh token
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });

      res.json({
        success: true,
        data: {
          token,
          member: {
            id: member.id,
            email: member.email,
            role: member.role,
            permissions: member.permissions,
            organizationId: member.organizationId,
            organization: organization
          },
          expiresIn: '24h'
        },
        timestamp: new Date().toISOString(),
        message: 'Login successful'
      });
    } catch (error) {
      console.error('Error during member login:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Login failed',
        timestamp: new Date().toISOString()
      });
    }
  }

  async refreshToken(req, res) {
    try {
      const refreshToken = req.cookies.refreshToken;

      if (!refreshToken) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Refresh token required',
          timestamp: new Date().toISOString()
        });
      }

      const { memberId } = this.authService.verifyRefreshToken(refreshToken);
      
      // Get fresh member data
      const member = await this.organizationService.getMemberById(memberId);
      
      if (!member || member.status !== 'ACTIVE') {
        // Clear invalid refresh token
        res.clearCookie('refreshToken');
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid or expired refresh token',
          timestamp: new Date().toISOString()
        });
      }

      // Generate new access token
      const newToken = this.authService.generateMemberToken(member);
      const newRefreshToken = this.authService.generateRefreshToken(member.id);

      // Update refresh token cookie
      res.cookie('refreshToken', newRefreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });

      res.json({
        success: true,
        data: {
          token: newToken,
          expiresIn: '24h'
        },
        timestamp: new Date().toISOString(),
        message: 'Token refreshed successfully'
      });
    } catch (error) {
      // Clear invalid refresh token
      res.clearCookie('refreshToken');
      
      console.error('Error refreshing token:', error);
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid refresh token',
        timestamp: new Date().toISOString()
      });
    }
  }

  async logout(req, res) {
    try {
      // Clear refresh token cookie
      res.clearCookie('refreshToken');

      // In a real implementation, add the JWT to a revocation list
      // and invalidate the session in your session store

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        message: 'Logout successful'
      });
    } catch (error) {
      console.error('Error during logout:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Logout failed',
        timestamp: new Date().toISOString()
      });
    }
  }

  async getProfile(req, res) {
    try {
      const member = req.member;

      // Get organization details
      const organization = await this.organizationService.getOrganizationById(member.organizationId);

      res.json({
        success: true,
        data: {
          ...member,
          organization
        },
        timestamp: new Date().toISOString(),
        message: 'Member profile retrieved successfully'
      });
    } catch (error) {
      console.error('Error fetching member profile:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve profile',
        timestamp: new Date().toISOString()
      });
    }
  }

  async verifyStellarSignature(req, res) {
    try {
      const { publicKey, signature, message } = req.body;

      // Validate input
      if (!publicKey || !signature || !message) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Public key, signature, and message are required',
          timestamp: new Date().toISOString()
        });
      }

      // Validate Stellar public key format
      if (!/^G[A-Z0-9]{55}$/.test(publicKey)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid Stellar public key format',
          timestamp: new Date().toISOString()
        });
      }

      // Validate signature format
      if (!/^[a-fA-F0-9]{128}$/.test(signature)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid signature format',
          timestamp: new Date().toISOString()
        });
      }

      // TODO: Implement actual Stellar signature verification
      // This would use the Stellar SDK to verify the signature
      const isValidSignature = this.authService.validateStellarSignature(publicKey, signature, message);

      if (!isValidSignature) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid Stellar signature',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        data: {
          publicKey,
          verified: true,
          message: 'Signature verified successfully'
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error verifying Stellar signature:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Signature verification failed',
        timestamp: new Date().toISOString()
      });
    }
  }

  async createApiKey(req, res) {
    try {
      const { permissions = [] } = req.body;
      const member = req.member;

      // Check if member has permission to create API keys
      if (!member.permissions.includes('api_keys:create')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to create API keys',
          timestamp: new Date().toISOString()
        });
      }

      const { apiKey, apiKeyId, expiresAt } = this.authService.generateApiKey(member.id, permissions);

      res.status(201).json({
        success: true,
        data: {
          apiKey,
          apiKeyId,
          permissions,
          expiresAt
        },
        timestamp: new Date().toISOString(),
        message: 'API key created successfully'
      });
    } catch (error) {
      console.error('Error creating API key:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to create API key',
        timestamp: new Date().toISOString()
      });
    }
  }

  async revokeApiKey(req, res) {
    try {
      const { apiKeyId } = req.params;
      const member = req.member;

      // Check if member has permission to revoke API keys
      if (!member.permissions.includes('api_keys:revoke')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to revoke API keys',
          timestamp: new Date().toISOString()
        });
      }

      // In a real implementation, revoke the API key in the database
      const revoked = this.authService.revokeToken(apiKeyId);

      if (!revoked) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'API key not found',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        message: 'API key revoked successfully'
      });
    } catch (error) {
      console.error('Error revoking API key:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to revoke API key',
        timestamp: new Date().toISOString()
      });
    }
  }
}

module.exports = { AuthController };

