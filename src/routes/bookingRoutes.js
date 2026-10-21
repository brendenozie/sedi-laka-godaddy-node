const express = require('express');
const router = express.Router();
const bookingService = require('../services/bookingService');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { rateLimiter } = require('../middleware/rateLimiter');

const bookingLimiter = rateLimiter({ windowMs: 60 * 1000, maxRequests: 20, message: 'Too many booking attempts. Please wait.' });

// GET /api/bookings/availability?date=YYYY-MM-DD&timezone=Africa/Nairobi&duration=50
router.get('/availability', (req, res, next) => {
  try {
    const { date, timezone = 'Africa/Nairobi', duration = 50 } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Valid date query param (YYYY-MM-DD) is required.' });
    }

    const slots = bookingService.getAvailableSlots(date, timezone, Number(duration) || 50);
    res.json({ date, timezone, availableSlots: slots });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/hold - hold a slot for 10 minutes while entering checkout
router.post('/hold', bookingLimiter, requireAuth, (req, res, next) => {
  try {
    const { slotStartTime } = req.body;
    if (!slotStartTime) return res.status(400).json({ error: 'slotStartTime is required.' });

    const hold = bookingService.holdSlot(slotStartTime, req.user.id);
    res.json({ message: 'Slot reserved for 10 minutes.', hold });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings - create appointment (package-deduction or direct single session)
router.post('/', bookingLimiter, requireAuth, (req, res, next) => {
  try {
    const {
      serviceId,
      packageId,
      startTimeUtc,
      durationMinutes = 50,
      deliveryMethod = 'online',
      clientTimezone = 'Africa/Nairobi',
      clientNotes
    } = req.body;

    if (!serviceId || !startTimeUtc) {
      return res.status(400).json({ error: 'serviceId and startTimeUtc are required.' });
    }

    // If packageId is provided, verify it belongs to user
    if (packageId) {
      const db = getDb();
      const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND user_id = ?').get(packageId, req.user.id);
      if (!pkg) {
        return res.status(400).json({ error: 'Selected package not found or does not belong to you.' });
      }
      if (pkg.remaining_sessions <= 0) {
        return res.status(400).json({ error: 'No sessions remaining in this package.' });
      }
    }

    const appointment = bookingService.createAppointment({
      userId: req.user.id,
      serviceId,
      packageId: packageId || null,
      startTimeUtc,
      durationMinutes: Number(durationMinutes) || 50,
      deliveryMethod,
      clientTimezone,
      clientNotes: clientNotes ? clientNotes.trim() : null,
      status: 'confirmed'
    });

    res.status(201).json({
      message: 'Appointment booked successfully.',
      appointment
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/my - list user's appointments
router.get('/my', requireAuth, (req, res) => {
  const db = getDb();
  const appointments = db.prepare(`
    SELECT a.*, s.name as service_name, s.price_usd as service_price
    FROM appointments a
    JOIN services s ON a.service_id = s.id
    WHERE a.user_id = ?
    ORDER BY a.start_time DESC
  `).all(req.user.id);

  res.json({ appointments });
});

// POST /api/bookings/:id/cancel
router.post('/:id/cancel', requireAuth, (req, res, next) => {
  try {
    const { reason = '' } = req.body;
    const result = bookingService.cancelAppointment(req.params.id, req.user.id, req.user.role, reason);
    res.json({ message: 'Appointment has been cancelled.', result });
  } catch (err) {
    next(err);
  }
});

// POST /api/bookings/:id/reschedule
router.post('/:id/reschedule', bookingLimiter, requireAuth, (req, res, next) => {
  try {
    const { newStartTimeUtc } = req.body;
    if (!newStartTimeUtc) return res.status(400).json({ error: 'newStartTimeUtc is required.' });

    const newAppt = bookingService.rescheduleAppointment(req.params.id, newStartTimeUtc, req.user.id, req.user.role);
    res.json({ message: 'Appointment rescheduled successfully.', appointment: newAppt });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
