// src/middleware/auth.js

import { verifyJWT } from "../services/jwtService.js";
import { createError } from "../utils/errorHandler.js";

export const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw createError("UNAUTHORIZED", "Authorization token required");
    }

    const token = authHeader.substring(7);
    const decoded = verifyJWT(token);

    // Add user info to request
    req.user = {
      id: decoded.userId,
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    next(error);
  }
};

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(createError("UNAUTHORIZED", "Authentication required"));
    }

    if (!roles.includes(req.user.role)) {
      console.log("User role is: ", req.user.role);
      return next(createError("FORBIDDEN", "Insufficient permissions"));
    }

    next();
  };
};

// Role constants
export const ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  MANAGER: "manager",
  TENANT: "tenant",
};
