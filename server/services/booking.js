'use strict';

// Booking lifecycle: create (pending) → sign (signed) → pay (paid). All money
// is recomputed server-side from the trailer + selection; client-sent totals
// are never trusted. Availability is re-checked inside the create transaction
// so two customers can't grab the same window.

const { pool } = require('../db');
const trailerSvc = require('./trailer');
const { computeQuote, DELIVERY_FEE_CENTS } = require('./pricing');
const { OCCUPYING_STATUSES } = require('./availability');
const { buildAgreement, toPlainText, CONTRACT_VERSION } = require('./contract');
const { parseDateOnly, addDays, todayUTC, toDateOnly } = require('../utils/date');
const { refCode } = require('../utils/ref-code');

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the rental window [start, end) as UTC instants. end is exclusive so
// overlap checks are clean. Returns { start, end, periodType, quantity }.
function resolveWindow(trailer, input) {
  if (trailer.type === 'dumpster') {
    const drop = parseDateOnly(input.start_at || input.drop_date);
    if (!drop) throw badRequest('A drop-off date is required.');
    const extraDays = Math.max(0, Math.floor(Number(input.extra_days ?? input.quantity ?? 0)) || 0);
    const totalDays = (trailer.flat_drop_off_days || 0) + extraDays;
    return { start: drop, end: addDays(drop, totalDays), periodType: 'roll_off', quantity: extraDays };
  }
  if (input.period_type && input.period_type !== 'day') {
    throw badRequest('Online booking currently supports daily rentals. Please call (419) 654-3584 for hourly, weekly, or monthly rentals.');
  }
  const start = parseDateOnly(input.start_at);
  const end = parseDateOnly(input.end_at);
  if (!start || !end || end < start) throw badRequest('Valid pickup and return dates are required.');
  // Inclusive day rental: a Jun 10–12 selection occupies through Jun 12, so the
  // exclusive end is Jun 13.
  const days = Math.round((end - start) / 86400000) + 1;
  return { start, end: addDays(end, 1), periodType: 'day', quantity: days };
}

async function findOrCreateCustomer(client, customer) {
  const name = (customer.name || '').trim();
  const email = (customer.email || '').trim().toLowerCase();
  const phone = (customer.phone || '').trim();
  if (!name || !phone) throw badRequest('Name and phone are required.');

  const found = await client.query(
    'SELECT id FROM customers WHERE lower(email) = $1 AND phone = $2 LIMIT 1',
    [email, phone]
  );
  if (found.rows.length) return found.rows[0].id;

  const inserted = await client.query(
    'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
    [name, email, phone]
  );
  return inserted.rows[0].id;
}

