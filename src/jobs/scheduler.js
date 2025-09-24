// src/jobs/scheduler.js
import recurringPaymentsJob from "./recurringPaymentsJob.js";

class JobScheduler {
  constructor() {
    this.jobs = {};
    this.isInitialized = false;
  }

  // Initialize and start all scheduled jobs
  async initialize() {
    if (this.isInitialized) {
      console.log("Job scheduler already initialized");
      return;
    }

    console.log("🚀 Initializing job scheduler...");

    try {
      // Register recurring payments job
      this.jobs.recurringPayments = recurringPaymentsJob;

      // Start the scheduler
      recurringPaymentsJob.startScheduler();

      this.isInitialized = true;
      console.log("✅ Job scheduler initialized successfully");

      // Log registered jobs
      const jobNames = Object.keys(this.jobs);
      console.log(`📋 Registered jobs: ${jobNames.join(", ")}`);
    } catch (error) {
      console.error("❌ Failed to initialize job scheduler:", error);
      throw error;
    }
  }

  // Manually trigger a specific job (useful for testing or admin actions)
  async triggerJob(jobName) {
    if (!this.jobs[jobName]) {
      throw new Error(`Job '${jobName}' not found`);
    }

    console.log(`🔧 Manually triggering job: ${jobName}`);

    try {
      const result = await this.jobs[jobName].triggerManually();
      console.log(`✅ Job '${jobName}' completed successfully`);
      return result;
    } catch (error) {
      console.error(`❌ Job '${jobName}' failed:`, error);
      throw error;
    }
  }

  // Get status of all jobs
  getJobsStatus() {
    const status = {};

    Object.keys(this.jobs).forEach((jobName) => {
      status[jobName] = {
        registered: true,
        running: this.jobs[jobName].isRunning || false,
      };
    });

    return status;
  }

  // Stop all jobs
  stopAllJobs() {
    console.log("⏹️ Stopping all scheduled jobs...");

    Object.keys(this.jobs).forEach((jobName) => {
      try {
        if (this.jobs[jobName].stopScheduler) {
          this.jobs[jobName].stopScheduler();
        }
      } catch (error) {
        console.error(`Error stopping job ${jobName}:`, error);
      }
    });

    this.isInitialized = false;
    console.log("✅ All jobs stopped");
  }

  // Health check for job scheduler
  healthCheck() {
    return {
      initialized: this.isInitialized,
      jobsCount: Object.keys(this.jobs).length,
      jobs: this.getJobsStatus(),
      timestamp: new Date().toISOString(),
    };
  }
}

export default new JobScheduler();
