const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');

const { authenticateUser } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const packageRoutes = require('./routes/packageRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const eventRoutes = require('./routes/eventRoutes');
const resourceRoutes = require('./routes/resourceRoutes');
const adminRoutes = require('./routes/adminRoutes');
const healthRoutes = require('./routes/healthRoutes');

const app = express();
const publicDir = path.join(__dirname, '..', 'public');

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", 'blob:'],
      frameSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());

// Webhooks need raw body for Stripe signature verification
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payments/webhook/stripe') {
    next();
  } else {
    express.json({ limit: '2mb' })(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Global session authentication extractor
app.use(authenticateUser);

// Health check endpoint
app.use(healthRoutes);

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/resources', resourceRoutes);
app.use('/api/admin', adminRoutes);

// Serve static assets from public/
app.use(express.static(publicDir, {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Client Portal & Admin routing fallback to appropriate HTML pages
app.get(/^\/portal/, (req, res) => {
  res.sendFile(path.join(publicDir, 'portal.html'));
});

app.get(/^\/admin/, (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.get(/^\/checkout/, (req, res) => {
  res.sendFile(path.join(publicDir, 'checkout.html'));
});

// Single-page brochure fallback
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(publicDir, 'index.html'));
  }
  next();
});

// Centralized error handler
app.use(errorHandler);

module.exports = app;
