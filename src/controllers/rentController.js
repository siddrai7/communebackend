// src/controllers/rentController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import fs from "fs/promises";
import path from "path";

class RentController {
  /**
   * Get building IDs accessible to the current user based on role
   */
  static async getAccessibleBuildingIds(userId, userRole) {
    if (userRole === "super_admin" || userRole === "admin") {
      // Super admin and admin can access all buildings
      const result = await pool.query(
        "SELECT id FROM buildings WHERE status = $1",
        ["active"]
      );
      return result.rows.map((row) => row.id);
    } else if (userRole === "manager") {
      // Manager can only access buildings they manage
      const result = await pool.query(
        "SELECT id FROM buildings WHERE manager_id = $1 AND status = $2",
        [userId, "active"]
      );
      return result.rows.map((row) => row.id);
    }
    return [];
  }

  /**
   * GET /api/rent-collection/overview
   * Get rent collection overview with building-wise breakdown
   */
  static async getOverview(req, res, next) {
    try {
      const { month, year, building_id } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Get accessible building IDs
      const accessibleBuildingIds =
        await RentController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            overview: {
              totalDue: 0,
              totalCollected: 0,
              totalOutstanding: 0,
              collectionRate: 0,
              totalPayments: 0,
              overduePayments: 0,
            },
            buildings: [],
          },
        });
      }

      const currentDate = new Date();
      const targetMonth = month ? parseInt(month) : currentDate.getMonth() + 1;
      const targetYear = year ? parseInt(year) : currentDate.getFullYear();

      let buildingFilter = "";
      let params = [];
      let paramIndex = 1;

      // Filter by accessible buildings
      buildingFilter = ` AND b.id = ANY($${paramIndex})`;
      params.push(accessibleBuildingIds);
      paramIndex++;

      // Additional building filter if specified
      if (
        building_id &&
        accessibleBuildingIds.includes(parseInt(building_id))
      ) {
        buildingFilter += ` AND b.id = $${paramIndex}`;
        params.push(parseInt(building_id));
        paramIndex++;
      }

      // Get overall overview from payments table only
      const overviewQuery = `
        SELECT 
          COUNT(DISTINCT p.id) as total_payments,
          COALESCE(SUM(p.amount), 0) as total_due,
          COALESCE(SUM(
            CASE WHEN p.status = 'paid' THEN p.amount
                 ELSE 0 END
          ), 0) as total_collected,
          COALESCE(SUM(
            CASE WHEN p.status != 'paid' 
                 THEN p.amount
                 ELSE 0 END
          ), 0) as total_outstanding,
          COUNT(DISTINCT CASE 
            WHEN p.due_date < CURRENT_DATE 
            AND p.status NOT IN ('paid') 
            THEN p.id 
          END) as overdue_payments,
          COUNT(DISTINCT CASE 
            WHEN p.status = 'paid' 
            THEN p.id 
          END) as paid_payments
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        WHERE p.due_date >= '${targetYear}-${targetMonth.toString().padStart(2, '0')}-01' 
        AND p.due_date < '${targetMonth === 12 ? targetYear + 1 : targetYear}-${(targetMonth === 12 ? 1 : targetMonth + 1).toString().padStart(2, '0')}-01'
        ${buildingFilter}
      `;

      const overviewResult = await pool.query(overviewQuery, params);
      const overview = overviewResult.rows[0];

      const totalDue = parseFloat(overview.total_due) || 0;
      const totalCollected = parseFloat(overview.total_collected) || 0;
      const collectionRate =
        totalDue > 0 ? ((totalCollected / totalDue) * 100).toFixed(2) : 0;

      // Get building-wise breakdown
      const buildingsQuery = `
        SELECT 
          b.id,
          b.name,
          b.address_line1,
          b.city,
          COUNT(DISTINCT u.id) as total_units,
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t2 
              WHERE t2.unit_id = u.id 
              AND t2.agreement_status = 'executed'
              AND CURRENT_DATE >= t2.start_date 
              AND CURRENT_DATE <= t2.end_date
            ) THEN u.id 
          END) as occupied_units,
          
          -- Building payments for the target month/year
          COALESCE(SUM(
            CASE WHEN bp.due_date >= '${targetYear}-${targetMonth.toString().padStart(2, '0')}-01' 
                 AND bp.due_date < '${targetMonth === 12 ? targetYear + 1 : targetYear}-${(targetMonth === 12 ? 1 : targetMonth + 1).toString().padStart(2, '0')}-01'
                 THEN bp.amount ELSE 0 END
          ), 0) as building_total_due,
          COALESCE(SUM(
            CASE WHEN bp.due_date >= '${targetYear}-${targetMonth.toString().padStart(2, '0')}-01' 
                 AND bp.due_date < '${targetMonth === 12 ? targetYear + 1 : targetYear}-${(targetMonth === 12 ? 1 : targetMonth + 1).toString().padStart(2, '0')}-01'
                 AND bp.status = 'paid' 
                 THEN bp.amount ELSE 0 END
          ), 0) as building_total_collected,
          COUNT(DISTINCT CASE 
            WHEN bp.due_date >= '${targetYear}-${targetMonth.toString().padStart(2, '0')}-01' 
            AND bp.due_date < '${targetMonth === 12 ? targetYear + 1 : targetYear}-${(targetMonth === 12 ? 1 : targetMonth + 1).toString().padStart(2, '0')}-01'
            AND bp.status NOT IN ('paid') 
            THEN bp.id 
          END) as pending_payments,
          COUNT(DISTINCT CASE 
            WHEN bp.due_date >= '${targetYear}-${targetMonth.toString().padStart(2, '0')}-01' 
            AND bp.due_date < '${targetMonth === 12 ? targetYear + 1 : targetYear}-${(targetMonth === 12 ? 1 : targetMonth + 1).toString().padStart(2, '0')}-01'
            AND bp.due_date < CURRENT_DATE 
            AND bp.status NOT IN ('paid') 
            THEN bp.id 
          END) as overdue_payments
        FROM buildings b
        LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
        LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
        LEFT JOIN units u ON r.id = u.room_id
        LEFT JOIN tenancies t ON u.id = t.unit_id AND t.agreement_status = 'executed'
        LEFT JOIN payments bp ON t.id = bp.tenancy_id
        WHERE b.id = ANY($1) ${
          building_id && accessibleBuildingIds.includes(parseInt(building_id))
            ? " AND b.id = $2"
            : ""
        }
        GROUP BY b.id, b.name, b.address_line1, b.city
        ORDER BY b.name
      `;

      const buildingsResult = await pool.query(buildingsQuery, params);

      const buildings = buildingsResult.rows.map((building) => {
        const buildingDue = parseFloat(building.building_total_due) || 0;
        const buildingCollected =
          parseFloat(building.building_total_collected) || 0;
        const buildingCollectionRate =
          buildingDue > 0
            ? ((buildingCollected / buildingDue) * 100).toFixed(2)
            : 0;
        const occupancyRate =
          building.total_units > 0
            ? ((building.occupied_units / building.total_units) * 100).toFixed(
                2
              )
            : 0;

        return {
          id: building.id,
          name: building.name,
          address: building.address_line1,
          city: building.city,
          totalUnits: parseInt(building.total_units) || 0,
          occupiedUnits: parseInt(building.occupied_units) || 0,
          occupancyRate: parseFloat(occupancyRate),
          totalDue: buildingDue,
          totalCollected: buildingCollected,
          totalOutstanding: buildingDue - buildingCollected,
          collectionRate: parseFloat(buildingCollectionRate),
          pendingPayments: parseInt(building.pending_payments) || 0,
          overduePayments: parseInt(building.overdue_payments) || 0,
        };
      });

      const response = {
        success: true,
        data: {
          overview: {
            totalDue: totalDue,
            totalCollected: totalCollected,
            totalOutstanding: totalDue - totalCollected,
            collectionRate: parseFloat(collectionRate),
            totalPayments: parseInt(overview.total_payments) || 0,
            overduePayments: parseInt(overview.overdue_payments) || 0,
            paidPayments: parseInt(overview.paid_payments) || 0,
            month: targetMonth,
            year: targetYear,
          },
          buildings,
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching rent collection overview:", error);
      next(
        createError(
          "DATABASE_ERROR",
          "Failed to fetch rent collection overview"
        )
      );
    }
  }

  /**
   * GET /api/rent-collection/payments
   * Get paginated list of rent payments with comprehensive filters
   */
  static async getPayments(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        building_id,
        month,
        year,
        start_date,
        end_date,
        tenant_search,
        overdue_only,
        days_overdue,
        sort_by = "due_date",
        sort_order = "desc",
      } = req.query;

      const userId = req.user.id;
      const userRole = req.user.role;

      // Get accessible building IDs
      const accessibleBuildingIds =
        await RentController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            payments: [],
            pagination: {
              currentPage: 1,
              totalPages: 0,
              totalItems: 0,
              itemsPerPage: parseInt(limit),
              hasNextPage: false,
              hasPrevPage: false,
            },
          },
        });
      }


      let whereConditions = ["b.id = ANY($1)"];
      let params = [accessibleBuildingIds];
      let paramIndex = 2;

      // Building filter
      if (
        building_id &&
        accessibleBuildingIds.includes(parseInt(building_id))
      ) {
        whereConditions.push(`b.id = $${paramIndex}`);
        params.push(parseInt(building_id));
        paramIndex++;
      }

      // Status filter
      if (status) {
        whereConditions.push(`p.status = $${paramIndex}`);
        params.push(status);
        paramIndex++;
      }

      // Date range filters
      if (month && year) {
        const monthInt = parseInt(month);
        const yearInt = parseInt(year);
        // Calculate next month and year for range
        const nextMonth = monthInt === 12 ? 1 : monthInt + 1;
        const nextYear = monthInt === 12 ? yearInt + 1 : yearInt;
        whereConditions.push(
          `p.due_date >= '${yearInt}-${monthInt.toString().padStart(2, '0')}-01' AND p.due_date < '${nextYear}-${nextMonth.toString().padStart(2, '0')}-01'`
        );
      } else if (start_date && end_date) {
        whereConditions.push(
          `p.due_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`
        );
        params.push(start_date, end_date);
        paramIndex += 2;
      }

      // Tenant search
      if (tenant_search) {
        whereConditions.push(`(
          LOWER(up.first_name) LIKE LOWER($${paramIndex}) OR 
          LOWER(up.last_name) LIKE LOWER($${paramIndex}) OR 
          LOWER(u_user.email) LIKE LOWER($${paramIndex}) OR
          un.unit_number LIKE $${paramIndex}
        )`);
        params.push(`%${tenant_search}%`);
        paramIndex++;
      }

      // Overdue filter
      if (overdue_only === "true") {
        whereConditions.push(
          `p.due_date < CURRENT_DATE AND p.status != 'paid'`
        );
      }

      const whereClause = whereConditions.join(" AND ");

      // Determine sort column
      let sortColumn;
      switch (sort_by) {
        case "amount":
          sortColumn = `p.amount ${sort_order.toUpperCase()}`;
          break;
        case "tenant_name":
          sortColumn = `up.first_name ${sort_order.toUpperCase()}, up.last_name ${sort_order.toUpperCase()}`;
          break;
        case "unit_number":
          sortColumn = `un.unit_number ${sort_order.toUpperCase()}`;
          break;
        case "status":
          sortColumn = `p.status ${sort_order.toUpperCase()}`;
          break;
        default:
          sortColumn = `p.due_date ${sort_order.toUpperCase()}`;
      }

      // Main payments query
      const overdueQuery = `
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
          
          -- Tenant info
          u_user.email as tenant_email,
          up.first_name,
          up.last_name,
          up.phone as tenant_phone,
          
          -- Unit info
          un.unit_number,
          un.rent_amount as unit_rent,
          r.room_number,
          r.room_type,
          f.floor_number,
          
          -- Building info
          b.id as building_id,
          b.name as building_name,
          
          -- Tenancy info
          t.id as tenancy_id,
          t.start_date as tenancy_start,
          t.end_date as tenancy_end,
          t.rent_amount as tenancy_rent,
          
          -- Calculate days overdue
          CASE 
            WHEN p.due_date < CURRENT_DATE AND p.status != 'paid'
            THEN (CURRENT_DATE - p.due_date)::integer
            ELSE 0
          END as days_overdue,
          
          -- Aging category
          CASE 
            WHEN p.due_date >= CURRENT_DATE OR p.status = 'paid' THEN 'current'
            WHEN (CURRENT_DATE - p.due_date) BETWEEN 1 AND 7 THEN '1-7'
            WHEN (CURRENT_DATE - p.due_date) BETWEEN 8 AND 15 THEN '8-15'
            WHEN (CURRENT_DATE - p.due_date) BETWEEN 16 AND 30 THEN '16-30'
            WHEN (CURRENT_DATE - p.due_date) BETWEEN 31 AND 60 THEN '31-60'
            ELSE '60+'
          END as aging_bucket,
          
          -- Get receipt files
          COALESCE(
            ARRAY(
              SELECT json_build_object(
                'id', pr.id,
                'file_name', pr.file_name,
                'file_path', pr.file_path,
                'file_size', pr.file_size,
                'uploaded_at', pr.uploaded_at
              )
              FROM payment_receipts pr 
              WHERE pr.payment_id = p.id
              ORDER BY pr.uploaded_at DESC
            ), 
            ARRAY[]::json[]
          ) as receipts
          
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        JOIN users u_user ON t.tenant_user_id = u_user.id
        JOIN user_profiles up ON u_user.id = up.user_id
        JOIN units un ON t.unit_id = un.id
        JOIN rooms r ON un.room_id = r.id
        JOIN floors f ON r.floor_id = f.id
        JOIN buildings b ON r.building_id = b.id
        WHERE ${whereClause}
        ORDER BY ${sortColumn}
      `;

      const overdueResult = await pool.query(overdueQuery, params);

      // Calculate aging summary
      const aging = {
        "current": { count: 0, amount: 0 },
        "1-7": { count: 0, amount: 0 },
        "8-15": { count: 0, amount: 0 },
        "16-30": { count: 0, amount: 0 },
        "31-60": { count: 0, amount: 0 },
        "60+": { count: 0, amount: 0 },
      };

      let totalOverdue = 0;
      let totalAmount = 0;

      const payments = overdueResult.rows.map((payment) => {
        const amount = parseFloat(payment.amount);
        const bucket = payment.aging_bucket;

        aging[bucket].count += 1;
        aging[bucket].amount += amount;
        totalOverdue += 1;
        totalAmount += amount;

        return {
          id: payment.id,
          amount: amount,
          dueDate: payment.due_date,
          status: payment.status,
          lateFee: parseFloat(payment.late_fee) || 0,
          paymentType: payment.payment_type,
          daysOverdue: payment.days_overdue,
          agingBucket: payment.aging_bucket,

          tenant: {
            firstName: payment.first_name,
            lastName: payment.last_name,
            fullName: `${payment.first_name || ""} ${
              payment.last_name || ""
            }`.trim(),
            email: payment.tenant_email,
            phone: payment.tenant_phone,
          },

          unit: {
            unitNumber: payment.unit_number,
            roomNumber: payment.room_number,
            floorNumber: payment.floor_number,
          },

          building: {
            id: payment.building_id,
            name: payment.building_name,
          },

          tenancy: {
            rentAmount: parseFloat(payment.tenancy_rent),
          },
        };
      });

      res.json({
        success: true,
        data: {
          summary: {
            totalOverdue,
            totalAmount,
            aging,
          },
          payments,
          filters: {
            building_id,
            days_overdue,
            sort_by,
          },
        },
      });
    } catch (error) {
      console.error("Error fetching overdue payments:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch overdue payments"));
    }
  }

  /**
   * PUT /api/rent-collection/payments/:paymentId
   * Update payment status and upload receipts
   */
  static async updatePayment(req, res, next) {
    const client = await pool.connect();

    try {
      const { paymentId } = req.params;
      const {
        status,
        paid_amount,
        payment_date,
        payment_method,
        transaction_id,
        late_fee,
        notes,
      } = req.body;
      const files = req.files || [];
      const userId = req.user.id;
      const userRole = req.user.role;

      await client.query("BEGIN");

      // First, verify payment exists and user has access
      const accessibleBuildingIds =
        await RentController.getAccessibleBuildingIds(userId, userRole);

      const paymentCheckQuery = `
        SELECT p.*, b.id as building_id, t.id as tenancy_id
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        WHERE p.id = $1 AND b.id = ANY($2)
      `;

      const paymentCheckResult = await client.query(paymentCheckQuery, [
        paymentId,
        accessibleBuildingIds,
      ]);

      if (paymentCheckResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return next(
          createError("NOT_FOUND", "Payment not found or access denied")
        );
      }


      // Prepare update fields
      let updateFields = [];
      let updateParams = [];
      let paramIndex = 1;

      if (status) {
        updateFields.push(`status = $${paramIndex}`);
        updateParams.push(status);
        paramIndex++;
      }

      if (paid_amount !== undefined) {
        updateFields.push(`paid_amount = $${paramIndex}`);
        updateParams.push(parseFloat(paid_amount));
        paramIndex++;
      }

      if (payment_date) {
        updateFields.push(`payment_date = $${paramIndex}`);
        updateParams.push(payment_date);
        paramIndex++;
      }

      if (payment_method) {
        updateFields.push(`payment_method = $${paramIndex}`);
        updateParams.push(payment_method);
        paramIndex++;
      }

      if (transaction_id) {
        updateFields.push(`transaction_id = $${paramIndex}`);
        updateParams.push(transaction_id);
        paramIndex++;
      }

      if (late_fee !== undefined) {
        updateFields.push(`late_fee = $${paramIndex}`);
        updateParams.push(parseFloat(late_fee));
        paramIndex++;
      }

      if (notes) {
        updateFields.push(`notes = $${paramIndex}`);
        updateParams.push(notes);
        paramIndex++;
      }

      // Update payment if there are fields to update
      if (updateFields.length > 0) {
        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        const updateQuery = `
          UPDATE payments 
          SET ${updateFields.join(", ")}
          WHERE id = $${paramIndex}
          RETURNING *
        `;

        updateParams.push(paymentId);
        await client.query(updateQuery, updateParams);
      }

      // Handle file uploads
      const uploadedReceipts = [];
      if (files.length > 0) {
        for (const file of files) {
          const receiptQuery = `
            INSERT INTO payment_receipts (
              payment_id, file_name, file_path, file_size, uploaded_by, uploaded_at
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            RETURNING *
          `;

          const receiptResult = await client.query(receiptQuery, [
            paymentId,
            file.originalname,
            file.path,
            file.size,
            userId,
          ]);

          uploadedReceipts.push({
            id: receiptResult.rows[0].id,
            fileName: receiptResult.rows[0].file_name,
            filePath: receiptResult.rows[0].file_path,
            fileSize: receiptResult.rows[0].file_size,
            uploadedAt: receiptResult.rows[0].uploaded_at,
          });
        }
      }

      await client.query("COMMIT");

      // Fetch updated payment with all details
      const updatedPaymentQuery = `
        SELECT 
          p.*,
          up.first_name,
          up.last_name,
          u_user.email as tenant_email,
          un.unit_number,
          b.name as building_name,
          COALESCE(
            ARRAY(
              SELECT json_build_object(
                'id', pr.id,
                'file_name', pr.file_name,
                'file_path', pr.file_path,
                'file_size', pr.file_size,
                'uploaded_at', pr.uploaded_at
              )
              FROM payment_receipts pr 
              WHERE pr.payment_id = p.id
              ORDER BY pr.uploaded_at DESC
            ), 
            ARRAY[]::json[]
          ) as receipts
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        JOIN users u_user ON t.tenant_user_id = u_user.id
        JOIN user_profiles up ON u_user.id = up.user_id
        JOIN units un ON t.unit_id = un.id
        JOIN rooms r ON un.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        WHERE p.id = $1
      `;

      const updatedResult = await client.query(updatedPaymentQuery, [
        paymentId,
      ]);
      const updatedPayment = updatedResult.rows[0];

      res.json({
        success: true,
        message: "Payment updated successfully",
        data: {
          payment: {
            id: updatedPayment.id,
            amount: parseFloat(updatedPayment.amount),
            status: updatedPayment.status,
            paymentDate: updatedPayment.payment_date,
            paymentMethod: updatedPayment.payment_method,
            transactionId: updatedPayment.transaction_id,
            lateFee: parseFloat(updatedPayment.late_fee) || 0,
            notes: updatedPayment.notes,
            paidAmount: 0,
            tenant: {
              name: `${updatedPayment.first_name || ""} ${
                updatedPayment.last_name || ""
              }`.trim(),
              email: updatedPayment.tenant_email,
            },
            unit: {
              unitNumber: updatedPayment.unit_number,
            },
            building: {
              name: updatedPayment.building_name,
            },
            receipts: updatedPayment.receipts || [],
          },
          uploadedReceipts,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error updating payment:", error);

      // Clean up uploaded files on error
      if (req.files) {
        for (const file of req.files) {
          try {
            await fs.unlink(file.path);
          } catch (unlinkError) {
            console.error("Error deleting uploaded file:", unlinkError);
          }
        }
      }

      next(createError("DATABASE_ERROR", "Failed to update payment"));
    } finally {
      client.release();
    }
  }

  /**
   * GET /api/rent-collection/overdue
   * Get overdue payments with aging analysis
   */
  static async getOverduePayments(req, res, next) {
    try {
      const { building_id, days_overdue, sort_by = "days_overdue" } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Get accessible building IDs
      const accessibleBuildingIds =
        await RentController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            summary: {
              totalOverdue: 0,
              totalAmount: 0,
              aging: {
                "1-7": { count: 0, amount: 0 },
                "8-15": { count: 0, amount: 0 },
                "16-30": { count: 0, amount: 0 },
                "31-60": { count: 0, amount: 0 },
                "60+": { count: 0, amount: 0 },
              },
            },
            payments: [],
          },
        });
      }

      let whereConditions = [
        "b.id = ANY($1)",
        "p.due_date < CURRENT_DATE",
        "p.status != 'paid'",
      ];
      let params = [accessibleBuildingIds];
      let paramIndex = 2;

      // Building filter
      if (
        building_id &&
        accessibleBuildingIds.includes(parseInt(building_id))
      ) {
        whereConditions.push(`b.id = $${paramIndex}`);
        params.push(parseInt(building_id));
        paramIndex++;
      }

      // Days overdue filter
      if (days_overdue) {
        const daysOverdueInt = parseInt(days_overdue);
        whereConditions.push(
          `(CURRENT_DATE - p.due_date) >= ${daysOverdueInt}`
        );
      }

      const whereClause = whereConditions.join(" AND ");

      // Determine sort column
      let sortColumn;
      switch (sort_by) {
        case "amount":
          sortColumn = "p.amount DESC";
          break;
        case "tenant_name":
          sortColumn = "up.first_name, up.last_name";
          break;
        case "unit_number":
          sortColumn = "un.unit_number";
          break;
        default:
          sortColumn = "days_overdue DESC";
      }

      // Get overdue payments with aging analysis
      const overdueQuery = `
        SELECT 
          p.id,
          p.amount,
          p.due_date,
          p.status,
          p.late_fee,
          p.payment_type,
          
          -- Tenant info
          up.first_name,
          up.last_name,
          u_user.email as tenant_email,
          up.phone as tenant_phone,
          
          -- Unit info
          un.unit_number,
          r.room_number,
          f.floor_number,
          
          -- Building info
          b.id as building_id,
          b.name as building_name,
          
          -- Tenancy info
          t.rent_amount as tenancy_rent,
          
          -- Calculate days overdue
          (CURRENT_DATE - p.due_date)::integer as days_overdue,
          
          -- Aging category
          CASE 
            WHEN (CURRENT_DATE - p.due_date) BETWEEN 1 AND 7 THEN '1-7'
            WHEN (CURRENT_DATE - p.due_date) BETWEEN 8 AND 15 THEN '8-15'
            WHEN (CURRENT_DATE - p.due_date) BETWEEN 16 AND 30 THEN '16-30'
            WHEN (CURRENT_DATE - p.due_date) BETWEEN 31 AND 60 THEN '31-60'
            ELSE '60+'
          END as aging_bucket
          
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        JOIN users u_user ON t.tenant_user_id = u_user.id
        JOIN user_profiles up ON u_user.id = up.user_id
        JOIN units un ON t.unit_id = un.id
        JOIN rooms r ON un.room_id = r.id
        JOIN floors f ON r.floor_id = f.id
        JOIN buildings b ON r.building_id = b.id
        WHERE ${whereClause}
        ORDER BY ${sortColumn}
      `;

      const overdueResult = await pool.query(overdueQuery, params);

      // Calculate aging summary
      const aging = {
        "current": { count: 0, amount: 0 },
        "1-7": { count: 0, amount: 0 },
        "8-15": { count: 0, amount: 0 },
        "16-30": { count: 0, amount: 0 },
        "31-60": { count: 0, amount: 0 },
        "60+": { count: 0, amount: 0 },
      };

      let totalOverdue = 0;
      let totalAmount = 0;

      const payments = overdueResult.rows.map((payment) => {
        const amount = parseFloat(payment.amount);
        const bucket = payment.aging_bucket;

        aging[bucket].count += 1;
        aging[bucket].amount += amount;
        totalOverdue += 1;
        totalAmount += amount;

        return {
          id: payment.id,
          amount: amount,
          dueDate: payment.due_date,
          status: payment.status,
          lateFee: parseFloat(payment.late_fee) || 0,
          paymentType: payment.payment_type,
          daysOverdue: payment.days_overdue,
          agingBucket: payment.aging_bucket,

          tenant: {
            firstName: payment.first_name,
            lastName: payment.last_name,
            fullName: `${payment.first_name || ""} ${
              payment.last_name || ""
            }`.trim(),
            email: payment.tenant_email,
            phone: payment.tenant_phone,
          },

          unit: {
            unitNumber: payment.unit_number,
            roomNumber: payment.room_number,
            floorNumber: payment.floor_number,
          },

          building: {
            id: payment.building_id,
            name: payment.building_name,
          },

          tenancy: {
            rentAmount: parseFloat(payment.tenancy_rent),
          },
        };
      });

      res.json({
        success: true,
        data: {
          summary: {
            totalOverdue,
            totalAmount,
            aging,
          },
          payments,
          filters: {
            building_id,
            days_overdue,
            sort_by,
          },
        },
      });
    } catch (error) {
      console.error("Error fetching overdue payments:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch overdue payments"));
    }
  }

  /**
   * GET /api/rent-collection/tenant/:tenantId/history
   * Get payment history for a specific tenant
   */
  static async getTenantPaymentHistory(req, res, next) {
    try {
      const { tenantId } = req.params;
      const { limit = 20, year } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Get accessible building IDs
      const accessibleBuildingIds =
        await RentController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            tenant: null,
            payments: [],
            summary: {
              totalPayments: 0,
              totalPaid: 0,
              totalOutstanding: 0,
              onTimePayments: 0,
              latePayments: 0,
            },
          },
        });
      }

      // Verify tenant exists and user has access to their building
      const tenantCheckQuery = `
        SELECT 
          u.id,
          u.email,
          up.first_name,
          up.last_name,
          up.phone,
          b.id as building_id,
          b.name as building_name
        FROM users u
        JOIN user_profiles up ON u.id = up.user_id
        JOIN tenancies t ON u.id = t.tenant_user_id AND t.agreement_status = 'executed'
        JOIN units un ON t.unit_id = un.id
        JOIN rooms r ON un.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        WHERE u.id = $1 AND b.id = ANY($2)
        LIMIT 1
      `;

      const tenantResult = await pool.query(tenantCheckQuery, [
        tenantId,
        accessibleBuildingIds,
      ]);

      if (tenantResult.rows.length === 0) {
        return next(
          createError("NOT_FOUND", "Tenant not found or access denied")
        );
      }

      const tenant = tenantResult.rows[0];

      let whereConditions = ["u_user.id = $1", "b.id = ANY($2)"];
      let params = [tenantId, accessibleBuildingIds];
      let paramIndex = 3;

      // Year filter
      if (year) {
        const yearInt = parseInt(year);
        whereConditions.push(`p.due_date >= '${yearInt}-01-01' AND p.due_date < '${yearInt + 1}-01-01'`);
      }

      const whereClause = whereConditions.join(" AND ");

      // Get payment history
      const historyQuery = `
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
          
          -- Unit info
          un.unit_number,
          r.room_number,
          f.floor_number,
          
          -- Building info
          b.name as building_name,
          
          -- Tenancy info
          t.rent_amount as tenancy_rent,
          t.start_date as tenancy_start,
          t.end_date as tenancy_end,
          
          -- Calculate if payment was on time
          CASE 
            WHEN p.payment_date IS NOT NULL AND p.payment_date <= p.due_date THEN true
            ELSE false
          END as paid_on_time,
          
          -- Days late (if applicable)
          CASE 
            WHEN p.payment_date IS NOT NULL AND p.payment_date > p.due_date
            THEN (p.payment_date - p.due_date)::integer
            ELSE 0
          END as days_late
          
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        JOIN users u_user ON t.tenant_user_id = u_user.id
        JOIN units un ON t.unit_id = un.id
        JOIN rooms r ON un.room_id = r.id
        JOIN floors f ON r.floor_id = f.id
        JOIN buildings b ON r.building_id = b.id
        WHERE ${whereClause}
        ORDER BY p.due_date DESC
        LIMIT $${paramIndex}
      `;

      params.push(parseInt(limit));
      const historyResult = await pool.query(historyQuery, params);

      // Calculate summary statistics
      let totalPayments = 0;
      let totalPaid = 0;
      let totalOutstanding = 0;
      let onTimePayments = 0;
      let latePayments = 0;

      const payments = historyResult.rows.map((payment) => {
        const amount = parseFloat(payment.amount);

        totalPayments += 1;
        if (payment.status === "paid") {
          totalPaid += amount;
        } else {
          totalOutstanding += amount;
        }

        if (payment.status === "paid" && payment.paid_on_time) {
          onTimePayments += 1;
        } else if (payment.status === "paid" && !payment.paid_on_time) {
          latePayments += 1;
        }

        return {
          id: payment.id,
          paymentType: payment.payment_type,
          amount: amount,
          dueDate: payment.due_date,
          paymentDate: payment.payment_date,
          paymentMethod: payment.payment_method,
          transactionId: payment.transaction_id,
          status: payment.status,
          lateFee: parseFloat(payment.late_fee) || 0,
          notes: payment.notes,
          paidOnTime: payment.paid_on_time,
          daysLate: payment.days_late,
          paidAmount: 0,
          createdAt: payment.created_at,

          unit: {
            unitNumber: payment.unit_number,
            roomNumber: payment.room_number,
            floorNumber: payment.floor_number,
          },

          building: {
            name: payment.building_name,
          },

          tenancy: {
            rentAmount: parseFloat(payment.tenancy_rent),
            startDate: payment.tenancy_start,
            endDate: payment.tenancy_end,
          },
        };
      });

      res.json({
        success: true,
        data: {
          tenant: {
            id: tenant.id,
            email: tenant.email,
            firstName: tenant.first_name,
            lastName: tenant.last_name,
            fullName: `${tenant.first_name || ""} ${
              tenant.last_name || ""
            }`.trim(),
            phone: tenant.phone,
            building: {
              id: tenant.building_id,
              name: tenant.building_name,
            },
          },
          payments,
          summary: {
            totalPayments,
            totalPaid: Math.round(totalPaid * 100) / 100,
            totalOutstanding: Math.round(totalOutstanding * 100) / 100,
            onTimePayments,
            latePayments,
            paymentRate:
              totalPayments > 0
                ? (
                    ((onTimePayments + latePayments) / totalPayments) *
                    100
                  ).toFixed(1)
                : 0,
            onTimeRate:
              onTimePayments + latePayments > 0
                ? (
                    (onTimePayments / (onTimePayments + latePayments)) *
                    100
                  ).toFixed(1)
                : 0,
          },
          filters: {
            limit: parseInt(limit),
            year,
          },
        },
      });
    } catch (error) {
      console.error("Error fetching tenant payment history:", error);
      next(
        createError("DATABASE_ERROR", "Failed to fetch tenant payment history")
      );
    }
  }

  /**
   * POST /api/rent-collection/send-reminders
   * Send payment reminder emails to tenants
   */
  static async sendPaymentReminders(req, res, next) {
    try {
      const { payment_ids, reminder_type } = req.body;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Get accessible building IDs
      const accessibleBuildingIds =
        await RentController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            sent: 0,
            failed: 0,
            results: [],
          },
        });
      }

      // Verify all payment IDs exist and user has access
      const paymentsQuery = `
        SELECT 
          p.id,
          p.amount,
          p.due_date,
          p.status,
          u_user.email as tenant_email,
          up.first_name,
          up.last_name,
          un.unit_number,
          b.name as building_name,
          (CURRENT_DATE - p.due_date)::integer as days_overdue
        FROM payments p
        JOIN tenancies t ON p.tenancy_id = t.id
        JOIN users u_user ON t.tenant_user_id = u_user.id
        JOIN user_profiles up ON u_user.id = up.user_id
        JOIN units un ON t.unit_id = un.id
        JOIN rooms r ON un.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        WHERE p.id = ANY($1) AND b.id = ANY($2) AND p.status != 'paid'
      `;

      const paymentsResult = await pool.query(paymentsQuery, [
        payment_ids,
        accessibleBuildingIds,
      ]);

      if (paymentsResult.rows.length === 0) {
        return next(
          createError("NOT_FOUND", "No valid payments found for reminders")
        );
      }

      const results = [];
      let sentCount = 0;
      let failedCount = 0;

      // Reminder functionality would be implemented here
      // const reminderTemplates = {
      //   gentle: { subject: "Friendly Reminder: Rent Payment Due", template: "gentle_reminder" },
      //   firm: { subject: "Important: Overdue Rent Payment", template: "firm_reminder" },
      //   final: { subject: "FINAL NOTICE: Immediate Action Required", template: "final_reminder" },
      // };
      // const reminderConfig = reminderTemplates[reminder_type];

      // Send reminders (This is a placeholder - implement actual email sending)
      for (const payment of paymentsResult.rows) {
        try {
          // Here you would implement the actual email sending logic
          // using your email service (nodemailer, etc.)

          // Email data would be prepared here for actual email sending
          // const emailData = {
          //   to: payment.tenant_email,
          //   subject: reminderConfig.subject,
          //   template: reminderConfig.template,
          //   data: {
          //     tenantName: `${payment.first_name || ""} ${payment.last_name || ""}`.trim(),
          //     unitNumber: payment.unit_number,
          //     buildingName: payment.building_name,
          //     amount: parseFloat(payment.amount),
          //     dueDate: payment.due_date,
          //     daysOverdue: payment.days_overdue,
          //     customMessage: custom_message || "",
          //   },
          // };

          // Placeholder for email sending
          // await emailService.sendReminderEmail(emailData);

          results.push({
            paymentId: payment.id,
            tenantEmail: payment.tenant_email,
            status: "sent",
            sentAt: new Date().toISOString(),
          });

          sentCount++;
        } catch (emailError) {
          console.error(
            `Failed to send reminder for payment ${payment.id}:`,
            emailError
          );

          results.push({
            paymentId: payment.id,
            tenantEmail: payment.tenant_email,
            status: "failed",
            error: emailError.message,
          });

          failedCount++;
        }
      }

      // Log reminder activity (optional)
      // You might want to create a reminders table to track sent reminders

      res.json({
        success: true,
        message: `Sent ${sentCount} reminders, ${failedCount} failed`,
        data: {
          sent: sentCount,
          failed: failedCount,
          results,
          reminderType: reminder_type,
          totalPayments: paymentsResult.rows.length,
        },
      });
    } catch (error) {
      console.error("Error sending payment reminders:", error);
      next(createError("DATABASE_ERROR", "Failed to send payment reminders"));
    }
  }
}

export default RentController;
