const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// GET /api/services - public active services & packages catalog
router.get('/', (req, res) => {
  const db = getDb();
  const services = db.prepare('SELECT * FROM services WHERE is_active = 1 ORDER BY price_usd ASC').all();
  res.json({ services });
});

// GET /api/services/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const service = db.prepare('SELECT * FROM services WHERE id = ? OR slug = ?').get(req.params.id, req.params.id);
  if (!service) {
    return res.status(404).json({ error: 'Service not found.' });
  }
  res.json({ service });
});

module.exports = router;
