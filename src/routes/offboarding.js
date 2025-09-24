// src/routes/offboarding.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import { createError } from "../utils/errorHandler.js";
import OffboardingController from "../controllers/offboardingController.js";

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
 * GET /api/offboarding
 * Get all offboarding requests with filters and pagination
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
    query("status")
      .optional()
      .isIn(["initiated", "pending_clearance", "completed"])
      .withMessage("Invalid offboarding status"),
    query("building_id")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Building ID must be a positive integer"),
    query("date_from")
      .optional()
      .isISO8601()
      .withMessage("Date from must be a valid ISO date"),
    query("date_to")
      .optional()
      .isISO8601()
      .withMessage("Date to must be a valid ISO date"),
    query("search")
      .optional()
      .trim()
      .isLength({ max: 255 })
      .withMessage("Search query cannot exceed 255 characters"),
    query("sortBy")
      .optional()
      .isIn([
        "offboarding_initiated_at",
        "intended_move_out_date",
        "offboarding_status",
        "tenant_name",
        "building_name",
      ])
      .withMessage("Invalid sort field"),
    query("sortOrder")
      .optional()
      .isIn(["asc", "desc"])
      .withMessage("Sort order must be asc or desc"),
  ],
  handleValidationErrors,
  OffboardingController.getAllOffboardingRequests
);

/**
 * GET /api/offboarding/stats
 * Get offboarding statistics
 */
router.get(
  "/stats",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  OffboardingController.getOffboardingStats
);

/**
 * GET /api/offboarding/:id
 * Get specific offboarding request details
 */
router.get(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [param("id").isInt({ min: 1 }).withMessage("Invalid offboarding request ID")],
  handleValidationErrors,
  OffboardingController.getOffboardingRequest
);

/**
 * POST /api/offboarding/initiate
 * Admin initiate offboarding for any tenant
 */
router.post(
  "/initiate",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    body("tenantUserId")
      .isInt({ min: 1 })
      .withMessage("Tenant user ID must be a positive integer"),
    body("reason")
      .trim()
      .notEmpty()
      .isLength({ min: 10, max: 500 })
      .withMessage("Reason must be between 10 and 500 characters"),
    body("moveOutDate")
      .isISO8601()
      .withMessage("Please provide a valid move-out date")
      .custom((value) => {
        const moveOutDate = new Date(value);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (moveOutDate < today) {
          throw new Error("Move-out date cannot be in the past");
        }
        
        // Admin can set any future date, no 30-day restriction
        return true;
      }),
  ],
  handleValidationErrors,
  OffboardingController.initiateOffboardingByAdmin
);

/**
 * PUT /api/offboarding/:id/status
 * Update offboarding status and details
 */
router.put(
  "/:id/status",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt({ min: 1 }).withMessage("Invalid offboarding request ID"),
    body("status")
      .optional()
      .isIn(["initiated", "pending_clearance", "completed"])
      .withMessage("Invalid offboarding status"),
    body("actualMoveOutDate")
      .optional()
      .isISO8601()
      .withMessage("Actual move-out date must be a valid ISO date"),
    body("finalDues")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Final dues must be a non-negative number"),
    body("depositRefundAmount")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Deposit refund amount must be a non-negative number"),
    body("depositRefundStatus")
      .optional()
      .isIn(["pending", "processed", "complete"])
      .withMessage("Invalid deposit refund status"),
    body("adminNotes")
      .optional()
      .trim()
      .isLength({ max: 1000 })
      .withMessage("Admin notes cannot exceed 1000 characters"),
  ],
  handleValidationErrors,
  OffboardingController.updateOffboardingStatus
);

export default router;