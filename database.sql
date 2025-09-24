-- ================================
-- TENANT PORTAL ADDITIONAL TABLES
-- ================================

-- Users table (for authentication and basic info)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('super_admin', 'admin', 'manager', 'tenant')),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- User profiles table (detailed information)
CREATE TABLE user_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    phone VARCHAR(20),
    date_of_birth DATE,
    gender VARCHAR(10) CHECK (gender IN ('male', 'female', 'other')),
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(100),
    country VARCHAR(100),
    postal_code VARCHAR(20),
    emergency_contact_name VARCHAR(100),
    emergency_contact_phone VARCHAR(20),
    emergency_contact_relation VARCHAR(50),
    profile_picture VARCHAR(255),
    id_proof_type VARCHAR(50),
    id_proof_number VARCHAR(100),
    id_proof_document VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- OTPs Table Schema
CREATE TABLE IF NOT EXISTS otps (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    otp VARCHAR(6) NOT NULL,
    purpose VARCHAR(50) NOT NULL CHECK (purpose IN ('login', 'registration', 'password_reset')),
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER DEFAULT 0,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_otps_email ON otps(email);
CREATE INDEX idx_otps_expires_at ON otps(expires_at);
CREATE INDEX idx_otps_used ON otps(used);

-- Cleanup function to remove expired OTPs (optional)
CREATE OR REPLACE FUNCTION cleanup_expired_otps()
RETURNS void AS $$
BEGIN
    DELETE FROM otps 
    WHERE expires_at < CURRENT_TIMESTAMP - INTERVAL '1 hour'
    OR (used = true AND created_at < CURRENT_TIMESTAMP - INTERVAL '24 hours');
END;
$$ LANGUAGE plpgsql;


-- Buildings table
CREATE TABLE IF NOT EXISTS buildings (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    address_line1 VARCHAR(255),
    address_line2 VARCHAR(255),
    city VARCHAR(100),
    state VARCHAR(100),
    postal_code VARCHAR(20),
    total_floors INTEGER DEFAULT 0,
    total_units INTEGER DEFAULT 0, -- Total rentable units across all rooms
    building_image VARCHAR(255),
    description TEXT,
    amenities TEXT[], -- Array of amenities
    contact_person VARCHAR(100),
    contact_phone VARCHAR(20),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'under_construction')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE buildings 
ADD COLUMN manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE buildings 
ADD COLUMN building_code VARCHAR(20) UNIQUE;


-- Add index for performance
CREATE INDEX idx_buildings_manager_id ON buildings(manager_id);

-- Maintenance requests (Can be for room or specific unit)
CREATE TABLE IF NOT EXISTS maintenance_requests (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL, -- Optional: specific to a unit
    tenant_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    category VARCHAR(50) NOT NULL,
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    title VARCHAR(200) NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'assigned', 'in_progress', 'completed', 'cancelled')),
    assigned_to VARCHAR(100),
    estimated_cost DECIMAL(10,2),
    actual_cost DECIMAL(10,2),
    requested_date DATE DEFAULT CURRENT_DATE,
    scheduled_date DATE,
    completion_date DATE,
    tenant_rating INTEGER CHECK (tenant_rating >= 1 AND tenant_rating <= 5),
    tenant_feedback TEXT,
    images TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Floors table
CREATE TABLE IF NOT EXISTS floors (
    id SERIAL PRIMARY KEY,
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    floor_number INTEGER NOT NULL,
    floor_name VARCHAR(50), -- Ground Floor, 1st Floor, etc.
    total_rooms INTEGER DEFAULT 0,
    total_units INTEGER DEFAULT 0, -- Total rentable units on this floor
    floor_plan_image VARCHAR(255),
    description TEXT,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(building_id, floor_number)
);

