// src/routes/announcements.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import upload from "../middleware/upload.js";
import { createError } from "../utils/errorHandler.js";
import AnnouncementsController from "../controllers/announcementsController.js";

const router = express.Router();

// Apply authentication to all routes
router.use(authenticate);

// Validation middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessage = errors.array()[0].msg;
    return next(createError("VALIDATION_ERROR", errorMessage));
  }
  next();
};

/**
 * GET /api/announcements/stats
 * Get announcement statistics
 */
router.get(
  "/stats",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  AnnouncementsController.getAnnouncementStats
);

/**
 * GET /api/announcements/buildings
 * Get buildings list for announcement creation (based on user role)
 */
router.get(
  "/buildings",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  AnnouncementsController.getBuildingsForAnnouncements
);

/**
 * GET /api/announcements
 * Get all announcements with filtering
 */
router.get(
  "/",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("category")
      .optional()
      .isIn([
        "maintenance",
        "event",
        "policy",
        "emergency",
        "billing",
        "amenity",
        "general",
      ])
      .withMessage("Invalid category"),
    query("priority")
      .optional()
      .isIn(["low", "normal", "high", "urgent"])
      .withMessage("Invalid priority"),
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
    query("status")
      .optional()
      .isIn(["published", "draft", "expired", "all"])
      .withMessage("Invalid status"),
    query("search")
      .optional()
      .isLength({ max: 255 })
      .withMessage("Search query too long"),
  ],
  handleValidationErrors,
  AnnouncementsController.getAnnouncements
);

/**
 * POST /api/announcements
 * Create new announcement
 */
router.post(
  "/",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  upload.array("attachments", 5), // Allow up to 5 attachments
  [
    body("title")
      .notEmpty()
      .withMessage("Title is required")
      .isLength({ max: 200 })
      .withMessage("Title must be less than 200 characters"),
    body("content")
      .notEmpty()
      .withMessage("Content is required")
      .isLength({ max: 5000 })
      .withMessage("Content must be less than 5000 characters"),
    body("building_id")
      .isInt()
      .withMessage("Building ID is required and must be a valid integer"),
    body("category")
      .isIn([
        "maintenance",
        "event",
        "policy",
        "emergency",
        "billing",
        "amenity",
        "general",
      ])
      .withMessage("Invalid category"),
    body("priority")
      .optional()
      .isIn(["low", "normal", "high", "urgent"])
      .withMessage("Invalid priority"),
    body("announcement_type")
      .optional()
      .isIn(["info", "warning", "success", "error"])
      .withMessage("Invalid announcement type"),
    body("target_audience")
      .optional()
      .isIn([
        "all_tenants",
        "specific_floors",
        "specific_rooms",
        "all_residents",
      ])
      .withMessage("Invalid target audience"),
    // body("target_floor_ids")
    //   .optional()
    //   .isArray()
    //   .withMessage("Target floor IDs must be an array"),
    // body("target_room_ids")
    //   .optional()
    //   .isArray()
    //   .withMessage("Target room IDs must be an array"),
    body("publish_at")
      .optional()
      .isISO8601()
      .withMessage("Publish date must be a valid ISO8601 date"),
    body("expires_at")
      .optional()
      .isISO8601()
      .withMessage("Expiry date must be a valid ISO8601 date"),
    body("is_published")
      .optional()
      .isBoolean()
      .withMessage("Is published must be a boolean"),
    body("is_pinned")
      .optional()
      .isBoolean()
      .withMessage("Is pinned must be a boolean"),
    body("acknowledgment_required")
      .optional()
      .isBoolean()
      .withMessage("Acknowledgment required must be a boolean"),
    body("external_links")
      .optional()
      .isArray()
      .withMessage("External links must be an array"),
  ],
  handleValidationErrors,
  AnnouncementsController.createAnnouncement
);

/**
 * GET /api/announcements/:id
 * Get single announcement details
 */
router.get(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [param("id").isInt().withMessage("Announcement ID must be a valid integer")],
  handleValidationErrors,
  AnnouncementsController.getAnnouncementById
);

/**
 * PUT /api/announcements/:id
 * Update existing announcement
 */
router.put(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  upload.array("attachments", 5),
  [
    param("id").isInt().withMessage("Announcement ID must be a valid integer"),
    body("title")
      .optional()
      .isLength({ max: 200 })
      .withMessage("Title must be less than 200 characters"),
    body("content")
      .optional()
      .isLength({ max: 5000 })
      .withMessage("Content must be less than 5000 characters"),
    body("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
    body("category")
      .optional()
      .isIn([
        "maintenance",
        "event",
        "policy",
        "emergency",
        "billing",
        "amenity",
        "general",
      ])
      .withMessage("Invalid category"),
    body("priority")
      .optional()
      .isIn(["low", "normal", "high", "urgent"])
      .withMessage("Invalid priority"),
    body("announcement_type")
      .optional()
      .isIn(["info", "warning", "success", "error"])
      .withMessage("Invalid announcement type"),
    body("target_audience")
      .optional()
      .isIn([
        "all_tenants",
        "specific_floors",
        "specific_rooms",
        "all_residents",
      ])
      .withMessage("Invalid target audience"),
    body("target_floor_ids")
      .optional()
      .isArray()
      .withMessage("Target floor IDs must be an array"),
    body("target_room_ids")
      .optional()
      .isArray()
      .withMessage("Target room IDs must be an array"),
    body("publish_at")
      .optional()
      .isISO8601()
      .withMessage("Publish date must be a valid ISO8601 date"),
    body("expires_at")
      .optional()
      .isISO8601()
      .withMessage("Expiry date must be a valid ISO8601 date"),
    body("is_published")
      .optional()
      .isBoolean()
      .withMessage("Is published must be a boolean"),
    body("is_pinned")
      .optional()
      .isBoolean()
      .withMessage("Is pinned must be a boolean"),
    body("acknowledgment_required")
      .optional()
      .isBoolean()
      .withMessage("Acknowledgment required must be a boolean"),
    body("external_links")
      .optional()
      .isArray()
      .withMessage("External links must be an array"),
    body("remove_attachments")
      .optional()
      .isArray()
      .withMessage("Remove attachments must be an array of file paths"),
  ],
  handleValidationErrors,
  AnnouncementsController.updateAnnouncement
);

/**
 * DELETE /api/announcements/:id
 * Delete announcement
 */
router.delete(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [param("id").isInt().withMessage("Announcement ID must be a valid integer")],
  handleValidationErrors,
  AnnouncementsController.deleteAnnouncement
);

/**
 * POST /api/announcements/:id/publish
 * Publish/unpublish announcement
 */
router.post(
  "/:id/publish",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt().withMessage("Announcement ID must be a valid integer"),
    body("is_published")
      .isBoolean()
      .withMessage("Is published must be a boolean"),
  ],
  handleValidationErrors,
  AnnouncementsController.togglePublishStatus
);

/**
 * POST /api/announcements/:id/pin
 * Pin/unpin announcement
 */
router.post(
  "/:id/pin",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt().withMessage("Announcement ID must be a valid integer"),
    body("is_pinned").isBoolean().withMessage("Is pinned must be a boolean"),
  ],
  handleValidationErrors,
  AnnouncementsController.togglePinStatus
);

export default router;
