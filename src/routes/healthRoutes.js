const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

router.get('/health', (req, res) => {
  const startTime = Date.now();
  let dbStatus = 'ok';
  let dbLatencyMs = 0;

  try {
    const db = getDb();
    const result = db.prepare('SELECT 1 as ping').get();
    if (!result || result.ping !== 1) {
      dbStatus = 'unhealthy';
    }
    dbLatencyMs = Date.now() - startTime;
  } catch (err) {
    dbStatus = 'error: ' + err.message;
  }

  const memoryUsage = process.memoryUsage();
  const healthy = dbStatus === 'ok';

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: {
      status: dbStatus,
      latencyMs: dbLatencyMs
    },
    memory: {
      heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      rssMb: Math.round(memoryUsage.rss / 1024 / 1024)
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

module.exports = router;
