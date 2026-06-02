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
const stripeSvc = require('../services/stripe');
const emailSvc = require('../services/email');
const smsSvc = require('../services/sms');
const config = require('../config');
const { OCCUPYING_STATUSES } = require('../services/availability');
const accountsSvc = require('../services/accounts');
const reportsSvc = require('../services/reports');
const auditSvc = require('../services/audit');
const chargesSvc = require('../services/charges');
const settingsSvc = require('../services/settings');
const couponsSvc = require('../services/coupons');
const { generateStatementPdf } = require('../services/statement');
const { requireAdmin, requireRole } = require('../middleware/auth');
const { formatCents } = require('../utils/money');
const { todayUTC, addDays, parseDateOnly } = require('../utils/date');

const router = express.Router();

// All columns the PWA needs. Kept in one place so GET and PATCH stay in sync.
const TRAILER_COLUMNS = [
  'id', 'slug', 'name', 'type', 'size_label', 'description', 'photo_url',
  'hourly_rate', 'daily_rate', 'weekly_rate', 'monthly_rate',
  'flat_drop_off_cents', 'flat_drop_off_days', 'extra_day_cents', 'per_tire_cents',
  'hitch_requirement', 'plug_requirement', 'specs', 'min_hours',
  'status', 'display_order', 'active', 'quantity_total', 'quantity_on_hold',
  'deposit_cents', 'deposit_enabled',
  'created_at', 'updated_at',
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
  quantity_total: nonNegInt,
  quantity_on_hold: nonNegInt,
  deposit_cents: nonNegInt,
  deposit_enabled: bool,
};

// GET /api/operator/me — echo back the authenticated operator.
router.get('/me', (req, res) => {
  res.json({ user: req.user });
});

// GET /api/operator/integrations — which outbound integrations are configured
// (admin only). Booleans only, never secrets — a quick self-diagnosis for "why
// didn't the email/SMS/push fire?".
router.get('/integrations', requireAdmin, (req, res) => {
  res.json({
    stripe_payments: stripeSvc.isConfigured(),
    stripe_webhook_secret: !!config.stripeWebhookSecret,
    email_resend: emailSvc.isConfigured(),
    from_email: config.fromEmail,
    web_push: pushSvc.isConfigured(),
    sms_twilio: smsSvc.isConfigured(),
    operator_phone_set: !!config.operatorPhone,
    base_url: config.baseUrl,
  });
});

