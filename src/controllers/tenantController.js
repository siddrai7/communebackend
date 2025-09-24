// src/controllers/tenantController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import { sendComplaintEmail } from "../services/emailService.js";
import path from "path";
import fs from "fs/promises";

class TenantController {
  // GET /api/tenant/dashboard
  async getDashboard(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      console.log("userId", userId);

      try {
        // Get current tenancy
        const tenancyQuery = `
          SELECT 
            t.id as tenancy_id, t.start_date, t.end_date, t.rent_amount, 
            t.security_deposit, t.agreement_status, t.move_in_date,
            u.unit_number, r.room_number, b.name as building_name
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.tenant_user_id = $1 AND t.agreement_status = 'executed'
          ORDER BY t.start_date DESC
          LIMIT 1
        `;

        const tenancyResult = await client.query(tenancyQuery, [userId]);
        const tenancy = tenancyResult.rows[0] || null;

        // Get payment summary
        const paymentSummaryQuery = `
          SELECT 
            COUNT(*) as total_payments,
            COUNT(*) FILTER (WHERE p.status = 'paid') as paid_payments,
            COUNT(*) FILTER (WHERE p.status = 'pending') as pending_payments,
            COUNT(*) FILTER (WHERE p.status = 'overdue') as overdue_payments,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0) as total_paid,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('pending', 'overdue')), 0) as total_due
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          WHERE t.tenant_user_id = $1 
          AND p.due_date >= CURRENT_DATE - INTERVAL '6 months'
        `;

        const paymentSummaryResult = await client.query(paymentSummaryQuery, [
          userId,
        ]);
        const paymentSummary = paymentSummaryResult.rows[0];

        // Get complaint stats
        const complaintStatsQuery = `
          SELECT 
            COUNT(*) as total_complaints,
            COUNT(*) FILTER (WHERE c.status IN ('submitted', 'acknowledged', 'in_progress')) as active_complaints,
            COUNT(*) FILTER (WHERE c.status = 'resolved') as resolved_complaints
          FROM complaints c
          WHERE c.tenant_user_id = $1 
          AND c.created_at >= CURRENT_DATE - INTERVAL '6 months'
        `;

        const complaintStatsResult = await client.query(complaintStatsQuery, [
          userId,
        ]);
        const complaintStats = complaintStatsResult.rows[0];

        // Get next rent due
        const nextRentQuery = `
          SELECT p.id, p.amount, p.due_date, p.status
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          WHERE t.tenant_user_id = $1 
          AND p.payment_type = 'rent'
          AND p.status IN ('pending', 'partial')
          AND p.due_date >= CURRENT_DATE
          ORDER BY p.due_date ASC
          LIMIT 1
        `;

        const nextRentResult = await client.query(nextRentQuery, [userId]);
        const nextRentDue = nextRentResult.rows[0] || null;

        res.json({
          success: true,
          data: {
            summary: {
              tenancy,
              payments: paymentSummary,
              complaints: complaintStats,
            },
            nextRentDue,
            quickActions: [
              {
                title: "Pay Rent",
                description: "Make online rent payment",
                action: "payment",
                enabled: nextRentDue ? true : false,
              },
              {
                title: "Report Issue",
                description: "Submit a maintenance complaint",
                action: "complaint",
                enabled: true,
              },
              {
                title: "View Documents",
                description: "Access lease and payment documents",
                action: "documents",
                enabled: true,
              },
            ],
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get dashboard error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch dashboard data"));
    }
  }

  // GET /api/tenant/profile
  async getProfile(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        const query = `
          SELECT 
            u.id, u.email, u.role, u.status, u.email_verified,
            u.created_at, u.last_login,
            p.first_name, p.last_name, p.phone, p.date_of_birth,
            p.gender, p.address_line1, p.address_line2, p.city,
            p.state, p.country, p.postal_code, p.profile_picture,
            p.emergency_contact_name, p.emergency_contact_phone,
            p.emergency_contact_relation, p.id_proof_type,
            p.id_proof_number, p.id_proof_document
          FROM users u
          LEFT JOIN user_profiles p ON u.id = p.user_id
          WHERE u.id = $1
        `;

        const result = await client.query(query, [userId]);

        if (result.rows.length === 0) {
          return next(createError("NOT_FOUND", "User profile not found"));
        }

        const profile = result.rows[0];

        // Remove sensitive information
        delete profile.id_proof_document; // Don't expose file paths directly

        res.json({
          success: true,
          data: profile,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get profile error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch profile"));
    }
  }

  // PUT /api/tenant/profile
  async updateProfile(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        await client.query("BEGIN");

        const {
          firstName,
          lastName,
          phone,
          dateOfBirth,
          gender,
          addressLine1,
          addressLine2,
          city,
          state,
          country,
          postalCode,
          emergencyContactName,
          emergencyContactPhone,
          emergencyContactRelation,
        } = req.body;

        // Check if profile exists
        const profileCheck = await client.query(
          "SELECT id FROM user_profiles WHERE user_id = $1",
          [userId]
        );

        let query, params;

        if (profileCheck.rows.length === 0) {
          // Create new profile
          query = `
            INSERT INTO user_profiles (
              user_id, first_name, last_name, phone, date_of_birth, gender,
              address_line1, address_line2, city, state, country, postal_code,
              emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
              updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CURRENT_TIMESTAMP)
            RETURNING *
          `;
          params = [
            userId,
            firstName,
            lastName,
            phone,
            dateOfBirth,
            gender,
            addressLine1,
            addressLine2,
            city,
            state,
            country,
            postalCode,
            emergencyContactName,
            emergencyContactPhone,
            emergencyContactRelation,
          ];
        } else {
          // Update existing profile
          query = `
            UPDATE user_profiles SET
              first_name = $2, last_name = $3, phone = $4, date_of_birth = $5,
              gender = $6, address_line1 = $7, address_line2 = $8, city = $9,
              state = $10, country = $11, postal_code = $12,
              emergency_contact_name = $13, emergency_contact_phone = $14,
              emergency_contact_relation = $15, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
            RETURNING *
          `;
          params = [
            userId,
            firstName,
            lastName,
            phone,
            dateOfBirth,
            gender,
            addressLine1,
            addressLine2,
            city,
            state,
            country,
            postalCode,
            emergencyContactName,
            emergencyContactPhone,
            emergencyContactRelation,
          ];
        }

        const result = await client.query(query, params);
        await client.query("COMMIT");

        res.json({
          success: true,
          message: "Profile updated successfully",
          data: result.rows[0],
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Update profile error:", error);
      next(createError("DATABASE_ERROR", "Failed to update profile"));
    }
  }

  // POST /api/tenant/profile/avatar
  async updateAvatar(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      if (!req.file) {
        return next(createError("VALIDATION_ERROR", "No image file provided"));
      }

      try {
        const profilePicturePath = `/uploads/avatars/${req.file.filename}`;

        // Update profile picture path in database
        await client.query(
          `INSERT INTO user_profiles (user_id, profile_picture, updated_at) 
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id) 
           DO UPDATE SET profile_picture = $2, updated_at = CURRENT_TIMESTAMP`,
          [userId, profilePicturePath]
        );

        res.json({
          success: true,
          message: "Profile picture updated successfully",
          data: { profilePicture: profilePicturePath },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Update avatar error:", error);
      next(createError("DATABASE_ERROR", "Failed to update profile picture"));
    }
  }

  // GET /api/tenant/property-details
  async getPropertyDetails(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        const query = `
          SELECT 
            t.id as tenancy_id, t.start_date, t.end_date, t.rent_amount, 
            t.security_deposit, t.agreement_status, t.move_in_date, t.move_out_date,
            
            u.id as unit_id, u.unit_number, u.unit_identifier, u.rent_amount as unit_rent,
            u.security_deposit as unit_deposit, u.target_selling_price,
            
            r.id as room_id, r.room_number, r.room_type, r.size_sqft, r.amenities as room_amenities,
            r.furnishing_status, r.ac_available, r.wifi_available, r.room_images,
            
            f.floor_number, f.floor_name,
            
            b.id as building_id, b.name as building_name, b.address_line1, b.address_line2,
            b.city, b.state, b.postal_code, b.total_floors, b.total_units,
            b.building_image, b.description as building_description, b.amenities as building_amenities,
            b.contact_person, b.contact_phone
            
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN floors f ON r.floor_id = f.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.tenant_user_id = $1 AND t.agreement_status = 'executed'
          ORDER BY t.start_date DESC
          LIMIT 1
        `;

        const result = await client.query(query, [userId]);

        if (result.rows.length === 0) {
          return next(createError("NOT_FOUND", "No active tenancy found"));
        }

        const propertyData = result.rows[0];

        res.json({
          success: true,
          data: {
            tenancy: {
              id: propertyData.tenancy_id,
              startDate: propertyData.start_date,
              endDate: propertyData.end_date,
              rentAmount: propertyData.rent_amount,
              securityDeposit: propertyData.security_deposit,
              agreementStatus: propertyData.agreement_status,
              moveInDate: propertyData.move_in_date,
              moveOutDate: propertyData.move_out_date,
            },
            unit: {
              id: propertyData.unit_id,
              unitNumber: propertyData.unit_number,
              unitIdentifier: propertyData.unit_identifier,
              rentAmount: propertyData.unit_rent,
              securityDeposit: propertyData.unit_deposit,
              targetSellingPrice: propertyData.target_selling_price,
            },
            room: {
              id: propertyData.room_id,
              roomNumber: propertyData.room_number,
              roomType: propertyData.room_type,
              sizeSqft: propertyData.size_sqft,
              amenities: propertyData.room_amenities || [],
              furnishingStatus: propertyData.furnishing_status,
              acAvailable: propertyData.ac_available,
              wifiAvailable: propertyData.wifi_available,
              images: propertyData.room_images || [],
            },
            floor: {
              floorNumber: propertyData.floor_number,
              floorName: propertyData.floor_name,
            },
            building: {
              id: propertyData.building_id,
              name: propertyData.building_name,
              address: {
                line1: propertyData.address_line1,
                line2: propertyData.address_line2,
                city: propertyData.city,
                state: propertyData.state,
                postalCode: propertyData.postal_code,
              },
              totalFloors: propertyData.total_floors,
              totalUnits: propertyData.total_units,
              image: propertyData.building_image,
              description: propertyData.building_description,
              amenities: propertyData.building_amenities || [],
              contact: {
                person: propertyData.contact_person,
                phone: propertyData.contact_phone,
              },
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get property details error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch property details"));
    }
  }

  // GET /api/tenant/payments
  async getPayments(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        const {
          page = 1,
          limit = 20,
          status = "all",
          type = "all",
        } = req.query;
        const offset = (page - 1) * limit;

        let statusFilter = "";
        let typeFilter = "";
        const params = [userId, limit, offset];

        if (status !== "all") {
          statusFilter = "AND p.status = $4";
          params.push(status);
        }

        if (type !== "all") {
          const typeParamIndex = params.length + 1;
          typeFilter = `AND p.payment_type = $${typeParamIndex}`;
          params.push(type);
        }

        const query = `
          SELECT 
            p.id, p.payment_type, p.amount, p.due_date, p.payment_date,
            p.payment_method, p.transaction_id, p.status, p.late_fee,
            p.notes, p.created_at,
            t.id as tenancy_id, t.rent_amount,
            u.unit_number, r.room_number, b.name as building_name,
            rc.cycle_month, rc.cycle_year
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          LEFT JOIN rent_cycles rc ON (rc.tenancy_id = t.id AND 
                                      p.payment_type = 'rent' AND 
                                      EXTRACT(MONTH FROM p.due_date) = rc.cycle_month AND 
                                      EXTRACT(YEAR FROM p.due_date) = rc.cycle_year)
          WHERE t.tenant_user_id = $1
          ${statusFilter}
          ${typeFilter}
          ORDER BY p.due_date DESC, p.created_at DESC
          LIMIT $2 OFFSET $3
        `;

        const result = await client.query(query, params);

        // Get total count
        const countQuery = `
          SELECT COUNT(*) as total
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          WHERE t.tenant_user_id = $1
          ${statusFilter.replace(/\$4/, `$${params.length - 2}`)}
          ${typeFilter.replace(/\$\d+/, `$${params.length - 1}`)}
        `;
        const countParams = [userId];
        if (status !== "all") countParams.push(status);
        if (type !== "all") countParams.push(type);

        const countResult = await client.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].total);

        res.json({
          success: true,
          data: result.rows,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get payments error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch payments"));
    }
  }

  // GET /api/tenant/payments/upcoming
  async getUpcomingPayments(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        const query = `
          SELECT 
            p.id, p.payment_type, p.amount, p.due_date, p.status,
            p.late_fee, u.unit_number, r.room_number,
            CASE 
              WHEN p.due_date < CURRENT_DATE THEN 'overdue'
              WHEN p.due_date = CURRENT_DATE THEN 'due_today'
              WHEN p.due_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'due_this_week'
              ELSE 'upcoming'
            END as urgency_status,
            (p.due_date - CURRENT_DATE) as days_until_due
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          WHERE t.tenant_user_id = $1 
          AND p.status IN ('pending', 'partial')
          AND p.due_date <= CURRENT_DATE + INTERVAL '30 days'
          ORDER BY 
            CASE 
              WHEN p.due_date < CURRENT_DATE THEN 1
              WHEN p.due_date = CURRENT_DATE THEN 2
              ELSE 3
            END,
            p.due_date ASC
        `;

        const result = await client.query(query, [userId]);

        // Categorize payments
        const categorized = {
          overdue: [],
          dueToday: [],
          dueThisWeek: [],
          upcoming: [],
        };

        result.rows.forEach((payment) => {
          switch (payment.urgency_status) {
            case "overdue":
              categorized.overdue.push(payment);
              break;
            case "due_today":
              categorized.dueToday.push(payment);
              break;
            case "due_this_week":
              categorized.dueThisWeek.push(payment);
              break;
            default:
              categorized.upcoming.push(payment);
          }
        });

        res.json({
          success: true,
          data: {
            ...categorized,
            summary: {
              totalOverdue: categorized.overdue.length,
              totalDueToday: categorized.dueToday.length,
              totalDueThisWeek: categorized.dueThisWeek.length,
              totalUpcoming: categorized.upcoming.length,
              overdue_amount: categorized.overdue.reduce(
                (sum, p) => sum + parseFloat(p.amount || 0),
                0
              ),
              due_today_amount: categorized.dueToday.reduce(
                (sum, p) => sum + parseFloat(p.amount || 0),
                0
              ),
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get upcoming payments error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch upcoming payments"));
    }
  }

  // GET /api/tenant/complaints
  async getComplaints(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        const {
          page = 1,
          limit = 20,
          status = "all",
          category = "all",
        } = req.query;
        const offset = (page - 1) * limit;

        let statusFilter = "";
        let categoryFilter = "";
        const params = [userId, limit, offset];

        if (status !== "all") {
          statusFilter = "AND c.status = $4";
          params.push(status);
        }

        if (category !== "all") {
          const categoryParamIndex = params.length + 1;
          categoryFilter = `AND c.category = $${categoryParamIndex}`;
          params.push(category);
        }

        const query = `
          SELECT 
            c.id, c.complaint_number, c.title, c.description, c.category,
            c.subcategory, c.priority, c.status, c.attachments,
            c.tenant_satisfaction_rating, c.tenant_feedback,
            c.created_at, c.updated_at, c.resolved_at, c.closed_at,
            u.unit_number, r.room_number, b.name as building_name,
            assigned_user.email as assigned_to_email,
            COALESCE(up.first_name || ' ' || up.last_name, assigned_user.email) as assigned_to_name
          FROM complaints c
          LEFT JOIN units u ON c.unit_id = u.id
          LEFT JOIN rooms r ON c.room_id = r.id
          LEFT JOIN buildings b ON c.building_id = b.id
          LEFT JOIN users assigned_user ON c.assigned_to = assigned_user.id
          LEFT JOIN user_profiles up ON assigned_user.id = up.user_id
          WHERE c.tenant_user_id = $1
          ${statusFilter}
          ${categoryFilter}
          ORDER BY c.created_at DESC
          LIMIT $2 OFFSET $3
        `;

        const result = await client.query(query, params);

        // Get total count
        const countQuery = `
          SELECT COUNT(*) as total
          FROM complaints c
          WHERE c.tenant_user_id = $1
          ${statusFilter.replace(/\$4/, `$${params.length - 2}`)}
          ${categoryFilter.replace(/\$\d+/, `$${params.length - 1}`)}
        `;
        const countParams = [userId];
        if (status !== "all") countParams.push(status);
        if (category !== "all") countParams.push(category);

        const countResult = await client.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].total);

        res.json({
          success: true,
          data: result.rows,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get complaints error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch complaints"));
    }
  }

  // POST /api/tenant/complaints
  async createComplaint(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        await client.query("BEGIN");

        const {
          title,
          description,
          category,
          subcategory,
          priority = "medium",
        } = req.body;

        // Get tenant's current property details including building code
        const tenancyQuery = `
          SELECT t.id, t.unit_id, u.room_id, r.building_id, b.building_code
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.tenant_user_id = $1 AND t.agreement_status = 'executed'
          ORDER BY t.start_date DESC
          LIMIT 1
        `;

        const tenancyResult = await client.query(tenancyQuery, [userId]);

        if (tenancyResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "No active tenancy found"));
        }

        const { unit_id, room_id, building_id, building_code } = tenancyResult.rows[0];

        // Generate complaint number: COMP_buildingCode_uniqueNumber
        const lastComplaintQuery = `
          SELECT complaint_number 
          FROM complaints 
          WHERE building_id = $1 AND complaint_number LIKE $2
          ORDER BY id DESC 
          LIMIT 1
        `;
        const lastComplaintResult = await client.query(lastComplaintQuery, [
          building_id, 
          `COMP_${building_code}_%`
        ]);
        
        let nextNumber = 1;
        if (lastComplaintResult.rows.length > 0) {
          const lastNumber = lastComplaintResult.rows[0].complaint_number;
          const numberPart = lastNumber.split('_').pop();
          nextNumber = parseInt(numberPart) + 1;
        }
        
        const complaintNumber = `COMP_${building_code}_${nextNumber}`;

        // Handle file attachments if any
        let attachments = [];
        if (req.files && req.files.length > 0) {
          attachments = req.files.map(
            (file) => `/uploads/complaints/${file.filename}`
          );
        }

        // Insert complaint
        const insertQuery = `
          INSERT INTO complaints (
            complaint_number, tenant_user_id, building_id, room_id, unit_id,
            title, description, category, subcategory, priority,
            attachments, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'submitted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING *
        `;

        const insertResult = await client.query(insertQuery, [
          complaintNumber,
          userId,
          building_id,
          room_id,
          unit_id,
          title,
          description,
          category,
          subcategory,
          priority,
          attachments,
        ]);

        const complaint = insertResult.rows[0];

        // Log initial activity
        await client.query(
          `INSERT INTO complaint_activities (
            complaint_id, activity_type, description, created_by, created_for
          ) VALUES ($1, 'status_change', 'Complaint submitted by tenant', $2, 'tenant')`,
          [complaint.id, userId]
        );

        await client.query("COMMIT");

        // Get additional data for email notifications
        const emailDataQuery = `
          SELECT 
            c.id, c.title, c.description, c.category, c.priority, c.created_at,
            CONCAT('COMP-', LPAD(c.id::text, 6, '0')) as complaint_number,
            u.email as tenant_email,
            up.first_name || ' ' || up.last_name as tenant_name,
            b.name as building_name,
            un.unit_number,
            admin.email as admin_email,
            admin_profile.first_name || ' ' || admin_profile.last_name as admin_name
          FROM complaints c
          JOIN users u ON c.tenant_user_id = u.id
          LEFT JOIN user_profiles up ON u.id = up.user_id
          JOIN buildings b ON c.building_id = b.id
          LEFT JOIN units un ON c.unit_id = un.id
          LEFT JOIN users admin ON b.manager_id = admin.id AND admin.role IN ('admin', 'super_admin', 'manager')
          LEFT JOIN user_profiles admin_profile ON admin.id = admin_profile.user_id
          WHERE c.id = $1
        `;
        
        const emailDataResult = await client.query(emailDataQuery, [complaint.id]);
        
        if (emailDataResult.rows.length > 0) {
          const emailData = emailDataResult.rows[0];
          
          // Send email notification to tenant (confirmation)
          try {
            await sendComplaintEmail('new_complaint', emailData.tenant_email, {
              complaintNumber: emailData.complaint_number,
              tenantName: emailData.tenant_name,
              title: emailData.title,
              description: emailData.description,
              category: emailData.category,
              priority: emailData.priority,
              buildingName: emailData.building_name,
              unitNumber: emailData.unit_number,
              createdAt: emailData.created_at,
              complaintId: complaint.id
            });
            console.log(`✅ Tenant notification sent for complaint ${emailData.complaint_number}`);
          } catch (emailError) {
            console.error(`❌ Failed to send tenant notification for complaint ${emailData.complaint_number}:`, emailError);
          }

          // Send email notification to admin/manager if available
          if (emailData.admin_email) {
            try {
              await sendComplaintEmail('admin_notification', emailData.admin_email, {
                complaintNumber: emailData.complaint_number,
                tenantName: emailData.tenant_name,
                adminName: emailData.admin_name,
                title: emailData.title,
                description: emailData.description,
                category: emailData.category,
                priority: emailData.priority,
                buildingName: emailData.building_name,
                unitNumber: emailData.unit_number,
                createdAt: emailData.created_at,
                complaintId: complaint.id
              });
              console.log(`✅ Admin notification sent for complaint ${emailData.complaint_number}`);
            } catch (emailError) {
              console.error(`❌ Failed to send admin notification for complaint ${emailData.complaint_number}:`, emailError);
            }
          } else {
            console.log(`⚠️ No admin email found for building ${emailData.building_name}`);
          }
        }

        res.status(201).json({
          success: true,
          message: "Complaint submitted successfully",
          data: complaint,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Create complaint error:", error);
      next(createError("DATABASE_ERROR", "Failed to create complaint"));
    }
  }

  // GET /api/tenant/complaints/:id
  async getComplaintDetails(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;
      const complaintId = req.params.id;

      try {
        // Get complaint details
        const complaintQuery = `
          SELECT 
            c.*, u.unit_number, r.room_number, b.name as building_name,
            assigned_user.email as assigned_to_email,
            COALESCE(up.first_name || ' ' || up.last_name, assigned_user.email) as assigned_to_name
          FROM complaints c
          LEFT JOIN units u ON c.unit_id = u.id
          LEFT JOIN rooms r ON c.room_id = r.id
          LEFT JOIN buildings b ON c.building_id = b.id
          LEFT JOIN users assigned_user ON c.assigned_to = assigned_user.id
          LEFT JOIN user_profiles up ON assigned_user.id = up.user_id
          WHERE c.id = $1 AND c.tenant_user_id = $2
        `;

        const complaintResult = await client.query(complaintQuery, [
          complaintId,
          userId,
        ]);

        if (complaintResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Complaint not found"));
        }

        const complaint = complaintResult.rows[0];

        // Get complaint activities
        const activitiesQuery = `
          SELECT 
            ca.*, 
            u.email as created_by_email,
            COALESCE(up.first_name || ' ' || up.last_name, u.email) as created_by_name
          FROM complaint_activities ca
          LEFT JOIN users u ON ca.created_by = u.id
          LEFT JOIN user_profiles up ON u.id = up.user_id
          WHERE ca.complaint_id = $1
          AND ca.created_for IN ('tenant', 'admin')
          ORDER BY ca.created_at ASC
        `;

        const activitiesResult = await client.query(activitiesQuery, [
          complaintId,
        ]);

        res.json({
          success: true,
          data: {
            complaint,
            activities: activitiesResult.rows,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get complaint details error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch complaint details"));
    }
  }

  // POST /api/tenant/complaints/:id/activity
  async addComplaintActivity(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;
      const complaintId = req.params.id;

      try {
        const { description } = req.body;
        
        // Handle file uploads
        const attachments = req.files
          ? req.files.map((file) => `/uploads/complaints/${file.filename}`)
          : [];

        // Verify complaint belongs to tenant and is in active state
        const verifyQuery = `
          SELECT id, status FROM complaints 
          WHERE id = $1 AND tenant_user_id = $2 
          AND status IN ('submitted', 'acknowledged', 'in_progress')
        `;

        const verifyResult = await client.query(verifyQuery, [
          complaintId,
          userId,
        ]);

        if (verifyResult.rows.length === 0) {
          return next(
            createError(
              "NOT_FOUND",
              "Complaint not found or not eligible for adding notes"
            )
          );
        }

        // Insert activity
        const activityQuery = `
          INSERT INTO complaint_activities (
            complaint_id, activity_type, description, 
            attachments, created_by, created_for, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
          RETURNING *
        `;

        const activityValues = [
          complaintId,
          "note",
          description,
          attachments,
          userId,
          "tenant",
        ];

        const activityResult = await client.query(
          activityQuery,
          activityValues
        );
        const activity = activityResult.rows[0];

        res.json({
          success: true,
          message: "Note added to complaint successfully",
          data: {
            activity: {
              id: activity.id,
              complaintId: activity.complaint_id,
              activityType: activity.activity_type,
              description: activity.description,
              attachments: activity.attachments || [],
              createdFor: activity.created_for,
              createdAt: activity.created_at,
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Add complaint activity error:", error);
      next(createError("DATABASE_ERROR", "Failed to add note"));
    }
  }

  // PUT /api/tenant/complaints/:id/feedback
  async submitComplaintFeedback(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;
      const complaintId = req.params.id;

      try {
        const { rating, feedback } = req.body;

        // Verify complaint belongs to tenant and is resolved
        const verifyQuery = `
          SELECT id, status FROM complaints 
          WHERE id = $1 AND tenant_user_id = $2 AND status IN ('resolved', 'closed')
        `;

        const verifyResult = await client.query(verifyQuery, [
          complaintId,
          userId,
        ]);

        if (verifyResult.rows.length === 0) {
          return next(
            createError(
              "NOT_FOUND",
              "Complaint not found or not eligible for feedback"
            )
          );
        }

        // Update complaint with feedback
        const updateQuery = `
          UPDATE complaints SET
            tenant_satisfaction_rating = $1,
            tenant_feedback = $2,
            feedback_date = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $3
          RETURNING *
        `;

        const updateResult = await client.query(updateQuery, [
          rating,
          feedback,
          complaintId,
        ]);

        // Log feedback activity
        await client.query(
          `INSERT INTO complaint_activities (
            complaint_id, activity_type, description, created_by, created_for
          ) VALUES ($1, 'feedback', $2, $3, 'tenant')`,
          [
            complaintId,
            `Tenant provided feedback with ${rating} star rating`,
            userId,
          ]
        );

        res.json({
          success: true,
          message: "Feedback submitted successfully",
          data: updateResult.rows[0],
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Submit complaint feedback error:", error);
      next(createError("DATABASE_ERROR", "Failed to submit feedback"));
    }
  }

  // GET /api/tenant/announcements
  async getAnnouncements(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        const { page = 1, limit = 20, category = "all" } = req.query;
        const offset = (page - 1) * limit;

        // Get tenant's building first
        const buildingQuery = `
          SELECT DISTINCT r.building_id, f.id as floor_id, r.id as room_id, t.start_date
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN floors f ON r.floor_id = f.id
          WHERE t.tenant_user_id = $1 AND t.agreement_status = 'executed'
          ORDER BY t.start_date DESC
          LIMIT 1
        `;

        const buildingResult = await client.query(buildingQuery, [userId]);

        if (buildingResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "No active tenancy found"));
        }

        const { building_id, floor_id, room_id } = buildingResult.rows[0];

        let categoryFilter = "";
        const params = [building_id, floor_id, room_id, limit, offset];

        if (category !== "all") {
          categoryFilter = "AND a.category = $6";
          params.push(category);
        }

        const query = `
          SELECT 
            a.id, a.title, a.content, a.category, a.priority,
            a.announcement_type, a.publish_at, a.expires_at,
            a.is_pinned, a.attachments, a.external_links,
            a.acknowledgment_required, a.view_count, a.created_at,
            creator.email as created_by_email,
            COALESCE(cup.first_name || ' ' || cup.last_name, creator.email) as created_by_name
          FROM announcements a
          LEFT JOIN users creator ON a.created_by = creator.id
          LEFT JOIN user_profiles cup ON creator.id = cup.user_id
          WHERE a.building_id = $1
          AND a.is_published = true
          AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
          AND (a.publish_at IS NULL OR a.publish_at <= CURRENT_TIMESTAMP)
          AND (
            a.target_audience = 'all_tenants' OR
            a.target_audience = 'all_residents' OR
            (a.target_audience = 'specific_floors' AND $2 = ANY(a.target_floor_ids)) OR
            (a.target_audience = 'specific_rooms' AND $3 = ANY(a.target_room_ids))
          )
          ${categoryFilter}
          ORDER BY a.is_pinned DESC, a.priority DESC, a.publish_at DESC
          LIMIT $4 OFFSET $5
        `;

        const result = await client.query(query, params);

        // Get total count
        const countQuery = `
          SELECT COUNT(*) as total
          FROM announcements a
          WHERE a.building_id = $1
          AND a.is_published = true
          AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
          AND (a.publish_at IS NULL OR a.publish_at <= CURRENT_TIMESTAMP)
          AND (
            a.target_audience = 'all_tenants' OR
            a.target_audience = 'all_residents' OR
            (a.target_audience = 'specific_floors' AND $2 = ANY(a.target_floor_ids)) OR
            (a.target_audience = 'specific_rooms' AND $3 = ANY(a.target_room_ids))
          )
          ${categoryFilter.replace("$6", "$4")}
        `;

        const countParams = [building_id, floor_id, room_id];
        if (category !== "all") countParams.push(category);

        const countResult = await client.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].total);

        res.json({
          success: true,
          data: result.rows,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / limit),
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get announcements error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch announcements"));
    }
  }

  // POST /api/tenant/announcements/:id/read - Simplified without tracking reads
  async markAnnouncementAsRead(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;
      const announcementId = req.params.id;

      try {
        // Just verify announcement exists and is accessible to tenant
        const checkQuery = `
          SELECT a.id, a.view_count
          FROM announcements a
          WHERE a.id = $1 AND a.is_published = true
          AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
          AND a.building_id = (
            SELECT r.building_id FROM tenancies t
            JOIN units u ON t.unit_id = u.id 
            JOIN rooms r ON u.room_id = r.id
            WHERE t.tenant_user_id = $2 AND t.agreement_status = 'executed'
            ORDER BY t.start_date DESC LIMIT 1
          )
        `;

        const checkResult = await client.query(checkQuery, [
          announcementId,
          userId,
        ]);

        if (checkResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Announcement not found"));
        }

        // Update view count
        await client.query(
          "UPDATE announcements SET view_count = view_count + 1 WHERE id = $1",
          [announcementId]
        );

        res.json({
          success: true,
          message: "Announcement marked as read",
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Mark announcement as read error:", error);
      next(
        createError("DATABASE_ERROR", "Failed to mark announcement as read")
      );
    }
  }

  // GET /api/tenant/documents
  async getDocuments(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        // Get user profile documents
        const profileQuery = `
          SELECT 
            'profile_picture' as document_type, profile_picture as file_path, 'Profile Picture' as display_name,
            updated_at as uploaded_date
          FROM user_profiles 
          WHERE user_id = $1 AND profile_picture IS NOT NULL
          
          UNION ALL
          
          SELECT 
            'id_proof' as document_type, id_proof_document as file_path, 
            CONCAT(id_proof_type, ' - ', id_proof_number) as display_name,
            updated_at as uploaded_date
          FROM user_profiles 
          WHERE user_id = $1 AND id_proof_document IS NOT NULL
        `;

        const profileResult = await client.query(profileQuery, [userId]);

        // Get lease/tenancy documents (if any stored)
        const tenancyQuery = `
          SELECT 
            'lease_agreement' as document_type, 
            '/documents/lease/' || t.id || '_agreement.pdf' as file_path,
            'Lease Agreement' as display_name,
            t.created_at as uploaded_date,
            t.id as reference_id
          FROM tenancies t
          WHERE t.tenant_user_id = $1 AND t.agreement_status = 'executed'
          ORDER BY t.start_date DESC
        `;

        const tenancyResult = await client.query(tenancyQuery, [userId]);

        // Get payment receipts (last 12 months)
        const receiptsQuery = `
          SELECT 
            'payment_receipt' as document_type,
            '/receipts/' || p.id || '_receipt.pdf' as file_path,
            CONCAT('Payment Receipt - ', TO_CHAR(p.payment_date, 'Mon YYYY')) as display_name,
            p.payment_date as uploaded_date,
            p.id as reference_id
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          WHERE t.tenant_user_id = $1 
          AND p.status = 'paid'
          AND p.payment_date >= CURRENT_DATE - INTERVAL '12 months'
          ORDER BY p.payment_date DESC
        `;

        const receiptsResult = await client.query(receiptsQuery, [userId]);

        const documents = {
          profile: profileResult.rows,
          tenancy: tenancyResult.rows,
          payments: receiptsResult.rows,
        };

        res.json({
          success: true,
          data: documents,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get documents error:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch documents"));
    }
  }

  // GET /api/tenant/documents/:type/:id/download
  async downloadDocument(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;
      const { type, id } = req.params;

      try {
        let filePath = null;
        let fileName = null;

        switch (type) {
          case "payment_receipt":
            // Verify payment belongs to tenant
            const paymentQuery = `
              SELECT p.id, p.transaction_id, p.payment_date, p.amount, p.payment_type
              FROM payments p
              JOIN tenancies t ON p.tenancy_id = t.id
              WHERE p.id = $1 AND t.tenant_user_id = $2 AND p.status = 'paid'
            `;
            const paymentResult = await client.query(paymentQuery, [
              id,
              userId,
            ]);

            if (paymentResult.rows.length === 0) {
              return next(
                createError("NOT_FOUND", "Payment receipt not found")
              );
            }

            filePath = `/receipts/${id}_receipt.pdf`;
            fileName = `payment_receipt_${id}.pdf`;
            break;

          case "lease_agreement":
            // Verify tenancy belongs to tenant
            const tenancyQuery = `
              SELECT id FROM tenancies WHERE id = $1 AND tenant_user_id = $2
            `;
            const tenancyResult = await client.query(tenancyQuery, [
              id,
              userId,
            ]);

            if (tenancyResult.rows.length === 0) {
              return next(
                createError("NOT_FOUND", "Lease agreement not found")
              );
            }

            filePath = `/documents/lease/${id}_agreement.pdf`;
            fileName = `lease_agreement_${id}.pdf`;
            break;

          case "id_proof":
            // Get ID proof document
            const idProofQuery = `
              SELECT id_proof_document FROM user_profiles 
              WHERE user_id = $1 AND id_proof_document IS NOT NULL
            `;
            const idProofResult = await client.query(idProofQuery, [userId]);

            if (idProofResult.rows.length === 0) {
              return next(
                createError("NOT_FOUND", "ID proof document not found")
              );
            }

            filePath = idProofResult.rows[0].id_proof_document;
            fileName = `id_proof_${userId}.pdf`;
            break;

          default:
            return next(
              createError("VALIDATION_ERROR", "Invalid document type")
            );
        }

        // In a real implementation, you would serve the actual file
        // For now, we'll return the file path information
        res.json({
          success: true,
          message: "Document download initiated",
          data: {
            filePath,
            fileName,
            downloadUrl: `/api/files${filePath}`,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Download document error:", error);
      next(createError("DATABASE_ERROR", "Failed to download document"));
    }
  }

  // GET /api/tenant/offboarding
  async getOffboardingStatus(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;

      try {
        // Get current tenancy with offboarding details
        const tenancyQuery = `
          SELECT 
            t.id, t.tenant_user_id, t.unit_id, t.start_date, t.end_date, 
            t.rent_amount, t.security_deposit, t.agreement_status,
            t.notice_period_days, t.offboarding_initiated_at, t.offboarding_reason,
            t.notice_given_date, t.intended_move_out_date, t.actual_move_out_date,
            t.deposit_refund_amount, t.deposit_refund_status, t.final_dues,
            t.offboarding_status,
            u.unit_number, r.room_number, b.name as building_name,
            b.address_line1, b.city, b.state
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.tenant_user_id = $1 AND t.agreement_status = 'executed'
          ORDER BY t.start_date DESC
          LIMIT 1
        `;

        const tenancyResult = await client.query(tenancyQuery, [userId]);

        if (tenancyResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Active tenancy not found"));
        }

        const tenancy = tenancyResult.rows[0];

        // Get pending complaints count
        const complaintsQuery = `
          SELECT COUNT(*) as pending_complaints
          FROM complaints
          WHERE tenant_user_id = $1 AND status NOT IN ('resolved', 'closed')
        `;

        const complaintsResult = await client.query(complaintsQuery, [userId]);
        const pendingComplaints = parseInt(complaintsResult.rows[0].pending_complaints);

        // Get pending payments
        const paymentsQuery = `
          SELECT 
            COUNT(*) as pending_payments_count,
            COALESCE(SUM(amount), 0) as total_pending_amount
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          WHERE t.tenant_user_id = $1 AND p.status IN ('pending', 'overdue')
        `;

        const paymentsResult = await client.query(paymentsQuery, [userId]);
        const paymentsSummary = paymentsResult.rows[0];

        // Tenants can always initiate offboarding if status is active
        const canInitiateOffboarding = tenancy.offboarding_status === 'active';

        res.json({
          success: true,
          data: {
            tenancy: {
              ...tenancy,
              offboarding_initiated_at: tenancy.offboarding_initiated_at,
              offboarding_reason: tenancy.offboarding_reason,
              notice_given_date: tenancy.notice_given_date,
              intended_move_out_date: tenancy.intended_move_out_date,
              actual_move_out_date: tenancy.actual_move_out_date,
              deposit_refund_amount: tenancy.deposit_refund_amount,
              deposit_refund_status: tenancy.deposit_refund_status,
              final_dues: tenancy.final_dues,
              offboarding_status: tenancy.offboarding_status
            },
            clearance_status: {
              pending_complaints: pendingComplaints,
              pending_payments_count: parseInt(paymentsSummary.pending_payments_count),
              total_pending_amount: parseFloat(paymentsSummary.total_pending_amount),
              can_initiate_offboarding: canInitiateOffboarding
            }
          }
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Get offboarding status error:", error);
      next(createError("DATABASE_ERROR", "Failed to get offboarding status"));
    }
  }

  // POST /api/tenant/offboarding/initiate
  async initiateOffboarding(req, res, next) {
    try {
      const client = await pool.connect();
      const userId = req.user.userId;
      const { reason, moveOutMonth } = req.body;

      try {
        await client.query("BEGIN");

        // Get current active tenancy
        const tenancyQuery = `
          SELECT id, offboarding_status, notice_period_days, security_deposit
          FROM tenancies
          WHERE tenant_user_id = $1 AND agreement_status = 'executed'
          ORDER BY start_date DESC
          LIMIT 1
        `;

        const tenancyResult = await client.query(tenancyQuery, [userId]);

        if (tenancyResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("NOT_FOUND", "Active tenancy not found"));
        }

        const tenancy = tenancyResult.rows[0];

        if (tenancy.offboarding_status !== 'active') {
          await client.query("ROLLBACK");
          return next(createError("VALIDATION_ERROR", "Offboarding already initiated"));
        }

        // Note: Pending complaints and payments do not block offboarding initiation
        // They will be handled during admin processing

        // Calculate month-end date for move-out
        const [year, month] = moveOutMonth.split('-').map(Number);
        const intendedMoveOutDate = new Date(year, month, 0); // Last day of the month

        // Update tenancy with offboarding details
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
          intendedMoveOutDate.toISOString().split('T')[0], // Format as YYYY-MM-DD
          tenancy.id
        ]);

        await client.query("COMMIT");

        res.json({
          success: true,
          message: "Offboarding process initiated successfully",
          data: {
            tenancy: updateResult.rows[0],
            notice_period_days: tenancy.notice_period_days,
            next_steps: [
              "Wait for admin review and approval",
              "Complete final inspection",
              "Return keys and access cards",
              "Receive security deposit refund"
            ]
          }
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Initiate offboarding error:", error);
      next(createError("DATABASE_ERROR", "Failed to initiate offboarding"));
    }
  }

}

export default new TenantController();
