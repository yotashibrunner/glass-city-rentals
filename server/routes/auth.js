'use strict';

// Auth endpoints (no JWT required to reach these):
//   POST /api/auth/login    email + password -> { accessToken, refreshToken }
//   POST /api/auth/refresh  refreshToken     -> { accessToken, refreshToken }
//
// Mounted at /api/auth in server/index.js.

const express = require('express');
const db = require('../db');
const { verifyPassword, issueTokens, verifyToken } = require('../services/auth');
const { rateLimit } = require('../middleware/rate-limit');

const router = express.Router();

// Plan §13: 5 login attempts per minute per IP.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: 'Too many login attempts. Try again in a minute.',
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { rows } = await db.query(
      'SELECT id, email, name, role, password_hash FROM admin_users WHERE email = $1',
      [email]
    );
    const user = rows[0];

    // Always run a bcrypt comparison (even on unknown email) to avoid leaking
    // which emails exist via response timing. Use a throwaway hash if needed.
    const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await verifyPassword(password, hash);

    if (!user || !ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await db.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const tokens = issueTokens(user);
    return res.json({
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/auth/refresh
// Accepts a valid refresh token and issues a fresh token pair (rotation).
router.post('/refresh', async (req, res, next) => {
  try {
    const token = String(req.body.refreshToken || '');
    if (!token) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    let payload;
    try {
      payload = verifyToken(token, 'refresh');
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Confirm the user still exists (could have been deleted/deactivated since
    // the refresh token was issued).
    const { rows } = await db.query(
      'SELECT id, email, name, role FROM admin_users WHERE id = $1',
      [payload.sub]
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists' });
    }

    const tokens = issueTokens(user);
    return res.json({
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
