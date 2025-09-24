// src/controllers/offboardingController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";

class OffboardingController {
  // Helper method to get buildings managed by a user
  getManagedBuildingIds = async (client, userId, userRole) => {
    if (userRole === "super_admin" || userRole === "admin") {
      return null; // Access to all buildings
    }

    if (userRole === "manager") {
      const buildingsQuery = `SELECT id FROM buildings WHERE manager_id = $1`;
      const result = await client.query(buildingsQuery, [userId]);
      return result.rows.map((row) => row.id);
    }

    return [];
  };

  // GET /api/offboarding
  // Get all offboarding requests with filters and pagination
  getAllOffboardingRequests = async (req, res, next) => {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        building_id,
        date_from,
        date_to,
        search,
        sortBy = "offboarding_initiated_at",
        sortOrder = "desc",
      } = req.query;

      const offset = (page - 1) * limit;
      const client = await pool.connect();

      try {
        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        // Build WHERE clause
        let whereConditions = ["t.offboarding_status != 'active'"]; // Only show offboarding requests
        let queryParams = [];
        let paramCount = 0;

        // Building access control
        if (managedBuildingIds !== null && managedBuildingIds.length > 0) {
          paramCount++;
          whereConditions.push(`b.id = ANY($${paramCount})`);
          queryParams.push(managedBuildingIds);
        } else if (managedBuildingIds !== null && managedBuildingIds.length === 0) {
          // Manager with no buildings
          whereConditions.push("false");
        }

        // Status filter
        if (status) {
          paramCount++;
          whereConditions.push(`t.offboarding_status = $${paramCount}`);
          queryParams.push(status);
        }

        // Building filter
        if (building_id) {
          paramCount++;
          whereConditions.push(`b.id = $${paramCount}`);
          queryParams.push(building_id);
        }

        // Date range filter
        if (date_from) {
          paramCount++;
          whereConditions.push(`t.offboarding_initiated_at >= $${paramCount}`);
          queryParams.push(date_from);
        }
        if (date_to) {
          paramCount++;
          whereConditions.push(`t.offboarding_initiated_at <= $${paramCount}`);
          queryParams.push(date_to + " 23:59:59");
        }

        // Search functionality (tenant name, email, unit number)
        if (search) {
          paramCount++;
          whereConditions.push(`(
            CONCAT(COALESCE(up.first_name, ''), ' ', COALESCE(up.last_name, '')) ILIKE $${paramCount} OR
            u_user.email ILIKE $${paramCount} OR
            units.unit_number ILIKE $${paramCount}
          )`);
          queryParams.push(`%${search}%`);
        }

        const whereClause = "WHERE " + whereConditions.join(" AND ");

        // Count total records
        const countQuery = `
          SELECT COUNT(DISTINCT t.id) as total
          FROM tenancies t
          JOIN units ON t.unit_id = units.id
          JOIN rooms r ON units.room_id = r.id
          JOIN floors f ON r.floor_id = f.id
          JOIN buildings b ON r.building_id = b.id
          JOIN users u_user ON t.tenant_user_id = u_user.id
          LEFT JOIN user_profiles up ON u_user.id = up.user_id
          ${whereClause}
        `;

        const countResult = await client.query(countQuery, queryParams);
        const total = parseInt(countResult.rows[0].total);

        // Validate sort fields
        const allowedSortFields = [
          "offboarding_initiated_at",
          "intended_move_out_date",
          "offboarding_status",
          "tenant_name",
          "building_name",
        ];
        const validSortBy = allowedSortFields.includes(sortBy) ? sortBy : "offboarding_initiated_at";
        const validSortOrder = ["asc", "desc"].includes(sortOrder.toLowerCase())
          ? sortOrder.toUpperCase()
          : "DESC";

        // Adjust sort field for SQL
        let sqlSortField = validSortBy;
        if (validSortBy === "tenant_name") {
          sqlSortField = "CONCAT(COALESCE(up.first_name, ''), ' ', COALESCE(up.last_name, ''))";
        } else if (validSortBy === "building_name") {
          sqlSortField = "b.name";
        } else {
          sqlSortField = `t.${validSortBy}`;
        }

        // Fetch offboarding requests
        paramCount++;
        queryParams.push(limit);
        paramCount++;
        queryParams.push(offset);

        const offboardingQuery = `
          SELECT 
            t.id as tenancy_id,
            t.tenant_user_id,
            t.start_date,
            t.rent_amount,
            t.security_deposit,
            t.offboarding_initiated_at,
            t.offboarding_reason,
            t.notice_given_date,
            t.intended_move_out_date,
            t.actual_move_out_date,
            t.deposit_refund_amount,
            t.deposit_refund_status,
            t.final_dues,
            t.offboarding_status,
            t.notice_period_days,
            
            -- Tenant info
            u_user.email as tenant_email,
            up.first_name,
            up.last_name,
            up.phone as tenant_phone,
            
            -- Property info
            units.unit_number,
            r.room_number,
            r.room_type,
            f.floor_name,
            b.id as building_id,
            b.name as building_name,
            b.address_line1,
            b.city,
            b.state,
            
            -- Pending payments count
            (SELECT COUNT(*) FROM payments p 
             WHERE p.tenancy_id = t.id AND p.status IN ('pending', 'overdue')) as pending_payments_count,
            (SELECT COALESCE(SUM(p.amount), 0) FROM payments p 
             WHERE p.tenancy_id = t.id AND p.status IN ('pending', 'overdue')) as total_pending_amount
            
          FROM tenancies t
          JOIN units ON t.unit_id = units.id
          JOIN rooms r ON units.room_id = r.id
          JOIN floors f ON r.floor_id = f.id
          JOIN buildings b ON r.building_id = b.id
          JOIN users u_user ON t.tenant_user_id = u_user.id
          LEFT JOIN user_profiles up ON u_user.id = up.user_id
          ${whereClause}
          ORDER BY ${sqlSortField} ${validSortOrder}
          LIMIT $${paramCount - 1} OFFSET $${paramCount}
        `;

        const offboardingResult = await client.query(offboardingQuery, queryParams);
        const offboardingRequests = offboardingResult.rows;

        // Calculate pagination info
        const totalPages = Math.ceil(total / limit);
        const hasNextPage = page < totalPages;
        const hasPrevPage = page > 1;

        res.json({
          success: true,
          data: {
            offboarding_requests: offboardingRequests,
            pagination: {
              currentPage: parseInt(page),
              totalPages,
              totalItems: total,
              itemsPerPage: parseInt(limit),
              hasNextPage,
              hasPrevPage,
            },
            filters: {
              status,
              building_id,
              date_from,
              date_to,
              search,
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get offboarding requests error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch offboarding requests"));
    }
  };

  // GET /api/offboarding/:id
  // Get specific offboarding request details
  getOffboardingRequest = async (req, res, next) => {
    try {
      const { id } = req.params;
      const client = await pool.connect();

      try {
        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        let buildingAccessCondition = "";
        let queryParams = [id];

        if (managedBuildingIds !== null && managedBuildingIds.length > 0) {
          buildingAccessCondition = "AND b.id = ANY($2)";
          queryParams.push(managedBuildingIds);
        } else if (managedBuildingIds !== null && managedBuildingIds.length === 0) {
          return next(createError("FORBIDDEN", "Access denied"));
        }

        const offboardingQuery = `
          SELECT 
            t.id as tenancy_id,
            t.tenant_user_id,
            t.start_date,
            t.end_date,
            t.rent_amount,
            t.security_deposit,
            t.agreement_status,
            t.move_in_date,
            t.move_out_date,
            t.notice_period_days,
            t.offboarding_initiated_at,
            t.offboarding_reason,
            t.notice_given_date,
            t.intended_move_out_date,
            t.actual_move_out_date,
            t.deposit_refund_amount,
            t.deposit_refund_status,
            t.final_dues,
            t.offboarding_status,
            t.documents_submitted,
            
            -- Tenant info
            u_user.email as tenant_email,
            u_user.status as tenant_status,
            up.first_name,
            up.last_name,
            up.phone as tenant_phone,
            up.date_of_birth,
            up.address_line1,
            up.city as tenant_city,
            up.state as tenant_state,
            up.emergency_contact_name,
            up.emergency_contact_phone,
            
            -- Property info
            units.unit_number,
            units.rent_amount as unit_rent,
            r.room_number,
            r.room_type,
            r.size_sqft,
            f.floor_name,
            f.floor_number,
            b.id as building_id,
            b.name as building_name,
            b.address_line1,
            b.address_line2,
            b.city as building_city,
            b.state as building_state,
            b.postal_code
            
          FROM tenancies t
          JOIN units ON t.unit_id = units.id
          JOIN rooms r ON units.room_id = r.id
          JOIN floors f ON r.floor_id = f.id
          JOIN buildings b ON r.building_id = b.id
          JOIN users u_user ON t.tenant_user_id = u_user.id
          LEFT JOIN user_profiles up ON u_user.id = up.user_id
          WHERE t.id = $1 ${buildingAccessCondition}
        `;

        const offboardingResult = await client.query(offboardingQuery, queryParams);

        if (offboardingResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Offboarding request not found"));
        }

        const offboardingRequest = offboardingResult.rows[0];

        // Get payment history
        const paymentsQuery = `
          SELECT 
            id,
            payment_type,
            amount,
            due_date,
            payment_date,
            payment_method,
            transaction_id,
            status,
            late_fee,
            notes,
            created_at
          FROM payments
          WHERE tenancy_id = $1
          ORDER BY due_date DESC
        `;

        const paymentsResult = await client.query(paymentsQuery, [id]);
        const payments = paymentsResult.rows;

        // Get complaints history
        const complaintsQuery = `
          SELECT 
            id,
            complaint_number,
            title,
            description,
            category,
            subcategory,
            priority,
            status,
            assigned_to,
            created_at,
            resolved_at
          FROM complaints
          WHERE tenant_user_id = $1
          ORDER BY created_at DESC
        `;

        const complaintsResult = await client.query(complaintsQuery, [offboardingRequest.tenant_user_id]);
        const complaints = complaintsResult.rows;

        res.json({
          success: true,
          data: {
            offboarding_request: offboardingRequest,
            payments,
            complaints,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get offboarding request error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch offboarding request"));
    }
  };

  // POST /api/offboarding/initiate
  // Admin initiate offboarding for any tenant
  initiateOffboardingByAdmin = async (req, res, next) => {
    try {
      const { tenantUserId, reason, moveOutDate } = req.body;
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Get current active tenancy for the tenant
        const tenancyQuery = `
          SELECT t.id, t.offboarding_status, t.notice_period_days, t.security_deposit,
                 b.id as building_id
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.tenant_user_id = $1 AND t.agreement_status = 'executed'
          ORDER BY t.start_date DESC
          LIMIT 1
        `;

        const tenancyResult = await client.query(tenancyQuery, [tenantUserId]);

        if (tenancyResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("NOT_FOUND", "Active tenancy not found for this tenant"));
        }

        const tenancy = tenancyResult.rows[0];

        // Check building access for managers
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        if (managedBuildingIds !== null && managedBuildingIds.length > 0) {
          if (!managedBuildingIds.includes(tenancy.building_id)) {
            await client.query("ROLLBACK");
            return next(createError("FORBIDDEN", "Access denied to this building"));
          }
        } else if (managedBuildingIds !== null && managedBuildingIds.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("FORBIDDEN", "Access denied"));
        }

        if (tenancy.offboarding_status !== 'active') {
          await client.query("ROLLBACK");
          return next(createError("VALIDATION_ERROR", "Offboarding already initiated for this tenant"));
        }

        // Update tenancy with offboarding details (admin can set any date)
        const updateQuery = `
          UPDATE tenancies 
          SET 
            offboarding_initiated_at = CURRENT_TIMESTAMP,
            offboarding_reason = $1,
            notice_given_date = CURRENT_DATE,
            intended_move_out_date = $2,
            offboarding_status = 'initiated',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
          RETURNING *
        `;

        const updateResult = await client.query(updateQuery, [
          reason,
          moveOutDate,
          tenancy.id
        ]);

        await client.query("COMMIT");

        res.json({
          success: true,
          message: "Offboarding process initiated successfully by admin",
          data: {
            tenancy: updateResult.rows[0],
            initiated_by: req.user.userId,
            admin_override: true
          }
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Admin initiate offboarding error:", error);
      next(createError("DATABASE_ERROR", "Failed to initiate offboarding"));
    }
  };

  // PUT /api/offboarding/:id/status
  // Update offboarding status (for admin processing)
  updateOffboardingStatus = async (req, res, next) => {
    try {
      const { id } = req.params;
      const { 
        status, 
        actualMoveOutDate, 
        finalDues, 
        depositRefundAmount, 
        depositRefundStatus,
        adminNotes 
      } = req.body;
      
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Get tenancy and check access
        const tenancyQuery = `
          SELECT t.*, b.id as building_id
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.id = $1
        `;

        const tenancyResult = await client.query(tenancyQuery, [id]);

        if (tenancyResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("NOT_FOUND", "Tenancy not found"));
        }

        const tenancy = tenancyResult.rows[0];

        // Check building access for managers
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        if (managedBuildingIds !== null && managedBuildingIds.length > 0) {
          if (!managedBuildingIds.includes(tenancy.building_id)) {
            await client.query("ROLLBACK");
            return next(createError("FORBIDDEN", "Access denied to this building"));
          }
        } else if (managedBuildingIds !== null && managedBuildingIds.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("FORBIDDEN", "Access denied"));
        }

        // Build update query dynamically
        const updates = [];
        const values = [];
        let paramCount = 0;

        if (status) {
          paramCount++;
          updates.push(`offboarding_status = $${paramCount}`);
          values.push(status);
        }

        if (actualMoveOutDate) {
          paramCount++;
          updates.push(`actual_move_out_date = $${paramCount}`);
          values.push(actualMoveOutDate);
        }

        if (finalDues !== undefined) {
          paramCount++;
          updates.push(`final_dues = $${paramCount}`);
          values.push(finalDues);
        }

        if (depositRefundAmount !== undefined) {
          paramCount++;
          updates.push(`deposit_refund_amount = $${paramCount}`);
          values.push(depositRefundAmount);
        }

        if (depositRefundStatus) {
          paramCount++;
          updates.push(`deposit_refund_status = $${paramCount}`);
          values.push(depositRefundStatus);
        }

        // If status is completed, set end_date and move_out_date
        if (status === 'completed') {
          paramCount++;
          updates.push(`end_date = $${paramCount}`);
          values.push(actualMoveOutDate || new Date().toISOString().split('T')[0]);
          
          paramCount++;
          updates.push(`move_out_date = $${paramCount}`);
          values.push(actualMoveOutDate || new Date().toISOString().split('T')[0]);
          
          paramCount++;
          updates.push(`agreement_status = $${paramCount}`);
          values.push('terminated');
        }

        if (updates.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("VALIDATION_ERROR", "No valid fields to update"));
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        paramCount++;
        values.push(id);

        const updateQuery = `
          UPDATE tenancies 
          SET ${updates.join(', ')}
          WHERE id = $${paramCount}
          RETURNING *
        `;

        const updateResult = await client.query(updateQuery, values);

        // If offboarding is completed, mark unit as available
        if (status === 'completed') {
          const unitUpdateQuery = `
            UPDATE units 
            SET status = 'available', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `;
          await client.query(unitUpdateQuery, [tenancy.unit_id]);
        }

        await client.query("COMMIT");

        res.json({
          success: true,
          message: "Offboarding status updated successfully",
          data: {
            tenancy: updateResult.rows[0],
            updated_by: req.user.userId
          }
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Update offboarding status error:", error);
      next(createError("DATABASE_ERROR", "Failed to update offboarding status"));
    }
  };

  // GET /api/offboarding/stats
  // Get offboarding statistics
  getOffboardingStats = async (req, res, next) => {
    try {
      const client = await pool.connect();

      try {
        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        let buildingCondition = "";
        let queryParams = [];

        if (managedBuildingIds !== null && managedBuildingIds.length > 0) {
          buildingCondition = "AND b.id = ANY($1)";
          queryParams.push(managedBuildingIds);
        } else if (managedBuildingIds !== null && managedBuildingIds.length === 0) {
          return next(createError("FORBIDDEN", "Access denied"));
        }

        const statsQuery = `
          SELECT 
            COUNT(*) as total_requests,
            COUNT(CASE WHEN t.offboarding_status = 'initiated' THEN 1 END) as pending_requests,
            COUNT(CASE WHEN t.offboarding_status = 'pending_clearance' THEN 1 END) as clearance_pending,
            COUNT(CASE WHEN t.offboarding_status = 'completed' THEN 1 END) as completed_requests,
            AVG(CASE WHEN t.actual_move_out_date IS NOT NULL AND t.offboarding_initiated_at IS NOT NULL 
                THEN EXTRACT(DAYS FROM t.actual_move_out_date::date - t.offboarding_initiated_at::date) 
                END) as avg_processing_days,
            COALESCE(SUM(CASE WHEN t.offboarding_status = 'completed' THEN t.deposit_refund_amount END), 0) as total_refunds_processed,
            COALESCE(SUM(CASE WHEN t.offboarding_status != 'completed' THEN t.final_dues END), 0) as pending_collections
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.offboarding_status != 'active' ${buildingCondition}
        `;

        const statsResult = await client.query(statsQuery, queryParams);
        const stats = statsResult.rows[0];

        // Get recent offboarding requests (last 30 days)
        const recentQuery = `
          SELECT 
            DATE(t.offboarding_initiated_at) as date,
            COUNT(*) as requests_count
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.offboarding_initiated_at >= CURRENT_DATE - INTERVAL '30 days'
          ${buildingCondition}
          GROUP BY DATE(t.offboarding_initiated_at)
          ORDER BY date DESC
        `;

        const recentResult = await client.query(recentQuery, queryParams);
        const recentRequests = recentResult.rows;

        res.json({
          success: true,
          data: {
            overview: {
              total_requests: parseInt(stats.total_requests),
              pending_requests: parseInt(stats.pending_requests),
              clearance_pending: parseInt(stats.clearance_pending),
              completed_requests: parseInt(stats.completed_requests),
              avg_processing_days: stats.avg_processing_days ? Math.round(parseFloat(stats.avg_processing_days)) : 0,
              total_refunds_processed: parseFloat(stats.total_refunds_processed),
              pending_collections: parseFloat(stats.pending_collections),
            },
            recent_requests: recentRequests,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get offboarding stats error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch offboarding statistics"));
    }
  };
}

export default new OffboardingController();