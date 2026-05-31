'use strict';

// Operator API. Every route here is behind requireAuth (mounted in
// server/index.js as app.use('/api/operator', requireAuth, router)), so
// req.user is always present.
//
// Routes:
//   GET   /api/operator/me            the logged-in operator
//   GET   /api/operator/dashboard     today's pickups + returns + active rentals
//   GET   /api/operator/schedule      chronological bookings for a given day
//   GET   /api/operator/bookings/:id  one booking, full detail
//   PATCH /api/operator/bookings/:id  mark picked up / returned, edit notes
//   GET   /api/operator/calendar      all bookings + blackouts in a date range
//   GET   /api/operator/blackouts     list blackouts
//   POST  /api/operator/blackouts     block a date range (one trailer or fleet)
//   DELETE /api/operator/blackouts/:id  unblock
//   GET   /api/operator/push/key      VAPID public key + configured flag
//   POST  /api/operator/push/subscribe   store this device's push subscription
//   POST  /api/operator/push/unsubscribe clear it
//   POST  /api/operator/push/test     send a test push to this operator
//   GET   /api/operator/trailers      full fleet with status, pricing, specs
//   PATCH /api/operator/trailers/:id  update status / pricing / other fields

const express = require('express');
const { pool, query } = require('../db');
const bookingSvc = require('../services/booking');
const blackoutSvc = require('../services/blackouts');
const pushSvc = require('../services/push');
const { formatCents } = require('../utils/money');
const { todayUTC, addDays, parseDateOnly } = require('../utils/date');

const router = express.Router();

// All columns the PWA needs. Kept in one place so GET and PATCH stay in sync.
const TRAILER_COLUMNS = [
  'id', 'slug', 'name', 'type', 'size_label', 'description', 'photo_url',
  'hourly_rate', 'daily_rate', 'weekly_rate', 'monthly_rate',
  'flat_drop_off_cents', 'flat_drop_off_days', 'extra_day_cents', 'per_tire_cents',
  'hitch_requirement', 'plug_requirement', 'specs', 'min_hours',
  'status', 'display_order', 'active', 'created_at', 'updated_at',
];
const SELECT_TRAILER = `SELECT ${TRAILER_COLUMNS.join(', ')} FROM trailers`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['available', 'out_of_service']);

// Fields the operator may PATCH, with a coercer/validator each. A coercer
// returns the value to store, or throws Error(message) on invalid input.
// Integer fields accept null to clear an unused rate (e.g. utility has no
// hourly rate). All money values are stored in cents.
const text = (max) => (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error('must be a string');
  const s = v.trim();
  if (s.length > max) throw new Error(`must be ${max} characters or fewer`);
  return s === '' ? null : s;
};
const nonNegInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error('must be a non-negative integer');
  }
  return v;
};
const status = (v) => {
  if (!STATUSES.has(v)) throw new Error("must be 'available' or 'out_of_service'");
  return v;
};
const bool = (v) => {
  if (typeof v !== 'boolean') throw new Error('must be true or false');
  return v;
};

const UPDATABLE = {
  name: text(200),
  description: text(2000),
  photo_url: text(500),
  size_label: text(100),
  hitch_requirement: text(100),
  plug_requirement: text(100),
  status,
  active: bool,
  hourly_rate: nonNegInt,
  daily_rate: nonNegInt,
  weekly_rate: nonNegInt,
  monthly_rate: nonNegInt,
  flat_drop_off_cents: nonNegInt,
  flat_drop_off_days: nonNegInt,
  extra_day_cents: nonNegInt,
  per_tire_cents: nonNegInt,
  min_hours: nonNegInt,
  display_order: nonNegInt,
};

// GET /api/operator/me — echo back the authenticated operator.
router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

// Attach formatted dollar strings + a ready-to-use contract PDF link so the PWA
// doesn't reimplement money math or URL building. contract_url is only set once
// the agreement is signed (the public PDF route 409s otherwise).
function serializeBooking(b) {
  return {
    ...b,
    total_fmt: formatCents(b.total_cents),
    amount_paid_fmt: formatCents(b.amount_paid_cents),
    contract_url: b.contract_signed_at ? `/api/bookings/${b.ref_code}/contract.pdf` : null,
  };
}

