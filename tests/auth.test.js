const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { getDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const authService = require('../src/services/authService');

describe('Category A: Authentication & Role-Based Access Control', () => {
  before(() => {
    getDb();
    seedDatabase();
  });

  const testEmail = `client_${Date.now()}@example.com`;
  let testUserId = null;
  let testVerificationToken = null;
  let testSessionId = null;

  test('Registration: Creates new user with hashed password and verification token', () => {
    const res = authService.registerUser({
      email: testEmail,
      password: 'StrongPassword2026!',
      fullName: 'Amani Wanjiku',
      phone: '+254711223344'
    });

    assert.ok(res.userId, 'User ID should be generated');
    assert.equal(res.email, testEmail.toLowerCase());
    assert.equal(res.role, 'client');
    assert.ok(res.verificationToken, 'Verification token must be generated');

    testUserId = res.userId;
    testVerificationToken = res.verificationToken;
  });

  test('Registration: Rejects duplicate email registration', () => {
    assert.throws(() => {
      authService.registerUser({
        email: testEmail,
        password: 'AnotherPassword123!',
        fullName: 'Duplicate User'
      });
    }, /already exists/);
  });

  test('Email Verification: Successfully confirms email ownership', () => {
    const verifiedUser = authService.verifyEmailToken(testVerificationToken);
    assert.equal(verifiedUser.email_verified, 1);

    // Token should now be consumed
    assert.throws(() => {
      authService.verifyEmailToken(testVerificationToken);
    }, /Invalid or expired/);
  });

  test('Login: Rejects invalid password', () => {
    assert.throws(() => {
      authService.loginUser({
        email: testEmail,
        password: 'WrongPassword999!',
        ipAddress: '127.0.0.1'
      });
    }, /Invalid email or password/);
  });

  test('Login: Successfully signs in and issues persistent session', () => {
    const result = authService.loginUser({
      email: testEmail,
      password: 'StrongPassword2026!',
      ipAddress: '127.0.0.1',
      userAgent: 'TestBrowser'
    });

    assert.ok(result.sessionId, 'Session ID must be issued');
    assert.equal(result.user.email, testEmail.toLowerCase());
    testSessionId = result.sessionId;

    // Validate active session
    const validated = authService.validateSession(testSessionId);
    assert.ok(validated);
    assert.equal(validated.user.id, testUserId);
  });

  test('Session Revocation: Invalidate session logs user out', () => {
    authService.invalidateSession(testSessionId);
    const validated = authService.validateSession(testSessionId);
    assert.equal(validated, null, 'Session should be null after logout');
  });

  test('Password Recovery: Dispatches token and updates password safely', () => {
    const { token } = authService.requestPasswordReset(testEmail);
    assert.ok(token, 'Password reset token must be returned');

    const updatedUser = authService.resetPassword(token, 'NewSecurePassword2026!');
    assert.ok(updatedUser);

    // Can log in with new password
    const login = authService.loginUser({
      email: testEmail,
      password: 'NewSecurePassword2026!'
    });
    assert.ok(login.sessionId);
    authService.invalidateSession(login.sessionId);
  });

  test('Profile Management: Updates communication preferences and phone', () => {
    const updated = authService.updateProfile(testUserId, {
      fullName: 'Amani Wanjiku Updated',
      phone: '+254799887766',
      communicationPrefs: { emailReminders: true, smsReminders: true }
    });

    assert.equal(updated.full_name, 'Amani Wanjiku Updated');
    assert.equal(updated.phone, '+254799887766');
    assert.equal(updated.communication_prefs.smsReminders, true);
  });

  test('Data Portability: Exports comprehensive user data (GDPR/DPA)', () => {
    const data = authService.exportUserData(testUserId);
    assert.ok(data.user);
    assert.ok(Array.isArray(data.appointments));
    assert.ok(Array.isArray(data.packages));
    assert.ok(data.exportedAt);
  });
});
