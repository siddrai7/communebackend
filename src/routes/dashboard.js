// src/routes/dashboard.js
import express from "express";
import { query, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import { createError } from "../utils/errorHandler.js";
import DashboardController from "../controllers/dashboardController.js";

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
 * GET /api/dashboard/overview
 * Get role-based dashboard overview data
 */
router.get(
  "/overview",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
    query("period")
      .optional()
      .isIn(["today", "week", "month", "quarter", "year"])
      .withMessage("Period must be one of: today, week, month, quarter, year"),
  ],
  handleValidationErrors,
  DashboardController.getOverview
);

/**
 * GET /api/dashboard/stats
 * Get key performance indicators and statistics
 */
router.get(
  "/stats",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
    query("month")
      .optional()
      .isInt({ min: 1, max: 12 })
      .withMessage("Month must be between 1 and 12"),
    query("year")
      .optional()
      .isInt({ min: 2020, max: 2030 })
      .withMessage("Year must be between 2020 and 2030"),
  ],
  handleValidationErrors,
  DashboardController.getStats
);

/**
 * GET /api/dashboard/recent-activity
 * Get recent system activities based on user role
 */
router.get(
  "/recent-activity",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("limit")
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage("Limit must be between 1 and 50"),
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
  ],
  handleValidationErrors,
  DashboardController.getRecentActivity
);

/**
 * GET /api/dashboard/alerts
 * Get role-based alerts and notifications
 */
router.get(
  "/alerts",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("priority")
      .optional()
      .isIn(["low", "medium", "high", "urgent"])
      .withMessage("Priority must be one of: low, medium, high, urgent"),
    query("category")
      .optional()
      .isIn(["rent", "maintenance", "complaints", "leads", "system"])
      .withMessage("Category must be one of: rent, maintenance, complaints, leads, system"),
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
  ],
  handleValidationErrors,
  DashboardController.getAlerts
);

/**
 * GET /api/dashboard/financial-summary
 * Get financial overview - admin/superadmin focused
 */
router.get(
  "/financial-summary",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("period")
      .optional()
      .isIn(["month", "quarter", "year"])
      .withMessage("Period must be one of: month, quarter, year"),
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
  ],
  handleValidationErrors,
  DashboardController.getFinancialSummary
);

/**
 * GET /api/dashboard/operational-metrics
 * Get operational metrics - manager focused
 */
router.get(
  "/operational-metrics",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
    query("timeframe")
      .optional()
      .isIn(["7d", "30d", "90d"])
      .withMessage("Timeframe must be one of: 7d, 30d, 90d"),
  ],
  handleValidationErrors,
  DashboardController.getOperationalMetrics
);

export default router;