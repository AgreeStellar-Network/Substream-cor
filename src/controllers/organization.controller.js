const { OrganizationService } = require('../services/organization.service');
const { AuthService } = require('../services/auth.service');
const { rbacMiddleware } = require('../middleware/rbac.middleware');
const { validateDto } = require('../middleware/validate-dto.middleware');
const { CreateOrganizationDto, UpdateOrganizationDto, AddMemberDto, UpdateMemberDto } = require('../dto/organization.dto');

class OrganizationController {
  constructor() {
    this.organizationService = new OrganizationService();
    this.authService = new AuthService();
  }

  async createOrganization(req, res) {
    try {
      const { name, slug, domain, description } = req.body;
      const createdBy = req.user?.id || 'system';

      // Validate input
      if (!name || !slug) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Name and slug are required',
          timestamp: new Date().toISOString()
        });
      }

      // Check if slug is already taken
      const existingOrg = await this.organizationService.getOrganizationBySlug(slug);
      if (existingOrg) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'Organization slug already exists',
          timestamp: new Date().toISOString()
        });
      }

      // Create organization
      const organizationId = await this.organizationService.createOrganization({
        name,
        slug,
        domain,
        description,
        createdBy
      });

      // Create admin member for the creator
      const memberId = await this.organizationService.createMember({
        organizationId,
        email: req.user?.email || 'admin@' + slug + '.com',
        stellarPublicKey: req.user?.stellarPublicKey,
        role: 'ADMIN',
        invitedBy: null
      });

      // Get the created organization
      const organization = await this.organizationService.getOrganizationById(organizationId);

      res.status(201).json({
        success: true,
        data: organization,
        timestamp: new Date().toISOString(),
        message: 'Organization created successfully'
      });
    } catch (error) {
      console.error('Error creating organization:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to create organization',
        timestamp: new Date().toISOString()
      });
    }
  }

  async getOrganization(req, res) {
    try {
      const { id } = req.params;

      const organization = await this.organizationService.getOrganizationById(id);
      if (!organization) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Organization not found',
          timestamp: new Date().toISOString()
        });
      }

      // Check if user has permission to view this organization
      if (req.member?.organizationId !== id && !req.user?.isAdmin) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Access denied',
          timestamp: new Date().toISOString()
        });
      }

      res.json({
        success: true,
        data: organization,
        timestamp: new Date().toISOString(),
        message: 'Organization retrieved successfully'
      });
    } catch (error) {
      console.error('Error getting organization:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve organization',
        timestamp: new Date().toISOString()
      });
    }
  }

  async updateOrganization(req, res) {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Check if user has permission to update this organization
      if (req.member?.organizationId !== id && !req.user?.isAdmin) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Access denied',
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

      await this.organizationService.updateOrganization(id, updates);

      const updatedOrganization = await this.organizationService.getOrganizationById(id);

      res.json({
        success: true,
        data: updatedOrganization,
        timestamp: new Date().toISOString(),
        message: 'Organization updated successfully'
      });
    } catch (error) {
      console.error('Error updating organization:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to update organization',
        timestamp: new Date().toISOString()
      });
    }
  }

  async getOrganizationMembers(req, res) {
    try {
      const { id } = req.params;

      // Check if user has permission to view members
      if (req.member?.organizationId !== id && !req.user?.isAdmin) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Access denied',
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

      const members = await this.organizationService.getOrganizationMembers(id);

      res.json({
        success: true,
        data: members,
        timestamp: new Date().toISOString(),
        message: 'Members retrieved successfully'
      });
    } catch (error) {
      console.error('Error getting organization members:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve members',
        timestamp: new Date().toISOString()
      });
    }
  }

  async addMember(req, res) {
    try {
      const { id } = req.params;
      const { email, role, stellarPublicKey } = req.body;

      // Check if user has permission to add members
      if (req.member?.organizationId !== id || !req.member?.permissions?.includes('members:invite')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to add members',
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
          message: 'Member already exists',
          timestamp: new Date().toISOString()
        });
      }

      // Create member
      const memberId = await this.organizationService.createMember({
        organizationId: id,
        email,
        stellarPublicKey,
        role,
        invitedBy: req.member.id
      });

      const member = await this.organizationService.getMemberById(memberId);

      res.status(201).json({
        success: true,
        data: member,
        timestamp: new Date().toISOString(),
        message: 'Member added successfully'
      });
    } catch (error) {
      console.error('Error adding member:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to add member',
        timestamp: new Date().toISOString()
      });
    }
  }

  async updateMember(req, res) {
    try {
      const { id, memberId } = req.params;
      const updates = req.body;

      // Check if user has permission to update members
      if (req.member?.organizationId !== id || !req.member?.permissions?.includes('members:write')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to update members',
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

      const member = await this.organizationService.getMemberById(memberId);
      if (!member) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Member not found',
          timestamp: new Date().toISOString()
        });
      }

      // Prevent self-removal or role downgrade for admins
      if (memberId === req.member.id && updates.role && updates.role !== 'ADMIN') {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot change your own role',
          timestamp: new Date().toISOString()
        });
      }

      await this.organizationService.updateMember(memberId, updates);

      const updatedMember = await this.organizationService.getMemberById(memberId);

      res.json({
        success: true,
        data: updatedMember,
        timestamp: new Date().toISOString(),
        message: 'Member updated successfully'
      });
    } catch (error) {
      console.error('Error updating member:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to update member',
        timestamp: new Date().toISOString()
      });
    }
  }

  async removeMember(req, res) {
    try {
      const { id, memberId } = req.params;

      // Check if user has permission to remove members
      if (req.member?.organizationId !== id || !req.member?.permissions?.includes('members:delete')) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Insufficient permissions to remove members',
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

      const member = await this.organizationService.getMemberById(memberId);
      if (!member) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Member not found',
          timestamp: new Date().toISOString()
        });
      }

      // Prevent self-removal
      if (memberId === req.member.id) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot remove yourself from organization',
          timestamp: new Date().toISOString()
        });
      }

      await this.organizationService.removeMember(memberId);

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        message: 'Member removed successfully'
      });
    } catch (error) {
      console.error('Error removing member:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to remove member',
        timestamp: new Date().toISOString()
      });
    }
  }
}

module.exports = { OrganizationController };

