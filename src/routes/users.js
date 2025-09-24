// src/routes/users.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import { createError } from "../utils/errorHandler.js";
import UsersController from "../controllers/usersController.js";

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
 * POST /api/users
 * Create new user
 */
router.post(
  "/",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    body("email")
      .isEmail()
      .withMessage("Please provide a valid email address")
      .normalizeEmail(),
    body("role")
      .isIn(Object.values(ROLES))
      .withMessage("Invalid role specified"),
    body("status")
      .optional()
      .isIn(["active", "inactive", "suspended"])
      .withMessage("Invalid status specified"),
    body("first_name")
      .notEmpty()
      .withMessage("First name is required")
      .isLength({ min: 2, max: 50 })
      .withMessage("First name must be between 2 and 50 characters"),
    body("last_name")
      .notEmpty()
      .withMessage("Last name is required")
      .isLength({ min: 2, max: 50 })
      .withMessage("Last name must be between 2 and 50 characters"),
    body("phone")
      .optional()
      .isMobilePhone()
      .withMessage("Please provide a valid phone number"),
    body("date_of_birth")
      .optional()
      .isISO8601()
      .withMessage("Please provide a valid date of birth"),
    body("gender")
      .optional()
      .isIn(["male", "female", "other"])
      .withMessage("Gender must be male, female, or other"),
  ],
  handleValidationErrors,
  UsersController.createUser
);

/**
 * GET /api/users
 * Get all users with filters, search, and pagination
 */
router.get(
  "/",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("search")
      .optional()
      .isLength({ min: 2, max: 100 })
      .withMessage("Search term must be between 2 and 100 characters"),
    query("role")
      .optional()
      .isIn(Object.values(ROLES))
      .withMessage("Invalid role specified"),
    query("status")
      .optional()
      .isIn(["active", "inactive", "suspended"])
      .withMessage("Invalid status specified"),
    query("sortBy")
      .optional()
      .isIn([
        "created_at",
        "email",
        "role",
        "status",
        "last_login",
        "first_name",
      ])
      .withMessage("Invalid sort field"),
    query("sortOrder")
      .optional()
      .isIn(["asc", "desc"])
      .withMessage("Sort order must be asc or desc"),
    query("hasProfile")
      .optional()
      .isIn(["true", "false"])
      .withMessage("hasProfile must be true or false"),
    query("dateFrom")
      .optional()
      .isISO8601()
      .withMessage("dateFrom must be a valid date"),
    query("dateTo")
      .optional()
      .isISO8601()
      .withMessage("dateTo must be a valid date"),
  ],
  handleValidationErrors,
  UsersController.getAllUsers
);

/**
 * GET /api/users/stats
 * Get user statistics
 */
router.get(
  "/stats",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  UsersController.getUserStats
);

/**
 * GET /api/users/export
 * Export users to CSV/Excel
 */
router.get(
  "/export",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    query("format")
      .optional()
      .isIn(["csv", "excel"])
      .withMessage("Format must be csv or excel"),
    query("role")
      .optional()
      .isIn(Object.values(ROLES))
      .withMessage("Invalid role specified"),
    query("status")
      .optional()
      .isIn(["active", "inactive", "suspended"])
      .withMessage("Invalid status specified"),
  ],
  handleValidationErrors,
  UsersController.exportUsers
);

/**
 * GET /api/users/:id
 * Get specific user details with complete profile
 */
router.get(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("User ID must be a positive integer"),
  ],
  handleValidationErrors,
  UsersController.getUserById
);

/**
 * PUT /api/users/:id
 * Update user and profile
 */
router.put(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("User ID must be a positive integer"),
    body("role")
      .optional()
      .isIn(Object.values(ROLES))
      .withMessage("Invalid role specified"),
    body("status")
      .optional()
      .isIn(["active", "inactive", "suspended"])
      .withMessage("Invalid status specified"),
    body("first_name")
      .optional()
      .isLength({ min: 2, max: 50 })
      .withMessage("First name must be between 2 and 50 characters"),
    body("last_name")
      .optional()
      .isLength({ min: 2, max: 50 })
      .withMessage("Last name must be between 2 and 50 characters"),
    body("phone")
      .optional()
      .isMobilePhone()
      .withMessage("Please provide a valid phone number"),
    body("date_of_birth")
      .optional()
      .isISO8601()
      .withMessage("Please provide a valid date of birth"),
    body("gender")
      .optional()
      .isIn(["male", "female", "other"])
      .withMessage("Gender must be male, female, or other"),
  ],
  handleValidationErrors,
  UsersController.updateUser
);

