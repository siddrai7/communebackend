// src/controllers/jobsController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import jobScheduler from "../jobs/scheduler.js";

class JobsController {
  // GET /api/admin/jobs/status
  async getJobsStatus(req, res, next) {
    try {
      const status = jobScheduler.healthCheck();

      // Get recent job logs from database
      const client = await pool.connect();
      try {
        const recentLogsQuery = `
          SELECT job_name, execution_date, status, details, payments_created, rent_cycles_created
          FROM job_logs 
          ORDER BY execution_date DESC 
          LIMIT 10
        `;

        const logsResult = await client.query(recentLogsQuery);

        res.json({
          success: true,
          data: {
            scheduler: status,
            recentLogs: logsResult.rows,
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // GET /api/admin/jobs/logs
  async getJobLogs(req, res, next) {
    try {
      const { page = 1, limit = 50, jobName, status } = req.query;
      const offset = (page - 1) * limit;
      const client = await pool.connect();

      try {
        let query = `
          SELECT id, job_name, execution_date, status, details, error_message,
                 payments_created, rent_cycles_created, execution_duration_ms,
                 created_at
          FROM job_logs
          WHERE 1=1
        `;

        const queryParams = [];
        let paramCount = 0;

        if (jobName) {
          paramCount++;
          query += ` AND job_name = $${paramCount}`;
          queryParams.push(jobName);
        }

        if (status) {
          paramCount++;
          query += ` AND status = $${paramCount}`;
          queryParams.push(status);
        }

        query += ` ORDER BY execution_date DESC`;

        // Add pagination
        paramCount++;
        query += ` LIMIT $${paramCount}`;
        queryParams.push(limit);

        paramCount++;
        query += ` OFFSET $${paramCount}`;
        queryParams.push(offset);

        const result = await client.query(query, queryParams);

        // Get total count
        let countQuery = `SELECT COUNT(*) FROM job_logs WHERE 1=1`;
        const countParams = [];
        if (jobName) {
          countQuery += ` AND job_name = $1`;
          countParams.push(jobName);
          if (status) {
            countQuery += ` AND status = $2`;
            countParams.push(status);
          }
        } else if (status) {
          countQuery += ` AND status = $1`;
          countParams.push(status);
        }

        const countResult = await client.query(countQuery, countParams);
        const totalCount = parseInt(countResult.rows[0].count);

        res.json({
          success: true,
          data: {
            logs: result.rows,
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: totalCount,
              totalPages: Math.ceil(totalCount / limit),
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

  // POST /api/admin/jobs/trigger
  async triggerJob(req, res, next) {
    try {
      const { jobName } = req.body;

      if (!jobName) {
        throw createError("Job name is required", 400);
      }

      console.log(
        `Admin triggering job: ${jobName} by user ${req.user.userId}`
      );

      const result = await jobScheduler.triggerJob(jobName);

      res.json({
        success: true,
        message: `Job '${jobName}' triggered successfully`,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/admin/jobs/summary
  async getJobsSummary(req, res, next) {
    try {
      const client = await pool.connect();

      try {
        // Get summary statistics
        const summaryQuery = `
          SELECT 
            job_name,
            COUNT(*) as total_executions,
            COUNT(*) FILTER (WHERE status = 'completed') as successful_executions,
            COUNT(*) FILTER (WHERE status = 'failed') as failed_executions,
            SUM(payments_created) as total_payments_created,
            SUM(rent_cycles_created) as total_rent_cycles_created,
            MAX(execution_date) as last_execution,
            AVG(execution_duration_ms) as avg_duration_ms
          FROM job_logs
          GROUP BY job_name
          ORDER BY last_execution DESC
        `;

        const summaryResult = await client.query(summaryQuery);

        // Get recent activity (last 30 days)
        const recentActivityQuery = `
          SELECT 
            DATE_TRUNC('day', execution_date) as date,
            job_name,
            COUNT(*) as executions,
            SUM(payments_created) as payments_created
          FROM job_logs
          WHERE execution_date >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY DATE_TRUNC('day', execution_date), job_name
          ORDER BY date DESC
        `;

        const activityResult = await client.query(recentActivityQuery);

        res.json({
          success: true,
          data: {
            jobsSummary: summaryResult.rows,
            recentActivity: activityResult.rows,
            schedulerStatus: jobScheduler.healthCheck(),
          },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // DELETE /api/admin/jobs/logs/:logId
  async deleteJobLog(req, res, next) {
    try {
      const { logId } = req.params;
      const client = await pool.connect();

      try {
        const deleteResult = await client.query(
          "DELETE FROM job_logs WHERE id = $1 RETURNING id",
          [logId]
        );

        if (deleteResult.rows.length === 0) {
          throw createError("Job log not found", 404);
        }

        res.json({
          success: true,
          message: "Job log deleted successfully",
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // POST /api/admin/jobs/cleanup-logs
  async cleanupLogs(req, res, next) {
    try {
      const { olderThanDays = 90 } = req.body;
      const client = await pool.connect();

      try {
        const cleanupQuery = `
          DELETE FROM job_logs 
          WHERE created_at < CURRENT_DATE - INTERVAL '${parseInt(
            olderThanDays
          )} days'
          AND status = 'completed'
          RETURNING COUNT(*)
        `;

        const result = await client.query(cleanupQuery);
        const deletedCount = result.rowCount;

        res.json({
          success: true,
          message: `Cleaned up ${deletedCount} old job logs`,
          data: { deletedCount },
        });
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }
}

export default new JobsController();
