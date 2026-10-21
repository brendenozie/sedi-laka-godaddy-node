const crypto = require('crypto');
const { getDb } = require('../db');
const { deductPackageSession, restorePackageSession } = require('./packageService');
const { sendBookingConfirmationEmail, sendBookingCancellationEmail } = require('./emailService');

function cleanExpiredLocks() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare('DELETE FROM appointment_locks WHERE expires_at < ?').run(now);
}

function generateReferenceNumber() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `SL-${dateStr}-${rand}`;
}

// Generate available slots for a given date (YYYY-MM-DD)
function getAvailableSlots(dateString, clientTimezone = 'Africa/Nairobi', serviceDuration = 50) {
  cleanExpiredLocks();
  const db = getDb();

  const targetDate = new Date(`${dateString}T00:00:00Z`);
  const dayOfWeek = targetDate.getUTCDay(); // 0 = Sun, 1 = Mon ...

  const config = db.prepare('SELECT * FROM schedule_config WHERE day_of_week = ?').get(dayOfWeek);
  if (!config || !config.is_working_day) {
    return [];
  }

  // Parse working start and end time
  const [startHour, startMin] = config.start_time.split(':').map(Number);
  const [endHour, endMin] = config.end_time.split(':').map(Number);

  const dayStartUtc = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), startHour, startMin, 0));
  const dayEndUtc = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), endHour, endMin, 0));

  // Check blackout dates
  const blackouts = db.prepare(`
    SELECT * FROM blackout_dates
    WHERE (start_time <= ? AND end_time >= ?)
  `).all(dayEndUtc.toISOString(), dayStartUtc.toISOString());

  // Existing booked appointments for the day
  const bookedAppointments = db.prepare(`
    SELECT start_time, end_time FROM appointments
    WHERE status IN ('confirmed', 'pending_payment', 'hold')
      AND start_time < ? AND end_time > ?
  `).all(dayEndUtc.toISOString(), dayStartUtc.toISOString());

  // Active locks
  const activeLocks = db.prepare(`
    SELECT slot_start FROM appointment_locks
    WHERE slot_start >= ? AND slot_start < ?
  `).all(dayStartUtc.toISOString(), dayEndUtc.toISOString());

  const lockedStarts = new Set(activeLocks.map(l => l.slot_start));

  const slots = [];
  const slotIntervalMs = (config.slot_interval_minutes || 60) * 60 * 1000;
  const durationMs = serviceDuration * 60 * 1000;
  const bufferMs = (config.buffer_minutes || 15) * 60 * 1000;

  let currentSlot = new Date(dayStartUtc.getTime());
  const now = new Date();

  while (currentSlot.getTime() + durationMs <= dayEndUtc.getTime()) {
    const slotStart = new Date(currentSlot.getTime());
    const slotEnd = new Date(currentSlot.getTime() + durationMs);

    // Slot must be at least 2 hours in the future
    if (slotStart.getTime() > now.getTime() + 2 * 60 * 60 * 1000) {
      // Check collision with blackout dates
      const isBlackedOut = blackouts.some(b => {
        const bStart = new Date(b.start_time).getTime();
        const bEnd = new Date(b.end_time).getTime();
        return slotStart.getTime() < bEnd && slotEnd.getTime() > bStart;
      });

      // Check collision with booked appointments (including buffer)
      const isBooked = bookedAppointments.some(a => {
        const aStart = new Date(a.start_time).getTime();
        const aEnd = new Date(a.end_time).getTime();
        return (slotStart.getTime() < aEnd + bufferMs) && (slotEnd.getTime() + bufferMs > aStart);
      });

      // Check collision with active temporary locks
      const isLocked = lockedStarts.has(slotStart.toISOString());

      if (!isBlackedOut && !isBooked && !isLocked) {
        slots.push({
          startTime: slotStart.toISOString(),
          endTime: slotEnd.toISOString(),
          formattedTime: slotStart.toLocaleTimeString('en-US', {
            timeZone: clientTimezone,
            hour: '2-digit',
            minute: '2-digit'
          })
        });
      }
    }

    currentSlot = new Date(currentSlot.getTime() + slotIntervalMs);
  }

  return slots;
}

// Temporary lock reservation for 10 minutes while customer completes booking
function holdSlot(slotStartUtc, userId) {
  cleanExpiredLocks();
  const db = getDb();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Check if already booked
  const existing = db.prepare(`
    SELECT id FROM appointments
    WHERE start_time = ? AND status IN ('confirmed', 'pending_payment', 'hold')
  `).get(slotStartUtc);

  if (existing) {
    throw new Error('This slot is already booked.');
  }

  try {
    db.prepare(`
      INSERT INTO appointment_locks (slot_start, user_id, expires_at)
      VALUES (?, ?, ?)
    `).run(slotStartUtc, userId, expiresAt);
    return { slotStart: slotStartUtc, expiresAt };
  } catch (err) {
    throw new Error('This time slot is currently being reserved by another client. Please select another slot.');
  }
}

