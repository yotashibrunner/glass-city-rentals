'use strict';

// Server-rendered customer booking pages.
//   GET /fleet/:slug          trailer detail + availability calendar + live quote
//   GET /book/dumpster        dedicated 25-yard roll-off flow
//   GET /book/new             booking form (name/email/phone/notes) for a selection
//   GET /book/:id/contract    rental agreement + e-signature
//   GET /book/:ref            confirmation page
//   GET /book/:ref/calendar.ics   add-to-calendar file
// Literal /book paths are declared before /book/:ref so they aren't shadowed.

const express = require('express');
const trailerSvc = require('../services/trailer');
const bookingSvc = require('../services/booking');
const { computeQuote, DELIVERY_FEE_CENTS } = require('../services/pricing');
const { formatCents } = require('../utils/money');
const { getTaxRate } = require('../services/settings');

const router = express.Router();

// GET /fleet — the fleet lives in the marketing page's #fleet grid (each card
// links to /fleet/:slug). Send the "Build a Quote" CTAs there.
router.get('/fleet', (req, res) => res.redirect('/#fleet'));

// GET /accessibility — accessibility statement (plan §9).
router.get('/accessibility', (req, res) => {
  const updated = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  res.render('accessibility', { updated });
});

router.get('/fleet/:slug', async (req, res, next) => {
  try {
    const trailer = await trailerSvc.getTrailerBySlug(req.params.slug);
    if (!trailer) return next();
    if (trailer.type === 'dumpster') return res.redirect('/book/dumpster');
    const taxRate = await getTaxRate();
    res.render('fleet-detail', { trailer, taxRate, fmt: formatCents });
  } catch (err) {
    next(err);
  }
});

router.get('/book/dumpster', async (req, res, next) => {
  try {
    const dumpster = await trailerSvc.getDumpster();
    if (!dumpster) return next();
    const taxRate = await getTaxRate();
    res.render('book-dumpster', { trailer: dumpster, taxRate, fmt: formatCents });
  } catch (err) {
    next(err);
  }
});

// GET /book/new?slug=&start=&end=&extra_days=&tire_count=
router.get('/book/new', async (req, res, next) => {
  try {
    const { slug, start, end } = req.query;
    const trailer = slug ? await trailerSvc.getTrailerBySlug(slug) : null;
    if (!trailer) return res.redirect('/#fleet');

    const isDumpster = trailer.type === 'dumpster';
    const extraDays = Math.max(0, parseInt(req.query.extra_days, 10) || 0);
    const tireCount = Math.max(0, parseInt(req.query.tire_count, 10) || 0);

    // A valid selection is required to price the booking; otherwise send the
    // customer back to choose.
    if (isDumpster ? !start : !(start && end)) {
      return res.redirect(isDumpster ? '/book/dumpster' : `/fleet/${trailer.slug}`);
    }

    let quote;
    try {
      quote = await computeQuote(trailer, {
        period_type: isDumpster ? 'roll_off' : 'day',
        start_at: start, end_at: end, extra_days: extraDays, quantity: extraDays,
      });
    } catch (e) {
      return res.redirect(isDumpster ? '/book/dumpster' : `/fleet/${trailer.slug}`);
    }

    const selection = {
      slug: trailer.slug,
      period_type: isDumpster ? 'roll_off' : 'day',
      start_at: start || null,
      end_at: end || null,
      extra_days: extraDays,
      tire_count: tireCount,
    };

    res.render('book-form', {
      trailer, quote, selection, isDumpster, fmt: formatCents,
      deliveryFeeCents: DELIVERY_FEE_CENTS,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/book/new/', (req, res) => res.redirect(`/book/new?${new URLSearchParams(req.query)}`));

// GET /book/:id/contract — UUID-addressed contract + signing page.
router.get('/book/:id/contract', async (req, res, next) => {
  try {
    const booking = await bookingSvc.getById(req.params.id);
    if (!booking) return next();
    if (booking.status === 'paid') return res.redirect(`/book/${booking.ref_code}`);

    const agreement = bookingSvc.buildAgreementFor(booking);
    res.render('book-contract', { booking, agreement, fmt: formatCents });
  } catch (err) {
    next(err);
  }
});

// GET /book/:ref/calendar.ics — add-to-calendar file.
router.get('/book/:ref/calendar.ics', async (req, res, next) => {
  try {
    const b = await bookingSvc.getByRef(req.params.ref);
    if (!b) return next();
    const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Glass City Trailer Rentals//EN',
      'BEGIN:VEVENT',
      `UID:${b.ref_code}@glasscitytrailerrentals.com`,
      `DTSTAMP:${stamp(b.created_at)}`,
      `DTSTART:${stamp(b.start_at)}`,
      `DTEND:${stamp(b.end_at)}`,
      `SUMMARY:Glass City Rental — ${b.trailer_name} (${b.ref_code})`,
      'LOCATION:2004 Front Street, Toledo, OH 43605',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${b.ref_code}.ics"`);
    res.send(ics);
  } catch (err) {
    next(err);
  }
});

// GET /book/:ref — confirmation page (declared last so it doesn't shadow the
// literal /book paths above).
router.get('/book/:ref', async (req, res, next) => {
  try {
    const booking = await bookingSvc.getByRef(req.params.ref);
    if (!booking) return next();
    res.render('book-confirmation', {
      booking,
      justPaid: req.query.paid === '1',
      fmt: formatCents,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
