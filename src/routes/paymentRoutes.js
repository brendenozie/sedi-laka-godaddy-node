const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');
const { getDb } = require('../db');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');

// POST /api/payments/initiate
router.post('/initiate', requireAuth, (req, res, next) => {
  try {
    const { itemType, itemId, provider = 'mock_sandbox', idempotencyKey } = req.body;
    if (!itemType || !itemId) {
      return res.status(400).json({ error: 'itemType and itemId are required.' });
    }

    const payment = paymentService.initiatePayment({
      userId: req.user.id,
      itemType,
      itemId,
      provider,
      idempotencyKey: idempotencyKey || null
    });

    res.status(201).json({ payment });
  } catch (err) {
    next(err);
  }
});

// GET /api/payments/my - client payment transaction history
router.get('/my', requireAuth, (req, res) => {
  const db = getDb();
  const payments = db.prepare(`
    SELECT * FROM payments
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(req.user.id);

  res.json({ payments });
});

// GET /api/payments/:reference - Public order reference lookup for checkout
router.get('/:reference', (req, res) => {
  const db = getDb();
  const payment = db.prepare('SELECT * FROM payments WHERE transaction_reference = ?').get(req.params.reference);
  if (!payment) {
    return res.status(404).json({ error: 'Payment transaction not found.' });
  }
  // IDOR check: If user is authenticated as a client, ensure it matches their user_id
  if (req.user && req.user.role === 'client' && payment.user_id && payment.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized.' });
  }
  res.json({ payment });
});

// POST /api/payments/sandbox-checkout - used by client checkout flow & automated tests
router.post('/sandbox-checkout', (req, res, next) => {
  try {
    const { transactionReference, simulateSuccess = true } = req.body;
    if (!transactionReference) {
      return res.status(400).json({ error: 'transactionReference is required.' });
    }

    const db = getDb();
    const payment = db.prepare('SELECT * FROM payments WHERE transaction_reference = ?').get(transactionReference);
    if (!payment) {
      return res.status(404).json({ error: 'Payment transaction not found.' });
    }

    // IDOR check: If user is authenticated as a client, ensure it matches their user_id
    if (req.user && req.user.role === 'client' && payment.user_id && payment.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    const providerTxId = `mock_tx_${Date.now()}`;
    const updatedPayment = paymentService.completePayment(
      transactionReference,
      providerTxId,
      { simulator: 'Sedi Laka Sandbox Checkout', timestamp: new Date().toISOString() },
      simulateSuccess !== false
    );

    res.json({
      message: simulateSuccess ? 'Payment confirmed successfully!' : 'Payment was marked as failed.',
      payment: updatedPayment
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/payments/webhook/mpesa - Daraja STK Push Callback URL
router.post('/webhook/mpesa', (req, res) => {
  try {
    console.log('[M-Pesa Webhook Received]:', JSON.stringify(req.body));
    const result = paymentService.processMpesaCallback(req.body);
    res.json({ ResultCode: 0, ResultDesc: 'Callback processed successfully' });
  } catch (err) {
    console.error('[M-Pesa Webhook Error]:', err.message);
    res.status(400).json({ ResultCode: 1, ResultDesc: err.message });
  }
});

// POST /api/payments/webhook/stripe - Stripe Webhook Handler with Signature Check
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');

  // Verify signature if secret configured
  if (config.STRIPE_WEBHOOK_SECRET) {
    const isValid = paymentService.verifyStripeWebhookSignature(rawBody, sig, config.STRIPE_WEBHOOK_SECRET);
    if (!isValid) {
      return res.status(400).send('Webhook signature verification failed');
    }
  }

  try {
    const event = JSON.parse(rawBody);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const txRef = session.client_reference_id;
      if (txRef) {
        paymentService.completePayment(txRef, session.id, event, true);
      }
    }
    res.json({ received: true });
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

module.exports = router;
