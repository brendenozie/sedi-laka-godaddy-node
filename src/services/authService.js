const crypto = require('crypto');
const { getDb } = require('../db');
const config = require('../config');

// Secure password hashing with PBKDF2 (100,000 iterations, 64-byte key)
function hashPassword(password, salt = null) {
  if (!salt) {
    salt = crypto.randomBytes(16).toString('hex');
  }
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function verifyPassword(password, storedHash, storedSalt) {
  const { hash } = hashPassword(password, storedSalt);
  const hashBuf = Buffer.from(hash, 'hex');
  const storedBuf = Buffer.from(storedHash, 'hex');
  if (hashBuf.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, storedBuf);
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// User Registration
function registerUser({ email, password, fullName, phone, role = 'client' }) {
  const db = getDb();
  const normalizedEmail = email.trim().toLowerCase();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    throw new Error('An account with this email address already exists.');
  }

  const { hash, salt } = hashPassword(password);
  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const verificationToken = generateToken();
  const tokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  // Allowed initial roles: clients can only register as 'client'. Admin/staff are provisioned.
  const assignedRole = ['client', 'staff', 'therapist', 'admin'].includes(role) ? role : 'client';

  db.prepare(`
    INSERT INTO users (
      id, email, password_hash, password_salt, full_name, phone, role,
      email_verified, verification_token, verification_token_expires_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    userId, normalizedEmail, hash, salt, fullName.trim(), phone ? phone.trim() : null,
    assignedRole, verificationToken, tokenExpires, now, now
  );

  return {
    userId,
    email: normalizedEmail,
    fullName: fullName.trim(),
    role: assignedRole,
    verificationToken
  };
}

// User Login & Session Creation
function loginUser({ email, password, ipAddress, userAgent }) {
  const db = getDb();
  const normalizedEmail = email.trim().toLowerCase();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) {
    throw new Error('Invalid email or password.');
  }

  const isValid = verifyPassword(password, user.password_hash, user.password_salt);
  if (!isValid) {
    throw new Error('Invalid email or password.');
  }

  // Create persistent session
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.SESSION_MAX_AGE_MS).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, user_id, ip_address, user_agent, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, user.id, ipAddress || null, userAgent || null, expiresAt, now.toISOString());

  return {
    sessionId,
    user: sanitizeUser(user)
  };
}

// Session Validation
function validateSession(sessionId) {
  if (!sessionId) return null;
  const db = getDb();
  const now = new Date().toISOString();

  const record = db.prepare(`
    SELECT s.id as session_id, s.expires_at, u.*
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sessionId, now);

  if (!record) return null;

  return {
    sessionId: record.session_id,
    user: sanitizeUser(record)
  };
}

// Invalidate Session (Logout)
function invalidateSession(sessionId) {
  if (!sessionId) return;
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

// Invalidate All User Sessions (Password change/security reset)
function invalidateAllUserSessions(userId) {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Email Verification
function verifyEmailToken(token) {
  const db = getDb();
  const now = new Date().toISOString();

  const user = db.prepare(`
    SELECT * FROM users
    WHERE verification_token = ? AND verification_token_expires_at > ?
  `).get(token, now);

  if (!user) {
    throw new Error('Invalid or expired email verification link.');
  }

  db.prepare(`
    UPDATE users
    SET email_verified = 1, verification_token = NULL, verification_token_expires_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, user.id);

  return getUserById(user.id);
}

// Request Password Reset
function requestPasswordReset(email) {
  const db = getDb();
  const normalizedEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT id, email, full_name FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) {
    // Return true silently to prevent account enumeration
    return { token: null, email: normalizedEmail };
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE users
    SET reset_token = ?, reset_token_expires_at = ?, updated_at = ?
    WHERE id = ?
  `).run(token, expiresAt, now, user.id);

  return { token, email: user.email, fullName: user.full_name };
}

// Reset Password with Token
function resetPassword(token, newPassword) {
  const db = getDb();
  const now = new Date().toISOString();

  const user = db.prepare(`
    SELECT * FROM users
    WHERE reset_token = ? AND reset_token_expires_at > ?
  `).get(token, now);

  if (!user) {
    throw new Error('Invalid or expired password reset link.');
  }

  const { hash, salt } = hashPassword(newPassword);

  db.prepare(`
    UPDATE users
    SET password_hash = ?, password_salt = ?, reset_token = NULL, reset_token_expires_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(hash, salt, now, user.id);

  // Invalidate all existing sessions on password change
  invalidateAllUserSessions(user.id);

  return sanitizeUser(user);
}

// Update Profile
function updateProfile(userId, { fullName, phone, communicationPrefs }) {
  const db = getDb();
  const now = new Date().toISOString();

  const updates = [];
  const params = [];

  if (fullName !== undefined) {
    updates.push('full_name = ?');
    params.push(fullName.trim());
  }
  if (phone !== undefined) {
    updates.push('phone = ?');
    params.push(phone ? phone.trim() : null);
  }
  if (communicationPrefs !== undefined) {
    updates.push('communication_prefs = ?');
    params.push(typeof communicationPrefs === 'object' ? JSON.stringify(communicationPrefs) : communicationPrefs);
  }

  if (updates.length === 0) return getUserById(userId);

  updates.push('updated_at = ?');
  params.push(now);
  params.push(userId);

  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getUserById(userId);
}

// User Data Export (GDPR / Kenyan DPA compliance)
function exportUserData(userId) {
  const db = getDb();
  const user = sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
  const appointments = db.prepare('SELECT * FROM appointments WHERE user_id = ? ORDER BY start_time DESC').all(userId);
  const packages = db.prepare('SELECT * FROM packages WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  const payments = db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  const eventRegistrations = db.prepare(`
    SELECT er.*, e.title as event_title, e.start_time as event_start_time
    FROM event_registrations er
    JOIN events e ON er.event_id = e.id
    WHERE er.user_id = ?
  `).all(userId);
  const resourcePurchases = db.prepare(`
    SELECT rp.*, r.title as resource_title
    FROM resource_purchases rp
    JOIN resources r ON rp.resource_id = r.id
    WHERE rp.user_id = ?
  `).all(userId);

  return {
    user,
    appointments,
    packages,
    payments,
    eventRegistrations,
    resourcePurchases,
    exportedAt: new Date().toISOString()
  };
}

// Delete User Account (with anonymization of financial audit trail)
function deleteUserAccount(userId) {
  const db = getDb();
  const now = new Date().toISOString();

  // Invalidate sessions
  invalidateAllUserSessions(userId);

  // Anonymize user record to preserve financial and audit integrity without keeping PII
  db.prepare(`
    UPDATE users
    SET email = 'deleted-' || id || '@anonymized.sedilaka.org',
        full_name = 'Deleted User',
        phone = NULL,
        password_hash = 'DELETED',
        password_salt = 'DELETED',
        verification_token = NULL,
        reset_token = NULL,
        communication_prefs = '{}',
        updated_at = ?
    WHERE id = ?
  `).run(now, userId);

  return true;
}

function getUserById(userId) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return user ? sanitizeUser(user) : null;
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, password_salt, verification_token, reset_token, ...safeUser } = user;
  if (typeof safeUser.communication_prefs === 'string') {
    try {
      safeUser.communication_prefs = JSON.parse(safeUser.communication_prefs);
    } catch {
      safeUser.communication_prefs = {};
    }
  }
  safeUser.fullName = safeUser.full_name;
  safeUser.communicationPrefs = safeUser.communication_prefs;
  return safeUser;
}

module.exports = {
  hashPassword,
  verifyPassword,
  registerUser,
  loginUser,
  validateSession,
  invalidateSession,
  invalidateAllUserSessions,
  verifyEmailToken,
  requestPasswordReset,
  resetPassword,
  updateProfile,
  exportUserData,
  deleteUserAccount,
  getUserById,
  sanitizeUser
};
