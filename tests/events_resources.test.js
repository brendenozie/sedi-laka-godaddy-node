const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const eventService = require('../src/services/eventService');
const resourceService = require('../src/services/resourceService');
const authService = require('../src/services/authService');

describe('Category D: Events Capacity and Digital Resource Protection', () => {
  let user1 = null;
  let user2 = null;

  before(() => {
    getDb();
    seedDatabase();
    user1 = authService.registerUser({
      email: `client_evt1_${Date.now()}@example.com`,
      password: 'Password123!',
      fullName: 'Event Client One'
    });
    user2 = authService.registerUser({
      email: `client_evt2_${Date.now()}@example.com`,
      password: 'Password123!',
      fullName: 'Event Client Two'
    });
  });

  test('Event Registration: Confirms registration for Vision Board Brunch', () => {
    const res = eventService.registerForEvent({
      eventId: 'evt-vision-board-brunch',
      userId: user1.userId
    });

    assert.ok(res.registration.id);
    assert.equal(res.registration.event_id, 'evt-vision-board-brunch');
  });

  test('Duplicate Event Registration: Rejects duplicate attempt by same user', () => {
    assert.throws(() => {
      eventService.registerForEvent({
        eventId: 'evt-vision-board-brunch',
        userId: user1.userId
      });
    }, /already registered/);
  });

  test('Event Capacity Enforcement: Rejects registration when capacity is reached', () => {
    const db = getDb();
    // Clear test event registrations and set capacity to 1
    db.prepare("DELETE FROM event_registrations WHERE event_id = 'evt-quarterly-retreat'").run();
    db.prepare('UPDATE events SET capacity = 1 WHERE id = ?').run('evt-quarterly-retreat');

    // Register user1
    eventService.registerForEvent({
      eventId: 'evt-quarterly-retreat',
      userId: user1.userId
    });

    // Register user2 should exceed capacity
    assert.throws(() => {
      eventService.registerForEvent({
        eventId: 'evt-quarterly-retreat',
        userId: user2.userId
      });
    }, /maximum capacity/);

    // Restore capacity
    db.prepare('UPDATE events SET capacity = 25 WHERE id = ?').run('evt-quarterly-retreat');
  });

  test('Digital Resources: Generates valid HMAC-SHA256 signed download token for free guide', () => {
    const link = resourceService.getResourceDownloadLink('res-intentional-planner', user1.userId, 'client');
    assert.ok(link.downloadUrl.includes('token='));

    const token = link.downloadUrl.split('token=')[1];
    const file = resourceService.getFilePathForDownload(token);
    assert.ok(file.filePath);
    assert.equal(file.mimeType, 'application/pdf');
  });

  test('Digital Resources: Rejects unauthorized access to paid resource without purchase', () => {
    assert.throws(() => {
      resourceService.getResourceDownloadLink('res-grounding-audio', user1.userId, 'client');
    }, /do not own this digital resource/);
  });

  test('Digital Resources: Rejects tampered download token', () => {
    const fakeToken = Buffer.from(JSON.stringify({
      resourceId: 'res-intentional-planner',
      userId: user1.userId,
      expiresAt: Date.now() + 10000,
      signature: 'bad_signature_12345'
    })).toString('base64url');

    assert.throws(() => {
      resourceService.getFilePathForDownload(fakeToken);
    }, /Invalid download signature|Malformed download token/);
  });
});
