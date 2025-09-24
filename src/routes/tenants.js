// src/routes/tenantRoutes.js
import express from "express";
import { body, query, param, validationResult } from "express-validator";
import { authenticate, authorize, ROLES } from "../middleware/auth.js";
import { createError } from "../utils/errorHandler.js";
import tenantController from "../controllers/tenantController.js";
import multer from "multer";
import path from "path";

const router = express.Router();

// Apply authentication to all routes
router.use(authenticate);
// Apply tenant authorization to all routes
router.use(authorize(ROLES.TENANT));

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
 * GET /api/tenant/dashboard
 * Get tenant dashboard summary data
 */
router.get("/dashboard", authenticate, tenantController.getDashboard);

/**
 * GET /api/tenant/analytics
 * Get tenant analytics (payment trends, complaint stats)
 */
// router.get("/analytics", tenantController.getAnalytics);

/**
 * GET /api/tenant/amenities
 * Get building and room amenities
 */
// router.get("/amenities", tenantController.getAmenities);

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = req.originalUrl.includes("/avatar")
      ? "uploads/avatars/"
      : "uploads/complaints/";
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (req.originalUrl.includes("/avatar")) {
      // Avatar upload - only images
      if (file.mimetype.startsWith("image/")) {
        cb(null, true);
      } else {
        cb(
          new Error("Only image files are allowed for profile picture"),
          false
        );
      }
    } else {
      // Complaint files - images and documents
      const allowedMimes = [
        "image/jpeg",
        "image/png",
        "image/gif",
        "application/pdf",
        "image/webp",
      ];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Only images and PDF files are allowed"), false);
      }
    }
  },
});

/**
 * GET /api/tenant/profile
 * Get tenant profile information
 */
router.get("/profile", tenantController.getProfile);

/**
 * PUT /api/tenant/profile
 * Update tenant profile information
 */
router.put(
  "/profile",
  [
    body("firstName")
      .optional()
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage("First name must be between 2 and 50 characters"),
    body("lastName")
      .optional()
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage("Last name must be between 2 and 50 characters"),
    body("phone")
      .optional()
      .isMobilePhone("en-IN")
      .withMessage("Please provide a valid Indian phone number"),
    body("dateOfBirth")
      .optional()
      .isISO8601()
      .withMessage("Please provide a valid date of birth")
      .custom((value) => {
        const birthDate = new Date(value);
        const today = new Date();
        const age = today.getFullYear() - birthDate.getFullYear();
        if (age < 18 || age > 100) {
          throw new Error("Age must be between 18 and 100 years");
        }
        return true;
      }),
    body("gender")
      .optional()
      .isIn(["male", "female", "other"])
      .withMessage("Gender must be male, female, or other"),
    body("addressLine1")
      .optional()
      .trim()
      .isLength({ max: 255 })
      .withMessage("Address line 1 cannot exceed 255 characters"),
    body("addressLine2")
      .optional()
      .trim()
      .isLength({ max: 255 })
      .withMessage("Address line 2 cannot exceed 255 characters"),
    body("city")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("City cannot exceed 100 characters"),
    body("state")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("State cannot exceed 100 characters"),
    body("country")
      .optional()
      .trim()
      .isLength({ max: 100 })
      .withMessage("Country cannot exceed 100 characters"),
    body("postalCode")
      .optional()
      .matches(/^[1-9][0-9]{5}$/)
      .withMessage("Please provide a valid Indian postal code"),
    body("emergencyContactName")
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage(
        "Emergency contact name must be between 2 and 100 characters"
      ),
    body("emergencyContactPhone")
      .optional()
      .isMobilePhone("en-IN")
      .withMessage("Please provide a valid emergency contact phone number"),
    body("emergencyContactRelation")
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage("Emergency contact relation cannot exceed 50 characters"),
  ],
  handleValidationErrors,
  tenantController.updateProfile
);

/**
 * POST /api/tenant/profile/avatar
 * Update tenant profile picture
 */
