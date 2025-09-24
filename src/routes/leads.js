// src/routes/leads.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import upload from "../middleware/upload.js";
import { createError } from "../utils/errorHandler.js";
import LeadsController from "../controllers/leadsController.js";

const router = express.Router();

// Apply authentication to all routes
router.use(authenticate);

// Validation middleware
const handleValidationErrors = (req, _res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessage = errors.array()[0].msg;
    return next(createError("VALIDATION_ERROR", errorMessage));
  }
  next();
};

/**
 * GET /api/leads/kanban
 * Get leads organized for Kanban board
 */
router.get(
  "/kanban",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("assigned_to")
      .optional()
      .isInt()
      .withMessage("Assigned to must be a valid user ID"),
    query("source")
      .optional()
      .isIn(["website", "referral", "walk_in", "social_media", "phone"])
      .withMessage("Invalid source"),
    query("priority")
      .optional()
      .isIn(["low", "medium", "high", "urgent"])
      .withMessage("Invalid priority"),
    query("building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
  ],
  handleValidationErrors,
  LeadsController.getKanbanBoard
);

/**
 * GET /api/leads
 * Get all leads with pagination and filters
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
      .isIn([
        "new_leads",
        "hot",
        "warm",
        "initial_contact",
        "negotiations",
        "cold",
        "lost",
        "won",
      ])
      .withMessage("Invalid status"),
    query("assigned_to")
      .optional()
      .isInt()
      .withMessage("Assigned to must be a valid user ID"),
    query("source")
      .optional()
      .isIn(["website", "referral", "walk_in", "social_media", "phone"])
      .withMessage("Invalid source"),
    query("search")
      .optional()
      .isLength({ min: 1 })
      .withMessage("Search term cannot be empty"),
  ],
  handleValidationErrors,
  LeadsController.getAllLeads
);

/**
 * GET /api/leads/:id
 * Get single lead details
 */
router.get(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [param("id").isInt().withMessage("Lead ID must be a valid integer")],
  handleValidationErrors,
  LeadsController.getLeadById
);

/**
 * POST /api/leads
 * Create new lead
 */
router.post(
  "/",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be between 2 and 100 characters"),
    body("phone")
      .trim()
      .matches(/^[6-9]\d{9}$/)
      .withMessage("Phone must be a valid 10-digit Indian mobile number"),
    body("email")
      .optional({ values: "falsy" })
      .isEmail()
      .withMessage("Must be a valid email address"),
    body("source")
      .isIn(["website", "referral", "walk_in", "social_media", "phone"])
      .withMessage("Invalid source"),
    body("preferred_building_id")
      .optional({ values: "falsy" })
      .isInt()
      .withMessage("Building ID must be a valid integer"),
    body("preferred_room_type")
      .optional({ values: "falsy" })
      .isIn(["single", "double", "triple"])
      .withMessage("Invalid room type"),
    body("budget_min")
      .optional({ values: "falsy" })
      .isFloat({ min: 0 })
      .withMessage("Budget min must be a positive number"),
    body("budget_max")
      .optional({ values: "falsy" })
      .isFloat({ min: 0 })
      .withMessage("Budget max must be a positive number"),
    body("preferred_move_in_date")
      .optional({ values: "falsy" })
      .isISO8601()
      .withMessage("Must be a valid date"),
    body("notes")
      .optional({ values: "falsy" })
      .isLength({ max: 1000 })
      .withMessage("Notes cannot exceed 1000 characters"),
  ],
  handleValidationErrors,
  LeadsController.createLead
);

/**
 * PUT /api/leads/:id
 * Update lead details
 */
router.put(
  "/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt().withMessage("Lead ID must be a valid integer"),
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be between 2 and 100 characters"),
    body("phone")
      .optional()
      .trim()
      .matches(/^[6-9]\d{9}$/)
      .withMessage("Phone must be a valid 10-digit Indian mobile number"),
    body("email")
      .optional()
      .isEmail()
      .withMessage("Must be a valid email address"),
    body("preferred_building_id")
      .optional()
      .isInt()
      .withMessage("Building ID must be a valid integer"),
    body("preferred_room_type")
      .optional()
      .isIn(["single", "double", "triple"])
      .withMessage("Invalid room type"),
    body("budget_min")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Budget min must be a positive number"),
    body("budget_max")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Budget max must be a positive number"),
    body("preferred_move_in_date")
      .optional()
      .isISO8601()
      .withMessage("Must be a valid date"),
    body("assigned_to")
      .optional()
      .isInt()
      .withMessage("Assigned to must be a valid user ID"),
    body("priority")
      .optional()
      .isIn(["low", "medium", "high", "urgent"])
      .withMessage("Invalid priority"),
    body("notes")
      .optional()
      .isLength({ max: 1000 })
      .withMessage("Notes cannot exceed 1000 characters"),
    body("follow_up_notes")
      .optional()
      .isLength({ max: 500 })
      .withMessage("Follow-up notes cannot exceed 500 characters"),
    body("next_follow_up_date")
      .optional()
      .isISO8601()
      .withMessage("Must be a valid date"),
  ],
  handleValidationErrors,
  LeadsController.updateLead
);

/**
 * PUT /api/leads/:id/status
 * Update lead status (Kanban drag & drop)
 */
