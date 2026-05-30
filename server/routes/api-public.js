'use strict';

// Public (no-auth) JSON API for the customer booking surface.
//   GET  /api/trailers                         active fleet + current status
//   GET  /api/trailers/:slug                   one trailer's public detail
//   GET  /api/trailers/:slug/availability      busy ranges over a date window
//   POST /api/quote                            live price for a selection
//
// /api/quote is rate-limited (plan §13: 30/min/IP) since it hits the DB and is
// the one public endpoint that accepts a body.

const express = require('express');
const { rateLimit } = require('../middleware/rate-limit');
const trailerSvc = require('../services/trailer');
const { getBusyRanges } = require('../services/availability');
const { computeQuote } = require('../services/pricing');
const { formatCents } = require('../utils/money');
const { todayUTC, addDays, parseDateOnly, toDateOnly } = require('../utils/date');

const router = express.Router();

const HORIZON_DAYS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const quoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: 'Too many quote requests, slow down.',
});

// Attach formatted dollar strings so the client doesn't reimplement money math.
function withFormatted(t) {
  return {
    ...t,
    hourly_rate_fmt: formatCents(t.hourly_rate),
    daily_rate_fmt: formatCents(t.daily_rate),
    weekly_rate_fmt: formatCents(t.weekly_rate),
    monthly_rate_fmt: formatCents(t.monthly_rate),
    flat_drop_off_fmt: formatCents(t.flat_drop_off_cents),
    extra_day_fmt: formatCents(t.extra_day_cents),
    per_tire_fmt: formatCents(t.per_tire_cents),
  };
}

router.get('/trailers', async (req, res, next) => {
  try {
    const trailers = await trailerSvc.getActiveTrailers();
    res.json({ trailers: trailers.map(withFormatted) });
  } catch (err) {
    next(err);
  }
});

router.get('/trailers/:slug', async (req, res, next) => {
  try {
    const trailer = await trailerSvc.getTrailerBySlug(req.params.slug);
    if (!trailer) return res.status(404).json({ error: 'Trailer not found' });
    res.json({ trailer: withFormatted(trailer) });
  } catch (err) {
    next(err);
  }
});

// GET /api/trailers/:slug/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
// Defaults to a 60-day horizon starting today; clamps any wider request.
router.get('/trailers/:slug/availability', async (req, res, next) => {
  try {
    const trailer = await trailerSvc.getTrailerBySlug(req.params.slug);
    if (!trailer) return res.status(404).json({ error: 'Trailer not found' });

    const today = todayUTC();
    const horizonEnd = addDays(today, HORIZON_DAYS);

    let from = parseDateOnly(req.query.from) || today;
    let to = parseDateOnly(req.query.to) || horizonEnd;
    if (from < today) from = today;
    if (to > horizonEnd) to = horizonEnd;
    if (to < from) to = from;

    // An out-of-service trailer is busy for the entire horizon.
    let busy;
    if (trailer.status !== 'available') {
      busy = [{ start_at: from.toISOString(), end_at: to.toISOString(), reason: 'out_of_service' }];
    } else {
      busy = await getBusyRanges(trailer.id, from.toISOString(), to.toISOString());
    }

    res.json({
      slug: trailer.slug,
      status: trailer.status,
      from: toDateOnly(from),
      to: toDateOnly(to),
      horizon_days: HORIZON_DAYS,
      busy,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/quote — { trailer_id | slug, period_type, start_at?, end_at?,
//                     quantity?, extra_days?, tire_count? }
router.post('/quote', quoteLimiter, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { trailer_id: trailerId, slug } = body;

    let trailer = null;
    if (trailerId && UUID_RE.test(trailerId)) {
      trailer = await trailerSvc.getTrailerById(trailerId);
    } else if (slug) {
      trailer = await trailerSvc.getTrailerBySlug(slug);
    } else {
      return res.status(400).json({ error: 'A trailer_id or slug is required.' });
    }
    if (!trailer) return res.status(404).json({ error: 'Trailer not found' });

    const quote = await computeQuote(trailer, body);
    res.json({
      trailer: { id: trailer.id, slug: trailer.slug, name: trailer.name, type: trailer.type },
      ...quote,
      base_fmt: formatCents(quote.base_cents),
      tax_fmt: formatCents(quote.tax_cents),
      total_fmt: formatCents(quote.total_cents),
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
