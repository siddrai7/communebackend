// src/controllers/profileController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";

class ProfileController {
  // GET /api/profile
  async getProfile(req, res, next) {
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

        const response = {
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
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // PUT /api/profile
  async updateProfile(req, res, next) {
    try {
      const {
        firstName,
        lastName,
        phone,
        dateOfBirth,
        gender,
        addressLine1,
        addressLine2,
        city,
        state,
        country,
        postalCode,
        emergencyContactName,
        emergencyContactPhone,
        emergencyContactRelation,
        idProofType,
        idProofNumber,
      } = req.body;

      const client = await pool.connect();

      try {
        // Check if profile exists
        const existingQuery = `SELECT id FROM user_profiles WHERE user_id = $1`;
        const existingResult = await client.query(existingQuery, [
          req.user.userId,
        ]);

        let result;
        if (existingResult.rows.length === 0) {
          // Create new profile
          const insertQuery = `
            INSERT INTO user_profiles (
              user_id, first_name, last_name, phone, date_of_birth, gender,
              address_line1, address_line2, city, state, country, postal_code,
              emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
              id_proof_type, id_proof_number
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
            ) RETURNING *
          `;

          const values = [
            req.user.userId,
            firstName,
            lastName,
            phone,
            dateOfBirth,
            gender,
            addressLine1,
            addressLine2,
            city,
            state,
            country,
            postalCode,
            emergencyContactName,
            emergencyContactPhone,
            emergencyContactRelation,
            idProofType,
            idProofNumber,
          ];

          result = await client.query(insertQuery, values);
        } else {
          // Update existing profile
          const updateQuery = `
            UPDATE user_profiles SET
              first_name = COALESCE($1, first_name),
              last_name = COALESCE($2, last_name),
              phone = COALESCE($3, phone),
              date_of_birth = COALESCE($4, date_of_birth),
              gender = COALESCE($5, gender),
              address_line1 = COALESCE($6, address_line1),
              address_line2 = COALESCE($7, address_line2),
              city = COALESCE($8, city),
              state = COALESCE($9, state),
              country = COALESCE($10, country),
              postal_code = COALESCE($11, postal_code),
              emergency_contact_name = COALESCE($12, emergency_contact_name),
              emergency_contact_phone = COALESCE($13, emergency_contact_phone),
              emergency_contact_relation = COALESCE($14, emergency_contact_relation),
              id_proof_type = COALESCE($15, id_proof_type),
              id_proof_number = COALESCE($16, id_proof_number),
              updated_at = CURRENT_TIMESTAMP
            WHERE user_id = $17
            RETURNING *
          `;

          const values = [
            firstName,
            lastName,
            phone,
            dateOfBirth,
            gender,
            addressLine1,
            addressLine2,
            city,
            state,
            country,
            postalCode,
            emergencyContactName,
            emergencyContactPhone,
            emergencyContactRelation,
            idProofType,
            idProofNumber,
            req.user.userId,
          ];

          result = await client.query(updateQuery, values);
        }

        const profile = result.rows[0];

        const response = {
          success: true,
          message: "Profile updated successfully",
          data: {
            firstName: profile.first_name,
            lastName: profile.last_name,
            phone: profile.phone,
            dateOfBirth: profile.date_of_birth,
            gender: profile.gender,
            address: {
              line1: profile.address_line1,
              line2: profile.address_line2,
              city: profile.city,
              state: profile.state,
              country: profile.country,
              postalCode: profile.postal_code,
            },
            emergencyContact: {
              name: profile.emergency_contact_name,
              phone: profile.emergency_contact_phone,
              relation: profile.emergency_contact_relation,
            },
            idProof: {
              type: profile.id_proof_type,
              number: profile.id_proof_number,
            },
            updatedAt: profile.updated_at,
          },
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // POST /api/profile/upload-avatar
  async uploadAvatar(req, res, next) {
    try {
      if (!req.file) {
        return next(
          createError("VALIDATION_ERROR", "Please select a file to upload")
        );
      }

      const imagePath = `/uploads/general/${req.file.filename}`;

      const client = await pool.connect();

      try {
        // Update profile picture
        const updateQuery = `
          UPDATE user_profiles SET
            profile_picture = $1,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $2
          RETURNING profile_picture
        `;

        const result = await client.query(updateQuery, [
          imagePath,
          req.user.userId,
        ]);

        if (result.rows.length === 0) {
          return next(createError("NOT_FOUND", "User profile not found"));
        }

        const response = {
          success: true,
          message: "Profile picture updated successfully",
          data: {
            profilePicture: result.rows[0].profile_picture,
          },
        };

        res.json(response);
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }
}

export default new ProfileController();

