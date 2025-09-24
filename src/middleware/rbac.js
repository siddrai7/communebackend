// src/middleware/rbac.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import { ROLES } from "./auth.js";

/**
 * Enhanced RBAC middleware that handles resource-based permissions
 * This middleware can be reused across different features (properties, maintenance, etc.)
 */

/**
 * Resource-based authorization middleware
 * @param {Object} config - Configuration object
 * @param {Array} config.roles - Allowed roles for this operation
 * @param {string} config.resource - Resource type (e.g., 'building', 'maintenance', 'tenant')
 * @param {string} config.operation - Operation type (e.g., 'read', 'write', 'delete')
 * @param {string} config.resourceIdParam - URL parameter name containing resource ID (e.g., 'id', 'buildingId')
 * @param {Function} config.customPermissionCheck - Optional custom permission validation function
 * @param {boolean} config.allowSelfAccess - Allow users to access their own resources (for tenants)
 */
export const authorizeResource = (config = {}) => {
  const {
    roles = [],
    resource,
    operation = "read",
    resourceIdParam = "id",
    customPermissionCheck,
    allowSelfAccess = false,
  } = config;

  return async (req, res, next) => {
    try {
      const user = req.user;

      if (!user) {
        return next(createError("UNAUTHORIZED", "Authentication required"));
      }

      // Basic role check
      if (roles.length > 0 && !roles.includes(user.role)) {
        return next(createError("FORBIDDEN", "Insufficient role permissions"));
      }

      // For super admins, allow all operations (unless explicitly restricted)
      if (user.role === ROLES.SUPER_ADMIN && !config.restrictSuperAdmin) {
        return next();
      }

      // For admins, allow most operations except user management
      if (user.role === ROLES.ADMIN && resource !== "user_management") {
        return next();
      }

      // Resource-specific permission checks
      if (resource && req.params[resourceIdParam]) {
        const resourceId = parseInt(req.params[resourceIdParam]);

        if (isNaN(resourceId)) {
          return next(createError("VALIDATION_ERROR", "Invalid resource ID"));
        }

        // Check resource-specific permissions
        const hasAccess = await checkResourcePermission(
          user,
          resource,
          resourceId,
          operation
        );

        if (!hasAccess) {
          return next(
            createError("FORBIDDEN", "Access denied to this resource")
          );
        }
      }

      // Custom permission check
      if (customPermissionCheck) {
        const customResult = await customPermissionCheck(req, user);
        if (!customResult) {
          return next(
            createError("FORBIDDEN", "Custom permission check failed")
          );
        }
      }

      // Store resource info for later use in controllers
      req.resourceAccess = {
        user,
        resource,
        operation,
        resourceId: req.params[resourceIdParam]
          ? parseInt(req.params[resourceIdParam])
          : null,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Check if user has permission to access a specific resource
 * @param {Object} user - User object with userId, email, role
 * @param {string} resource - Resource type
 * @param {number} resourceId - Resource ID
 * @param {string} operation - Operation type
 * @returns {boolean} - Has permission
 */
async function checkResourcePermission(user, resource, resourceId, operation) {
  const client = await pool.connect();

  try {
    switch (resource) {
      case "building":
        return await checkBuildingPermission(
          client,
          user,
          resourceId,
          operation
        );

      case "maintenance":
        return await checkMaintenancePermission(
          client,
          user,
          resourceId,
          operation
        );

      case "tenant":
        return await checkTenantPermission(client, user, resourceId, operation);

      case "complaint":
        return await checkComplaintPermission(
          client,
          user,
          resourceId,
          operation
        );

      default:
        // For unknown resources, deny access unless super admin or admin
        return user.role === ROLES.SUPER_ADMIN || user.role === ROLES.ADMIN;
    }
  } finally {
    client.release();
  }
}

/**
 * Check building-specific permissions for managers
 */
async function checkBuildingPermission(client, user, buildingId, operation) {
  if (user.role === ROLES.MANAGER) {
    // Managers can only access buildings they are assigned to
    const query = `
      SELECT id FROM buildings 
      WHERE id = $1 AND manager_id = $2 AND status = 'active'
    `;
    const result = await client.query(query, [buildingId, user.userId]);
    return result.rows.length > 0;
  }

  // For tenants, check if they have a tenancy in this building
  if (user.role === ROLES.TENANT) {
    const query = `
      SELECT DISTINCT r.building_id 
      FROM tenancies t
      JOIN units u ON t.unit_id = u.id
      JOIN rooms r ON u.room_id = r.id
      WHERE r.building_id = $1 
      AND t.tenant_user_id = $2 
      AND t.agreement_status = 'executed'
      AND CURRENT_DATE >= t.start_date 
      AND CURRENT_DATE <= t.end_date
    `;
    const result = await client.query(query, [buildingId, user.userId]);
    return result.rows.length > 0;
  }

  return false;
}

/**
 * Check maintenance request permissions
 */
async function checkMaintenancePermission(client, user, requestId, operation) {
  if (user.role === ROLES.MANAGER) {
    // Managers can access maintenance requests from their buildings
    const query = `
      SELECT mr.id 
      FROM maintenance_requests mr
      JOIN rooms r ON mr.room_id = r.id
      JOIN buildings b ON r.building_id = b.id
      WHERE mr.id = $1 AND b.manager_id = $2
    `;
    const result = await client.query(query, [requestId, user.userId]);
    return result.rows.length > 0;
  }

  if (user.role === ROLES.TENANT) {
    // Tenants can only access their own maintenance requests
    const query = `
      SELECT id FROM maintenance_requests 
      WHERE id = $1 AND tenant_user_id = $2
    `;
    const result = await client.query(query, [requestId, user.userId]);
    return result.rows.length > 0;
  }

  return false;
}

/**
 * Check tenant-specific permissions
 */
async function checkTenantPermission(client, user, tenantId, operation) {
  if (user.role === ROLES.MANAGER) {
    // Managers can access tenants from their buildings
    const query = `
      SELECT DISTINCT t.tenant_user_id
      FROM tenancies t
      JOIN units u ON t.unit_id = u.id
      JOIN rooms r ON u.room_id = r.id
      JOIN buildings b ON r.building_id = b.id
      WHERE t.tenant_user_id = $1 AND b.manager_id = $2
      AND t.agreement_status = 'executed'
    `;
    const result = await client.query(query, [tenantId, user.userId]);
    return result.rows.length > 0;
  }

  if (user.role === ROLES.TENANT) {
    // Tenants can only access their own data
    return user.userId === tenantId;
  }

  return false;
}

/**
 * Check complaint permissions
 */
async function checkComplaintPermission(client, user, complaintId, operation) {
  if (user.role === ROLES.MANAGER) {
    // Managers can access complaints from their buildings
    const query = `
      SELECT c.id 
      FROM complaints c
      JOIN buildings b ON c.building_id = b.id
      WHERE c.id = $1 AND b.manager_id = $2
    `;
    const result = await client.query(query, [complaintId, user.userId]);
    return result.rows.length > 0;
  }

  if (user.role === ROLES.TENANT) {
    // Tenants can only access their own complaints
    const query = `
      SELECT id FROM complaints 
      WHERE id = $1 AND tenant_user_id = $2
    `;
    const result = await client.query(query, [complaintId, user.userId]);
    return result.rows.length > 0;
  }

  return false;
}

/**
 * Middleware to filter query results based on user permissions
 * This modifies the request to include necessary filters for managers
 */
export const applyDataFilters = (resource) => {
  return (req, res, next) => {
    const user = req.user;

    if (!user) {
      return next();
    }

    // Initialize filters object
    req.dataFilters = {
      user,
      resource,
      buildingIds: null,
      tenantIds: null,
    };

    // For managers, we need to limit data to their assigned buildings
    if (user.role === ROLES.MANAGER) {
      req.dataFilters.managerRestricted = true;
      req.dataFilters.managerId = user.userId;
    }

    // For tenants, limit to their own data
    if (user.role === ROLES.TENANT) {
      req.dataFilters.tenantRestricted = true;
      req.dataFilters.tenantId = user.userId;
    }

    next();
  };
};

/**
 * Helper function to get user's accessible building IDs
 * Used in controllers to filter building-related queries
 */
export async function getUserAccessibleBuildings(userId, userRole) {
  if (userRole === ROLES.SUPER_ADMIN || userRole === ROLES.ADMIN) {
    return null; // null means all buildings
  }

  const client = await pool.connect();
  try {
    if (userRole === ROLES.MANAGER) {
      const query = `
        SELECT id FROM buildings 
        WHERE manager_id = $1 AND status = 'active'
      `;
      const result = await client.query(query, [userId]);
      return result.rows.map((row) => row.id);
    }

    if (userRole === ROLES.TENANT) {
      const query = `
        SELECT DISTINCT r.building_id 
        FROM tenancies t
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        WHERE t.tenant_user_id = $1 
        AND t.agreement_status = 'executed'
        AND CURRENT_DATE >= t.start_date 
        AND CURRENT_DATE <= t.end_date
      `;
      const result = await client.query(query, [userId]);
      return result.rows.map((row) => row.building_id);
    }

    return [];
  } finally {
    client.release();
  }
}

/**
 * Helper function to get available managers for assignment
 */
export async function getAvailableManagers() {
  const client = await pool.connect();
  try {
    const query = `
      SELECT 
        u.id,
        u.email,
        up.first_name,
        up.last_name,
        up.phone,
        COUNT(b.id) as assigned_buildings_count
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      LEFT JOIN buildings b ON u.id = b.manager_id
      WHERE u.role = 'manager' AND u.status = 'active'
      GROUP BY u.id, u.email, up.first_name, up.last_name, up.phone
      ORDER BY up.first_name, up.last_name
    `;

    const result = await client.query(query);
    return result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      fullName:
        `${row.first_name || ""} ${row.last_name || ""}`.trim() || "Unknown",
      phone: row.phone,
      assignedBuildingsCount: parseInt(row.assigned_buildings_count) || 0,
    }));
  } finally {
    client.release();
  }
}
