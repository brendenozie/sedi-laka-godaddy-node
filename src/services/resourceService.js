const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../db');
const config = require('../config');

// Generate signed short-lived download token (valid for 15 minutes)
function generateDownloadToken(resourceId, userId) {
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const payload = `${resourceId}:${userId}:${expiresAt}`;
  const signature = crypto.createHmac('sha256', config.SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ resourceId, userId, expiresAt, signature })).toString('base64url');
}

// Verify download token
function verifyDownloadToken(token) {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const { resourceId, userId, expiresAt, signature } = JSON.parse(raw);

    if (Date.now() > expiresAt) {
      return { valid: false, error: 'Download link has expired. Please generate a new link from your portal.' };
    }

    const payload = `${resourceId}:${userId}:${expiresAt}`;
    const expectedSig = crypto.createHmac('sha256', config.SESSION_SECRET).update(payload).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      return { valid: false, error: 'Invalid download signature.' };
    }

    return { valid: true, resourceId, userId };
  } catch {
    return { valid: false, error: 'Malformed download token.' };
  }
}

// Verify entitlement and get download link
function getResourceDownloadLink(resourceId, userId, role = 'client') {
  const db = getDb();
  const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId);
  if (!resource) throw new Error('Resource not found.');

  // Staff and admin have automatic entitlement
  if (role !== 'admin' && role !== 'staff' && !resource.is_free) {
    const purchase = db.prepare('SELECT id FROM resource_purchases WHERE resource_id = ? AND user_id = ?').get(resourceId, userId);
    if (!purchase) {
      throw new Error('You do not own this digital resource. Please purchase it first.');
    }
  }

  const token = generateDownloadToken(resourceId, userId);
  return {
    downloadUrl: `/api/resources/download?token=${token}`,
    resource
  };
}

// Track file download and serve path
function getFilePathForDownload(token) {
  const verification = verifyDownloadToken(token);
  if (!verification.valid) {
    throw new Error(verification.error);
  }

  const db = getDb();
  const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(verification.resourceId);
  if (!resource) {
    throw new Error('Resource file not found.');
  }

  // Record download count
  db.prepare(`
    UPDATE resource_purchases
    SET download_count = download_count + 1
    WHERE resource_id = ? AND user_id = ?
  `).run(resource.id, verification.userId);

  return {
    filePath: resource.file_path,
    filename: resource.file_filename,
    mimeType: resource.mime_type
  };
}

module.exports = {
  generateDownloadToken,
  verifyDownloadToken,
  getResourceDownloadLink,
  getFilePathForDownload
};
