const config = require('../config');

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || (err.message.includes('not found') ? 404 : 400);

  // Never leak internal stack traces or database errors in production
  const response = {
    error: err.message || 'An unexpected error occurred. Please try again.'
  };

  if (config.NODE_ENV !== 'production' && err.stack) {
    response.stack = err.stack;
  }

  console.error(`[Error] ${req.method} ${req.originalUrl}:`, err.message);
  res.status(statusCode).json(response);
}

module.exports = { errorHandler };
