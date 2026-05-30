'use strict';

// Minimal fixed-window, in-memory rate limiter. No external dependency.
// Good enough for a single-instance deployment (Railway runs one web process);
// if we ever scale horizontally this should move to Redis/Postgres.
//
// Plan §13: limit /api/auth/login to 5/min/IP and /api/quote to 30/min/IP.

function rateLimit({ windowMs, max, message }) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Opportunistic cleanup so the Map doesn't grow without bound.
  function sweep(now) {
    for (const [ip, rec] of hits) {
      if (rec.resetAt <= now) hits.delete(ip);
    }
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    if (hits.size > 10000) sweep(now);

    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    let rec = hits.get(ip);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(ip, rec);
    }
    rec.count += 1;

    const remaining = Math.max(0, max - rec.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));

    if (rec.count > max) {
      const retryAfter = Math.ceil((rec.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message || 'Too many requests, slow down.' });
    }
    return next();
  };
}

module.exports = { rateLimit };
