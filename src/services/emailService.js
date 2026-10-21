const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { getDb } = require('../db');
const config = require('../config');

// Create transporter if SMTP credentials provided, otherwise use mock transport
let transporter = null;
if (config.SMTP_HOST && config.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: {
      user: config.SMTP_USER,
      pass: config.SMTP_PASS
    }
  });
}

function baseBrandedTemplate(title, preheader, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { margin:0; padding:0; background-color:#faf8f2; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:#20382f; line-height:1.6; }
    .container { max-width:600px; margin:40px auto; background:#ffffff; border:1px solid #d9dfd5; border-radius:4px; overflow:hidden; }
    .header { background:#123e32; padding:32px 40px; text-align:center; color:#faf8f2; }
    .header h1 { font-family:Georgia,serif; font-size:26px; font-weight:normal; margin:0 0 6px; color:#ffffff; }
    .header p { margin:0; font-size:13px; letter-spacing:0.15em; text-transform:uppercase; color:#d1a44b; }
    .content { padding:40px; }
    .content h2 { font-family:Georgia,serif; font-size:22px; color:#123e32; margin-top:0; font-weight:normal; }
    .content p { font-size:15px; margin:0 0 18px; color:#334d43; }
    .highlight-box { background:#f7f4eb; border-left:4px solid #b68b3a; padding:18px 22px; margin:24px 0; border-radius:2px; }
    .highlight-box p { margin:0 0 8px; font-size:14px; }
    .highlight-box p:last-child { margin:0; }
    .btn { display:inline-block; padding:12px 24px; background:#123e32; color:#ffffff !important; text-decoration:none; font-weight:bold; font-size:14px; border-radius:3px; margin:15px 0; }
    .footer { background:#f4f1ea; padding:24px 40px; text-align:center; font-size:12px; color:#6b8277; border-top:1px solid #e7ece1; }
    .footer a { color:#123e32; text-decoration:underline; }
  </style>
</head>
<body>
  <div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${preheader}
  </div>
  <div class="container">
    <div class="header">
      <h1>Sedi Laka Center</h1>
      <p>Awaken Your Light</p>
    </div>
    <div class="content">
      ${bodyHtml}
    </div>
    <div class="footer">
      <p>Sedi Laka Center · Trauma-informed care &amp; intentional growth · Nairobi, Kenya</p>
      <p>Questions? Contact us at <a href="mailto:${config.SUPPORT_EMAIL}">${config.SUPPORT_EMAIL}</a></p>
      <p style="margin-top:12px; font-size:11px;">Confidentiality Note: This notification is intended solely for the recipient. If you received this in error, please disregard.</p>
    </div>
  </div>
</body>
</html>`;
}

async function sendEmail({ to, subject, type, html, userId = null }) {
  const db = getDb();
  const notificationId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Check for duplicate sent email within last 5 minutes to prevent retry loops
  const existing = db.prepare(`
    SELECT id FROM notifications
    WHERE recipient_email = ? AND subject = ? AND type = ? AND created_at > datetime('now', '-5 minutes')
  `).get(to, subject, type);

  if (existing) {
    console.log(`[Email] Suppressing duplicate ${type} email to ${to}`);
    return existing.id;
  }

  let status = 'sent';
  let messageId = `sim-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  let errorMsg = null;

  try {
    if (transporter) {
      const info = await transporter.sendMail({
        from: config.EMAIL_FROM,
        to,
        subject,
        html
      });
      messageId = info.messageId;
    } else {
      // In development / test or when SMTP is unconfigured, log safely
      console.log(`[Email Mock Transport] To: ${to} | Subject: ${subject} | Type: ${type}`);
    }
  } catch (err) {
    console.error(`[Email Error] Failed to send email to ${to}:`, err.message);
    status = 'failed';
    errorMsg = err.message;
  }

  // Persist delivery log in notifications table
  db.prepare(`
    INSERT INTO notifications (id, user_id, recipient_email, subject, type, body_html, status, provider_message_id, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(notificationId, userId, to, subject, type, html, status, messageId, errorMsg, now);

  return notificationId;
}

// Notification Templates
async function sendVerificationEmail(user, token) {
  const verifyUrl = `${config.BASE_URL}/verify-email?token=${token}`;
  const html = baseBrandedTemplate(
    'Verify your Sedi Laka Center account',
    'Please verify your email address to complete registration.',
    `<h2>Welcome, ${user.fullName || 'there'}.</h2>
     <p>Thank you for creating an account with Sedi Laka Center. Please confirm your email address to access your client portal, view appointments, and manage your resources.</p>
     <div style="text-align:center; margin:30px 0;">
       <a href="${verifyUrl}" class="btn">Verify Email Address</a>
     </div>
     <p style="font-size:13px; color:#6b8277;">Or paste this link into your browser:<br><a href="${verifyUrl}">${verifyUrl}</a></p>
     <p>This verification link will expire in 24 hours.</p>`
  );

  return sendEmail({
    to: user.email,
    subject: 'Confirm your Sedi Laka Center account',
    type: 'account_verification',
    html,
    userId: user.id
  });
}

async function sendPasswordResetEmail(user, token) {
  const resetUrl = `${config.BASE_URL}/reset-password?token=${token}`;
  const html = baseBrandedTemplate(
    'Reset your password · Sedi Laka Center',
    'Follow this link to securely reset your password.',
    `<h2>Password Reset Request</h2>
     <p>We received a request to reset your password for your Sedi Laka Center account.</p>
     <div style="text-align:center; margin:30px 0;">
       <a href="${resetUrl}" class="btn">Reset My Password</a>
     </div>
     <p style="font-size:13px; color:#6b8277;">Or paste this link into your browser:<br><a href="${resetUrl}">${resetUrl}</a></p>
     <p>If you did not request this change, you can safely ignore this email. Your account remains secure.</p>`
  );

  return sendEmail({
    to: user.email,
    subject: 'Password reset request · Sedi Laka Center',
    type: 'password_reset',
    html,
    userId: user.id
  });
}

async function sendBookingConfirmationEmail(user, appointment, service) {
  const formattedDate = new Date(appointment.startTime).toLocaleString('en-US', {
    timeZone: appointment.clientTimezone || 'Africa/Nairobi',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const html = baseBrandedTemplate(
    'Appointment Confirmed · Sedi Laka Center',
    `Your session is confirmed for ${formattedDate}`,
    `<h2>Your Appointment is Confirmed</h2>
     <p>Dear ${user.fullName},</p>
     <p>We look forward to meeting with you. Your appointment details are outlined below:</p>
     <div class="highlight-box">
       <p><strong>Service:</strong> ${service.name}</p>
       <p><strong>Date &amp; Time:</strong> ${formattedDate} (${appointment.clientTimezone || 'EAT'})</p>
       <p><strong>Format:</strong> ${appointment.deliveryMethod === 'online' ? 'Online (Link available in portal)' : 'In-Person (Nairobi, Kenya)'}</p>
       <p><strong>Reference:</strong> ${appointment.referenceNumber}</p>
     </div>
     <p>You can review your appointment, access meeting links, or request a reschedule in your client portal.</p>
     <div style="text-align:center; margin:25px 0;">
       <a href="${config.BASE_URL}/portal" class="btn">View in Client Portal</a>
     </div>`
  );

  return sendEmail({
    to: user.email,
    subject: `Appointment Confirmed (${appointment.referenceNumber}) · Sedi Laka Center`,
    type: 'booking_confirmation',
    html,
    userId: user.id
  });
}

async function sendBookingCancellationEmail(user, appointment, service, reason) {
  const html = baseBrandedTemplate(
    'Appointment Cancellation Notice · Sedi Laka Center',
    `Your appointment (${appointment.referenceNumber}) has been cancelled.`,
    `<h2>Appointment Cancelled</h2>
     <p>Dear ${user.fullName},</p>
     <p>This email confirms that your appointment <strong>${appointment.referenceNumber}</strong> for <strong>${service.name}</strong> has been cancelled.</p>
     ${reason ? `<div class="highlight-box"><p><strong>Reason provided:</strong> ${reason}</p></div>` : ''}
     <p>If this was part of an active package, the session credit has been returned to your balance. You can book a new time whenever you are ready.</p>
     <div style="text-align:center; margin:25px 0;">
       <a href="${config.BASE_URL}/portal" class="btn">Go to Client Portal</a>
     </div>`
  );

  return sendEmail({
    to: user.email,
    subject: `Appointment Cancelled (${appointment.referenceNumber}) · Sedi Laka Center`,
    type: 'booking_cancellation',
    html,
    userId: user.id
  });
}

async function sendPaymentReceiptEmail(user, payment, itemDetails) {
  const html = baseBrandedTemplate(
    'Payment Receipt · Sedi Laka Center',
    `Receipt for payment ${payment.transactionReference}`,
    `<h2>Payment Receipt</h2>
     <p>Dear ${user.fullName},</p>
     <p>Thank you for your payment. Your transaction has been successfully processed.</p>
     <div class="highlight-box">
       <p><strong>Item:</strong> ${itemDetails.title}</p>
       <p><strong>Amount Paid:</strong> US$${Number(payment.amount).toFixed(2)}</p>
       <p><strong>Payment Method:</strong> ${payment.provider.toUpperCase()}</p>
       <p><strong>Transaction Ref:</strong> ${payment.transactionReference}</p>
       <p><strong>Date:</strong> ${new Date(payment.createdAt).toLocaleString()}</p>
     </div>
     <p>A full record of your payments and downloadable receipts is always available in your portal.</p>
     <div style="text-align:center; margin:25px 0;">
       <a href="${config.BASE_URL}/portal" class="btn">View Payment History</a>
     </div>`
  );

  return sendEmail({
    to: user.email,
    subject: `Payment Receipt: US$${Number(payment.amount).toFixed(2)} · Sedi Laka Center`,
    type: 'payment_receipt',
    html,
    userId: user.id
  });
}

async function sendEventRegistrationEmail(user, event) {
  const formattedDate = new Date(event.startTime).toLocaleString('en-US', {
    timeZone: event.timezone || 'Africa/Nairobi',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const html = baseBrandedTemplate(
    'Event Registration Confirmed · Sedi Laka Center',
    `You are registered for ${event.title}`,
    `<h2>You're Registered!</h2>
     <p>Dear ${user.fullName},</p>
     <p>Your registration for <strong>${event.title}</strong> is confirmed.</p>
     <div class="highlight-box">
       <p><strong>Event:</strong> ${event.title}</p>
       <p><strong>Date &amp; Time:</strong> ${formattedDate} (${event.timezone})</p>
       <p><strong>Venue:</strong> ${event.venue}</p>
       <p><strong>Format:</strong> ${event.deliveryMode.toUpperCase()}</p>
     </div>
     <p>We look forward to gathering with you. You can review your event registration details in your client portal.</p>
     <div style="text-align:center; margin:25px 0;">
       <a href="${config.BASE_URL}/portal" class="btn">View My Registrations</a>
     </div>`
  );

  return sendEmail({
    to: user.email,
    subject: `Registration Confirmed: ${event.title} · Sedi Laka Center`,
    type: 'event_registration',
    html,
    userId: user.id
  });
}

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendBookingConfirmationEmail,
  sendBookingCancellationEmail,
  sendPaymentReceiptEmail,
  sendEventRegistrationEmail
};
