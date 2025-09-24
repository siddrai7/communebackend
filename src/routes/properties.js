// src/routes/properties.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import { authorizeResource, applyDataFilters } from "../middleware/rbac.js";
import upload from "../middleware/upload.js";
import { createError } from "../utils/errorHandler.js";
import PropertiesController from "../controllers/propertiesController.js";

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
 * GET /api/properties/overview
 * Get properties overview statistics
 * Role-based: Admins see all, Managers see only their buildings
 */
router.get(
  "/overview",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  applyDataFilters("building"),
  PropertiesController.getOverview
);

/**
 * GET /api/properties/buildings
 * Get all buildings with pagination and filters
 * Role-based: Admins see all, Managers see only assigned buildings
 */
router.get(
  "/buildings",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  applyDataFilters("building"),
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
      .isIn(["active", "inactive", "under_construction"])
      .withMessage("Invalid status"),
    query("search")
      .optional()
      .isLength({ max: 100 })
      .withMessage("Search term too long"),
  ],
  handleValidationErrors,
  PropertiesController.getBuildings
);

/**
 * GET /api/properties/managers/available
 * Get available managers for building assignment
 * Only Super Admins and Admins can access this
 */
router.get(
  "/managers/available",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  PropertiesController.getAvailableManagers
);

/**
 * POST /api/properties/buildings
 * Create a new building
 * Only Super Admins and Admins can create buildings
 */
router.post(
  "/buildings",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  upload.fields([
    { name: "masterImage", maxCount: 1 },
    { name: "otherImages", maxCount: 10 },
  ]),
  [
    body("name")
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage(
        "Building name is required and must be less than 100 characters"
      ),
    body("addressLine1")
      .trim()
      .isLength({ min: 1, max: 200 })
      .withMessage(
        "Address line 1 is required and must be less than 200 characters"
      ),
    body("city")
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("City is required and must be less than 100 characters"),
    body("state")
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("State is required and must be less than 50 characters"),
    body("postalCode")
      .trim()
      .isLength({ min: 1, max: 20 })
      .withMessage(
        "Postal code is required and must be less than 20 characters"
      ),
    body("managerId")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Manager ID must be a positive integer"),
    body("contactPerson")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Contact person name must be less than 100 characters"),
    body("contactPhone")
      .optional()
      .trim()
      .isLength({ max: 20 })
      .withMessage("Contact phone must be less than 20 characters"),
    body("amenities")
      .optional()
      .isJSON()
      .withMessage("Amenities must be valid JSON"),
  ],
  handleValidationErrors,
  PropertiesController.createBuilding
);

/**
 * GET /api/properties/buildings/:id
 * Get building by ID with detailed information
 * Role-based: Managers can only access their assigned buildings
 */
router.get(
  "/buildings/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  authorizeResource({
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
    resource: "building",
    operation: "read",
    resourceIdParam: "id",
  }),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("Building ID must be a positive integer"),
  ],
  handleValidationErrors,
  PropertiesController.getBuildingById
);

/**
 * GET /api/properties/buildings/:id/edit
 * Get building details for editing
 * Role-based: Managers can only access their assigned buildings
 */
router.get(
  "/buildings/:id/edit",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  authorizeResource({
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
    resource: "building",
    operation: "read",
    resourceIdParam: "id",
  }),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("Building ID must be a positive integer"),
  ],
  handleValidationErrors,
  PropertiesController.getBuildingForEdit
);

/**
 * GET /api/properties/buildings/:id/tenants
 * Get building tenants
 * Role-based: Managers can only access tenants from their buildings
 */
router.get(
  "/buildings/:id/tenants",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  authorizeResource({
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
    resource: "building",
    operation: "read",
    resourceIdParam: "id",
  }),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("Building ID must be a positive integer"),
    query("type")
      .optional()
      .matches(/^(current|future|past)(,(current|future|past))*$/)
      .withMessage("Invalid tenant type"),
    query("include")
      .optional()
      .matches(
        /^(profile|emergency|documents)(,(profile|emergency|documents))*$/
      )
      .withMessage("Invalid include options"),
  ],
  handleValidationErrors,
  PropertiesController.getBuildingTenants
);

/**
 * GET /api/properties/buildings/:id/vacancy-chart
 * Get building vacancy chart data
 * Role-based: Managers can only access their buildings
 */
router.get(
  "/buildings/:id/vacancy-chart",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  authorizeResource({
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER],
    resource: "building",
    operation: "read",
    resourceIdParam: "id",
  }),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("Building ID must be a positive integer"),
    query("range")
      .optional()
      .isInt({ min: 7, max: 365 })
      .withMessage("Range must be between 7 and 365 days"),
  ],
  handleValidationErrors,
  PropertiesController.getBuildingVacancyChart
);

/**
 * GET /api/properties/buildings/:id/analytics
 * Get building analytics
 * Restricted to Super Admins and Admins only
 */
router.get(
  "/buildings/:id/analytics",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizeResource({
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN],
    resource: "building",
    operation: "read",
    resourceIdParam: "id",
  }),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("Building ID must be a positive integer"),
    query("period")
      .optional()
      .isIn(["3months", "6months", "12months"])
      .withMessage("Invalid period"),
    query("metrics")
      .optional()
      .matches(
        /^(revenue|occupancy|maintenance|tenant_satisfaction)(,(revenue|occupancy|maintenance|tenant_satisfaction))*$/
      )
      .withMessage("Invalid metrics"),
  ],
  handleValidationErrors,
  PropertiesController.getBuildingAnalytics
);

/**
 * PUT /api/properties/buildings/:id
 * Update building information
 * Only Super Admins and Admins can update buildings
 */
router.put(
  "/buildings/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizeResource({
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN],
    resource: "building",
    operation: "write",
    resourceIdParam: "id",
  }),
  upload.single("buildingImage"),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("Building ID must be a positive integer"),
    body("name")
      .optional()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Building name must be less than 100 characters"),
    body("managerId")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Manager ID must be a positive integer"),
    body("addressLine1")
      .optional()
      .trim()
      .isLength({ max: 200 })
      .withMessage("Address line 1 must be less than 200 characters"),
    body("city")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("City must be less than 100 characters"),
    body("state")
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage("State must be less than 50 characters"),
    body("postalCode")
      .optional()
      .trim()
      .isLength({ max: 20 })
      .withMessage("Postal code must be less than 20 characters"),
    body("contactPerson")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Contact person name must be less than 100 characters"),
    body("contactPhone")
      .optional()
      .trim()
      .isLength({ max: 20 })
      .withMessage("Contact phone must be less than 20 characters"),
    body("status")
      .optional()
      .isIn(["active", "inactive", "under_construction"])
      .withMessage("Invalid status"),
    body("amenities")
      .optional()
      .isJSON()
      .withMessage("Amenities must be valid JSON"),
  ],
  handleValidationErrors,
  PropertiesController.updateBuilding
);

/**
 * DELETE /api/properties/buildings/:id
 * Delete building
 * Only Super Admins and Admins can delete buildings
 */
router.delete(
  "/buildings/:id",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN),
  authorizeResource({
    roles: [ROLES.SUPER_ADMIN, ROLES.ADMIN],
    resource: "building",
    operation: "delete",
    resourceIdParam: "id",
  }),
  [
    param("id")
      .isInt({ min: 1 })
      .withMessage("Building ID must be a positive integer"),
  ],
  handleValidationErrors,
  PropertiesController.deleteBuilding
);

export default router;