-- Rooms table (Physical rooms)
CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    floor_id INTEGER REFERENCES floors(id) ON DELETE CASCADE,
    room_number VARCHAR(20) NOT NULL,
    room_type VARCHAR(20) NOT NULL CHECK (room_type IN ('single', 'double', 'triple')),
    total_units INTEGER NOT NULL DEFAULT 1, -- How many units this room has (1 for single, 2 for double sharing)
    size_sqft DECIMAL(8,2),
    amenities TEXT[],
    room_images TEXT[],
    furnishing_status VARCHAR(20) DEFAULT 'furnished' CHECK (furnishing_status IN ('furnished', 'semi_furnished', 'unfurnished')),
    ac_available BOOLEAN DEFAULT true,
    wifi_available BOOLEAN DEFAULT true,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(building_id, room_number)
);

-- Units table (Rentable units within rooms)
-- This is the KEY table that solves the problem
CREATE TABLE IF NOT EXISTS units (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    unit_identifier VARCHAR(10) NOT NULL, -- A, B, C (for sharing rooms) or NULL for single rooms
    unit_number VARCHAR(30) NOT NULL, -- 101, 102A, 102B, 103A, 103B etc.
    rent_amount DECIMAL(10,2) NOT NULL,
    security_deposit DECIMAL(10,2),
    target_selling_price DECIMAL(10,2), -- From your Excel
    status VARCHAR(20) DEFAULT 'available' CHECK (status IN ('available', 'occupied', 'maintenance', 'reserved')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(room_id, unit_identifier),
    UNIQUE(unit_number) -- Each unit has unique number across building
);

-- ================================
-- TENANCY AND OCCUPANCY TABLES
-- ================================

-- Tenancies table (Now linked to units, not rooms)
CREATE TABLE IF NOT EXISTS tenancies (
    id SERIAL PRIMARY KEY,
    unit_id INTEGER REFERENCES units(id) ON DELETE CASCADE, -- FIXED: Now references units
    tenant_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE,
    rent_amount DECIMAL(10,2) NOT NULL,
    security_deposit DECIMAL(10,2),
    agreement_status VARCHAR(20) DEFAULT 'pending' CHECK (agreement_status IN ('pending', 'executed', 'expired', 'terminated')),
    move_in_date DATE,
    move_out_date DATE,
    notice_period_days INTEGER DEFAULT 30,
    documents_submitted TEXT[],
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

 ALTER TABLE tenancies
  ADD COLUMN offboarding_initiated_at TIMESTAMP,
  ADD COLUMN offboarding_reason TEXT,
  ADD COLUMN notice_given_date DATE,
  ADD COLUMN intended_move_out_date DATE,
  ADD COLUMN actual_move_out_date DATE,
  ADD COLUMN deposit_refund_amount DECIMAL(10,2),
  ADD COLUMN deposit_refund_status VARCHAR(20) DEFAULT 'pending' CHECK
  (deposit_refund_status IN ('pending', 'processed', 'complete')),
  ADD COLUMN final_dues DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN offboarding_status VARCHAR(20) DEFAULT 'active' CHECK
  (offboarding_status IN ('active', 'initiated', 'pending_clearance',
  'completed'));

-- ================================
-- FINANCIAL MANAGEMENT TABLES
-- ================================

-- Payments table (Now per unit through tenancy)
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    tenancy_id INTEGER REFERENCES tenancies(id) ON DELETE CASCADE,
    payment_type VARCHAR(20) NOT NULL CHECK (payment_type IN ('rent', 'security_deposit', 'maintenance', 'utility', 'late_fee', 'other')),
    amount DECIMAL(10,2) NOT NULL,
    due_date DATE NOT NULL,
    payment_date DATE,
    payment_method VARCHAR(20) CHECK (payment_method IN ('cash', 'bank_transfer', 'upi', 'card', 'cheque')),
    transaction_id VARCHAR(100),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue', 'partial', 'failed')),
    late_fee DECIMAL(10,2) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE payment_receipts (
     id SERIAL PRIMARY KEY,
     payment_id INTEGER REFERENCES payments(id),
     file_name VARCHAR(255),
     file_path VARCHAR(500),
     file_size INTEGER,
     uploaded_by INTEGER REFERENCES users(id),
     uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );

-- Monthly rent cycles (Per unit through tenancy)
CREATE TABLE IF NOT EXISTS rent_cycles (
    id SERIAL PRIMARY KEY,
    tenancy_id INTEGER REFERENCES tenancies(id) ON DELETE CASCADE,
    cycle_month INTEGER NOT NULL, -- 1-12
    cycle_year INTEGER NOT NULL,
    rent_amount DECIMAL(10,2) NOT NULL,
    due_date DATE NOT NULL,
    payment_status VARCHAR(20) DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'overdue', 'partial')),
    paid_amount DECIMAL(10,2) DEFAULT 0,
    payment_date DATE,
    late_fee DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenancy_id, cycle_month, cycle_year)
);


