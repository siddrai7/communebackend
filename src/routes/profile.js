// src/routes/profile.js
import express from "express";
import { body, validationResult } from "express-validator";
import { authenticate } from "../middleware/auth.js";
import upload from "../middleware/upload.js";
import { createError } from "../utils/errorHandler.js";
import ProfileController from "../controllers/profileController.js";

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
 * GET /api/profile
 * Get user profile
 */
router.get("/", ProfileController.getProfile);

/**
 * PUT /api/profile
 * Update user profile
 */
router.put(
  "/",
  [
    body("firstName")
      .optional()
      .trim()
      .isLength({ min: 1 })
      .withMessage("First name cannot be empty"),
    body("lastName")
      .optional()
      .trim()
      .isLength({ min: 1 })
      .withMessage("Last name cannot be empty"),
    body("phone")
      .optional()
      .isMobilePhone()
      .withMessage("Please provide a valid phone number"),
    body("email")
      .optional()
      .isEmail()
      .withMessage("Please provide a valid email address"),
  ],
  handleValidationErrors,
  ProfileController.updateProfile
);

/**
 * POST /api/profile/upload-avatar
 * Upload profile picture
 */
router.post(
  "/upload-avatar",
  upload.single("avatar"),
  ProfileController.uploadAvatar
);

export default router;