/**
 * PUT /api/users/:id/status
 * Update user status (activate, deactivate, suspend)
 */
router.put(
  "/:id/status",
  authorize(ROLES.SUPER_ADMIN),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("User ID must be a positive integer"),
    body("status")
      .isIn(["active", "inactive", "suspended"])
      .withMessage("Status must be active, inactive, or suspended"),
    body("reason")
      .optional()
      .isLength({ min: 5, max: 500 })
      .withMessage("Reason must be between 5 and 500 characters"),
  ],
  handleValidationErrors,
  UsersController.updateUserStatus
);

/**
 * PUT /api/users/:id/role
 * Update user role (Super Admin only)
 */
router.put(
  "/:id/role",
  authorize(ROLES.SUPER_ADMIN),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("User ID must be a positive integer"),
    body("role")
      .isIn(Object.values(ROLES))
      .withMessage("Invalid role specified"),
    body("reason")
      .optional()
      .isLength({ min: 5, max: 500 })
      .withMessage("Reason must be between 5 and 500 characters"),
  ],
  handleValidationErrors,
  UsersController.updateUserRole
);

/**
 * POST /api/users/bulk-update
 * Bulk update user statuses
 */
router.post(
  "/bulk-update",
  authorize(ROLES.SUPER_ADMIN),
  [
    body("userIds")
      .isArray({ min: 1 })
      .withMessage("userIds must be a non-empty array"),
    body("userIds.*")
      .isInt({ min: 1 })
      .withMessage("Each user ID must be a positive integer"),
    body("action")
      .isIn(["activate", "deactivate", "suspend"])
      .withMessage("Action must be activate, deactivate, or suspend"),
    body("reason")
      .optional()
      .isLength({ min: 5, max: 500 })
      .withMessage("Reason must be between 5 and 500 characters"),
  ],
  handleValidationErrors,
  UsersController.bulkUpdateUsers
);

/**
 * GET /api/users/:id/tenancy
 * Get tenant's tenancy information (for tenant users only)
 */
router.get(
  "/:id/tenancy",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("User ID must be a positive integer"),
  ],
  handleValidationErrors,
  UsersController.getUserTenancy
);

/**
 * GET /api/users/:id/payments
 * Get tenant's payment history (for tenant users only)
 */
router.get(
  "/:id/payments",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("User ID must be a positive integer"),
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
      .isIn(["pending", "paid", "overdue", "partial", "failed"])
      .withMessage("Invalid payment status"),
    query("type")
      .optional()
      .isIn([
        "rent",
        "security_deposit",
        "maintenance",
        "utility",
        "late_fee",
        "other",
      ])
      .withMessage("Invalid payment type"),
  ],
  handleValidationErrors,
  UsersController.getUserPayments
);

/**
 * GET /api/users/:id/activity
 * Get user activity logs
 */
router.get(
  "/:id/activity",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("User ID must be a positive integer"),
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
  ],
  handleValidationErrors,
  UsersController.getUserActivity
);

/**
 * POST /api/users/:id/send-notification
 * Send notification to user
 */
router.post(
  "/:id/send-notification",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("User ID must be a positive integer"),
    body("subject")
      .isLength({ min: 5, max: 200 })
      .withMessage("Subject must be between 5 and 200 characters"),
    body("message")
      .isLength({ min: 10, max: 1000 })
      .withMessage("Message must be between 10 and 1000 characters"),
    body("type")
      .optional()
      .isIn(["email", "sms", "both"])
      .withMessage("Type must be email, sms, or both"),
  ],
  handleValidationErrors,
  UsersController.sendNotificationToUser
);

export default router;
