// src/config/database.js

import pkg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pkg;

// SSL configuration
const sslConfig =
  process.env.DB_SSL === "true"
    ? {
        rejectUnauthorized: false,
        sslmode: "require",
      }
    : false;

// const pool = new Pool({
//   host: process.env.DB_HOST,
//   port: process.env.DB_PORT,
//   database: process.env.DB_NAME,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   ssl: sslConfig,
//   max: 10, // Reduced max connections
//   min: 5, // Keep more connections always ready
//   idleTimeoutMillis: 0, // Never close idle connections
//   connectionTimeoutMillis: 30000, // 30 seconds
//   acquireTimeoutMillis: 30000, // 30 seconds
//   reapIntervalMillis: 0, // Don't reap connections
//   createTimeoutMillis: 30000, // 30 seconds to create a connection
//   destroyTimeoutMillis: 5000, // 5 seconds to destroy a connection
//   createRetryIntervalMillis: 200, // Retry every 200ms
//   propagateCreateError: false, // Don't propagate connection errors
//   // Keep connections alive
//   keepAlive: true,
//   keepAliveInitialDelayMillis: 10000, // Start keep-alive after 10 seconds
// });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: sslConfig,
});

// Test connection
pool.on("connect", () => {
  console.log("📊 Connected to PostgreSQL database");
});

pool.on("error", (err) => {
  console.error("💥 Database pool error:", err);
  // Don't exit the process, just log the error
  // The pool will handle reconnection automatically
});

// Handle individual client errors
pool.on("acquire", (client) => {
  client.on("error", (err) => {
    console.error("💥 Database client error:", err);
    // Don't manually release - let the pool handle it
    // The client will be automatically removed from the pool
  });
});

// Keep connections alive with periodic pings
const keepConnectionsAlive = async () => {
  let client;
  try {
    client = await pool.connect();
    await client.query("SELECT 1");
    console.log("💓 Database connection ping successful");
  } catch (error) {
    console.error("💔 Database connection ping failed:", error.message);
  } finally {
    if (client) {
      try {
        client.release();
      } catch (releaseError) {
        console.error(
          "💔 Failed to release ping client:",
          releaseError.message
        );
      }
    }
  }
};

// Ping every 5 minutes to keep connections alive
setInterval(keepConnectionsAlive, 5 * 60 * 1000);

// Initial ping after 30 seconds
setTimeout(keepConnectionsAlive, 30000);

// Health check function
export const testConnection = async () => {
  try {
    const client = await pool.connect();
    await client.query("SELECT NOW()");
    client.release();
    console.log("✅ Database connection test successful");
    return true;
  } catch (error) {
    console.error("❌ Database connection test failed:", error.message);
    return false;
  }
};

export default pool;
