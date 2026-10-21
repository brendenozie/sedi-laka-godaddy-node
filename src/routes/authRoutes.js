const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailService');
const { requireAuth } = require('../middleware/auth');
const { rateLimiter } = require('../middleware/rateLimiter');
const config = require('../config');

const authLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 20, message: 'Too many login or registration attempts. Please wait 15 minutes.' });

// POST /api/auth/register
router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, password, fullName, phone } = req.body;
    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Email, password, and full name are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const result = authService.registerUser({ email, password, fullName, phone });

    // Send verification email asynchronously
    sendVerificationEmail({ id: result.userId, email: result.email, fullName: result.fullName }, result.verificationToken)
      .catch(e => console.error('[Email Error] Verification email failed:', e.message));

    // Auto login
    const loginResult = authService.loginUser({
      email,
      password,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.cookie('sedi_session', loginResult.sessionId, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: config.SESSION_MAX_AGE_MS
    });

    res.status(201).json({
      message: 'Account created successfully. A verification link has been sent to your email.',
      user: loginResult.user,
      sessionId: loginResult.sessionId
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const { sessionId, user } = authService.loginUser({
      email,
      password,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.cookie('sedi_session', sessionId, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: config.SESSION_MAX_AGE_MS
    });

    res.json({
      message: 'Signed in successfully.',
      user,
      sessionId
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const sessionId = req.cookies?.sedi_session || req.sessionId;
  if (sessionId) {
    authService.invalidateSession(sessionId);
  }
  res.clearCookie('sedi_session');
  res.json({ message: 'Signed out successfully.' });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ user: null });
  }
  res.json({ user: req.user });
});

// GET /api/auth/verify-email
router.get('/verify-email', (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token is required.' });
    const user = authService.verifyEmailToken(token);
    res.json({ message: 'Email verified successfully!', user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const result = authService.requestPasswordReset(email);
    if (result.token) {
      sendPasswordResetEmail({ id: '', email: result.email, fullName: result.fullName }, result.token)
        .catch(e => console.error('[Email Error] Password reset failed:', e.message));
    }

    res.json({ message: 'If an account exists with this email, a password reset link has been dispatched.' });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', authLimiter, (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    const user = authService.resetPassword(token, newPassword);
    res.json({ message: 'Password has been updated successfully. Please sign in with your new password.', user });
  } catch (err) {
    next(err);
  }
});

// PUT /api/auth/profile
router.put('/profile', requireAuth, (req, res, next) => {
  try {
    const { fullName, phone, communicationPrefs } = req.body;
    const user = authService.updateProfile(req.user.id, { fullName, phone, communicationPrefs });
    res.json({ message: 'Profile updated.', user });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/export-data
router.get('/export-data', requireAuth, (req, res, next) => {
  try {
    const data = authService.exportUserData(req.user.id);
    res.setHeader('Content-Disposition', 'attachment; filename="sedi_laka_my_data.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/auth/delete-account
router.delete('/delete-account', requireAuth, (req, res, next) => {
  try {
    authService.deleteUserAccount(req.user.id);
    res.clearCookie('sedi_session');
    res.json({ message: 'Your account has been deleted and anonymized.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