// GET /api/operator/dashboard — today's pickups, returns, and active rentals.
router.get('/dashboard', async (req, res, next) => {
  try {
    const { pickups, returns, active } = await bookingSvc.getDashboard();
    res.json({
      user: req.user,
      pickups: pickups.map(serializeBooking),
      returns: returns.map(serializeBooking),
      active: active.map(serializeBooking),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/operator/schedule?date=YYYY-MM-DD — chronological list for a day.
// Defaults to today when no date is supplied.
router.get('/schedule', async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const { date: resolvedDate, bookings } = await bookingSvc.getSchedule(date);
    res.json({ date: resolvedDate, bookings: bookings.map(serializeBooking) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// GET /api/operator/bookings/:id — full detail for one booking.
router.get('/bookings/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid booking id' });
  try {
    const booking = await bookingSvc.getById(id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking: serializeBooking(booking) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/operator/bookings/:id — mark picked up ('out') / returned, and/or
// edit operator notes. Returning a booking flips its trailer back to available.
router.patch('/bookings/:id', async (req, res, next) => {
  const { id } = req.params;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const booking = await bookingSvc.updateBooking(id, body, req.user.id);
    res.json({ booking: serializeBooking(booking) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/operator/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — every booking and
// blackout overlapping the range, for the month/week calendar. Defaults to a
// six-week window from today; range width is capped to keep queries bounded.
const MAX_CALENDAR_DAYS = 366;
router.get('/calendar', async (req, res, next) => {
  try {
    const from = parseDateOnly(req.query.from) || todayUTC();
    let to = parseDateOnly(req.query.to) || addDays(from, 42);
    if (to < from) to = from;
    if ((to - from) / 86400000 > MAX_CALENDAR_DAYS) to = addDays(from, MAX_CALENDAR_DAYS);

    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const [bookings, blackouts] = await Promise.all([
      bookingSvc.getBookingsInRange(fromIso, toIso),
      blackoutSvc.getBlackoutsInRange(fromIso, toIso),
    ]);

    res.json({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      bookings: bookings.map(serializeBooking),
      blackouts,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/operator/blackouts — all blackouts, soonest first.
router.get('/blackouts', async (req, res, next) => {
  try {
    res.json({ blackouts: await blackoutSvc.listBlackouts() });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/blackouts — block a date range. Body:
// { trailer_id?, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', reason? }.
// Omit trailer_id (or send null) to block the entire fleet.
router.post('/blackouts', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const blackout = await blackoutSvc.createBlackout(body, req.user.id);
    res.status(201).json({ blackout });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/operator/blackouts/:id — unblock.
router.delete('/blackouts/:id', async (req, res, next) => {
  try {
    const removed = await blackoutSvc.deleteBlackout(req.params.id, req.user.id);
    if (!removed) return res.status(404).json({ error: 'Blackout not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Web Push (Phase 8) ─────────────────────────────────────────────────
// GET /api/operator/push/key — the VAPID public key the browser needs to
// subscribe, plus whether push is configured server-side at all.
router.get('/push/key', (req, res) => {
  res.json({ configured: pushSvc.isConfigured(), publicKey: pushSvc.getPublicKey() });
});

// POST /api/operator/push/subscribe — store this device's PushSubscription on
// the operator's account. Body: { subscription: <PushSubscription> }.
router.post('/push/subscribe', async (req, res, next) => {
  try {
    const sub = req.body && req.body.subscription;
    await pushSvc.saveSubscription(req.user.id, sub);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/operator/push/unsubscribe — forget this operator's subscription.
router.post('/push/unsubscribe', async (req, res, next) => {
  try {
    await pushSvc.clearSubscription(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/push/test — send a test notification to the requesting
// operator's own device, so they can confirm alerts work end-to-end.
router.post('/push/test', async (req, res, next) => {
  try {
    if (!pushSvc.isConfigured()) {
      return res.status(503).json({ error: 'Push is not configured on the server.' });
    }
    const { rows } = await query(
      'SELECT push_subscription FROM admin_users WHERE id = $1', [req.user.id]
    );
    const stored = rows[0] && rows[0].push_subscription;
    if (!stored) return res.status(400).json({ error: 'No push subscription on this account yet.' });

    const sub = typeof stored === 'string' ? JSON.parse(stored) : stored;
    const result = await pushSvc.sendToSubscription(sub, {
      title: 'Glass City — test alert',
      body: 'Push notifications are working on this device. 🎉',
      url: '/operator/',
      tag: 'push-test',
    });
    if (result.expired) {
      await pushSvc.clearSubscription(req.user.id);
      return res.status(409).json({ error: 'This subscription expired. Re-enable alerts.' });
    }
    if (!result.ok) return res.status(502).json({ error: result.error || 'Send failed.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/operator/trailers — the full fleet, ordered for display.
router.get('/trailers', async (req, res, next) => {
  try {
    const { rows } = await query(
      `${SELECT_TRAILER} ORDER BY display_order, name`
    );
    res.json({ trailers: rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/operator/trailers/:id — partial update of one trailer.
// Body may contain any subset of UPDATABLE fields. Unknown fields are
// rejected so typos don't silently no-op. Returns the updated row.
router.patch('/trailers/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid trailer id' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const keys = Object.keys(body);
  if (keys.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  const sets = [];
  const values = [];
  for (const key of keys) {
    const coerce = UPDATABLE[key];
    if (!coerce) {
      return res.status(400).json({ error: `Field '${key}' is not editable` });
    }
    let value;
    try {
      value = coerce(body[key]);
    } catch (e) {
      return res.status(400).json({ error: `${key}: ${e.message}` });
    }
    values.push(value);
    sets.push(`${key} = $${values.length}`);
  }
  sets.push('updated_at = NOW()');
  values.push(id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE trailers SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING ${TRAILER_COLUMNS.join(', ')}`,
      values
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Trailer not found' });
    }

    // Audit trail — who changed what.
    await client.query(
      `INSERT INTO audit_log (admin_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'trailer.update', 'trailer', $2, $3)`,
      [req.user.id, id, JSON.stringify({ fields: keys })]
    );

    await client.query('COMMIT');
    res.json({ trailer: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
