class AppError extends Error {
  constructor(message, statusCode, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
    this.isOperational = true;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }
}

const errorTypes = {
  VALIDATION_ERROR: (message) => new AppError(message, 400, "VALIDATION_ERROR"),
  UNAUTHORIZED: (message) => new AppError(message, 401, "UNAUTHORIZED"),
  FORBIDDEN: (message) => new AppError(message, 403, "FORBIDDEN"),
  NOT_FOUND: (message) => new AppError(message, 404, "NOT_FOUND"),
  CONFLICT: (message) => new AppError(message, 409, "CONFLICT"),
  DATABASE_ERROR: (message) => new AppError(message, 500, "DATABASE_ERROR"),
  EMAIL_ERROR: (message) => new AppError(message, 500, "EMAIL_ERROR"),
  FILE_ERROR: (message) => new AppError(message, 400, "FILE_ERROR"),
};

const createError = (type, message) => {
  const errorFunc = errorTypes[type];
  if (!errorFunc) {
    return new AppError(message, 500, "UNKNOWN_ERROR");
  }
  return errorFunc(message);
};

const globalErrorHandler = (err, req, res, next) => {
  let { statusCode = 500, message, code } = err;

  // Log error
  console.error(`💥 Error ${statusCode}:`, message);
  if (process.env.NODE_ENV === "development") {
    
    console.error(err.stack);
  }

  // Database specific errors
  if (err.code === "23505") {
    statusCode = 409;
    message = "Duplicate entry. Resource already exists.";
    code = "DUPLICATE_ERROR";
  }

  if (err.code === "23503") {
    statusCode = 400;
    message = "Invalid reference. Related resource not found.";
    code = "FOREIGN_KEY_ERROR";
  }

  if (err.code === "23502") {
    statusCode = 400;
    message = "Missing required field.";
    code = "NULL_VIOLATION";
  }

  // JWT specific errors
  if (err.name === "JsonWebTokenError") {
    statusCode = 401;
    message = "Invalid token";
    code = "INVALID_TOKEN";
  }

  if (err.name === "TokenExpiredError") {
    statusCode = 401;
    message = "Token expired";
    code = "TOKEN_EXPIRED";
  }

  // Send error response
  const response = {
    success: false,
    message,
    code,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  };

  res.status(statusCode).json(response);
};

export { AppError, createError, globalErrorHandler };
