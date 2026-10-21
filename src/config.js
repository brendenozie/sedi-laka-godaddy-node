const path = require('path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '..');

module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATA_DIR: process.env.DATA_DIR || path.join(ROOT_DIR, 'data'),
  BACKUP_DIR: process.env.BACKUP_DIR || path.join(ROOT_DIR, 'backups'),
  RESOURCES_DIR: process.env.RESOURCES_DIR || path.join(ROOT_DIR, 'protected_resources'),
  SESSION_SECRET: process.env.SESSION_SECRET || 'sedi-laka-session-secret-change-in-prod-58b29f0e81c',
  SESSION_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  APP_NAME: 'Sedi Laka Center',
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  SUPPORT_EMAIL: 'sedilaka.org@gmail.com',
  DEFAULT_TIMEZONE: 'Africa/Nairobi',
  
  // Payment Providers Config
  PAYMENT_PROVIDER_DEFAULT: process.env.PAYMENT_PROVIDER_DEFAULT || 'mock_sandbox', // 'mpesa', 'card_stripe', 'mock_sandbox'
  MPESA_CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY || '',
  MPESA_CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET || '',
  MPESA_SHORTCODE: process.env.MPESA_SHORTCODE || '174379',
  MPESA_PASSKEY: process.env.MPESA_PASSKEY || '',
  MPESA_CALLBACK_URL: process.env.MPESA_CALLBACK_URL || '',
  
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  
  // Email Config
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  EMAIL_FROM: process.env.EMAIL_FROM || '"Sedi Laka Center" <sedilaka.org@gmail.com>',
  
  // Initial Admin Credentials (Configurable via env)
  INITIAL_ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@sedilaka.org',
  INITIAL_ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'SediLakaAdmin2026!'
};