-- Building amenities
CREATE TABLE IF NOT EXISTS building_amenities (
    id SERIAL PRIMARY KEY,
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    amenity_name VARCHAR(100) NOT NULL,
    description TEXT,
    location VARCHAR(100),
    operational_hours VARCHAR(100),
    booking_required BOOLEAN DEFAULT false,
    maintenance_schedule VARCHAR(100),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Room amenities (Applies to entire room)
CREATE TABLE IF NOT EXISTS room_amenities (
    id SERIAL PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    amenity_name VARCHAR(100) NOT NULL,
    description TEXT,
    working_status VARCHAR(20) DEFAULT 'working' CHECK (working_status IN ('working', 'not_working', 'maintenance')),
    last_serviced DATE,
    warranty_expiry DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- Daily occupancy snapshots (Now unit-based)
CREATE TABLE IF NOT EXISTS occupancy_snapshots (
    id SERIAL PRIMARY KEY,
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    snapshot_date DATE NOT NULL,
    total_units INTEGER NOT NULL, -- Total rentable units
    occupied_units INTEGER NOT NULL, -- Units with active tenancies
    available_units INTEGER NOT NULL, -- Units available for rent
    maintenance_units INTEGER NOT NULL, -- Units under maintenance
    occupancy_rate DECIMAL(5,2) NOT NULL, -- (occupied_units / total_units) * 100
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(building_id, snapshot_date)
);

-- Monthly revenue snapshots (Unit-based revenue)
CREATE TABLE IF NOT EXISTS revenue_snapshots (
    id SERIAL PRIMARY KEY,
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    snapshot_month INTEGER NOT NULL,
    snapshot_year INTEGER NOT NULL,
    total_rent_due DECIMAL(12,2) NOT NULL, -- Sum of all unit rents
    total_rent_collected DECIMAL(12,2) NOT NULL,
    total_outstanding DECIMAL(12,2) NOT NULL,
    collection_rate DECIMAL(5,2) NOT NULL,
    average_rent_per_unit DECIMAL(10,2) NOT NULL,
    total_active_units INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(building_id, snapshot_month, snapshot_year)
);


-- Enhanced Leads Table (Kanban Cards)
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(50) UNIQUE NOT NULL, -- From website forms
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20) NOT NULL,
    
    -- Lead Source & Origin
    source VARCHAR(50) DEFAULT 'website', -- website, referral, walk_in, social_media, phone
    page_url TEXT, -- From website submissions
    
    -- Property Preferences
    preferred_building_id INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
    preferred_room_type VARCHAR(20) CHECK (preferred_room_type IN ('single', 'double', 'triple')),
    budget_min DECIMAL(10,2),
    budget_max DECIMAL(10,2),
    preferred_move_in_date DATE,
    
    -- Lead Management (Kanban Functionality)
    status VARCHAR(50) DEFAULT 'new_leads' CHECK (status IN (
        'new_leads', 'hot', 'warm', 'initial_contact', 
        'negotiations', 'cold', 'lost', 'won'
    )),
    stage_position INTEGER DEFAULT 0, -- Position within the stage for drag-drop ordering
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL, -- Agent/Manager
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    lead_score INTEGER DEFAULT 0 CHECK (lead_score >= 0 AND lead_score <= 100),
    
    -- Timeline & Follow-ups
    last_contacted_at TIMESTAMP,
    next_follow_up_date TIMESTAMP,
    follow_up_notes TEXT,
    
    -- Conversion Tracking
    converted_to_tenant_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    conversion_date TIMESTAMP,
    lost_reason VARCHAR(100),
    lost_date TIMESTAMP,
    
    -- Additional Info
    notes TEXT,
    tags TEXT[], -- Flexible tagging system
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lead Activities/Touch Log
CREATE TABLE IF NOT EXISTS lead_activities (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    
    -- Activity Details
    activity_type VARCHAR(50) NOT NULL, -- call, email, meeting, note, tour, follow_up
    touch_number INTEGER, -- Touch 1, Touch 2, etc.
    
    -- Communication (Hardcoded options in frontend)
    communication_mode VARCHAR(50), -- voice_call, sms, whatsapp_msg, whatsapp_call, email, in_person
    outcome VARCHAR(100), -- could_not_connect, call_me_back, on_whatsapp, video_tour, physical_tour, interested, not_interested
    
    -- Status Changes
    status_before VARCHAR(50),
    status_after VARCHAR(50),
    next_action VARCHAR(100),
    
    -- Scheduling
    scheduled_at TIMESTAMP,
    completed_at TIMESTAMP,
    try_again_date TIMESTAMP,
    next_interaction_date TIMESTAMP,
    
    -- Details
    title VARCHAR(200),
    description TEXT,
    notes TEXT,
    
    -- Agent Info
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    
    -- Files & Media
    attachments TEXT[], -- File paths/URLs
    
    -- Email specific
    email_sent BOOLEAN DEFAULT false,
    welcome_mail_status VARCHAR(20),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lead Stage Transitions (Track Kanban Movement for Analytics)
CREATE TABLE IF NOT EXISTS lead_stage_transitions (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    moved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason VARCHAR(200),
    automated BOOLEAN DEFAULT false, -- Was this an automatic transition?
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lead Files & Documents
CREATE TABLE IF NOT EXISTS lead_documents (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL, -- id_proof, income_proof, agreement, photo, video_tour
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_size INTEGER,
    mime_type VARCHAR(100),
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================

-- Kanban Board Performance
CREATE INDEX idx_leads_status_position ON leads(status, stage_position);
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX idx_leads_next_follow_up ON leads(next_follow_up_date) WHERE next_follow_up_date IS NOT NULL;
CREATE INDEX idx_leads_created_at ON leads(created_at);

-- Activity & Search Performance
CREATE INDEX idx_lead_activities_lead_id ON lead_activities(lead_id);
CREATE INDEX idx_lead_activities_created_at ON lead_activities(created_at);
CREATE INDEX idx_lead_transitions_lead_id ON lead_stage_transitions(lead_id);

-- Search Performance
CREATE INDEX idx_leads_phone ON leads(phone);
CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_name ON leads(name);



-- Complaints Table (Enhanced from maintenance_requests)
CREATE TABLE IF NOT EXISTS complaints (
    id SERIAL PRIMARY KEY,
    tenant_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    room_id INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
    unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
    
    -- Complaint Details
    complaint_number VARCHAR(20) UNIQUE NOT NULL, -- AUTO: COMP-2025-001
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(50) NOT NULL, -- maintenance, noise, cleanliness, security, billing, amenity, other
    subcategory VARCHAR(50), -- ac_issue, plumbing, electrical, wifi, pest_control, etc.
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    
    -- Status Management
    status VARCHAR(20) DEFAULT 'submitted' CHECK (status IN ('submitted', 'acknowledged', 'in_progress', 'resolved', 'closed', 'rejected')),
    
    -- Assignment & Resolution
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL, -- Admin/Manager assigned
    assigned_at TIMESTAMP,
    acknowledged_at TIMESTAMP,
    resolution_notes TEXT,
    resolved_at TIMESTAMP,
    closed_at TIMESTAMP,
    
    -- Tenant Feedback
    tenant_satisfaction_rating INTEGER CHECK (tenant_satisfaction_rating >= 1 AND tenant_satisfaction_rating <= 5),
    tenant_feedback TEXT,
    feedback_date TIMESTAMP,
    
    -- Media & Documentation
    attachments TEXT[], -- Image/video file paths
    resolution_attachments TEXT[], -- Before/after photos from staff
    
    -- Tracking
    estimated_resolution_time INTEGER, -- Hours
    actual_resolution_time INTEGER, -- Hours
    cost_incurred DECIMAL(10,2) DEFAULT 0,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Complaint Activities/Updates Log
CREATE TABLE IF NOT EXISTS complaint_activities (
    id SERIAL PRIMARY KEY,
    complaint_id INTEGER REFERENCES complaints(id) ON DELETE CASCADE,
    
    -- Activity Details
    activity_type VARCHAR(50) NOT NULL, -- status_change, assignment, note, resolution, feedback
    description TEXT NOT NULL,
    status_before VARCHAR(20),
    status_after VARCHAR(20),
    
    -- User Info
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_for VARCHAR(20) NOT NULL, -- tenant, admin, system
    
    -- Additional Data
    attachments TEXT[],
    internal_notes TEXT, -- Only visible to staff
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Building Announcements
CREATE TABLE IF NOT EXISTS announcements (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    
    -- Targeting
    building_id INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    target_audience VARCHAR(20) DEFAULT 'all_tenants' CHECK (target_audience IN ('all_tenants', 'specific_floors', 'specific_rooms', 'all_residents')),
    target_floor_ids INTEGER[], -- Array of floor IDs if targeting specific floors
    target_room_ids INTEGER[], -- Array of room IDs if targeting specific rooms
    
    -- Announcement Details
    category VARCHAR(50) NOT NULL, -- maintenance, event, policy, emergency, billing, amenity, general
    priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    announcement_type VARCHAR(20) DEFAULT 'info' CHECK (announcement_type IN ('info', 'warning', 'success', 'error')),
    
    -- Scheduling & Visibility
    publish_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- When to show the announcement
    expires_at TIMESTAMP, -- When to hide/archive the announcement
    is_published BOOLEAN DEFAULT true,
    is_pinned BOOLEAN DEFAULT false, -- Pin important announcements at top
    
    -- Rich Content
    attachments TEXT[], -- Images, PDFs, documents
    external_links TEXT[], -- Links to external resources
    
    -- Interaction Tracking
    view_count INTEGER DEFAULT 0,
    acknowledgment_required BOOLEAN DEFAULT false, -- Require tenants to acknowledge reading
    
    -- Author Info
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, -- Admin/Manager who created
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Announcement Read Status (Track who has read what)
CREATE TABLE IF NOT EXISTS announcement_reads (
    id SERIAL PRIMARY KEY,
    announcement_id INTEGER REFERENCES announcements(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acknowledged BOOLEAN DEFAULT false, -- If acknowledgment was required
    acknowledged_at TIMESTAMP,
    
    UNIQUE(announcement_id, user_id) -- One read record per user per announcement
);

-- Document Access Log (Track document views)
CREATE TABLE IF NOT EXISTS document_access_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL, -- lease_agreement, id_proof, profile_picture, payment_receipt, etc.
    document_path VARCHAR(500) NOT NULL,
    reference_id INTEGER, -- Could reference tenancies.id, payments.id, etc.
    access_type VARCHAR(20) DEFAULT 'view' CHECK (access_type IN ('view', 'download')),
    ip_address INET,
    user_agent TEXT,
    accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================

-- Complaints Performance
CREATE INDEX idx_complaints_tenant_user_id ON complaints(tenant_user_id);
CREATE INDEX idx_complaints_building_id ON complaints(building_id);
CREATE INDEX idx_complaints_status ON complaints(status);
CREATE INDEX idx_complaints_category ON complaints(category);
CREATE INDEX idx_complaints_created_at ON complaints(created_at);
CREATE INDEX idx_complaints_assigned_to ON complaints(assigned_to);

-- Complaint Activities
CREATE INDEX idx_complaint_activities_complaint_id ON complaint_activities(complaint_id);
CREATE INDEX idx_complaint_activities_created_at ON complaint_activities(created_at);

-- Announcements Performance
CREATE INDEX idx_announcements_building_id ON announcements(building_id);
CREATE INDEX idx_announcements_published ON announcements(is_published, publish_at);
CREATE INDEX idx_announcements_expires_at ON announcements(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_announcements_category ON announcements(category);
CREATE INDEX idx_announcements_priority ON announcements(priority);

-- Announcement Reads
CREATE INDEX idx_announcement_reads_user_id ON announcement_reads(user_id);
CREATE INDEX idx_announcement_reads_announcement_id ON announcement_reads(announcement_id);

-- Document Access Logs
CREATE INDEX idx_document_access_user_id ON document_access_logs(user_id);
CREATE INDEX idx_document_access_accessed_at ON document_access_logs(accessed_at);

-- ================================
-- TRIGGERS FOR AUTO-UPDATES
-- ================================

-- Auto-generate complaint numbers
CREATE OR REPLACE FUNCTION generate_complaint_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.complaint_number IS NULL THEN
        NEW.complaint_number := 'COMP-' || EXTRACT(YEAR FROM CURRENT_DATE) || '-' || 
                               LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING(complaint_number FROM 10) AS INTEGER)), 0) + 1 
                                    FROM complaints 
                                    WHERE complaint_number LIKE 'COMP-' || EXTRACT(YEAR FROM CURRENT_DATE) || '-%')::TEXT, 3, '0');
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_generate_complaint_number
    BEFORE INSERT ON complaints
    FOR EACH ROW EXECUTE FUNCTION generate_complaint_number();

-- Auto-update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_complaints_updated_at
    BEFORE UPDATE ON complaints
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trigger_announcements_updated_at
    BEFORE UPDATE ON announcements
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================
-- SAMPLE DATA
-- ================================

-- Insert some sample complaint categories (can be used for dropdowns)
INSERT INTO complaints (tenant_user_id, building_id, room_id, title, description, category, subcategory, priority, status, created_by) VALUES
(4, 1, 1, 'Air conditioning not working', 'The AC in my room has stopped cooling since yesterday evening', 'maintenance', 'ac_issue', 'high', 'submitted', 4),
(4, 1, 1, 'Noise complaint from neighboring room', 'Loud music playing late at night from room 102', 'noise', 'neighbor_disturbance', 'medium', 'acknowledged', 4);

-- Insert sample announcements
INSERT INTO announcements (title, content, building_id, category, priority, created_by) VALUES
('Monthly Maintenance Schedule', 'Please be informed that routine maintenance will be conducted on the 15th of every month from 9 AM to 12 PM. This includes elevator servicing and common area cleaning.', 1, 'maintenance', 'normal', 1),
('New Gym Equipment Installed', 'We are excited to announce that new fitness equipment has been installed in the building gym. Please follow the usage guidelines posted at the entrance.', 1, 'amenity', 'normal', 1),
('Water Supply Interruption Notice', 'Water supply will be temporarily interrupted on Sunday, March 10th from 8 AM to 2 PM due to tank cleaning. Please store water accordingly.', 1, 'maintenance', 'high', 1);




-- Enhanced Leads Table (Kanban Cards)
CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(50) UNIQUE NOT NULL, -- From website forms
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20) NOT NULL,
    
    -- Lead Source & Origin
    source VARCHAR(50) DEFAULT 'website', -- website, referral, walk_in, social_media, phone
    page_url TEXT, -- From website submissions
    
    -- Property Preferences
    preferred_building_id INTEGER REFERENCES buildings(id) ON DELETE SET NULL,
    preferred_room_type VARCHAR(20) CHECK (preferred_room_type IN ('single', 'double', 'triple')),
    budget_min DECIMAL(10,2),
    budget_max DECIMAL(10,2),
    preferred_move_in_date DATE,
    
    -- Lead Management (Kanban Functionality)
    status VARCHAR(50) DEFAULT 'new_leads' CHECK (status IN (
        'new_leads', 'hot', 'warm', 'initial_contact', 
        'negotiations', 'cold', 'lost', 'won'
    )),
    stage_position INTEGER DEFAULT 0, -- Position within the stage for drag-drop ordering
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL, -- Agent/Manager
    priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
    lead_score INTEGER DEFAULT 0 CHECK (lead_score >= 0 AND lead_score <= 100),
    
    -- Timeline & Follow-ups
    last_contacted_at TIMESTAMP,
    next_follow_up_date TIMESTAMP,
    follow_up_notes TEXT,
    
    -- Conversion Tracking
    converted_to_tenant_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    conversion_date TIMESTAMP,
    lost_reason VARCHAR(100),
    lost_date TIMESTAMP,
    
    -- Additional Info
    notes TEXT,
    tags TEXT[], -- Flexible tagging system
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lead Activities/Touch Log
CREATE TABLE IF NOT EXISTS lead_activities (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    
    -- Activity Details
    activity_type VARCHAR(50) NOT NULL, -- call, email, meeting, note, tour, follow_up
    touch_number INTEGER, -- Touch 1, Touch 2, etc.
    
    -- Communication (Hardcoded options in frontend)
    communication_mode VARCHAR(50), -- voice_call, sms, whatsapp_msg, whatsapp_call, email, in_person
    outcome VARCHAR(100), -- could_not_connect, call_me_back, on_whatsapp, video_tour, physical_tour, interested, not_interested
    
    -- Status Changes
    status_before VARCHAR(50),
    status_after VARCHAR(50),
    next_action VARCHAR(100),
    
    -- Scheduling
    scheduled_at TIMESTAMP,
    completed_at TIMESTAMP,
    try_again_date TIMESTAMP,
    next_interaction_date TIMESTAMP,
    
    -- Details
    title VARCHAR(200),
    description TEXT,
    notes TEXT,
    
    -- Agent Info
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    
    -- Files & Media
    attachments TEXT[], -- File paths/URLs
    
    -- Email specific
    email_sent BOOLEAN DEFAULT false,
    welcome_mail_status VARCHAR(20),
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lead Stage Transitions (Track Kanban Movement for Analytics)
CREATE TABLE IF NOT EXISTS lead_stage_transitions (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    moved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason VARCHAR(200),
    automated BOOLEAN DEFAULT false, -- Was this an automatic transition?
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lead Files & Documents
CREATE TABLE IF NOT EXISTS lead_documents (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL, -- id_proof, income_proof, agreement, photo, video_tour
    file_name VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    file_size INTEGER,
    mime_type VARCHAR(100),
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================

-- Kanban Board Performance
CREATE INDEX idx_leads_status_position ON leads(status, stage_position);
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX idx_leads_next_follow_up ON leads(next_follow_up_date) WHERE next_follow_up_date IS NOT NULL;
CREATE INDEX idx_leads_created_at ON leads(created_at);

-- Activity & Search Performance
CREATE INDEX idx_lead_activities_lead_id ON lead_activities(lead_id);
CREATE INDEX idx_lead_activities_created_at ON lead_activities(created_at);
CREATE INDEX idx_lead_transitions_lead_id ON lead_stage_transitions(lead_id);

-- Search Performance
CREATE INDEX idx_leads_phone ON leads(phone);
CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_name ON leads(name);