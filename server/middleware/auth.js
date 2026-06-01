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

// Gate for admin-only routes. Must run after requireAuth (which sets req.user).
// Operators get a clean 403 rather than leaking the resource.
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'forbidden' });
  }
  return next();
}

// Gate for a set of roles, e.g. requireRole('admin', 'owner'). Must run after
// requireAuth. Returns 403 for any role not in the allow-list.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this.', code: 'forbidden' });
    }
    return next();
  };
}

module.exports = { requireAuth, requireAdmin, requireRole };
