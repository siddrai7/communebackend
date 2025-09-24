// src/controllers/complaintsController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import { sendComplaintEmail } from "../services/emailService.js";

class ComplaintsController {
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

  // GET /api/complaints
  getComplaints = async (req, res, next) => {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        category,
        priority,
        building_id,
        assigned_to,
        date_from,
        date_to,
        search,
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
        let whereConditions = ["1=1"];
        let queryParams = [];
        let paramIndex = 1;

        // Building access control
        if (managedBuildingIds !== null) {
          if (managedBuildingIds.length === 0) {
            // Manager with no buildings
            return res.json({
              success: true,
              data: {
                complaints: [],
                pagination: {
                  currentPage: 1,
                  totalPages: 0,
                  totalItems: 0,
                  itemsPerPage: limit,
                  hasNextPage: false,
                  hasPrevPage: false,
                },
                summary: {
                  total: 0,
                  byStatus: {},
                  byCategory: {},
                  byPriority: {},
                },
              },
            });
          }
          whereConditions.push(`c.building_id = ANY($${paramIndex})`);
          queryParams.push(managedBuildingIds);
          paramIndex++;
        }

        // Status filter
        if (status) {
          whereConditions.push(`c.status = $${paramIndex}`);
          queryParams.push(status);
          paramIndex++;
        }

        // Category filter
        if (category) {
          whereConditions.push(`c.category = $${paramIndex}`);
          queryParams.push(category);
          paramIndex++;
        }

        // Priority filter
        if (priority) {
          whereConditions.push(`c.priority = $${paramIndex}`);
          queryParams.push(priority);
          paramIndex++;
        }

        // Building filter
        if (building_id) {
          whereConditions.push(`c.building_id = $${paramIndex}`);
          queryParams.push(building_id);
          paramIndex++;
        }

        // Assigned to filter
        if (assigned_to) {
          whereConditions.push(`c.assigned_to = $${paramIndex}`);
          queryParams.push(assigned_to);
          paramIndex++;
        }

        // Date range filter
        if (date_from) {
          whereConditions.push(`c.created_at >= $${paramIndex}`);
          queryParams.push(date_from);
          paramIndex++;
        }

        if (date_to) {
          whereConditions.push(`c.created_at <= $${paramIndex}`);
          queryParams.push(date_to);
          paramIndex++;
        }

        // Search filter
        if (search) {
          whereConditions.push(`(
            LOWER(c.title) LIKE LOWER($${paramIndex}) OR 
            LOWER(c.description) LIKE LOWER($${paramIndex}) OR 
            c.complaint_number LIKE UPPER($${paramIndex}) OR
            LOWER(CONCAT(tp.first_name, ' ', tp.last_name)) LIKE LOWER($${paramIndex})
          )`);
          queryParams.push(`%${search}%`);
          paramIndex++;
        }

        const whereClause = whereConditions.join(" AND ");

        // Main complaints query
        const complaintsQuery = `
          SELECT 
            c.*,
            b.name as building_name,
            f.floor_number,
            f.floor_name,
            r.room_number,
            u.unit_number,
            CONCAT(tp.first_name, ' ', tp.last_name) as tenant_name,
            tp.phone as tenant_phone,
            tenant_user.email as tenant_email,
            tp.profile_picture as tenant_avatar,
            CASE 
              WHEN c.assigned_to IS NOT NULL THEN CONCAT(ap.first_name, ' ', ap.last_name)
              ELSE NULL
            END as assigned_to_name,
            -- Calculate resolution time for resolved/closed complaints
            CASE 
              WHEN c.resolved_at IS NOT NULL THEN 
                EXTRACT(EPOCH FROM (c.resolved_at - c.created_at))/3600
              ELSE NULL
            END as actual_resolution_hours,
            -- Get activity counts directly
            (SELECT COUNT(*) FROM complaint_activities ca WHERE ca.complaint_id = c.id) as activity_count,
            (SELECT MAX(created_at) FROM complaint_activities ca WHERE ca.complaint_id = c.id) as last_activity_at
          FROM complaints c
          INNER JOIN buildings b ON c.building_id = b.id
          LEFT JOIN rooms r ON c.room_id = r.id
          LEFT JOIN floors f ON r.floor_id = f.id
          LEFT JOIN units u ON c.unit_id = u.id
          INNER JOIN users tenant_user ON c.tenant_user_id = tenant_user.id
          INNER JOIN user_profiles tp ON tenant_user.id = tp.user_id
          LEFT JOIN users assigned_user ON c.assigned_to = assigned_user.id
          LEFT JOIN user_profiles ap ON assigned_user.id = ap.user_id
          WHERE ${whereClause}
          ORDER BY 
            CASE 
              WHEN c.status IN ('resolved', 'closed') THEN 1
              ELSE 0
            END,
            c.created_at DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        queryParams.push(limit, offset);
        const complaintsResult = await client.query(
          complaintsQuery,
          queryParams
        );

        // Get total count for pagination
        const countQuery = `
          SELECT COUNT(*) as total
          FROM complaints c
          INNER JOIN buildings b ON c.building_id = b.id
          LEFT JOIN rooms r ON c.room_id = r.id
          LEFT JOIN units u ON c.unit_id = u.id
          INNER JOIN users tenant_user ON c.tenant_user_id = tenant_user.id
          INNER JOIN user_profiles tp ON tenant_user.id = tp.user_id
          WHERE ${whereClause}
        `;

        const countResult = await client.query(
          countQuery,
          queryParams.slice(0, -2)
        );
        const totalComplaints = parseInt(countResult.rows[0].total);

        // Calculate pagination
        const totalPages = Math.ceil(totalComplaints / limit);
        const hasNextPage = page < totalPages;
        const hasPrevPage = page > 1;

        // Get summary statistics
        const summaryQuery = `
          SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN c.status = 'submitted' THEN 1 END) as submitted,
            COUNT(CASE WHEN c.status = 'acknowledged' THEN 1 END) as acknowledged,
            COUNT(CASE WHEN c.status = 'in_progress' THEN 1 END) as in_progress,
            COUNT(CASE WHEN c.status = 'resolved' THEN 1 END) as resolved,
            COUNT(CASE WHEN c.status = 'closed' THEN 1 END) as closed,
            COUNT(CASE WHEN c.status = 'rejected' THEN 1 END) as rejected,
            COUNT(CASE WHEN c.priority = 'urgent' THEN 1 END) as urgent,
            COUNT(CASE WHEN c.priority = 'high' THEN 1 END) as high,
            COUNT(CASE WHEN c.priority = 'medium' THEN 1 END) as medium,
            COUNT(CASE WHEN c.priority = 'low' THEN 1 END) as low,
            COUNT(CASE WHEN c.category = 'maintenance' THEN 1 END) as maintenance,
            COUNT(CASE WHEN c.category = 'noise' THEN 1 END) as noise,
            COUNT(CASE WHEN c.category = 'cleanliness' THEN 1 END) as cleanliness,
            COUNT(CASE WHEN c.category = 'security' THEN 1 END) as security,
            COUNT(CASE WHEN c.category = 'billing' THEN 1 END) as billing,
            COUNT(CASE WHEN c.category = 'amenity' THEN 1 END) as amenity,
            COUNT(CASE WHEN c.category = 'other' THEN 1 END) as other
          FROM complaints c
          INNER JOIN buildings b ON c.building_id = b.id
          WHERE ${whereClause}
        `;

        const summaryResult = await client.query(
          summaryQuery,
          queryParams.slice(0, -2)
        );
        const summary = summaryResult.rows[0];

        // Process complaints data
        const complaints = complaintsResult.rows.map((complaint) => ({
          id: complaint.id,
          complaintNumber: complaint.complaint_number,
          title: complaint.title,
          description: complaint.description,
          category: complaint.category,
          subcategory: complaint.subcategory,
          priority: complaint.priority,
          status: complaint.status,
          tenant: {
            name: complaint.tenant_name,
            email: complaint.tenant_email,
            phone: complaint.tenant_phone,
            avatar: complaint.tenant_avatar,
          },
          property: {
            buildingName: complaint.building_name,
            floorNumber: complaint.floor_number,
            floorName: complaint.floor_name,
            roomNumber: complaint.room_number,
            unitNumber: complaint.unit_number,
          },
          assignment: {
            assignedTo: complaint.assigned_to,
            assignedToName: complaint.assigned_to_name,
            assignedAt: complaint.assigned_at,
          },
          timeline: {
            createdAt: complaint.created_at,
            acknowledgedAt: complaint.acknowledged_at,
            resolvedAt: complaint.resolved_at,
            closedAt: complaint.closed_at,
            lastActivityAt: complaint.last_activity_at,
          },
          resolution: {
            notes: complaint.resolution_notes,
            estimatedTime: complaint.estimated_resolution_time,
            actualTime: complaint.actual_resolution_hours
              ? Math.round(complaint.actual_resolution_hours)
              : null,
            costIncurred: complaint.cost_incurred
              ? parseFloat(complaint.cost_incurred)
              : 0,
            attachments: complaint.resolution_attachments || [],
          },
          feedback: {
            rating: complaint.tenant_satisfaction_rating,
            feedback: complaint.tenant_feedback,
            feedbackDate: complaint.feedback_date,
          },
          attachments: complaint.attachments || [],
        }));

        const response = {
          success: true,
          data: {
            complaints,
            pagination: {
              currentPage: parseInt(page),
              totalPages,
              totalItems: totalComplaints,
              itemsPerPage: parseInt(limit),
              hasNextPage,
              hasPrevPage,
            },
            summary: {
              total: parseInt(summary.total),
              byStatus: {
                submitted: parseInt(summary.submitted),
                acknowledged: parseInt(summary.acknowledged),
                in_progress: parseInt(summary.in_progress),
                resolved: parseInt(summary.resolved),
                closed: parseInt(summary.closed),
                rejected: parseInt(summary.rejected),
              },
              byPriority: {
                urgent: parseInt(summary.urgent),
                high: parseInt(summary.high),
                medium: parseInt(summary.medium),
                low: parseInt(summary.low),
              },
              byCategory: {
                maintenance: parseInt(summary.maintenance),
                noise: parseInt(summary.noise),
                cleanliness: parseInt(summary.cleanliness),
                security: parseInt(summary.security),
                billing: parseInt(summary.billing),
                amenity: parseInt(summary.amenity),
                other: parseInt(summary.other),
              },
            },
          },
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // GET /api/complaints/:id
  getComplaintById = async (req, res, next) => {
    try {
      const complaintId = req.params.id;
      const client = await pool.connect();

      try {
        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        // Build access control condition
        let buildingAccessCondition = "";
        let accessParams = [complaintId];

        if (managedBuildingIds !== null) {
          if (managedBuildingIds.length === 0) {
            return next(createError("NOT_FOUND", "Complaint not found"));
          }
          buildingAccessCondition = "AND c.building_id = ANY($2)";
          accessParams.push(managedBuildingIds);
        }

        // Get complaint details
        const complaintQuery = `
          SELECT 
            c.*,
            b.name as building_name,
            b.address_line1,
            b.city,
            b.state,
            f.floor_number,
            f.floor_name,
            r.room_number,
            r.room_type,
            u.unit_number,
            CONCAT(tp.first_name, ' ', tp.last_name) as tenant_name,
            tp.phone as tenant_phone,
            tp.emergency_contact_name,
            tp.emergency_contact_phone,
            tenant_user.email as tenant_email,
            tp.profile_picture as tenant_avatar,
            CASE 
              WHEN c.assigned_to IS NOT NULL THEN CONCAT(ap.first_name, ' ', ap.last_name)
              ELSE NULL
            END as assigned_to_name,
            CASE 
              WHEN c.assigned_to IS NOT NULL THEN ap.phone
              ELSE NULL
            END as assigned_to_phone,
            -- Calculate resolution time
            CASE 
              WHEN c.resolved_at IS NOT NULL THEN 
                EXTRACT(EPOCH FROM (c.resolved_at - c.created_at))/3600
              ELSE NULL
            END as actual_resolution_hours
          FROM complaints c
          INNER JOIN buildings b ON c.building_id = b.id
          LEFT JOIN floors f ON c.building_id = f.building_id AND c.room_id IS NOT NULL
          LEFT JOIN rooms r ON c.room_id = r.id
          LEFT JOIN units u ON c.unit_id = u.id
          INNER JOIN users tenant_user ON c.tenant_user_id = tenant_user.id
          INNER JOIN user_profiles tp ON tenant_user.id = tp.user_id
          LEFT JOIN users assigned_user ON c.assigned_to = assigned_user.id
          LEFT JOIN user_profiles ap ON assigned_user.id = ap.user_id
          WHERE c.id = $1 ${buildingAccessCondition}
        `;

        const complaintResult = await client.query(
          complaintQuery,
          accessParams
        );

        if (complaintResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Complaint not found"));
        }

        const complaint = complaintResult.rows[0];

        // Get complaint activities
        const activitiesQuery = `
          SELECT 
            ca.*,
            CASE 
              WHEN ca.created_by IS NOT NULL THEN CONCAT(up.first_name, ' ', up.last_name)
              ELSE 'System'
            END as created_by_name,
            CASE 
              WHEN ca.created_by IS NOT NULL THEN u.role
              ELSE 'system'
            END as created_by_role
          FROM complaint_activities ca
          LEFT JOIN users u ON ca.created_by = u.id
          LEFT JOIN user_profiles up ON u.id = up.user_id
          WHERE ca.complaint_id = $1
          ORDER BY ca.created_at DESC
        `;

        const activitiesResult = await client.query(activitiesQuery, [
          complaintId,
        ]);

        // Process the response
        const response = {
          success: true,
          data: {
            complaint: {
              id: complaint.id,
              complaintNumber: complaint.complaint_number,
              title: complaint.title,
              description: complaint.description,
              category: complaint.category,
              subcategory: complaint.subcategory,
              priority: complaint.priority,
              status: complaint.status,
              tenant: {
                id: complaint.tenant_user_id,
                name: complaint.tenant_name,
                email: complaint.tenant_email,
                phone: complaint.tenant_phone,
                avatar: complaint.tenant_avatar,
                emergencyContact: {
                  name: complaint.emergency_contact_name,
                  phone: complaint.emergency_contact_phone,
                },
              },
              activities: activitiesResult.rows.map((activity) => ({
                id: activity.id,
                activityType: activity.activity_type,
                description: activity.description,
                statusBefore: activity.status_before,
                statusAfter: activity.status_after,
                createdBy: {
                  name: activity.created_by_name,
                  role: activity.created_by_role,
                },
                createdFor: activity.created_for,
                attachments: activity.attachments || [],
                internalNotes: activity.internal_notes,
                createdAt: activity.created_at,
              })),
              property: {
                buildingId: complaint.building_id,
                buildingName: complaint.building_name,
                address: `${complaint.address_line1}, ${complaint.city}, ${complaint.state}`,
                floorNumber: complaint.floor_number,
                floorName: complaint.floor_name,
                roomNumber: complaint.room_number,
                roomType: complaint.room_type,
                unitNumber: complaint.unit_number,
              },
              assignment: {
                assignedTo: complaint.assigned_to,
                assignedToName: complaint.assigned_to_name,
                assignedToPhone: complaint.assigned_to_phone,
                assignedAt: complaint.assigned_at,
              },
              timeline: {
                createdAt: complaint.created_at,
                acknowledgedAt: complaint.acknowledged_at,
                resolvedAt: complaint.resolved_at,
                closedAt: complaint.closed_at,
              },
              resolution: {
                notes: complaint.resolution_notes,
                estimatedTime: complaint.estimated_resolution_time,
                actualTime: complaint.actual_resolution_hours
                  ? Math.round(complaint.actual_resolution_hours)
                  : null,
                costIncurred: complaint.cost_incurred
                  ? parseFloat(complaint.cost_incurred)
                  : 0,
                attachments: complaint.resolution_attachments || [],
              },
              feedback: {
                rating: complaint.tenant_satisfaction_rating,
                feedback: complaint.tenant_feedback,
                feedbackDate: complaint.feedback_date,
              },
              attachments: complaint.attachments || [],
            },
          },
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // PUT /api/complaints/:id/status
  updateComplaintStatus = async (req, res, next) => {
    try {
      const complaintId = req.params.id;
      const {
        status,
        resolution_notes,
        estimated_resolution_time,
        cost_incurred,
      } = req.body;

      // Handle file uploads
      const resolutionAttachments = req.files
        ? req.files.map((file) => `/uploads/complaints/${file.filename}`)
        : [];

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        // Build access control condition
        let buildingAccessCondition = "";
        let accessParams = [complaintId];

        if (managedBuildingIds !== null) {
          if (managedBuildingIds.length === 0) {
            await client.query("ROLLBACK");
            return next(createError("NOT_FOUND", "Complaint not found"));
          }
          buildingAccessCondition = "AND building_id = ANY($2)";
          accessParams.push(managedBuildingIds);
        }

        // Get current complaint status
        const currentStatusQuery = `
          SELECT status, building_id, assigned_to 
          FROM complaints 
          WHERE id = $1 ${buildingAccessCondition}
        `;

        const currentStatusResult = await client.query(
          currentStatusQuery,
          accessParams
        );

        if (currentStatusResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("NOT_FOUND", "Complaint not found"));
        }

        const currentComplaint = currentStatusResult.rows[0];
        const previousStatus = currentComplaint.status;

        // Auto-assign to building manager if not already assigned and status is being acknowledged
        let assignedTo = currentComplaint.assigned_to;
        if (!assignedTo && status === "acknowledged") {
          const managerQuery = `SELECT manager_id FROM buildings WHERE id = $1`;
          const managerResult = await client.query(managerQuery, [
            currentComplaint.building_id,
          ]);
          if (
            managerResult.rows.length > 0 &&
            managerResult.rows[0].manager_id
          ) {
            assignedTo = managerResult.rows[0].manager_id;
          }
        }

        // Prepare update fields
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        updateFields.push(`status = $${paramIndex}`);
        updateValues.push(status);
        paramIndex++;

        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        // Set timestamps based on status
        if (status === "acknowledged" && previousStatus !== "acknowledged") {
          updateFields.push(`acknowledged_at = CURRENT_TIMESTAMP`);
        }
        if (status === "resolved" && previousStatus !== "resolved") {
          updateFields.push(`resolved_at = CURRENT_TIMESTAMP`);
        }
        if (status === "closed" && previousStatus !== "closed") {
          updateFields.push(`closed_at = CURRENT_TIMESTAMP`);
        }

        // Add optional fields
        if (resolution_notes) {
          updateFields.push(`resolution_notes = $${paramIndex}`);
          updateValues.push(resolution_notes);
          paramIndex++;
        }

        if (estimated_resolution_time) {
          updateFields.push(`estimated_resolution_time = $${paramIndex}`);
          updateValues.push(estimated_resolution_time);
          paramIndex++;
        }

        if (cost_incurred !== undefined) {
          updateFields.push(`cost_incurred = $${paramIndex}`);
          updateValues.push(cost_incurred);
          paramIndex++;
        }

        if (resolutionAttachments.length > 0) {
          updateFields.push(`resolution_attachments = $${paramIndex}`);
          updateValues.push(resolutionAttachments);
          paramIndex++;
        }

        if (assignedTo && assignedTo !== currentComplaint.assigned_to) {
          updateFields.push(`assigned_to = $${paramIndex}`);
          updateValues.push(assignedTo);
          paramIndex++;
          updateFields.push(`assigned_at = CURRENT_TIMESTAMP`);
        }

        // Update complaint
        updateValues.push(complaintId);
        const updateQuery = `
          UPDATE complaints 
          SET ${updateFields.join(", ")}
          WHERE id = $${paramIndex}
          RETURNING *
        `;

        const updateResult = await client.query(updateQuery, updateValues);
        const updatedComplaint = updateResult.rows[0];

        // Create activity log
        const activityQuery = `
          INSERT INTO complaint_activities (
            complaint_id, activity_type, description, status_before, status_after, 
            created_by, created_for, attachments, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
          RETURNING *
        `;

        let activityDescription = `Status updated from "${previousStatus}" to "${status}"`;
        if (resolution_notes) {
          activityDescription += `. Resolution notes: ${resolution_notes}`;
        }

        const activityValues = [
          complaintId,
          "status_change",
          activityDescription,
          previousStatus,
          status,
          req.user.userId,
          "admin",
          resolutionAttachments,
        ];

        await client.query(activityQuery, activityValues);

        // If auto-assigned, create assignment activity
        if (assignedTo && assignedTo !== currentComplaint.assigned_to) {
          const assignmentActivityQuery = `
            INSERT INTO complaint_activities (
              complaint_id, activity_type, description, created_by, created_for, created_at
            ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          `;

          const assignmentDescription = `Complaint automatically assigned to building manager`;

          await client.query(assignmentActivityQuery, [
            complaintId,
            "assignment",
            assignmentDescription,
            req.user.userId,
            "admin",
          ]);
        }

        // Send email notifications for status updates
        if (previousStatus !== status) {
          const emailDataQuery = `
            SELECT 
              c.id, c.title, c.description, c.category, c.priority, c.created_at,
              CONCAT('COMP-', LPAD(c.id::text, 6, '0')) as complaint_number,
              u.email as tenant_email,
              up.first_name || ' ' || up.last_name as tenant_name,
              b.name as building_name,
              un.unit_number,
              assigned_user.first_name || ' ' || assigned_user.last_name as assigned_to_name
            FROM complaints c
            JOIN users u ON c.tenant_user_id = u.id
            LEFT JOIN user_profiles up ON u.id = up.user_id
            JOIN buildings b ON c.building_id = b.id
            LEFT JOIN units un ON c.unit_id = un.id
            LEFT JOIN user_profiles assigned_user ON c.assigned_to = assigned_user.user_id
            WHERE c.id = $1
          `;
          
          const emailDataResult = await client.query(emailDataQuery, [complaintId]);
          
          if (emailDataResult.rows.length > 0) {
            const emailData = emailDataResult.rows[0];
            
            try {
              if (status === 'resolved') {
                // Send resolved notification
                await sendComplaintEmail('resolved', emailData.tenant_email, {
                  complaintNumber: emailData.complaint_number,
                  tenantName: emailData.tenant_name,
                  title: emailData.title,
                  resolvedAt: new Date(),
                  resolutionNotes: resolution_notes,
                  complaintId: updatedComplaint.id
                });
                console.log(`✅ Resolution notification sent for complaint ${emailData.complaint_number}`);
              } else {
                // Send status update notification
                await sendComplaintEmail('status_update', emailData.tenant_email, {
                  complaintNumber: emailData.complaint_number,
                  tenantName: emailData.tenant_name,
                  title: emailData.title,
                  status: status,
                  previousStatus: previousStatus,
                  assignedTo: emailData.assigned_to_name,
                  updateNote: resolution_notes,
                  complaintId: updatedComplaint.id
                });
                console.log(`✅ Status update notification sent for complaint ${emailData.complaint_number}`);
              }
            } catch (emailError) {
              console.error(`❌ Failed to send status update notification for complaint ${emailData.complaint_number}:`, emailError);
              // Don't fail the entire operation if email fails
            }
          }
        }

        await client.query("COMMIT");

        const response = {
          success: true,
          message: `Complaint status updated to ${status}`,
          data: {
            id: updatedComplaint.id,
            status: updatedComplaint.status,
            acknowledgedAt: updatedComplaint.acknowledged_at,
            resolvedAt: updatedComplaint.resolved_at,
            closedAt: updatedComplaint.closed_at,
            assignedTo: updatedComplaint.assigned_to,
            assignedAt: updatedComplaint.assigned_at,
            resolutionNotes: updatedComplaint.resolution_notes,
            estimatedResolutionTime: updatedComplaint.estimated_resolution_time,
            costIncurred: updatedComplaint.cost_incurred
              ? parseFloat(updatedComplaint.cost_incurred)
              : 0,
            resolutionAttachments:
              updatedComplaint.resolution_attachments || [],
            updatedAt: updatedComplaint.updated_at,
          },
        };

        res.json(response);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // POST /api/complaints/:id/activity
  addComplaintActivity = async (req, res, next) => {
    try {
      const complaintId = req.params.id;
      const { activity_type, description, internal_notes } = req.body;

      // Handle file uploads
      const attachments = req.files
        ? req.files.map((file) => `/uploads/complaints/${file.filename}`)
        : [];

      const client = await pool.connect();

      try {
        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        // Build access control condition
        let buildingAccessCondition = "";
        let accessParams = [complaintId];

        if (managedBuildingIds !== null) {
          if (managedBuildingIds.length === 0) {
            return next(createError("NOT_FOUND", "Complaint not found"));
          }
          buildingAccessCondition = "AND building_id = ANY($2)";
          accessParams.push(managedBuildingIds);
        }

        // Verify complaint exists and user has access
        const complaintQuery = `
          SELECT id, status 
          FROM complaints 
          WHERE id = $1 ${buildingAccessCondition}
        `;

        const complaintResult = await client.query(
          complaintQuery,
          accessParams
        );

        if (complaintResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Complaint not found"));
        }

        // Insert activity
        const activityQuery = `
          INSERT INTO complaint_activities (
            complaint_id, activity_type, description, internal_notes, 
            attachments, created_by, created_for, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
          RETURNING *
        `;

        const activityValues = [
          complaintId,
          activity_type,
          description,
          internal_notes,
          attachments,
          req.user.userId,
          "admin",
        ];

        const activityResult = await client.query(
          activityQuery,
          activityValues
        );
        const activity = activityResult.rows[0];

        // Get creator details
        const creatorQuery = `
          SELECT CONCAT(up.first_name, ' ', up.last_name) as name, u.role
          FROM users u
          INNER JOIN user_profiles up ON u.id = up.user_id
          WHERE u.id = $1
        `;

        const creatorResult = await client.query(creatorQuery, [
          req.user.userId,
        ]);

        const creator = creatorResult.rows[0];

        const response = {
          success: true,
          message: "Activity added to complaint",
          data: {
            activity: {
              id: activity.id,
              complaintId: activity.complaint_id,
              activityType: activity.activity_type,
              description: activity.description,
              internalNotes: activity.internal_notes,
              attachments: activity.attachments || [],
              createdBy: {
                id: req.user.userId,
                name: creator.name,
                role: creator.role,
              },
              createdFor: activity.created_for,
              createdAt: activity.created_at,
            },
          },
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // GET /api/complaints/stats
  getComplaintsStats = async (req, res, next) => {
    try {
      const { building_id, period = "30days" } = req.query;
      const client = await pool.connect();

      try {
        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        // Build WHERE clause for building access
        let whereConditions = ["1=1"];
        let queryParams = [];
        let paramIndex = 1;

        if (managedBuildingIds !== null) {
          if (managedBuildingIds.length === 0) {
            return res.json({
              success: true,
              data: {
                overview: {
                  total: 0,
                  byStatus: {},
                  byCategory: {},
                  byPriority: {},
                },
                trends: { daily: [], weekly: [], monthly: [] },
                performance: {
                  averageResolutionTime: 0,
                  resolutionRate: 0,
                  satisfactionScore: 0,
                },
              },
            });
          }
          whereConditions.push(`c.building_id = ANY(${paramIndex})`);
          queryParams.push(managedBuildingIds);
          paramIndex++;
        }

        // Building filter
        if (building_id) {
          whereConditions.push(`c.building_id = ${paramIndex}`);
          queryParams.push(building_id);
          paramIndex++;
        }

        // Date filter based on period
        const periodMap = {
          "7days": 7,
          "30days": 30,
          "90days": 90,
          "6months": 180,
          "1year": 365,
        };

        const days = periodMap[period] || 30;
        whereConditions.push(
          `c.created_at >= CURRENT_DATE - INTERVAL '${days} days'`
        );

        const whereClause = whereConditions.join(" AND ");

        // Overall statistics
        const overviewQuery = `
          SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN c.status = 'submitted' THEN 1 END) as submitted,
            COUNT(CASE WHEN c.status = 'acknowledged' THEN 1 END) as acknowledged,
            COUNT(CASE WHEN c.status = 'in_progress' THEN 1 END) as in_progress,
            COUNT(CASE WHEN c.status = 'resolved' THEN 1 END) as resolved,
            COUNT(CASE WHEN c.status = 'closed' THEN 1 END) as closed,
            COUNT(CASE WHEN c.status = 'rejected' THEN 1 END) as rejected,
            COUNT(CASE WHEN c.priority = 'urgent' THEN 1 END) as urgent,
            COUNT(CASE WHEN c.priority = 'high' THEN 1 END) as high,
            COUNT(CASE WHEN c.priority = 'medium' THEN 1 END) as medium,
            COUNT(CASE WHEN c.priority = 'low' THEN 1 END) as low,
            COUNT(CASE WHEN c.category = 'maintenance' THEN 1 END) as maintenance,
            COUNT(CASE WHEN c.category = 'noise' THEN 1 END) as noise,
            COUNT(CASE WHEN c.category = 'cleanliness' THEN 1 END) as cleanliness,
            COUNT(CASE WHEN c.category = 'security' THEN 1 END) as security,
            COUNT(CASE WHEN c.category = 'billing' THEN 1 END) as billing,
            COUNT(CASE WHEN c.category = 'amenity' THEN 1 END) as amenity,
            COUNT(CASE WHEN c.category = 'other' THEN 1 END) as other
          FROM complaints c
          WHERE ${whereClause}
        `;

        const overviewResult = await client.query(overviewQuery, queryParams);
        const overview = overviewResult.rows[0];

        // Daily trends for the period
        const trendsQuery = `
          SELECT 
            DATE(c.created_at) as date,
            COUNT(*) as total,
            COUNT(CASE WHEN c.status IN ('resolved', 'closed') THEN 1 END) as resolved,
            AVG(CASE WHEN c.resolved_at IS NOT NULL 
                THEN EXTRACT(EPOCH FROM (c.resolved_at - c.created_at))/3600 
                ELSE NULL END) as avg_resolution_hours
          FROM complaints c
          WHERE ${whereClause}
          GROUP BY DATE(c.created_at)
          ORDER BY date DESC
          LIMIT 30
        `;

        const trendsResult = await client.query(trendsQuery, queryParams);

        // Performance metrics
        const performanceQuery = `
          SELECT 
            AVG(CASE WHEN c.resolved_at IS NOT NULL 
                THEN EXTRACT(EPOCH FROM (c.resolved_at - c.created_at))/3600 
                ELSE NULL END) as avg_resolution_hours,
            COUNT(CASE WHEN c.status IN ('resolved', 'closed') THEN 1 END)::float / 
            NULLIF(COUNT(*), 0) * 100 as resolution_rate,
            AVG(c.tenant_satisfaction_rating) as avg_satisfaction,
            COUNT(CASE WHEN c.tenant_satisfaction_rating IS NOT NULL THEN 1 END) as rated_complaints
          FROM complaints c
          WHERE ${whereClause}
        `;

        const performanceResult = await client.query(
          performanceQuery,
          queryParams
        );
        const performance = performanceResult.rows[0];

        // Top categories and their resolution times
        const categoryPerformanceQuery = `
          SELECT 
            c.category,
            COUNT(*) as total,
            COUNT(CASE WHEN c.status IN ('resolved', 'closed') THEN 1 END) as resolved,
            AVG(CASE WHEN c.resolved_at IS NOT NULL 
                THEN EXTRACT(EPOCH FROM (c.resolved_at - c.created_at))/3600 
                ELSE NULL END) as avg_resolution_hours,
            AVG(c.tenant_satisfaction_rating) as avg_satisfaction
          FROM complaints c
          WHERE ${whereClause}
          GROUP BY c.category
          ORDER BY total DESC
        `;

        const categoryPerformanceResult = await client.query(
          categoryPerformanceQuery,
          queryParams
        );

        const response = {
          success: true,
          data: {
            overview: {
              total: parseInt(overview.total),
              byStatus: {
                submitted: parseInt(overview.submitted),
                acknowledged: parseInt(overview.acknowledged),
                in_progress: parseInt(overview.in_progress),
                resolved: parseInt(overview.resolved),
                closed: parseInt(overview.closed),
                rejected: parseInt(overview.rejected),
              },
              byPriority: {
                urgent: parseInt(overview.urgent),
                high: parseInt(overview.high),
                medium: parseInt(overview.medium),
                low: parseInt(overview.low),
              },
              byCategory: {
                maintenance: parseInt(overview.maintenance),
                noise: parseInt(overview.noise),
                cleanliness: parseInt(overview.cleanliness),
                security: parseInt(overview.security),
                billing: parseInt(overview.billing),
                amenity: parseInt(overview.amenity),
                other: parseInt(overview.other),
              },
            },
            trends: {
              daily: trendsResult.rows.map((row) => ({
                date: row.date,
                total: parseInt(row.total),
                resolved: parseInt(row.resolved),
                avgResolutionHours: row.avg_resolution_hours
                  ? parseFloat(row.avg_resolution_hours).toFixed(1)
                  : null,
              })),
            },
            performance: {
              averageResolutionTime: performance.avg_resolution_hours
                ? parseFloat(performance.avg_resolution_hours).toFixed(1)
                : 0,
              resolutionRate: performance.resolution_rate
                ? parseFloat(performance.resolution_rate).toFixed(1)
                : 0,
              satisfactionScore: performance.avg_satisfaction
                ? parseFloat(performance.avg_satisfaction).toFixed(1)
                : null,
              totalRatedComplaints: parseInt(performance.rated_complaints) || 0,
            },
            categoryPerformance: categoryPerformanceResult.rows.map((row) => ({
              category: row.category,
              total: parseInt(row.total),
              resolved: parseInt(row.resolved),
              resolutionRate:
                row.total > 0
                  ? ((row.resolved / row.total) * 100).toFixed(1)
                  : "0",
              avgResolutionTime: row.avg_resolution_hours
                ? parseFloat(row.avg_resolution_hours).toFixed(1)
                : null,
              avgSatisfaction: row.avg_satisfaction
                ? parseFloat(row.avg_satisfaction).toFixed(1)
                : null,
            })),
          },
          filters: {
            buildingId: building_id,
            period,
          },
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // GET /api/complaints/categories
  getComplaintCategories = async (req, res, next) => {
    try {
      const { building_id } = req.query;
      const client = await pool.connect();

      try {
        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        // Build WHERE clause
        let whereConditions = ["1=1"];
        let queryParams = [];
        let paramIndex = 1;

        if (managedBuildingIds !== null) {
          if (managedBuildingIds.length === 0) {
            return res.json({
              success: true,
              data: { categories: [], subcategories: {} },
            });
          }
          whereConditions.push(`c.building_id = ANY(${paramIndex})`);
          queryParams.push(managedBuildingIds);
          paramIndex++;
        }

        if (building_id) {
          whereConditions.push(`c.building_id = ${paramIndex}`);
          queryParams.push(building_id);
          paramIndex++;
        }

        const whereClause = whereConditions.join(" AND ");

        // Get categories with counts
        const categoriesQuery = `
          SELECT 
            c.category,
            COUNT(*) as total,
            COUNT(CASE WHEN c.status = 'submitted' THEN 1 END) as pending,
            COUNT(CASE WHEN c.status IN ('resolved', 'closed') THEN 1 END) as resolved
          FROM complaints c
          WHERE ${whereClause}
          GROUP BY c.category
          ORDER BY total DESC
        `;

        const categoriesResult = await client.query(
          categoriesQuery,
          queryParams
        );

        // Get subcategories with counts
        const subcategoriesQuery = `
          SELECT 
            c.category,
            c.subcategory,
            COUNT(*) as total,
            COUNT(CASE WHEN c.status = 'submitted' THEN 1 END) as pending,
            COUNT(CASE WHEN c.status IN ('resolved', 'closed') THEN 1 END) as resolved
          FROM complaints c
          WHERE ${whereClause} AND c.subcategory IS NOT NULL
          GROUP BY c.category, c.subcategory
          ORDER BY c.category, total DESC
        `;

        const subcategoriesResult = await client.query(
          subcategoriesQuery,
          queryParams
        );

        // Group subcategories by category
        const subcategoriesByCategory = {};
        subcategoriesResult.rows.forEach((row) => {
          if (!subcategoriesByCategory[row.category]) {
            subcategoriesByCategory[row.category] = [];
          }
          subcategoriesByCategory[row.category].push({
            name: row.subcategory,
            total: parseInt(row.total),
            pending: parseInt(row.pending),
            resolved: parseInt(row.resolved),
          });
        });

        const response = {
          success: true,
          data: {
            categories: categoriesResult.rows.map((row) => ({
              name: row.category,
              total: parseInt(row.total),
              pending: parseInt(row.pending),
              resolved: parseInt(row.resolved),
              resolutionRate:
                row.total > 0
                  ? ((row.resolved / row.total) * 100).toFixed(1)
                  : "0",
            })),
            subcategories: subcategoriesByCategory,
          },
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // GET /api/complaints/buildings
  getBuildings = async (req, res, next) => {
    try {
      const client = await pool.connect();

      try {
        // Get managed buildings for access control
        const managedBuildingIds = await this.getManagedBuildingIds(
          client,
          req.user.userId,
          req.user.role
        );

        // Build WHERE clause
        let whereConditions = ["1=1"];
        let queryParams = [];

        if (managedBuildingIds !== null) {
          if (managedBuildingIds.length === 0) {
            return res.json({
              success: true,
              data: [],
            });
          }
          whereConditions.push("b.id = ANY($1)");
          queryParams.push(managedBuildingIds);
        }

        const whereClause = whereConditions.join(" AND ");

        // Get buildings with complaint counts
        const buildingsQuery = `
          SELECT 
            b.id,
            b.name,
            b.address_line1 || ', ' || b.city || ', ' || b.state as location,
            COUNT(c.id) as total_complaints,
            COUNT(CASE WHEN c.status IN ('submitted', 'acknowledged', 'in_progress') THEN 1 END) as active_complaints
          FROM buildings b
          LEFT JOIN complaints c ON b.id = c.building_id
          WHERE ${whereClause}
          GROUP BY b.id, b.name, b.address_line1, b.city, b.state
          ORDER BY b.name
        `;

        const buildingsResult = await client.query(buildingsQuery, queryParams);

        console.log("buildings data is: ", buildingsResult.rows);
        const response = {
          success: true,
          data: buildingsResult.rows.map((row) => ({
            id: row.id,
            name: row.name,
            location: row.location,
            totalComplaints: parseInt(row.total_complaints),
            activeComplaints: parseInt(row.active_complaints),
          })),
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };
}

export default new ComplaintsController();
