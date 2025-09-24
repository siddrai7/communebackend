// src/controllers/authController.js
import pool from "../config/database.js";
import { generateJWT, verifyJWT } from "../services/jwtService.js";
import { createError } from "../utils/errorHandler.js";
import { sendOTP } from "../services/emailService.js";

// Generate OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

class AuthController {
  // POST /api/auth/login
  async login(req, res, next) {
    try {
      const { email } = req.body;

      console.log(`Login attempt for email: ${email}--`);

      const client = await pool.connect();

      try {
        // Check if user exists
        const userQuery = `
          SELECT id, email, role, status, email_verified 
          FROM users 
          WHERE email = $1
        `;
        const userResult = await client.query(userQuery, [email]);

        if (userResult.rows.length === 0) {
          console.log(
            "User not found. Please contact admin for account creation."
          );
          return next(
            createError(
              "NOT_FOUND",
              "User not found. Please contact admin for account creation."
            )
          );
        }

        const user = userResult.rows[0];

        // Check if user is active
        if (user.status !== "active") {
          return next(
            createError(
              "FORBIDDEN",
              "Account is inactive. Please contact administrator."
            )
          );
        }

        // Generate OTP
        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // Delete existing OTPs for this email
        await client.query(
          "DELETE FROM otps WHERE email = $1 AND purpose = $2",
          [email, "login"]
        );

        // Store OTP
        await client.query(
          `INSERT INTO otps (email, otp, purpose, expires_at, attempts, used) 
           VALUES ($1, $2, $3, $4, 0, false)`,
          [email, otp, "login", expiresAt]
        );

        // Send OTP via email
        await sendOTP(email, otp, "login");
        console.log("OTP sent to your email address", otp);

        res.json({
          success: true,
          message: "OTP sent to your email address",
          data: {
            email,
            expiresIn: 600, // 10 minutes in seconds
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // POST /api/auth/verify-otp
  async verifyOTP(req, res, next) {
    try {
      const { email, otp } = req.body;

      const client = await pool.connect();

      try {
        // Get OTP record
        const otpQuery = `
          SELECT id, otp, expires_at, attempts, used 
          FROM otps 
          WHERE email = $1 AND purpose = $2 
          ORDER BY created_at DESC 
          LIMIT 1
        `;
        const otpResult = await client.query(otpQuery, [email, "login"]);

        if (otpResult.rows.length === 0) {
          return next(
            createError("NOT_FOUND", "No OTP found. Please request a new one.")
          );
        }

        const otpRecord = otpResult.rows[0];

        // Check if OTP is expired
        if (new Date() > new Date(otpRecord.expires_at)) {
          return next(
            createError(
              "UNAUTHORIZED",
              "OTP has expired. Please request a new one."
            )
          );
        }

        // Check if OTP is already used
        if (otpRecord.used) {
          return next(
            createError(
              "UNAUTHORIZED",
              "OTP has already been used. Please request a new one."
            )
          );
        }

        // Check attempts limit
        if (otpRecord.attempts >= 3) {
          return next(
            createError(
              "UNAUTHORIZED",
              "Too many failed attempts. Please request a new OTP."
            )
          );
        }

        // Verify OTP
        if (otpRecord.otp !== otp) {
          // Increment attempts
          await client.query(
            "UPDATE otps SET attempts = attempts + 1 WHERE id = $1",
            [otpRecord.id]
          );

          return next(
            createError("UNAUTHORIZED", "Invalid OTP. Please try again.")
          );
        }

        // Mark OTP as used
        await client.query("UPDATE otps SET used = true WHERE id = $1", [
          otpRecord.id,
        ]);

        // Get user details
        const userQuery = `
          SELECT u.id, u.email, u.role, u.status, u.email_verified,
                 up.first_name, up.last_name, up.phone, up.profile_picture
          FROM users u
          LEFT JOIN user_profiles up ON u.id = up.user_id
          WHERE u.email = $1
        `;
        const userResult = await client.query(userQuery, [email]);
        const user = userResult.rows[0];

        // Update last login
        await client.query(
          "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1",
          [user.id]
        );

        // Generate JWT token
        const token = generateJWT({
          userId: user.id,
          email: user.email,
          role: user.role,
        });

        res.json({
          success: true,
          message: "Login successful",
          data: {
            token,
            user: {
              id: user.id,
              email: user.email,
              role: user.role,
              firstName: user.first_name,
              lastName: user.last_name,
              phone: user.phone,
              profilePicture: user.profile_picture,
              emailVerified: user.email_verified,
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // POST /api/auth/resend-otp
  async resendOTP(req, res, next) {
    try {
      const { email } = req.body;

      const client = await pool.connect();

      try {
        // Check if user exists
        const userQuery = `SELECT id, status FROM users WHERE email = $1`;
        const userResult = await client.query(userQuery, [email]);

        if (userResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "User not found"));
        }

        const user = userResult.rows[0];

        if (user.status !== "active") {
          return next(createError("FORBIDDEN", "Account is inactive"));
        }

        // Check rate limiting (no more than 1 OTP per minute)
        const recentOtpQuery = `
          SELECT id FROM otps 
          WHERE email = $1 AND created_at > NOW() - INTERVAL '1 minute'
        `;
        const recentOtpResult = await client.query(recentOtpQuery, [email]);

        if (recentOtpResult.rows.length > 0) {
          return next(
            createError(
              "VALIDATION_ERROR",
              "Please wait 1 minute before requesting another OTP"
            )
          );
        }

        // Generate new OTP
        const otp = generateOTP();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        // Delete existing OTPs
        await client.query(
          "DELETE FROM otps WHERE email = $1 AND purpose = $2",
          [email, "login"]
        );

        // Store new OTP
        await client.query(
          `INSERT INTO otps (email, otp, purpose, expires_at, attempts, used) 
           VALUES ($1, $2, $3, $4, 0, false)`,
          [email, otp, "login", expiresAt]
        );

        // Send OTP
        await sendOTP(email, otp, "resend");

        res.json({
          success: true,
          message: "New OTP sent to your email",
          data: {
            email,
            expiresIn: 600,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // POST /api/auth/logout
  async logout(req, res) {
    res.json({
      success: true,
      message: "Logged out successfully",
    });
  }

  // GET /api/auth/me
  async getCurrentUser(req, res, next) {
    try {
      const client = await pool.connect();

      try {
        const userQuery = `
          SELECT u.id, u.email, u.role, u.status, u.email_verified, u.last_login,
                 up.first_name, up.last_name, up.phone, up.date_of_birth, up.gender,
                 up.address_line1, up.address_line2, up.city, up.state, up.country,
                 up.postal_code, up.emergency_contact_name, up.emergency_contact_phone,
                 up.emergency_contact_relation, up.profile_picture, up.id_proof_type,
                 up.id_proof_number
          FROM users u
          LEFT JOIN user_profiles up ON u.id = up.user_id
          WHERE u.id = $1
        `;

        const userResult = await client.query(userQuery, [req.user.userId]);

        if (userResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "User not found"));
        }

        const user = userResult.rows[0];

        res.json({
          success: true,
          data: {
            id: user.id,
            email: user.email,
            role: user.role,
            status: user.status,
            emailVerified: user.email_verified,
            lastLogin: user.last_login,
            profile: {
              firstName: user.first_name,
              lastName: user.last_name,
              phone: user.phone,
              dateOfBirth: user.date_of_birth,
              gender: user.gender,
              address: {
                line1: user.address_line1,
                line2: user.address_line2,
                city: user.city,
                state: user.state,
                country: user.country,
                postalCode: user.postal_code,
              },
              emergencyContact: {
                name: user.emergency_contact_name,
                phone: user.emergency_contact_phone,
                relation: user.emergency_contact_relation,
              },
              profilePicture: user.profile_picture,
              idProof: {
                type: user.id_proof_type,
                number: user.id_proof_number,
              },
            },
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // POST /api/auth/refresh
  async refreshToken(req, res, next) {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return next(
          createError("UNAUTHORIZED", "Authorization token required")
        );
      }

      const token = authHeader.substring(7);

      try {
        const decoded = verifyJWT(token);

        // Generate new token
        const newToken = generateJWT({
          userId: decoded.userId,
          email: decoded.email,
          role: decoded.role,
        });

        res.json({
          success: true,
          message: "Token refreshed successfully",
          data: {
            token: newToken,
          },
        });
      } catch (error) {
        return next(createError("UNAUTHORIZED", "Invalid token for refresh"));
      }
    } catch (error) {
      next(error);
    }
  }
}

export default new AuthController();
