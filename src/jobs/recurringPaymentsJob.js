// src/jobs/recurringPaymentsJob.js
import pool from "../config/database.js";
import cron from "node-cron";

class RecurringPaymentsJob {
  constructor() {
    this.isRunning = false;
  }

  // Main job function to create monthly rent payments
  async createMonthlyRentPayments() {
    if (this.isRunning) {
      console.log("Recurring payments job is already running, skipping...");
      return;
    }

    console.log("🕐 Starting recurring payments job...");
    this.isRunning = true;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const currentDate = new Date();
      const currentMonth = currentDate.getMonth() + 1; // 1-12
      const currentYear = currentDate.getFullYear();
      const firstOfMonth = new Date(currentYear, currentDate.getMonth(), 1);
      const dueDate = firstOfMonth.toISOString().split("T")[0];

      console.log(
        `📅 Creating rent payments for ${currentMonth}/${currentYear}`
      );

      // Get all active tenancies that don't have payments for current month
      const activetenanciesQuery = `
        SELECT DISTINCT
          t.id as tenancy_id,
          t.tenant_user_id,
          t.rent_amount,
          t.start_date,
          t.end_date,
          u.unit_number,
          r.room_number,
          b.name as building_name,
          up.first_name,
          up.last_name,
          usr.email
        FROM tenancies t
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        JOIN users usr ON t.tenant_user_id = usr.id
        JOIN user_profiles up ON usr.id = up.user_id
        WHERE t.start_date <= $1::date
          AND (t.end_date IS NULL OR t.end_date >= $1::date)
          AND usr.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM rent_cycles rc 
            WHERE rc.tenancy_id = t.id 
              AND rc.cycle_month = $2 
              AND rc.cycle_year = $3
          )
          AND NOT EXISTS (
            SELECT 1 FROM payments p 
            WHERE p.tenancy_id = t.id 
              AND p.payment_type = 'rent'
              AND EXTRACT(MONTH FROM p.due_date) = $2
              AND EXTRACT(YEAR FROM p.due_date) = $3
          )
      `;

      const tenanciesResult = await client.query(activetenanciesQuery, [
        dueDate,
        currentMonth,
        currentYear,
      ]);

      const activeTenancies = tenanciesResult.rows;
      console.log(
        `📊 Found ${activeTenancies.length} active tenancies for payment generation`
      );

      let paymentsCreated = 0;
      let rentCyclesCreated = 0;

      for (const tenancy of activeTenancies) {
        try {
          // Create payment record
          const createPaymentQuery = `
            INSERT INTO payments (
              tenancy_id, payment_type, amount, due_date, status, notes, created_at, updated_at
            ) VALUES ($1, 'rent', $2, $3, 'pending', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING id
          `;

          const paymentResult = await client.query(createPaymentQuery, [
            tenancy.tenancy_id,
            tenancy.rent_amount,
            dueDate,
            `Monthly rent for ${currentMonth}/${currentYear} - Unit ${tenancy.unit_number}`,
          ]);

          paymentsCreated++;

          // Create rent cycle record
          const createRentCycleQuery = `
            INSERT INTO rent_cycles (
              tenancy_id, cycle_month, cycle_year, rent_amount, due_date,
              payment_status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING id
          `;

          await client.query(createRentCycleQuery, [
            tenancy.tenancy_id,
            currentMonth,
            currentYear,
            tenancy.rent_amount,
            dueDate,
          ]);

          rentCyclesCreated++;

          console.log(
            `✅ Created payment for ${tenancy.first_name} ${tenancy.last_name} - Unit ${tenancy.unit_number} - ₹${tenancy.rent_amount}`
          );
        } catch (tenancyError) {
          console.error(
            `❌ Error creating payment for tenancy ${tenancy.tenancy_id}:`,
            tenancyError.message
          );
          // Continue with other tenancies even if one fails
        }
      }

      // Log job execution
      const logJobQuery = `
        INSERT INTO job_logs (
          job_name, execution_date, status, details, payments_created, rent_cycles_created,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;

      await client.query(logJobQuery, [
        "recurring_payments",
        currentDate.toISOString(),
        "completed",
        `Successfully created ${paymentsCreated} payments and ${rentCyclesCreated} rent cycles for ${currentMonth}/${currentYear}`,
        paymentsCreated,
        rentCyclesCreated,
      ]);

      await client.query("COMMIT");

      console.log(`🎉 Recurring payments job completed successfully!`);
      console.log(
        `📈 Summary: ${paymentsCreated} payments created, ${rentCyclesCreated} rent cycles created`
      );

      return {
        success: true,
        paymentsCreated,
        rentCyclesCreated,
        month: currentMonth,
        year: currentYear,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("❌ Recurring payments job failed:", error);

      // Log failed job execution
      try {
        const logFailedJobQuery = `
          INSERT INTO job_logs (
            job_name, execution_date, status, error_message, created_at, updated_at
          ) VALUES ($1, $2, 'failed', $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;

        await client.query(logFailedJobQuery, [
          "recurring_payments",
          new Date().toISOString(),
          error.message,
        ]);
      } catch (logError) {
        console.error("Failed to log job error:", logError);
      }

      throw error;
    } finally {
      client.release();
      this.isRunning = false;
    }
  }

  // Schedule the job to run on 1st of every month at 00:30 AM
  startScheduler() {
    console.log("🚀 Starting recurring payments scheduler...");

    // Run on 1st of every month at 00:30 AM
    cron.schedule(
      "30 0 1 * *",
      async () => {
        console.log("⏰ Cron triggered: Creating monthly rent payments");
        try {
          await this.createMonthlyRentPayments();
        } catch (error) {
          console.error("Scheduled job failed:", error);
        }
      },
      {
        scheduled: true,
        timezone: "Asia/Kolkata",
      }
    );

    console.log(
      "📅 Recurring payments scheduler started - will run on 1st of every month at 00:30 AM IST"
    );
  }

  // Manual trigger for testing or admin use
  async triggerManually() {
    console.log("🔧 Manually triggering recurring payments job...");
    return await this.createMonthlyRentPayments();
  }

  // Stop the scheduler
  stopScheduler() {
    // Note: node-cron doesn't provide direct stop method for specific jobs
    // You would need to keep reference to the task if you want to stop it
    console.log("⏹️ Recurring payments scheduler stopped");
  }
}

export default new RecurringPaymentsJob();
