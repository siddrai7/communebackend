// src/controllers/propertiesController.js
import pool from "../config/database.js";
import { createError } from "../utils/errorHandler.js";
import {
  getUserAccessibleBuildings,
  getAvailableManagers,
} from "../middleware/rbac.js";
import { ROLES } from "../middleware/auth.js";

class PropertiesController {
  // GET /api/properties/managers/available
  async getAvailableManagers(req, res, next) {
    try {
      const managers = await getAvailableManagers();

      const response = {
        success: true,
        data: {
          managers,
          total: managers.length,
        },
      };

      res.json(response);
    } catch (error) {
      next(error);
    }
  }

  // GET /api/properties/overview (FIXED with proper parameter handling)
  async getOverview(req, res, next) {
    try {
      const client = await pool.connect();

      try {
        const user = req.user;

        // Get accessible buildings for the user
        let accessibleBuildingIds = null;
        if (user.role === ROLES.MANAGER) {
          accessibleBuildingIds = await getUserAccessibleBuildings(
            user.userId,
            user.role
          );
          if (accessibleBuildingIds.length === 0) {
            // Manager has no assigned buildings - return empty stats
            return res.json({
              success: true,
              data: {
                overview: {
                  totalBuildings: 0,
                  totalUnits: 0,
                  availableUnits: 0,
                  occupiedUnits: 0,
                  maintenanceUnits: 0,
                  upcomingUnits: 0,
                  occupancyRate: 0,
                  utilizationRate: 0,
                },
                revenue: {
                  totalRentDue: 0,
                  totalRentCollected: 0,
                  totalOutstanding: 0,
                  collectionRate: 0,
                  potentialMonthlyRevenue: 0,
                  activeTenancies: 0,
                  revenueTrend: 0,
                  month: new Date().getMonth() + 1,
                  year: new Date().getFullYear(),
                },
                recentActivity: {},
                trends: {
                  revenueGrowth: 0,
                  collectionRate: 0,
                  occupancyTrend: "stable",
                },
                alerts: {
                  expiring_leases: 0,
                  overdue_payments: 0,
                  maintenance_pending: 0,
                },
                userContext: {
                  role: user.role,
                  managedBuildingsCount: 0,
                },
              },
            });
          }
        }

        // Helper function to build WHERE clause and params
        const buildBuildingFilter = () => {
          if (accessibleBuildingIds && accessibleBuildingIds.length > 0) {
            return {
              clause: "AND b.id = ANY($1::integer[])",
              params: [accessibleBuildingIds],
            };
          }
          return {
            clause: "",
            params: [],
          };
        };

        const buildingFilter = buildBuildingFilter();

        // 1. GET TOTAL BUILDINGS COUNT
        const buildingsQuery = `
        SELECT COUNT(*) as total_buildings 
        FROM buildings b
        WHERE b.status = 'active' ${buildingFilter.clause}
      `;
        const buildingsResult = await client.query(
          buildingsQuery,
          buildingFilter.params
        );
        const totalBuildings = parseInt(
          buildingsResult.rows[0].total_buildings
        );

        // 2. GET UNIT STATISTICS
        const unitsQuery = `
        SELECT 
          COUNT(DISTINCT u.id) as total_units,
          -- Available: No current tenancy and not in maintenance
          COUNT(DISTINCT CASE 
            WHEN u.status != 'maintenance' 
            AND NOT EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND CURRENT_DATE >= t.start_date 
              AND CURRENT_DATE <= t.end_date
            ) THEN u.id 
          END) as available_units,
          -- Occupied: Has current active tenancy
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND CURRENT_DATE >= t.start_date 
              AND CURRENT_DATE <= t.end_date
            ) THEN u.id 
          END) as occupied_units,
          -- Maintenance: Unit status is maintenance
          COUNT(DISTINCT CASE WHEN u.status = 'maintenance' THEN u.id END) as maintenance_units,
          -- Upcoming: Has future tenancy starting within 30 days
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND t.start_date > CURRENT_DATE 
              AND t.start_date <= CURRENT_DATE + INTERVAL '30 days'
            ) THEN u.id 
          END) as upcoming_units
        FROM units u
        JOIN rooms r ON u.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        WHERE b.status = 'active' AND r.status = 'active' ${buildingFilter.clause}
      `;
        const unitsResult = await client.query(
          unitsQuery,
          buildingFilter.params
        );
        const unitStats = unitsResult.rows[0];

        // Calculate occupancy rate
        const totalUnits = parseInt(unitStats.total_units);
        const occupiedUnits = parseInt(unitStats.occupied_units);
        const occupancyRate =
          totalUnits > 0 ? ((occupiedUnits / totalUnits) * 100).toFixed(2) : 0;

        // 3. GET CURRENT MONTH REVENUE
        const currentDate = new Date();
        const currentMonth = currentDate.getMonth() + 1;
        const currentYear = currentDate.getFullYear();

        // Build revenue query parameters
        const revenueParams =
          buildingFilter.params.length > 0
            ? [...buildingFilter.params, currentMonth, currentYear]
            : [currentMonth, currentYear];

        const monthParam = buildingFilter.params.length > 0 ? "$2" : "$1";
        const yearParam = buildingFilter.params.length > 0 ? "$3" : "$2";

        const revenueQuery = `
        SELECT 
          COALESCE(SUM(rc.rent_amount), 0) as total_rent_due,
          COALESCE(SUM(rc.paid_amount), 0) as total_rent_collected,
          COALESCE(SUM(rc.rent_amount - rc.paid_amount), 0) as total_outstanding,
          COUNT(DISTINCT rc.tenancy_id) as active_tenancies,
          -- Calculate potential revenue from all current tenancies
          COALESCE((
            SELECT SUM(t.rent_amount) 
            FROM tenancies t
            JOIN units tu ON t.unit_id = tu.id
            JOIN rooms tr ON tu.room_id = tr.id
            JOIN buildings b ON tr.building_id = b.id
            WHERE t.agreement_status = 'executed'
            AND CURRENT_DATE >= t.start_date 
            AND CURRENT_DATE <= t.end_date
            AND b.status = 'active'
            ${buildingFilter.clause}
          ), 0) as potential_monthly_revenue
        FROM rent_cycles rc
        JOIN tenancies t ON rc.tenancy_id = t.id
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        WHERE rc.cycle_month = ${monthParam} AND rc.cycle_year = ${yearParam}
        AND b.status = 'active' ${buildingFilter.clause}
      `;

        const revenueResult = await client.query(revenueQuery, revenueParams);
        const revenueStats = revenueResult.rows[0];

        // Calculate collection rate
        const collectionRate =
          parseFloat(revenueStats.total_rent_due) > 0
            ? (
                (parseFloat(revenueStats.total_rent_collected) /
                  parseFloat(revenueStats.total_rent_due)) *
                100
              ).toFixed(2)
            : 0;

        // 4. GET RECENT ACTIVITY (last 7 days)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const activityParams =
          buildingFilter.params.length > 0
            ? [
                ...buildingFilter.params,
                sevenDaysAgo.toISOString().split("T")[0],
              ]
            : [sevenDaysAgo.toISOString().split("T")[0]];

        const dateParam = buildingFilter.params.length > 0 ? "$2" : "$1";

        const activityQuery = `
        (SELECT 'new_tenants' as activity_type, COUNT(*) as count,
         ARRAY_AGG(DISTINCT CONCAT(up.first_name, ' ', up.last_name)) as details
         FROM tenancies t
         JOIN users u ON t.tenant_user_id = u.id
         JOIN user_profiles up ON u.id = up.user_id
         JOIN units un ON t.unit_id = un.id
         JOIN rooms r ON un.room_id = r.id
         JOIN buildings b ON r.building_id = b.id
         WHERE t.move_in_date >= ${dateParam} AND b.status = 'active' ${buildingFilter.clause})
        UNION ALL
        (SELECT 'maintenance_requests' as activity_type, COUNT(*) as count,
         ARRAY_AGG(DISTINCT mr.category) as details
         FROM maintenance_requests mr
         JOIN rooms r ON mr.room_id = r.id
         JOIN buildings b ON r.building_id = b.id
         WHERE mr.requested_date >= ${dateParam} AND b.status = 'active' ${buildingFilter.clause})
        UNION ALL
        (SELECT 'payments' as activity_type, COUNT(*) as count,
         ARRAY_AGG(DISTINCT p.payment_type) as details
         FROM payments p
         JOIN tenancies t ON p.tenancy_id = t.id
         JOIN units u ON t.unit_id = u.id
         JOIN rooms r ON u.room_id = r.id
         JOIN buildings b ON r.building_id = b.id
         WHERE p.payment_date >= ${dateParam} AND b.status = 'active' ${buildingFilter.clause})
        UNION ALL
        (SELECT 'lease_renewals' as activity_type, COUNT(*) as count,
         ARRAY_AGG(DISTINCT un.unit_number) as details
         FROM tenancies t
         JOIN units un ON t.unit_id = un.id
         JOIN rooms r ON un.room_id = r.id
         JOIN buildings b ON r.building_id = b.id
         WHERE t.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
         AND t.agreement_status = 'executed'
         AND b.status = 'active' ${buildingFilter.clause})
      `;

        const activityResult = await client.query(
          activityQuery,
          activityParams
        );

        // Process activity data
        const recentActivity = activityResult.rows.reduce((acc, row) => {
          acc[row.activity_type] = {
            count: parseInt(row.count),
            details: row.details || [],
          };
          return acc;
        }, {});

        // 5. GET TRENDS (compare with previous month)
        const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
        const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;

        const trendsParams =
          buildingFilter.params.length > 0
            ? [...buildingFilter.params, prevMonth, prevYear]
            : [prevMonth, prevYear];

        const trendsQuery = `
        SELECT 
          COALESCE(SUM(rc.rent_amount), 0) as prev_rent_due,
          COALESCE(SUM(rc.paid_amount), 0) as prev_rent_collected
        FROM rent_cycles rc
        JOIN tenancies t ON rc.tenancy_id = t.id
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        JOIN buildings b ON r.building_id = b.id
        WHERE rc.cycle_month = ${monthParam} AND rc.cycle_year = ${yearParam}
        AND b.status = 'active' ${buildingFilter.clause}
      `;

        const trendsResult = await client.query(trendsQuery, trendsParams);
        const prevStats = trendsResult.rows[0];

        const revenueTrend =
          parseFloat(prevStats.prev_rent_collected) > 0
            ? (
                ((parseFloat(revenueStats.total_rent_collected) -
                  parseFloat(prevStats.prev_rent_collected)) /
                  parseFloat(prevStats.prev_rent_collected)) *
                100
              ).toFixed(1)
            : 0;

        // 6. BUILD RESPONSE
        const response = {
          success: true,
          data: {
            overview: {
              totalBuildings,
              totalUnits: totalUnits,
              availableUnits: parseInt(unitStats.available_units),
              occupiedUnits: occupiedUnits,
              maintenanceUnits: parseInt(unitStats.maintenance_units),
              upcomingUnits: parseInt(unitStats.upcoming_units),
              occupancyRate: parseFloat(occupancyRate),
              utilizationRate:
                totalUnits > 0
                  ? (
                      ((occupiedUnits + parseInt(unitStats.upcoming_units)) /
                        totalUnits) *
                      100
                    ).toFixed(2)
                  : 0,
            },
            revenue: {
              totalRentDue: parseFloat(revenueStats.total_rent_due),
              totalRentCollected: parseFloat(revenueStats.total_rent_collected),
              totalOutstanding: parseFloat(revenueStats.total_outstanding),
              collectionRate: parseFloat(collectionRate),
              potentialMonthlyRevenue: parseFloat(
                revenueStats.potential_monthly_revenue
              ),
              activeTenancies: parseInt(revenueStats.active_tenancies),
              revenueTrend: parseFloat(revenueTrend),
              month: currentMonth,
              year: currentYear,
            },
            recentActivity,
            trends: {
              revenueGrowth: parseFloat(revenueTrend),
              collectionRate: parseFloat(collectionRate),
              occupancyTrend: "stable",
            },
            alerts: {
              expiring_leases: recentActivity.lease_renewals?.count || 0,
              overdue_payments: Math.round(
                parseFloat(revenueStats.total_outstanding)
              ),
              maintenance_pending:
                recentActivity.maintenance_requests?.count || 0,
            },
            userContext: {
              role: user.role,
              managedBuildingsCount:
                user.role === ROLES.MANAGER
                  ? accessibleBuildingIds?.length || 0
                  : null,
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

  async getBuildings(req, res, next) {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const status = req.query.status || "active";
      const city = req.query.city;
      const search = req.query.search;

      const offset = (page - 1) * limit;
      const client = await pool.connect();

      try {
        const user = req.user;

        // Get accessible buildings for managers
        let accessibleBuildingIds = null;
        if (user.role === ROLES.MANAGER) {
          accessibleBuildingIds = await getUserAccessibleBuildings(
            user.userId,
            user.role
          );
          if (accessibleBuildingIds.length === 0) {
            // Manager has no assigned buildings
            return res.json({
              success: true,
              data: {
                buildings: [],
                pagination: {
                  currentPage: page,
                  totalPages: 0,
                  totalItems: 0,
                  itemsPerPage: limit,
                  hasNextPage: false,
                  hasPrevPage: false,
                },
                summary: {
                  totalBuildings: 0,
                  totalUnits: 0,
                  totalOccupied: 0,
                  totalRevenue: 0,
                  averageOccupancy: 0,
                },
                userContext: {
                  role: user.role,
                  canCreateBuildings: false,
                  canEditBuildings: false,
                  isManagerFiltered: true,
                  managedBuildingsCount: 0,
                },
              },
            });
          }
        }

        // Build WHERE conditions and parameters systematically
        const whereConditions = [];
        const queryParams = [];
        let paramIndex = 1;

        // Always add status condition first
        whereConditions.push(`b.status = $${paramIndex}`);
        queryParams.push(status);
        paramIndex++;

        // Add building ID filtering for managers
        if (accessibleBuildingIds && accessibleBuildingIds.length > 0) {
          whereConditions.push(`b.id = ANY($${paramIndex}::integer[])`);
          queryParams.push(accessibleBuildingIds);
          paramIndex++;
        }

        // Add city filter if provided
        if (city) {
          whereConditions.push(`b.city ILIKE $${paramIndex}`);
          queryParams.push(`%${city}%`);
          paramIndex++;
        }

        // Add search filter if provided
        if (search) {
          whereConditions.push(
            `(b.name ILIKE $${paramIndex} OR b.address_line1 ILIKE $${paramIndex})`
          );
          queryParams.push(`%${search}%`);
          paramIndex++;
        }

        const whereClause = whereConditions.join(" AND ");

        // Main buildings query with manager info
        const buildingsQuery = `
        SELECT 
          b.*,
          -- Manager information
          mu.email as manager_email,
          CONCAT(COALESCE(mup.first_name, ''), ' ', COALESCE(mup.last_name, '')) as manager_name,
          mup.phone as manager_phone,
          
          COUNT(DISTINCT f.id) as total_floors,
          COUNT(DISTINCT r.id) as total_rooms,
          COUNT(DISTINCT u.id) as total_units,
          
          -- Available units (no current tenancy and not in maintenance)
          COUNT(DISTINCT CASE 
            WHEN u.status != 'maintenance' 
            AND NOT EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND CURRENT_DATE >= t.start_date 
              AND CURRENT_DATE <= t.end_date
            ) THEN u.id 
          END) as available_units,
          
          -- Occupied units (has current active tenancy)
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND CURRENT_DATE >= t.start_date 
              AND CURRENT_DATE <= t.end_date
            ) THEN u.id 
          END) as occupied_units,
          
          -- Maintenance units
          COUNT(DISTINCT CASE WHEN u.status = 'maintenance' THEN u.id END) as maintenance_units,
          
          -- Upcoming units (future tenancy starting within 30 days)
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND t.start_date > CURRENT_DATE 
              AND t.start_date <= CURRENT_DATE + INTERVAL '30 days'
            ) THEN u.id 
          END) as upcoming_units,
          
          -- Revenue calculations
          COALESCE((
            SELECT SUM(t.rent_amount) 
            FROM tenancies t
            JOIN units tu ON t.unit_id = tu.id
            JOIN rooms tr ON tu.room_id = tr.id
            WHERE tr.building_id = b.id
            AND t.agreement_status = 'executed'
            AND CURRENT_DATE >= t.start_date 
            AND CURRENT_DATE <= t.end_date
          ), 0) as current_monthly_revenue,
          
          COALESCE(AVG(u.rent_amount), 0) as average_rent,
          COALESCE(MIN(u.rent_amount), 0) as min_rent,
          COALESCE(MAX(u.rent_amount), 0) as max_rent
          
        FROM buildings b
        LEFT JOIN users mu ON b.manager_id = mu.id AND mu.role = 'manager'
        LEFT JOIN user_profiles mup ON mu.id = mup.user_id
        LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
        LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
        LEFT JOIN units u ON r.id = u.room_id
        WHERE ${whereClause}
        GROUP BY b.id, mu.id, mu.email, mup.first_name, mup.last_name, mup.phone
        ORDER BY b.created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

        // Add pagination parameters
        const paginationParams = [...queryParams, limit, offset];
        const buildingsResult = await client.query(
          buildingsQuery,
          paginationParams
        );

        // Get total count for pagination (using same WHERE clause and params)
        const countQuery = `
        SELECT COUNT(DISTINCT b.id) as total
        FROM buildings b
        WHERE ${whereClause}
      `;

        const countResult = await client.query(countQuery, queryParams);
        const totalBuildings = parseInt(countResult.rows[0].total);

        // Calculate pagination
        const totalPages = Math.ceil(totalBuildings / limit);
        const hasNextPage = page < totalPages;
        const hasPrevPage = page > 1;

        // Process buildings data
        const processedBuildings = buildingsResult.rows.map((building) => {
          const totalUnits = parseInt(building.total_units);
          const occupiedUnits = parseInt(building.occupied_units);
          const availableUnits = parseInt(building.available_units);
          const upcomingUnits = parseInt(building.upcoming_units);

          // Calculate accurate occupancy rate
          const occupancyRate =
            totalUnits > 0
              ? ((occupiedUnits / totalUnits) * 100).toFixed(2)
              : 0;

          // Calculate utilization rate (occupied + upcoming)
          const utilizationRate =
            totalUnits > 0
              ? (((occupiedUnits + upcomingUnits) / totalUnits) * 100).toFixed(
                  2
                )
              : 0;

          return {
            id: building.id,
            name: building.name,
            address: {
              line1: building.address_line1,
              line2: building.address_line2,
              city: building.city,
              state: building.state,
              postalCode: building.postal_code,
            },
            // Manager information
            manager: building.manager_id
              ? {
                  id: building.manager_id,
                  email: building.manager_email,
                  name: (building.manager_name || "").trim() || "Unknown",
                  phone: building.manager_phone,
                }
              : null,

            totalFloors: parseInt(building.total_floors),
            totalRooms: parseInt(building.total_rooms),
            totalUnits: totalUnits,
            availableUnits: availableUnits,
            occupiedUnits: occupiedUnits,
            maintenanceUnits: parseInt(building.maintenance_units),
            upcomingUnits: upcomingUnits,
            occupancyRate: parseFloat(occupancyRate),
            utilizationRate: parseFloat(utilizationRate),
            currentMonthlyRevenue: parseFloat(building.current_monthly_revenue),
            averageRent: parseFloat(building.average_rent),
            minRent: parseFloat(building.min_rent),
            maxRent: parseFloat(building.max_rent),
            buildingImage: building.building_image,
            amenities: building.amenities || [],
            contactPerson: building.contact_person,
            contactPhone: building.contact_phone,
            status: building.status,
            createdAt: building.created_at,
            updatedAt: building.updated_at,

            // Performance indicators
            performance: {
              occupancyRating:
                occupancyRate >= 90
                  ? "excellent"
                  : occupancyRate >= 75
                  ? "good"
                  : occupancyRate >= 60
                  ? "average"
                  : "poor",
              revenuePerUnit:
                totalUnits > 0
                  ? Math.round(
                      parseFloat(building.current_monthly_revenue) / totalUnits
                    )
                  : 0,
              vacancyRate:
                totalUnits > 0
                  ? ((availableUnits / totalUnits) * 100).toFixed(1)
                  : 0,
            },
          };
        });

        // Calculate summary statistics
        const summary = {
          totalBuildings: processedBuildings.length,
          totalUnits: processedBuildings.reduce(
            (sum, b) => sum + b.totalUnits,
            0
          ),
          totalOccupied: processedBuildings.reduce(
            (sum, b) => sum + b.occupiedUnits,
            0
          ),
          totalRevenue: processedBuildings.reduce(
            (sum, b) => sum + b.currentMonthlyRevenue,
            0
          ),
          averageOccupancy:
            processedBuildings.length > 0
              ? (
                  processedBuildings.reduce((sum, b) => {
                    return (
                      sum +
                      (b.totalUnits > 0
                        ? (b.occupiedUnits / b.totalUnits) * 100
                        : 0)
                    );
                  }, 0) / processedBuildings.length
                ).toFixed(1)
              : 0,
        };

        // Build response
        const response = {
          success: true,
          data: {
            buildings: processedBuildings,
            pagination: {
              currentPage: page,
              totalPages,
              totalItems: totalBuildings,
              itemsPerPage: limit,
              hasNextPage,
              hasPrevPage,
            },
            summary,
            userContext: {
              role: user.role,
              canCreateBuildings: [ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(
                user.role
              ),
              canEditBuildings: [ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(
                user.role
              ),
              isManagerFiltered: user.role === ROLES.MANAGER,
              managedBuildingsCount:
                user.role === ROLES.MANAGER
                  ? accessibleBuildingIds?.length || 0
                  : null,
            },
            filters: {
              applied: {
                status,
                city: city || null,
                search: search || null,
                managerFilter: accessibleBuildingIds ? true : false,
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

  // POST /api/properties/buildings (UPDATED with manager assignment)
  async createBuilding(req, res, next) {
    try {
      const {
        name,
        propertyCode,
        addressLine1,
        addressLine2,
        city,
        state,
        postalCode,
        description,
        amenities,
        contactPerson,
        contactPhone,
        managerId, // NEW: Manager assignment
        floors,
        otherImages,
      } = req.body;

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Validate manager if provided
        if (managerId) {
          const managerQuery = `
            SELECT id, email FROM users 
            WHERE id = $1 AND role = 'manager' AND status = 'active'
          `;
          const managerResult = await client.query(managerQuery, [managerId]);

          if (managerResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return next(
              createError(
                "VALIDATION_ERROR",
                "Invalid manager ID or manager is not active"
              )
            );
          }
        }

        // Parse amenities if provided
        let parsedAmenities = [];
        if (amenities) {
          try {
            parsedAmenities =
              typeof amenities === "string" ? JSON.parse(amenities) : amenities;
          } catch (error) {
            await client.query("ROLLBACK");
            return next(
              createError("VALIDATION_ERROR", "Invalid amenities format")
            );
          }
        }

        // Parse floors data if provided
        let parsedFloors = [];
        if (floors) {
          try {
            parsedFloors =
              typeof floors === "string" ? JSON.parse(floors) : floors;
          } catch (error) {
            await client.query("ROLLBACK");
            return next(
              createError("VALIDATION_ERROR", "Invalid floors format")
            );
          }
        }

        // Parse other images if provided
        let parsedOtherImages = [];
        if (otherImages) {
          try {
            parsedOtherImages =
              typeof otherImages === "string"
                ? JSON.parse(otherImages)
                : otherImages;
          } catch (error) {
            await client.query("ROLLBACK");
            return next(
              createError("VALIDATION_ERROR", "Invalid other images format")
            );
          }
        }

        // Handle main building image
        const masterImagePath = req.files?.masterImage
          ? `/uploads/buildings/${req.files.masterImage[0].filename}`
          : null;

        // Handle other images
        const additionalImagePaths = req.files?.otherImages
          ? req.files.otherImages.map(
              (file) => `/uploads/buildings/${file.filename}`
            )
          : parsedOtherImages;

        // Create building with manager assignment
        const buildingQuery = `
          INSERT INTO buildings (
            name, building_code, address_line1, address_line2, city, state, postal_code,
            description, amenities, contact_person, contact_phone, building_image, manager_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
          ) RETURNING *
        `;

        const buildingValues = [
          name,
          propertyCode,
          addressLine1,
          addressLine2,
          city,
          state,
          postalCode,
          description,
          parsedAmenities,
          contactPerson,
          contactPhone,
          masterImagePath,
          managerId || null, // NEW: Include manager assignment
        ];

        const buildingResult = await client.query(
          buildingQuery,
          buildingValues
        );
        const building = buildingResult.rows[0];
        const buildingId = building.id;

        let totalRooms = 0;
        let totalUnits = 0;
        const createdFloors = [];

        // Create floors, rooms, and units if provided (same logic as before)
        if (parsedFloors && parsedFloors.length > 0) {
          for (const floorData of parsedFloors) {
            // Create floor
            const floorQuery = `
              INSERT INTO floors (
                building_id, floor_number, floor_name, description
              ) VALUES ($1, $2, $3, $4) RETURNING *
            `;

            const floorValues = [
              buildingId,
              floorData.floorNumber,
              floorData.floorName || `Floor ${floorData.floorNumber}`,
              floorData.description || "",
            ];

            const floorResult = await client.query(floorQuery, floorValues);
            const floor = floorResult.rows[0];
            const floorId = floor.id;

            let floorRooms = 0;
            let floorUnits = 0;
            const createdRooms = [];

            // Create rooms for this floor
            if (floorData.rooms && floorData.rooms.length > 0) {
              for (const roomData of floorData.rooms) {
                // Create room
                const roomQuery = `
                  INSERT INTO rooms (
                    building_id, floor_id, room_number, room_type, 
                    total_units, size_sqft, furnishing_status, 
                    ac_available, wifi_available, amenities
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
                `;

                const roomValues = [
                  buildingId,
                  floorId,
                  roomData.roomNumber,
                  roomData.roomType,
                  roomData.units?.length || 1,
                  roomData.sizeSqft || null,
                  roomData.furnishingStatus || "furnished",
                  roomData.acAvailable !== false,
                  roomData.wifiAvailable !== false,
                  roomData.amenities || [],
                ];

                const roomResult = await client.query(roomQuery, roomValues);
                const room = roomResult.rows[0];
                const roomId = room.id;

                floorRooms++;
                const createdUnits = [];

                // Create units for this room
                if (roomData.units && roomData.units.length > 0) {
                  for (const unitData of roomData.units) {
                    const unitQuery = `
                      INSERT INTO units (
                        room_id, unit_identifier, unit_number, 
                        rent_amount, security_deposit, target_selling_price
                      ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
                    `;

                    const unitValues = [
                      roomId,
                      unitData.unitIdentifier || null,
                      unitData.unitNumber,
                      unitData.rentAmount,
                      unitData.securityDeposit || 0,
                      unitData.targetSellingPrice || 0,
                    ];

                    const unitResult = await client.query(
                      unitQuery,
                      unitValues
                    );
                    const unit = unitResult.rows[0];

                    createdUnits.push({
                      id: unit.id,
                      unitNumber: unit.unit_number,
                      unitIdentifier: unit.unit_identifier,
                      rentAmount: parseFloat(unit.rent_amount),
                      securityDeposit: parseFloat(unit.security_deposit),
                      targetSellingPrice: parseFloat(unit.target_selling_price),
                    });

                    floorUnits++;
                    totalUnits++;
                  }
                } else {
                  // Create default unit for single rooms
                  const uniqueUnitNumber = `${floorData.floorNumber}-${roomData.roomNumber}`;

                  const defaultUnitQuery = `
                    INSERT INTO units (
                      room_id, unit_identifier, unit_number, 
                      rent_amount, security_deposit, target_selling_price
                    ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
                  `;

                  const defaultUnitValues = [
                    roomId,
                    null,
                    uniqueUnitNumber,
                    roomData.rentAmount || 0,
                    roomData.securityDeposit || 0,
                    roomData.targetSellingPrice || 0,
                  ];

                  const unitResult = await client.query(
                    defaultUnitQuery,
                    defaultUnitValues
                  );
                  const unit = unitResult.rows[0];

                  createdUnits.push({
                    id: unit.id,
                    unitNumber: unit.unit_number,
                    rentAmount: parseFloat(unit.rent_amount),
                    securityDeposit: parseFloat(unit.security_deposit),
                    targetSellingPrice: parseFloat(unit.target_selling_price),
                  });

                  floorUnits++;
                  totalUnits++;
                }

                createdRooms.push({
                  id: room.id,
                  roomNumber: room.room_number,
                  roomType: room.room_type,
                  totalUnits: room.total_units,
                  sizeSqft: room.size_sqft,
                  furnishingStatus: room.furnishing_status,
                  amenities: room.amenities,
                  units: createdUnits,
                });

                totalRooms++;
              }
            }

            // Update floor totals
            await client.query(
              "UPDATE floors SET total_rooms = $1, total_units = $2 WHERE id = $3",
              [floorRooms, floorUnits, floorId]
            );

            createdFloors.push({
              id: floor.id,
              floorNumber: floor.floor_number,
              floorName: floor.floor_name,
              totalRooms: floorRooms,
              totalUnits: floorUnits,
              rooms: createdRooms,
            });
          }

          // Update building totals
          await client.query(
            "UPDATE buildings SET total_floors = $1, total_units = $2 WHERE id = $3",
            [parsedFloors.length, totalUnits, buildingId]
          );
        }

        // Get manager info for response if assigned
        let managerInfo = null;
        if (managerId) {
          const managerInfoQuery = `
            SELECT u.id, u.email, up.first_name, up.last_name, up.phone
            FROM users u
            LEFT JOIN user_profiles up ON u.id = up.user_id
            WHERE u.id = $1
          `;
          const managerInfoResult = await client.query(managerInfoQuery, [
            managerId,
          ]);
          if (managerInfoResult.rows.length > 0) {
            const manager = managerInfoResult.rows[0];
            managerInfo = {
              id: manager.id,
              email: manager.email,
              name:
                `${manager.first_name || ""} ${
                  manager.last_name || ""
                }`.trim() || "Unknown",
              phone: manager.phone,
            };
          }
        }

        // Commit transaction
        await client.query("COMMIT");

        const response = {
          success: true,
          message:
            "Building created successfully with floors, rooms, and units",
          data: {
            building: {
              id: building.id,
              name: building.name,
              address: {
                line1: building.address_line1,
                line2: building.address_line2,
                city: building.city,
                state: building.state,
                postalCode: building.postal_code,
              },
              description: building.description,
              amenities: building.amenities || [],
              contactPerson: building.contact_person,
              contactPhone: building.contact_phone,
              buildingImage: building.building_image,
              manager: managerInfo, // NEW: Include manager info
              status: building.status,
              totalFloors: parsedFloors.length,
              totalRooms: totalRooms,
              totalUnits: totalUnits,
              createdAt: building.created_at,
            },
            floors: createdFloors,
            additionalImages: additionalImagePaths,
            summary: {
              totalFloors: parsedFloors.length,
              totalRooms: totalRooms,
              totalUnits: totalUnits,
              averageRent:
                totalUnits > 0
                  ? createdFloors.reduce(
                      (sum, floor) =>
                        sum +
                        floor.rooms.reduce(
                          (roomSum, room) =>
                            roomSum +
                            room.units.reduce(
                              (unitSum, unit) => unitSum + unit.rentAmount,
                              0
                            ),
                          0
                        ),
                      0
                    ) / totalUnits
                  : 0,
            },
          },
        };

        res.status(201).json(response);
      } catch (error) {
        // Rollback transaction on error
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // The remaining methods (getBuildingById, getBuildingForEdit, getBuildingTenants,
  // getBuildingVacancyChart, getBuildingAnalytics, updateBuilding, deleteBuilding)
  // need similar updates but they already have the authorizeResource middleware
  // protecting them, so they don't need major changes unless you want to add
  // manager info to their responses.

  async updateBuilding(req, res, next) {
    try {
      const buildingId = req.params.id;
      const {
        name,
        propertyCode,
        addressLine1,
        addressLine2,
        city,
        state,
        postalCode,
        description,
        amenities,
        contactPerson,
        contactPhone,
        status,
        managerId,
        floors,
      } = req.body;

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Check if building exists
        const existingQuery = `
          SELECT building_image, manager_id FROM buildings WHERE id = $1
        `;
        const existingResult = await client.query(existingQuery, [buildingId]);

        if (existingResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return next(createError("NOT_FOUND", "Building not found"));
        }

        const existingBuilding = existingResult.rows[0];
        let imagePath = existingBuilding.building_image;

        // Validate manager if provided
        if (managerId !== undefined) {
          if (managerId !== null) {
            const managerQuery = `
              SELECT id, email FROM users
              WHERE id = $1 AND role = 'manager' AND status = 'active'
            `;
            const managerResult = await client.query(managerQuery, [managerId]);

            if (managerResult.rows.length === 0) {
              await client.query("ROLLBACK");
              return next(
                createError(
                  "VALIDATION_ERROR",
                  "Invalid manager ID or manager is not active"
                )
              );
            }
          }
        }

        // Handle image upload if provided
        if (req.file) {
          imagePath = `/uploads/buildings/${req.file.filename}`;
        }

        // Parse amenities and floors if provided
        let parsedAmenities = null;
        let parsedFloors = null;

        if (amenities) {
          try {
            parsedAmenities =
              typeof amenities === "string" ? JSON.parse(amenities) : amenities;
          } catch (error) {
            await client.query("ROLLBACK");
            return next(
              createError("VALIDATION_ERROR", "Invalid amenities format")
            );
          }
        }

        if (floors) {
          try {
            parsedFloors =
              typeof floors === "string" ? JSON.parse(floors) : floors;
          } catch (error) {
            await client.query("ROLLBACK");
            return next(
              createError("VALIDATION_ERROR", "Invalid floors format")
            );
          }
        }

        // Update building basic info including manager
        const updateBuildingQuery = `
          UPDATE buildings SET
            name = COALESCE($1, name),
            building_code = COALESCE($2, building_code),
            address_line1 = COALESCE($3, address_line1),
            address_line2 = COALESCE($4, address_line2),
            city = COALESCE($5, city),
            state = COALESCE($6, state),
            postal_code = COALESCE($7, postal_code),
            description = COALESCE($8, description),
            amenities = COALESCE($9, amenities),
            contact_person = COALESCE($10, contact_person),
            contact_phone = COALESCE($11, contact_phone),
            status = COALESCE($12, status),
            building_image = COALESCE($13, building_image),
            manager_id = CASE WHEN $14::boolean THEN $15 ELSE manager_id END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $16
          RETURNING *
        `;

        const buildingValues = [
          name,
          propertyCode,
          addressLine1,
          addressLine2,
          city,
          state,
          postalCode,
          description,
          parsedAmenities,
          contactPerson,
          contactPhone,
          status,
          imagePath,
          managerId !== undefined, // Boolean to indicate if manager should be updated
          managerId, // The actual manager ID (can be null)
          buildingId,
        ];

        const buildingResult = await client.query(
          updateBuildingQuery,
          buildingValues
        );
        const building = buildingResult.rows[0];

        // Handle floors/rooms/units update if provided (smart differential update)
        if (parsedFloors && Array.isArray(parsedFloors)) {
          // Use the smart differential update method
          // Get existing structure
          const existingQuery = `
            SELECT 
              f.id as floor_id, f.floor_number, f.floor_name,
              r.id as room_id, r.room_number, r.room_type, r.floor_id as room_floor_id,
              u.id as unit_id, u.unit_number, u.unit_identifier, u.room_id as unit_room_id
            FROM floors f
            LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
            LEFT JOIN units u ON r.id = u.room_id
            WHERE f.building_id = $1 AND f.status = 'active'
            ORDER BY f.floor_number, r.room_number, u.unit_number
          `;

          const existingResult = await client.query(existingQuery, [
            buildingId,
          ]);

          // Build existing structure map
          const existingStructure = {
            floors: new Map(),
            rooms: new Map(),
            units: new Map(),
          };

          existingResult.rows.forEach((row) => {
            // Build floors map
            if (!existingStructure.floors.has(row.floor_id)) {
              existingStructure.floors.set(row.floor_id, {
                id: row.floor_id,
                floorNumber: row.floor_number,
                floorName: row.floor_name,
                rooms: new Set(),
              });
            }

            // Build rooms map
            if (row.room_id && !existingStructure.rooms.has(row.room_id)) {
              existingStructure.rooms.set(row.room_id, {
                id: row.room_id,
                roomNumber: row.room_number,
                roomType: row.room_type,
                floorId: row.room_floor_id,
                units: new Set(),
              });
              existingStructure.floors.get(row.floor_id).rooms.add(row.room_id);
            }

            // Build units map
            if (row.unit_id && !existingStructure.units.has(row.unit_id)) {
              existingStructure.units.set(row.unit_id, {
                id: row.unit_id,
                unitNumber: row.unit_number,
                unitIdentifier: row.unit_identifier,
                roomId: row.unit_room_id,
              });
              if (existingStructure.rooms.has(row.unit_room_id)) {
                existingStructure.rooms
                  .get(row.unit_room_id)
                  .units.add(row.unit_id);
              }
            }
          });

          // Process new structure - only create new items
          for (const newFloor of parsedFloors) {
            let floorId = null;
            let floorExists = false;

            // Check if floor exists (by floor_number)
            for (const [
              existingFloorId,
              existingFloor,
            ] of existingStructure.floors) {
              if (existingFloor.floorNumber === newFloor.floorNumber) {
                floorId = existingFloorId;
                floorExists = true;

                // Update floor if needed
                if (existingFloor.floorName !== newFloor.floorName) {
                  await client.query(
                    `UPDATE floors SET floor_name = $1, description = $2 WHERE id = $3`,
                    [newFloor.floorName, newFloor.description || "", floorId]
                  );
                }
                break;
              }
            }

            // Create new floor if it doesn't exist
            if (!floorExists) {
              const floorResult = await client.query(
                `INSERT INTO floors (building_id, floor_number, floor_name, description, status) 
                 VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
                [
                  buildingId,
                  newFloor.floorNumber,
                  newFloor.floorName || `Floor ${newFloor.floorNumber}`,
                  newFloor.description || "",
                ]
              );
              floorId = floorResult.rows[0].id;
            }

            // Process rooms for this floor
            if (newFloor.rooms && Array.isArray(newFloor.rooms)) {
              for (const newRoom of newFloor.rooms) {
                let roomId = null;
                let roomExists = false;

                // Check if room exists
                for (const [
                  existingRoomId,
                  existingRoom,
                ] of existingStructure.rooms) {
                  if (
                    existingRoom.floorId === floorId &&
                    existingRoom.roomNumber === newRoom.roomNumber
                  ) {
                    roomId = existingRoomId;
                    roomExists = true;

                    // Update room if needed
                    if (existingRoom.roomType !== newRoom.roomType) {
                      await client.query(
                        `UPDATE rooms SET room_type = $1 WHERE id = $2`,
                        [newRoom.roomType, roomId]
                      );
                    }
                    break;
                  }
                }

                // Create new room if it doesn't exist
                if (!roomExists) {
                  const roomResult = await client.query(
                    `INSERT INTO rooms (building_id, floor_id, room_number, room_type, 
                     total_units, size_sqft, furnishing_status, ac_available, wifi_available, amenities, status) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active') RETURNING id`,
                    [
                      buildingId,
                      floorId,
                      newRoom.roomNumber,
                      newRoom.roomType || "private",
                      newRoom.totalUnits || newRoom.units?.length || 0,
                      newRoom.sizeSqft || null,
                      newRoom.furnishingStatus || "unfurnished",
                      newRoom.acAvailable || false,
                      newRoom.wifiAvailable || false,
                      Array.isArray(newRoom.amenities) ? newRoom.amenities : [],
                    ]
                  );
                  roomId = roomResult.rows[0].id;
                }

                // Process units for this room
                if (newRoom.units && Array.isArray(newRoom.units)) {
                  for (const newUnit of newRoom.units) {
                    let unitExists = false;

                    // Check if unit exists
                    for (const [
                      existingUnitId,
                      existingUnit,
                    ] of existingStructure.units) {
                      if (
                        existingUnit.roomId === roomId &&
                        existingUnit.unitNumber === newUnit.unitNumber
                      ) {
                        unitExists = true;
                        
                        // Update existing unit with new values
                        await client.query(
                          `UPDATE units SET 
                            unit_identifier = $1,
                            rent_amount = $2,
                            security_deposit = $3,
                            target_selling_price = $4,
                            updated_at = CURRENT_TIMESTAMP
                          WHERE id = $5`,
                          [
                            newUnit.unitIdentifier || existingUnit.unitIdentifier,
                            newUnit.rentAmount || 0,
                            newUnit.securityDeposit || 0,
                            newUnit.targetSellingPrice || 0,
                            existingUnitId
                          ]
                        );
                        break;
                      }
                    }

                    // Create new unit if it doesn't exist
                    if (!unitExists) {
                      await client.query(
                        `INSERT INTO units (
                          room_id, unit_number, unit_identifier, rent_amount,
                          security_deposit, target_selling_price, status
                        ) VALUES ($1, $2, $3, $4, $5, $6, 'available')`,
                        [
                          roomId,
                          newUnit.unitNumber,
                          newUnit.unitIdentifier ||
                            `${newRoom.roomNumber}-${newUnit.unitNumber}`,
                          newUnit.rentAmount || 0,
                          newUnit.securityDeposit || 0,
                          newUnit.targetSellingPrice || 0,
                        ]
                      );
                    }
                  }
                }
              }
            }
          }
        }

        // Get updated manager info for response
        let managerInfo = null;
        if (building.manager_id) {
          const managerInfoQuery = `
            SELECT u.id, u.email, up.first_name, up.last_name, up.phone
            FROM users u
            LEFT JOIN user_profiles up ON u.id = up.user_id
            WHERE u.id = $1
          `;
          const managerInfoResult = await client.query(managerInfoQuery, [
            building.manager_id,
          ]);
          if (managerInfoResult.rows.length > 0) {
            const manager = managerInfoResult.rows[0];
            managerInfo = {
              id: manager.id,
              email: manager.email,
              name:
                `${manager.first_name || ""} ${
                  manager.last_name || ""
                }`.trim() || "Unknown",
              phone: manager.phone,
            };
          }
        }

        await client.query("COMMIT");

        const response = {
          success: true,
          message: "Building updated successfully",
          data: {
            id: building.id,
            name: building.name,
            propertyCode: building.building_code,
            address: {
              line1: building.address_line1,
              line2: building.address_line2,
              city: building.city,
              state: building.state,
              postalCode: building.postal_code,
            },
            description: building.description,
            amenities: building.amenities || [],
            contactPerson: building.contact_person,
            contactPhone: building.contact_phone,
            buildingImage: building.building_image,
            manager: managerInfo, // NEW: Include updated manager info
            status: building.status,
            updatedAt: building.updated_at,
          },
        };

        res.json(response);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  }

  // Smart Differential Update - Better Approach
  // async updateBuildingStructure(client, buildingId, parsedFloors) {
  //   // Get existing structure
  //   const existingQuery = `
  //   SELECT
  //     f.id as floor_id, f.floor_number, f.floor_name,
  //     r.id as room_id, r.room_number, r.room_type, r.floor_id as room_floor_id,
  //     u.id as unit_id, u.unit_number, u.unit_identifier, u.room_id as unit_room_id
  //   FROM floors f
  //   LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
  //   LEFT JOIN units u ON r.id = u.room_id
  //   WHERE f.building_id = $1 AND f.status = 'active'
  //   ORDER BY f.floor_number, r.room_number, u.unit_number
  // `;

  //   const existingResult = await client.query(existingQuery, [buildingId]);

  //   // Build existing structure map
  //   const existingStructure = {
  //     floors: new Map(),
  //     rooms: new Map(),
  //     units: new Map(),
  //   };

  //   existingResult.rows.forEach((row) => {
  //     // Build floors map
  //     if (!existingStructure.floors.has(row.floor_id)) {
  //       existingStructure.floors.set(row.floor_id, {
  //         id: row.floor_id,
  //         floorNumber: row.floor_number,
  //         floorName: row.floor_name,
  //         rooms: new Set(),
  //       });
  //     }

  //     // Build rooms map
  //     if (row.room_id && !existingStructure.rooms.has(row.room_id)) {
  //       existingStructure.rooms.set(row.room_id, {
  //         id: row.room_id,
  //         roomNumber: row.room_number,
  //         roomType: row.room_type,
  //         floorId: row.room_floor_id,
  //         units: new Set(),
  //       });
  //       existingStructure.floors.get(row.floor_id).rooms.add(row.room_id);
  //     }

  //     // Build units map
  //     if (row.unit_id && !existingStructure.units.has(row.unit_id)) {
  //       existingStructure.units.set(row.unit_id, {
  //         id: row.unit_id,
  //         unitNumber: row.unit_number,
  //         unitIdentifier: row.unit_identifier,
  //         roomId: row.unit_room_id,
  //       });
  //       if (existingStructure.rooms.has(row.unit_room_id)) {
  //         existingStructure.rooms.get(row.unit_room_id).units.add(row.unit_id);
  //       }
  //     }
  //   });

  //   // Process new structure and identify changes
  //   const toDelete = {
  //     floors: new Set(existingStructure.floors.keys()),
  //     rooms: new Set(existingStructure.rooms.keys()),
  //     units: new Set(existingStructure.units.keys()),
  //   };

  //   const toCreate = { floors: [], rooms: [], units: [] };
  //   const toUpdate = { floors: [], rooms: [], units: [] };

  //   // Process each floor in new structure
  //   for (const newFloor of parsedFloors) {
  //     let floorId = null;
  //     let floorExists = false;

  //     // Check if floor exists (by floor_number)
  //     for (const [existingFloorId, existingFloor] of existingStructure.floors) {
  //       if (existingFloor.floorNumber === newFloor.floorNumber) {
  //         floorId = existingFloorId;
  //         floorExists = true;
  //         toDelete.floors.delete(existingFloorId);

  //         // Check if floor needs update
  //         if (existingFloor.floorName !== newFloor.floorName) {
  //           toUpdate.floors.push({
  //             id: floorId,
  //             floorName: newFloor.floorName,
  //             description: newFloor.description || "",
  //           });
  //         }
  //         break;
  //       }
  //     }

  //     // Floor doesn't exist, mark for creation
  //     if (!floorExists) {
  //       toCreate.floors.push({
  //         buildingId,
  //         floorNumber: newFloor.floorNumber,
  //         floorName: newFloor.floorName,
  //         description: newFloor.description || "",
  //         rooms: newFloor.rooms || [],
  //       });
  //       continue;
  //     }

  //     // Process rooms for existing floor
  //     if (newFloor.rooms && Array.isArray(newFloor.rooms)) {
  //       for (const newRoom of newFloor.rooms) {
  //         let roomId = null;
  //         let roomExists = false;

  //         // Check if room exists (by room_number within the floor)
  //         for (const [
  //           existingRoomId,
  //           existingRoom,
  //         ] of existingStructure.rooms) {
  //           if (
  //             existingRoom.floorId === floorId &&
  //             existingRoom.roomNumber === newRoom.roomNumber
  //           ) {
  //             roomId = existingRoomId;
  //             roomExists = true;
  //             toDelete.rooms.delete(existingRoomId);

  //             // Check if room needs update
  //             if (existingRoom.roomType !== newRoom.roomType) {
  //               toUpdate.rooms.push({
  //                 id: roomId,
  //                 roomType: newRoom.roomType,
  //                 sizeSqft: newRoom.sizeSqft,
  //                 furnishingStatus: newRoom.furnishingStatus,
  //                 acAvailable: newRoom.acAvailable,
  //                 wifiAvailable: newRoom.wifiAvailable,
  //                 amenities: newRoom.amenities,
  //               });
  //             }
  //             break;
  //           }
  //         }

  //         // Room doesn't exist, mark for creation
  //         if (!roomExists) {
  //           toCreate.rooms.push({
  //             buildingId,
  //             floorId,
  //             roomNumber: newRoom.roomNumber,
  //             roomType: newRoom.roomType,
  //             sizeSqft: newRoom.sizeSqft,
  //             furnishingStatus: newRoom.furnishingStatus || "furnished",
  //             acAvailable: newRoom.acAvailable !== false,
  //             wifiAvailable: newRoom.wifiAvailable !== false,
  //             amenities: newRoom.amenities || [],
  //             units: newRoom.units || [],
  //           });
  //           continue;
  //         }

  //         // Process units for existing room
  //         if (newRoom.units && Array.isArray(newRoom.units)) {
  //           for (const newUnit of newRoom.units) {
  //             let unitExists = false;

  //             // Check if unit exists (by unit_number)
  //             for (const [
  //               existingUnitId,
  //               existingUnit,
  //             ] of existingStructure.units) {
  //               if (
  //                 existingUnit.roomId === roomId &&
  //                 existingUnit.unitNumber === newUnit.unitNumber
  //               ) {
  //                 unitExists = true;
  //                 toDelete.units.delete(existingUnitId);

  //                 // Check if unit needs update (rent, security deposit, etc.)
  //                 toUpdate.units.push({
  //                   id: existingUnitId,
  //                   rentAmount: newUnit.rentAmount,
  //                   securityDeposit: newUnit.securityDeposit,
  //                   targetSellingPrice: newUnit.targetSellingPrice,
  //                 });
  //                 break;
  //               }
  //             }

  //             // Unit doesn't exist, mark for creation
  //             if (!unitExists) {
  //               toCreate.units.push({
  //                 roomId,
  //                 unitIdentifier: newUnit.unitIdentifier,
  //                 unitNumber: newUnit.unitNumber,
  //                 rentAmount: newUnit.rentAmount || 0,
  //                 securityDeposit: newUnit.securityDeposit || 0,
  //                 targetSellingPrice: newUnit.targetSellingPrice || 0,
  //               });
  //             }
  //           }
  //         }
  //       }
  //     }
  //   }

  //   // Check for active tenancies on units to be deleted
  //   if (toDelete.units.size > 0) {
  //     const activeUnitsQuery = `
  //     SELECT u.unit_number, COUNT(*) as active_count
  //     FROM tenancies t
  //     JOIN units u ON t.unit_id = u.id
  //     WHERE u.id = ANY($1)
  //     AND t.agreement_status = 'executed'
  //     AND CURRENT_DATE >= t.start_date
  //     AND CURRENT_DATE <= t.end_date
  //     GROUP BY u.id, u.unit_number
  //   `;

  //     const activeUnitsResult = await client.query(activeUnitsQuery, [
  //       Array.from(toDelete.units),
  //     ]);

  //     if (activeUnitsResult.rows.length > 0) {
  //       const activeUnits = activeUnitsResult.rows
  //         .map((r) => r.unit_number)
  //         .join(", ");
  //       throw new Error(
  //         `Cannot delete units with active tenancies: ${activeUnits}`
  //       );
  //     }
  //   }

  //   // Execute deletions (in reverse order: units -> rooms -> floors)
  //   if (toDelete.units.size > 0) {
  //     await client.query(`DELETE FROM units WHERE id = ANY($1)`, [
  //       Array.from(toDelete.units),
  //     ]);
  //   }

  //   if (toDelete.rooms.size > 0) {
  //     await client.query(`DELETE FROM rooms WHERE id = ANY($1)`, [
  //       Array.from(toDelete.rooms),
  //     ]);
  //   }

  //   if (toDelete.floors.size > 0) {
  //     await client.query(`DELETE FROM floors WHERE id = ANY($1)`, [
  //       Array.from(toDelete.floors),
  //     ]);
  //   }

  //   // Execute updates
  //   for (const floor of toUpdate.floors) {
  //     await client.query(
  //       `UPDATE floors SET floor_name = $1, description = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
  //       [floor.floorName, floor.description, floor.id]
  //     );
  //   }

  //   for (const room of toUpdate.rooms) {
  //     await client.query(
  //       `UPDATE rooms SET room_type = $1, size_sqft = $2, furnishing_status = $3,
  //      ac_available = $4, wifi_available = $5, amenities = $6, updated_at = CURRENT_TIMESTAMP
  //      WHERE id = $7`,
  //       [
  //         room.roomType,
  //         room.sizeSqft,
  //         room.furnishingStatus,
  //         room.acAvailable,
  //         room.wifiAvailable,
  //         room.amenities,
  //         room.id,
  //       ]
  //     );
  //   }

  //   for (const unit of toUpdate.units) {
  //     await client.query(
  //       `UPDATE units SET rent_amount = $1, security_deposit = $2,
  //      target_selling_price = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4`,
  //       [
  //         unit.rentAmount,
  //         unit.securityDeposit,
  //         unit.targetSellingPrice,
  //         unit.id,
  //       ]
  //     );
  //   }

  //   // Execute creations (in order: floors -> rooms -> units)
  //   for (const floor of toCreate.floors) {
  //     const floorResult = await client.query(
  //       `INSERT INTO floors (building_id, floor_number, floor_name, description, status)
  //      VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
  //       [
  //         floor.buildingId,
  //         floor.floorNumber,
  //         floor.floorName,
  //         floor.description,
  //       ]
  //     );

  //     const newFloorId = floorResult.rows[0].id;

  //     // Create rooms for this new floor
  //     for (const room of floor.rooms) {
  //       const roomResult = await client.query(
  //         `INSERT INTO rooms (building_id, floor_id, room_number, room_type,
  //        size_sqft, furnishing_status, ac_available, wifi_available, amenities, status)
  //        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active') RETURNING id`,
  //         [
  //           floor.buildingId,
  //           newFloorId,
  //           room.roomNumber,
  //           room.roomType,
  //           room.sizeSqft,
  //           room.furnishingStatus,
  //           room.acAvailable,
  //           room.wifiAvailable,
  //           room.amenities,
  //         ]
  //       );

  //       const newRoomId = roomResult.rows[0].id;

  //       // Create units for this new room
  //       for (const unit of room.units) {
  //         await client.query(
  //           `INSERT INTO units (room_id, unit_identifier, unit_number,
  //          rent_amount, security_deposit, target_selling_price, status)
  //          VALUES ($1, $2, $3, $4, $5, $6, 'available')`,
  //           [
  //             newRoomId,
  //             unit.unitIdentifier,
  //             unit.unitNumber,
  //             unit.rentAmount,
  //             unit.securityDeposit,
  //             unit.targetSellingPrice,
  //           ]
  //         );
  //       }
  //     }
  //   }

  //   for (const room of toCreate.rooms) {
  //     const roomResult = await client.query(
  //       `INSERT INTO rooms (building_id, floor_id, room_number, room_type,
  //      size_sqft, furnishing_status, ac_available, wifi_available, amenities, status)
  //      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active') RETURNING id`,
  //       [
  //         room.buildingId,
  //         room.floorId,
  //         room.roomNumber,
  //         room.roomType,
  //         room.sizeSqft,
  //         room.furnishingStatus,
  //         room.acAvailable,
  //         room.wifiAvailable,
  //         room.amenities,
  //       ]
  //     );

  //     const newRoomId = roomResult.rows[0].id;

  //     // Create units for this new room
  //     for (const unit of room.units) {
  //       await client.query(
  //         `INSERT INTO units (room_id, unit_identifier, unit_number,
  //        rent_amount, security_deposit, target_selling_price, status)
  //        VALUES ($1, $2, $3, $4, $5, $6, 'available')`,
  //         [
  //           newRoomId,
  //           unit.unitIdentifier,
  //           unit.unitNumber,
  //           unit.rentAmount,
  //           unit.securityDeposit,
  //           unit.targetSellingPrice,
  //         ]
  //       );
  //     }
  //   }

  //   for (const unit of toCreate.units) {
  //     await client.query(
  //       `INSERT INTO units (room_id, unit_identifier, unit_number,
  //      rent_amount, security_deposit, target_selling_price, status)
  //      VALUES ($1, $2, $3, $4, $5, $6, 'available')`,
  //       [
  //         unit.roomId,
  //         unit.unitIdentifier,
  //         unit.unitNumber,
  //         unit.rentAmount,
  //         unit.securityDeposit,
  //         unit.targetSellingPrice,
  //       ]
  //     );
  //   }

  //   // Update building totals
  //   const totalsQuery = `
  //   SELECT
  //     COUNT(DISTINCT f.id) as total_floors,
  //     COUNT(DISTINCT r.id) as total_rooms,
  //     COUNT(DISTINCT u.id) as total_units
  //   FROM buildings b
  //   LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
  //   LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
  //   LEFT JOIN units u ON r.id = u.room_id
  //   WHERE b.id = $1
  // `;

  //   const totalsResult = await client.query(totalsQuery, [buildingId]);
  //   const totals = totalsResult.rows[0];

  //   await client.query(
  //     `UPDATE buildings SET total_floors = $1, total_units = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
  //     [parseInt(totals.total_floors), parseInt(totals.total_units), buildingId]
  //   );

  //   return {
  //     created: toCreate,
  //     updated: toUpdate,
  //     deleted: {
  //       floors: toDelete.floors.size,
  //       rooms: toDelete.rooms.size,
  //       units: toDelete.units.size,
  //     },
  //   };
  // }
  // Other methods remain the same but will be protected by the authorizeResource middleware
  // getBuildingById, getBuildingForEdit, getBuildingTenants, getBuildingVacancyChart,
  // getBuildingAnalytics, deleteBuilding will all work with the new RBAC system

  // For brevity, I'm not including them here, but they don't need major changes
  // since the middleware handles the authorization logic

  // Additional methods for PropertiesController with RBAC support
  // Add these to your existing PropertiesController class

  // GET /api/properties/buildings/:id (Updated with manager info)
  async getBuildingById(req, res, next) {
    try {
      const buildingId = req.params.id;
      const client = await pool.connect();

      try {
        // Get building basic info with manager information
        const buildingQuery = `
        SELECT 
          b.*,
          mu.email as manager_email,
          CONCAT(COALESCE(mup.first_name, ''), ' ', COALESCE(mup.last_name, '')) as manager_name,
          mup.phone as manager_phone,
          mup.first_name as manager_first_name,
          mup.last_name as manager_last_name
        FROM buildings b
        LEFT JOIN users mu ON b.manager_id = mu.id AND mu.role = 'manager'
        LEFT JOIN user_profiles mup ON mu.id = mup.user_id
        WHERE b.id = $1
      `;
        const buildingResult = await client.query(buildingQuery, [buildingId]);

        if (buildingResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Building not found"));
        }

        const building = buildingResult.rows[0];

        // CORRECTED: Get floors with accurate stats based on tenancy logic
        const floorsQuery = `
        SELECT 
          f.*,
          COUNT(DISTINCT r.id) as total_rooms,
          COUNT(DISTINCT u.id) as total_units,
          -- Available: No current tenancy and not in maintenance
          COUNT(DISTINCT CASE 
            WHEN u.status != 'maintenance' 
            AND NOT EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND CURRENT_DATE >= t.start_date 
              AND CURRENT_DATE <= t.end_date
            ) THEN u.id 
          END) as available_units,
          -- Occupied: Has current active tenancy
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND CURRENT_DATE >= t.start_date 
              AND CURRENT_DATE <= t.end_date
            ) THEN u.id 
          END) as occupied_units,
          -- Maintenance units
          COUNT(DISTINCT CASE WHEN u.status = 'maintenance' THEN u.id END) as maintenance_units,
          -- Upcoming units (future tenancy within 30 days)
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND t.start_date > CURRENT_DATE 
              AND t.start_date <= CURRENT_DATE + INTERVAL '30 days'
            ) THEN u.id 
          END) as upcoming_units
        FROM floors f
        LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
        LEFT JOIN units u ON r.id = u.room_id
        WHERE f.building_id = $1 AND f.status = 'active'
        GROUP BY f.id
        ORDER BY f.floor_number
      `;
        const floorsResult = await client.query(floorsQuery, [buildingId]);

        // CORRECTED: Get overall building stats with proper tenancy logic
        const statsQuery = `
        SELECT 
          COUNT(DISTINCT f.id) as total_floors,
          COUNT(DISTINCT r.id) as total_rooms,
          COUNT(DISTINCT u.id) as total_units,
          -- Available: No current tenancy and not in maintenance
          COUNT(DISTINCT CASE 
            WHEN u.status != 'maintenance' 
            AND NOT EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND CURRENT_DATE >= t.start_date 
              AND CURRENT_DATE <= t.end_date
            ) THEN u.id 
          END) as available_units,
          -- Occupied: Has current active tenancy
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND CURRENT_DATE >= t.start_date 
              AND CURRENT_DATE <= t.end_date
            ) THEN u.id 
          END) as occupied_units,
          -- Maintenance units
          COUNT(DISTINCT CASE WHEN u.status = 'maintenance' THEN u.id END) as maintenance_units,
          -- Upcoming units
          COUNT(DISTINCT CASE 
            WHEN EXISTS (
              SELECT 1 FROM tenancies t 
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND t.start_date > CURRENT_DATE 
              AND t.start_date <= CURRENT_DATE + INTERVAL '30 days'
            ) THEN u.id 
          END) as upcoming_units,
          -- Rent statistics
          COALESCE(AVG(u.rent_amount), 0) as average_rent,
          COALESCE(MIN(u.rent_amount), 0) as min_rent,
          COALESCE(MAX(u.rent_amount), 0) as max_rent,
          -- Current monthly revenue from active tenancies
          COALESCE((
            SELECT SUM(t.rent_amount) 
            FROM tenancies t
            JOIN units tu ON t.unit_id = tu.id
            JOIN rooms tr ON tu.room_id = tr.id
            WHERE tr.building_id = $1
            AND t.agreement_status = 'executed'
            AND CURRENT_DATE >= t.start_date 
            AND CURRENT_DATE <= t.end_date
          ), 0) as current_monthly_revenue
        FROM buildings b
        LEFT JOIN floors f ON b.id = f.building_id AND f.status = 'active'
        LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
        LEFT JOIN units u ON r.id = u.room_id
        WHERE b.id = $1
      `;
        const statsResult = await client.query(statsQuery, [buildingId]);
        const stats = statsResult.rows[0];

        // Calculate accurate occupancy rate
        const totalUnits = parseInt(stats.total_units);
        const occupiedUnits = parseInt(stats.occupied_units);
        const occupancyRate =
          totalUnits > 0 ? ((occupiedUnits / totalUnits) * 100).toFixed(2) : 0;

        // Calculate utilization rate (occupied + upcoming)
        const upcomingUnits = parseInt(stats.upcoming_units);
        const utilizationRate =
          totalUnits > 0
            ? (((occupiedUnits + upcomingUnits) / totalUnits) * 100).toFixed(2)
            : 0;

        // Enhanced revenue calculations for current month
        const currentDate = new Date();
        const currentMonth = currentDate.getMonth() + 1;
        const currentYear = currentDate.getFullYear();

        const revenueQuery = `
        SELECT 
          COALESCE(SUM(rc.rent_amount), 0) as total_rent_due,
          COALESCE(SUM(rc.paid_amount), 0) as total_rent_collected,
          COALESCE(SUM(rc.rent_amount - rc.paid_amount), 0) as total_outstanding,
          COUNT(DISTINCT rc.tenancy_id) as active_rent_cycles,
          -- Get potential revenue if all units were occupied (sum of all unit rents)
          (
            SELECT COALESCE(SUM(u.rent_amount), 0)
            FROM units u
            JOIN rooms r ON u.room_id = r.id
            WHERE r.building_id = $1
          ) as potential_monthly_revenue,
          -- Current monthly revenue from only ongoing tenancies
          (
            SELECT COALESCE(SUM(t.rent_amount), 0)
            FROM tenancies t
            JOIN units u ON t.unit_id = u.id
            JOIN rooms r ON u.room_id = r.id
            WHERE r.building_id = $1
            AND t.agreement_status = 'executed'
            AND CURRENT_DATE >= t.start_date 
            AND CURRENT_DATE <= t.end_date
          ) as current_monthly_revenue
        FROM rent_cycles rc
        JOIN tenancies t ON rc.tenancy_id = t.id
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        WHERE r.building_id = $1 AND rc.cycle_month = $2 AND rc.cycle_year = $3
      `;
        const revenueResult = await client.query(revenueQuery, [
          buildingId,
          currentMonth,
          currentYear,
        ]);
        const revenue = revenueResult.rows[0];

        // Calculate collection rate
        const collectionRate =
          parseFloat(revenue.total_rent_due) > 0
            ? (
                (parseFloat(revenue.total_rent_collected) /
                  parseFloat(revenue.total_rent_due)) *
                100
              ).toFixed(2)
            : 0;

        // Calculate revenue utilization
        const potentialRevenue = parseFloat(revenue.potential_monthly_revenue);
        const actualRevenue = parseFloat(stats.current_monthly_revenue);
        const revenueUtilization =
          potentialRevenue > 0
            ? ((actualRevenue / potentialRevenue) * 100).toFixed(2)
            : 0;

        // Get additional insights
        const insightsQuery = `
        SELECT 
          -- Lease expiration alerts (next 30 days)
          COUNT(CASE 
            WHEN t.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' 
            THEN 1 
          END) as expiring_leases,
          -- Long vacant units (available for more than 30 days)
          COUNT(CASE 
            WHEN NOT EXISTS (
              SELECT 1 FROM tenancies tt 
              WHERE tt.unit_id = u.id 
              AND tt.agreement_status = 'executed'
              AND CURRENT_DATE >= tt.start_date 
              AND CURRENT_DATE <= tt.end_date
            )
            AND u.status != 'maintenance'
            AND (
              SELECT MAX(tt.end_date) 
              FROM tenancies tt 
              WHERE tt.unit_id = u.id 
              AND tt.agreement_status IN ('executed', 'terminated')
            ) < CURRENT_DATE - INTERVAL '30 days'
            THEN 1 
          END) as long_vacant_units,
          -- Average tenancy duration (in days)
          COALESCE(AVG(
            CASE 
              WHEN t.move_out_date IS NOT NULL 
              THEN (t.move_out_date - t.move_in_date)
              WHEN t.agreement_status = 'executed' AND t.end_date >= CURRENT_DATE
              THEN (CURRENT_DATE - COALESCE(t.move_in_date, t.start_date))
              ELSE NULL
            END
          ), 0) as avg_tenancy_duration_days
        FROM units u
        JOIN rooms r ON u.room_id = r.id
        LEFT JOIN tenancies t ON u.id = t.unit_id AND t.agreement_status = 'executed'
        WHERE r.building_id = $1
      `;
        const insightsResult = await client.query(insightsQuery, [buildingId]);
        const insights = insightsResult.rows[0];

        // Convert average tenancy duration from days to months
        const avgTenancyDurationMonths = insights.avg_tenancy_duration_days
          ? (parseFloat(insights.avg_tenancy_duration_days) / 30.44).toFixed(1)
          : 0;

        const response = {
          success: true,
          data: {
            building: {
              id: building.id,
              name: building.name,
              propertyCode: building.building_code,
              address: {
                line1: building.address_line1,
                line2: building.address_line2,
                city: building.city,
                state: building.state,
                postalCode: building.postal_code,
              },
              description: building.description,
              amenities: building.amenities || [],
              contactPerson: building.contact_person,
              contactPhone: building.contact_phone,
              buildingImage: building.building_image,
              // Manager information
              manager: building.manager_id
                ? {
                    id: building.manager_id,
                    email: building.manager_email,
                    name: (building.manager_name || "").trim() || "Unknown",
                    phone: building.manager_phone,
                    firstName: building.manager_first_name,
                    lastName: building.manager_last_name,
                  }
                : null,
              status: building.status,
              createdAt: building.created_at,
              updatedAt: building.updated_at,
            },
            stats: {
              totalFloors: parseInt(stats.total_floors),
              totalRooms: parseInt(stats.total_rooms),
              totalUnits: totalUnits,
              availableUnits: parseInt(stats.available_units),
              occupiedUnits: occupiedUnits,
              maintenanceUnits: parseInt(stats.maintenance_units),
              upcomingUnits: upcomingUnits,
              occupancyRate: parseFloat(occupancyRate),
              utilizationRate: parseFloat(utilizationRate),
              averageRent: parseFloat(stats.average_rent),
              minRent: parseFloat(stats.min_rent),
              maxRent: parseFloat(stats.max_rent),
              currentMonthlyRevenue: parseFloat(stats.current_monthly_revenue),
              // Performance indicators
              performance: {
                occupancyGrade:
                  occupancyRate >= 90
                    ? "A"
                    : occupancyRate >= 80
                    ? "B"
                    : occupancyRate >= 70
                    ? "C"
                    : "D",
                revenueEfficiency: parseFloat(revenueUtilization),
                averageTenancyDuration: avgTenancyDurationMonths,
              },
            },
            revenue: {
              totalRentDue: parseFloat(revenue.total_rent_due),
              totalRentCollected: parseFloat(revenue.total_rent_collected),
              totalOutstanding: parseFloat(revenue.total_outstanding),
              collectionRate: parseFloat(collectionRate),
              potentialMonthlyRevenue: potentialRevenue,
              currentMonthlyRevenue: revenue.current_monthly_revenue,
              revenueUtilization: parseFloat(revenueUtilization),
              activeTenancies: parseInt(revenue.active_rent_cycles),
              month: currentMonth,
              year: currentYear,
            },
            floors: floorsResult.rows.map((floor) => ({
              id: floor.id,
              floorNumber: floor.floor_number,
              floorName: floor.floor_name,
              totalRooms: parseInt(floor.total_rooms),
              totalUnits: parseInt(floor.total_units),
              availableUnits: parseInt(floor.available_units),
              occupiedUnits: parseInt(floor.occupied_units),
              maintenanceUnits: parseInt(floor.maintenance_units),
              upcomingUnits: parseInt(floor.upcoming_units),
              floorPlanImage: floor.floor_plan_image,
              description: floor.description,
              status: floor.status,
              // Floor-specific occupancy rate
              occupancyRate:
                parseInt(floor.total_units) > 0
                  ? (
                      (parseInt(floor.occupied_units) /
                        parseInt(floor.total_units)) *
                      100
                    ).toFixed(1)
                  : 0,
            })),
            insights: {
              expiringLeases: parseInt(insights.expiring_leases),
              longVacantUnits: parseInt(insights.long_vacant_units),
              averageTenancyDuration: avgTenancyDurationMonths,
              alerts: {
                highPriority:
                  parseInt(insights.expiring_leases) > 0 ||
                  parseInt(insights.long_vacant_units) > 2,
                maintenanceBacklog: parseInt(stats.maintenance_units) > 3,
                lowOccupancy: parseFloat(occupancyRate) < 70,
              },
            },
            metadata: {
              generatedAt: new Date().toISOString(),
              dataAccuracy: "Real-time based on current tenancies",
              lastUpdated: building.updated_at,
              userRole: req.user.role,
              canEdit: [ROLES.SUPER_ADMIN, ROLES.ADMIN].includes(req.user.role),
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

  // GET /api/properties/buildings/:id/edit (Updated with manager info)
  async getBuildingForEdit(req, res, next) {
    try {
      const buildingId = req.params.id;
      const client = await pool.connect();

      try {
        // Get building basic info with manager information
        const buildingQuery = `
        SELECT 
          b.*,
          mu.email as manager_email,
          CONCAT(COALESCE(mup.first_name, ''), ' ', COALESCE(mup.last_name, '')) as manager_name,
          mup.phone as manager_phone
        FROM buildings b
        LEFT JOIN users mu ON b.manager_id = mu.id AND mu.role = 'manager'
        LEFT JOIN user_profiles mup ON mu.id = mup.user_id
        WHERE b.id = $1
      `;
        const buildingResult = await client.query(buildingQuery, [buildingId]);

        if (buildingResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Building not found"));
        }

        const building = buildingResult.rows[0];

        // Get floors with rooms and units (same logic as before)
        const floorsQuery = `
        SELECT 
          f.id as floor_id,
          f.floor_number,
          f.floor_name,
          f.description as floor_description,
          r.id as room_id,
          r.room_number,
          r.room_type,
          r.size_sqft,
          r.furnishing_status,
          r.ac_available,
          r.wifi_available,
          r.amenities as room_amenities,
          u.id as unit_id,
          u.unit_identifier,
          u.unit_number,
          u.rent_amount,
          u.security_deposit,
          u.target_selling_price
        FROM floors f
        LEFT JOIN rooms r ON f.id = r.floor_id AND r.status = 'active'
        LEFT JOIN units u ON r.id = u.room_id
        WHERE f.building_id = $1 AND f.status = 'active'
        ORDER BY f.floor_number, r.room_number, u.unit_number
      `;

        const floorsResult = await client.query(floorsQuery, [buildingId]);

        // Transform the flat result into nested structure
        const floorsMap = new Map();

        floorsResult.rows.forEach((row) => {
          // Create floor if not exists
          if (!floorsMap.has(row.floor_id)) {
            floorsMap.set(row.floor_id, {
              id: row.floor_id,
              floorNumber: row.floor_number,
              floorName: row.floor_name,
              description: row.floor_description || "",
              rooms: new Map(),
            });
          }

          const floor = floorsMap.get(row.floor_id);

          // Create room if not exists and has room data
          if (row.room_id && !floor.rooms.has(row.room_id)) {
            floor.rooms.set(row.room_id, {
              id: row.room_id,
              roomNumber: row.room_number,
              roomType: row.room_type,
              sizeSqft: row.size_sqft,
              furnishingStatus: row.furnishing_status,
              acAvailable: row.ac_available,
              wifiAvailable: row.wifi_available,
              amenities: row.room_amenities || [],
              units: [],
            });
          }

          // Add unit if exists
          if (row.unit_id && row.room_id) {
            const room = floor.rooms.get(row.room_id);
            room.units.push({
              id: row.unit_id,
              unitNumber: row.unit_number,
              unitIdentifier: row.unit_identifier,
              rentAmount: row.rent_amount,
              securityDeposit: row.security_deposit,
              targetSellingPrice: row.target_selling_price,
            });
          }
        });

        // Convert maps to arrays
        const floors = Array.from(floorsMap.values()).map((floor) => ({
          ...floor,
          rooms: Array.from(floor.rooms.values()),
        }));

        const response = {
          success: true,
          data: {
            id: building.id,
            name: building.name,
            propertyCode: building.building_code,
            description: building.description,
            contactPerson: building.contact_person,
            contactPhone: building.contact_phone,
            addressLine1: building.address_line1,
            addressLine2: building.address_line2,
            city: building.city,
            state: building.state,
            postalCode: building.postal_code,
            amenities: building.amenities || [],
            masterImage: building.building_image,
            otherImages: [], // You can implement this if you have multiple images
            // Manager information for editing
            manager: building.manager_id
              ? {
                  id: building.manager_id,
                  email: building.manager_email,
                  name: (building.manager_name || "").trim() || "Unknown",
                  phone: building.manager_phone,
                }
              : null,
            floors: floors,
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

  // Updated updateBuilding method to handle manager assignment changes
  // async updateBuilding(req, res, next) {
  //   try {
  //     const buildingId = req.params.id;
  //     const {
  //       name,
  //       propertyCode,
  //       addressLine1,
  //       addressLine2,
  //       city,
  //       state,
  //       postalCode,
  //       description,
  //       amenities,
  //       contactPerson,
  //       contactPhone,
  //       status,
  //       managerId, // NEW: Manager reassignment
  //       floors,
  //     } = req.body;

  //     const client = await pool.connect();

  //     try {
  //       await client.query("BEGIN");

  //       // Check if building exists
  //       const existingQuery = `
  //         SELECT building_image, manager_id FROM buildings WHERE id = $1
  //       `;
  //       const existingResult = await client.query(existingQuery, [buildingId]);

  //       if (existingResult.rows.length === 0) {
  //         await client.query("ROLLBACK");
  //         return next(createError("NOT_FOUND", "Building not found"));
  //       }

  //       const existingBuilding = existingResult.rows[0];
  //       let imagePath = existingBuilding.building_image;

  //       // Validate manager if provided
  //       if (managerId !== undefined) {
  //         if (managerId !== null) {
  //           const managerQuery = `
  //             SELECT id, email FROM users
  //             WHERE id = $1 AND role = 'manager' AND status = 'active'
  //           `;
  //           const managerResult = await client.query(managerQuery, [managerId]);

  //           if (managerResult.rows.length === 0) {
  //             await client.query("ROLLBACK");
  //             return next(
  //               createError(
  //                 "VALIDATION_ERROR",
  //                 "Invalid manager ID or manager is not active"
  //               )
  //             );
  //           }
  //         }
  //       }

  //       // Handle image upload if provided
  //       if (req.file) {
  //         imagePath = `/uploads/buildings/${req.file.filename}`;
  //       }

  //       // Parse amenities and floors if provided
  //       let parsedAmenities = null;
  //       let parsedFloors = null;

  //       if (amenities) {
  //         try {
  //           parsedAmenities =
  //             typeof amenities === "string" ? JSON.parse(amenities) : amenities;
  //         } catch (error) {
  //           await client.query("ROLLBACK");
  //           return next(
  //             createError("VALIDATION_ERROR", "Invalid amenities format")
  //           );
  //         }
  //       }

  //       if (floors) {
  //         try {
  //           parsedFloors =
  //             typeof floors === "string" ? JSON.parse(floors) : floors;
  //         } catch (error) {
  //           await client.query("ROLLBACK");
  //           return next(
  //             createError("VALIDATION_ERROR", "Invalid floors format")
  //           );
  //         }
  //       }

  //       // Update building basic info including manager
  //       const updateBuildingQuery = `
  //         UPDATE buildings SET
  //           name = COALESCE($1, name),
  //           building_code = COALESCE($2, building_code),
  //           address_line1 = COALESCE($3, address_line1),
  //           address_line2 = COALESCE($4, address_line2),
  //           city = COALESCE($5, city),
  //           state = COALESCE($6, state),
  //           postal_code = COALESCE($7, postal_code),
  //           description = COALESCE($8, description),
  //           amenities = COALESCE($9, amenities),
  //           contact_person = COALESCE($10, contact_person),
  //           contact_phone = COALESCE($11, contact_phone),
  //           status = COALESCE($12, status),
  //           building_image = COALESCE($13, building_image),
  //           manager_id = CASE WHEN $14::boolean THEN $15 ELSE manager_id END,
  //           updated_at = CURRENT_TIMESTAMP
  //         WHERE id = $16
  //         RETURNING *
  //       `;

  //       const buildingValues = [
  //         name,
  //         propertyCode,
  //         addressLine1,
  //         addressLine2,
  //         city,
  //         state,
  //         postalCode,
  //         description,
  //         parsedAmenities,
  //         contactPerson,
  //         contactPhone,
  //         status,
  //         imagePath,
  //         managerId !== undefined, // Boolean to indicate if manager should be updated
  //         managerId, // The actual manager ID (can be null)
  //         buildingId,
  //       ];

  //       const buildingResult = await client.query(
  //         updateBuildingQuery,
  //         buildingValues
  //       );
  //       const building = buildingResult.rows[0];

  //       // Handle floors/rooms/units update if provided (same logic as create)
  //       if (parsedFloors && Array.isArray(parsedFloors)) {
  //         // Delete existing floors, rooms, and units for this building
  //         await client.query(
  //           `
  //           DELETE FROM units WHERE room_id IN (
  //             SELECT r.id FROM rooms r
  //             JOIN floors f ON r.floor_id = f.id
  //             WHERE f.building_id = $1
  //           )
  //         `,
  //           [buildingId]
  //         );

  //         await client.query(
  //           `
  //           DELETE FROM rooms WHERE floor_id IN (
  //             SELECT id FROM floors WHERE building_id = $1
  //           )
  //         `,
  //           [buildingId]
  //         );

  //         await client.query(`DELETE FROM floors WHERE building_id = $1`, [
  //           buildingId,
  //         ]);

  //         // Insert new structure (reuse creation logic here)
  //         // ... (same floor/room/unit creation logic as in createBuilding)
  //       }

  //       // Get updated manager info for response
  //       let managerInfo = null;
  //       if (building.manager_id) {
  //         const managerInfoQuery = `
  //           SELECT u.id, u.email, up.first_name, up.last_name, up.phone
  //           FROM users u
  //           LEFT JOIN user_profiles up ON u.id = up.user_id
  //           WHERE u.id = $1
  //         `;
  //         const managerInfoResult = await client.query(managerInfoQuery, [
  //           building.manager_id,
  //         ]);
  //         if (managerInfoResult.rows.length > 0) {
  //           const manager = managerInfoResult.rows[0];
  //           managerInfo = {
  //             id: manager.id,
  //             email: manager.email,
  //             name:
  //               `${manager.first_name || ""} ${
  //                 manager.last_name || ""
  //               }`.trim() || "Unknown",
  //             phone: manager.phone,
  //           };
  //         }
  //       }

  //       await client.query("COMMIT");

  //       const response = {
  //         success: true,
  //         message: "Building updated successfully",
  //         data: {
  //           id: building.id,
  //           name: building.name,
  //           propertyCode: building.building_code,
  //           address: {
  //             line1: building.address_line1,
  //             line2: building.address_line2,
  //             city: building.city,
  //             state: building.state,
  //             postalCode: building.postal_code,
  //           },
  //           description: building.description,
  //           amenities: building.amenities || [],
  //           contactPerson: building.contact_person,
  //           contactPhone: building.contact_phone,
  //           buildingImage: building.building_image,
  //           manager: managerInfo, // NEW: Include updated manager info
  //           status: building.status,
  //           updatedAt: building.updated_at,
  //         },
  //       };

  //       res.json(response);
  //     } catch (error) {
  //       await client.query("ROLLBACK");
  //       throw error;
  //     } finally {
  //       client.release();
  //     }
  //   } catch (error) {
  //     next(error);
  //   }
  // }

  // Updated getBuildingTenants method with corrected date logic
  async getBuildingTenants(req, res, next) {
    try {
      const buildingId = req.params.id;
      const {
        type = "current,future,past",
        include = "profile,emergency",
        page = 1,
        limit = 50,
        search,
        status,
        floor,
      } = req.query;

      const client = await pool.connect();

      try {
        // Validate building exists
        const buildingCheck = await client.query(
          "SELECT id FROM buildings WHERE id = $1",
          [buildingId]
        );
        if (buildingCheck.rows.length === 0) {
          return next(createError("NOT_FOUND", "Building not found"));
        }

        const tenantTypes = type.split(",").map((t) => t.trim());
        const includeOptions = include.split(",").map((i) => i.trim());

        // Build WHERE conditions for tenancy types with CORRECTED date logic
        let tenancyTypeConditions = [];
        if (tenantTypes.includes("current")) {
          tenancyTypeConditions.push(
            `(t.agreement_status = 'executed' AND CURRENT_DATE >= t.start_date AND CURRENT_DATE <= t.end_date)`
          );
        }
        if (tenantTypes.includes("future")) {
          tenancyTypeConditions.push(
            `(t.agreement_status = 'executed' AND t.start_date > CURRENT_DATE)`
          );
        }
        if (tenantTypes.includes("past")) {
          tenancyTypeConditions.push(
            `(t.agreement_status IN ('executed', 'expired', 'terminated') AND (t.end_date < CURRENT_DATE OR t.agreement_status IN ('expired', 'terminated')))`
          );
        }

        let whereClause = `WHERE r.building_id = $1`;
        let queryParams = [buildingId];
        let paramIndex = 2;

        if (tenancyTypeConditions.length > 0) {
          whereClause += ` AND (${tenancyTypeConditions.join(" OR ")})`;
        }

        // Add search filter
        if (search) {
          whereClause += ` AND (LOWER(up.first_name) LIKE LOWER($${paramIndex}) OR LOWER(up.last_name) LIKE LOWER($${paramIndex}) OR LOWER(u.email) LIKE LOWER($${paramIndex}) OR un.unit_number LIKE $${paramIndex})`;
          queryParams.push(`%${search}%`);
          paramIndex++;
        }

        // Add status filter
        if (status) {
          whereClause += ` AND t.agreement_status = $${paramIndex}`;
          queryParams.push(status);
          paramIndex++;
        }

        // Add floor filter
        if (floor) {
          whereClause += ` AND f.floor_number = $${paramIndex}`;
          queryParams.push(floor);
          paramIndex++;
        }

        // Build SELECT fields based on include options
        let selectFields = `
            t.id as tenancy_id,
            t.tenant_user_id,
            up.first_name,
            up.last_name,
            u.email,
            up.phone,
            un.unit_number,
            un.id as unit_id,
            r.room_number,
            r.room_type,
            f.floor_number,
            f.floor_name,
            t.start_date,
            t.end_date,
            t.rent_amount,
            t.security_deposit,
            t.agreement_status,
            t.move_in_date,
            t.move_out_date,
            t.notice_period_days,
            t.created_at as tenancy_created_at,
            u.status as user_status,
            u.created_at as user_created_at,
            -- CORRECTED tenancy type logic based on actual dates
            CASE 
              WHEN t.agreement_status = 'executed' AND CURRENT_DATE >= t.start_date AND CURRENT_DATE <= t.end_date THEN 'current'
              WHEN t.agreement_status = 'executed' AND t.start_date > CURRENT_DATE THEN 'future'
              WHEN t.agreement_status IN ('executed', 'expired', 'terminated') AND (t.end_date < CURRENT_DATE OR t.agreement_status IN ('expired', 'terminated')) THEN 'past'
              ELSE 'pending'
            END as tenancy_type
          `;

        if (includeOptions.includes("profile")) {
          selectFields += `,
            up.date_of_birth,
            up.gender,
            up.profile_picture,
            up.id_proof_type,
            up.id_proof_number
          `;
        }

        if (includeOptions.includes("emergency")) {
          selectFields += `,
            up.emergency_contact_name,
            up.emergency_contact_phone,
            up.emergency_contact_relation
          `;
        }

        if (includeOptions.includes("documents")) {
          selectFields += `,
            t.documents_submitted,
            up.id_proof_document
          `;
        }

        // Main tenants query with corrected ordering
        const tenantsQuery = `
            SELECT ${selectFields}
            FROM tenancies t
            JOIN users u ON t.tenant_user_id = u.id
            JOIN user_profiles up ON u.id = up.user_id
            JOIN units un ON t.unit_id = un.id
            JOIN rooms r ON un.room_id = r.id
            JOIN floors f ON r.floor_id = f.id
            ${whereClause}
            ORDER BY 
              CASE 
                WHEN t.agreement_status = 'executed' AND CURRENT_DATE >= t.start_date AND CURRENT_DATE <= t.end_date THEN 1
                WHEN t.agreement_status = 'executed' AND t.start_date > CURRENT_DATE THEN 2
                ELSE 3
              END,
              f.floor_number, 
              un.unit_number
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
          `;

        queryParams.push(limit, (page - 1) * limit);

        const tenantsResult = await client.query(tenantsQuery, queryParams);

        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(*) as total
            FROM tenancies t
            JOIN users u ON t.tenant_user_id = u.id
            JOIN user_profiles up ON u.id = up.user_id
            JOIN units un ON t.unit_id = un.id
            JOIN rooms r ON un.room_id = r.id
            JOIN floors f ON r.floor_id = f.id
            ${whereClause}
          `;

        const countResult = await client.query(
          countQuery,
          queryParams.slice(0, -2)
        ); // Remove limit and offset
        const total = parseInt(countResult.rows[0].total);

        // Process and group tenants with enhanced data
        const allTenants = tenantsResult.rows.map((tenant) => ({
          tenancyId: tenant.tenancy_id,
          userId: tenant.tenant_user_id,
          tenancyType: tenant.tenancy_type,
          personalInfo: {
            firstName: tenant.first_name,
            lastName: tenant.last_name,
            fullName: `${tenant.first_name || ""} ${
              tenant.last_name || ""
            }`.trim(),
            email: tenant.email,
            phone: tenant.phone,
            ...(includeOptions.includes("profile") && {
              dateOfBirth: tenant.date_of_birth,
              gender: tenant.gender,
              profilePicture: tenant.profile_picture,
              idProofType: tenant.id_proof_type,
              idProofNumber: tenant.id_proof_number,
            }),
            userStatus: tenant.user_status,
            userCreatedAt: tenant.user_created_at,
          },
          ...(includeOptions.includes("emergency") && {
            emergencyContact: {
              name: tenant.emergency_contact_name,
              phone: tenant.emergency_contact_phone,
              relation: tenant.emergency_contact_relation,
            },
          }),
          unitInfo: {
            unitId: tenant.unit_id,
            unitNumber: tenant.unit_number,
            roomNumber: tenant.room_number,
            roomType: tenant.room_type,
            floorNumber: tenant.floor_number,
            floorName: tenant.floor_name,
          },
          tenancyInfo: {
            startDate: tenant.start_date,
            endDate: tenant.end_date,
            rentAmount: parseFloat(tenant.rent_amount),
            securityDeposit: parseFloat(tenant.security_deposit),
            agreementStatus: tenant.agreement_status,
            moveInDate: tenant.move_in_date,
            moveOutDate: tenant.move_out_date,
            noticePeriodDays: tenant.notice_period_days,
            ...(includeOptions.includes("documents") && {
              documentsSubmitted: tenant.documents_submitted || [],
              idProofDocument: tenant.id_proof_document,
            }),
            tenancyCreatedAt: tenant.tenancy_created_at,

            // Add computed fields for business logic
            daysUntilEnd:
              tenant.tenancy_type === "current" && tenant.end_date
                ? Math.ceil(
                    (new Date(tenant.end_date) - new Date()) /
                      (1000 * 60 * 60 * 24)
                  )
                : null,
            daysUntilStart:
              tenant.tenancy_type === "future"
                ? Math.ceil(
                    (new Date(tenant.start_date) - new Date()) /
                      (1000 * 60 * 60 * 24)
                  )
                : null,
            isExpiringSoon: function () {
              return (
                this.daysUntilEnd !== null &&
                this.daysUntilEnd <= 30 &&
                this.daysUntilEnd > 0
              );
            },
            isMovingInSoon: function () {
              return (
                this.daysUntilStart !== null &&
                this.daysUntilStart <= 7 &&
                this.daysUntilStart > 0
              );
            },
          },
        }));

        // Enhanced grouping with corrected categorization
        const groupedTenants = {
          all: allTenants,
          current: allTenants
            .filter((t) => t.tenancyType === "current")
            .map((t) => ({
              tenancyId: t.tenancyId,
              userId: t.userId,
              name: t.personalInfo.fullName,
              email: t.personalInfo.email,
              phone: t.personalInfo.phone,
              unitNumber: t.unitInfo.unitNumber,
              roomNumber: t.unitInfo.roomNumber,
              floorNumber: t.unitInfo.floorNumber,
              startDate: t.tenancyInfo.startDate,
              endDate: t.tenancyInfo.endDate,
              rentAmount: t.tenancyInfo.rentAmount,
              agreementStatus: t.tenancyInfo.agreementStatus,
              profilePicture: t.personalInfo.profilePicture,
              daysUntilEnd: t.tenancyInfo.daysUntilEnd,
              isExpiringSoon:
                t.tenancyInfo.daysUntilEnd <= 30 &&
                t.tenancyInfo.daysUntilEnd > 0,
            })),
          future: allTenants
            .filter((t) => t.tenancyType === "future")
            .map((t) => ({
              tenancyId: t.tenancyId,
              name: t.personalInfo.fullName,
              email: t.personalInfo.email,
              phone: t.personalInfo.phone,
              unitNumber: t.unitInfo.unitNumber,
              roomNumber: t.unitInfo.roomNumber,
              floorNumber: t.unitInfo.floorNumber,
              startDate: t.tenancyInfo.startDate,
              endDate: t.tenancyInfo.endDate,
              rentAmount: t.tenancyInfo.rentAmount,
              agreementStatus: t.tenancyInfo.agreementStatus,
              daysUntilStart: t.tenancyInfo.daysUntilStart,
              isMovingInSoon:
                t.tenancyInfo.daysUntilStart <= 7 &&
                t.tenancyInfo.daysUntilStart > 0,
            })),
          past: allTenants
            .filter((t) => t.tenancyType === "past")
            .map((t) => ({
              tenancyId: t.tenancyId,
              name: t.personalInfo.fullName,
              email: t.personalInfo.email,
              phone: t.personalInfo.phone,
              unitNumber: t.unitInfo.unitNumber,
              roomNumber: t.unitInfo.roomNumber,
              floorNumber: t.unitInfo.floorNumber,
              startDate: t.tenancyInfo.startDate,
              endDate: t.tenancyInfo.endDate,
              moveOutDate: t.tenancyInfo.moveOutDate,
              rentAmount: t.tenancyInfo.rentAmount,
              agreementStatus: t.tenancyInfo.agreementStatus,
            })),
        };

        // Calculate summary statistics
        const summary = {
          total: allTenants.length,
          current: groupedTenants.current.length,
          future: groupedTenants.future.length,
          past: groupedTenants.past.length,
          expiringSoon: groupedTenants.current.filter((t) => t.isExpiringSoon)
            .length,
          movingInSoon: groupedTenants.future.filter((t) => t.isMovingInSoon)
            .length,
          totalRevenue: groupedTenants.current.reduce(
            (sum, t) => sum + t.rentAmount,
            0
          ),
          averageRent:
            groupedTenants.current.length > 0
              ? groupedTenants.current.reduce(
                  (sum, t) => sum + t.rentAmount,
                  0
                ) / groupedTenants.current.length
              : 0,
        };

        const response = {
          success: true,
          data: groupedTenants,
          summary,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            itemsPerPage: parseInt(limit),
            hasNextPage: page * limit < total,
            hasPrevPage: page > 1,
          },
          filters: {
            type,
            include,
            search,
            status,
            floor,
          },
          metadata: {
            generatedAt: new Date().toISOString(),
            includeOptions,
            tenantTypes,
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

  // GET /api/properties/buildings/:id/vacancy-chart
  async getBuildingVacancyChart(req, res, next) {
    try {
      const buildingId = req.params.id;
      const {
        range = 90,
        includeHistory = "true",
        groupBy = "floor",
        floor,
        roomType,
      } = req.query;

      // Parameters validation
      const lookAheadDays = Math.min(Math.max(parseInt(range), 7), 365);
      const shouldIncludeHistory = includeHistory !== "false";

      // Calculate date ranges
      const today = new Date();
      const futureDate = new Date();
      futureDate.setDate(today.getDate() + lookAheadDays);

      const client = await pool.connect();

      try {
        // Validate building exists
        const buildingCheck = await client.query(
          "SELECT id FROM buildings WHERE id = $1",
          [buildingId]
        );
        if (buildingCheck.rows.length === 0) {
          return next(createError("NOT_FOUND", "Building not found"));
        }

        // Build dynamic WHERE clause for optional filters
        let additionalFilters = "";
        const queryParams = [buildingId, futureDate];
        let paramIndex = 3;

        if (floor) {
          additionalFilters += ` AND f.floor_number = $${paramIndex}`;
          queryParams.push(parseInt(floor));
          paramIndex++;
        }

        if (roomType) {
          additionalFilters += ` AND r.room_type = $${paramIndex}`;
          queryParams.push(roomType);
          paramIndex++;
        }

        // Main enhanced query to get all units with comprehensive tenancy information
        const unitsQuery = `
          WITH unit_tenancies AS (
            SELECT DISTINCT ON (u.id)
              u.id as unit_id,
              u.unit_number,
              u.unit_identifier,
              u.rent_amount,
              u.security_deposit,
              u.target_selling_price,
              u.status as unit_status,
              
              -- Room and floor information
              r.room_number,
              r.room_type,
              r.size_sqft,
              r.furnishing_status,
              r.ac_available,
              r.wifi_available,
              r.amenities as room_amenities,
              
              f.floor_number,
              f.floor_name,
              
              b.name as building_name,
              
              -- Current tenancy (active today)
              ct.id as current_tenancy_id,
              ct.start_date as current_start_date,
              ct.end_date as current_end_date,
              ct.rent_amount as current_rent,
              ct.security_deposit as current_deposit,
              ct.agreement_status as current_agreement_status,
              
              -- Current tenant details
              cu.email as current_tenant_email,
              CONCAT(COALESCE(cup.first_name, ''), ' ', COALESCE(cup.last_name, '')) as current_tenant_name,
              cup.phone as current_tenant_phone,
              
              -- Upcoming tenancy (next future tenancy)
              ut.id as upcoming_tenancy_id,
              ut.start_date as upcoming_start_date,
              ut.end_date as upcoming_end_date,
              ut.rent_amount as upcoming_rent,
              ut.security_deposit as upcoming_deposit,
              ut.agreement_status as upcoming_agreement_status,
              
              -- Upcoming tenant details
              uu.email as upcoming_tenant_email,
              CONCAT(COALESCE(uup.first_name, ''), ' ', COALESCE(uup.last_name, '')) as upcoming_tenant_name,
              uup.phone as upcoming_tenant_phone,
              
              -- Last vacancy information
              (
                SELECT MAX(t.end_date)
                FROM tenancies t
                WHERE t.unit_id = u.id 
                AND t.end_date < CURRENT_DATE
                AND t.agreement_status IN ('executed', 'terminated')
              ) as last_vacant_date,
              
              -- Count of total tenancies for this unit
              (
                SELECT COUNT(*)
                FROM tenancies t
                WHERE t.unit_id = u.id
                AND t.agreement_status IN ('executed', 'terminated')
              ) as total_tenancies_count
              
            FROM units u
            INNER JOIN rooms r ON u.room_id = r.id
            INNER JOIN floors f ON r.floor_id = f.id
            INNER JOIN buildings b ON r.building_id = b.id
            
            -- Current tenancy (active today - start_date <= today <= end_date)
            LEFT JOIN tenancies ct ON u.id = ct.unit_id 
              AND ct.agreement_status = 'executed'
              AND CURRENT_DATE >= ct.start_date 
              AND CURRENT_DATE <= ct.end_date
            LEFT JOIN users cu ON ct.tenant_user_id = cu.id
            LEFT JOIN user_profiles cup ON cu.id = cup.user_id
            
            -- Get the next upcoming tenancy (earliest future start date)
            LEFT JOIN LATERAL (
              SELECT t.*
              FROM tenancies t
              WHERE t.unit_id = u.id 
              AND t.agreement_status = 'executed'
              AND t.start_date > CURRENT_DATE 
              AND t.start_date <= $2
              ORDER BY t.start_date ASC
              LIMIT 1
            ) ut ON true
            LEFT JOIN users uu ON ut.tenant_user_id = uu.id
            LEFT JOIN user_profiles uup ON uu.id = uup.user_id
            
            WHERE b.id = $1 
            AND r.status = 'active'
            AND f.status = 'active'
            ${additionalFilters}
            
            ORDER BY u.id, f.floor_number ASC, r.room_number ASC, u.unit_number ASC
          )
          SELECT * FROM unit_tenancies
          ORDER BY floor_number ASC, room_number ASC, unit_number ASC
        `;

        const unitsResult = await client.query(unitsQuery, queryParams);

        // Get comprehensive tenancy history if requested
        let tenancyHistoryMap = {};
        if (shouldIncludeHistory) {
          const historyQuery = `
            SELECT 
              t.unit_id,
              t.id as tenancy_id,
              t.start_date,
              t.end_date,
              t.rent_amount,
              t.security_deposit,
              t.agreement_status,
              t.move_in_date,
              t.move_out_date,
              t.notice_period_days,
              u.email as tenant_email,
              CONCAT(COALESCE(up.first_name, ''), ' ', COALESCE(up.last_name, '')) as tenant_name,
              up.phone as tenant_phone,
              up.emergency_contact_name,
              up.emergency_contact_phone,
              
              -- Calculate tenancy duration
              CASE 
                WHEN t.move_out_date IS NOT NULL THEN t.move_out_date - t.move_in_date
                WHEN t.agreement_status = 'executed' AND CURRENT_DATE BETWEEN t.start_date AND t.end_date 
                THEN CURRENT_DATE - COALESCE(t.move_in_date, t.start_date)
                ELSE t.end_date - t.start_date
              END as tenancy_duration_days
              
            FROM tenancies t
            INNER JOIN users u ON t.tenant_user_id = u.id
            INNER JOIN user_profiles up ON u.id = up.user_id
            WHERE t.unit_id IN (
              SELECT u.id FROM units u 
              INNER JOIN rooms r ON u.room_id = r.id 
              WHERE r.building_id = $1
            )
            AND t.agreement_status IN ('executed', 'terminated', 'expired')
            ORDER BY t.unit_id, t.start_date DESC
          `;

          const historyResult = await client.query(historyQuery, [buildingId]);

          // Group history by unit_id
          historyResult.rows.forEach((row) => {
            if (!tenancyHistoryMap[row.unit_id]) {
              tenancyHistoryMap[row.unit_id] = [];
            }
            tenancyHistoryMap[row.unit_id].push({
              tenancyId: row.tenancy_id,
              startDate: row.start_date,
              endDate: row.end_date,
              rentAmount: parseFloat(row.rent_amount) || 0,
              securityDeposit: parseFloat(row.security_deposit) || 0,
              agreementStatus: row.agreement_status,
              moveInDate: row.move_in_date,
              moveOutDate: row.move_out_date,
              noticePeriodDays: row.notice_period_days,
              tenantEmail: row.tenant_email,
              tenantName: row.tenant_name.trim() || "Unknown",
              tenantPhone: row.tenant_phone,
              emergencyContactName: row.emergency_contact_name,
              emergencyContactPhone: row.emergency_contact_phone,
              tenancyDurationDays: row.tenancy_duration_days,
            });
          });
        }

        // Process and enhance units data
        const processedUnits = unitsResult.rows.map((row) => {
          const unit = {
            unitId: row.unit_id,
            unitNumber: row.unit_number,
            unitIdentifier: row.unit_identifier,
            rentAmount: parseFloat(row.rent_amount) || 0,
            securityDeposit: parseFloat(row.security_deposit) || 0,
            targetSellingPrice: parseFloat(row.target_selling_price) || 0,
            status: row.unit_status,

            // Room details
            roomNumber: row.room_number,
            roomType: row.room_type,
            sizeSqft: row.size_sqft ? parseFloat(row.size_sqft) : null,
            furnishingStatus: row.furnishing_status,
            acAvailable: row.ac_available,
            wifiAvailable: row.wifi_available,
            amenities: row.room_amenities || [],

            // Floor details
            floorNumber: row.floor_number,
            floorName: row.floor_name || `Floor ${row.floor_number}`,

            // Building details
            buildingName: row.building_name,

            // Vacancy tracking
            lastVacantDate: row.last_vacant_date,
            totalTenanciesCount: parseInt(row.total_tenancies_count) || 0,

            // Initialize tenancy objects
            currentTenancy: null,
            upcomingTenancy: null,
            tenancyHistory: tenancyHistoryMap[row.unit_id] || [],
          };

          // Add current tenancy if exists
          if (row.current_tenancy_id) {
            unit.currentTenancy = {
              tenancyId: row.current_tenancy_id,
              startDate: row.current_start_date,
              endDate: row.current_end_date,
              rentAmount: parseFloat(row.current_rent) || 0,
              securityDeposit: parseFloat(row.current_deposit) || 0,
              agreementStatus: row.current_agreement_status,
              tenantEmail: row.current_tenant_email,
              tenantName: (row.current_tenant_name || "").trim() || "Unknown",
              tenantPhone: row.current_tenant_phone,

              // Calculate remaining days
              daysRemaining: Math.ceil(
                (new Date(row.current_end_date) - today) / (1000 * 60 * 60 * 24)
              ),
            };
          }

          // Add upcoming tenancy if exists
          if (row.upcoming_tenancy_id) {
            unit.upcomingTenancy = {
              tenancyId: row.upcoming_tenancy_id,
              startDate: row.upcoming_start_date,
              endDate: row.upcoming_end_date,
              rentAmount: parseFloat(row.upcoming_rent) || 0,
              securityDeposit: parseFloat(row.upcoming_deposit) || 0,
              agreementStatus: row.upcoming_agreement_status,
              tenantEmail: row.upcoming_tenant_email,
              tenantName: (row.upcoming_tenant_name || "").trim() || "Unknown",
              tenantPhone: row.upcoming_tenant_phone,

              // Calculate days until start
              daysUntilStart: Math.ceil(
                (new Date(row.upcoming_start_date) - today) /
                  (1000 * 60 * 60 * 24)
              ),
            };
          }

          return unit;
        });

        // Calculate comprehensive summary statistics
        const summary = {
          totalUnits: processedUnits.length,
          available: 0,
          occupied: 0,
          upcoming: 0,
          maintenance: 0,

          // Financial metrics
          totalPotentialRevenue: 0,
          currentActualRevenue: 0,
          upcomingRevenue: 0,

          // Vacancy metrics
          totalVacantUnits: 0,
          longTermVacant: 0, // Vacant > 45 days
          averageVacancyDays: 0,

          // Performance metrics
          occupancyRate: 0,
          revenueUtilization: 0,
        };

        let totalVacancyDays = 0;
        let vacantUnitsWithData = 0;

        processedUnits.forEach((unit) => {
          // Determine actual status based on tenancy dates
          let actualStatus = "available"; // Default to available

          if (unit.status === "maintenance") {
            actualStatus = "maintenance";
            summary.maintenance++;
          } else if (unit.currentTenancy) {
            // Double-check: ensure current tenancy is actually current
            const today = new Date();
            const startDate = new Date(unit.currentTenancy.startDate);
            const endDate = new Date(unit.currentTenancy.endDate);

            if (today >= startDate && today <= endDate) {
              console.log("unit id is", unit.unitId);
              console.log("unit current tenancy is", unit.currentTenancy);
              actualStatus = "occupied";
              summary.occupied++;
              summary.currentActualRevenue += unit.currentTenancy.rentAmount;
            } else {
              // Tenancy exists but is not current - unit is available
              actualStatus = "available";
              summary.available++;
              summary.totalVacantUnits++;

              // Calculate vacancy duration if last tenancy ended
              if (endDate < today) {
                const vacancyDays = Math.floor(
                  (today - endDate) / (1000 * 60 * 60 * 24)
                );
                totalVacancyDays += vacancyDays;
                vacantUnitsWithData++;

                if (vacancyDays > 45) {
                  summary.longTermVacant++;
                }

                // Update lastVacantDate to the end date of the last tenancy
                unit.lastVacantDate = unit.currentTenancy.endDate;
              }

              // Clear current tenancy since it's not actually current
              unit.currentTenancy = null;
            }
          } else if (unit.upcomingTenancy) {
            // Unit has upcoming booking but no current tenant
            actualStatus = "upcoming";
            summary.upcoming++;
            summary.upcomingRevenue += unit.upcomingTenancy.rentAmount;

            // Calculate vacancy duration if unit has been vacant
            if (unit.lastVacantDate) {
              const today = new Date();
              const lastVacant = new Date(unit.lastVacantDate);
              const vacancyDays = Math.floor(
                (today - lastVacant) / (1000 * 60 * 60 * 24)
              );
              totalVacancyDays += vacancyDays;
              vacantUnitsWithData++;

              if (vacancyDays > 45) {
                summary.longTermVacant++;
              }
            }
          } else {
            // No current or upcoming tenancy - unit is available
            actualStatus = "available";
            summary.available++;
            summary.totalVacantUnits++;

            // Calculate vacancy duration
            if (unit.lastVacantDate) {
              const today = new Date();
              const vacancyDays = Math.floor(
                (today - new Date(unit.lastVacantDate)) / (1000 * 60 * 60 * 24)
              );
              totalVacancyDays += vacancyDays;
              vacantUnitsWithData++;

              if (vacancyDays > 45) {
                summary.longTermVacant++;
              }
            }
          }

          // Add the corrected status to the unit object
          unit.actualStatus = actualStatus;

          // Add to potential revenue
          summary.totalPotentialRevenue += unit.rentAmount;
        });

        // Calculate derived metrics
        if (summary.totalUnits > 0) {
          summary.occupancyRate =
            ((summary.occupied + summary.upcoming) / summary.totalUnits) * 100;

          if (summary.totalPotentialRevenue > 0) {
            summary.revenueUtilization =
              (summary.currentActualRevenue / summary.totalPotentialRevenue) *
              100;
          }
        }

        if (vacantUnitsWithData > 0) {
          summary.averageVacancyDays = Math.round(
            totalVacancyDays / vacantUnitsWithData
          );
        }

        // Group units by floor if requested
        let byFloor = null;
        if (groupBy === "floor") {
          byFloor = {};
          processedUnits.forEach((unit) => {
            const floorKey = `floor_${unit.floorNumber}`;
            if (!byFloor[floorKey]) {
              byFloor[floorKey] = {
                floorNumber: unit.floorNumber,
                floorName: unit.floorName,
                units: [],
              };
            }
            byFloor[floorKey].units.push(unit);
          });
        }

        // Get upcoming changes (move-ins and move-outs in the next 30 days)
        const upcomingChangesQuery = `
          WITH upcoming_moveouts AS (
            SELECT 
              'move_out' as change_type,
              t.id as tenancy_id,
              t.end_date as change_date,
              u.unit_number,
              CONCAT(COALESCE(up.first_name, ''), ' ', COALESCE(up.last_name, '')) as tenant_name,
              up.phone as tenant_phone,
              (t.end_date - CURRENT_DATE) as days_until_change,
              t.rent_amount
            FROM tenancies t
            INNER JOIN units u ON t.unit_id = u.id
            INNER JOIN rooms r ON u.room_id = r.id
            INNER JOIN users usr ON t.tenant_user_id = usr.id
            INNER JOIN user_profiles up ON usr.id = up.user_id
            WHERE r.building_id = $1
              AND t.agreement_status = 'executed'
              AND t.end_date > CURRENT_DATE
              AND t.end_date <= CURRENT_DATE + INTERVAL '30 days'
              AND CURRENT_DATE >= t.start_date
          ),
          upcoming_moveins AS (
            SELECT 
              'move_in' as change_type,
              t.id as tenancy_id,
              t.start_date as change_date,
              u.unit_number,
              CONCAT(COALESCE(up.first_name, ''), ' ', COALESCE(up.last_name, '')) as tenant_name,
              up.phone as tenant_phone,
              (t.start_date - CURRENT_DATE) as days_until_change,
              t.rent_amount
            FROM tenancies t
            INNER JOIN units u ON t.unit_id = u.id
            INNER JOIN rooms r ON u.room_id = r.id
            INNER JOIN users usr ON t.tenant_user_id = usr.id
            INNER JOIN user_profiles up ON usr.id = up.user_id
            WHERE r.building_id = $1
              AND t.agreement_status = 'executed'
              AND t.start_date > CURRENT_DATE
              AND t.start_date <= CURRENT_DATE + INTERVAL '30 days'
          )
          SELECT * FROM upcoming_moveouts
          UNION ALL
          SELECT * FROM upcoming_moveins
          ORDER BY change_date ASC, change_type DESC
        `;

        const upcomingChangesResult = await client.query(upcomingChangesQuery, [
          buildingId,
        ]);

        const upcomingChanges = {
          moveOuts: [],
          moveIns: [],
          totalChanges: upcomingChangesResult.rows.length,
        };

        upcomingChangesResult.rows.forEach((row) => {
          const change = {
            tenancyId: row.tenancy_id,
            unitNumber: row.unit_number,
            tenantName: (row.tenant_name || "").trim() || "Unknown",
            tenantPhone: row.tenant_phone,
            changeDate: row.change_date,
            daysUntilChange: Math.max(0, parseInt(row.days_until_change) || 0),
            rentAmount: parseFloat(row.rent_amount) || 0,
          };

          if (row.change_type === "move_out") {
            change.endDate = row.change_date;
            change.daysUntilMoveOut = change.daysUntilChange;
            upcomingChanges.moveOuts.push(change);
          } else {
            change.startDate = row.change_date;
            change.daysUntilMoveIn = change.daysUntilChange;
            upcomingChanges.moveIns.push(change);
          }
        });

        // Prepare final response
        const responseData = {
          success: true,
          data: {
            summary: {
              ...summary,
              // Round decimal values for display
              occupancyRate: Math.round(summary.occupancyRate * 10) / 10,
              revenueUtilization:
                Math.round(summary.revenueUtilization * 10) / 10,
              totalPotentialRevenue: Math.round(summary.totalPotentialRevenue),
              currentActualRevenue: Math.round(summary.currentActualRevenue),
              upcomingRevenue: Math.round(summary.upcomingRevenue),
            },
            units: processedUnits,
            byFloor,
            upcomingChanges,
            filters: {
              range: lookAheadDays,
              includeHistory: shouldIncludeHistory,
              groupBy,
              appliedFilters: {
                floor: floor || null,
                roomType: roomType || null,
              },
            },
            metadata: {
              generatedAt: new Date().toISOString(),
              totalUnitsProcessed: processedUnits.length,
              hasHistoryData: shouldIncludeHistory,
              lookAheadDays,
            },
          },
        };

        res.json(responseData);
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("Enhanced vacancy chart error:", error);
      next(error);
    }
  }

  // GET /api/properties/buildings/:id/analytics
  async getBuildingAnalytics(req, res, next) {
    try {
      const buildingId = req.params.id;
      const {
        period = "12months",
        metrics = "revenue,occupancy,maintenance",
        compare = false,
      } = req.query;

      const client = await pool.connect();

      try {
        // Validate building exists
        const buildingCheck = await client.query(
          "SELECT id FROM buildings WHERE id = $1",
          [buildingId]
        );
        if (buildingCheck.rows.length === 0) {
          return next(createError("NOT_FOUND", "Building not found"));
        }

        const requestedMetrics = metrics.split(",").map((m) => m.trim());
        const currentDate = new Date();
        let dateRange;

        // Calculate date range based on period
        switch (period) {
          case "3months":
            dateRange = {
              start: new Date(
                currentDate.getFullYear(),
                currentDate.getMonth() - 3,
                1
              ),
              end: currentDate,
            };
            break;
          case "6months":
            dateRange = {
              start: new Date(
                currentDate.getFullYear(),
                currentDate.getMonth() - 6,
                1
              ),
              end: currentDate,
            };
            break;
          case "12months":
          default:
            dateRange = {
              start: new Date(
                currentDate.getFullYear(),
                currentDate.getMonth() - 12,
                1
              ),
              end: currentDate,
            };
            break;
        }

        const analyticsData = {};

        // Revenue Analytics
        if (requestedMetrics.includes("revenue")) {
          const revenueQuery = `
            SELECT 
              rs.snapshot_month,
              rs.snapshot_year,
              rs.total_rent_due,
              rs.total_rent_collected,
              rs.total_outstanding,
              rs.collection_rate,
              rs.average_rent_per_unit,
              rs.total_active_units
            FROM revenue_snapshots rs
            WHERE rs.building_id = $1
            AND rs.snapshot_year * 100 + rs.snapshot_month >= $2
            AND rs.snapshot_year * 100 + rs.snapshot_month <= $3
            ORDER BY rs.snapshot_year, rs.snapshot_month
          `;

          const startPeriod =
            dateRange.start.getFullYear() * 100 +
            (dateRange.start.getMonth() + 1);
          const endPeriod =
            currentDate.getFullYear() * 100 + (currentDate.getMonth() + 1);

          const revenueResult = await client.query(revenueQuery, [
            buildingId,
            startPeriod,
            endPeriod,
          ]);

          analyticsData.revenue = {
            trends: revenueResult.rows.map((row) => ({
              month: row.snapshot_month,
              year: row.snapshot_year,
              period: `${row.snapshot_year}-${String(
                row.snapshot_month
              ).padStart(2, "0")}`,
              totalRentDue: parseFloat(row.total_rent_due),
              totalRentCollected: parseFloat(row.total_rent_collected),
              totalOutstanding: parseFloat(row.total_outstanding),
              collectionRate: parseFloat(row.collection_rate),
              averageRentPerUnit: parseFloat(row.average_rent_per_unit),
              totalActiveUnits: parseInt(row.total_active_units),
            })),
            summary: {
              totalRevenue: revenueResult.rows.reduce(
                (sum, row) => sum + parseFloat(row.total_rent_collected),
                0
              ),
              averageCollectionRate:
                revenueResult.rows.length > 0
                  ? (
                      revenueResult.rows.reduce(
                        (sum, row) => sum + parseFloat(row.collection_rate),
                        0
                      ) / revenueResult.rows.length
                    ).toFixed(2)
                  : 0,
              totalOutstanding:
                revenueResult.rows.length > 0
                  ? parseFloat(
                      revenueResult.rows[revenueResult.rows.length - 1]
                        .total_outstanding
                    )
                  : 0,
            },
          };
        }

        // Occupancy Analytics
        if (requestedMetrics.includes("occupancy")) {
          const occupancyQuery = `
            SELECT 
              os.snapshot_date,
              os.total_units,
              os.occupied_units,
              os.available_units,
              os.maintenance_units,
              os.occupancy_rate
            FROM occupancy_snapshots os
            WHERE os.building_id = $1
            AND os.snapshot_date >= $2
            AND os.snapshot_date <= $3
            ORDER BY os.snapshot_date
          `;

          const occupancyResult = await client.query(occupancyQuery, [
            buildingId,
            dateRange.start.toISOString().split("T")[0],
            currentDate.toISOString().split("T")[0],
          ]);

          analyticsData.occupancy = {
            trends: occupancyResult.rows.map((row) => ({
              date: row.snapshot_date,
              totalUnits: parseInt(row.total_units),
              occupiedUnits: parseInt(row.occupied_units),
              availableUnits: parseInt(row.available_units),
              maintenanceUnits: parseInt(row.maintenance_units),
              occupancyRate: parseFloat(row.occupancy_rate),
            })),
            summary: {
              averageOccupancyRate:
                occupancyResult.rows.length > 0
                  ? (
                      occupancyResult.rows.reduce(
                        (sum, row) => sum + parseFloat(row.occupancy_rate),
                        0
                      ) / occupancyResult.rows.length
                    ).toFixed(2)
                  : 0,
              currentOccupancyRate:
                occupancyResult.rows.length > 0
                  ? parseFloat(
                      occupancyResult.rows[occupancyResult.rows.length - 1]
                        .occupancy_rate
                    )
                  : 0,
              peakOccupancyRate:
                occupancyResult.rows.length > 0
                  ? Math.max(
                      ...occupancyResult.rows.map((row) =>
                        parseFloat(row.occupancy_rate)
                      )
                    )
                  : 0,
            },
          };
        }

        // Maintenance Analytics
        if (requestedMetrics.includes("maintenance")) {
          const maintenanceQuery = `
            SELECT 
              DATE_TRUNC('month', mr.requested_date) as month,
              COUNT(*) as total_requests,
              COUNT(CASE WHEN mr.status = 'completed' THEN 1 END) as completed_requests,
              COUNT(CASE WHEN mr.priority = 'urgent' THEN 1 END) as urgent_requests,
              AVG(CASE WHEN mr.completion_date IS NOT NULL AND mr.requested_date IS NOT NULL 
                  THEN EXTRACT(EPOCH FROM (mr.completion_date::timestamp - mr.requested_date::timestamp))/86400 END) as avg_resolution_days,
              AVG(CASE WHEN mr.actual_cost IS NOT NULL THEN mr.actual_cost END) as avg_cost,
              AVG(CASE WHEN mr.tenant_rating IS NOT NULL THEN mr.tenant_rating END) as avg_rating
            FROM maintenance_requests mr
            JOIN rooms r ON mr.room_id = r.id
            WHERE r.building_id = $1
            AND mr.requested_date >= $2
            AND mr.requested_date <= $3
            GROUP BY DATE_TRUNC('month', mr.requested_date)
            ORDER BY month
          `;

          const maintenanceResult = await client.query(maintenanceQuery, [
            buildingId,
            dateRange.start.toISOString().split("T")[0],
            currentDate.toISOString().split("T")[0],
          ]);

          analyticsData.maintenance = {
            trends: maintenanceResult.rows.map((row) => ({
              month: row.month,
              totalRequests: parseInt(row.total_requests),
              completedRequests: parseInt(row.completed_requests),
              urgentRequests: parseInt(row.urgent_requests),
              averageResolutionDays: row.avg_resolution_days
                ? parseFloat(row.avg_resolution_days).toFixed(1)
                : null,
              averageCost: row.avg_cost ? parseFloat(row.avg_cost) : null,
              averageRating: row.avg_rating
                ? parseFloat(row.avg_rating).toFixed(1)
                : null,
              completionRate:
                parseInt(row.total_requests) > 0
                  ? (
                      (parseInt(row.completed_requests) /
                        parseInt(row.total_requests)) *
                      100
                    ).toFixed(1)
                  : 0,
            })),
            summary: {
              totalRequests: maintenanceResult.rows.reduce(
                (sum, row) => sum + parseInt(row.total_requests),
                0
              ),
              averageResolutionDays:
                maintenanceResult.rows.length > 0
                  ? (
                      maintenanceResult.rows
                        .filter((row) => row.avg_resolution_days !== null)
                        .reduce(
                          (sum, row) =>
                            sum + parseFloat(row.avg_resolution_days),
                          0
                        ) /
                      maintenanceResult.rows.filter(
                        (row) => row.avg_resolution_days !== null
                      ).length
                    ).toFixed(1)
                  : null,
              overallCompletionRate: (() => {
                const totalRequests = maintenanceResult.rows.reduce(
                  (sum, row) => sum + parseInt(row.total_requests),
                  0
                );
                const totalCompleted = maintenanceResult.rows.reduce(
                  (sum, row) => sum + parseInt(row.completed_requests),
                  0
                );
                return totalRequests > 0
                  ? ((totalCompleted / totalRequests) * 100).toFixed(1)
                  : 0;
              })(),
              averageRating:
                maintenanceResult.rows.length > 0
                  ? (
                      maintenanceResult.rows
                        .filter((row) => row.avg_rating !== null)
                        .reduce(
                          (sum, row) => sum + parseFloat(row.avg_rating),
                          0
                        ) /
                      maintenanceResult.rows.filter(
                        (row) => row.avg_rating !== null
                      ).length
                    ).toFixed(1)
                  : null,
            },
          };
        }

        if (requestedMetrics.includes("tenant_satisfaction")) {
          analyticsData.tenant_satisfaction = {
            summary: {
              averageRating: "Coming soon",
              responseRate: "Coming soon",
              satisfactionTrend: "Coming soon",
            },
          };
        }

        const response = {
          success: true,
          data: {
            period,
            dateRange: {
              start: dateRange.start.toISOString().split("T")[0],
              end: currentDate.toISOString().split("T")[0],
            },
            metrics: analyticsData,
            ...(compare && {
              comparison: {
                note: "Comparison with previous period coming soon",
              },
            }),
          },
          filters: {
            period,
            metrics,
            compare,
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

  // The getBuildingTenants, getBuildingVacancyChart, getBuildingAnalytics methods
  // remain the same as they're already protected by the authorizeResource middleware
  // and don't need manager-specific filtering since the middleware handles access control

  // DELETE /api/properties/buildings/:id (Updated with manager check)
  async deleteBuilding(req, res, next) {
    try {
      const buildingId = req.params.id;

      const client = await pool.connect();

      try {
        // Check if building has active tenancies
        const tenanciesQuery = `
        SELECT COUNT(*) as active_tenancies
        FROM tenancies t
        JOIN units u ON t.unit_id = u.id
        JOIN rooms r ON u.room_id = r.id
        WHERE r.building_id = $1 AND t.agreement_status = 'executed'
        AND (t.end_date IS NULL OR t.end_date > CURRENT_DATE)
      `;
        const tenanciesResult = await client.query(tenanciesQuery, [
          buildingId,
        ]);
        const activeTenancies = parseInt(
          tenanciesResult.rows[0].active_tenancies
        );

        if (activeTenancies > 0) {
          return next(
            createError(
              "CONFLICT",
              "Cannot delete building with active tenancies"
            )
          );
        }

        // Get building info including manager before deletion
        const buildingQuery = `
        SELECT 
          building_image,
          manager_id,
          mu.email as manager_email,
          CONCAT(COALESCE(mup.first_name, ''), ' ', COALESCE(mup.last_name, '')) as manager_name
        FROM buildings b
        LEFT JOIN users mu ON b.manager_id = mu.id
        LEFT JOIN user_profiles mup ON mu.id = mup.user_id
        WHERE b.id = $1
      `;
        const buildingResult = await client.query(buildingQuery, [buildingId]);

        if (buildingResult.rows.length === 0) {
          return next(createError("NOT_FOUND", "Building not found"));
        }

        const building = buildingResult.rows[0];

        // Delete building (CASCADE will handle related tables)
        const deleteQuery = `DELETE FROM buildings WHERE id = $1`;
        await client.query(deleteQuery, [buildingId]);

        // TODO: Delete building image file if it exists
        // if (building.building_image) {
        //   // Delete the image file from uploads/buildings/
        // }

        const response = {
          success: true,
          message: "Building deleted successfully",
          data: {
            deletedBuildingId: buildingId,
            // Include manager info for any necessary notifications
            wasAssignedTo: building.manager_id
              ? {
                  id: building.manager_id,
                  email: building.manager_email,
                  name: (building.manager_name || "").trim() || "Unknown",
                }
              : null,
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

export default new PropertiesController();
