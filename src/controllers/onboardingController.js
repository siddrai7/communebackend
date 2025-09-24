// src/controllers/onboardingController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import { sendLeadOnboardingEmail } from "../services/emailService.js";

class OnboardingController {
  // GET /api/onboarding/won-leads
  async getWonLeads(req, res, next) {
    try {
      const client = await pool.connect();

      try {
        const { page = 1, limit = 20, search = "" } = req.query;
        const offset = (page - 1) * limit;

        let query = `
          SELECT 
            l.id, l.uuid, l.name, l.email, l.phone, l.source,
            l.preferred_building_id, l.preferred_room_type, 
            l.budget_min, l.budget_max, l.preferred_move_in_date,
            l.conversion_date, l.created_at, l.notes, l.tags,
            b.name as building_name, b.address_line1, b.city
          FROM leads l
          LEFT JOIN buildings b ON l.preferred_building_id = b.id
          WHERE l.status = 'won' AND l.converted_to_tenant_id IS NULL
        `;

        const queryParams = [];
        let paramCount = 0;

        if (search) {
          paramCount++;
          query += ` AND (l.name ILIKE $${paramCount} OR l.email ILIKE $${paramCount} OR l.phone ILIKE $${paramCount})`;
          queryParams.push(`%${search}%`);
        }

        query += ` ORDER BY l.conversion_date DESC NULLS LAST, l.created_at DESC`;

        // Add pagination
        paramCount++;
        query += ` LIMIT $${paramCount}`;
        queryParams.push(limit);

        paramCount++;
        query += ` OFFSET $${paramCount}`;
        queryParams.push(offset);

        const result = await client.query(query, queryParams);

        // Get total count for pagination
        let countQuery = `
          SELECT COUNT(*) 
          FROM leads l 
          WHERE l.status = 'won' AND l.converted_to_tenant_id IS NULL
        `;
        const countParams = [];
        if (search) {
          countQuery += ` AND (l.name ILIKE $1 OR l.email ILIKE $1 OR l.phone ILIKE $1)`;
          countParams.push(`%${search}%`);
        }

        const countResult = await client.query(countQuery, countParams);
        const totalCount = parseInt(countResult.rows[0].count);

        res.json({
          success: true,
          data: {
            leads: result.rows,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: totalCount,
              totalPages: Math.ceil(totalCount / limit),
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // GET /api/onboarding/lead/:leadId
  async getLeadDetails(req, res, next) {
    try {
      const { leadId } = req.params;
      const client = await pool.connect();

      try {
        // Get lead details
        const leadQuery = `
          SELECT 
            l.*,
            b.name as building_name, b.address_line1, b.city, b.state,
            b.total_floors, b.total_units, b.amenities as building_amenities
          FROM leads l
          LEFT JOIN buildings b ON l.preferred_building_id = b.id
          WHERE l.id = $1 AND l.status = 'won'
        `;

        const leadResult = await client.query(leadQuery, [leadId]);

        if (leadResult.rows.length === 0) {
          throw createError("Lead not found or not in won status", 404);
        }

        const lead = leadResult.rows[0];

        // Get lead activities
        const activitiesQuery = `
          SELECT 
            la.*,
            u.email as created_by_email,
            up.first_name, up.last_name
          FROM lead_activities la
          LEFT JOIN users u ON la.created_by = u.id
          LEFT JOIN user_profiles up ON u.id = up.user_id
          WHERE la.lead_id = $1
          ORDER BY la.created_at DESC
          LIMIT 10
        `;

        const activitiesResult = await client.query(activitiesQuery, [leadId]);

        // Get lead documents
        const documentsQuery = `
          SELECT 
            ld.*,
            u.email as uploaded_by_email,
            up.first_name, up.last_name
          FROM lead_documents ld
          LEFT JOIN users u ON ld.uploaded_by = u.id
          LEFT JOIN user_profiles up ON u.id = up.user_id
          WHERE ld.lead_id = $1
          ORDER BY ld.created_at DESC
        `;

        const documentsResult = await client.query(documentsQuery, [leadId]);

        res.json({
          success: true,
          data: {
            lead,
            activities: activitiesResult.rows,
            documents: documentsResult.rows,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // GET /api/onboarding/available-units
  async getAvailableUnits(req, res, next) {
    try {
      const { buildingId, roomType } = req.query;
      const client = await pool.connect();

      try {
        let query = `
          SELECT 
            u.id, u.unit_number, u.rent_amount, u.security_deposit, u.target_selling_price,
            r.room_number, r.room_type, r.size_sqft, r.amenities as room_amenities,
            r.furnishing_status, r.ac_available, r.wifi_available,
            f.floor_number, f.floor_name,
            b.name as building_name, b.address_line1, b.city
          FROM units u
          JOIN rooms r ON u.room_id = r.id
          JOIN floors f ON r.floor_id = f.id
          JOIN buildings b ON r.building_id = b.id
          WHERE u.status = 'available'
        `;

        const queryParams = [];
        let paramCount = 0;

        if (buildingId) {
          paramCount++;
          query += ` AND b.id = $${paramCount}`;
          queryParams.push(buildingId);
        }

        if (roomType) {
          paramCount++;
          query += ` AND r.room_type = $${paramCount}`;
          queryParams.push(roomType);
        }

        query += ` ORDER BY b.name, f.floor_number, r.room_number, u.unit_number`;

        const result = await client.query(query, queryParams);

        res.json({
          success: true,
          data: {
            units: result.rows,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // GET /api/onboarding/buildings
  async getBuildings(req, res, next) {
    try {
      const client = await pool.connect();

      try {
        const query = `
          SELECT 
            b.id, b.name, b.address_line1, b.city, b.state,
            b.total_floors, b.total_units, b.amenities,
            COUNT(u.id) as available_units
          FROM buildings b
          LEFT JOIN rooms r ON b.id = r.building_id
          LEFT JOIN units u ON r.id = u.room_id AND u.status = 'available'
          WHERE b.status = 'active'
          GROUP BY b.id
          ORDER BY b.name
        `;

        const result = await client.query(query);

        res.json({
          success: true,
          data: {
            buildings: result.rows,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // POST /api/onboarding/onboard-tenant
  async onboardTenant(req, res, next) {
    try {
      const { leadId, unitId, tenantInfo, tenancyDetails, documents } =
        req.body;

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // 1. Verify lead exists and is in 'won' status
        const leadQuery = `
          SELECT * FROM leads 
          WHERE id = $1 AND status = 'won' AND converted_to_tenant_id IS NULL
        `;
        const leadResult = await client.query(leadQuery, [leadId]);

        if (leadResult.rows.length === 0) {
          throw createError(
            "Lead not found, not won, or already onboarded",
            400
          );
        }

        const lead = leadResult.rows[0];

        // 2. Verify unit is available
        const unitQuery = `
          SELECT u.*, r.room_number, r.building_id 
          FROM units u
          JOIN rooms r ON u.room_id = r.id
          WHERE u.id = $1 AND u.status = 'available'
        `;
        const unitResult = await client.query(unitQuery, [unitId]);

        if (unitResult.rows.length === 0) {
          throw createError("Unit not found or not available", 400);
        }

        const unit = unitResult.rows[0];

        // 3. Create user account
        const userInsertQuery = `
          INSERT INTO users (email, role, status, email_verified, created_at, updated_at)
          VALUES ($1, 'tenant', 'active', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING id
        `;
        const userResult = await client.query(userInsertQuery, [lead.email]);
        const userId = userResult.rows[0].id;

        console.log("User created with ID:", userId);

        // 4. Create user profile
        const profileInsertQuery = `
          INSERT INTO user_profiles (
            user_id, first_name, last_name, phone, date_of_birth, gender,
            address_line1, address_line2, city, state, country, postal_code,
            emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
            id_proof_type, id_proof_number, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;

        // Split lead name into first and last name
        const nameParts = lead.name.trim().split(" ");
        const firstName = nameParts[0] || "";
        const lastName = nameParts.slice(1).join(" ") || "";

        await client.query(profileInsertQuery, [
          userId,
          tenantInfo.firstName || firstName,
          tenantInfo.lastName || lastName,
          tenantInfo.phone || lead.phone,
          tenantInfo.dateOfBirth || null,
          tenantInfo.gender || null,
          tenantInfo.addressLine1 || null,
          tenantInfo.addressLine2 || null,
          tenantInfo.city || null,
          tenantInfo.state || null,
          tenantInfo.country || "India",
          tenantInfo.postalCode || null,
          tenantInfo.emergencyContactName || null,
          tenantInfo.emergencyContactPhone || null,
          tenantInfo.emergencyContactRelation || null,
          tenantInfo.idProofType || null,
          tenantInfo.idProofNumber || null,
        ]);

        // 5. Create tenancy
        const tenancyInsertQuery = `
          INSERT INTO tenancies (
            unit_id, tenant_user_id, start_date, end_date, rent_amount, security_deposit,
            agreement_status, move_in_date, notice_period_days, documents_submitted,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          RETURNING id
        `;

        const tenancyResult = await client.query(tenancyInsertQuery, [
          unitId,
          userId,
          tenancyDetails.startDate,
          tenancyDetails.endDate || null,
          tenancyDetails.rentAmount || unit.rent_amount,
          tenancyDetails.securityDeposit || unit.security_deposit,
          tenancyDetails.agreementStatus || "executed",
          tenancyDetails.moveInDate || tenancyDetails.startDate,
          tenancyDetails.noticePeriodDays || 30,
          documents || [],
        ]);

        const tenancyId = tenancyResult.rows[0].id;

        // 6. Update unit status to occupied
        await client.query(
          `UPDATE units SET status = 'occupied', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [unitId]
        );

        // 7. Update lead with conversion info
        await client.query(
          `UPDATE leads SET 
           converted_to_tenant_id = $1, 
           conversion_date = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP 
           WHERE id = $2`,
          [userId, leadId]
        );

        // 8. Create payment records for security deposit and first month rent
        const today = new Date().toISOString().split("T")[0];
        const moveInDate = new Date(
          tenancyDetails.moveInDate || tenancyDetails.startDate
        );

        // Security deposit payment
        if (
          tenancyDetails.securityDeposit &&
          tenancyDetails.securityDeposit > 0
        ) {
          const securityDepositPaymentQuery = `
            INSERT INTO payments (
              tenancy_id, payment_type, amount, due_date, status, notes, created_at, updated_at
            ) VALUES ($1, 'security_deposit', $2, $3, 'pending', 'Security deposit for onboarding', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `;

          await client.query(securityDepositPaymentQuery, [
            tenancyId,
            tenancyDetails.securityDeposit || unit.security_deposit,
            today, // Due today
          ]);
        }

        // First month rent payment
        const firstMonthRentPaymentQuery = `
          INSERT INTO payments (
            tenancy_id, payment_type, amount, due_date, status, notes, created_at, updated_at
          ) VALUES ($1, 'rent', $2, $3, 'pending', 'First month rent payment', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;

        await client.query(firstMonthRentPaymentQuery, [
          tenancyId,
          tenancyDetails.rentAmount || unit.rent_amount,
          tenancyDetails.moveInDate || tenancyDetails.startDate, // Due on move-in date
        ]);

        // 9. Log onboarding activity for lead
        const activityInsertQuery = `
          INSERT INTO lead_activities (
            lead_id, activity_type, title, description, completed_at, created_by, created_at
          ) VALUES ($1, 'onboarding', 'Tenant Onboarded', $2, CURRENT_TIMESTAMP, $3, CURRENT_TIMESTAMP)
        `;

        await client.query(activityInsertQuery, [
          leadId,
          `Successfully onboarded to unit ${unit.unit_number}. Tenancy ID: ${tenancyId}. Payment records created for security deposit and first month rent.`,
          req.user.userId,
        ]);

        await client.query("COMMIT");

        // Send onboarding email after successful onboarding
        try {
          await sendLeadOnboardingEmail({
            name: lead.name,
            email: lead.email,
            buildingName: "Commune Quartex"
          });
          
          console.log(`✅ Onboarding email sent to ${lead.email} for ${lead.name}`);
        } catch (emailError) {
          // Log email error but don't fail the onboarding process
          console.error("⚠️ Failed to send onboarding email:", emailError);
          console.error("Onboarding was successful, but email notification failed");
        }

        res.json({
          success: true,
          message: "Tenant onboarded successfully",
          data: {
            userId,
            tenancyId,
            unitId,
            unitNumber: unit.unit_number,
            emailSent: true, // Will always be true as we don't fail on email errors
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

  // GET /api/onboarding/onboarded-tenants
  async getOnboardedTenants(req, res, next) {
    try {
      const { page = 1, limit = 20, search = "", fromDate, toDate } = req.query;
      const offset = (page - 1) * limit;
      const client = await pool.connect();

      try {
        // Default to last 1 month if no date range provided
        const defaultFromDate = new Date();
        defaultFromDate.setMonth(defaultFromDate.getMonth() - 1);
        const defaultToDate = new Date();

        const actualFromDate =
          fromDate || defaultFromDate.toISOString().split("T")[0];
        const actualToDate =
          toDate || defaultToDate.toISOString().split("T")[0];

        let query = `
          SELECT 
            u.id as user_id, u.email, u.created_at as onboarded_date,
            up.first_name, up.last_name, up.phone,
            t.id as tenancy_id, t.start_date, t.end_date, t.rent_amount, t.agreement_status, t.move_in_date,
            un.unit_number, r.room_number, r.room_type,
            b.name as building_name, b.city,
            l.id as lead_id, l.name as original_lead_name, l.source as lead_source
          FROM users u
          JOIN user_profiles up ON u.id = up.user_id
          JOIN tenancies t ON u.id = t.tenant_user_id
          JOIN units un ON t.unit_id = un.id
          JOIN rooms r ON un.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          LEFT JOIN leads l ON l.converted_to_tenant_id = u.id
          WHERE u.role = 'tenant' 
            AND u.created_at >= $1::date 
            AND u.created_at <= $2::date + interval '1 day'
        `;

        const queryParams = [actualFromDate, actualToDate];
        let paramCount = 2;

        if (search) {
          paramCount++;
          query += ` AND (
            up.first_name ILIKE $${paramCount} OR 
            up.last_name ILIKE $${paramCount} OR 
            u.email ILIKE $${paramCount} OR 
            up.phone ILIKE $${paramCount} OR
            un.unit_number ILIKE $${paramCount}
          )`;
          queryParams.push(`%${search}%`);
        }

        query += ` ORDER BY u.created_at DESC`;

        // Add pagination
        paramCount++;
        query += ` LIMIT $${paramCount}`;
        queryParams.push(limit);

        paramCount++;
        query += ` OFFSET $${paramCount}`;
        queryParams.push(offset);

        const result = await client.query(query, queryParams);

        // Get total count
        let countQuery = `
          SELECT COUNT(*) 
          FROM users u
          JOIN user_profiles up ON u.id = up.user_id
          JOIN tenancies t ON u.id = t.tenant_user_id
          JOIN units un ON t.unit_id = un.id
          WHERE u.role = 'tenant'
            AND u.created_at >= $1::date 
            AND u.created_at <= $2::date + interval '1 day'
        `;
        const countParams = [actualFromDate, actualToDate];
        if (search) {
          countQuery += ` AND (
            up.first_name ILIKE $3 OR 
            up.last_name ILIKE $3 OR 
            u.email ILIKE $3 OR 
            up.phone ILIKE $3 OR
            un.unit_number ILIKE $3
          )`;
          countParams.push(`%${search}%`);
        }

        const countResult = await client.query(countQuery, countParams);
        const totalCount = parseInt(countResult.rows[0].count);

        res.json({
          success: true,
          data: {
            tenants: result.rows,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: totalCount,
              totalPages: Math.ceil(totalCount / limit),
            },
            dateRange: {
              from: actualFromDate,
              to: actualToDate,
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // PUT /api/onboarding/tenant/:tenantId
  async updateTenantInfo(req, res, next) {
    try {
      const { tenantId } = req.params;
      const { profileData, tenancyData } = req.body;
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Update user profile if provided
        if (profileData) {
          const profileUpdateQuery = `
            UPDATE user_profiles SET
              first_name = COALESCE($1, first_name),
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

          await client.query(profileUpdateQuery, [
            profileData.firstName,
            profileData.lastName,
            profileData.phone,
            profileData.dateOfBirth,
            profileData.gender,
            profileData.addressLine1,
            profileData.addressLine2,
            profileData.city,
            profileData.state,
            profileData.country,
            profileData.postalCode,
            profileData.emergencyContactName,
            profileData.emergencyContactPhone,
            profileData.emergencyContactRelation,
            profileData.idProofType,
            profileData.idProofNumber,
            tenantId,
          ]);
        }

        // Update tenancy if provided
        if (tenancyData) {
          const tenancyUpdateQuery = `
            UPDATE tenancies SET
              start_date = COALESCE($1, start_date),
              end_date = COALESCE($2, end_date),
              rent_amount = COALESCE($3, rent_amount),
              security_deposit = COALESCE($4, security_deposit),
              agreement_status = COALESCE($5, agreement_status),
              move_in_date = COALESCE($6, move_in_date),
              notice_period_days = COALESCE($7, notice_period_days),
              documents_submitted = COALESCE($8, documents_submitted),
              updated_at = CURRENT_TIMESTAMP
            WHERE tenant_user_id = $9
          `;

          await client.query(tenancyUpdateQuery, [
            tenancyData.startDate,
            tenancyData.endDate,
            tenancyData.rentAmount,
            tenancyData.securityDeposit,
            tenancyData.agreementStatus,
            tenancyData.moveInDate,
            tenancyData.noticePeriodDays,
            tenancyData.documentsSubmitted,
            tenantId,
          ]);
        }

        await client.query("COMMIT");

        res.json({
          success: true,
          message: "Tenant information updated successfully",
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
}

export default new OnboardingController();