router.post(
  "/profile/avatar",
  upload.single("avatar"),
  (req, res, next) => {
    if (!req.file) {
      return next(
        createError("VALIDATION_ERROR", "Please select an image file")
      );
    }
    next();
  },
  tenantController.updateAvatar
);

/**
 * GET /api/tenant/property-details
 * Get current property, room, and lease details
 */
router.get("/property-details", tenantController.getPropertyDetails);

/**
 * GET /api/tenant/payments
 * Get payment history with filtering and pagination
 */
router.get(
  "/payments",
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
      .isIn(["all", "pending", "paid", "overdue", "partial", "failed"])
      .withMessage("Invalid payment status"),
    query("type")
      .optional()
      .isIn([
        "all",
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
  tenantController.getPayments
);

/**
 * GET /api/tenant/payments/upcoming
 * Get upcoming and overdue payments
 */
router.get("/payments/upcoming", tenantController.getUpcomingPayments);

/**
 * GET /api/tenant/complaints
 * Get tenant's complaints with filtering and pagination
 */
router.get(
  "/complaints",
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
        "all",
        "submitted",
        "acknowledged",
        "in_progress",
        "resolved",
        "closed",
        "rejected",
      ])
      .withMessage("Invalid complaint status"),
    // query("category")
    //   .optional()
    //   .isIn([
    //     "all",
    //     "maintenance",
    //     "electrical",
    //     "noise",
    //     "cleaning",
    //     "security",
    //     "billing",
    //     "amenity",
    //     "other",
    //   ])
    //   .withMessage("Invalid complaint category"),
  ],
  handleValidationErrors,
  tenantController.getComplaints
);

/**
 * POST /api/tenant/complaints
 * Create a new complaint
 */
router.post(
  "/complaints",
  upload.array("attachments", 5), // Allow up to 5 file attachments
  [
    body("title")
      .trim()
      .notEmpty()
      .isLength({ min: 5, max: 200 })
      .withMessage("Title must be between 5 and 200 characters"),
    body("description")
      .trim()
      .notEmpty()
      .isLength({ min: 10, max: 1000 })
      .withMessage("Description must be between 10 and 1000 characters"),
    // body("category")
    //   .notEmpty()
    //   .isIn([
    //     "all",
    //     "maintenance",
    //     "electrical",
    //     "noise",
    //     "cleaning",
    //     "security",
    //     "billing",
    //     "amenity",
    //     "other",
    //   ])
    //   .withMessage("Invalid complaint category"),
    body("subcategory")
      .optional()
      .trim()
      .isLength({ max: 50 })
      .withMessage("Subcategory cannot exceed 50 characters"),
    body("priority")
      .optional()
      .isIn(["low", "medium", "high", "urgent"])
      .withMessage("Priority must be low, medium, high, or urgent"),
  ],
  handleValidationErrors,
  tenantController.createComplaint
);

/**
 * GET /api/tenant/complaints/:id
 * Get complaint details with activity log
 */
router.get(
  "/complaints/:id",
  [param("id").isInt({ min: 1 }).withMessage("Invalid complaint ID")],
  handleValidationErrors,
  tenantController.getComplaintDetails
);

/**
 * POST /api/tenant/complaints/:id/activity
 * Add a note/activity to complaint
 */
router.post(
  "/complaints/:id/activity",
  upload.array("attachments", 3), // Allow up to 3 file attachments for notes
  [
    param("id").isInt({ min: 1 }).withMessage("Invalid complaint ID"),
    body("description")
      .trim()
      .notEmpty()
      .isLength({ min: 5, max: 500 })
      .withMessage("Note must be between 5 and 500 characters"),
  ],
  handleValidationErrors,
  tenantController.addComplaintActivity
);

/**
 * PUT /api/tenant/complaints/:id/feedback
 * Submit feedback for resolved complaint
 */
