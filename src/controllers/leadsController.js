// src/controllers/leadsController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import { v4 as uuidv4 } from "uuid";

class LeadsController {
  /**
   * Get leads organized for Kanban board
   */
  static async getKanbanBoard(req, res, next) {
    try {
      const { assigned_to, source, priority, building_id } = req.query;

      let query = `
        SELECT 
          l.*,
          b.name as building_name,
          u.first_name, u.last_name,
          COUNT(la.id) as activity_count,
          MAX(la.created_at) as last_activity_date
        FROM leads l
        LEFT JOIN buildings b ON l.preferred_building_id = b.id
        LEFT JOIN user_profiles u ON l.assigned_to = u.user_id
        LEFT JOIN lead_activities la ON l.id = la.lead_id
        WHERE 1=1
      `;

      const params = [];
      let paramIndex = 1;

      // Apply filters
      if (assigned_to) {
        query += ` AND l.assigned_to = $${paramIndex}`;
        params.push(assigned_to);
        paramIndex++;
      }

      if (source) {
        query += ` AND l.source = $${paramIndex}`;
        params.push(source);
        paramIndex++;
      }

      if (priority) {
        query += ` AND l.priority = $${paramIndex}`;
        params.push(priority);
        paramIndex++;
      }

      if (building_id) {
        query += ` AND l.preferred_building_id = $${paramIndex}`;
        params.push(building_id);
        paramIndex++;
      }

      query += `
        GROUP BY l.id, b.name, u.first_name, u.last_name
        ORDER BY l.status, l.stage_position, l.created_at DESC
      `;

      const result = await pool.query(query, params);

      // Group by status for Kanban columns
      const kanbanData = {
        new_leads: [],
        hot: [],
        warm: [],
        initial_contact: [],
        negotiations: [],
        cold: [],
        lost: [],
        won: [],
      };

      result.rows.forEach((lead) => {
        if (kanbanData[lead.status]) {
          kanbanData[lead.status].push({
            ...lead,
            agent_name:
              lead.first_name && lead.last_name
                ? `${lead.first_name} ${lead.last_name}`
                : null,
          });
        }
      });

      // Get column stats
      const statsQuery = `
        SELECT 
          status,
          COUNT(*) as count,
          COUNT(CASE WHEN priority = 'high' OR priority = 'urgent' THEN 1 END) as high_priority_count
        FROM leads 
        WHERE 1=1
        ${assigned_to ? `AND assigned_to = $1` : ""}
        GROUP BY status
      `;

      const statsResult = await pool.query(
        statsQuery,
        assigned_to ? [assigned_to] : []
      );

      const stats = {};
      statsResult.rows.forEach((row) => {
        stats[row.status] = {
          total: parseInt(row.count),
          highPriority: parseInt(row.high_priority_count),
        };
      });

      res.json({
        success: true,
        data: {
          columns: kanbanData,
          stats,
        },
      });
    } catch (error) {
      console.error("Error fetching Kanban board:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch Kanban board"));
    }
  }

  /**
   * Get all leads with pagination and filters
   */
  static async getAllLeads(req, res, next) {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        assigned_to,
        source,
        search,
      } = req.query;

      const offset = (page - 1) * limit;

      let query = `
        SELECT 
          l.*,
          b.name as building_name,
          u.first_name, u.last_name,
          COUNT(la.id) as activity_count
        FROM leads l
        LEFT JOIN buildings b ON l.preferred_building_id = b.id
        LEFT JOIN user_profiles u ON l.assigned_to = u.user_id
        LEFT JOIN lead_activities la ON l.id = la.lead_id
        WHERE 1=1
      `;

      const params = [];
      let paramIndex = 1;

      // Apply filters
      if (status) {
        query += ` AND l.status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (assigned_to) {
        query += ` AND l.assigned_to = $${paramIndex}`;
        params.push(assigned_to);
        paramIndex++;
      }

      if (source) {
        query += ` AND l.source = $${paramIndex}`;
        params.push(source);
        paramIndex++;
      }

      if (search) {
        query += ` AND (l.name ILIKE $${paramIndex} OR l.phone ILIKE $${paramIndex} OR l.email ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      query += `
        GROUP BY l.id, b.name, u.first_name, u.last_name
        ORDER BY l.created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      params.push(limit, offset);

      const result = await pool.query(query, params);

      // Get total count for pagination
      let countQuery = `
        SELECT COUNT(DISTINCT l.id) as total
        FROM leads l
        WHERE 1=1
      `;

      const countParams = [];
      let countParamIndex = 1;

      if (status) {
        countQuery += ` AND l.status = $${countParamIndex}`;
        countParams.push(status);
        countParamIndex++;
      }

      if (assigned_to) {
        countQuery += ` AND l.assigned_to = $${countParamIndex}`;
        countParams.push(assigned_to);
        countParamIndex++;
      }

      if (source) {
        countQuery += ` AND l.source = $${countParamIndex}`;
        countParams.push(source);
        countParamIndex++;
      }

      if (search) {
        countQuery += ` AND (l.name ILIKE $${countParamIndex} OR l.phone ILIKE $${countParamIndex} OR l.email ILIKE $${countParamIndex})`;
        countParams.push(`%${search}%`);
      }

      const countResult = await pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total);

      res.json({
        success: true,
        data: {
          leads: result.rows.map((lead) => ({
            ...lead,
            agent_name:
              lead.first_name && lead.last_name
                ? `${lead.first_name} ${lead.last_name}`
                : null,
          })),
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      console.error("Error fetching leads:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch leads"));
    }
  }

  /**
   * Get single lead details
   */
  static async getLeadById(req, res, next) {
    try {
      const { id } = req.params;

      const query = `
        SELECT 
          l.*,
          b.name as building_name,
          u.first_name, u.last_name
        FROM leads l
        LEFT JOIN buildings b ON l.preferred_building_id = b.id
        LEFT JOIN user_profiles u ON l.assigned_to = u.user_id
        WHERE l.id = $1
      `;

      const result = await pool.query(query, [id]);

      if (result.rows.length === 0) {
        return next(createError("NOT_FOUND", "Lead not found"));
      }

      const lead = {
        ...result.rows[0],
        agent_name:
          result.rows[0].first_name && result.rows[0].last_name
            ? `${result.rows[0].first_name} ${result.rows[0].last_name}`
            : null,
      };

      res.json({
        success: true,
        data: lead,
      });
    } catch (error) {
      console.error("Error fetching lead:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch lead"));
    }
  }

  /**
   * Create new lead
   */
  static async createLead(req, res, next) {
    try {
      const {
        name,
        phone,
        email,
        source,
        preferred_building_id,
        preferred_room_type,
        budget_min,
        budget_max,
        preferred_move_in_date,
        notes,
      } = req.body;

      const uuid = uuidv4();

      // Check for duplicate phone number
      const duplicateCheck = await pool.query(
        "SELECT id FROM leads WHERE phone = $1",
        [phone]
      );

      if (duplicateCheck.rows.length > 0) {
        return next(
          createError("CONFLICT", "Lead with this phone number already exists")
        );
      }

      // Get next stage position for new_leads status
      const positionResult = await pool.query(
        "SELECT COALESCE(MAX(stage_position), 0) + 1 as next_position FROM leads WHERE status = $1",
        ["new_leads"]
      );

      const nextPosition = positionResult.rows[0].next_position;

      const query = `
        INSERT INTO leads (
          uuid, name, phone, email, source, preferred_building_id,
          preferred_room_type, budget_min, budget_max, preferred_move_in_date,
          notes, status, stage_position
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        ) RETURNING *
      `;

      const values = [
        uuid,
        name,
        phone,
        email,
        source,
        preferred_building_id,
        preferred_room_type,
        budget_min,
        budget_max,
        preferred_move_in_date,
        notes,
        "new_leads",
        nextPosition,
      ];

      const result = await pool.query(query, values);

      res.status(201).json({
        success: true,
        message: "Lead created successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("Error creating lead:", error);
      next(createError("DATABASE_ERROR", "Failed to create lead"));
    }
  }

  /**
   * Update lead details
   */
  static async updateLead(req, res, next) {
    try {
      const { id } = req.params;
      const updateFields = req.body;

      // Remove fields that shouldn't be updated directly
      delete updateFields.status;
      delete updateFields.stage_position;
      delete updateFields.uuid;

      if (Object.keys(updateFields).length === 0) {
        return next(
          createError("VALIDATION_ERROR", "No valid fields to update")
        );
      }

      // Check if phone number is being updated and if it's duplicate
      if (updateFields.phone) {
        const duplicateCheck = await pool.query(
          "SELECT id FROM leads WHERE phone = $1 AND id != $2",
          [updateFields.phone, id]
        );

        if (duplicateCheck.rows.length > 0) {
          return next(
            createError(
              "CONFLICT",
              "Lead with this phone number already exists"
            )
          );
        }
      }

      // Build dynamic update query
      const setClause = Object.keys(updateFields)
        .map((key, index) => `${key} = $${index + 2}`)
        .join(", ");

      const query = `
        UPDATE leads 
        SET ${setClause}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `;

      const values = [id, ...Object.values(updateFields)];
      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return next(createError("NOT_FOUND", "Lead not found"));
      }

      res.json({
        success: true,
        message: "Lead updated successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("Error updating lead:", error);
      next(createError("DATABASE_ERROR", "Failed to update lead"));
    }
  }

  /**
   * Update lead status (Kanban drag & drop)
   */
  static async updateLeadStatus(req, res, next) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { id } = req.params;
      const { status, stage_position, reason } = req.body;
      const userId = req.user.id;

      // Get current lead data
      const currentLead = await client.query(
        "SELECT status FROM leads WHERE id = $1",
        [id]
      );

      if (currentLead.rows.length === 0) {
        await client.query("ROLLBACK");
        return next(createError("NOT_FOUND", "Lead not found"));
      }

      const currentStatus = currentLead.rows[0].status;

      // Update other leads' positions in the new status column
      await client.query(
        "UPDATE leads SET stage_position = stage_position + 1 WHERE status = $1 AND stage_position >= $2",
        [status, stage_position]
      );

      // Update the lead
      const updateResult = await client.query(
        `UPDATE leads 
         SET status = $1, stage_position = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING *`,
        [status, stage_position, id]
      );

      // Record the transition
      if (currentStatus !== status) {
        await client.query(
          `INSERT INTO lead_stage_transitions 
           (lead_id, from_status, to_status, moved_by, reason)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, currentStatus, status, userId, reason]
        );
      }

      await client.query("COMMIT");

      res.json({
        success: true,
        message: "Lead status updated successfully",
        data: updateResult.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error updating lead status:", error);
      next(createError("DATABASE_ERROR", "Failed to update lead status"));
    } finally {
      client.release();
    }
  }

  /**
   * Assign lead to agent
   */
  static async assignLead(req, res, next) {
    try {
      const { id } = req.params;
      const { assigned_to } = req.body;

      // Verify the user exists and has appropriate role
      const userCheck = await pool.query(
        "SELECT id, role FROM users WHERE id = $1",
        [assigned_to]
      );

      if (userCheck.rows.length === 0) {
        return next(createError("NOT_FOUND", "User not found"));
      }

      const userRole = userCheck.rows[0].role;
      if (!["admin", "manager"].includes(userRole)) {
        return next(
          createError("VALIDATION_ERROR", "User must be an admin or manager")
        );
      }

      const result = await pool.query(
        `UPDATE leads 
         SET assigned_to = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
         RETURNING *`,
        [assigned_to, id]
      );

      if (result.rows.length === 0) {
        return next(createError("NOT_FOUND", "Lead not found"));
      }

      res.json({
        success: true,
        message: "Lead assigned successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("Error assigning lead:", error);
      next(createError("DATABASE_ERROR", "Failed to assign lead"));
    }
  }

  /**
   * Delete lead
   */
  static async deleteLead(req, res, next) {
    try {
      const { id } = req.params;

      const result = await pool.query(
        "DELETE FROM leads WHERE id = $1 RETURNING id",
        [id]
      );

      if (result.rows.length === 0) {
        return next(createError("NOT_FOUND", "Lead not found"));
      }

      res.json({
        success: true,
        message: "Lead deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting lead:", error);
      next(createError("DATABASE_ERROR", "Failed to delete lead"));
    }
  }

  /**
   * Get lead activities/touch log
   */
  static async getLeadActivities(req, res, next) {
    try {
      const { id } = req.params;
      const { page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;

      const query = `
        SELECT 
          la.*,
          u.first_name, u.last_name
        FROM lead_activities la
        LEFT JOIN user_profiles u ON la.created_by = u.user_id
        WHERE la.lead_id = $1
        ORDER BY la.created_at DESC
        LIMIT $2 OFFSET $3
      `;

      const result = await pool.query(query, [id, limit, offset]);

      // Get total count
      const countResult = await pool.query(
        "SELECT COUNT(*) as total FROM lead_activities WHERE lead_id = $1",
        [id]
      );

      const total = parseInt(countResult.rows[0].total);

      res.json({
        success: true,
        data: {
          activities: result.rows.map((activity) => ({
            ...activity,
            created_by_name:
              activity.first_name && activity.last_name
                ? `${activity.first_name} ${activity.last_name}`
                : null,
          })),
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      console.error("Error fetching lead activities:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch lead activities"));
    }
  }

  /**
   * Add new activity to lead
   */
  static async addLeadActivity(req, res, next) {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { id } = req.params;
      const {
        activity_type,
        communication_mode,
        outcome,
        title,
        description,
        notes,
        next_action,
        scheduled_at,
        next_interaction_date,
      } = req.body;

      const userId = req.user.id;

      // Verify lead exists
      const leadCheck = await client.query(
        "SELECT id, status FROM leads WHERE id = $1",
        [id]
      );

      if (leadCheck.rows.length === 0) {
        await client.query("ROLLBACK");
        return next(createError("NOT_FOUND", "Lead not found"));
      }

      const currentStatus = leadCheck.rows[0].status;

      // Get next touch number
      const touchResult = await client.query(
        "SELECT COALESCE(MAX(touch_number), 0) + 1 as next_touch FROM lead_activities WHERE lead_id = $1",
        [id]
      );

      const nextTouch = touchResult.rows[0].next_touch;

      // Insert activity
      const activityQuery = `
        INSERT INTO lead_activities (
          lead_id, activity_type, touch_number, communication_mode, outcome,
          title, description, notes, next_action, scheduled_at, 
          next_interaction_date, status_before, created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        ) RETURNING *
      `;

      const activityValues = [
        id,
        activity_type,
        nextTouch,
        communication_mode,
        outcome,
        title,
        description,
        notes,
        next_action,
        scheduled_at,
        next_interaction_date,
        currentStatus,
        userId,
      ];

      const activityResult = await client.query(activityQuery, activityValues);

      // Update lead's last contacted date and next follow-up
      const leadUpdateQuery = `
        UPDATE leads 
        SET 
          last_contacted_at = CURRENT_TIMESTAMP,
          next_follow_up_date = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `;

      await client.query(leadUpdateQuery, [next_interaction_date, id]);

      await client.query("COMMIT");

      res.status(201).json({
        success: true,
        message: "Activity added successfully",
        data: activityResult.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error adding lead activity:", error);
      next(createError("DATABASE_ERROR", "Failed to add lead activity"));
    } finally {
      client.release();
    }
  }

  /**
   * Get leads overview statistics
   */
  static async getLeadsOverview(req, res, next) {
    try {
      const { date_from, date_to, assigned_to } = req.query;

      let whereClause = "WHERE 1=1";
      const params = [];
      let paramIndex = 1;

      if (date_from) {
        whereClause += ` AND l.created_at >= $${paramIndex}`;
        params.push(date_from);
        paramIndex++;
      }

      if (date_to) {
        whereClause += ` AND l.created_at <= $${paramIndex}`;
        params.push(date_to);
        paramIndex++;
      }

      if (assigned_to) {
        whereClause += ` AND l.assigned_to = $${paramIndex}`;
        params.push(assigned_to);
        paramIndex++;
      }

      // Get comprehensive status distribution for all statuses
      const statusQuery = `
      SELECT 
        status,
        COUNT(*) as count,
        ROUND(AVG(lead_score), 2) as avg_score
      FROM leads l
      ${whereClause}
      GROUP BY status
      ORDER BY 
        CASE status
          WHEN 'new_leads' THEN 1
          WHEN 'hot' THEN 2
          WHEN 'warm' THEN 3
          WHEN 'initial_contact' THEN 4
          WHEN 'negotiations' THEN 5
          WHEN 'cold' THEN 6
          WHEN 'lost' THEN 7
          WHEN 'won' THEN 8
        END
    `;

      const statusResult = await pool.query(statusQuery, params);

      // Create complete status distribution with zeros for missing statuses
      const allStatuses = [
        "new_leads",
        "hot",
        "warm",
        "initial_contact",
        "negotiations",
        "cold",
        "lost",
        "won",
      ];
      const statusDistribution = allStatuses.map((status) => {
        const found = statusResult.rows.find((row) => row.status === status);
        return {
          status,
          count: found ? parseInt(found.count) : 0,
          avg_score: found ? parseFloat(found.avg_score) || 0 : 0,
          label: status
            .replace("_", " ")
            .replace(/\b\w/g, (l) => l.toUpperCase()),
        };
      });

      // Get source distribution
      const sourceQuery = `
      SELECT 
        source,
        COUNT(*) as count,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as converted
      FROM leads l
      ${whereClause}
      GROUP BY source
      ORDER BY count DESC
    `;

      const sourceResult = await pool.query(sourceQuery, params);

      // Get comprehensive stats for summary cards
      const summaryQuery = `
      SELECT
        COUNT(*) as total_leads,
        COUNT(CASE WHEN status = 'hot' THEN 1 END) as hot_leads,
        COUNT(CASE WHEN status = 'warm' THEN 1 END) as warm_leads,
        COUNT(CASE WHEN status = 'initial_contact' THEN 1 END) as initial_contact_leads,
        COUNT(CASE WHEN status = 'negotiations' THEN 1 END) as negotiating_leads,
        COUNT(CASE WHEN status = 'won' THEN 1 END) as converted_leads,
        COUNT(CASE WHEN status = 'lost' THEN 1 END) as lost_leads,
        COUNT(CASE WHEN status = 'cold' THEN 1 END) as cold_leads,
        COUNT(CASE WHEN status = 'new_leads' THEN 1 END) as new_leads,
        COUNT(CASE WHEN status NOT IN ('new_leads', 'lost', 'won') THEN 1 END) as active_leads,
        AVG(lead_score) as avg_lead_score
      FROM leads l
      ${whereClause}
    `;

      const summaryResult = await pool.query(summaryQuery, params);

      // Get recent activities count
      const activitiesQuery = `
      SELECT COUNT(*) as recent_activities
      FROM lead_activities la
      JOIN leads l ON la.lead_id = l.id
      ${whereClause.replace("l.created_at", "la.created_at")}
      AND la.created_at >= CURRENT_DATE - INTERVAL '7 days'
    `;

      const activitiesResult = await pool.query(activitiesQuery, params);

      // Get top performers (if not filtered by assigned_to)
      let topPerformers = [];
      if (!assigned_to) {
        const performersQuery = `
        SELECT 
          u.first_name, u.last_name,
          COUNT(*) as total_leads,
          COUNT(CASE WHEN l.status = 'won' THEN 1 END) as converted_leads,
          ROUND(
            COUNT(CASE WHEN l.status = 'won' THEN 1 END) * 100.0 / 
            NULLIF(COUNT(*), 0), 2
          ) as conversion_rate
        FROM leads l
        JOIN user_profiles u ON l.assigned_to = u.user_id
        ${whereClause}
        GROUP BY u.user_id, u.first_name, u.last_name
        HAVING COUNT(*) > 0
        ORDER BY conversion_rate DESC, total_leads DESC
        LIMIT 5
      `;

        const performersResult = await pool.query(performersQuery, params);
        topPerformers = performersResult.rows;
      }

      const summary = summaryResult.rows[0];
      const conversionRate =
        summary.total_leads > 0
          ? ((summary.converted_leads / summary.total_leads) * 100).toFixed(2)
          : 0;

      res.json({
        success: true,
        data: {
          summary: {
            total_leads: parseInt(summary.total_leads),
            hot_leads: parseInt(summary.hot_leads),
            warm_leads: parseInt(summary.warm_leads),
            converted_leads: parseInt(summary.converted_leads),
            lost_leads: parseInt(summary.lost_leads),
            cold_leads: parseInt(summary.cold_leads),
            new_leads: parseInt(summary.new_leads),
            active_leads: parseInt(summary.active_leads),
            conversion_rate: parseFloat(conversionRate),
            avg_lead_score: parseFloat(summary.avg_lead_score) || 0,
            recent_activities: parseInt(
              activitiesResult.rows[0].recent_activities
            ),
          },
          status_distribution: statusDistribution,
          source_performance: sourceResult.rows.map((row) => ({
            source: row.source,
            count: parseInt(row.count),
            converted: parseInt(row.converted),
            conversion_rate:
              row.count > 0
                ? ((row.converted / row.count) * 100).toFixed(2)
                : 0,
          })),
          conversion_funnel: statusDistribution.reduce((acc, status) => {
            acc[status.status] = status.count;
            return acc;
          }, {}),
          top_performers: topPerformers,
        },
      });
    } catch (error) {
      console.error("Error fetching leads overview:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch leads overview"));
    }
  }

  /**
   * Upload documents for lead
   */
  static async uploadLeadDocuments(req, res, next) {
    try {
      const { id } = req.params;
      const { document_type } = req.body;
      const files = req.files;

      if (!files || files.length === 0) {
        return next(createError("VALIDATION_ERROR", "No files uploaded"));
      }

      // Verify lead exists
      const leadCheck = await pool.query("SELECT id FROM leads WHERE id = $1", [
        id,
      ]);

      if (leadCheck.rows.length === 0) {
        return next(createError("NOT_FOUND", "Lead not found"));
      }

      const userId = req.user.id;
      const uploadedDocuments = [];

      for (const file of files) {
        const query = `
          INSERT INTO lead_documents (
            lead_id, document_type, file_name, file_path, 
            file_size, mime_type, uploaded_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `;

        const values = [
          id,
          document_type,
          file.originalname,
          file.path,
          file.size,
          file.mimetype,
          userId,
        ];

        const result = await pool.query(query, values);
        uploadedDocuments.push(result.rows[0]);
      }

      res.status(201).json({
        success: true,
        message: "Documents uploaded successfully",
        data: uploadedDocuments,
      });
    } catch (error) {
      console.error("Error uploading lead documents:", error);
      next(createError("DATABASE_ERROR", "Failed to upload documents"));
    }
  }

  /**
   * Get lead documents
   */
  static async getLeadDocuments(req, res, next) {
    try {
      const { id } = req.params;

      const query = `
        SELECT 
          ld.*,
          u.first_name, u.last_name
        FROM lead_documents ld
        LEFT JOIN user_profiles u ON ld.uploaded_by = u.user_id
        WHERE ld.lead_id = $1
        ORDER BY ld.created_at DESC
      `;

      const result = await pool.query(query, [id]);

      res.json({
        success: true,
        data: result.rows.map((doc) => ({
          ...doc,
          uploaded_by_name:
            doc.first_name && doc.last_name
              ? `${doc.first_name} ${doc.last_name}`
              : null,
        })),
      });
    } catch (error) {
      console.error("Error fetching lead documents:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch lead documents"));
    }
  }

  /**
   * Delete lead document
   */
  static async deleteLeadDocument(req, res, next) {
    try {
      const { id, docId } = req.params;

      const result = await pool.query(
        "DELETE FROM lead_documents WHERE id = $1 AND lead_id = $2 RETURNING file_path",
        [docId, id]
      );

      if (result.rows.length === 0) {
        return next(createError("NOT_FOUND", "Document not found"));
      }

      // TODO: Delete actual file from storage
      // const filePath = result.rows[0].file_path;
      // await fs.unlink(filePath);

      res.json({
        success: true,
        message: "Document deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting lead document:", error);
      next(createError("DATABASE_ERROR", "Failed to delete document"));
    }
  }

  /**
   * Get buildings list for dropdown
   */
  static async getBuildings(req, res, next) {
    try {
      const query = `
      SELECT 
        id,
        name,
        city,
        status
      FROM buildings 
      WHERE status = 'active'
      ORDER BY name ASC
    `;

      const result = await pool.query(query);

      res.json({
        success: true,
        data: result.rows,
      });
    } catch (error) {
      console.error("Error fetching buildings:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch buildings"));
    }
  }

  /**
   * Get agents/managers list for dropdown
   */
  static async getAgents(req, res, next) {
    console.log("getAgents");
    try {
      const query = `
      SELECT 
        u.id,
        up.first_name,
        up.last_name,
        u.role,
        u.status
      FROM users u
      JOIN user_profiles up ON u.id = up.user_id
      WHERE u.role IN ('admin', 'manager') 
        AND u.status = 'active'
      ORDER BY up.first_name ASC, up.last_name ASC
    `;

      const result = await pool.query(query);

      // Format the response to include full name
      const agents = result.rows.map((agent) => ({
        id: agent.id,
        name: `${agent.first_name} ${agent.last_name}`.trim(),
        first_name: agent.first_name,
        last_name: agent.last_name,
        role: agent.role,
      }));

      res.json({
        success: true,
        data: agents,
      });
    } catch (error) {
      console.error("Error fetching agents:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch agents"));
    }
  }

}

export default LeadsController;