// POST /api/operator/test-email — send a test email (admin). Defaults to the
// logged-in admin's address. Surfaces the real error (e.g. unverified domain).
router.post('/test-email', requireAdmin, async (req, res, next) => {
  try {
    const to = String((req.body && req.body.email) || req.user.email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return res.status(400).json({ error: 'A valid recipient email is required.' });
    }
    if (!emailSvc.isConfigured()) {
      return res.status(503).json({ error: 'Email (Resend) is not configured. Set RESEND_API_KEY in Railway.' });
    }
    const result = await emailSvc.sendTest(to);
    if (result.skipped) return res.status(503).json({ error: result.reason });
    if (result.error) return res.status(502).json({ error: result.error });
    res.json({ ok: true, id: result.id, to });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/test-sms — send a test SMS (admin). Defaults to
// OPERATOR_PHONE. Surfaces Twilio's real error (e.g. unverified trial number).
router.post('/test-sms', requireAdmin, async (req, res, next) => {
  try {
    const to = String((req.body && req.body.phone) || config.operatorPhone || '').trim();
    if (!to) return res.status(400).json({ error: 'Enter a phone number, or set OPERATOR_PHONE in Railway.' });
    if (!/^\+?[1-9]\d{6,14}$/.test(to.replace(/[\s()-]/g, ''))) {
      return res.status(400).json({ error: 'Enter a valid phone number, ideally +1XXXXXXXXXX.' });
    }
    if (!smsSvc.isConfigured()) {
      return res.status(503).json({ error: 'SMS (Twilio) is not configured. Set TWILIO_* in Railway.' });
    }
    const result = await smsSvc.sendSMS(to, 'Glass City test SMS ✅ — if you got this, alerts work.');
    if (result.skipped) return res.status(503).json({ error: 'SMS is not configured.' });
    if (result.error) return res.status(502).json({ error: result.error });
    res.json({ ok: true, sid: result.sid, to });
  } catch (err) {
    next(err);
  }
});

// Attach formatted dollar strings + a ready-to-use contract PDF link so the PWA
// doesn't reimplement money math or URL building. contract_url is only set once
// the agreement is signed (the public PDF route 409s otherwise).
// The requested time-of-day from start_at (stored as wall-clock UTC). Midnight
// means no specific time was chosen, so we return null.
function fmtTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return null;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

function serializeBooking(b) {
  return {
    ...b,
    total_fmt: formatCents(b.total_cents),
    amount_paid_fmt: formatCents(b.amount_paid_cents),
    delivery_fee_fmt: formatCents(b.delivery_fee_cents),
    deposit_paid_fmt: formatCents(b.deposit_paid_cents),
    deposit_refunded_fmt: formatCents(b.deposit_refunded_cents),
    discount_applied_fmt: formatCents(b.discount_applied_cents),
    time_fmt: fmtTime(b.start_at),
    contract_url: b.contract_signed_at ? `/api/bookings/${b.ref_code}/contract.pdf` : null,
  };
}

// GET /api/operator/dashboard — today's pickups, returns, and active rentals.
router.get('/dashboard', async (req, res, next) => {
  try {
    const { pickups, dropoffs, retrievals, returns, active } = await bookingSvc.getDashboard();
    res.json({
      user: req.user,
      pickups: pickups.map(serializeBooking),
      dropoffs: dropoffs.map(serializeBooking),
      retrievals: retrievals.map(serializeBooking),
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
router.patch('/bookings/:id', requireRole('admin', 'operator'), async (req, res, next) => {
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

// ── Returns, extensions & additional charges ───────────────────────────────
const canManageBooking = requireRole('admin', 'operator');

// POST /api/operator/bookings/:id/return — finalize a return with condition.
// Body: { clean, deductions: [{ charge_type, description, amount_cents, weight_tons? }], operator_notes? }.
// Settles the deposit (refund / partial / charge overage) and frees the trailer.
router.post('/bookings/:id/return', canManageBooking, async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid booking id' });
  try {
    const result = await chargesSvc.finalizeReturn(id, req.body || {}, req.user.id);
    res.json({
      booking: serializeBooking(result.booking),
      summary: result.summary,
      settlement: result.settlement,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/operator/bookings/:id/extend — extend an out rental.
// Body: { new_return_date: 'YYYY-MM-DD' }. Creates a payment link for the fee.
router.post('/bookings/:id/extend', canManageBooking, async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid booking id' });
  try {
    const result = await chargesSvc.createExtension(id, req.body || {}, req.user.id);
    res.status(201).json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/operator/bookings/:id/charges — charges + extensions for a booking.
router.get('/bookings/:id/charges', async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid booking id' });
  try {
    const [charges, extensions] = await Promise.all([
      chargesSvc.listCharges(id), chargesSvc.listExtensions(id),
    ]);
    res.json({ charges, extensions });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/bookings/:id/charges — add a post-rental charge.
// Body: { charge_type, description, amount_cents, weight_tons?, billing_method, notes? }.
router.post('/bookings/:id/charges', canManageBooking, async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid booking id' });
  try {
    const charge = await chargesSvc.createCharge(id, req.body || {}, req.user.id);
    res.status(201).json({ charge });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/operator/charges/:id — update a charge's status (waive/dispute/paid).
router.patch('/charges/:id', canManageBooking, async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid charge id' });
  try {
    const charge = await chargesSvc.updateCharge(id, req.body || {});
    res.json({ charge });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Coupons (admin) ────────────────────────────────────────────────────────
router.get('/coupons', requireAdmin, async (req, res, next) => {
  try {
    res.json({ coupons: await couponsSvc.listCoupons() });
  } catch (err) { next(err); }
});

router.post('/coupons', requireAdmin, async (req, res, next) => {
  try {
    const coupon = await couponsSvc.createCoupon(req.body || {}, req.user.id);
    res.status(201).json({ coupon });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.patch('/coupons/:id', requireAdmin, async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid coupon id' });
  try {
    const coupon = await couponsSvc.updateCoupon(req.params.id, req.body || {});
    res.json({ coupon });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/coupons/:id', requireAdmin, async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid coupon id' });
  try {
    res.json(await couponsSvc.deleteCoupon(req.params.id));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Business settings (admin) ──────────────────────────────────────────────
// GET /api/operator/settings — the operator-tunable business settings.
router.get('/settings', requireAdmin, async (req, res, next) => {
  try {
    res.json({ settings: await settingsSvc.getBusinessSettings() });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/operator/settings — update deposits_enabled and/or the tonnage
// overage rate. Audit-logged.
router.patch('/settings', requireAdmin, async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const changed = [];
    if (body.deposits_enabled !== undefined) {
      if (typeof body.deposits_enabled !== 'boolean') {
        return res.status(400).json({ error: 'deposits_enabled must be true or false.' });
      }
      await settingsSvc.setSetting('deposits_enabled', body.deposits_enabled);
      changed.push('deposits_enabled');
    }
    if (body.tonnage_overage_rate_cents !== undefined) {
      const v = body.tonnage_overage_rate_cents;
      if (!Number.isInteger(v) || v < 0) {
        return res.status(400).json({ error: 'tonnage_overage_rate_cents must be a non-negative integer.' });
      }
      await settingsSvc.setSetting('tonnage_overage_rate_cents', v);
      changed.push('tonnage_overage_rate_cents');
    }
    if (!changed.length) return res.status(400).json({ error: 'No recognized settings to update.' });

    await query(
      `INSERT INTO audit_log (admin_user_id, action_by, action, entity_type, details)
       VALUES ($1, $1, 'settings.update', 'settings', $2)`,
      [req.user.id, JSON.stringify({ fields: changed })]
    ).catch((e) => console.error('[settings] audit failed:', e.message));

    res.json({ settings: await settingsSvc.getBusinessSettings() });
  } catch (err) {
    next(err);
  }
});

// GET /api/operator/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — every booking and
// blackout overlapping the range, for the month/week calendar. Defaults to a
// six-week window from today; range width is capped to keep queries bounded.
const MAX_CALENDAR_DAYS = 366;
router.get('/calendar', requireAdmin, async (req, res, next) => {
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
router.get('/blackouts', requireAdmin, async (req, res, next) => {
  try {
    res.json({ blackouts: await blackoutSvc.listBlackouts() });
  } catch (err) {
    next(err);
  }
});

// POST /api/operator/blackouts — block a date range. Body:
// { trailer_id?, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', reason? }.
// Omit trailer_id (or send null) to block the entire fleet.
router.post('/blackouts', requireAdmin, async (req, res, next) => {
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
router.delete('/blackouts/:id', requireAdmin, async (req, res, next) => {
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

// ── Operator accounts (admin only) ─────────────────────────────────────
// GET /api/operator/accounts — list all accounts.
router.get('/accounts', requireAdmin, async (req, res, next) => {
  try {
    res.json({ accounts: await accountsSvc.listAccounts() });
  } catch (err) { next(err); }
});

// POST /api/operator/accounts — create an operator/admin.
router.post('/accounts', requireAdmin, async (req, res, next) => {
  try {
    const account = await accountsSvc.createAccount(req.body || {}, req.user.id);
    res.status(201).json({ account });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// GET /api/operator/accounts/:id — one account.
router.get('/accounts/:id', requireAdmin, async (req, res, next) => {
  try {
    const account = await accountsSvc.getAccount(req.params.id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ account });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /api/operator/accounts/:id — update name/phone/role/active, reset password.
router.patch('/accounts/:id', requireAdmin, async (req, res, next) => {
  try {
    // An admin can't lock themselves out by demoting or deactivating their own
    // account.
    if (req.params.id === req.user.id) {
      const b = req.body || {};
      if (b.active === false) return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      if (b.role && b.role !== 'admin') return res.status(400).json({ error: 'You cannot change your own role.' });
    }
    const account = await accountsSvc.updateAccount(req.params.id, req.body || {}, req.user.id);
    res.json({ account });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/operator/accounts/:id — deactivate (soft delete).
router.delete('/accounts/:id', requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
    const account = await accountsSvc.deactivateAccount(req.params.id, req.user.id);
    res.json({ account });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── Reports & audit (admin + owner; export/send are admin only) ────────
const reportAccess = requireRole('admin', 'owner');

// Resolve a [from, to) range from query (YYYY-MM-DD). `to` is treated as an
// inclusive day (made exclusive by +1). Defaults to the current calendar month.
function reportRange(req) {
  const today = todayUTC();
  const from = parseDateOnly(req.query.from)
    || new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const toQ = parseDateOnly(req.query.to);
  const to = toQ ? addDays(toQ, 1)
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

router.get('/reports/summary', reportAccess, async (req, res, next) => {
  try {
    const { fromIso, toIso } = reportRange(req);
    res.json({ from: fromIso, to: toIso, summary: await reportsSvc.summary(fromIso, toIso) });
  } catch (err) { next(err); }
});

router.get('/reports/bookings', reportAccess, async (req, res, next) => {
  try {
    const { fromIso, toIso } = reportRange(req);
    res.json({ from: fromIso, to: toIso, bookings: await reportsSvc.bookingsBreakdown(fromIso, toIso) });
  } catch (err) { next(err); }
});

router.get('/reports/by-trailer', reportAccess, async (req, res, next) => {
  try {
    const { fromIso, toIso } = reportRange(req);
    res.json({ from: fromIso, to: toIso, trailers: await reportsSvc.byTrailer(fromIso, toIso) });
  } catch (err) { next(err); }
});

// GET /reports/statement?month=&year= — defaults to the current month.
router.get('/reports/statement', reportAccess, async (req, res, next) => {
  try {
    const now = todayUTC();
    const month = req.query.month || (now.getUTCMonth() + 1);
    const year = req.query.year || now.getUTCFullYear();
    res.json({ statement: await reportsSvc.statement(month, year) });
  } catch (err) { next(err); }
});

// GET /reports/export.csv?from&to — admin only.
router.get('/reports/export.csv', requireAdmin, async (req, res, next) => {
  try {
    const { fromIso, toIso } = reportRange(req);
    const rows = await reportsSvc.bookingsBreakdown(fromIso, toIso);
    const stamp = fromIso.slice(0, 7); // YYYY-MM
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="glass-city-bookings-${stamp}.csv"`);
    res.send(reportsSvc.toCsv(rows));
  } catch (err) { next(err); }
});

// POST /reports/send-statement — generate the month's statement PDF and email
// it to OWNER_EMAIL + all active operator/admin accounts. Body: { month, year }
// (defaults to the current month). Admin only.
router.post('/reports/send-statement', requireAdmin, async (req, res, next) => {
  try {
    const now = todayUTC();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const month = body.month || (now.getUTCMonth() + 1);
    const year = body.year || now.getUTCFullYear();

    const statement = await reportsSvc.statement(month, year);
    const pdf = await generateStatementPdf(statement);

    // Recipients: configured owner + every active operator/admin email.
    const { rows } = await query(
      "SELECT email FROM admin_users WHERE active = true AND role IN ('admin','operator') AND email IS NOT NULL"
    );
    const recipients = [...new Set([config.ownerEmail, ...rows.map((r) => r.email)].filter(Boolean))];

    const result = await emailSvc.sendStatement(recipients, pdf, statement);
    if (result.skipped) return res.status(503).json({ error: result.reason, recipients });
    if (result.error) return res.status(502).json({ error: result.error, recipients });
    res.json({ ok: true, recipients, label: statement.label, total_due_fmt: statement.totals.total_due_fmt });
  } catch (err) { next(err); }
});

// GET /audit?from&to&user_id&action&limit&offset — admin + owner.
router.get('/audit', reportAccess, async (req, res, next) => {
  try {
    const { fromIso, toIso } = (() => {
      // Audit defaults to "all time" unless a range is given.
      const from = parseDateOnly(req.query.from);
      const toQ = parseDateOnly(req.query.to);
      return {
        fromIso: from ? from.toISOString() : null,
        toIso: toQ ? addDays(toQ, 1).toISOString() : null,
      };
    })();
    const data = await auditSvc.listAudit({
      from: fromIso, to: toIso, userId: req.query.user_id, action: req.query.action,
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(data);
  } catch (err) { next(err); }
});

// GET /audit/actions — distinct action types, for the filter dropdown.
router.get('/audit/actions', reportAccess, async (req, res, next) => {
  try {
    res.json({ actions: await auditSvc.actionTypes() });
  } catch (err) { next(err); }
});

// GET /api/operator/trailers — the full fleet, ordered for display, with live
// unit counts: out (currently rented), on_hold, and available.
router.get('/trailers', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(`${SELECT_TRAILER} ORDER BY display_order, name`);

    // Units currently out = occupying bookings whose window spans right now,
    // counted per trailer in one pass.
    const counts = await query(
      `SELECT trailer_id, count(*)::int AS n FROM bookings
        WHERE status = ANY($1) AND start_at <= NOW() AND end_at > NOW()
        GROUP BY trailer_id`,
      [OCCUPYING_STATUSES]
    );
    const outById = Object.fromEntries(counts.rows.map((r) => [r.trailer_id, r.n]));

    const trailers = rows.map((t) => {
      const total = t.quantity_total ?? 1;
      const onHold = t.quantity_on_hold ?? 0;
      const out = outById[t.id] || 0;
      const available = Math.max(0, total - onHold - out);
      return { ...t, units: { total, on_hold: onHold, out, available } };
    });
    res.json({ trailers });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/operator/trailers/:id — partial update of one trailer.
// Body may contain any subset of UPDATABLE fields. Unknown fields are
// rejected so typos don't silently no-op. Returns the updated row.
router.patch('/trailers/:id', requireAdmin, async (req, res, next) => {
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