async function createBooking(input) {
  // Resolve the trailer up front (read-only).
  let trailer = null;
  if (input.trailer_id && UUID_RE.test(input.trailer_id)) {
    trailer = await trailerSvc.getTrailerById(input.trailer_id);
  } else if (input.slug) {
    trailer = await trailerSvc.getTrailerBySlug(input.slug);
  }
  if (!trailer) throw badRequest('Trailer not found.', 404);
  if (trailer.status !== 'available') throw badRequest('This item is currently unavailable.', 409);

  const { start, end, periodType, quantity } = resolveWindow(trailer, input);
  const quote = await computeQuote(trailer, {
    period_type: periodType,
    start_at: input.start_at,
    end_at: input.end_at,
    extra_days: quantity,
    quantity,
  });

  const isDumpster = trailer.type === 'dumpster';
  const baseAmount = isDumpster ? trailer.flat_drop_off_cents : quote.base_cents;
  const extraCharges = isDumpster ? quote.base_cents - trailer.flat_drop_off_cents : 0;
  const tireCount = Math.max(0, Math.floor(Number(input.tire_count) || 0));

  // Fulfillment: pickup (free) or delivery (flat fee + required address). The
  // delivery fee is added on top of base + tax for the charged total.
  const fulfillment = input.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  let deliveryAddress = null;
  let deliveryFee = 0;
  if (fulfillment === 'delivery') {
    deliveryAddress = (input.delivery_address || '').trim();
    if (!deliveryAddress) throw badRequest('A delivery address is required for delivery.');
    deliveryFee = DELIVERY_FEE_CENTS;
  }
  const totalCents = quote.total_cents + deliveryFee;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-check availability against other occupying bookings + blackouts.
    const conflict = await client.query(
      `SELECT 1 FROM bookings
        WHERE trailer_id = $1 AND status = ANY($2)
          AND start_at < $4 AND end_at > $3
        UNION ALL
        SELECT 1 FROM blackouts
        WHERE (trailer_id = $1 OR trailer_id IS NULL)
          AND start_at < $4 AND end_at > $3
        LIMIT 1`,
      [trailer.id, OCCUPYING_STATUSES, start.toISOString(), end.toISOString()]
    );
    if (conflict.rows.length) {
      throw badRequest('Those dates are no longer available. Please pick another range.', 409);
    }

    const customerId = await findOrCreateCustomer(client, input.customer || {});

    // Unique ref_code with a couple of retries on the unlikely collision.
    let booking = null;
    for (let attempt = 0; attempt < 5 && !booking; attempt++) {
      const ref = refCode();
      try {
        const res = await client.query(
          `INSERT INTO bookings
             (ref_code, trailer_id, customer_id, start_at, end_at, period_type, quantity,
              tire_count, base_amount_cents, extra_charges_cents, tax_cents, total_cents,
              customer_notes, status, fulfillment, delivery_address, delivery_fee_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14,$15,$16)
           RETURNING id, ref_code`,
          [ref, trailer.id, customerId, start.toISOString(), end.toISOString(), periodType, quantity,
            tireCount, baseAmount, extraCharges, quote.tax_cents, totalCents,
            (input.notes || '').trim() || null, fulfillment, deliveryAddress, deliveryFee]
        );
        booking = res.rows[0];
      } catch (e) {
        if (e.code === '23505') continue; // ref_code collision — retry
        throw e;
      }
    }
    if (!booking) throw new Error('Could not allocate a booking reference.');

    await client.query('COMMIT');
    return { id: booking.id, ref_code: booking.ref_code };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Booking joined with its trailer + customer, by id or ref_code.
async function fetchBooking(where, value) {
  const { rows } = await pool.query(
    `SELECT b.*,
            t.name AS trailer_name, t.type AS trailer_type, t.slug AS trailer_slug,
            t.size_label, t.hitch_requirement, t.plug_requirement, t.per_tire_cents,
            c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
       FROM bookings b
       JOIN trailers t ON t.id = b.trailer_id
       JOIN customers c ON c.id = b.customer_id
      WHERE ${where} = $1`,
    [value]
  );
  return rows[0] || null;
}

const getById = (id) => fetchBooking('b.id', id);
const getByRef = (ref) => fetchBooking('b.ref_code', ref);

// Shape a booking row into the {booking, trailer, customer} the contract
// builder expects.
function asAgreementInput(row) {
  return {
    booking: row,
    trailer: {
      name: row.trailer_name, type: row.trailer_type, size_label: row.size_label,
      hitch_requirement: row.hitch_requirement, plug_requirement: row.plug_requirement,
      per_tire_cents: row.per_tire_cents,
    },
    customer: { name: row.customer_name, email: row.customer_email, phone: row.customer_phone },
  };
}

function buildAgreementFor(row) {
  return buildAgreement(asAgreementInput(row));
}

// Capture the e-signature and lock the immutable snapshot. Booking must be
// pending. Returns the updated booking row.
async function signBooking(id, sig) {
  const row = await getById(id);
  if (!row) throw badRequest('Booking not found.', 404);
  if (row.status === 'signed' || row.status === 'paid') {
    return row; // already signed — idempotent
  }
  if (row.status !== 'pending') throw badRequest('This booking can no longer be signed.', 409);

  const name = (sig.name || '').trim();
  if (!name) throw badRequest('A typed signature name is required.');

  const agreement = buildAgreement(asAgreementInput(row));
  const snapshot = toPlainText(agreement);

  await pool.query(
    `UPDATE bookings SET
       status = 'signed',
       contract_version = $2,
       contract_signed_at = NOW(),
       contract_signed_name = $3,
       contract_signed_ip = $4,
       contract_signed_user_agent = $5,
       contract_signature_image = $6,
       contract_snapshot = $7,
       updated_at = NOW()
     WHERE id = $1`,
    [id, CONTRACT_VERSION, name, sig.ip || null, sig.userAgent || null,
      sig.signatureImage || null, snapshot]
  );
  return getById(id);
}

// Mark a booking paid from a Stripe checkout session. Idempotent.
async function markPaidBySession(sessionId, paymentIntentId, amountCents) {
  const { rows } = await pool.query(
    `UPDATE bookings SET
       status = 'paid',
       amount_paid_cents = $2,
       stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
       updated_at = NOW()
     WHERE stripe_session_id = $1 AND status <> 'paid'
     RETURNING id`,
    [sessionId, amountCents || 0, paymentIntentId || null]
  );
  if (!rows.length) return null; // unknown session or already paid
  return getById(rows[0].id);
}

async function attachCheckoutSession(bookingId, sessionId) {
  await pool.query('UPDATE bookings SET stripe_session_id = $2, updated_at = NOW() WHERE id = $1',
    [bookingId, sessionId]);
}

// ── Operator views (Phase 6) ─────────────────────────────────────────────
// All rows below carry the trailer + customer fields the PWA renders, so the
// dashboard / schedule / detail screens never make a second round-trip.
const OPERATOR_SELECT = `
  SELECT b.id, b.ref_code, b.status, b.start_at, b.end_at, b.period_type, b.quantity,
         b.total_cents, b.amount_paid_cents, b.tire_count,
         b.picked_up_at, b.returned_at, b.customer_notes, b.operator_notes,
         b.contract_signed_at, b.contract_signed_name, b.created_at,
         b.fulfillment, b.delivery_address, b.delivery_fee_cents,
         t.id AS trailer_id, t.name AS trailer_name, t.type AS trailer_type,
         t.slug AS trailer_slug, t.size_label, t.status AS trailer_status,
         c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
    FROM bookings b
    JOIN trailers t ON t.id = b.trailer_id
    JOIN customers c ON c.id = b.customer_id`;

// Statuses that represent an upcoming, confirmed-but-not-yet-out rental.
const UPCOMING_STATUSES = ['paid', 'confirmed'];

// Today's pickups + returns + currently-out rentals. "Today" is anchored to UTC
// midnight, matching how availability and the calendar reason about dates
// elsewhere (utils/date.js). Returns three arrays of operator booking rows.
async function getDashboard() {
  const today = todayUTC();
  const tomorrow = addDays(today, 1);
  const t0 = today.toISOString();
  const t1 = tomorrow.toISOString();

  // Pickups today: confirmed rentals whose window starts within today and that
  // haven't been picked up yet.
  const pickups = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status = ANY($1) AND b.start_at >= $2 AND b.start_at < $3
      ORDER BY b.start_at, t.name`,
    [UPCOMING_STATUSES, t0, t1]
  );

  // Returns today: rentals currently out whose (exclusive) end is on or before
  // tomorrow's midnight — i.e. due back today, including anything overdue.
  const returns = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status = 'out' AND b.end_at <= $1
      ORDER BY b.end_at, t.name`,
    [t1]
  );

  // Active now: everything currently out, soonest-due first.
  const active = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status = 'out'
      ORDER BY b.end_at, t.name`
  );

  return { pickups: pickups.rows, returns: returns.rows, active: active.rows };
}

// All bookings touching a given 'YYYY-MM-DD' date, chronological. A booking is
// included if its [start, end) window overlaps the day; each row is tagged with
// whether the pickup and/or return falls on that day so the PWA can label it.
async function getSchedule(dateStr) {
  const day = parseDateOnly(dateStr);
  if (!day) throw badRequest('A valid date (YYYY-MM-DD) is required.');
  const next = addDays(day, 1);
  const d0 = day.toISOString();
  const d1 = next.toISOString();

  const { rows } = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status <> 'cancelled'
        AND b.start_at < $2 AND b.end_at > $1
      ORDER BY b.start_at, b.end_at, t.name`,
    [d0, d1]
  );

  const bookings = rows.map((r) => ({
    ...r,
    is_pickup_day: r.start_at >= day && r.start_at < next,
    // end_at is exclusive: a booking whose last rental day is `day` ends at the
    // following midnight, so the return falls on `day` when end is in (d0, d1].
    is_return_day: r.end_at > day && r.end_at <= next,
  }));

  return { date: toDateOnly(day), bookings };
}

