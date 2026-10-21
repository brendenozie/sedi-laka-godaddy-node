const crypto = require('crypto');
const { getDb } = require('../db');
const { sendEventRegistrationEmail } = require('./emailService');

function registerForEvent({ eventId, userId, paymentId = null }) {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(() => {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) throw new Error('Event not found.');
    if (event.status !== 'published') {
      throw new Error(`This event is not open for registration (status: ${event.status}).`);
    }

    // Check if user is already registered
    const existing = db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND user_id = ?').get(eventId, userId);
    if (existing && existing.status !== 'cancelled') {
      throw new Error('You are already registered for this event.');
    }

    // Capacity check: count active registrations
    const countResult = db.prepare(`
      SELECT COUNT(*) as count FROM event_registrations
      WHERE event_id = ? AND status IN ('confirmed', 'pending')
    `).get(eventId);

    if (countResult.count >= event.capacity) {
      throw new Error(`This event has reached its maximum capacity of ${event.capacity} participants.`);
    }

    const regId = crypto.randomUUID();
    const status = event.price_usd > 0 && !paymentId ? 'pending' : 'confirmed';

    if (existing) {
      db.prepare(`
        UPDATE event_registrations
        SET status = ?, payment_id = ?, registered_at = ?
        WHERE id = ?
      `).run(status, paymentId, now, existing.id);
    } else {
      db.prepare(`
        INSERT INTO event_registrations (id, event_id, user_id, payment_id, status, registered_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(regId, eventId, userId, paymentId, status, now);
    }

    const registration = db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND user_id = ?').get(eventId, userId);
    const user = db.prepare('SELECT id, email, full_name FROM users WHERE id = ?').get(userId);

    if (status === 'confirmed' && user) {
      sendEventRegistrationEmail(
        { id: user.id, email: user.email, fullName: user.full_name },
        event
      ).catch(e => console.error('[Email Error] Event confirmation failed:', e.message));
    }

    return { registration, event };
  })();
}

function cancelEventRegistration(eventId, userId) {
  const db = getDb();
  const reg = db.prepare('SELECT * FROM event_registrations WHERE event_id = ? AND user_id = ?').get(eventId, userId);
  if (!reg) throw new Error('Registration not found.');

  db.prepare("UPDATE event_registrations SET status = 'cancelled' WHERE id = ?").run(reg.id);
  return { success: true };
}

function getEventAttendees(eventId) {
  const db = getDb();
  return db.prepare(`
    SELECT er.id as registration_id, er.status, er.registered_at,
           u.id as user_id, u.full_name, u.email, u.phone
    FROM event_registrations er
    JOIN users u ON er.user_id = u.id
    WHERE er.event_id = ? AND er.status != 'cancelled'
    ORDER BY er.registered_at ASC
  `).all(eventId);
}

module.exports = {
  registerForEvent,
  cancelEventRegistration,
  getEventAttendees
};
