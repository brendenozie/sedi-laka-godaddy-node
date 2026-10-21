const express = require('express');
const router = express.Router();
const eventService = require('../services/eventService');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/events - list published events with real available capacity
router.get('/', (req, res) => {
  const db = getDb();
  const events = db.prepare(`
    SELECT e.*,
           (e.capacity - (
             SELECT COUNT(*) FROM event_registrations er
             WHERE er.event_id = e.id AND er.status != 'cancelled'
           )) as available_seats
    FROM events e
    WHERE e.status = 'published'
    ORDER BY e.start_time ASC
  `).all();

  res.json({ events });
});

// GET /api/events/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const event = db.prepare(`
    SELECT e.*,
           (e.capacity - (
             SELECT COUNT(*) FROM event_registrations er
             WHERE er.event_id = e.id AND er.status != 'cancelled'
           )) as available_seats
    FROM events e
    WHERE e.id = ? OR e.slug = ?
  `).get(req.params.id, req.params.id);

  if (!event) return res.status(404).json({ error: 'Event not found.' });
  res.json({ event });
});

// GET /api/events/my/registrations
router.get('/my/registrations', requireAuth, (req, res) => {
  const db = getDb();
  const registrations = db.prepare(`
    SELECT er.*, e.title as event_title, e.start_time, e.end_time, e.venue, e.delivery_mode, e.timezone
    FROM event_registrations er
    JOIN events e ON er.event_id = e.id
    WHERE er.user_id = ?
    ORDER BY e.start_time ASC
  `).all(req.user.id);

  res.json({ registrations });
});

// POST /api/events/:id/register
router.post('/:id/register', requireAuth, (req, res, next) => {
  try {
    const { paymentId = null } = req.body;
    const result = eventService.registerForEvent({
      eventId: req.params.id,
      userId: req.user.id,
      paymentId
    });

    res.status(201).json({
      message: 'Successfully registered for event.',
      registration: result.registration,
      event: result.event
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/events/:id/cancel
router.post('/:id/cancel', requireAuth, (req, res, next) => {
  try {
    const result = eventService.cancelEventRegistration(req.params.id, req.user.id);
    res.json({ message: 'Event registration cancelled.', result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
