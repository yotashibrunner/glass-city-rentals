'use strict';

// Server-rendered customer booking pages.
//   GET /fleet/:slug      trailer detail + availability calendar + live quote
//   GET /book/dumpster    dedicated 25-yard roll-off flow
// Both render EJS and hydrate their client widgets from a JSON blob in the page.

const express = require('express');
const trailerSvc = require('../services/trailer');
const { formatCents } = require('../utils/money');
const { DEFAULT_TAX_RATE, getTaxRate } = require('../services/settings');

const router = express.Router();

router.get('/fleet/:slug', async (req, res, next) => {
  try {
    const trailer = await trailerSvc.getTrailerBySlug(req.params.slug);
    if (!trailer) return next(); // fall through to 404

    // Dumpsters have their own flow.
    if (trailer.type === 'dumpster') return res.redirect('/book/dumpster');

    const taxRate = await getTaxRate();
    res.render('fleet-detail', {
      trailer,
      taxRate,
      fmt: formatCents,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/book/dumpster', async (req, res, next) => {
  try {
    const dumpster = await trailerSvc.getDumpster();
    if (!dumpster) return next();

    const taxRate = await getTaxRate();
    res.render('book-dumpster', {
      trailer: dumpster,
      taxRate,
      fmt: formatCents,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.DEFAULT_TAX_RATE = DEFAULT_TAX_RATE;
