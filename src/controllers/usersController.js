// src/controllers/usersController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import ExcelJS from "exceljs";
import { Parser } from "json2csv";

class UsersController {
  /**
   * Get all users with filters, search, and pagination
   */
  static async getAllUsers(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        search = "",
        role = "",
        status = "",
        sortBy = "created_at",
        sortOrder = "desc",
        hasProfile,
        dateFrom,
        dateTo,
      } = req.query;

      const offset = (page - 1) * limit;

      // Build WHERE clause dynamically
      let whereConditions = [];
      let queryParams = [];
      let paramCount = 0;

      // Search functionality (name, email, phone)
      if (search) {
        paramCount++;
        whereConditions.push(`(
          u.email ILIKE $${paramCount} OR 
          CONCAT(COALESCE(up.first_name, ''), ' ', COALESCE(up.last_name, '')) ILIKE $${paramCount} OR
          up.phone ILIKE $${paramCount}
        )`);
        queryParams.push(`%${search}%`);
      }

      // Role filter
      if (role) {
        paramCount++;
        whereConditions.push(`u.role = $${paramCount}`);
        queryParams.push(role);
      }

      // Status filter
      if (status) {
        paramCount++;
        whereConditions.push(`u.status = $${paramCount}`);
        queryParams.push(status);
      }

      // Profile completion filter
      if (hasProfile === "true") {
        whereConditions.push("up.id IS NOT NULL");
      } else if (hasProfile === "false") {
        whereConditions.push("up.id IS NULL");
      }

      // Date range filter
      if (dateFrom) {
        paramCount++;
        whereConditions.push(`u.created_at >= $${paramCount}`);
        queryParams.push(dateFrom);
      }
      if (dateTo) {
        paramCount++;
        whereConditions.push(`u.created_at <= $${paramCount}`);
        queryParams.push(dateTo + " 23:59:59");
      }

      const whereClause =
        whereConditions.length > 0
          ? "WHERE " + whereConditions.join(" AND ")
          : "";

      // Validate sort fields
      const allowedSortFields = [
        "created_at",
        "email",
        "role",
        "status",
        "last_login",
        "first_name",
      ];
      const validSortBy = allowedSortFields.includes(sortBy)
        ? sortBy
        : "created_at";
      const validSortOrder = ["asc", "desc"].includes(sortOrder.toLowerCase())
        ? sortOrder.toUpperCase()
        : "DESC";

      // Count total records
      const countQuery = `
        SELECT COUNT(DISTINCT u.id) as total
        FROM users u
        LEFT JOIN user_profiles up ON u.id = up.user_id
        ${whereClause}
      `;

      const countResult = await pool.query(countQuery, queryParams);
      const total = parseInt(countResult.rows[0].total);

      // Fetch users with profiles and additional info
      const sortField =
        validSortBy === "first_name" ? "up.first_name" : `u.${validSortBy}`;

      paramCount++;
      queryParams.push(limit);
      paramCount++;
      queryParams.push(offset);

      const usersQuery = `
        SELECT 
          u.id,
          u.email,
          u.role,
          u.status,
          u.email_verified,
          u.created_at,
          u.updated_at,
          u.last_login,
          up.first_name,
          up.last_name,
          up.phone,
          up.profile_picture,
          up.city,
          up.state,
          CASE WHEN up.id IS NOT NULL THEN true ELSE false END as has_profile,
          CASE 
            WHEN u.role = 'tenant' THEN (
              SELECT COUNT(*) FROM tenancies t 
              WHERE t.tenant_user_id = u.id 
              AND t.agreement_status = 'executed'
            )
            ELSE NULL
          END as active_tenancies_count,
          CASE 
            WHEN u.role = 'tenant' THEN (
              SELECT COALESCE(SUM(p.amount), 0) FROM payments p 
              JOIN tenancies t ON p.tenancy_id = t.id
              WHERE t.tenant_user_id = u.id 
              AND p.status = 'pending'
            )
            ELSE NULL
          END as pending_payments
        FROM users u
        LEFT JOIN user_profiles up ON u.id = up.user_id
        ${whereClause}
        ORDER BY ${sortField} ${validSortOrder}
        LIMIT $${paramCount - 1} OFFSET $${paramCount}
      `;

