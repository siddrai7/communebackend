// src/routes/jobsRoutes.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import { createError } from "../utils/errorHandler.js";
import jobsController from "../controllers/jobsController.js";

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
 * GET /api/admin/jobs/status
 * Get current status of job scheduler and recent logs
 */
router.get(
  "/status",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  jobsController.getJobsStatus
);

/**
 * GET /api/admin/jobs/logs
 * Get paginated job execution logs
 */
router.get(
  "/logs",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 200 })
      .withMessage("Limit must be between 1 and 200"),
    query("jobName")
      .optional()
      .isLength({ max: 100 })
      .withMessage("Job name too long"),
    query("status")
      .optional()
      .isIn(["running", "completed", "failed"])
      .withMessage("Invalid status"),
  ],
  handleValidationErrors,
  jobsController.getJobLogs
);

/**
 * POST /api/admin/jobs/trigger
 * Manually trigger a scheduled job
 */
router.post(
  "/trigger",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    body("jobName")
      .notEmpty()
      .isLength({ max: 100 })
      .withMessage("Valid job name is required"),
  ],
  handleValidationErrors,
  jobsController.triggerJob
);

/**
 * GET /api/admin/jobs/summary
 * Get jobs summary and statistics
 */
router.get(
  "/summary",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  jobsController.getJobsSummary
);

/**
 * DELETE /api/admin/jobs/logs/:logId
 * Delete a specific job log
 */
router.delete(
  "/logs/:logId",
  authorize(ROLES.SUPER_ADMIN),
  [param("logId").isInt({ min: 1 }).withMessage("Invalid log ID")],
  handleValidationErrors,
  jobsController.deleteJobLog
);

/**
 * POST /api/admin/jobs/cleanup-logs
 * Cleanup old job logs
 */
router.post(
  "/cleanup-logs",
  authorize(ROLES.SUPER_ADMIN),
  [
    body("olderThanDays")
      .optional()
      .isInt({ min: 1, max: 365 })
      .withMessage("Days must be between 1 and 365"),
  ],
  handleValidationErrors,
  jobsController.cleanupLogs
);

export default router;
