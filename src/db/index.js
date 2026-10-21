const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const { initializeSchema } = require('./schema');

// Ensure data and backup directories exist
if (!fs.existsSync(config.DATA_DIR)) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}
if (!fs.existsSync(config.BACKUP_DIR)) {
  fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
}
if (!fs.existsSync(config.RESOURCES_DIR)) {
  fs.mkdirSync(config.RESOURCES_DIR, { recursive: true });
}

const dbPath = path.join(config.DATA_DIR, 'sedi_laka.db');
let db = null;
let transactionDepth = 0;

function getDb() {
  if (!db) {
    db = new DatabaseSync(dbPath);
    
    // Add transaction helper method onto db instance with nested transaction support
    db.transaction = function (fn) {
      return function (...args) {
        if (transactionDepth > 0) {
          // Already within an outer transaction; execute directly in current transaction
          return fn(...args);
        }

        transactionDepth++;
        db.exec('BEGIN IMMEDIATE;');
        try {
          const result = fn(...args);
          db.exec('COMMIT;');
          transactionDepth--;
          return result;
        } catch (err) {
          transactionDepth--;
          try { db.exec('ROLLBACK;'); } catch (_) {}
          throw err;
        }
      };
    };

    initializeSchema(db);
  }
  return db;
}

function runTransaction(callback) {
  const database = getDb();
  return database.transaction(callback)();
}

module.exports = {
  getDb,
  runTransaction,
  dbPath
};
