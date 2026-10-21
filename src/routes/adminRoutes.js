const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { hashPassword } = require('../services/authService');
const { adjustPackageBalance } = require('../services/packageService');
const { refundPayment, completePayment } = require('../services/paymentService');
const { createBackup, listBackups, verifyRestore } = require('../services/backupService');
const { getEventAttendees } = require('../services/eventService');

// All admin routes require staff, therapist, or admin role
router.use(requireAuth);
router.use(requireRole('admin', 'staff', 'therapist'));

// ==========================================
// 1. Overview & Metrics
// ==========================================
router.get('/overview', (req, res) => {
  const db = getDb();

  const totalClients = db.prepare("SELECT count(*) as count FROM users WHERE role = 'client'").get().count;
  const totalAppointments = db.prepare("SELECT count(*) as count FROM appointments").get().count;
  const upcomingAppointments = db.prepare("SELECT count(*) as count FROM appointments WHERE status = 'confirmed' AND start_time > datetime('now')").get().count;
  const activePackages = db.prepare("SELECT count(*) as count FROM packages WHERE status = 'active'").get().count;
  const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'successful'").get().total;

  const recentAppointments = db.prepare(`
    SELECT a.*, u.full_name as client_name, u.email as client_email, s.name as service_name
    FROM appointments a
    JOIN users u ON a.user_id = u.id
    JOIN services s ON a.service_id = s.id
    ORDER BY a.start_time DESC
    LIMIT 10
  `).all();

  res.json({
    metrics: {
      totalClients,
      totalAppointments,
      upcomingAppointments,
      activePackages,
      totalRevenueUsd: totalRevenue
    },
    recentAppointments
  });
});

// ==========================================
// 2. Accounts & User Management
// ==========================================
router.get('/users', (req, res) => {
  const db = getDb();
  const { role, search } = req.query;

  let query = 'SELECT id, email, full_name, phone, role, email_verified, created_at, updated_at FROM users WHERE 1=1';
  const params = [];

  if (role) {
    query += ' AND role = ?';
    params.push(role);
  }
  if (search) {
    query += ' AND (email LIKE ? OR full_name LIKE ? OR phone LIKE ?)';
    const term = `%${search.trim()}%`;
    params.push(term, term, term);
  }

  query += ' ORDER BY created_at DESC';
  const users = db.prepare(query).all(...params);
  res.json({ users });
});

router.post('/users', requireRole('admin'), (req, res, next) => {
  try {
    const db = getDb();
    const { email, password, fullName, phone, role = 'client', emailVerified = true } = req.body;

    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Email, password, and full name are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }

    const { hash, salt } = hashPassword(password);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (
        id, email, password_hash, password_salt, full_name, phone, role,
        email_verified, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, normalizedEmail, hash, salt, fullName.trim(), phone ? phone.trim() : null, role, emailVerified ? 1 : 0, now, now);

    res.status(201).json({ message: 'User account created successfully.', userId });
  } catch (err) {
    next(err);
  }
});

router.put('/users/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { fullName, phone, role, emailVerified } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE users
    SET full_name = COALESCE(?, full_name),
        phone = COALESCE(?, phone),
        role = COALESCE(?, role),
        email_verified = COALESCE(?, email_verified),
        updated_at = ?
    WHERE id = ?
  `).run(
    fullName !== undefined ? fullName.trim() : null,
    phone !== undefined ? phone.trim() : null,
    role || null,
    emailVerified !== undefined ? (emailVerified ? 1 : 0) : null,
    now,
    req.params.id
  );

  res.json({ message: 'User profile updated successfully.' });
});

router.post('/users/:id/reset-password', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  const { hash, salt } = hashPassword(newPassword);
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE users
    SET password_hash = ?, password_salt = ?, updated_at = ?
    WHERE id = ?
  `).run(hash, salt, now, req.params.id);

  res.json({ message: 'User password reset successfully.' });
});

router.delete('/users/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own logged-in administrator account.' });
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ message: 'User account deleted.' });
});

