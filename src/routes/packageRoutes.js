const express = require('express');
const router = express.Router();
const packageService = require('../services/packageService');
const paymentService = require('../services/paymentService');
const { requireAuth } = require('../middleware/auth');

// GET /api/packages/my - client's packages and session balance ledger
router.get('/my', requireAuth, (req, res, next) => {
  try {
    const packages = packageService.getUserPackages(req.user.id);
    res.json({ packages });
  } catch (err) {
    next(err);
  }
});

// POST /api/packages/purchase - initiate purchase of Clarity or Integration Package
router.post('/purchase', requireAuth, (req, res, next) => {
  try {
    const { serviceId, provider = 'mock_sandbox', idempotencyKey } = req.body;
    if (!serviceId) {
      return res.status(400).json({ error: 'serviceId is required.' });
    }

    const payment = paymentService.initiatePayment({
      userId: req.user.id,
      itemType: 'package',
      itemId: serviceId,
      provider,
      idempotencyKey: idempotencyKey || null
    });

    res.status(201).json({
      message: 'Package purchase payment initiated.',
      payment
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
