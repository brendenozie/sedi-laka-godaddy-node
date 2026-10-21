const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { adjustPackageBalance } = require('../services/packageService');
const { refundPayment } = require('../services/paymentService');
const { createBackup, listBackups, verifyRestore } = require('../services/backupService');
const { getEventAttendees } = require('../services/eventService');

// All admin routes require staff, therapist, or admin role
router.use(requireAuth);
router.use(requireRole('admin', 'staff', 'therapist'));

// GET /api/admin/overview - dashboard metrics
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

// GET /api/admin/appointments
router.get('/appointments', (req, res) => {
  const db = getDb();
  const { status, limit = 50 } = req.query;

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
  params.push(Number(limit) || 50);

  const appointments = db.prepare(query).all(...params);
  res.json({ appointments });
});

// PUT /api/admin/appointments/:id/status
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

  // Record audit log
  db.prepare(`
    INSERT INTO audit_logs (id, user_id, role, action, resource_type, resource_id, details_json, created_at)
    VALUES (?, ?, ?, 'update_appointment_status', 'appointment', ?, ?, ?)
  `).run(crypto.randomUUID(), req.user.id, req.user.role, req.params.id, JSON.stringify({ status, notes }), now);

  res.json({ message: 'Appointment status updated.' });
});

// GET /api/admin/schedule
router.get('/schedule', (req, res) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM schedule_config ORDER BY day_of_week ASC').all();
  const blackouts = db.prepare('SELECT * FROM blackout_dates ORDER BY start_time ASC').all();
  res.json({ schedule, blackouts });
});

// PUT /api/admin/schedule/:dayOfWeek
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

// POST /api/admin/blackout-dates
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

// DELETE /api/admin/blackout-dates/:id
router.delete('/blackout-dates/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM blackout_dates WHERE id = ?').run(req.params.id);
  res.json({ message: 'Blackout date removed.' });
});

// POST /api/admin/packages/:id/adjust
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

// GET /api/admin/payments
router.get('/payments', (req, res) => {
  const db = getDb();
  const payments = db.prepare(`
    SELECT p.*, u.full_name as client_name, u.email as client_email
    FROM payments p
    JOIN users u ON p.user_id = u.id
    ORDER BY p.created_at DESC
    LIMIT 100
  `).all();
  res.json({ payments });
});

// POST /api/admin/payments/:id/refund
router.post('/payments/:id/refund', requireRole('admin'), (req, res, next) => {
  try {
    const { reason = 'Customer refund' } = req.body;
    const payment = refundPayment(req.params.id, reason, req.user.id);
    res.json({ message: 'Payment refunded.', payment });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/events/:id/attendees
router.get('/events/:id/attendees', (req, res) => {
  const attendees = getEventAttendees(req.params.id);
  res.json({ attendees });
});

// POST /api/admin/events
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

// GET /api/admin/audit-logs
router.get('/audit-logs', requireRole('admin'), (req, res) => {
  const db = getDb();
  const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100').all();
  res.json({ logs });
});

// POST /api/admin/backups/create
router.post('/backups/create', requireRole('admin'), async (req, res, next) => {
  try {
    const backup = await createBackup();
    res.json({ message: 'Database backup created and verified successfully.', backup });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/backups
router.get('/backups', requireRole('admin'), (req, res) => {
  const backups = listBackups();
  res.json({ backups });
});

// POST /api/admin/backups/verify-restore
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