// ==========================================
// 3. Appointments Management
// ==========================================
router.get('/appointments', (req, res) => {
  const db = getDb();
  const { status, limit = 100 } = req.query;

  let query = `
    SELECT a.*, u.full_name as client_name, u.email as client_email, u.phone as client_phone, s.name as service_name
    FROM appointments a
    JOIN users u ON a.user_id = u.id
    JOIN services s ON a.service_id = s.id
  `;
  const params = [];

  if (status) {
    query += ' WHERE a.status = ?';
    params.push(status);
  }

  query += ' ORDER BY a.start_time DESC LIMIT ?';
  params.push(Number(limit) || 100);

  const appointments = db.prepare(query).all(...params);
  res.json({ appointments });
});

router.put('/appointments/:id/status', (req, res) => {
  const db = getDb();
  const { status, notes } = req.body;
  if (!['confirmed', 'completed', 'cancelled', 'no_show'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE appointments
    SET status = ?, client_notes = COALESCE(?, client_notes), updated_at = ?
    WHERE id = ?
  `).run(status, notes || null, now, req.params.id);

  db.prepare(`
    INSERT INTO audit_logs (id, user_id, role, action, resource_type, resource_id, details_json, created_at)
    VALUES (?, ?, ?, 'update_appointment_status', 'appointment', ?, ?, ?)
  `).run(crypto.randomUUID(), req.user.id, req.user.role, req.params.id, JSON.stringify({ status, notes }), now);

  res.json({ message: 'Appointment status updated.' });
});

// ==========================================
// 4. Schedule & Blackouts
// ==========================================
router.get('/schedule', (req, res) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM schedule_config ORDER BY day_of_week ASC').all();
  const blackouts = db.prepare('SELECT * FROM blackout_dates ORDER BY start_time ASC').all();
  res.json({ schedule, blackouts });
});

router.put('/schedule/:dayOfWeek', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { startTime, endTime, isWorkingDay, bufferMinutes, slotIntervalMinutes } = req.body;

  db.prepare(`
    UPDATE schedule_config
    SET start_time = COALESCE(?, start_time),
        end_time = COALESCE(?, end_time),
        is_working_day = COALESCE(?, is_working_day),
        buffer_minutes = COALESCE(?, buffer_minutes),
        slot_interval_minutes = COALESCE(?, slot_interval_minutes)
    WHERE day_of_week = ?
  `).run(startTime, endTime, isWorkingDay, bufferMinutes, slotIntervalMinutes, req.params.dayOfWeek);

  res.json({ message: 'Schedule updated.' });
});

router.post('/blackout-dates', requireRole('admin', 'staff'), (req, res) => {
  const db = getDb();
  const { startTime, endTime, reason } = req.body;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO blackout_dates (id, start_time, end_time, reason, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, startTime, endTime, reason || null, req.user.email, now);

  res.status(201).json({ message: 'Blackout dates registered.', id });
});

router.delete('/blackout-dates/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM blackout_dates WHERE id = ?').run(req.params.id);
  res.json({ message: 'Blackout date removed.' });
});

// ==========================================
// 5. Services & Pricing Catalog
// ==========================================
router.get('/services', (req, res) => {
  const db = getDb();
  const services = db.prepare('SELECT * FROM services ORDER BY price_usd ASC').all();
  res.json({ services });
});

router.post('/services', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { name, type, durationMinutes, priceUsd, sessionCount, description, isActive = 1 } = req.body;
  if (!name || priceUsd === undefined) {
    return res.status(400).json({ error: 'Name and priceUsd are required.' });
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `srv-${slug}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO services (id, name, slug, type, description, duration_minutes, price_usd, currency, session_count, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?)
  `).run(
    id, name.trim(), slug, type || 'single_session', description ? description.trim() : '',
    Number(durationMinutes) || 50, Number(priceUsd) || 0, Number(sessionCount) || 1,
    isActive ? 1 : 0, now, now
  );

  res.status(201).json({ message: 'Service created successfully.', serviceId: id });
});

router.put('/services/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { name, type, durationMinutes, priceUsd, sessionCount, description, isActive } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE services
    SET name = COALESCE(?, name),
        type = COALESCE(?, type),
        duration_minutes = COALESCE(?, duration_minutes),
        price_usd = COALESCE(?, price_usd),
        session_count = COALESCE(?, session_count),
        description = COALESCE(?, description),
        is_active = COALESCE(?, is_active),
        updated_at = ?
    WHERE id = ?
  `).run(
    name ? name.trim() : null,
    type || null,
    durationMinutes !== undefined ? Number(durationMinutes) : null,
    priceUsd !== undefined ? Number(priceUsd) : null,
    sessionCount !== undefined ? Number(sessionCount) : null,
    description !== undefined ? description.trim() : null,
    isActive !== undefined ? (isActive ? 1 : 0) : null,
    now,
    req.params.id
  );

  res.json({ message: 'Service updated successfully.' });
});

router.delete('/services/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  res.json({ message: 'Service deleted.' });
});

