const app = require('./src/app');
const config = require('./src/config');
const { getDb } = require('./src/db');
const { seedDatabase } = require('./src/db/seed');

// Initialize database schema and initial seeds
try {
  getDb();
  seedDatabase();
} catch (err) {
  console.error('[Startup Error] Failed to initialize database:', err);
  process.exit(1);
}

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`=======================================================`);
  console.log(`Sedi Laka Center server is active at:`);
  console.log(`http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`);
  console.log(`Environment: ${config.NODE_ENV}`);
  console.log(`=======================================================`);
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Closing HTTP server and SQLite database...`);
  server.close(() => {
    try {
      const db = getDb();
      if (db) db.close();
      console.log('Database connection closed cleanly.');
    } catch (err) {
      console.error('Error closing database:', err.message);
    }
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = server;
