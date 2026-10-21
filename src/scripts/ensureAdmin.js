const crypto = require('crypto');
const { getDb } = require('../db');
const { hashPassword } = require('../services/authService');

function ensureAdminAccounts() {
  const db = getDb();
  const now = new Date().toISOString();

  const accounts = [
    {
      email: 'admin@sedilaka.org',
      password: 'SediLakaAdmin2026!',
      fullName: 'Sarah Kihuha (Admin)',
      phone: '+254700000000',
      role: 'admin'
    },
    {
      email: 'admin@sedilaka.com',
      password: 'AdminPassword2026!',
      fullName: 'Sedi Laka Administrator',
      phone: '+254711000000',
      role: 'admin'
    }
  ];

  for (const acc of accounts) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(acc.email.toLowerCase());
    const { hash, salt } = hashPassword(acc.password);
    if (!existing) {
      const id = crypto.randomUUID();
      db.prepare(`
        INSERT INTO users (
          id, email, password_hash, password_salt, full_name, phone, role,
          email_verified, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, acc.email.toLowerCase(), hash, salt, acc.fullName, acc.phone, acc.role, now, now);
      console.log(`[Admin] Created admin account: ${acc.email}`);
    } else {
      // Update password and ensure role is admin and email_verified is 1
      db.prepare(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, role = 'admin', email_verified = 1, updated_at = ?
        WHERE id = ?
      `).run(hash, salt, now, existing.id);
      console.log(`[Admin] Synchronized & updated admin account: ${acc.email}`);
    }
  }
}

if (require.main === module) {
  ensureAdminAccounts();
  console.log('Admin accounts verified successfully.');
}

module.exports = { ensureAdminAccounts };
