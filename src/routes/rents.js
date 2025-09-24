// src/routes/rents.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import upload from "../middleware/upload.js";
import { createError } from "../utils/errorHandler.js";
import RentController from "../controllers/rentController.js";

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
 * GET /api/rent-collection/overview
 * Get rent collection overview/dashboard data with building-wise breakdown
 */
router.get(
  "/overview",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("month")
      .optional()
      .isInt({ min: 1, max: 12 })
      .withMessage("Month must be between 1 and 12"),
    query("year")
      .optional()
      .isInt({ min: 2020, max: 2030 })
      .withMessage("Year must be between 2020 and 2030"),
    // query("building_id")
    //   .optional()
    //   .isInt()
    //   .withMessage("Building ID must be a valid integer"),
  ],
  handleValidationErrors,
  RentController.getOverview
);

/**
 * GET /api/rent-collection/payments
 * Get paginated list of rent payments with comprehensive filters
 */
router.get(
  "/payments",
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
      .isIn(["pending", "paid", "overdue", "partial", "failed"])
      .withMessage("Invalid payment status"),
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
    query("start_date")
      .optional()
      .isISO8601()
      .withMessage("Start date must be in ISO format (YYYY-MM-DD)"),
    query("end_date")
      .optional()
      .isISO8601()
      .withMessage("End date must be in ISO format (YYYY-MM-DD)"),
    query("tenant_search")
      .optional()
      .isLength({ min: 2, max: 100 })
      .withMessage("Tenant search must be between 2 and 100 characters"),
    query("overdue_only")
      .optional()
      .isBoolean()
      .withMessage("Overdue only must be true or false"),
    query("sort_by")
      .optional()
      .isIn(["due_date", "amount", "tenant_name", "unit_number", "status"])
      .withMessage("Invalid sort field"),
    query("sort_order")
      .optional()
      .isIn(["asc", "desc"])
      .withMessage("Sort order must be asc or desc"),
  ],
  handleValidationErrors,
  RentController.getPayments
);

/**
 * PUT /api/rent-collection/payments/:paymentId
 * Update payment status and upload receipts
 */
router.put(
  "/payments/:paymentId",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  upload.array("receipts", 5), // Allow up to 5 receipt files
  [
    param("paymentId")
      .isInt()
      .withMessage("Payment ID must be a valid integer"),
    body("status")
      .optional()
      .isIn(["pending", "paid", "overdue", "partial", "failed"])
      .withMessage("Invalid payment status"),
    body("paid_amount")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Paid amount must be a positive number"),
    body("payment_date")
      .optional()
      .isISO8601()
      .withMessage("Payment date must be in ISO format"),
    body("payment_method")
      .optional()
      .isIn(["cash", "bank_transfer", "upi", "card", "cheque"])
      .withMessage("Invalid payment method"),
    body("transaction_id")
      .optional()
      .isLength({ max: 100 })
      .withMessage("Transaction ID must not exceed 100 characters"),
    body("late_fee")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Late fee must be a positive number"),
    body("notes")
      .optional()
      .isLength({ max: 500 })
      .withMessage("Notes must not exceed 500 characters"),
  ],
  handleValidationErrors,
  RentController.updatePayment
);

/**
 * GET /api/rent-collection/overdue
 * Get overdue payments with aging analysis
 */
router.get(
  "/overdue",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    // query("building_id")
    //   .optional()
    //   .isInt()
    //   .withMessage("Building ID must be a valid integer"),
    query("days_overdue")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Days overdue must be a positive integer"),
    query("sort_by")
      .optional()
      .isIn(["due_date", "days_overdue", "amount", "tenant_name", "unit_number"])
      .withMessage("Invalid sort field"),
  ],
  handleValidationErrors,
  RentController.getOverduePayments
);

/**
 * GET /api/rent-collection/tenant/:tenantId/history
 * Get payment history for a specific tenant
 */
router.get(
  "/tenant/:tenantId/history",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("tenantId").isInt().withMessage("Tenant ID must be a valid integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage("Limit must be between 1 and 50"),
    query("year")
      .optional()
      .isInt({ min: 2020, max: 2030 })
      .withMessage("Year must be between 2020 and 2030"),
  ],
  handleValidationErrors,
  RentController.getTenantPaymentHistory
);

/**
 * POST /api/rent-collection/send-reminders
 * Send payment reminder emails to tenants
 */
router.post(
  "/send-reminders",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    body("payment_ids")
      .isArray({ min: 1 })
      .withMessage("Payment IDs must be a non-empty array"),
    body("payment_ids.*")
      .isInt()
      .withMessage("Each payment ID must be a valid integer"),
    body("reminder_type")
      .isIn(["gentle", "firm", "final"])
      .withMessage("Reminder type must be gentle, firm, or final"),
    body("custom_message")
      .optional()
      .isLength({ max: 500 })
      .withMessage("Custom message must not exceed 500 characters"),
  ],
  handleValidationErrors,
  RentController.sendPaymentReminders
);

export default router;
