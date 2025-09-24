// src/routes/onboardingRoutes.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import { createError } from "../utils/errorHandler.js";
import onboardingController from "../controllers/onboardingController.js";

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
 * GET /api/onboarding/won-leads
 * Get all won leads ready for onboarding
 */
router.get(
  "/won-leads",
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
    query("search")
      .optional()
      .isLength({ max: 100 })
      .withMessage("Search term too long"),
  ],
  handleValidationErrors,
  onboardingController.getWonLeads
);

/**
 * GET /api/onboarding/lead/:leadId
 * Get detailed lead information for onboarding
 */
router.get(
  "/lead/:leadId",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [param("leadId").isInt({ min: 1 }).withMessage("Invalid lead ID")],
  handleValidationErrors,
  onboardingController.getLeadDetails
);

/**
 * GET /api/onboarding/available-units
 * Get available units for assignment
 */
router.get(
  "/available-units",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    query("buildingId")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Invalid building ID"),
    query("roomType")
      .optional()
      .isIn(["single", "double", "triple"])
      .withMessage("Invalid room type"),
  ],
  handleValidationErrors,
  onboardingController.getAvailableUnits
);

/**
 * GET /api/onboarding/buildings
 * Get all active buildings with unit availability
 */
router.get(
  "/buildings",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  onboardingController.getBuildings
);

/**
 * POST /api/onboarding/onboard-tenant
 * Complete tenant onboarding process
 */
router.post(
  "/onboard-tenant",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    body("leadId").isInt({ min: 1 }).withMessage("Invalid lead ID"),
    body("unitId").isInt({ min: 1 }).withMessage("Invalid unit ID"),
    body("tenantInfo").isObject().withMessage("Tenant info is required"),
    body("tenantInfo.firstName")
      .trim()
      .isLength({ min: 1 })
      .withMessage("First name is required"),
    body("tenantInfo.phone")
      .isMobilePhone("en-IN")
      .withMessage("Invalid phone number"),
    body("tenancyDetails")
      .isObject()
      .withMessage("Tenancy details are required"),
    body("tenancyDetails.startDate")
      .isISO8601()
      .withMessage("Invalid start date"),
    body("tenancyDetails.moveInDate")
      .isISO8601()
      .withMessage("Invalid move-in date"),
    body("tenancyDetails.endDate")
      .notEmpty()
      .isISO8601()
      .withMessage("End date is required and must be valid"),
    body("tenancyDetails.rentAmount")
      .isFloat({ min: 0 })
      .withMessage("Invalid rent amount"),
    body("tenancyDetails.securityDeposit")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Invalid security deposit"),
    body("tenancyDetails.agreementStatus")
      .optional()
      .isIn(["pending", "executed"])
      .withMessage("Invalid agreement status"),
    body("tenancyDetails.noticePeriodDays")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Invalid notice period"),
  ],
  handleValidationErrors,
  onboardingController.onboardTenant
);

/**
 * GET /api/onboarding/onboarded-tenants
 * Get list of all onboarded tenants
 */
router.get(
  "/onboarded-tenants",
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
    query("search")
      .optional()
      .isLength({ max: 100 })
      .withMessage("Search term too long"),
    query("fromDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid from date format"),
    query("toDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid to date format"),
  ],
  handleValidationErrors,
  onboardingController.getOnboardedTenants
);

/**
 * PUT /api/onboarding/tenant/:tenantId
 * Update tenant profile and tenancy info
 */
router.put(
  "/tenant/:tenantId",
  authorize(ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.MANAGER),
  [
    param("tenantId").isInt({ min: 1 }).withMessage("Invalid tenant ID"),
    body("profileData")
      .optional()
      .isObject()
      .withMessage("Invalid profile data"),
    body("profileData.firstName")
      .optional()
      .trim()
      .isLength({ min: 1 })
      .withMessage("Invalid first name"),
    body("profileData.lastName")
      .optional()
      .trim()
      .isLength({ min: 1 })
      .withMessage("Invalid last name"),
    body("profileData.phone")
      .optional()
      .isMobilePhone("en-IN")
      .withMessage("Invalid phone number"),
    body("profileData.dateOfBirth")
      .optional()
      .isISO8601()
      .withMessage("Invalid date of birth"),
    body("profileData.gender")
      .optional()
      .isIn(["male", "female", "other"])
      .withMessage("Invalid gender"),
    body("tenancyData")
      .optional()
      .isObject()
      .withMessage("Invalid tenancy data"),
    body("tenancyData.startDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid start date"),
    body("tenancyData.endDate")
      .optional()
      .isISO8601()
      .withMessage("Invalid end date"),
    body("tenancyData.rentAmount")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Invalid rent amount"),
    body("tenancyData.securityDeposit")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Invalid security deposit"),
    body("tenancyData.agreementStatus")
      .optional()
      .isIn(["pending", "executed", "expired", "terminated"])
      .withMessage("Invalid agreement status"),
    body("tenancyData.noticePeriodDays")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Invalid notice period"),
  ],
  handleValidationErrors,
  onboardingController.updateTenantInfo
);

export default router;
