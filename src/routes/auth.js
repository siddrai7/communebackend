// src/routes/auth.js
import express from "express";
import { body, validationResult } from "express-validator";
import { authenticate } from "../middleware/auth.js";
import { createError } from "../utils/errorHandler.js";
import AuthController from "../controllers/authController.js";

const router = express.Router();

// Validation middleware
const validateEmail = body("email")
  .isEmail()
  // .normalizeEmail()
  .withMessage("Please provide a valid email address");

const validateOTP = body("otp")
  .isLength({ min: 6, max: 6 })
  .isNumeric()
  .withMessage("OTP must be 6 digits");

// Helper function to handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessage = errors.array()[0].msg;
    return next(createError("VALIDATION_ERROR", errorMessage));
  }
  next();
};

/**
 * POST /api/auth/login
 * Send OTP to email for login
 */
router.post(
  "/login",
  validateEmail,
  handleValidationErrors,
  AuthController.login
);

/**
 * POST /api/auth/verify-otp
 * Verify OTP and return JWT token
 */
router.post(
  "/verify-otp",
  [validateEmail, validateOTP],
  handleValidationErrors,
  AuthController.verifyOTP
);

/**
 * POST /api/auth/resend-otp
 * Resend OTP
 */
router.post(
  "/resend-otp",
  validateEmail,
  handleValidationErrors,
  AuthController.resendOTP
);

/**
 * POST /api/auth/logout
 * Logout user (mainly for token cleanup on frontend)
 */
router.post("/logout", authenticate, AuthController.logout);

/**
 * GET /api/auth/me
 * Get current user information
 */
router.get("/me", authenticate, AuthController.getCurrentUser);

/**
 * POST /api/auth/refresh
 * Refresh JWT token
 */
router.post("/refresh", AuthController.refreshToken);

export default router;