router.put(
  "/:id/status",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt().withMessage("Lead ID must be a valid integer"),
    body("status")
      .isIn([
        "new_leads",
        "hot",
        "warm",
        "initial_contact",
        "negotiations",
        "cold",
        "lost",
        "won",
      ])
      .withMessage("Invalid status"),
    body("stage_position")
      .isInt({ min: 1 })
      .withMessage("Stage position must be a positive integer"),
    body("reason")
      .optional()
      .isLength({ max: 200 })
      .withMessage("Reason cannot exceed 200 characters"),
  ],
  handleValidationErrors,
  LeadsController.updateLeadStatus
);

/**
 * PUT /api/leads/:id/assign
 * Assign lead to agent
 */
router.put(
  "/:id/assign",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt().withMessage("Lead ID must be a valid integer"),
    body("assigned_to")
      .isInt()
      .withMessage("Assigned to must be a valid user ID"),
  ],
  handleValidationErrors,
  LeadsController.assignLead
);


/**
 * DELETE /api/leads/:id
 * Delete lead (Super Admin only)
 */
router.delete(
  "/:id",
  authorize(ROLES.SUPER_ADMIN),
  [param("id").isInt().withMessage("Lead ID must be a valid integer")],
  handleValidationErrors,
  LeadsController.deleteLead
);

/**
 * GET /api/leads/:id/activities
 * Get lead activities/touch log
 */
router.get(
  "/:id/activities",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt().withMessage("Lead ID must be a valid integer"),
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 50 })
      .withMessage("Limit must be between 1 and 50"),
  ],
  handleValidationErrors,
  LeadsController.getLeadActivities
);

/**
 * POST /api/leads/:id/activities
 * Add new activity to lead
 */
router.post(
  "/:id/activities",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt().withMessage("Lead ID must be a valid integer"),
    body("activity_type")
      .isIn(["call", "email", "meeting", "note", "tour", "follow_up"])
      .withMessage("Invalid activity type"),
    body("communication_mode")
      .optional()
      .isIn([
        "voice_call",
        "sms",
        "whatsapp_msg",
        "whatsapp_call",
        "email",
        "in_person",
      ])
      .withMessage("Invalid communication mode"),
    body("outcome")
      .optional()
      .isIn([
        "could_not_connect",
        "call_me_back",
        "on_whatsapp",
        "video_tour",
        "physical_tour",
        "interested",
        "not_interested",
      ])
      .withMessage("Invalid outcome"),
    body("title")
      .trim()
      .isLength({ min: 1, max: 200 })
      .withMessage("Title must be between 1 and 200 characters"),
    body("description")
      .optional()
      .isLength({ max: 1000 })
      .withMessage("Description cannot exceed 1000 characters"),
    body("notes")
      .optional()
      .isLength({ max: 500 })
      .withMessage("Notes cannot exceed 500 characters"),
    body("next_action")
      .optional()
      .isLength({ max: 100 })
      .withMessage("Next action cannot exceed 100 characters"),
    body("scheduled_at")
      .optional()
      .isISO8601()
      .withMessage("Must be a valid date"),
    body("next_interaction_date")
      .optional()
      .isISO8601()
      .withMessage("Must be a valid date"),
  ],
  handleValidationErrors,
  LeadsController.addLeadActivity
);

/**
 * GET /api/leads/stats/overview
 * Get leads overview statistics
 */
router.get(
  "/stats/overview",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("date_from")
      .optional()
      .isISO8601()
      .withMessage("Date from must be a valid date"),
    query("date_to")
      .optional()
      .isISO8601()
      .withMessage("Date to must be a valid date"),
    query("assigned_to")
      .optional()
      .isInt()
      .withMessage("Assigned to must be a valid user ID"),
  ],
  handleValidationErrors,
  LeadsController.getLeadsOverview
);

/**
 * POST /api/leads/:id/documents
 * Upload documents for lead
 */
router.post(
  "/:id/documents",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [param("id").isInt().withMessage("Lead ID must be a valid integer")],
  upload.array("documents", 5), // Max 5 files
  [
    body("document_type")
      .isIn(["id_proof", "income_proof", "agreement", "photo", "video_tour"])
      .withMessage("Invalid document type"),
  ],
  handleValidationErrors,
  LeadsController.uploadLeadDocuments
);

/**
 * GET /api/leads/:id/documents
 * Get lead documents
 */
router.get(
  "/:id/documents",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [param("id").isInt().withMessage("Lead ID must be a valid integer")],
  handleValidationErrors,
  LeadsController.getLeadDocuments
);

/**
 * DELETE /api/leads/:id/documents/:docId
 * Delete lead document
 */
router.delete(
  "/:id/documents/:docId",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("id").isInt().withMessage("Lead ID must be a valid integer"),
    param("docId").isInt().withMessage("Document ID must be a valid integer"),
  ],
  handleValidationErrors,
  LeadsController.deleteLeadDocument
);

/**
 * GET /api/leads/buildings
 * Get list of buildings for dropdown
 */
router.get(
  "/data/buildings",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  LeadsController.getBuildings
);

/**
 * GET /api/leads/agents
 * Get list of agents/managers for dropdown
 */
router.get(
  "/data/agents",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  LeadsController.getAgents
);

export default router;