function releaseHold(slotStartUtc) {
  const db = getDb();
  db.prepare('DELETE FROM appointment_locks WHERE slot_start = ?').run(slotStartUtc);
}

// Book appointment in a strict database transaction
function createAppointment({
  userId,
  serviceId,
  packageId = null,
  startTimeUtc,
  durationMinutes = 50,
  deliveryMethod = 'online',
  clientTimezone = 'Africa/Nairobi',
  clientNotes = null,
  status = 'confirmed'
}) {
  const db = getDb();
  cleanExpiredLocks();

  const start = new Date(startTimeUtc);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  const startTimeIso = start.toISOString();
  const endTimeIso = end.toISOString();
  const now = new Date().toISOString();
  const appointmentId = crypto.randomUUID();
  const refNumber = generateReferenceNumber();

  // Execute inside an atomic transaction
  return db.transaction(() => {
    // 1. Strict Double-Booking Guard: ensure no overlapping confirmed/pending appointments
    const conflict = db.prepare(`
      SELECT id, reference_number FROM appointments
      WHERE status IN ('confirmed', 'pending_payment', 'hold')
        AND (start_time < ? AND end_time > ?)
    `).get(endTimeIso, startTimeIso);

    if (conflict) {
      throw new Error('The selected time slot has already been booked. Please choose another time.');
    }

    // 2. If package-based, deduct 1 session and record in ledger
    if (packageId) {
      deductPackageSession(packageId, appointmentId, 'Booked appointment ' + refNumber);
    }

    // 3. Insert appointment record
    db.prepare(`
      INSERT INTO appointments (
        id, reference_number, user_id, service_id, package_id,
        start_time, end_time, duration_minutes, delivery_method,
        status, client_timezone, client_notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      appointmentId, refNumber, userId, serviceId, packageId,
      startTimeIso, endTimeIso, durationMinutes, deliveryMethod,
      status, clientTimezone, clientNotes, now, now
    );

    // 4. Clear any lock on this slot
    releaseHold(startTimeIso);

    // Fetch created record with service and user details
    const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
    const user = db.prepare('SELECT id, email, full_name FROM users WHERE id = ?').get(userId);

    // Send confirmation email asynchronously
    if (status === 'confirmed' && user && service) {
      sendBookingConfirmationEmail(
        { id: user.id, email: user.email, fullName: user.full_name },
        { referenceNumber: refNumber, startTime: startTimeIso, clientTimezone, deliveryMethod },
        service
      ).catch(e => console.error('[Email Error] Confirmation failed:', e.message));
    }

    return appointment;
  })();
}

// Cancel appointment
function cancelAppointment(appointmentId, userId, role, reason = '') {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(() => {
    const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appt) {
      throw new Error('Appointment not found.');
    }

    // IDOR protection: client can only cancel their own appointment
    if (role === 'client' && appt.user_id !== userId) {
      throw new Error('Unauthorized to cancel this appointment.');
    }

    if (appt.status === 'cancelled') {
      throw new Error('Appointment is already cancelled.');
    }

    // Update appointment status
    db.prepare(`
      UPDATE appointments
      SET status = 'cancelled', cancellation_reason = ?, cancelled_at = ?, updated_at = ?
      WHERE id = ?
    `).run(reason, now, now, appointmentId);

    // If appointment used a package, restore the session credit in the ledger
    if (appt.package_id) {
      restorePackageSession(appt.package_id, appointmentId, `Cancelled appointment ${appt.reference_number}: ${reason}`);
    }

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(appt.service_id);
    const user = db.prepare('SELECT id, email, full_name FROM users WHERE id = ?').get(appt.user_id);

    if (user && service) {
      sendBookingCancellationEmail(
        { id: user.id, email: user.email, fullName: user.full_name },
        { referenceNumber: appt.reference_number },
        service,
        reason
      ).catch(e => console.error('[Email Error] Cancellation email failed:', e.message));
    }

    return { success: true, referenceNumber: appt.reference_number };
  })();
}

// Reschedule appointment
function rescheduleAppointment(appointmentId, newStartTimeUtc, userId, role) {
  const db = getDb();
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!appt) {
    throw new Error('Appointment not found.');
  }

  if (role === 'client' && appt.user_id !== userId) {
    throw new Error('Unauthorized to reschedule this appointment.');
  }

  // Cancel old and create new with reference to original
  return db.transaction(() => {
    cancelAppointment(appointmentId, userId, role, 'Rescheduled to ' + newStartTimeUtc);
    
    return createAppointment({
      userId: appt.user_id,
      serviceId: appt.service_id,
      packageId: appt.package_id,
      startTimeUtc: newStartTimeUtc,
      durationMinutes: appt.duration_minutes,
      deliveryMethod: appt.delivery_method,
      clientTimezone: appt.client_timezone,
      clientNotes: `Rescheduled from ${appt.reference_number}. ${appt.client_notes || ''}`,
      status: 'confirmed'
    });
  })();
}

module.exports = {
  getAvailableSlots,
  holdSlot,
  releaseHold,
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
  cleanExpiredLocks
};
