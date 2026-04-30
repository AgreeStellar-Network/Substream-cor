const { OrganizationService } = require('../services/organization.service');
const { EmailService } = require('../services/email.service');
const { validateDto } = require('../middleware/validate-dto.middleware');
const { CreateInvitationDto, AcceptInvitationDto } = require('../dto/invitation.dto');

class InvitationController {
  constructor() {
    this.organizationService = new OrganizationService();
    this.emailService = new EmailService();
  }

  async createInvitation(req, res) {
    try {
      const { id } = req.params;
      const { email, role, message, expiresInDays } = req.body;
      const invitedBy = req.member.id;

      // Check if user has permission to invite members
      if (!req.member.permissions.includes('members:invite')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to invite members',
          timestamp: new Date().toISOString()
        });
      }

      // Validate input
      if (!email || !role) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Email and role are required',
          timestamp: new Date().toISOString()
        });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid email format',
          timestamp: new Date().toISOString()
        });
      }

      // Validate role
      const validRoles = ['ADMIN', 'VIEWER', 'BILLING_MANAGER'];
      if (!validRoles.includes(role)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid role',
          timestamp: new Date().toISOString()
        });
      }

      const organization = await this.organizationService.getOrganizationById(id);
      if (!organization) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Organization not found',
          timestamp: new Date().toISOString()
        });
      }

      // Check if member already exists
      const existingMember = await this.organizationService.getMemberByEmail(id, email);
      if (existingMember) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'Member already exists in organization',
          timestamp: new Date().toISOString()
        });
      }

      // Check for existing pending invitation
      const pendingInvitations = await this.organizationService.getPendingInvitations(id);
      const existingInvitation = pendingInvitations.find(inv => inv.email === email);
      
      if (existingInvitation) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'Pending invitation already exists for this email',
          timestamp: new Date().toISOString()
        });
      }

      // Create invitation
      const invitationId = await this.organizationService.createInvitation({
        organizationId: id,
        invitedBy,
        email,
        role,
        message,
        expiresInDays
      });

      // Get the created invitation
      const invitations = await this.organizationService.getPendingInvitations(id);
      const invitation = invitations.find(inv => inv.id === invitationId);

      // Send invitation email
      try {
        await this.emailService.sendInvitationEmail(invitation, organization, req.member);
      } catch (emailError) {
        console.error('Failed to send invitation email:', emailError);
        // Don't fail the request if email fails, but log it
      }

      res.status(201).json({
        success: true,
        data: invitation,
        timestamp: new Date().toISOString(),
        message: 'Invitation created successfully'
      });
    } catch (error) {
      console.error('Error creating invitation:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to create invitation',
        timestamp: new Date().toISOString()
      });
    }
  }

  async getInvitations(req, res) {
    try {
      const { id } = req.params;

      // Check if user has permission to view invitations
      if (!req.member.permissions.includes('members:read')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to view invitations',
          timestamp: new Date().toISOString()
        });
      }

      const organization = await this.organizationService.getOrganizationById(id);
      if (!organization) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Organization not found',
          timestamp: new Date().toISOString()
        });
      }

      const invitations = await this.organizationService.getPendingInvitations(id);

      res.json({
        success: true,
        data: invitations,
        timestamp: new Date().toISOString(),
        message: 'Invitations retrieved successfully'
      });
    } catch (error) {
      console.error('Error getting invitations:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve invitations',
        timestamp: new Date().toISOString()
      });
    }
  }

  async acceptInvitation(req, res) {
    try {
      const { token } = req.params;
      const { stellarPublicKey } = req.body;

      // Validate input
      if (!stellarPublicKey) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Stellar public key is required',
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

      // Get invitation by token
      const invitation = await this.organizationService.getInvitationByToken(token);
      
      if (!invitation) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Invitation not found',
          timestamp: new Date().toISOString()
        });
      }

      if (invitation.status !== 'PENDING') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invitation is no longer valid',
          timestamp: new Date().toISOString()
        });
      }

      if (new Date() > new Date(invitation.expiresAt)) {
        await this.organizationService.updateInvitationStatus(invitation.id, 'EXPIRED');
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invitation has expired',
          timestamp: new Date().toISOString()
        });
      }

      // Check if Stellar public key is already used in this organization
      const existingMember = await this.organizationService.getMemberByStellarPublicKey(
        invitation.organizationId, 
        stellarPublicKey
      );
      
      if (existingMember) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'Stellar public key is already used in this organization',
          timestamp: new Date().toISOString()
        });
      }

      // Create member
      const memberId = await this.organizationService.createMember({
        organizationId: invitation.organizationId,
        email: invitation.email,
        stellarPublicKey,
        role: invitation.role,
        invitedBy: invitation.invitedBy
      });

      // Activate the member
      await this.organizationService.activateMember(memberId, stellarPublicKey);

      // Update invitation status
      await this.organizationService.updateInvitationStatus(invitation.id, 'ACCEPTED');

      // Get the created member
      const member = await this.organizationService.getMemberById(memberId);

      res.status(201).json({
        success: true,
        data: member,
        timestamp: new Date().toISOString(),
        message: 'Invitation accepted successfully'
      });
    } catch (error) {
      console.error('Error accepting invitation:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to accept invitation',
        timestamp: new Date().toISOString()
      });
    }
  }

  async getInvitationDetails(req, res) {
    try {
      const { token } = req.params;

      const invitation = await this.organizationService.getInvitationByToken(token);
      
      if (!invitation) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Invitation not found',
          timestamp: new Date().toISOString()
        });
      }

      if (invitation.status !== 'PENDING') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invitation is no longer valid',
          timestamp: new Date().toISOString()
        });
      }

      if (new Date() > new Date(invitation.expiresAt)) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invitation has expired',
          timestamp: new Date().toISOString()
        });
      }

      // Get organization details
      const organization = await this.organizationService.getOrganizationById(invitation.organizationId);

      // Get inviter details
      const inviter = await this.organizationService.getMemberById(invitation.invitedBy);

      res.json({
        success: true,
        data: {
          ...invitation,
          organization: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug
          },
          inviter: inviter ? {
            id: inviter.id,
            email: inviter.email,
            role: inviter.role
          } : null
        },
        timestamp: new Date().toISOString(),
        message: 'Invitation details retrieved successfully'
      });
    } catch (error) {
      console.error('Error getting invitation details:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve invitation details',
        timestamp: new Date().toISOString()
      });
    }
  }

  async cancelInvitation(req, res) {
    try {
      const { token } = req.params;

      // Get invitation by token
      const invitation = await this.organizationService.getInvitationByToken(token);
      
      if (!invitation) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Invitation not found',
          timestamp: new Date().toISOString()
        });
      }

      // Check if user has permission to cancel invitations in this organization
      if (req.member.organizationId !== invitation.organizationId || 
          !req.member.permissions.includes('members:invite')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to cancel this invitation',
          timestamp: new Date().toISOString()
        });
      }

      if (invitation.status !== 'PENDING') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invitation cannot be cancelled',
          timestamp: new Date().toISOString()
        });
      }

      // Update invitation status
      await this.organizationService.updateInvitationStatus(invitation.id, 'CANCELLED');

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        message: 'Invitation cancelled successfully'
      });
    } catch (error) {
      console.error('Error cancelling invitation:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to cancel invitation',
        timestamp: new Date().toISOString()
      });
    }
  }

  async resendInvitation(req, res) {
    try {
      const { token } = req.params;

      const invitation = await this.organizationService.getInvitationByToken(token);
      
      if (!invitation) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Invitation not found',
          timestamp: new Date().toISOString()
        });
      }

      // Check if user has permission to resend invitations in this organization
      if (req.member.organizationId !== invitation.organizationId || 
          !req.member.permissions.includes('members:invite')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to resend this invitation',
          timestamp: new Date().toISOString()
        });
      }

      if (invitation.status !== 'PENDING') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Invitation cannot be resent',
          timestamp: new Date().toISOString()
        });
      }

      // Get organization details
      const organization = await this.organizationService.getOrganizationById(invitation.organizationId);

      // Resend invitation email
      try {
        await this.emailService.sendInvitationEmail(invitation, organization, req.member);
      } catch (emailError) {
        console.error('Failed to resend invitation email:', emailError);
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Failed to resend invitation email',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        message: 'Invitation resent successfully'
      });
    } catch (error) {
      console.error('Error resending invitation:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to resend invitation',
        timestamp: new Date().toISOString()
      });
    }
  }
}

module.exports = { InvitationController };

