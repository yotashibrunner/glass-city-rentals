'use strict';

// Operator API. Every route here is behind requireAuth (mounted in
// server/index.js as app.use('/api/operator', requireAuth, router)), so
// req.user is always present.
//
// Phase 2 ships only the minimum the PWA needs to prove auth works:
//   GET /api/operator/me         the logged-in operator
//   GET /api/operator/dashboard  empty placeholder (real data in Phase 6)
// Inventory, bookings, calendar, etc. land in later phases.

const express = require('express');

const router = express.Router();

// GET /api/operator/me — echo back the authenticated operator.
router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

// GET /api/operator/dashboard — empty shell for Phase 2.
// Phase 6 fills pickups/returns/active from the bookings table.
router.get('/dashboard', (req, res) => {
  res.json({
    user: req.user,
    pickups: [],
    returns: [],
    active: [],
    message: 'Dashboard is empty — booking management arrives in a later phase.',
  });
});

module.exports = router;