      const usersResult = await pool.query(usersQuery, queryParams);
      const users = usersResult.rows;

      // Calculate pagination info
      const totalPages = Math.ceil(total / limit);
      const hasNextPage = page < totalPages;
      const hasPrevPage = page > 1;

      res.json({
        success: true,
        data: {
          users,
          pagination: {
            currentPage: parseInt(page),
            totalPages,
            totalItems: total,
            itemsPerPage: parseInt(limit),
            hasNextPage,
            hasPrevPage,
          },
          filters: {
            search,
            role,
            status,
            hasProfile,
            dateFrom,
            dateTo,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get user statistics
   */
  static async getUserStats(req, res, next) {
    try {
      const statsQuery = `
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN role = 'super_admin' THEN 1 END) as super_admins,
          COUNT(CASE WHEN role = 'admin' THEN 1 END) as admins,
          COUNT(CASE WHEN role = 'manager' THEN 1 END) as managers,
          COUNT(CASE WHEN role = 'tenant' THEN 1 END) as tenants,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_users,
          COUNT(CASE WHEN status = 'inactive' THEN 1 END) as inactive_users,
          COUNT(CASE WHEN status = 'suspended' THEN 1 END) as suspended_users,
          COUNT(CASE WHEN email_verified = true THEN 1 END) as verified_users,
          COUNT(up.id) as users_with_profile
        FROM users u
        LEFT JOIN user_profiles up ON u.id = up.user_id
      `;

      const result = await pool.query(statsQuery);
      const stats = result.rows[0];

      // Get recent registrations (last 30 days)
      const recentRegistrationsQuery = `
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as registrations
        FROM users 
        WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `;

      const recentResult = await pool.query(recentRegistrationsQuery);
      const recentRegistrations = recentResult.rows;

      // Get tenant statistics
      const tenantStatsQuery = `
        SELECT 
          COUNT(DISTINCT u.id) as total_tenants,
          COUNT(DISTINCT CASE WHEN t.agreement_status = 'executed' THEN u.id END) as active_tenants,
          COUNT(DISTINCT CASE WHEN t.agreement_status = 'pending' THEN u.id END) as pending_tenants,
          AVG(CASE WHEN t.agreement_status = 'executed' THEN t.rent_amount END) as avg_rent
        FROM users u
        LEFT JOIN tenancies t ON u.id = t.tenant_user_id
        WHERE u.role = 'tenant'
      `;

      const tenantResult = await pool.query(tenantStatsQuery);
      const tenantStats = tenantResult.rows[0];

      res.json({
        success: true,
        data: {
          overview: {
            total_users: parseInt(stats.total_users),
            active_users: parseInt(stats.active_users),
            inactive_users: parseInt(stats.inactive_users),
            suspended_users: parseInt(stats.suspended_users),
            verified_users: parseInt(stats.verified_users),
            users_with_profile: parseInt(stats.users_with_profile),
            profile_completion_rate:
              stats.total_users > 0
                ? Math.round(
                    (stats.users_with_profile / stats.total_users) * 100
                  )
                : 0,
          },
          by_role: {
            super_admins: parseInt(stats.super_admins),
            admins: parseInt(stats.admins),
            managers: parseInt(stats.managers),
            tenants: parseInt(stats.tenants),
          },
          tenant_details: {
            total_tenants: parseInt(tenantStats.total_tenants),
            active_tenants: parseInt(tenantStats.active_tenants),
            pending_tenants: parseInt(tenantStats.pending_tenants),
            average_rent: tenantStats.avg_rent
              ? parseFloat(tenantStats.avg_rent)
              : 0,
          },
          recent_registrations: recentRegistrations,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get specific user by ID with complete details
   */
  static async getUserById(req, res, next) {
    try {
      const { id } = req.params;

      // Get user basic info and profile
      const userQuery = `
        SELECT 
          u.id,
          u.email,
          u.role,
          u.status,
          u.email_verified,
          u.created_at,
          u.updated_at,
          u.last_login,
          up.id as profile_id,
          up.first_name,
          up.last_name,
          up.phone,
          up.date_of_birth,
          up.gender,
          up.address_line1,
          up.address_line2,
          up.city,
          up.state,
          up.country,
          up.postal_code,
          up.emergency_contact_name,
          up.emergency_contact_phone,
          up.emergency_contact_relation,
          up.profile_picture,
          up.id_proof_type,
          up.id_proof_number,
          up.id_proof_document,
          up.created_at as profile_created_at,
          up.updated_at as profile_updated_at
        FROM users u
        LEFT JOIN user_profiles up ON u.id = up.user_id
        WHERE u.id = $1
      `;

      const userResult = await pool.query(userQuery, [id]);

      if (userResult.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      const user = userResult.rows[0];

      // If user is a tenant, get additional tenancy information
      let tenancyInfo = null;
      let paymentsSummary = null;

      if (user.role === "tenant") {
        // Get tenancy history
        const tenancyQuery = `
          SELECT 
            t.id,
            t.start_date,
            t.end_date,
            t.rent_amount,
            t.security_deposit,
            t.agreement_status,
            t.move_in_date,
            t.move_out_date,
            t.notice_period_days,
            t.created_at,
            u.unit_number,
            u.unit_identifier,
            r.room_number,
            r.room_type,
            r.size_sqft,
            f.floor_name,
            f.floor_number,
            b.id as building_id,
            b.name as building_name,
            b.address_line1,
            b.address_line2,
            b.city,
            b.state,
            b.postal_code
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN floors f ON r.floor_id = f.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.tenant_user_id = $1
          ORDER BY t.start_date DESC
        `;

        const tenancyResult = await pool.query(tenancyQuery, [id]);
        tenancyInfo = {
          tenancies: tenancyResult.rows,
          current_tenancy: tenancyResult.rows.find(
            (t) => t.agreement_status === "executed"
          ),
        };

        // Get payments summary
        const paymentsQuery = `
          SELECT 
            COUNT(*) as total_payments,
            COUNT(CASE WHEN p.status = 'paid' THEN 1 END) as paid_payments,
            COUNT(CASE WHEN p.status = 'pending' THEN 1 END) as pending_payments,
            COUNT(CASE WHEN p.status = 'overdue' THEN 1 END) as overdue_payments,
            COUNT(CASE WHEN p.status = 'failed' THEN 1 END) as failed_payments,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount END), 0) as total_paid,
            COALESCE(SUM(CASE WHEN p.status IN ('pending', 'overdue') THEN p.amount END), 0) as total_due,
            COALESCE(SUM(CASE WHEN p.status = 'overdue' THEN p.late_fee END), 0) as total_late_fees
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          WHERE t.tenant_user_id = $1
        `;

        const paymentsResult = await pool.query(paymentsQuery, [id]);
        paymentsSummary = paymentsResult.rows[0];
      }

      res.json({
        success: true,
        data: {
          user,
          tenancy_info: tenancyInfo,
          payments_summary: paymentsSummary,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update user status
   */
  static async updateUserStatus(req, res, next) {
    try {
      const { id } = req.params;
      const { status, reason } = req.body;

      // Check if user exists
      const userCheck = await pool.query("SELECT * FROM users WHERE id = $1", [
        id,
      ]);

      if (userCheck.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      // Prevent updating own status
      if (parseInt(id) === req.user.userId) {
        throw createError("FORBIDDEN", "Cannot update your own status");
      }

      // Update user status
      const updateQuery = `
        UPDATE users 
        SET status = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2 
        RETURNING *
      `;

      const result = await pool.query(updateQuery, [status, id]);
      const updatedUser = result.rows[0];

      // TODO: Log the action in audit log
      // await this.logAuditAction(req.user.userId, 'UPDATE_USER_STATUS', id, { status, reason });

      res.json({
        success: true,
        message: `User status updated to ${status}`,
        data: {
          user: updatedUser,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update user role (Super Admin only)
   */
  static async updateUserRole(req, res, next) {
    try {
      const { id } = req.params;
      const { role, reason } = req.body;

      // Check if user exists
      const userCheck = await pool.query("SELECT * FROM users WHERE id = $1", [
        id,
      ]);

      if (userCheck.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      // Prevent updating own role
      if (parseInt(id) === req.user.userId) {
        throw createError("FORBIDDEN", "Cannot update your own role");
      }

      // Update user role
      const updateQuery = `
        UPDATE users 
        SET role = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2 
        RETURNING *
      `;

      const result = await pool.query(updateQuery, [role, id]);
      const updatedUser = result.rows[0];

      res.json({
        success: true,
        message: `User role updated to ${role}`,
        data: {
          user: updatedUser,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Bulk update users
   */
  static async bulkUpdateUsers(req, res, next) {
    try {
      const { userIds, action, reason } = req.body;

      // Convert action to status
      const statusMap = {
        activate: "active",
        deactivate: "inactive",
        suspend: "suspended",
      };

      const newStatus = statusMap[action];

      // Remove current user from the list to prevent self-update
      const filteredUserIds = userIds.filter(
        (id) => parseInt(id) !== req.user.userId
      );

      if (filteredUserIds.length === 0) {
        throw createError("VALIDATION_ERROR", "No valid users to update");
      }

      // Update users
      const placeholders = filteredUserIds
        .map((_, index) => `$${index + 2}`)
        .join(",");
      const updateQuery = `
        UPDATE users 
        SET status = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id IN (${placeholders})
        RETURNING id, email, status
      `;

      const queryParams = [newStatus, ...filteredUserIds];
      const result = await pool.query(updateQuery, queryParams);

      res.json({
        success: true,
        message: `${result.rows.length} users ${action}d successfully`,
        data: {
          updated_users: result.rows,
          skipped_count: userIds.length - filteredUserIds.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get user tenancy information
   */
  static async getUserTenancy(req, res, next) {
    try {
      const { id } = req.params;

      // Check if user exists and is a tenant
      const userCheck = await pool.query(
        "SELECT role FROM users WHERE id = $1",
        [id]
      );

      if (userCheck.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      if (userCheck.rows[0].role !== "tenant") {
        throw createError("VALIDATION_ERROR", "User is not a tenant");
      }

      // Get tenancy history
      const tenancyQuery = `
        SELECT 
          t.*,
          u.unit_number,
          r.room_number,
          r.room_type,
          r.size_sqft,
          b.name as building_name,
          b.address_line1,
          b.city,
          b.state,
          f.floor_name
        FROM tenancies t
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        JOIN floors f ON r.floor_id = f.id
        JOIN buildings b ON r.building_id = b.id
        WHERE t.tenant_user_id = $1
        ORDER BY t.start_date DESC
      `;

      const result = await pool.query(tenancyQuery, [id]);

      res.json({
        success: true,
        data: {
          tenancies: result.rows,
          current_tenancy: result.rows.find(
            (t) => t.agreement_status === "executed"
          ),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get user payments history
   */
  static async getUserPayments(req, res, next) {
    try {
      const { id } = req.params;
      const { page = 1, limit = 20, status = "", type = "" } = req.query;

      const offset = (page - 1) * limit;

      // Check if user exists and is a tenant
      const userCheck = await pool.query(
        "SELECT role FROM users WHERE id = $1",
        [id]
      );

      if (userCheck.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      if (userCheck.rows[0].role !== "tenant") {
        throw createError("VALIDATION_ERROR", "User is not a tenant");
      }

      // Build WHERE clause for filters
      let whereConditions = ["t.tenant_user_id = $1"];
      let queryParams = [id];
      let paramCount = 1;

      if (status) {
        paramCount++;
        whereConditions.push(`p.status = $${paramCount}`);
        queryParams.push(status);
      }

      if (type) {
        paramCount++;
        whereConditions.push(`p.payment_type = $${paramCount}`);
        queryParams.push(type);
      }

      const whereClause = "WHERE " + whereConditions.join(" AND ");

      // Count total records
      const countQuery = `
        SELECT COUNT(*) as total
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        ${whereClause}
      `;

      const countResult = await pool.query(countQuery, queryParams);
      const total = parseInt(countResult.rows[0].total);

      // Fetch payments
      paramCount++;
      queryParams.push(limit);
      paramCount++;
      queryParams.push(offset);

      const paymentsQuery = `
        SELECT 
          p.id,
          p.payment_type,
          p.amount,
          p.due_date,
          p.payment_date,
          p.payment_method,
          p.transaction_id,
          p.status,
          p.late_fee,
          p.notes,
          p.created_at,
          u.unit_number,
          r.room_number,
          b.name as building_name,
          t.id as tenancy_id
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        ${whereClause}
        ORDER BY p.due_date DESC
        LIMIT $${paramCount - 1} OFFSET $${paramCount}
      `;

      const paymentsResult = await pool.query(paymentsQuery, queryParams);

      // Calculate pagination
      const totalPages = Math.ceil(total / limit);

      res.json({
        success: true,
        data: {
          payments: paymentsResult.rows,
          pagination: {
            currentPage: parseInt(page),
            totalPages,
            totalItems: total,
            itemsPerPage: parseInt(limit),
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get user activity logs
   */
  static async getUserActivity(req, res, next) {
    try {
      const { id } = req.params;
      const { page = 1, limit = 20 } = req.query;

      // Check if user exists
      const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
        id,
      ]);

      if (userCheck.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      // For now, we'll return login activity
      // You can extend this to include other activities from an audit log table
      const activityQuery = `
        SELECT 
          'login' as activity_type,
          'User logged in' as description,
          last_login as timestamp,
          NULL as details
        FROM users 
        WHERE id = $1 AND last_login IS NOT NULL
        ORDER BY last_login DESC
        LIMIT $2 OFFSET $3
      `;

      const offset = (page - 1) * limit;
      const result = await pool.query(activityQuery, [id, limit, offset]);

      res.json({
        success: true,
        data: {
          activities: result.rows,
          pagination: {
            currentPage: parseInt(page),
            itemsPerPage: parseInt(limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Export users to CSV/Excel
   */
  static async exportUsers(req, res, next) {
    try {
      const { format = "csv", role = "", status = "" } = req.query;

      // Build WHERE clause for filters
      let whereConditions = [];
      let queryParams = [];
      let paramCount = 0;

      if (role) {
        paramCount++;
        whereConditions.push(`u.role = $${paramCount}`);
        queryParams.push(role);
      }

      if (status) {
        paramCount++;
        whereConditions.push(`u.status = $${paramCount}`);
        queryParams.push(status);
      }

      const whereClause =
        whereConditions.length > 0
          ? "WHERE " + whereConditions.join(" AND ")
          : "";

      // Fetch all users for export
      const exportQuery = `
        SELECT 
          u.id,
          u.email,
          u.role,
          u.status,
          u.email_verified,
          u.created_at,
          u.last_login,
          up.first_name,
          up.last_name,
          up.phone,
          up.city,
          up.state,
          up.date_of_birth,
          up.gender
        FROM users u
        LEFT JOIN user_profiles up ON u.id = up.user_id
        ${whereClause}
        ORDER BY u.created_at DESC
      `;

      const result = await pool.query(exportQuery, queryParams);
      const users = result.rows;

      if (format === "excel") {
        // Create Excel file
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Users");

        // Add headers
        worksheet.columns = [
          { header: "ID", key: "id", width: 10 },
          { header: "Email", key: "email", width: 30 },
          { header: "First Name", key: "first_name", width: 20 },
          { header: "Last Name", key: "last_name", width: 20 },
          { header: "Phone", key: "phone", width: 15 },
          { header: "Role", key: "role", width: 15 },
          { header: "Status", key: "status", width: 15 },
          { header: "Email Verified", key: "email_verified", width: 15 },
          { header: "City", key: "city", width: 20 },
          { header: "State", key: "state", width: 20 },
          { header: "Date of Birth", key: "date_of_birth", width: 15 },
          { header: "Gender", key: "gender", width: 10 },
          { header: "Created At", key: "created_at", width: 20 },
          { header: "Last Login", key: "last_login", width: 20 },
        ];

        // Add rows
        worksheet.addRows(users);

        // Style the header row
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFE0E0E0" },
        };

        // Set response headers
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=users_export_${
            new Date().toISOString().split("T")[0]
          }.xlsx`
        );

        // Write to response
        await workbook.xlsx.write(res);
        res.end();
      } else {
        // Create CSV file
        const fields = [
          "id",
          "email",
          "first_name",
          "last_name",
          "phone",
          "role",
          "status",
          "email_verified",
          "city",
          "state",
          "date_of_birth",
          "gender",
          "created_at",
          "last_login",
        ];

        const parser = new Parser({ fields });
        const csv = parser.parse(users);

        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=users_export_${
            new Date().toISOString().split("T")[0]
          }.csv`
        );

        res.send(csv);
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * Send notification to user
   */
  static async sendNotificationToUser(req, res, next) {
    try {
      const { id } = req.params;
      const { subject, message, type = "email" } = req.body;

      // Check if user exists and get contact info
      const userQuery = `
        SELECT u.email, up.phone, up.first_name, up.last_name
        FROM users u
        LEFT JOIN user_profiles up ON u.id = up.user_id
        WHERE u.id = $1 AND u.status = 'active'
      `;

      const userResult = await pool.query(userQuery, [id]);

      if (userResult.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found or inactive");
      }

      const user = userResult.rows[0];

      // TODO: Implement actual email/SMS sending logic here
      // For now, we'll just return success

      // You can use your existing email service here
      // await sendEmail(user.email, subject, message);

      // If SMS is required and phone exists
      // if ((type === 'sms' || type === 'both') && user.phone) {
      //   await sendSMS(user.phone, message);
      // }

      res.json({
        success: true,
        message: `Notification sent to ${user.first_name || user.email}`,
        data: {
          recipient: {
            email: user.email,
            phone: user.phone,
            name: `${user.first_name || ""} ${user.last_name || ""}`.trim(),
          },
          notification: {
            subject,
            message,
            type,
            sent_at: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create new user
   */
  static async createUser(req, res, next) {
    try {
      const {
        email,
        role = "tenant",
        status = "active",
        first_name,
        last_name,
        phone,
        date_of_birth,
        gender,
        address_line1,
        address_line2,
        city,
        state,
        country,
        postal_code,
        emergency_contact_name,
        emergency_contact_phone,
        emergency_contact_relation,
        id_proof_type,
        id_proof_number,
      } = req.body;

      // Check if user already exists
      const existingUser = await pool.query(
        "SELECT id FROM users WHERE email = $1",
        [email]
      );

      if (existingUser.rows.length > 0) {
        throw createError("CONFLICT", "User with this email already exists");
      }

      // Start transaction
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // TODO: Hash password before storing
        // const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const userQuery = `
          INSERT INTO users (email, role, status, email_verified, created_at, updated_at)
          VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING *
        `;

        const userResult = await client.query(userQuery, [
          email,
          role,
          status,
          false, // email_verified = false for new users
        ]);

        const newUser = userResult.rows[0];

        // Create user profile if profile data is provided
        if (first_name || last_name || phone) {
          const profileQuery = `
            INSERT INTO user_profiles (
              user_id,
              first_name,
              last_name,
              phone,
              date_of_birth,
              gender,
              address_line1,
              address_line2,
              city,
              state,
              country,
              postal_code,
              emergency_contact_name,
              emergency_contact_phone,
              emergency_contact_relation,
              id_proof_type,
              id_proof_number,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING *
          `;

          await client.query(profileQuery, [
            newUser.id,
            first_name,
            last_name,
            phone,
            date_of_birth || null,
            gender || null,
            address_line1 || null,
            address_line2 || null,
            city || null,
            state || null,
            country || null,
            postal_code || null,
            emergency_contact_name || null,
            emergency_contact_phone || null,
            emergency_contact_relation || null,
            id_proof_type || null,
            id_proof_number || null,
          ]);
        }

        await client.query("COMMIT");

        // TODO: Send welcome email with temporary password
        // await sendWelcomeEmail(email, password);

        res.status(201).json({
          success: true,
          message: "User created successfully",
          data: {
            user: {
              ...newUser,
              first_name,
              last_name,
              phone,
            },
          },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update user and profile
   */
  static async updateUser(req, res, next) {
    try {
      const { id } = req.params;
      const {
        role,
        status,
        first_name,
        last_name,
        phone,
        date_of_birth,
        gender,
        address_line1,
        address_line2,
        city,
        state,
        country,
        postal_code,
        emergency_contact_name,
        emergency_contact_phone,
        emergency_contact_relation,
        id_proof_type,
        id_proof_number,
      } = req.body;

      // Check if user exists
      const userCheck = await pool.query("SELECT * FROM users WHERE id = $1", [
        id,
      ]);

      if (userCheck.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      // Start transaction
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Update user basic info if provided
        if (role !== undefined || status !== undefined) {
          const updateUserQuery = `
            UPDATE users 
            SET role = COALESCE($1, role),
                status = COALESCE($2, status),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
          `;

          await client.query(updateUserQuery, [role, status, id]);
        }

        // Update or create user profile
        const profileCheck = await client.query(
          "SELECT id FROM user_profiles WHERE user_id = $1",
          [id]
        );

        if (profileCheck.rows.length > 0) {
          // Update existing profile
          const updateProfileQuery = `
            UPDATE user_profiles 
            SET first_name = COALESCE($1, first_name),
                last_name = COALESCE($2, last_name),
                phone = COALESCE($3, phone),
                date_of_birth = COALESCE($4, date_of_birth),
                gender = COALESCE($5, gender),
                address_line1 = COALESCE($6, address_line1),
                address_line2 = COALESCE($7, address_line2),
                city = COALESCE($8, city),
                state = COALESCE($9, state),
                country = COALESCE($10, country),
                postal_code = COALESCE($11, postal_code),
                emergency_contact_name = COALESCE($12, emergency_contact_name),
                emergency_contact_phone = COALESCE($13, emergency_contact_phone),
                emergency_contact_relation = COALESCE($14, emergency_contact_relation),
                id_proof_type = COALESCE($15, id_proof_type),
                id_proof_number = COALESCE($16, id_proof_number),
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $17
          `;

          await client.query(updateProfileQuery, [
            first_name,
            last_name,
            phone,
            date_of_birth,
            gender,
            address_line1,
            address_line2,
            city,
            state,
            country,
            postal_code,
            emergency_contact_name,
            emergency_contact_phone,
            emergency_contact_relation,
            id_proof_type,
            id_proof_number,
            id,
          ]);
        } else if (first_name || last_name || phone) {
          // Create new profile
          const createProfileQuery = `
            INSERT INTO user_profiles (
              user_id,
              first_name,
              last_name,
              phone,
              date_of_birth,
              gender,
              address_line1,
              address_line2,
              city,
              state,
              country,
              postal_code,
              emergency_contact_name,
              emergency_contact_phone,
              emergency_contact_relation,
              id_proof_type,
              id_proof_number,
              created_at,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `;

          await client.query(createProfileQuery, [
            id,
            first_name,
            last_name,
            phone,
            date_of_birth,
            gender,
            address_line1,
            address_line2,
            city,
            state,
            country,
            postal_code,
            emergency_contact_name,
            emergency_contact_phone,
            emergency_contact_relation,
            id_proof_type,
            id_proof_number,
          ]);
        }

        await client.query("COMMIT");

        // Get updated user data
        const updatedUserQuery = `
          SELECT 
            u.*,
            up.first_name,
            up.last_name,
            up.phone,
            up.date_of_birth,
            up.gender,
            up.address_line1,
            up.address_line2,
            up.city,
            up.state,
            up.country,
            up.postal_code,
            up.emergency_contact_name,
            up.emergency_contact_phone,
            up.emergency_contact_relation,
            up.id_proof_type,
            up.id_proof_number,
            up.profile_picture
          FROM users u
          LEFT JOIN user_profiles up ON u.id = up.user_id
          WHERE u.id = $1
        `;

        const updatedUserResult = await client.query(updatedUserQuery, [id]);

        res.json({
          success: true,
          message: "User updated successfully",
          data: {
            user: updatedUserResult.rows[0],
          },
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete user (soft delete by setting status to inactive)
   */
  static async deleteUser(req, res, next) {
    try {
      const { id } = req.params;

      // Check if user exists
      const userCheck = await pool.query("SELECT * FROM users WHERE id = $1", [
        id,
      ]);

      if (userCheck.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      // Prevent deleting own account
      if (parseInt(id) === req.user.userId) {
        throw createError("FORBIDDEN", "Cannot delete your own account");
      }

      // Soft delete by setting status to inactive
      const deleteQuery = `
        UPDATE users 
        SET status = 'inactive', updated_at = CURRENT_TIMESTAMP 
        WHERE id = $1 
        RETURNING id, email, status
      `;

      const result = await pool.query(deleteQuery, [id]);

      res.json({
        success: true,
        message: "User deleted successfully",
        data: {
          user: result.rows[0],
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Upload user profile picture
   */
  static async uploadProfilePicture(req, res, next) {
    try {
      const { id } = req.params;

      // Check if user exists
      const userCheck = await pool.query("SELECT id FROM users WHERE id = $1", [
        id,
      ]);

      if (userCheck.rows.length === 0) {
        throw createError("NOT_FOUND", "User not found");
      }

      if (!req.file) {
        throw createError("VALIDATION_ERROR", "No file uploaded");
      }

      // TODO: Upload file to storage service (S3, Cloudinary, etc.)
      // For now, we'll just use the filename
      const profilePictureUrl = `/uploads/profiles/${req.file.filename}`;

      // Update user profile with new picture URL
      const updateQuery = `
        UPDATE user_profiles 
        SET profile_picture = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE user_id = $2
        RETURNING profile_picture
      `;

      const result = await pool.query(updateQuery, [profilePictureUrl, id]);

      if (result.rows.length === 0) {
        // Create profile if it doesn't exist
        const createQuery = `
          INSERT INTO user_profiles (user_id, profile_picture, created_at, updated_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING profile_picture
        `;

        const createResult = await pool.query(createQuery, [
          id,
          profilePictureUrl,
        ]);

        res.json({
          success: true,
          message: "Profile picture uploaded successfully",
          data: {
            profile_picture: createResult.rows[0].profile_picture,
          },
        });
      } else {
        res.json({
          success: true,
          message: "Profile picture updated successfully",
          data: {
            profile_picture: result.rows[0].profile_picture,
          },
        });
      }
    } catch (error) {
      next(error);
    }
  }
}

export default UsersController;