router.put(
  "/complaints/:id/feedback",
  [
    param("id").isInt({ min: 1 }).withMessage("Invalid complaint ID"),
    body("rating")
      .isInt({ min: 1, max: 5 })
      .withMessage("Rating must be between 1 and 5"),
    body("feedback")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Feedback cannot exceed 500 characters"),
  ],
  handleValidationErrors,
  tenantController.submitComplaintFeedback
);

/**
 * GET /api/tenant/announcements
 * Get building announcements for tenant
 */
router.get(
  "/announcements",
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
        "all",
        "maintenance",
        "event",
        "policy",
        "emergency",
        "billing",
        "amenity",
        "general",
      ])
      .withMessage("Invalid announcement category"),
  ],
  handleValidationErrors,
  tenantController.getAnnouncements
);

/**
 * POST /api/tenant/announcements/:id/read
 * Mark announcement as read (simplified without tracking)
 */
router.post(
  "/announcements/:id/read",
  [param("id").isInt({ min: 1 }).withMessage("Invalid announcement ID")],
  handleValidationErrors,
  tenantController.markAnnouncementAsRead
);

/**
 * GET /api/tenant/documents
 * Get available documents for tenant
 */
router.get("/documents", tenantController.getDocuments);

/**
 * GET /api/tenant/documents/:type/:id/download
 * Download specific document
 */
router.get(
  "/documents/:type/:id/download",
  [
    param("type")
      .isIn(["payment_receipt", "lease_agreement", "id_proof"])
      .withMessage("Invalid document type"),
    param("id").isInt({ min: 1 }).withMessage("Invalid document ID"),
  ],
  handleValidationErrors,
  tenantController.downloadDocument
);

/**
 * GET /api/tenant/offboarding
 * Get tenant's current offboarding status
 */
router.get("/offboarding", tenantController.getOffboardingStatus);

/**
 * POST /api/tenant/offboarding/initiate
 * Initiate offboarding process
 */
router.post(
  "/offboarding/initiate",
  [
    body("reason")
      .trim()
      .notEmpty()
      .isLength({ min: 10, max: 500 })
      .withMessage("Reason must be between 10 and 500 characters"),
    body("moveOutMonth")
      .notEmpty()
      .matches(/^\d{4}-(0[1-9]|1[0-2])$/)
      .withMessage("Please provide a valid move-out month in YYYY-MM format")
      .custom((value) => {
        const [year, month] = value.split('-').map(Number);
        const today = new Date();
        const currentYear = today.getFullYear();
        const currentMonth = today.getMonth() + 1;
        const currentDay = today.getDate();
        
        // Calculate 30 days from today
        const noticeDate = new Date(today);
        noticeDate.setDate(noticeDate.getDate() + 30);
        
        // Find the end of the month containing the 30-day notice date
        const minMoveOutDate = new Date(noticeDate.getFullYear(), noticeDate.getMonth() + 1, 0); // Last day of that month
        
        const minYear = minMoveOutDate.getFullYear();
        const minMonth = minMoveOutDate.getMonth() + 1;
        
        if (year < minYear || (year === minYear && month < minMonth)) {
          const minDate = `${minYear}-${minMonth.toString().padStart(2, '0')}`;
          throw new Error(`Move-out month must be ${minDate} or later to ensure 30-day notice period`);
        }
        
        return true;
      }),
  ],
  handleValidationErrors,
  tenantController.initiateOffboarding
);

// Error handling middleware for multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return next(
        createError(
          "VALIDATION_ERROR",
          "File size too large. Maximum 5MB allowed."
        )
      );
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      return next(
        createError(
          "VALIDATION_ERROR",
          "Too many files. Maximum 5 files allowed."
        )
      );
    }
  }
  if (error.message.includes("Only image files are allowed")) {
    return next(
      createError(
        "VALIDATION_ERROR",
        "Only image files are allowed for profile picture"
      )
    );
  }
  if (error.message.includes("Only images and PDF files are allowed")) {
    return next(
      createError("VALIDATION_ERROR", "Only images and PDF files are allowed")
    );
  }
  next(error);
});

export default router;
