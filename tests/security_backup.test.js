const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const { createBackup, listBackups, verifyRestore } = require('../src/services/backupService');
const bookingService = require('../src/services/bookingService');
const authService = require('../src/services/authService');

describe('Category E: Security, Integrity, and Disaster Recovery', () => {
  let client = null;
  let otherClient = null;

  before(() => {
    getDb();
    seedDatabase();
    client = authService.registerUser({
      email: `client_sec1_${Date.now()}@example.com`,
      password: 'Password123!',
      fullName: 'Security Client'
    });
    otherClient = authService.registerUser({
      email: `client_sec2_${Date.now()}@example.com`,
      password: 'Password123!',
      fullName: 'Other Client'
    });
  });

  test('IDOR Protection: Client cannot cancel another user appointment', () => {
    // Book appointment for client with a distinct future time
    const slotTime = new Date(Date.now() + (10000 + Math.floor(Math.random() * 50000)) * 3600 * 1000).toISOString();
    const appt = bookingService.createAppointment({
      userId: client.userId,
      serviceId: 'srv-exploration-session',
      startTimeUtc: slotTime,
      durationMinutes: 50
    });

    // otherClient attempts to cancel client appointment
    assert.throws(() => {
      bookingService.cancelAppointment(appt.id, otherClient.userId, 'client', 'Malicious cancellation');
    }, /Unauthorized/);
  });

  test('Database Backup: Generates atomic snapshot with verified integrity', async () => {
    const backup = await createBackup();
    assert.ok(backup.filename);
    assert.ok(backup.sizeBytes > 0);
    assert.equal(backup.integrityOk, true);

    const backups = listBackups();
    assert.ok(backups.length > 0);
    assert.ok(backups.some(b => b.filename === backup.filename));
  });

  test('Restoration Verification: Loads snapshot and validates record counts', async () => {
    const backups = listBackups();
    assert.ok(backups.length > 0);

    const result = verifyRestore(backups[0].filename);
    assert.equal(result.success, true);
    assert.ok(result.userCount > 0);
    assert.ok(result.serviceCount > 0);
    assert.ok(result.verifiedAt);
  });
});