// ==========================================
// 6. Events & Attendee Rosters
// ==========================================
router.get('/events', (req, res) => {
  const db = getDb();
  const events = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM event_registrations er WHERE er.event_id = e.id AND er.status = 'confirmed') as registered_count
    FROM events e
    ORDER BY e.start_time DESC
  `).all();
  res.json({ events });
});

router.post('/events', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { title, description, startTime, endTime, timezone, venue, deliveryMode, capacity, priceUsd, status } = req.body;
  const id = crypto.randomUUID();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO events (
      id, title, slug, description, start_time, end_time, timezone,
      venue, delivery_mode, capacity, price_usd, currency, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)
  `).run(
    id, title, slug, description, startTime, endTime, timezone || 'Africa/Nairobi',
    venue, deliveryMode || 'online', Number(capacity) || 15, Number(priceUsd) || 0,
    status || 'published', now, now
  );

  res.status(201).json({ message: 'Event created.', id });
});

router.put('/events/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { title, description, startTime, endTime, venue, deliveryMode, capacity, priceUsd, status } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE events
    SET title = COALESCE(?, title),
        description = COALESCE(?, description),
        start_time = COALESCE(?, start_time),
        end_time = COALESCE(?, end_time),
        venue = COALESCE(?, venue),
        delivery_mode = COALESCE(?, delivery_mode),
        capacity = COALESCE(?, capacity),
        price_usd = COALESCE(?, price_usd),
        status = COALESCE(?, status),
        updated_at = ?
    WHERE id = ?
  `).run(
    title, description, startTime, endTime, venue, deliveryMode,
    capacity !== undefined ? Number(capacity) : null,
    priceUsd !== undefined ? Number(priceUsd) : null,
    status, now, req.params.id
  );

  res.json({ message: 'Event updated successfully.' });
});

router.delete('/events/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ message: 'Event deleted.' });
});

router.get('/events/:id/attendees', (req, res) => {
  const attendees = getEventAttendees(req.params.id);
  res.json({ attendees });
});

// ==========================================
// 7. Orders & Payments Management
// ==========================================
router.get('/payments', (req, res) => {
  const db = getDb();
  const payments = db.prepare(`
    SELECT p.*, u.full_name as client_name, u.email as client_email
    FROM payments p
    LEFT JOIN users u ON p.user_id = u.id
    ORDER BY p.created_at DESC
    LIMIT 150
  `).all();
  res.json({ payments });
});

router.post('/payments/:id/refund', requireRole('admin'), (req, res, next) => {
  try {
    const { reason = 'Customer refund' } = req.body;
    const payment = refundPayment(req.params.id, reason, req.user.id);
    res.json({ message: 'Payment refunded successfully.', payment });
  } catch (err) {
    next(err);
  }
});

router.post('/payments/:id/fulfill', requireRole('admin'), (req, res, next) => {
  try {
    const db = getDb();
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found.' });

    const updated = completePayment(
      payment.transaction_reference,
      `manual_admin_fulfill_${Date.now()}`,
      { adminOverride: true, adminUser: req.user.email },
      true
    );

    res.json({ message: 'Order fulfilled successfully.', payment: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/packages/:id/adjust', requireRole('admin'), (req, res, next) => {
  try {
    const { delta, reason } = req.body;
    if (typeof delta !== 'number' || !reason) {
      return res.status(400).json({ error: 'delta (number) and reason (string) are required.' });
    }

    const updated = adjustPackageBalance(req.params.id, delta, reason, req.user.id);
    res.json({ message: 'Package balance adjusted.', package: updated });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// 8. Digital Resources Management
// ==========================================
router.get('/resources', (req, res) => {
  const db = getDb();
  const resources = db.prepare('SELECT * FROM resources ORDER BY created_at DESC').all();
  res.json({ resources });
});

router.post('/resources', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { title, description, isFree, priceUsd, filePath, status = 'published' } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required.' });

  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const id = `res-${slug}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO resources (id, title, slug, description, file_path, is_free, price_usd, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)
  `).run(
    id, title.trim(), slug, description ? description.trim() : '', filePath || 'guide.pdf',
    isFree ? 1 : 0, isFree ? 0 : (Number(priceUsd) || 0), status, now, now
  );

  res.status(201).json({ message: 'Resource created.', id });
});

router.put('/resources/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { title, description, isFree, priceUsd, filePath, status } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE resources
    SET title = COALESCE(?, title),
        description = COALESCE(?, description),
        is_free = COALESCE(?, is_free),
        price_usd = COALESCE(?, price_usd),
        file_path = COALESCE(?, file_path),
        status = COALESCE(?, status),
        updated_at = ?
    WHERE id = ?
  `).run(
    title ? title.trim() : null,
    description ? description.trim() : null,
    isFree !== undefined ? (isFree ? 1 : 0) : null,
    priceUsd !== undefined ? Number(priceUsd) : null,
    filePath || null,
    status || null,
    now,
    req.params.id
  );

  res.json({ message: 'Resource updated.' });
});

