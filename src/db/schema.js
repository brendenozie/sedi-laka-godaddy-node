function initializeSchema(db) {
  // Enforce WAL mode and foreign key constraints
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'staff', 'therapist', 'admin')),
      email_verified INTEGER NOT NULL DEFAULT 0,
      verification_token TEXT,
      verification_token_expires_at TEXT,
      reset_token TEXT,
      reset_token_expires_at TEXT,
      communication_prefs TEXT DEFAULT '{"email_reminders":true,"sms_reminders":false,"newsletter":false}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    -- Sessions table (persistent server-side sessions)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    -- Services catalog
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('single_session', 'package', 'event', 'resource')),
      description TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 50,
      price_usd REAL NOT NULL,
      session_count INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    -- Weekly Working Schedule
    CREATE TABLE IF NOT EXISTS schedule_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week INTEGER NOT NULL UNIQUE, -- 0=Sun, 1=Mon, ..., 6=Sat
      start_time TEXT NOT NULL, -- e.g. "09:00"
      end_time TEXT NOT NULL,   -- e.g. "17:00"
      is_working_day INTEGER NOT NULL DEFAULT 1,
      slot_interval_minutes INTEGER NOT NULL DEFAULT 60,
      buffer_minutes INTEGER NOT NULL DEFAULT 15
    );

    -- Blackout Dates / Holidays / Time-off
    CREATE TABLE IF NOT EXISTS blackout_dates (
      id TEXT PRIMARY KEY,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    -- Purchased Packages
    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      name TEXT NOT NULL,
      total_sessions INTEGER NOT NULL,
      remaining_sessions INTEGER NOT NULL,
      price_paid_usd REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'refunded')),
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES services(id)
    );

    CREATE INDEX IF NOT EXISTS idx_packages_user_id ON packages(user_id);

    -- Package Ledger for auditable session increments and decrements
    CREATE TABLE IF NOT EXISTS package_ledger (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      appointment_id TEXT,
      delta INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      adjusted_by_user_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (package_id) REFERENCES packages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_package_ledger_pkg ON package_ledger(package_id);

    -- Concurrency Locks for booking slots
    CREATE TABLE IF NOT EXISTS appointment_locks (
      slot_start TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    -- Appointments
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      reference_number TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      package_id TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      delivery_method TEXT NOT NULL DEFAULT 'online' CHECK (delivery_method IN ('online', 'in_person')),
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('hold', 'pending_payment', 'confirmed', 'completed', 'cancelled', 'no_show')),
      client_timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
      client_notes TEXT,
      cancellation_reason TEXT,
      cancelled_at TEXT,
      rescheduled_from_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES services(id),
      FOREIGN KEY (package_id) REFERENCES packages(id)
    );

    CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments(user_id);
    CREATE INDEX IF NOT EXISTS idx_appointments_time ON appointments(start_time, end_time);
    CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);

    -- Payments & Transactions
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      transaction_reference TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('mpesa', 'card_stripe', 'card_pesapal', 'mock_sandbox', 'manual_admin')),
      provider_tx_id TEXT,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'successful', 'failed', 'cancelled', 'refunded', 'reconciliation_required')),
      item_type TEXT NOT NULL CHECK (item_type IN ('service_session', 'package', 'event', 'resource')),
      item_id TEXT NOT NULL,
      metadata_json TEXT,
      idempotency_key TEXT UNIQUE,
      provider_response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_tx_ref ON payments(transaction_reference);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

    -- Events & Group Experiences (Vision Board Experience, Retreats, Live Online)
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Africa/Nairobi',
      venue TEXT NOT NULL,
      delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('online', 'in_person', 'hybrid')),
      capacity INTEGER NOT NULL DEFAULT 15,
      price_usd REAL NOT NULL DEFAULT 0.0,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'closed', 'cancelled')),
      registration_deadline TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

    -- Event Registrations
    CREATE TABLE IF NOT EXISTS event_registrations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      payment_id TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
      registered_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (payment_id) REFERENCES payments(id),
      UNIQUE(event_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_event_reg_event ON event_registrations(event_id);
    CREATE INDEX IF NOT EXISTS idx_event_reg_user ON event_registrations(user_id);

    -- Digital Resources (Lifelines & Guided Resources)
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('planners', 'reflective_guides', 'guided_journals', 'audio_guides', 'video_guides')),
      description TEXT NOT NULL,
      file_filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      price_usd REAL NOT NULL DEFAULT 0.0,
      is_free INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'archived')),
      created_at TEXT NOT NULL
    );

    -- Resource Purchases & Access Entitlements
    CREATE TABLE IF NOT EXISTS resource_purchases (
      id TEXT PRIMARY KEY,
      resource_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      payment_id TEXT,
      download_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (payment_id) REFERENCES payments(id),
      UNIQUE(resource_id, user_id)
    );

    -- Notifications and Email Deliveries
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      recipient_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      type TEXT NOT NULL,
      body_html TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'failed')),
      provider_message_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_email);

    -- Audit Logs
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details_json TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
  `);
}

module.exports = { initializeSchema };
