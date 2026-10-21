const { validateSession } = require('../services/authService');

function authenticateUser(req, res, next) {
  // Check cookie or Authorization header
  let sessionId = req.cookies?.sedi_session;
  if (!sessionId && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      sessionId = parts[1];
    }
  }

  if (sessionId) {
    const sessionData = validateSession(sessionId);
    if (sessionData) {
      req.user = sessionData.user;
      req.sessionId = sessionData.sessionId;
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required. Please sign in.' });
  }
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient privileges.' });
    }
    next();
  };
}

module.exports = {
  authenticateUser,
  requireAuth,
  requireRole
};
