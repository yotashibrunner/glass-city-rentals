'use strict';

// JWT auth guard for operator-only routes. Mounted on /api/operator/* in
// server/index.js. Expects an `Authorization: Bearer <accessToken>` header.
// On success, attaches the decoded user to req.user and calls next();
// otherwise responds 401 (no token / invalid token) — never throws to the
// global error handler so we don't leak token details.

const { verifyToken } = require('../services/auth');

function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  try {
    const payload = verifyToken(match[1], 'access');
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      name: payload.name,
    };
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Access token expired' : 'Invalid access token',
      code: expired ? 'token_expired' : 'token_invalid',
    });
  }
}

module.exports = { requireAuth };
