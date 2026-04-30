const ADMIN_ROLES = new Set(['ADMIN', 'super_admin']);
const READ_ROLES = new Set(['ADMIN', 'VIEWER', 'BILLING_MANAGER', 'super_admin']);

function requireRbacUser(req, res, next) {
  const tenantId = req.user?.tenant_id || req.user?.tenantId || req.user?.organizationId || req.tenant?.id;

  if (!tenantId || !req.user?.role) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'RBAC authentication required'
    });
  }

  if (!req.user.tenant_id) {
    req.user.tenant_id = tenantId;
  }

  if (!Array.isArray(req.user.permissions)) {
    req.user.permissions = [];
  }

  if (!req.tenant) {
    req.tenant = {
      id: tenantId,
      is_admin: ADMIN_ROLES.has(req.user.role)
    };
  }

  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!roles.has(req.user?.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient role level'
      });
    }

    next();
  };
}

function requirePermissionOrRole(permission, roles) {
  return (req, res, next) => {
    const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    const hasPermission = permissions.includes(permission);

    if (!hasPermission && !roles.has(req.user?.role)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions'
      });
    }

    next();
  };
}

module.exports = {
  ADMIN_ROLES,
  READ_ROLES,
  requireRbacUser,
  requireRole,
  requirePermissionOrRole
};
