// src/controllers/announcementsController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import fs from "fs/promises";
import path from "path";

class AnnouncementsController {
  // Helper method to get buildings based on user role
  getUserAccessibleBuildings = async (userId, userRole) => {
    const client = await pool.connect();
    try {
      let buildingIds = [];

      if (userRole === "super_admin" || userRole === "admin") {
        // Super admin and admin can access all buildings
        const query = `SELECT id FROM buildings WHERE status = 'active'`;
        const result = await client.query(query);
        buildingIds = result.rows.map((row) => row.id);
      } else if (userRole === "manager") {
        // Manager can only access buildings where they are the manager
        const query = `SELECT id FROM buildings WHERE manager_id = $1 AND status = 'active'`;
        const result = await client.query(query, [userId]);
        buildingIds = result.rows.map((row) => row.id);
      }

      return buildingIds;
    } finally {
      client.release();
    }
  };

  // GET /api/announcements/stats
  getAnnouncementStats = async (req, res, next) => {
    try {
      const { user } = req;
      const accessibleBuildings = await this.getUserAccessibleBuildings(
        user.id,
        user.role
      );

      if (accessibleBuildings.length === 0) {
        return res.json({
          success: true,
          data: {
            total: 0,
            published: 0,
            draft: 0,
            expired: 0,
            pinned: 0,
            byCategory: {},
            byPriority: {},
            recentActivity: 0,
          },
        });
      }

      const client = await pool.connect();

      try {
        const placeholders = accessibleBuildings
          .map((_, i) => `$${i + 1}`)
          .join(",");

        // Get overall stats
        const statsQuery = `
          SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN is_published = true AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP) THEN 1 END) as published,
            COUNT(CASE WHEN is_published = false THEN 1 END) as draft,
            COUNT(CASE WHEN expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP THEN 1 END) as expired,
            COUNT(CASE WHEN is_pinned = true THEN 1 END) as pinned,
            COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as recent_activity
          FROM announcements 
          WHERE building_id IN (${placeholders})
        `;

        const statsResult = await client.query(statsQuery, accessibleBuildings);
        const stats = statsResult.rows[0];

        // Get category breakdown
        const categoryQuery = `
          SELECT 
            category,
            COUNT(*) as count
          FROM announcements 
          WHERE building_id IN (${placeholders})
          GROUP BY category
          ORDER BY count DESC
        `;

        const categoryResult = await client.query(
          categoryQuery,
          accessibleBuildings
        );
        const byCategory = categoryResult.rows.reduce((acc, row) => {
          acc[row.category] = parseInt(row.count);
          return acc;
        }, {});

        // Get priority breakdown
        const priorityQuery = `
          SELECT 
            priority,
            COUNT(*) as count
          FROM announcements 
          WHERE building_id IN (${placeholders})
          GROUP BY priority
          ORDER BY 
            CASE priority 
              WHEN 'urgent' THEN 1 
              WHEN 'high' THEN 2 
              WHEN 'normal' THEN 3 
              WHEN 'low' THEN 4 
            END
        `;

        const priorityResult = await client.query(
          priorityQuery,
          accessibleBuildings
        );
        const byPriority = priorityResult.rows.reduce((acc, row) => {
          acc[row.priority] = parseInt(row.count);
          return acc;
        }, {});

        res.json({
          success: true,
          data: {
            total: parseInt(stats.total),
            published: parseInt(stats.published),
            draft: parseInt(stats.draft),
            expired: parseInt(stats.expired),
            pinned: parseInt(stats.pinned),
            recentActivity: parseInt(stats.recent_activity),
            byCategory,
            byPriority,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // POST /api/announcements
  createAnnouncement = async (req, res, next) => {
    try {
      const { user } = req;
      const {
        title,
        content,
        building_id,
        category,
        priority = "normal",
        announcement_type = "info",
        target_audience = "all_tenants",
        target_floor_ids = [],
        target_room_ids = [],
        publish_at,
        expires_at,
        is_published = true,
        is_pinned = false,
        acknowledgment_required = false,
        external_links = [],
      } = req.body;

      // Check if user has access to this building
      const accessibleBuildings = await this.getUserAccessibleBuildings(
        user.id,
        user.role
      );
      if (!accessibleBuildings.includes(parseInt(building_id))) {
        return next(createError("FORBIDDEN", "Access denied to this building"));
      }

      // Handle file uploads
      let attachmentPaths = [];
      if (req.files && req.files.length > 0) {
        attachmentPaths = req.files.map(
          (file) => `/uploads/announcements/${file.filename}`
        );
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const insertQuery = `
          INSERT INTO announcements (
            title, content, building_id, category, priority, announcement_type,
            target_audience, target_floor_ids, target_room_ids, publish_at, expires_at,
            is_published, is_pinned, acknowledgment_required, attachments, external_links,
            created_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          RETURNING *
        `;

        const values = [
          title,
          content,
          building_id,
          category,
          priority,
          announcement_type,
          target_audience,
          target_floor_ids,
          target_room_ids,
          publish_at || null,
          expires_at || null,
          is_published,
          is_pinned,
          acknowledgment_required,
          attachmentPaths,
          external_links,
          user.id,
        ];

        const result = await client.query(insertQuery, values);
        const announcement = result.rows[0];

        await client.query("COMMIT");

        res.status(201).json({
          success: true,
          message: "Announcement created successfully",
          data: {
            id: announcement.id,
            title: announcement.title,
            content: announcement.content,
            category: announcement.category,
            priority: announcement.priority,
            announcementType: announcement.announcement_type,
            isPublished: announcement.is_published,
            isPinned: announcement.is_pinned,
            buildingId: announcement.building_id,
            attachments: announcement.attachments || [],
            createdAt: announcement.created_at,
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
  };

  // GET /api/announcements/buildings
  getBuildingsForAnnouncements = async (req, res, next) => {
    try {
      const { user } = req;
      const client = await pool.connect();

      try {
        let query,
          params = [];

        if (user.role === "super_admin" || user.role === "admin") {
          query = `
            SELECT 
              id, 
              name, 
              city, 
              state,
              (SELECT COUNT(*) FROM announcements WHERE building_id = buildings.id) as announcement_count
            FROM buildings 
            WHERE status = 'active'
            ORDER BY name
          `;
        } else if (user.role === "manager") {
          query = `
            SELECT 
              id, 
              name, 
              city, 
              state,
              (SELECT COUNT(*) FROM announcements WHERE building_id = buildings.id) as announcement_count
            FROM buildings 
            WHERE manager_id = $1 AND status = 'active'
            ORDER BY name
          `;
          params = [user.id];
        }

        const result = await client.query(query, params);

        res.json({
          success: true,
          data: result.rows.map((building) => ({
            id: building.id,
            name: building.name,
            location: `${building.city}, ${building.state}`,
            announcementCount: parseInt(building.announcement_count),
          })),
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // GET /api/announcements
  getAnnouncements = async (req, res, next) => {
    try {
      const { user } = req;
      const {
        page = 1,
        limit = 20,
        category,
        priority,
        building_id,
        status = "all",
        search,
      } = req.query;

      const accessibleBuildings = await this.getUserAccessibleBuildings(
        user.id,
        user.role
      );

      if (accessibleBuildings.length === 0) {
        return res.json({
          success: true,
          data: {
            announcements: [],
            pagination: {
              currentPage: parseInt(page),
              totalPages: 0,
              totalItems: 0,
              itemsPerPage: parseInt(limit),
              hasNextPage: false,
              hasPrevPage: false,
            },
          },
        });
      }

      const offset = (page - 1) * limit;
      const client = await pool.connect();

      try {
        // Build WHERE clause
        let whereConditions = [
          `a.building_id IN (${accessibleBuildings
            .map((_, i) => `$${i + 1}`)
            .join(",")})`,
        ];
        let queryParams = [...accessibleBuildings];
        let paramIndex = accessibleBuildings.length + 1;

        // Add status filter
        if (status !== "all") {
          if (status === "published") {
            whereConditions.push(
              `a.is_published = true AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)`
            );
          } else if (status === "draft") {
            whereConditions.push(`a.is_published = false`);
          } else if (status === "expired") {
            whereConditions.push(
              `a.expires_at IS NOT NULL AND a.expires_at <= CURRENT_TIMESTAMP`
            );
          }
        }

        // Add filters
        if (category) {
          whereConditions.push(`a.category = $${paramIndex}`);
          queryParams.push(category);
          paramIndex++;
        }

        if (priority) {
          whereConditions.push(`a.priority = $${paramIndex}`);
          queryParams.push(priority);
          paramIndex++;
        }

        if (building_id) {
          // Ensure the requested building is accessible to the user
          if (accessibleBuildings.includes(parseInt(building_id))) {
            whereConditions.push(`a.building_id = $${paramIndex}`);
            queryParams.push(building_id);
            paramIndex++;
          } else {
            return next(
              createError("FORBIDDEN", "Access denied to this building")
            );
          }
        }

        if (search) {
          whereConditions.push(
            `(LOWER(a.title) LIKE LOWER($${paramIndex}) OR LOWER(a.content) LIKE LOWER($${paramIndex}))`
          );
          queryParams.push(`%${search}%`);
          paramIndex++;
        }

        const whereClause = whereConditions.join(" AND ");

        // Main query
        const announcementsQuery = `
          SELECT 
            a.*,
            b.name as building_name,
            b.city as building_city,
            b.state as building_state,
            u.email as created_by_email,
            up.first_name as created_by_first_name,
            up.last_name as created_by_last_name,
            uu.email as updated_by_email,
            uup.first_name as updated_by_first_name,
            uup.last_name as updated_by_last_name,
            CASE 
              WHEN a.expires_at IS NOT NULL AND a.expires_at <= CURRENT_TIMESTAMP THEN 'expired'
              WHEN a.is_published = false THEN 'draft'
              WHEN a.is_published = true THEN 'published'
              ELSE 'draft'
            END as computed_status
          FROM announcements a
          JOIN buildings b ON a.building_id = b.id
          LEFT JOIN users u ON a.created_by = u.id
          LEFT JOIN user_profiles up ON u.id = up.user_id
          LEFT JOIN users uu ON a.updated_by = uu.id
          LEFT JOIN user_profiles uup ON uu.id = uup.user_id
          WHERE ${whereClause}
          ORDER BY 
            a.is_pinned DESC,
            CASE a.priority 
              WHEN 'urgent' THEN 1 
              WHEN 'high' THEN 2 
              WHEN 'normal' THEN 3 
              WHEN 'low' THEN 4 
            END,
            a.created_at DESC
          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;

        queryParams.push(limit, offset);
        const announcementsResult = await client.query(
          announcementsQuery,
          queryParams
        );

        // Get total count
        const countQuery = `
          SELECT COUNT(*) as total
          FROM announcements a
          JOIN buildings b ON a.building_id = b.id
          WHERE ${whereClause}
        `;

        const countResult = await client.query(
          countQuery,
          queryParams.slice(0, -2)
        );
        const total = parseInt(countResult.rows[0].total);

        // Process results
        const announcements = announcementsResult.rows.map((row) => ({
          id: row.id,
          title: row.title,
          content: row.content,
          category: row.category,
          priority: row.priority,
          announcementType: row.announcement_type,
          targetAudience: row.target_audience,
          targetFloorIds: row.target_floor_ids || [],
          targetRoomIds: row.target_room_ids || [],
          isPublished: row.is_published,
          isPinned: row.is_pinned,
          publishAt: row.publish_at,
          expiresAt: row.expires_at,
          acknowledgmentRequired: row.acknowledgment_required,
          attachments: row.attachments || [],
          externalLinks: row.external_links || [],
          viewCount: row.view_count,
          status: row.computed_status,
          building: {
            id: row.building_id,
            name: row.building_name,
            location: `${row.building_city}, ${row.building_state}`,
          },
          createdBy: row.created_by
            ? {
                email: row.created_by_email,
                name:
                  `${row.created_by_first_name || ""} ${
                    row.created_by_last_name || ""
                  }`.trim() || "Unknown",
              }
            : null,
          updatedBy: row.updated_by
            ? {
                email: row.updated_by_email,
                name:
                  `${row.updated_by_first_name || ""} ${
                    row.updated_by_last_name || ""
                  }`.trim() || "Unknown",
              }
            : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));

        res.json({
          success: true,
          data: {
            announcements,
            pagination: {
              currentPage: parseInt(page),
              totalPages: Math.ceil(total / parseInt(limit)),
              totalItems: total,
              itemsPerPage: parseInt(limit),
              hasNextPage: page * limit < total,
              hasPrevPage: page > 1,
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // GET /api/announcements/:id
  getAnnouncementById = async (req, res, next) => {
    try {
      const { user } = req;
      const { id } = req.params;

      const accessibleBuildings = await this.getUserAccessibleBuildings(
        user.id,
        user.role
      );
      if (accessibleBuildings.length === 0) {
        return next(createError("FORBIDDEN", "No accessible buildings"));
      }

      const client = await pool.connect();

      try {
        const placeholders = accessibleBuildings
          .map((_, i) => `$${i + 2}`)
          .join(",");

        const query = `
        SELECT 
          a.*,
          b.name as building_name,
          b.city as building_city,
          b.state as building_state,
          u.email as created_by_email,
          up.first_name as created_by_first_name,
          up.last_name as created_by_last_name,
          uu.email as updated_by_email,
          uup.first_name as updated_by_first_name,
          uup.last_name as updated_by_last_name,
          CASE 
            WHEN a.expires_at IS NOT NULL AND a.expires_at <= CURRENT_TIMESTAMP THEN 'expired'
            WHEN a.is_published = false THEN 'draft'
            WHEN a.is_published = true THEN 'published'
            ELSE 'draft'
          END as computed_status
        FROM announcements a
        JOIN buildings b ON a.building_id = b.id
        LEFT JOIN users u ON a.created_by = u.id
        LEFT JOIN user_profiles up ON u.id = up.user_id
        LEFT JOIN users uu ON a.updated_by = uu.id
        LEFT JOIN user_profiles uup ON uu.id = uup.user_id
        WHERE a.id = $1 AND a.building_id IN (${placeholders})
      `;

        const params = [id, ...accessibleBuildings];
        const result = await client.query(query, params);

        if (result.rows.length === 0) {
          return next(createError("NOT_FOUND", "Announcement not found"));
        }

        const row = result.rows[0];
        const announcement = {
          id: row.id,
          title: row.title,
          content: row.content,
          category: row.category,
          priority: row.priority,
          announcementType: row.announcement_type,
          targetAudience: row.target_audience,
          targetFloorIds: row.target_floor_ids || [],
          targetRoomIds: row.target_room_ids || [],
          isPublished: row.is_published,
          isPinned: row.is_pinned,
          publishAt: row.publish_at,
          expiresAt: row.expires_at,
          acknowledgmentRequired: row.acknowledgment_required,
          attachments: row.attachments || [],
          externalLinks: row.external_links || [],
          viewCount: row.view_count,
          status: row.computed_status,
          building: {
            id: row.building_id,
            name: row.building_name,
            location: `${row.building_city}, ${row.building_state}`,
          },
          createdBy: row.created_by
            ? {
                email: row.created_by_email,
                name:
                  `${row.created_by_first_name || ""} ${
                    row.created_by_last_name || ""
                  }`.trim() || "Unknown",
              }
            : null,
          updatedBy: row.updated_by
            ? {
                email: row.updated_by_email,
                name:
                  `${row.updated_by_first_name || ""} ${
                    row.updated_by_last_name || ""
                  }`.trim() || "Unknown",
              }
            : null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };

        res.json({
          success: true,
          data: announcement,
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // PUT /api/announcements/:id
  updateAnnouncement = async (req, res, next) => {
    try {
      const { user } = req;
      const { id } = req.params;
      const {
        title,
        content,
        building_id,
        category,
        priority,
        announcement_type,
        target_audience,
        target_floor_ids,
        target_room_ids,
        publish_at,
        expires_at,
        is_published,
        is_pinned,
        acknowledgment_required,
        external_links,
        remove_attachments = [],
      } = req.body;

      const accessibleBuildings = await this.getUserAccessibleBuildings(
        user.id,
        user.role
      );
      if (accessibleBuildings.length === 0) {
        return next(createError("FORBIDDEN", "No accessible buildings"));
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // First, verify the announcement exists and user has access
        const placeholders = accessibleBuildings
          .map((_, i) => `$${i + 2}`)
          .join(",");
        const checkQuery = `
          SELECT * FROM announcements 
          WHERE id = $1 AND building_id IN (${placeholders})
        `;
        const checkResult = await client.query(checkQuery, [
          id,
          ...accessibleBuildings,
        ]);

        if (checkResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("NOT_FOUND", "Announcement not found"));
        }

        const existingAnnouncement = checkResult.rows[0];

        // If building_id is being changed, verify access to new building
        if (
          building_id &&
          parseInt(building_id) !== existingAnnouncement.building_id
        ) {
          if (!accessibleBuildings.includes(parseInt(building_id))) {
            await client.query("ROLLBACK");
            return next(
              createError("FORBIDDEN", "Access denied to target building")
            );
          }
        }

        // Handle file uploads and removals
        let currentAttachments = existingAnnouncement.attachments || [];

        // Remove specified attachments
        if (remove_attachments.length > 0) {
          currentAttachments = currentAttachments.filter(
            (att) => !remove_attachments.includes(att)
          );

          // TODO: Actually delete files from filesystem
          // for (const filePath of remove_attachments) {
          //   try {
          //     await fs.unlink(path.join(process.cwd(), 'public', filePath));
          //   } catch (err) {
          //     console.log('Error deleting file:', err);
          //   }
          // }
        }

        // Add new attachments
        if (req.files && req.files.length > 0) {
          const newAttachments = req.files.map(
            (file) => `/uploads/announcements/${file.filename}`
          );
          currentAttachments = [...currentAttachments, ...newAttachments];
        }

        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];
        let paramIndex = 1;

        if (title !== undefined) {
          updateFields.push(`title = $${paramIndex}`);
          updateValues.push(title);
          paramIndex++;
        }

        if (content !== undefined) {
          updateFields.push(`content = $${paramIndex}`);
          updateValues.push(content);
          paramIndex++;
        }

        if (building_id !== undefined) {
          updateFields.push(`building_id = $${paramIndex}`);
          updateValues.push(building_id);
          paramIndex++;
        }

        if (category !== undefined) {
          updateFields.push(`category = $${paramIndex}`);
          updateValues.push(category);
          paramIndex++;
        }

        if (priority !== undefined) {
          updateFields.push(`priority = $${paramIndex}`);
          updateValues.push(priority);
          paramIndex++;
        }

        if (announcement_type !== undefined) {
          updateFields.push(`announcement_type = $${paramIndex}`);
          updateValues.push(announcement_type);
          paramIndex++;
        }

        if (target_audience !== undefined) {
          updateFields.push(`target_audience = $${paramIndex}`);
          updateValues.push(target_audience);
          paramIndex++;
        }

        if (target_floor_ids !== undefined) {
          updateFields.push(`target_floor_ids = $${paramIndex}`);
          updateValues.push(target_floor_ids);
          paramIndex++;
        }

        if (target_room_ids !== undefined) {
          updateFields.push(`target_room_ids = $${paramIndex}`);
          updateValues.push(target_room_ids);
          paramIndex++;
        }

        if (publish_at !== undefined) {
          updateFields.push(`publish_at = $${paramIndex}`);
          updateValues.push(publish_at || null);
          paramIndex++;
        }

        if (expires_at !== undefined) {
          updateFields.push(`expires_at = $${paramIndex}`);
          updateValues.push(expires_at || null);
          paramIndex++;
        }

        if (is_published !== undefined) {
          updateFields.push(`is_published = $${paramIndex}`);
          updateValues.push(is_published);
          paramIndex++;
        }

        if (is_pinned !== undefined) {
          updateFields.push(`is_pinned = $${paramIndex}`);
          updateValues.push(is_pinned);
          paramIndex++;
        }

        if (acknowledgment_required !== undefined) {
          updateFields.push(`acknowledgment_required = $${paramIndex}`);
          updateValues.push(acknowledgment_required);
          paramIndex++;
        }

        if (external_links !== undefined) {
          updateFields.push(`external_links = $${paramIndex}`);
          updateValues.push(external_links);
          paramIndex++;
        }

        // Always update attachments and metadata
        updateFields.push(`attachments = $${paramIndex}`);
        updateValues.push(currentAttachments);
        paramIndex++;

        updateFields.push(`updated_by = $${paramIndex}`);
        updateValues.push(user.id);
        paramIndex++;

        updateFields.push(`updated_at = CURRENT_TIMESTAMP`);

        // Add WHERE condition
        updateValues.push(id);
        const whereClause = `WHERE id = $${paramIndex}`;

        const updateQuery = `
          UPDATE announcements 
          SET ${updateFields.join(", ")}
          ${whereClause}
          RETURNING *
        `;

        const updateResult = await client.query(updateQuery, updateValues);
        const updatedAnnouncement = updateResult.rows[0];

        await client.query("COMMIT");

        res.json({
          success: true,
          message: "Announcement updated successfully",
          data: {
            id: updatedAnnouncement.id,
            title: updatedAnnouncement.title,
            content: updatedAnnouncement.content,
            category: updatedAnnouncement.category,
            priority: updatedAnnouncement.priority,
            announcementType: updatedAnnouncement.announcement_type,
            isPublished: updatedAnnouncement.is_published,
            isPinned: updatedAnnouncement.is_pinned,
            buildingId: updatedAnnouncement.building_id,
            attachments: updatedAnnouncement.attachments || [],
            updatedAt: updatedAnnouncement.updated_at,
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
  };

  // DELETE /api/announcements/:id
  deleteAnnouncement = async (req, res, next) => {
    try {
      const { user } = req;
      const { id } = req.params;

      const accessibleBuildings = await this.getUserAccessibleBuildings(
        user.id,
        user.role
      );
      if (accessibleBuildings.length === 0) {
        return next(createError("FORBIDDEN", "No accessible buildings"));
      }

      const client = await pool.connect();

      try {
        // First, get the announcement to check access and get attachments
        const placeholders = accessibleBuildings
          .map((_, i) => `$${i + 2}`)
          .join(",");
        const selectQuery = `
          SELECT attachments FROM announcements 
          WHERE id = $1 AND building_id IN (${placeholders})
        `;
        const selectResult = await client.query(selectQuery, [
          id,
          ...accessibleBuildings,
        ]);

        if (selectResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Announcement not found"));
        }

        const attachments = selectResult.rows[0].attachments || [];

        // Delete the announcement
        const deleteQuery = `DELETE FROM announcements WHERE id = $1`;
        await client.query(deleteQuery, [id]);

        // TODO: Delete associated files
        // for (const filePath of attachments) {
        //   try {
        //     await fs.unlink(path.join(process.cwd(), 'public', filePath));
        //   } catch (err) {
        //     console.log('Error deleting file:', err);
        //   }
        // }

        res.json({
          success: true,
          message: "Announcement deleted successfully",
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // POST /api/announcements/:id/publish
  togglePublishStatus = async (req, res, next) => {
    try {
      const { user } = req;
      const { id } = req.params;
      const { is_published } = req.body;

      const accessibleBuildings = await this.getUserAccessibleBuildings(
        user.id,
        user.role
      );
      if (accessibleBuildings.length === 0) {
        return next(createError("FORBIDDEN", "No accessible buildings"));
      }

      const client = await pool.connect();

      try {
        const placeholders = accessibleBuildings
          .map((_, i) => `$${i + 4}`)
          .join(",");

        const updateQuery = `
          UPDATE announcements 
          SET is_published = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $3 AND building_id IN (${placeholders})
          RETURNING id, title, is_published
        `;

        const params = [is_published, user.id, id, ...accessibleBuildings];
        const result = await client.query(updateQuery, params);

        if (result.rows.length === 0) {
          return next(createError("NOT_FOUND", "Announcement not found"));
        }

        const announcement = result.rows[0];

        res.json({
          success: true,
          message: `Announcement ${
            is_published ? "published" : "unpublished"
          } successfully`,
          data: {
            id: announcement.id,
            title: announcement.title,
            isPublished: announcement.is_published,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };

  // POST /api/announcements/:id/pin
  togglePinStatus = async (req, res, next) => {
    try {
      const { user } = req;
      const { id } = req.params;
      const { is_pinned } = req.body;

      const accessibleBuildings = await this.getUserAccessibleBuildings(
        user.id,
        user.role
      );
      if (accessibleBuildings.length === 0) {
        return next(createError("FORBIDDEN", "No accessible buildings"));
      }

      const client = await pool.connect();

      try {
        const placeholders = accessibleBuildings
          .map((_, i) => `$${i + 4}`)
          .join(",");

        const updateQuery = `
          UPDATE announcements 
          SET is_pinned = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $3 AND building_id IN (${placeholders})
          RETURNING id, title, is_pinned
        `;

        const params = [is_pinned, user.id, id, ...accessibleBuildings];
        const result = await client.query(updateQuery, params);

        if (result.rows.length === 0) {
          return next(createError("NOT_FOUND", "Announcement not found"));
        }

        const announcement = result.rows[0];

        res.json({
          success: true,
          message: `Announcement ${
            is_pinned ? "pinned" : "unpinned"
          } successfully`,
          data: {
            id: announcement.id,
            title: announcement.title,
            isPinned: announcement.is_pinned,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  };
}

export default new AnnouncementsController();
