const crypto = require('crypto');
const { getDb } = require('../db');
const config = require('../config');
const { purchasePackage } = require('./packageService');
const { sendPaymentReceiptEmail } = require('./emailService');

function generateTransactionReference() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `TX-${dateStr}-${rand}`;
}

// Initiate Payment
function initiatePayment({
  userId,
  itemType,
  itemId,
  provider = 'mock_sandbox', // 'mpesa', 'card_stripe', 'mock_sandbox'
  metadata = {},
  idempotencyKey = null
}) {
  const db = getDb();
  const now = new Date().toISOString();

  // If idempotencyKey provided, check if transaction already exists
  if (idempotencyKey) {
    const existing = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      return existing;
    }
  }

  // Determine official server-side price (NEVER trust client price)
  let expectedAmount = 0;
  let itemTitle = '';

  if (itemType === 'service_session' || itemType === 'package') {
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(itemId);
    if (!service) throw new Error('Service not found.');
    expectedAmount = service.price_usd;
    itemTitle = service.name;
  } else if (itemType === 'event') {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(itemId);
    if (!event) throw new Error('Event not found.');
    expectedAmount = event.price_usd;
    itemTitle = event.title;
  } else if (itemType === 'resource') {
    const resource = db.prepare('SELECT * FROM resources WHERE id = ?').get(itemId);
    if (!resource) throw new Error('Resource not found.');
    expectedAmount = resource.price_usd;
    itemTitle = resource.title;
  } else {
    throw new Error('Invalid item type for payment.');
  }

  const paymentId = crypto.randomUUID();
  const txRef = generateTransactionReference();

  db.prepare(`
    INSERT INTO payments (
      id, transaction_reference, provider, provider_tx_id, user_id,
      amount, currency, status, item_type, item_id,
      metadata_json, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'USD', 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    paymentId, txRef, provider, userId,
    expectedAmount, itemType, itemId,
    JSON.stringify({ ...metadata, itemTitle }), idempotencyKey, now, now
  );

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);

  // If using mock_sandbox, we can also return mock client checkout details
  return {
    ...payment,
    checkoutUrl: `${config.BASE_URL}/checkout?ref=${txRef}`,
    instructions: provider === 'mpesa'
      ? 'An STK push will be sent to your phone number once initiated.'
      : 'Complete payment via secure portal.'
  };
}

// Process Payment Completion (Triggered by Webhook or Mock Sandbox Checkout)
function completePayment(txRef, providerTxId, providerResponse = {}, isSuccess = true) {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE transaction_reference = ?').get(txRef);
    if (!payment) {
      throw new Error(`Payment transaction not found: ${txRef}`);
    }

    // Idempotency: If already successful, do not double-fulfill
    if (payment.status === 'successful') {
      console.log(`[Payment] Transaction ${txRef} already processed successfully. Skipping.`);
      return payment;
    }

    const newStatus = isSuccess ? 'successful' : 'failed';

    db.prepare(`
      UPDATE payments
      SET status = ?, provider_tx_id = ?, provider_response_json = ?, updated_at = ?
      WHERE id = ?
    `).run(newStatus, providerTxId, JSON.stringify(providerResponse), now, payment.id);

    const updatedPayment = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);

    // If payment failed, stop here
    if (!isSuccess) {
      return updatedPayment;
    }

    // Fulfill purchased item
    let metadata = {};
    try {
      metadata = JSON.parse(payment.metadata_json || '{}');
    } catch {
      metadata = {};
    }

    if (payment.item_type === 'package') {
      // Allocate package sessions
      purchasePackage({
        userId: payment.user_id,
        serviceId: payment.item_id,
        pricePaidUsd: payment.amount
      });
    } else if (payment.item_type === 'event') {
      // Mark event registration confirmed
      db.prepare(`
        UPDATE event_registrations
        SET status = 'confirmed', payment_id = ?
        WHERE event_id = ? AND user_id = ?
      `).run(payment.id, payment.item_id, payment.user_id);
    } else if (payment.item_type === 'resource') {
      // Grant resource purchase entitlement
      db.prepare(`
        INSERT INTO resource_purchases (id, resource_id, user_id, payment_id, download_count, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
      `).run(crypto.randomUUID(), payment.item_id, payment.user_id, payment.id, now);
    }

    // Send receipt email
    const user = db.prepare('SELECT id, email, full_name FROM users WHERE id = ?').get(payment.user_id);
    if (user) {
      sendPaymentReceiptEmail(
        { id: user.id, email: user.email, fullName: user.full_name },
        { transactionReference: txRef, amount: payment.amount, provider: payment.provider, createdAt: now },
        { title: metadata.itemTitle || payment.item_type }
      ).catch(e => console.error('[Email Error] Receipt failed:', e.message));
    }

    return updatedPayment;
  })();
}

// Refund Payment (Admin operation)
function refundPayment(paymentId, reason, adminUserId) {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(() => {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) throw new Error('Payment not found.');
    if (payment.status !== 'successful') {
      throw new Error(`Cannot refund payment in status: ${payment.status}`);
    }

    db.prepare(`
      UPDATE payments
      SET status = 'refunded', updated_at = ?
      WHERE id = ?
    `).run(now, paymentId);

    // Record audit log
    db.prepare(`
      INSERT INTO audit_logs (id, user_id, role, action, resource_type, resource_id, details_json, created_at)
      VALUES (?, ?, 'admin', 'refund_payment', 'payment', ?, ?, ?)
    `).run(
      crypto.randomUUID(), adminUserId, paymentId,
      JSON.stringify({ amount: payment.amount, reason }), now
    );

    return db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  })();
}

// Webhook signature validator (Stripe standard HMAC SHA-256)
function verifyStripeWebhookSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  try {
    const parts = signatureHeader.split(',');
    const timestampPart = parts.find(p => p.startsWith('t='));
    const sigPart = parts.find(p => p.startsWith('v1='));
    if (!timestampPart || !sigPart) return false;

    const timestamp = timestampPart.split('=')[1];
    const signature = sigPart.split('=')[1];

    const signedPayload = `${timestamp}.${payload}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'));
  } catch {
    return false;
  }
}

// M-Pesa STK Callback processor
function processMpesaCallback(callbackBody) {
  const callbackData = callbackBody?.Body?.stkCallback;
  if (!callbackData) throw new Error('Invalid M-Pesa callback payload.');

  const resultCode = callbackData.ResultCode;
  const merchantRequestId = callbackData.MerchantRequestID;
  const checkoutRequestId = callbackData.CheckoutRequestID;
  const isSuccess = resultCode === 0;

  // Find transaction by metadata merchantRequestId or checkoutRequestId
  const db = getDb();
  const payments = db.prepare("SELECT * FROM payments WHERE provider = 'mpesa' AND status = 'pending'").all();
  const target = payments.find(p => {
    try {
      const meta = JSON.parse(p.metadata_json || '{}');
      return meta.checkoutRequestId === checkoutRequestId || meta.merchantRequestId === merchantRequestId;
    } catch {
      return false;
    }
  });

  if (!target) {
    console.warn(`[M-Pesa Webhook] No matching pending payment for CheckoutRequestID: ${checkoutRequestId}`);
    return null;
  }

  return completePayment(target.transaction_reference, checkoutRequestId, callbackData, isSuccess);
}

module.exports = {
  initiatePayment,
  completePayment,
  refundPayment,
  verifyStripeWebhookSignature,
  processMpesaCallback
};
