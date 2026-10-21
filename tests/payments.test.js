const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { getDb } = require('../src/db');
const { seedDatabase } = require('../src/db/seed');
const paymentService = require('../src/services/paymentService');
const authService = require('../src/services/authService');

describe('Category C: Payment Gateway, Webhooks, and Idempotency', () => {
  let user = null;

  before(() => {
    getDb();
    seedDatabase();
    user = authService.registerUser({
      email: `client_pay_${Date.now()}@example.com`,
      password: 'Password123!',
      fullName: 'Payment Tester'
    });
  });

  test('Payment Initiation: Validates official price server-side (Clarity Package = $475)', () => {
    const payment = paymentService.initiatePayment({
      userId: user.userId,
      itemType: 'package',
      itemId: 'srv-clarity-package',
      provider: 'mock_sandbox'
    });

    assert.ok(payment.transaction_reference.startsWith('TX-'));
    assert.equal(payment.amount, 475.00, 'Server-side price must be enforced');
    assert.equal(payment.status, 'pending');
  });

  test('Idempotency: Re-submitting identical idempotency_key returns original transaction', () => {
    const key = `idemp_${Date.now()}`;
    const p1 = paymentService.initiatePayment({
      userId: user.userId,
      itemType: 'service_session',
      itemId: 'srv-exploration-session',
      idempotencyKey: key
    });

    const p2 = paymentService.initiatePayment({
      userId: user.userId,
      itemType: 'service_session',
      itemId: 'srv-exploration-session',
      idempotencyKey: key
    });

    assert.equal(p1.id, p2.id, 'Idempotent calls must return identical payment record');
  });

  test('Payment Verification: Successful fulfillment grants entitlements', () => {
    const payment = paymentService.initiatePayment({
      userId: user.userId,
      itemType: 'package',
      itemId: 'srv-clarity-package'
    });

    const completed = paymentService.completePayment(
      payment.transaction_reference,
      'prov_tx_12345',
      { status: 'COMPLETED' },
      true
    );

    assert.equal(completed.status, 'successful');

    // Verify package sessions allocated
    const db = getDb();
    const pkg = db.prepare('SELECT * FROM packages WHERE user_id = ? AND service_id = ?').get(user.userId, 'srv-clarity-package');
    assert.ok(pkg, 'Package must be created upon successful payment');
    assert.equal(pkg.remaining_sessions, 5);
  });

  test('Stripe Webhook Signature Verification: Validates HMAC-SHA256 signature correctly', () => {
    const secret = 'whsec_test_secret_123';
    const payload = JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signedPayload = `${timestamp}.${payload}`;
    const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    const header = `t=${timestamp},v1=${signature}`;

    const isValid = paymentService.verifyStripeWebhookSignature(payload, header, secret);
    assert.equal(isValid, true, 'Valid webhook signature must pass');

    // Tampered payload fails
    const isTampered = paymentService.verifyStripeWebhookSignature(payload + 'tamper', header, secret);
    assert.equal(isTampered, false, 'Tampered payload must be rejected');
  });

  test('Refund Workflow: Admin refund transitions status and logs audit entry', () => {
    const payment = paymentService.initiatePayment({
      userId: user.userId,
      itemType: 'service_session',
      itemId: 'srv-exploration-session'
    });
    paymentService.completePayment(payment.transaction_reference, 'tx_to_refund', {}, true);

    const refunded = paymentService.refundPayment(payment.id, 'Client requested refund', 'admin-id');
    assert.equal(refunded.status, 'refunded');

    const db = getDb();
    const audit = db.prepare("SELECT * FROM audit_logs WHERE action = 'refund_payment' AND resource_id = ?").get(payment.id);
    assert.ok(audit, 'Audit log must record refund');
  });
});
