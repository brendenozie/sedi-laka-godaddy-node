const fs = require('fs');
const express = require('express');
const router = express.Router();
const resourceService = require('../services/resourceService');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');

// GET /api/resources - catalog of digital resources
router.get('/', (req, res) => {
  const db = getDb();
  const resources = db.prepare('SELECT * FROM resources WHERE status = "published" ORDER BY created_at DESC').all();
  res.json({ resources });
});

// GET /api/resources/my/library - resources owned by client
router.get('/my/library', requireAuth, (req, res) => {
  const db = getDb();
  // All free published resources + purchased resources
  const ownedResources = db.prepare(`
    SELECT r.*, rp.download_count, rp.created_at as acquired_at
    FROM resources r
    LEFT JOIN resource_purchases rp ON r.id = rp.resource_id AND rp.user_id = ?
    WHERE r.status = 'published' AND (r.is_free = 1 OR rp.id IS NOT NULL)
    ORDER BY r.created_at DESC
  `).all(req.user.id);

  res.json({ library: ownedResources });
});

// POST /api/resources/:id/request-download - generates signed download link
router.post('/:id/request-download', requireAuth, (req, res, next) => {
  try {
    const result = resourceService.getResourceDownloadLink(req.params.id, req.user.id, req.user.role);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/resources/download?token=... - secure file download
router.get('/download', (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Download token is required.');

    const fileInfo = resourceService.getFilePathForDownload(token);
    if (!fs.existsSync(fileInfo.filePath)) {
      return res.status(404).send('Resource file is unavailable on server storage.');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${fileInfo.filename}"`);
    res.setHeader('Content-Type', fileInfo.mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    fs.createReadStream(fileInfo.filePath).pipe(res);
  } catch (err) {
    res.status(403).send(err.message);
  }
});

module.exports = router;
