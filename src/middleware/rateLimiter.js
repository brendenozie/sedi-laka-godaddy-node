// In-memory rate limiter per IP address
function rateLimiter({ windowMs = 60 * 1000, maxRequests = 30, message = 'Too many requests, please try again later.' }) {
  const requests = new Map();

  // Periodically clean up old buckets
  setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of requests.entries()) {
      if (now - data.startTime > windowMs) {
        requests.delete(ip);
      }
    }
  }, windowMs);

  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    const now = Date.now();

    let record = requests.get(ip);
    if (!record || (now - record.startTime > windowMs)) {
      record = { startTime: now, count: 1 };
      requests.set(ip, record);
    } else {
      record.count += 1;
    }

    if (record.count > maxRequests) {
      res.setHeader('Retry-After', Math.ceil((record.startTime + windowMs - now) / 1000));
      return res.status(429).json({ error: message });
    }

    next();
  };
}

module.exports = { rateLimiter };
