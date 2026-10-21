const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getDb } = require('../db');
const config = require('../config');

// Create a safe, atomic online backup using SQLite's native VACUUM INTO command
async function createBackup() {
  const db = getDb();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `sedi_laka_backup_${timestamp}.db`;
  const backupFilePath = path.join(config.BACKUP_DIR, backupFileName);

  if (!fs.existsSync(config.BACKUP_DIR)) {
    fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
  }

  // SQLite VACUUM INTO creates an atomic online snapshot
  // Escape backslashes for Windows paths in SQL
  const safePath = backupFilePath.replace(/\\/g, '/');
  db.exec(`VACUUM INTO '${safePath}';`);

  // Verify backup integrity
  const backupDb = new DatabaseSync(backupFilePath);
  const rows = backupDb.prepare('PRAGMA integrity_check;').all();
  backupDb.close();

  const isHealthy = Array.isArray(rows) && rows[0]?.integrity_check === 'ok';
  if (!isHealthy) {
    throw new Error('Database backup failed integrity check.');
  }

  // Prune old backups, keeping most recent 10
  pruneBackups(10);

  const stats = fs.statSync(backupFilePath);
  return {
    filename: backupFileName,
    filePath: backupFilePath,
    sizeBytes: stats.size,
    createdAt: timestamp,
    integrityOk: true
  };
}

function listBackups() {
  if (!fs.existsSync(config.BACKUP_DIR)) return [];
  const files = fs.readdirSync(config.BACKUP_DIR).filter(f => f.endsWith('.db'));
  return files.map(file => {
    const fullPath = path.join(config.BACKUP_DIR, file);
    const stats = fs.statSync(fullPath);
    return {
      filename: file,
      sizeBytes: stats.size,
      createdAt: stats.mtime.toISOString()
    };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneBackups(maxToKeep = 10) {
  const backups = listBackups();
  if (backups.length > maxToKeep) {
    const toDelete = backups.slice(maxToKeep);
    for (const b of toDelete) {
      try {
        fs.unlinkSync(path.join(config.BACKUP_DIR, b.filename));
      } catch (err) {
        console.error('Failed to delete old backup:', err.message);
      }
    }
  }
}

// Restoration test: verifies that a backup file can be loaded, passes schema checks, and reads critical tables
function verifyRestore(backupFileName) {
  const backupFilePath = path.join(config.BACKUP_DIR, backupFileName);
  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`Backup file not found: ${backupFileName}`);
  }

  const testDb = new DatabaseSync(backupFilePath, { readOnly: true });
  try {
    const rows = testDb.prepare('PRAGMA integrity_check;').all();
    if (!rows || rows[0]?.integrity_check !== 'ok') {
      return { success: false, error: 'Failed PRAGMA integrity_check' };
    }

    const userCount = testDb.prepare('SELECT count(*) as count FROM users;').get().count;
    const serviceCount = testDb.prepare('SELECT count(*) as count FROM services;').get().count;
    const apptCount = testDb.prepare('SELECT count(*) as count FROM appointments;').get().count;

    return {
      success: true,
      userCount,
      serviceCount,
      appointmentCount: apptCount,
      verifiedAt: new Date().toISOString()
    };
  } finally {
    testDb.close();
  }
}

module.exports = {
  createBackup,
  listBackups,
  verifyRestore
};
