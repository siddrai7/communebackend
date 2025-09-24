import jwt from "jsonwebtoken";
import { createError } from "../utils/errorHandler.js";

// Lazy loading of environment variables
const getJWTConfig = () => {
  const JWT_SECRET = process.env.JWT_SECRET;
  const JWT_EXPIRE = process.env.JWT_EXPIRE || "7d";

  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters long");
  }

  return { JWT_SECRET, JWT_EXPIRE };
};

export const generateJWT = (payload) => {
  try {
    const { JWT_SECRET, JWT_EXPIRE } = getJWTConfig();

    const tokenPayload = {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
      iat: Math.floor(Date.now() / 1000),
    };

    return jwt.sign(tokenPayload, JWT_SECRET, {
      expiresIn: JWT_EXPIRE,
      issuer: "commune-apartments",
      audience: "commune-users",
    });
  } catch (error) {
    console.error("JWT generation error:", error);
    throw createError(
      "DATABASE_ERROR",
      "Failed to generate authentication token"
    );
  }
};

export const verifyJWT = (token) => {
  try {
    const { JWT_SECRET } = getJWTConfig();

    if (!token || typeof token !== "string") {
      throw createError("UNAUTHORIZED", "Invalid token format");
    }

    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: "commune-apartments",
      audience: "commune-users",
    });

    return decoded;
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      throw createError("UNAUTHORIZED", "Token has expired");
    }
    if (error.name === "JsonWebTokenError") {
      console.log("Error that is happening is ", error);
      throw createError("UNAUTHORIZED", "Invalid token");
    }
    if (error.name === "NotBeforeError") {
      throw createError("UNAUTHORIZED", "Token not active yet");
    }

    // Re-throw our custom errors
    if (error.statusCode) {
      throw error;
    }

    throw createError("UNAUTHORIZED", "Token verification failed");
  }
};

export const refreshJWT = (token) => {
  try {
    const decoded = verifyJWT(token);

    // Check if token is close to expiry (less than 1 day left)
    const now = Math.floor(Date.now() / 1000);
    const timeLeft = decoded.exp - now;

    if (timeLeft < 86400) {
      // Less than 24 hours
      return generateJWT({
        userId: decoded.userId,
        email: decoded.email,
        role: decoded.role,
      });
    }

    return token; // Return original token if not close to expiry
  } catch (error) {
    throw createError("UNAUTHORIZED", "Cannot refresh invalid token");
  }
};
