const crypto = require('crypto');
const { getDb } = require('../db');

function purchasePackage({ userId, serviceId, pricePaidUsd, validityMonths = 6 }) {
  const db = getDb();
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(serviceId);
  if (!service || service.type !== 'package') {
    throw new Error('Invalid package service selected.');
  }

  const packageId = crypto.randomUUID();
  const ledgerId = crypto.randomUUID();
  const now = new Date();
  const createdAtIso = now.toISOString();
  
  // Calculate expiry (e.g. 3 months for Integration, 6 months default)
  const expiryDate = new Date(now);
  expiryDate.setMonth(expiryDate.getMonth() + validityMonths);
  const expiresAtIso = expiryDate.toISOString();

  return db.transaction(() => {
    // 1. Create Package Record
    db.prepare(`
      INSERT INTO packages (
        id, user_id, service_id, name, total_sessions, remaining_sessions,
        price_paid_usd, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      packageId, userId, serviceId, service.name, service.session_count, service.session_count,
      pricePaidUsd, expiresAtIso, createdAtIso, createdAtIso
    );

    // 2. Insert initial allocation into auditable ledger
    db.prepare(`
      INSERT INTO package_ledger (
        id, package_id, appointment_id, delta, balance_after, action, reason, adjusted_by_user_id, created_at
      ) VALUES (?, ?, NULL, ?, ?, 'initial_allocation', 'Package purchased and sessions allocated', NULL, ?)
    `).run(ledgerId, packageId, service.session_count, service.session_count, createdAtIso);

    return db.prepare('SELECT * FROM packages WHERE id = ?').get(packageId);
  })();
}

function deductPackageSession(packageId, appointmentId, reason = 'Booked appointment') {
  const db = getDb();
  const now = new Date().toISOString();

  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(packageId);
  if (!pkg) {
    throw new Error('Package not found.');
  }
  if (pkg.status !== 'active') {
    throw new Error(`Package is not active (current status: ${pkg.status}).`);
  }
  if (pkg.remaining_sessions <= 0) {
    throw new Error('No remaining sessions in this package.');
  }

  const newBalance = pkg.remaining_sessions - 1;
  const newStatus = newBalance === 0 ? 'completed' : 'active';
  const ledgerId = crypto.randomUUID();

  // Deduct in transaction
  db.prepare(`
    UPDATE packages
    SET remaining_sessions = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(newBalance, newStatus, now, packageId);

  db.prepare(`
    INSERT INTO package_ledger (
      id, package_id, appointment_id, delta, balance_after, action, reason, created_at
    ) VALUES (?, ?, ?, -1, ?, 'booking_deduction', ?, ?)
  `).run(ledgerId, packageId, appointmentId, newBalance, reason, now);

  return newBalance;
}

function restorePackageSession(packageId, appointmentId, reason = 'Cancelled appointment') {
  const db = getDb();
  const now = new Date().toISOString();

  const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(packageId);
  if (!pkg) {
    throw new Error('Package not found.');
  }

  // Cap at total_sessions to prevent extra session generation
  const newBalance = Math.min(pkg.total_sessions, pkg.remaining_sessions + 1);
  const ledgerId = crypto.randomUUID();

  db.prepare(`
    UPDATE packages
    SET remaining_sessions = ?, status = 'active', updated_at = ?
    WHERE id = ?
  `).run(newBalance, now, packageId);

  db.prepare(`
    INSERT INTO package_ledger (
      id, package_id, appointment_id, delta, balance_after, action, reason, created_at
    ) VALUES (?, ?, ?, 1, ?, 'cancellation_credit', ?, ?)
  `).run(ledgerId, packageId, appointmentId, newBalance, reason, now);

  return newBalance;
}

function adjustPackageBalance(packageId, delta, reason, adminUserId) {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(() => {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ?').get(packageId);
    if (!pkg) throw new Error('Package not found.');

    const newBalance = Math.max(0, pkg.remaining_sessions + delta);
    const newStatus = newBalance === 0 ? 'completed' : 'active';
    const ledgerId = crypto.randomUUID();

    db.prepare(`
      UPDATE packages
      SET remaining_sessions = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(newBalance, newStatus, now, packageId);

    db.prepare(`
      INSERT INTO package_ledger (
        id, package_id, appointment_id, delta, balance_after, action, reason, adjusted_by_user_id, created_at
      ) VALUES (?, ?, NULL, ?, ?, 'manual_adjustment', ?, ?, ?)
    `).run(ledgerId, packageId, delta, newBalance, reason, adminUserId, now);

    return db.prepare('SELECT * FROM packages WHERE id = ?').get(packageId);
  })();
}

function getUserPackages(userId) {
  const db = getDb();
  const packages = db.prepare(`
    SELECT p.*, s.description as service_description
    FROM packages p
    JOIN services s ON p.service_id = s.id
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC
  `).all(userId);

  return packages.map(pkg => {
    const ledger = db.prepare(`
      SELECT * FROM package_ledger
      WHERE package_id = ?
      ORDER BY created_at DESC
    `).all(pkg.id);
    return { ...pkg, ledger };
  });
}

module.exports = {
  purchasePackage,
  deductPackageSession,
  restorePackageSession,
  adjustPackageBalance,
  getUserPackages
};
