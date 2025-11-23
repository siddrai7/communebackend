import dotenv from "dotenv";

// Load environment variables FIRST, before any other imports
dotenv.config();

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

// Import error handler
import { globalErrorHandler } from "./utils/errorHandler.js";

// Import routes (we'll create these next)
import authRoutes from "./routes/auth.js";
import propertiesRoutes from "./routes/properties.js";
import profileRoutes from "./routes/profile.js";
import usersRoutes from "./routes/users.js";
import leadsRoutes from "./routes/leads.js";
import onboardingRoutes from "./routes/onboarding.js";
import jobsRoutes from "./routes/jobs.js";
import tenantsRouter from "./routes/tenants.js";
import complaintRouters from "./routes/complaints.js";
import announcementRoutes from "./routes/announcements.js";
import rentRoutes from "./routes/rents.js";
import dashboardRoutes from "./routes/dashboard.js";
import offboardingRoutes from "./routes/offboarding.js";

// Import job scheduler
import jobScheduler from "./jobs/scheduler.js";
// Get directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8000;

// Security middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// CORS configuration
const allowedOrigins = [
  "http://localhost:3000",
  "https://commune-4718a.web.app",
  "https://proflow.lancehawks.com/",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Rate limiting
if (process.env.NODE_ENV !== "development") {
  const limiter = rateLimit({
    windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000,
    max: process.env.RATE_LIMIT_MAX_REQUESTS || 100,
    message: {
      success: false,
      message: "Too many requests, please try again later.",
    },
  });
  app.use("/api", limiter);
}

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Compression
app.use(compression());

// Logging
if (process.env.NODE_ENV === "development") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

// Serve static files
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Root route
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Welcome to Commune Apartments",
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Commune Apartments API is running",
    timestamp: new Date().toISOString(),
    jobs: jobScheduler.healthCheck(),
    environment: process.env.NODE_ENV,
  });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/properties", propertiesRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/leads", leadsRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/admin/jobs", jobsRoutes);
app.use("/api/tenant", tenantsRouter);
app.use("/api/complaints", complaintRouters);
app.use("/api/announcements", announcementRoutes);
app.use("/api/rent-collection", rentRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/offboarding", offboardingRoutes);

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// Global error handler
app.use(globalErrorHandler);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("👋 SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("👋 SIGINT received, shutting down gracefully");
  process.exit(0);
});

// Start server
app.listen(PORT, async () => {
  console.log("🚀 Commune Apartments Backend Server Started");
  console.log(`📍 Server running on: http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
  console.log(`📊 Database: ${process.env.DB_NAME}`);
  console.log(`⏰ Started at: ${new Date().toISOString()}`);

  // Initialize job scheduler after server starts
  try {
    await jobScheduler.initialize();
    console.log("✅ Job scheduler initialized successfully");
  } catch (error) {
    console.error("❌ Failed to initialize job scheduler:", error);
    // Don't exit the server if jobs fail to initialize
    // The server can still serve API requests
  }
});

export default app;