router.delete('/resources/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM resources WHERE id = ?').run(req.params.id);
  res.json({ message: 'Resource deleted.' });
});

// ==========================================
// 9. Direct Database Explorer & Safe SQL
// ==========================================
router.get('/db/tables', requireRole('admin'), (req, res) => {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC").all();
  const result = tables.map(t => {
    const count = db.prepare(`SELECT count(*) as count FROM ${t.name}`).get().count;
    return { name: t.name, rowCount: count };
  });
  res.json({ tables: result });
});

router.get('/db/table/:name', requireRole('admin'), (req, res) => {
  const db = getDb();
  const tableName = req.params.name.replace(/[^a-zA-Z0-9_]/g, '');
  try {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const rows = db.prepare(`SELECT * FROM ${tableName} LIMIT 100`).all();
    res.json({ tableName, columns, rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/db/execute', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { sql } = req.body;

  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({ error: 'SQL statement is required.' });
  }

  const trimmed = sql.trim();
  const isSelect = /^SELECT\b/i.test(trimmed) || /^PRAGMA\b/i.test(trimmed);

  try {
    if (isSelect) {
      const rows = db.prepare(trimmed).all();
      return res.json({ success: true, isSelect: true, rows, count: rows.length });
    }

    // Write operations require transaction and audit trail
    const result = db.transaction(() => {
      const stmt = db.prepare(trimmed);
      const info = stmt.run();

      const auditId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO audit_logs (id, user_id, role, action, resource_type, resource_id, details_json, created_at)
        VALUES (?, ?, 'admin', 'db_direct_query', 'database', 'sqlite', ?, datetime('now'))
      `).run(auditId, req.user.id, JSON.stringify({ sql: trimmed, changes: info.changes }));

      return info;
    })();

    res.json({ success: true, isSelect: false, changes: result.changes, lastInsertRowid: String(result.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==========================================
// 10. Audit Logs & Backups
// ==========================================
router.get('/audit-logs', requireRole('admin'), (req, res) => {
  const db = getDb();
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 150').all();
  res.json({ logs });
});

router.post('/backups/create', requireRole('admin'), async (req, res, next) => {
  try {
    const backup = await createBackup();
    res.json({ message: 'Database backup created and verified successfully.', backup });
  } catch (err) {
    next(err);
  }
});

router.get('/backups', requireRole('admin'), (req, res) => {
  const backups = listBackups();
  res.json({ backups });
});

router.post('/backups/verify-restore', requireRole('admin'), (req, res, next) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required.' });
    const result = verifyRestore(filename);
    res.json({ message: 'Restore verification completed.', result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
