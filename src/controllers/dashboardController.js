// src/controllers/dashboardController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";

class DashboardController {
  /**
   * Get building IDs accessible to the current user based on role
   */
  static async getAccessibleBuildingIds(userId, userRole) {
    if (userRole === "super_admin" || userRole === "admin") {
      // Super admin and admin can access all buildings
      const result = await pool.query(
        "SELECT id FROM buildings WHERE status = $1 ORDER BY name",
        ["active"]
      );
      return result.rows.map((row) => row.id);
    } else if (userRole === "manager") {
      // Manager can only access buildings they manage
      const result = await pool.query(
        "SELECT id FROM buildings WHERE manager_id = $1 AND status = $2 ORDER BY name",
        [userId, "active"]
      );
      return result.rows.map((row) => row.id);
    }
    return [];
  }

  /**
   * GET /api/dashboard/overview
   * Get role-based dashboard overview data
   */
  static async getOverview(req, res, next) {
    try {
      const { building_id, period = "month" } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      // Get accessible building IDs
      const accessibleBuildingIds = await DashboardController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            summary: {
              totalBuildings: 0,
              totalUnits: 0,
              occupiedUnits: 0,
              occupancyRate: 0,
              monthlyRevenue: 0,
              activeComplaints: 0,
              activeTenants: 0,
              pendingMaintenance: 0,
            },
            trends: {},
            role: userRole,
          },
        });
      }

      let buildingFilter = "";
      let params = [accessibleBuildingIds];
      let paramIndex = 2;

      // Additional building filter if specified
      if (building_id && accessibleBuildingIds.includes(parseInt(building_id))) {
        buildingFilter = ` AND b.id = $${paramIndex}`;
        params.push(parseInt(building_id));
        paramIndex++;
      }

      // Get current date for period calculations
      const currentDate = new Date();
      const currentMonth = currentDate.getMonth() + 1;
      const currentYear = currentDate.getFullYear();

      // Main overview query
      const overviewQuery = `
        WITH building_stats AS (
          SELECT 
            COUNT(DISTINCT b.id) as total_buildings,
            COUNT(DISTINCT u.id) as total_units,
            COUNT(DISTINCT CASE 
              WHEN EXISTS (
                SELECT 1 FROM tenancies t2 
                WHERE t2.unit_id = u.id 
                AND t2.agreement_status = 'executed'
                AND CURRENT_DATE >= t2.start_date 
                AND CURRENT_DATE <= t2.end_date
              ) THEN u.id 
            END) as occupied_units
          FROM buildings b
          LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
          LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
          LEFT JOIN units u ON r.id = u.room_id
          WHERE b.id = ANY($1) ${buildingFilter}
        ),
        revenue_stats AS (
          SELECT 
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) as monthly_revenue_collected,
            COALESCE(SUM(p.amount), 0) as monthly_revenue_due
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND p.due_date >= '${currentYear}-${currentMonth.toString().padStart(2, '0')}-01'
          AND p.due_date < '${currentMonth === 12 ? currentYear + 1 : currentYear}-${(currentMonth === 12 ? 1 : currentMonth + 1).toString().padStart(2, '0')}-01'
        ),
        complaint_stats AS (
          SELECT 
            COUNT(*) as active_complaints
          FROM complaints c
          JOIN buildings b ON c.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND c.status NOT IN ('resolved', 'closed')
        ),
        tenant_stats AS (
          SELECT 
            COUNT(DISTINCT t.tenant_user_id) as active_tenants
          FROM tenancies t
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND t.agreement_status = 'executed'
          AND CURRENT_DATE >= t.start_date 
          AND CURRENT_DATE <= t.end_date
        ),
        maintenance_stats AS (
          SELECT 
            COUNT(*) as pending_maintenance
          FROM maintenance_requests mr
          JOIN rooms r ON mr.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND mr.status IN ('pending', 'assigned', 'in_progress')
        )
        SELECT 
          bs.*,
          rs.monthly_revenue_collected,
          rs.monthly_revenue_due,
          cs.active_complaints,
          ts.active_tenants,
          ms.pending_maintenance
        FROM building_stats bs, revenue_stats rs, complaint_stats cs, tenant_stats ts, maintenance_stats ms
      `;

      const overviewResult = await pool.query(overviewQuery, params);
      const overview = overviewResult.rows[0];

      const occupancyRate = overview.total_units > 0 
        ? ((overview.occupied_units / overview.total_units) * 100).toFixed(2)
        : 0;

      // Get trend data for the specified period
      let trendQuery = "";
      let trendParams = [accessibleBuildingIds];
      
      if (period === "month") {
        trendQuery = `
          SELECT 
            DATE_TRUNC('day', p.due_date) as date,
            SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END) as revenue,
            COUNT(DISTINCT CASE WHEN p.status = 'paid' THEN p.id END) as payments
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND p.due_date >= CURRENT_DATE - INTERVAL '30 days'
          GROUP BY DATE_TRUNC('day', p.due_date)
          ORDER BY date
        `;
      }

      const trendResult = await pool.query(trendQuery, trendParams);

      const response = {
        success: true,
        data: {
          summary: {
            totalBuildings: parseInt(overview.total_buildings) || 0,
            totalUnits: parseInt(overview.total_units) || 0,
            occupiedUnits: parseInt(overview.occupied_units) || 0,
            occupancyRate: parseFloat(occupancyRate),
            monthlyRevenue: parseFloat(overview.monthly_revenue_collected) || 0,
            monthlyRevenueDue: parseFloat(overview.monthly_revenue_due) || 0,
            activeComplaints: parseInt(overview.active_complaints) || 0,
            activeTenants: parseInt(overview.active_tenants) || 0,
            pendingMaintenance: parseInt(overview.pending_maintenance) || 0,
          },
          trends: {
            revenue: trendResult.rows.map(row => ({
              date: row.date,
              amount: parseFloat(row.revenue) || 0,
              payments: parseInt(row.payments) || 0,
            }))
          },
          role: userRole,
          period,
          accessible_buildings: accessibleBuildingIds.length,
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching dashboard overview:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch dashboard overview"));
    }
  }

  /**
   * GET /api/dashboard/stats
   * Get key performance indicators and statistics
   */
  static async getStats(req, res, next) {
    try {
      const { building_id, month, year } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      const accessibleBuildingIds = await DashboardController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            kpis: {
              occupancy: { current: 0, target: 95, trend: "stable" },
              collection: { current: 0, target: 98, trend: "stable" },
              satisfaction: { current: 0, target: 4.5, trend: "stable" },
              responseTime: { current: 0, target: 24, trend: "stable" },
            },
            buildingPerformance: [],
          },
        });
      }

      let buildingFilter = "";
      let params = [accessibleBuildingIds];
      let paramIndex = 2;

      if (building_id && accessibleBuildingIds.includes(parseInt(building_id))) {
        buildingFilter = ` AND b.id = $${paramIndex}`;
        params.push(parseInt(building_id));
        paramIndex++;
      }

      const currentDate = new Date();
      const targetMonth = month ? parseInt(month) : currentDate.getMonth() + 1;
      const targetYear = year ? parseInt(year) : currentDate.getFullYear();

      // KPI calculation query
      const kpiQuery = `
        WITH occupancy_kpi AS (
          SELECT 
            COUNT(DISTINCT u.id) as total_units,
            COUNT(DISTINCT CASE 
              WHEN EXISTS (
                SELECT 1 FROM tenancies t2 
                WHERE t2.unit_id = u.id 
                AND t2.agreement_status = 'executed'
                AND CURRENT_DATE >= t2.start_date 
                AND CURRENT_DATE <= t2.end_date
              ) THEN u.id 
            END) as occupied_units
          FROM buildings b
          LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
          LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
          LEFT JOIN units u ON r.id = u.room_id
          WHERE b.id = ANY($1) ${buildingFilter}
        ),
        collection_kpi AS (
          SELECT 
            COALESCE(SUM(p.amount), 0) as total_due,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) as total_collected
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND p.due_date >= '${targetYear}-${targetMonth.toString().padStart(2, '0')}-01'
          AND p.due_date < '${targetMonth === 12 ? targetYear + 1 : targetYear}-${(targetMonth === 12 ? 1 : targetMonth + 1).toString().padStart(2, '0')}-01'
        ),
        satisfaction_kpi AS (
          SELECT 
            AVG(c.tenant_satisfaction_rating) as avg_rating
          FROM complaints c
          JOIN buildings b ON c.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND c.tenant_satisfaction_rating IS NOT NULL
          AND c.created_at >= CURRENT_DATE - INTERVAL '3 months'
        ),
        response_time_kpi AS (
          SELECT 
            AVG(EXTRACT(EPOCH FROM (c.acknowledged_at - c.created_at))/3600) as avg_response_hours
          FROM complaints c
          JOIN buildings b ON c.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND c.acknowledged_at IS NOT NULL
          AND c.created_at >= CURRENT_DATE - INTERVAL '1 month'
        )
        SELECT 
          ok.*,
          ck.total_due,
          ck.total_collected,
          sk.avg_rating,
          rk.avg_response_hours
        FROM occupancy_kpi ok, collection_kpi ck, satisfaction_kpi sk, response_time_kpi rk
      `;

      const kpiResult = await pool.query(kpiQuery, params);
      const kpiData = kpiResult.rows[0];

      const occupancyRate = kpiData.total_units > 0 
        ? ((kpiData.occupied_units / kpiData.total_units) * 100).toFixed(2) 
        : 0;

      const collectionRate = kpiData.total_due > 0 
        ? ((kpiData.total_collected / kpiData.total_due) * 100).toFixed(2) 
        : 0;

      // Building performance for admin/superadmin
      let buildingPerformance = [];
      if (userRole === "super_admin" || userRole === "admin") {
        const buildingQuery = `
          SELECT 
            b.id,
            b.name,
            COUNT(DISTINCT u.id) as total_units,
            COUNT(DISTINCT CASE 
              WHEN EXISTS (
                SELECT 1 FROM tenancies t2 
                WHERE t2.unit_id = u.id 
                AND t2.agreement_status = 'executed'
                AND CURRENT_DATE >= t2.start_date 
                AND CURRENT_DATE <= t2.end_date
              ) THEN u.id 
            END) as occupied_units,
            COALESCE(SUM(CASE WHEN bp.status = 'paid' THEN bp.amount ELSE 0 END), 0) as revenue_collected,
            COUNT(DISTINCT CASE WHEN bc.status NOT IN ('resolved', 'closed') THEN bc.id END) as active_complaints
          FROM buildings b
          LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
          LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
          LEFT JOIN units u ON r.id = u.room_id
          LEFT JOIN tenancies t ON u.id = t.unit_id AND t.agreement_status = 'executed'
          LEFT JOIN payments bp ON t.id = bp.tenancy_id 
            AND bp.due_date >= '${targetYear}-${targetMonth.toString().padStart(2, '0')}-01'
            AND bp.due_date < '${targetMonth === 12 ? targetYear + 1 : targetYear}-${(targetMonth === 12 ? 1 : targetMonth + 1).toString().padStart(2, '0')}-01'
          LEFT JOIN complaints bc ON b.id = bc.building_id
          WHERE b.id = ANY($1) ${buildingFilter}
          GROUP BY b.id, b.name
          ORDER BY b.name
        `;

        const buildingResult = await pool.query(buildingQuery, params);
        buildingPerformance = buildingResult.rows.map(building => ({
          id: building.id,
          name: building.name,
          occupancyRate: building.total_units > 0 
            ? ((building.occupied_units / building.total_units) * 100).toFixed(2)
            : 0,
          revenue: parseFloat(building.revenue_collected) || 0,
          activeComplaints: parseInt(building.active_complaints) || 0,
          totalUnits: parseInt(building.total_units) || 0,
          occupiedUnits: parseInt(building.occupied_units) || 0,
        }));
      }

      const response = {
        success: true,
        data: {
          kpis: {
            occupancy: {
              current: parseFloat(occupancyRate),
              target: 95,
              trend: parseFloat(occupancyRate) >= 95 ? "positive" : "stable",
            },
            collection: {
              current: parseFloat(collectionRate),
              target: 98,
              trend: parseFloat(collectionRate) >= 98 ? "positive" : "stable",
            },
            satisfaction: {
              current: parseFloat(kpiData.avg_rating) || 0,
              target: 4.5,
              trend: parseFloat(kpiData.avg_rating) >= 4.5 ? "positive" : "stable",
            },
            responseTime: {
              current: parseFloat(kpiData.avg_response_hours) || 0,
              target: 24,
              trend: parseFloat(kpiData.avg_response_hours) <= 24 ? "positive" : "negative",
            },
          },
          buildingPerformance,
          role: userRole,
          period: { month: targetMonth, year: targetYear },
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching dashboard stats:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch dashboard stats"));
    }
  }

  /**
   * GET /api/dashboard/recent-activity
   * Get recent system activities based on user role
   */
  static async getRecentActivity(req, res, next) {
    try {
      const { limit = 20, building_id } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      const accessibleBuildingIds = await DashboardController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: { activities: [] },
        });
      }

      let buildingFilter = "";
      let params = [accessibleBuildingIds, parseInt(limit)];
      let paramIndex = 3;

      if (building_id && accessibleBuildingIds.includes(parseInt(building_id))) {
        buildingFilter = ` AND b.id = $${paramIndex}`;
        params.push(parseInt(building_id));
        paramIndex++;
      }

      // Get recent activities from various sources
      const activitiesQuery = `
        (
          SELECT 
            'payment' as type,
            p.id as reference_id,
            'Payment received for unit ' || u.unit_number || ' - ' || b.name as description,
            p.payment_date as activity_time,
            up.first_name || ' ' || up.last_name as actor_name,
            'tenant' as actor_type,
            b.name as building_name
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          JOIN users usr ON t.tenant_user_id = usr.id
          JOIN user_profiles up ON usr.id = up.user_id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE p.status = 'paid' 
          AND p.payment_date IS NOT NULL
          AND b.id = ANY($1) ${buildingFilter}
          AND p.payment_date >= CURRENT_DATE - INTERVAL '7 days'
        )
        UNION ALL
        (
          SELECT 
            'complaint' as type,
            c.id as reference_id,
            'New complaint: ' || c.title || ' - ' || b.name as description,
            c.created_at as activity_time,
            up.first_name || ' ' || up.last_name as actor_name,
            'tenant' as actor_type,
            b.name as building_name
          FROM complaints c
          JOIN users usr ON c.tenant_user_id = usr.id
          JOIN user_profiles up ON usr.id = up.user_id
          JOIN buildings b ON c.building_id = b.id
          WHERE b.id = ANY($1) ${buildingFilter}
          AND c.created_at >= CURRENT_DATE - INTERVAL '7 days'
        )
        UNION ALL
        (
          SELECT 
            'tenancy' as type,
            t.id as reference_id,
            'New tenant onboarded: ' || up.first_name || ' ' || up.last_name || ' - Unit ' || u.unit_number as description,
            t.move_in_date as activity_time,
            up.first_name || ' ' || up.last_name as actor_name,
            'tenant' as actor_type,
            b.name as building_name
          FROM tenancies t
          JOIN users usr ON t.tenant_user_id = usr.id
          JOIN user_profiles up ON usr.id = up.user_id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE t.move_in_date IS NOT NULL
          AND b.id = ANY($1) ${buildingFilter}
          AND t.move_in_date >= CURRENT_DATE - INTERVAL '7 days'
        )
        ORDER BY activity_time DESC
        LIMIT $2
      `;

      const activitiesResult = await pool.query(activitiesQuery, params);

      const activities = activitiesResult.rows.map(activity => ({
        id: activity.reference_id,
        type: activity.type,
        description: activity.description,
        activityTime: activity.activity_time,
        actorName: activity.actor_name,
        actorType: activity.actor_type,
        buildingName: activity.building_name,
        timeAgo: DashboardController.getTimeAgo(activity.activity_time),
      }));

      res.json({
        success: true,
        data: {
          activities,
          total: activities.length,
          role: userRole,
        },
      });
    } catch (error) {
      console.error("Error fetching recent activity:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch recent activity"));
    }
  }

  /**
   * GET /api/dashboard/alerts
   * Get role-based alerts and notifications
   */
  static async getAlerts(req, res, next) {
    try {
      const { priority, category, building_id } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      const accessibleBuildingIds = await DashboardController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: { alerts: [], summary: { total: 0, high: 0, urgent: 0 } },
        });
      }

      let buildingFilter = "";
      let params = [accessibleBuildingIds];
      let paramIndex = 2;

      if (building_id && accessibleBuildingIds.includes(parseInt(building_id))) {
        buildingFilter = ` AND b.id = $${paramIndex}`;
        params.push(parseInt(building_id));
        paramIndex++;
      }

      // Generate alerts based on various conditions
      const alertsQuery = `
        WITH rent_alerts AS (
          SELECT 
            'rent' as category,
            'urgent' as priority,
            'Overdue rent payments (' || COUNT(*) || ')' as title,
            'There are ' || COUNT(*) || ' overdue rent payments requiring immediate attention' as message,
            COUNT(*) as count,
            b.name as building_name,
            b.id as building_id
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE p.due_date < CURRENT_DATE - INTERVAL '7 days'
          AND p.status != 'paid'
          AND b.id = ANY($1) ${buildingFilter}
          GROUP BY b.id, b.name
          HAVING COUNT(*) > 0
        ),
        complaint_alerts AS (
          SELECT 
            'complaints' as category,
            CASE 
              WHEN COUNT(*) > 10 THEN 'urgent'
              WHEN COUNT(*) > 5 THEN 'high'
              ELSE 'medium'
            END as priority,
            'Pending complaints (' || COUNT(*) || ')' as title,
            'There are ' || COUNT(*) || ' unresolved complaints that need attention' as message,
            COUNT(*) as count,
            b.name as building_name,
            b.id as building_id
          FROM complaints c
          JOIN buildings b ON c.building_id = b.id
          WHERE c.status NOT IN ('resolved', 'closed')
          AND b.id = ANY($1) ${buildingFilter}
          GROUP BY b.id, b.name
          HAVING COUNT(*) > 2
        ),
        maintenance_alerts AS (
          SELECT 
            'maintenance' as category,
            CASE 
              WHEN COUNT(*) > 15 THEN 'urgent'
              WHEN COUNT(*) > 8 THEN 'high'
              ELSE 'medium'
            END as priority,
            'Pending maintenance (' || COUNT(*) || ')' as title,
            'There are ' || COUNT(*) || ' pending maintenance requests' as message,
            COUNT(*) as count,
            b.name as building_name,
            b.id as building_id
          FROM maintenance_requests mr
          JOIN rooms r ON mr.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE mr.status IN ('pending', 'assigned', 'in_progress')
          AND b.id = ANY($1) ${buildingFilter}
          GROUP BY b.id, b.name
          HAVING COUNT(*) > 3
        ),
        occupancy_alerts AS (
          SELECT 
            'system' as category,
            'medium' as priority,
            'Low occupancy - ' || b.name as title,
            'Building occupancy is ' || ROUND((occupied_units::decimal / total_units * 100), 1) || '% (below 80%)' as message,
            1 as count,
            b.name as building_name,
            b.id as building_id
          FROM (
            SELECT 
              b.id,
              b.name,
              COUNT(DISTINCT u.id) as total_units,
              COUNT(DISTINCT CASE 
                WHEN EXISTS (
                  SELECT 1 FROM tenancies t2 
                  WHERE t2.unit_id = u.id 
                  AND t2.agreement_status = 'executed'
                  AND CURRENT_DATE >= t2.start_date 
                  AND CURRENT_DATE <= t2.end_date
                ) THEN u.id 
              END) as occupied_units
            FROM buildings b
            LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
            LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
            LEFT JOIN units u ON r.id = u.room_id
            WHERE b.id = ANY($1) ${buildingFilter}
            GROUP BY b.id, b.name
          ) occupancy_data
          WHERE total_units > 0 
          AND (occupied_units::decimal / total_units) < 0.8
        )
        SELECT * FROM rent_alerts
        UNION ALL
        SELECT * FROM complaint_alerts
        UNION ALL
        SELECT * FROM maintenance_alerts
        UNION ALL
        SELECT * FROM occupancy_alerts
        ORDER BY 
          CASE priority
            WHEN 'urgent' THEN 1
            WHEN 'high' THEN 2
            WHEN 'medium' THEN 3
            ELSE 4
          END,
          count DESC
      `;

      const alertsResult = await pool.query(alertsQuery, params);

      // Filter by priority and category if specified
      let alerts = alertsResult.rows;
      if (priority) {
        alerts = alerts.filter(alert => alert.priority === priority);
      }
      if (category) {
        alerts = alerts.filter(alert => alert.category === category);
      }

      const summary = {
        total: alerts.length,
        urgent: alerts.filter(alert => alert.priority === 'urgent').length,
        high: alerts.filter(alert => alert.priority === 'high').length,
        medium: alerts.filter(alert => alert.priority === 'medium').length,
      };

      res.json({
        success: true,
        data: {
          alerts: alerts.map(alert => ({
            category: alert.category,
            priority: alert.priority,
            title: alert.title,
            message: alert.message,
            count: parseInt(alert.count),
            buildingName: alert.building_name,
            buildingId: alert.building_id,
            createdAt: new Date().toISOString(),
          })),
          summary,
          role: userRole,
          filters: { priority, category, building_id },
        },
      });
    } catch (error) {
      console.error("Error fetching alerts:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch alerts"));
    }
  }

  /**
   * GET /api/dashboard/financial-summary
   * Get financial overview - admin/superadmin focused
   */
  static async getFinancialSummary(req, res, next) {
    try {
      const { period = "month", building_id } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      const accessibleBuildingIds = await DashboardController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            summary: {
              totalRevenue: 0,
              totalExpenses: 0,
              netIncome: 0,
              collectionRate: 0,
            },
            breakdown: { buildings: [], categories: [] },
          },
        });
      }

      let buildingFilter = "";
      let params = [accessibleBuildingIds];
      let paramIndex = 2;

      if (building_id && accessibleBuildingIds.includes(parseInt(building_id))) {
        buildingFilter = ` AND b.id = $${paramIndex}`;
        params.push(parseInt(building_id));
        paramIndex++;
      }

      // Calculate period dates
      const currentDate = new Date();
      let startDate, endDate;

      switch (period) {
        case "quarter":
          const quarterStart = new Date(currentDate.getFullYear(), Math.floor(currentDate.getMonth() / 3) * 3, 1);
          startDate = quarterStart.toISOString().split('T')[0];
          endDate = new Date(quarterStart.getFullYear(), quarterStart.getMonth() + 3, 0).toISOString().split('T')[0];
          break;
        case "year":
          startDate = `${currentDate.getFullYear()}-01-01`;
          endDate = `${currentDate.getFullYear()}-12-31`;
          break;
        default: // month
          startDate = `${currentDate.getFullYear()}-${(currentDate.getMonth() + 1).toString().padStart(2, '0')}-01`;
          const nextMonth = currentDate.getMonth() === 11 ? 0 : currentDate.getMonth() + 1;
          const nextYear = currentDate.getMonth() === 11 ? currentDate.getFullYear() + 1 : currentDate.getFullYear();
          endDate = `${nextYear}-${(nextMonth + 1).toString().padStart(2, '0')}-01`;
      }

      const financialQuery = `
        WITH revenue_summary AS (
          SELECT 
            COALESCE(SUM(p.amount), 0) as total_due,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) as total_collected,
            COUNT(DISTINCT p.id) as total_payments,
            COUNT(DISTINCT CASE WHEN p.status = 'paid' THEN p.id END) as paid_payments
          FROM payments p
          JOIN tenancies t ON p.tenancy_id = t.id
          JOIN units u ON t.unit_id = u.id
          JOIN rooms r ON u.room_id = r.id
          JOIN buildings b ON r.building_id = b.id
          WHERE p.due_date >= '${startDate}' AND p.due_date < '${endDate}'
          AND b.id = ANY($1) ${buildingFilter}
        ),
        building_breakdown AS (
          SELECT 
            b.id,
            b.name,
            COALESCE(SUM(CASE WHEN p.status = 'paid' THEN p.amount ELSE 0 END), 0) as revenue,
            COUNT(DISTINCT u.id) as total_units,
            COUNT(DISTINCT CASE 
              WHEN EXISTS (
                SELECT 1 FROM tenancies t2 
                WHERE t2.unit_id = u.id 
                AND t2.agreement_status = 'executed'
                AND CURRENT_DATE >= t2.start_date 
                AND CURRENT_DATE <= t2.end_date
              ) THEN u.id 
            END) as occupied_units
          FROM buildings b
          LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
          LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
          LEFT JOIN units u ON r.id = u.room_id
          LEFT JOIN tenancies t ON u.id = t.unit_id AND t.agreement_status = 'executed'
          LEFT JOIN payments p ON t.id = p.tenancy_id 
            AND p.due_date >= '${startDate}' AND p.due_date < '${endDate}'
            AND p.status = 'paid'
          WHERE b.id = ANY($1) ${buildingFilter}
          GROUP BY b.id, b.name
          ORDER BY revenue DESC
        )
        SELECT 
          (SELECT row_to_json(rs) FROM revenue_summary rs) as revenue_data,
          (SELECT json_agg(bb) FROM building_breakdown bb) as buildings_data
      `;

      const financialResult = await pool.query(financialQuery, params);
      const data = financialResult.rows[0];

      const revenueData = data.revenue_data || {};
      const buildingsData = data.buildings_data || [];

      const collectionRate = revenueData.total_due > 0 
        ? ((revenueData.total_collected / revenueData.total_due) * 100).toFixed(2)
        : 0;

      const response = {
        success: true,
        data: {
          summary: {
            totalRevenue: parseFloat(revenueData.total_collected) || 0,
            totalDue: parseFloat(revenueData.total_due) || 0,
            totalOutstanding: (parseFloat(revenueData.total_due) || 0) - (parseFloat(revenueData.total_collected) || 0),
            collectionRate: parseFloat(collectionRate),
            totalPayments: parseInt(revenueData.total_payments) || 0,
            paidPayments: parseInt(revenueData.paid_payments) || 0,
          },
          breakdown: {
            buildings: buildingsData.map(building => ({
              id: building.id,
              name: building.name,
              revenue: parseFloat(building.revenue) || 0,
              totalUnits: parseInt(building.total_units) || 0,
              occupiedUnits: parseInt(building.occupied_units) || 0,
              occupancyRate: building.total_units > 0 
                ? ((building.occupied_units / building.total_units) * 100).toFixed(2)
                : 0,
            })),
          },
          period,
          dateRange: { startDate, endDate },
          role: userRole,
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching financial summary:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch financial summary"));
    }
  }

  /**
   * GET /api/dashboard/operational-metrics
   * Get operational metrics - manager focused
   */
  static async getOperationalMetrics(req, res, next) {
    try {
      const { building_id, timeframe = "30d" } = req.query;
      const userId = req.user.id;
      const userRole = req.user.role;

      const accessibleBuildingIds = await DashboardController.getAccessibleBuildingIds(userId, userRole);

      if (accessibleBuildingIds.length === 0) {
        return res.json({
          success: true,
          data: {
            metrics: {
              avgResponseTime: 0,
              completionRate: 0,
              tenantSatisfaction: 0,
              leadConversionRate: 0,
            },
            trends: [],
          },
        });
      }

      let buildingFilter = "";
      let params = [accessibleBuildingIds];
      let paramIndex = 2;

      if (building_id && accessibleBuildingIds.includes(parseInt(building_id))) {
        buildingFilter = ` AND b.id = $${paramIndex}`;
        params.push(parseInt(building_id));
        paramIndex++;
      }

      // Calculate timeframe interval
      let intervalDays;
      switch (timeframe) {
        case "7d": intervalDays = 7; break;
        case "90d": intervalDays = 90; break;
        default: intervalDays = 30; // 30d
      }

      const metricsQuery = `
        WITH response_time_metrics AS (
          SELECT 
            AVG(EXTRACT(EPOCH FROM (c.acknowledged_at - c.created_at))/3600) as avg_response_hours
          FROM complaints c
          JOIN buildings b ON c.building_id = b.id
          WHERE c.acknowledged_at IS NOT NULL
          AND c.created_at >= CURRENT_DATE - INTERVAL '${intervalDays} days'
          AND b.id = ANY($1) ${buildingFilter}
        ),
        completion_metrics AS (
          SELECT 
            COUNT(*) as total_complaints,
            COUNT(CASE WHEN c.status IN ('resolved', 'closed') THEN 1 END) as completed_complaints
          FROM complaints c
          JOIN buildings b ON c.building_id = b.id
          WHERE c.created_at >= CURRENT_DATE - INTERVAL '${intervalDays} days'
          AND b.id = ANY($1) ${buildingFilter}
        ),
        satisfaction_metrics AS (
          SELECT 
            AVG(c.tenant_satisfaction_rating) as avg_satisfaction
          FROM complaints c
          JOIN buildings b ON c.building_id = b.id
          WHERE c.tenant_satisfaction_rating IS NOT NULL
          AND c.feedback_date >= CURRENT_DATE - INTERVAL '${intervalDays} days'
          AND b.id = ANY($1) ${buildingFilter}
        ),
        lead_conversion_metrics AS (
          SELECT 
            COUNT(*) as total_leads,
            COUNT(CASE WHEN l.status = 'won' THEN 1 END) as converted_leads
          FROM leads l
          LEFT JOIN buildings b ON l.preferred_building_id = b.id
          WHERE l.created_at >= CURRENT_DATE - INTERVAL '${intervalDays} days'
          AND (l.preferred_building_id IS NULL OR b.id = ANY($1) ${buildingFilter})
        )
        SELECT 
          rt.avg_response_hours,
          cm.total_complaints,
          cm.completed_complaints,
          sm.avg_satisfaction,
          lcm.total_leads,
          lcm.converted_leads
        FROM response_time_metrics rt, completion_metrics cm, satisfaction_metrics sm, lead_conversion_metrics lcm
      `;

      const metricsResult = await pool.query(metricsQuery, params);
      const metrics = metricsResult.rows[0];

      const completionRate = metrics.total_complaints > 0 
        ? ((metrics.completed_complaints / metrics.total_complaints) * 100).toFixed(2)
        : 0;

      const conversionRate = metrics.total_leads > 0 
        ? ((metrics.converted_leads / metrics.total_leads) * 100).toFixed(2)
        : 0;

      const response = {
        success: true,
        data: {
          metrics: {
            avgResponseTime: parseFloat(metrics.avg_response_hours) || 0,
            completionRate: parseFloat(completionRate),
            tenantSatisfaction: parseFloat(metrics.avg_satisfaction) || 0,
            leadConversionRate: parseFloat(conversionRate),
            totalComplaints: parseInt(metrics.total_complaints) || 0,
            completedComplaints: parseInt(metrics.completed_complaints) || 0,
            totalLeads: parseInt(metrics.total_leads) || 0,
            convertedLeads: parseInt(metrics.converted_leads) || 0,
          },
          timeframe,
          role: userRole,
          accessibleBuildings: accessibleBuildingIds.length,
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching operational metrics:", error);
      next(createError("DATABASE_ERROR", "Failed to fetch operational metrics"));
    }
  }

  /**
   * Helper function to calculate time ago
   */
  static getTimeAgo(date) {
    const now = new Date();
    const diffMs = now - new Date(date);
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      return `${diffDays}d ago`;
    } else if (diffHours > 0) {
      return `${diffHours}h ago`;
    } else {
      return "Just now";
    }
  }
}

export default DashboardController;