// src/routes/complaints.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import upload from "../middleware/upload.js";
import { createError } from "../utils/errorHandler.js";
import ComplaintsController from "../controllers/complaintsController.js";

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
 * GET /api/complaints
 * Get all complaints with filters and pagination
 */
router.get(
  "/",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  //   [
  //     query("page")
  //       .optional()
  //       .isInt({ min: 1 })
  //       .withMessage("Page must be a positive integer"),
  //     query("limit")
  //       .optional()
  //       .isInt({ min: 1, max: 100 })
  //       .withMessage("Limit must be between 1 and 100"),
  //     query("status")
  //       .optional()
  //       .isIn([
  //         "submitted",
  //         "acknowledged",
  //         "in_progress",
  //         "resolved",
  //         "closed",
  //         "rejected",
  //       ])
  //       .withMessage("Invalid status"),
  //     query("category")
  //       .optional()
  //       .isString()
  //       .withMessage("Category must be a string"),
  //     query("priority")
  //       .optional()
  //       .isIn(["low", "medium", "high", "urgent"])
  //       .withMessage("Invalid priority"),
  //     query("building_id")
  //       .optional()
  //       .isInt()
  //       .withMessage("Building ID must be a valid integer"),
  //     query("assigned_to")
  //       .optional()
  //       .isInt()
  //       .withMessage("Assigned to must be a valid user ID"),
  //     query("date_from")
  //       .optional()
  //       .custom((value) => {
  //         if (value === "" || value === null || value === undefined) {
  //           return true; // Allow empty values
  //         }
  //         return !isNaN(Date.parse(value));
  //       })
  //       .withMessage("Date from must be a valid date"),
  //     query("date_to")
  //       .optional()
  //       .custom((value) => {
  //         if (value === "" || value === null || value === undefined) {
  //           return true; // Allow empty values
  //         }
  //         return !isNaN(Date.parse(value));
  //       })
  //       .withMessage("Date to must be a valid date"),
  //     query("search")
  //       .optional()
  //       .custom((value) => {
  //         if (value === "" || value === null || value === undefined) {
  //           return true; // Allow empty values
  //         }
  //         return typeof value === "string" && value.length <= 200;
  //       })
  //       .withMessage("Search term must be less than 200 characters"),
  //   ],
  //   handleValidationErrors,
  ComplaintsController.getComplaints
);

/**
 * GET /api/complaints/buildings
 * Get buildings accessible to current user with complaint counts
 */
router.get(
  "/buildings",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  ComplaintsController.getBuildings
);

/**
 * GET /api/complaints/stats
 * Get complaints statistics and dashboard data
 */
router.get(
  "/stats",
  //   authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  //   [
  //     query("building_id")
  //       .optional()
  //       .isInt()
  //       .withMessage("Building ID must be a valid integer"),
  //     query("period")
  //       .optional()
  //       .isIn(["7days", "30days", "90days", "6months", "1year"])
  //       .withMessage("Invalid period"),
  //   ],
  //   handleValidationErrors,
  ComplaintsController.getComplaintsStats
);

/**
 * GET /api/complaints/categories
 * Get complaint categories with counts
 */
router.get(
  "/categories",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
  ],
  handleValidationErrors,
  ComplaintsController.getComplaintCategories
);

/**
 * GET /api/complaints/:id
 * Get complaint details by ID
 */
router.get(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [param("id").isInt().withMessage("Complaint ID must be a valid integer")],
  handleValidationErrors,
  ComplaintsController.getComplaintById
);

/**
 * PUT /api/complaints/:id/status
 * Update complaint status and add resolution notes
 */
router.put(
  "/:id/status",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  upload.array("resolution_attachments", 5), // Allow up to 5 files
  [
    param("id").isInt().withMessage("Complaint ID must be a valid integer"),
    body("status")
      .isIn(["acknowledged", "in_progress", "resolved", "closed", "rejected"])
      .withMessage("Invalid status"),
    body("resolution_notes")
      .optional()
      .isString()
      .isLength({ max: 2000 })
      .withMessage("Resolution notes must be less than 2000 characters"),
    body("estimated_resolution_time")
      .optional()
      .isInt({ min: 1 })
      .withMessage(
        "Estimated resolution time must be a positive integer (hours)"
      ),
    body("cost_incurred")
      .optional()
      .isNumeric()
      .withMessage("Cost incurred must be a valid number"),
  ],
  handleValidationErrors,
  ComplaintsController.updateComplaintStatus
);

/**
 * POST /api/complaints/:id/activity
 * Add activity/note to complaint
 */
router.post(
  "/:id/activity",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  upload.array("attachments", 3), // Allow up to 3 files for activities
  [
    param("id").isInt().withMessage("Complaint ID must be a valid integer"),
    body("activity_type")
      .isIn(["status_change", "assignment", "note", "resolution", "feedback"])
      .withMessage("Invalid activity type"),
    body("description")
      .notEmpty()
      .isString()
      .isLength({ max: 1000 })
      .withMessage(
        "Description is required and must be less than 1000 characters"
      ),
    body("internal_notes")
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage("Internal notes must be less than 500 characters"),
  ],
  handleValidationErrors,
  ComplaintsController.addComplaintActivity
);

export default router;