// All non-cancelled bookings whose [start, end) window overlaps [from, to).
// Backs the operator calendar; each row carries trailer + customer fields for
// color-coding and labels.
async function getBookingsInRange(from, to) {
  const { rows } = await pool.query(
    `${OPERATOR_SELECT}
      WHERE b.status <> 'cancelled'
        AND b.start_at < $2 AND b.end_at > $1
      ORDER BY b.start_at, t.name`,
    [from, to]
  );
  return rows;
}

// Allowed operator status transitions and the timestamp each one stamps.
const TRANSITIONS = {
  out: { from: UPCOMING_STATUSES, stamp: 'picked_up_at' },        // Mark Picked Up
  returned: { from: ['out'], stamp: 'returned_at' },              // Mark Returned
};

// Apply an operator update to a booking: a status transition (mark picked up /
// returned) and/or operator notes. On return, the trailer flips back to
// available. Runs in one transaction with an audit-log entry. Returns the
// updated booking detail (getById shape), or throws a tagged Error.
async function updateBooking(id, patch, adminUserId) {
  if (!UUID_RE.test(id)) throw badRequest('Invalid booking id.');

  const hasStatus = patch.status !== undefined;
  const hasNotes = patch.operator_notes !== undefined;
  if (!hasStatus && !hasNotes) throw badRequest('No fields to update.');

  let transition = null;
  if (hasStatus) {
    transition = TRANSITIONS[patch.status];
    if (!transition) throw badRequest("status must be 'out' or 'returned'.");
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row so concurrent operators can't double-transition it.
    const cur = await client.query(
      'SELECT id, status, trailer_id FROM bookings WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!cur.rows.length) throw badRequest('Booking not found.', 404);
    const booking = cur.rows[0];

    const sets = ['updated_at = NOW()'];
    const values = [];

    if (transition) {
      if (!transition.from.includes(booking.status)) {
        throw badRequest(
          `Cannot move a '${booking.status}' booking to '${patch.status}'.`,
          409
        );
      }
      values.push(patch.status);
      sets.push(`status = $${values.length}`);
      sets.push(`${transition.stamp} = NOW()`);
    }

    if (hasNotes) {
      const notes = patch.operator_notes;
      if (notes !== null && typeof notes !== 'string') {
        throw badRequest('operator_notes must be a string or null.');
      }
      values.push(notes === null ? null : notes.trim() || null);
      sets.push(`operator_notes = $${values.length}`);
    }

    values.push(id);
    await client.query(
      `UPDATE bookings SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values
    );

    // Returning a trailer frees it for the next renter.
    if (patch.status === 'returned') {
      await client.query(
        `UPDATE trailers SET status = 'available', updated_at = NOW()
          WHERE id = $1 AND status <> 'out_of_service'`,
        [booking.trailer_id]
      );
    }

    await client.query(
      `INSERT INTO audit_log (admin_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'booking.update', 'booking', $2, $3)`,
      [adminUserId || null, id, JSON.stringify({
        status: hasStatus ? patch.status : undefined,
        notes_changed: hasNotes || undefined,
      })]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return getById(id);
}

module.exports = {
  createBooking, getById, getByRef, signBooking, markPaidBySession,
  attachCheckoutSession, buildAgreementFor,
  getDashboard, getSchedule, updateBooking, getBookingsInRange,
};
