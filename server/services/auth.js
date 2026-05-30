'use strict';

// Operator authentication: password hashing + JWT issuance/verification.
// Used by routes/auth.js (login, refresh) and middleware/auth.js (verify).

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');

// --- Passwords -------------------------------------------------------------

function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptRounds);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// --- Tokens ----------------------------------------------------------------
// Two token types signed with the same secret, distinguished by `type`:
//   access  — short-lived (15m), carries identity for /api/operator/* calls
//   refresh — long-lived (30d), only accepted by /api/auth/refresh
// Keeping them separate means a leaked access token can't be used to mint
// new tokens, and a refresh token can't be used to call the API directly.

function signAccessToken(user) {
  return jwt.sign(
    { type: 'access', email: user.email, role: user.role, name: user.name || null },
    config.jwtSecret,
    { subject: String(user.id), expiresIn: config.accessTokenTtl }
  );
}

function signRefreshToken(user) {
  return jwt.sign({ type: 'refresh' }, config.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.refreshTokenTtl,
  });
}

function issueTokens(user) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    tokenType: 'Bearer',
  };
}

// Verifies a token and asserts it is of the expected type. Throws on any
// invalid/expired token or type mismatch (jwt throws; callers translate to 401).
function verifyToken(token, expectedType) {
  const payload = jwt.verify(token, config.jwtSecret);
  if (expectedType && payload.type !== expectedType) {
    const err = new Error(`Expected ${expectedType} token`);
    err.name = 'JsonWebTokenError';
    throw err;
  }
  return payload;
}

module.exports = {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  issueTokens,
  verifyToken,
};
