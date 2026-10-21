const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { getDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const bookingService = require('../src/services/bookingService');
const packageService = require('../src/services/packageService');
const authService = require('../src/services/authService');

describe('Category B: Booking Engine, Concurrency, and Packages', () => {
  let client1 = null;
  let client2 = null;

  before(() => {
    getDb();
    seedDatabase();
    client1 = authService.registerUser({
      email: `client_booking1_${Date.now()}@example.com`,
      password: 'Password123!',
      fullName: 'Client One'
    });
    client2 = authService.registerUser({
      email: `client_booking2_${Date.now()}@example.com`,
      password: 'Password123!',
      fullName: 'Client Two'
    });
  });

  test('Availability: Returns open slots for future working day', () => {
    // Pick upcoming Tuesday (working day)
    const d = new Date();
    d.setDate(d.getDate() + ((2 + 7 - d.getDay()) % 7 || 7));
    const dateStr = d.toISOString().split('T')[0];

    const slots = bookingService.getAvailableSlots(dateStr, 'Africa/Nairobi', 50);
    assert.ok(Array.isArray(slots));
    assert.ok(slots.length > 0, 'Should have open working slots');
    assert.ok(slots[0].startTime);
    assert.ok(slots[0].formattedTime);
  });

  test('Hold Reservation: Temporarily reserves slot for client', () => {
    const slotTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const hold = bookingService.holdSlot(slotTime, client1.userId);
    assert.equal(hold.slotStart, slotTime);

    // Another client attempting to hold the same slot is rejected
    assert.throws(() => {
      bookingService.holdSlot(slotTime, client2.userId);
    }, /currently being reserved/);

    bookingService.releaseHold(slotTime);
  });

  test('Double-Booking Prevention: Concurrency lock blocks overlapping booking', () => {
    const slotTime = new Date(Date.now() + (500 + Math.floor(Math.random() * 500)) * 3600 * 1000).toISOString();

    // 1st booking succeeds
    const appt1 = bookingService.createAppointment({
      userId: client1.userId,
      serviceId: 'srv-exploration-session',
      startTimeUtc: slotTime,
      durationMinutes: 50,
      deliveryMethod: 'online'
    });
    assert.ok(appt1.id);
    assert.ok(appt1.reference_number);

    // 2nd booking attempt for same slot MUST be rejected
    assert.throws(() => {
      bookingService.createAppointment({
        userId: client2.userId,
        serviceId: 'srv-exploration-session',
        startTimeUtc: slotTime,
        durationMinutes: 50,
        deliveryMethod: 'online'
      });
    }, /already been booked/);
  });

  test('Package Lifecycle & Ledger: Purchase, session deduction, and cancellation restoration', () => {
    // 1. Purchase Clarity Package (5 sessions)
    const pkg = packageService.purchasePackage({
      userId: client1.userId,
      serviceId: 'srv-clarity-package',
      pricePaidUsd: 475.00
    });

    assert.equal(pkg.total_sessions, 5);
    assert.equal(pkg.remaining_sessions, 5);
    assert.equal(pkg.status, 'active');

    // 2. Book appointment using package credit
    const slotTime = new Date(Date.now() + (1500 + Math.floor(Math.random() * 500)) * 3600 * 1000).toISOString();
    const appt = bookingService.createAppointment({
      userId: client1.userId,
      serviceId: 'srv-clarity-package',
      packageId: pkg.id,
      startTimeUtc: slotTime,
      durationMinutes: 50
    });

    assert.equal(appt.package_id, pkg.id);

    // Verify package balance decremented to 4 in database
    const db = getDb();
    const pkgAfter = db.prepare('SELECT * FROM packages WHERE id = ?').get(pkg.id);
    assert.equal(pkgAfter.remaining_sessions, 4);

    // Verify auditable ledger
    const ledger = db.prepare('SELECT * FROM package_ledger WHERE package_id = ? ORDER BY created_at ASC').all(pkg.id);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].action, 'initial_allocation');
    assert.equal(ledger[0].balance_after, 5);
    assert.equal(ledger[1].action, 'booking_deduction');
    assert.equal(ledger[1].delta, -1);
    assert.equal(ledger[1].balance_after, 4);

    // 3. Cancel appointment and verify package session credit restored
    bookingService.cancelAppointment(appt.id, client1.userId, 'client', 'Schedule conflict');

    const pkgRestored = db.prepare('SELECT * FROM packages WHERE id = ?').get(pkg.id);
    assert.equal(pkgRestored.remaining_sessions, 5, 'Session credit must be restored to 5');

    const ledgerAfter = db.prepare('SELECT * FROM package_ledger WHERE package_id = ? ORDER BY created_at DESC').get(pkg.id);
    assert.equal(ledgerAfter.action, 'cancellation_credit');
    assert.equal(ledgerAfter.delta, 1);
    assert.equal(ledgerAfter.balance_after, 5);
  });
});
