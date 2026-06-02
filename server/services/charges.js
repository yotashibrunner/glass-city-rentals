'use strict';

// Deposit returns, rental extensions, and post-rental additional charges.
//
// All money is integer cents. Stripe calls are best-effort and guarded: with no
// STRIPE_SECRET_KEY the records are still written and the operator/customer are
// informed, so the office workflow never hard-fails on a missing integration.
// The deposit hold + saved card (customer + payment method) are captured at
// booking checkout (see services/stripe.js + booking.markPaidBySession).

const { pool, query } = require('../db');
const config = require('../config');
const bookingSvc = require('./booking');
const trailerSvc = require('./trailer');
const stripeSvc = require('./stripe');
const emailSvc = require('./email');
const smsSvc = require('./sms');
const settingsSvc = require('./settings');
const { OCCUPYING_STATUSES } = require('./availability');
const { formatCents } = require('../utils/money');
const { parseDateOnly, addDays } = require('../utils/date');

const DAY_MS = 86400000;

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Deposit owed for a booking's trailer, given the global toggle. A deposit
// applies only when the global switch is on AND the trailer is enabled AND the
// trailer's deposit amount is positive. Returns integer cents (0 = none).
function depositDueCents(booking, globalEnabled) {
  if (!globalEnabled) return 0;
  if (!booking.trailer_deposit_enabled) return 0;
  const cents = Number(booking.trailer_deposit_cents) || 0;
  return cents > 0 ? cents : 0;
}

const VALID_CHARGE_TYPES = new Set([
  'damage', 'tonnage_overage', 'prohibited_items', 'tires', 'late_return',
  'deposit_deduction', 'other',
]);

function chargeTypeLabel(t) {
  return {
    damage: 'Damage', tonnage_overage: 'Tonnage overage', prohibited_items: 'Prohibited items',
    tires: 'Tires', late_return: 'Late return', deposit_deduction: 'Deposit deduction', other: 'Other',
  }[t] || 'Charge';
}

function serializeCharge(c) {
  return {
    ...c,
    amount_fmt: formatCents(c.amount_cents),
    type_label: chargeTypeLabel(c.charge_type),
  };
}
function serializeExtension(e) {
  return {
    ...e,
    extension_fee_fmt: formatCents(e.extension_fee_cents),
  };
}

// ── Additional charges ────────────────────────────────────────────────────
async function listCharges(bookingId) {
  const { rows } = await query(
    'SELECT * FROM additional_charges WHERE booking_id = $1 ORDER BY created_at DESC',
    [bookingId]
  );
  return rows.map(serializeCharge);
}

async function listExtensions(bookingId) {
  const { rows } = await query(
    'SELECT * FROM rental_extensions WHERE booking_id = $1 ORDER BY created_at DESC',
    [bookingId]
  );
  return rows.map(serializeExtension);
}

// Notify the customer of a charge/extension on both channels (best-effort).
async function notifyCustomer(booking, { sms, emailFn }) {
  if (booking.customer_phone && sms) {
    try { await smsSvc.sendSms(booking.customer_phone, sms); }
    catch (e) { console.error('[charges] customer SMS failed:', e.message); }
  }
  if (emailFn) {
    try { await emailFn(); }
    catch (e) { console.error('[charges] customer email failed:', e.message); }
  }
}

// Create a post-rental additional charge. billing_method:
//   'card_on_file' → charge the saved card immediately (needs a card on file);
//   'payment_link' → create a hosted link the customer pays online.
async function createCharge(bookingId, body, operatorId) {
  const booking = await bookingSvc.getById(bookingId);
  if (!booking) throw badRequest('Booking not found.', 404);

  const chargeType = String(body.charge_type || '').trim();
  if (!VALID_CHARGE_TYPES.has(chargeType)) throw badRequest('Invalid charge type.');
  const description = String(body.description || '').trim();
  if (!description) throw badRequest('A description is required.');
  const amountCents = Math.round(Number(body.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw badRequest('A positive amount is required.');
  const weightTons = body.weight_tons != null && body.weight_tons !== '' ? Number(body.weight_tons) : null;
  let billingMethod = body.billing_method === 'card_on_file' ? 'card_on_file' : 'payment_link';
  if (billingMethod === 'card_on_file' && !(booking.stripe_customer_id && booking.stripe_payment_method_id)) {
    throw badRequest('No saved card on file for this booking — use a payment link instead.', 409);
  }

  // Insert pending first so we always have a record, then attempt billing.
  const ins = await query(
    `INSERT INTO additional_charges
       (booking_id, charge_type, description, amount_cents, weight_tons, billing_method, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [bookingId, chargeType, description, amountCents, weightTons, billingMethod,
      (body.notes || '').trim() || null, operatorId || null]
  );
  let charge = ins.rows[0];

  let paymentLink = null;
  if (billingMethod === 'card_on_file') {
    try {
      const pi = await stripeSvc.chargeCardOnFile({
        customerId: booking.stripe_customer_id,
        paymentMethodId: booking.stripe_payment_method_id,
        amountCents,
        description: `${chargeTypeLabel(chargeType)} — ${booking.ref_code}`,
        metadata: { type: 'charge', charge_id: charge.id, booking_id: bookingId, ref_code: booking.ref_code },
      });
      const upd = await query(
        `UPDATE additional_charges SET status='paid', paid_at=NOW(),
           stripe_payment_intent_id=$2 WHERE id=$1 RETURNING *`,
        [charge.id, pi.id]
      );
      charge = upd.rows[0];
    } catch (e) {
      console.error('[charges] card-on-file charge failed:', e.message);
      throw badRequest(e.message || 'Could not charge the card on file.', e.status || 502);
    }
  } else {
    // Hosted payment link (best-effort; null when Stripe is unconfigured).
    try {
      const link = await stripeSvc.createPaymentLink({
        amountCents,
        productName: `${chargeTypeLabel(chargeType)} — ${booking.ref_code}`,
        description,
        customerEmail: booking.customer_email || undefined,
        metadata: { type: 'charge', charge_id: charge.id, booking_id: bookingId, ref_code: booking.ref_code },
        successUrl: `${config.baseUrl}/book/${booking.ref_code}?paid=1`,
        cancelUrl: `${config.baseUrl}/book/${booking.ref_code}`,
      });
      paymentLink = link.url;
      const upd = await query(
        `UPDATE additional_charges SET stripe_payment_link=$2, stripe_session_id=$3 WHERE id=$1 RETURNING *`,
        [charge.id, link.url, link.id]
      );
      charge = upd.rows[0];
    } catch (e) {
      console.error('[charges] payment link creation failed:', e.message);
    }
  }

  // Notify the customer.
  const amountFmt = formatCents(amountCents);
  await query('UPDATE additional_charges SET notified_at = NOW() WHERE id = $1', [charge.id]).catch(() => {});
  const sms = billingMethod === 'card_on_file'
    ? `Glass City: a ${chargeTypeLabel(chargeType).toLowerCase()} charge of ${amountFmt} was applied to your card on file for rental ${booking.ref_code}. Questions? (419) 654-3584`
    : `Glass City: a ${chargeTypeLabel(chargeType).toLowerCase()} charge of ${amountFmt} is due for rental ${booking.ref_code}.${paymentLink ? ' Pay here: ' + paymentLink : ''}`;
  await notifyCustomer(booking, {
    sms,
    emailFn: () => emailSvc.sendChargeNotice(booking, serializeCharge(charge), paymentLink, config.baseUrl),
  });

  return serializeCharge(charge);
}

async function updateCharge(chargeId, patch) {
  const allowed = new Set(['paid', 'waived', 'disputed', 'pending']);
  const status = String(patch.status || '').trim();
  if (!allowed.has(status)) throw badRequest("status must be 'paid', 'waived', 'disputed', or 'pending'.");
  const { rows } = await query(
    `UPDATE additional_charges
        SET status=$2, paid_at = CASE WHEN $2='paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END
      WHERE id=$1 RETURNING *`,
    [chargeId, status]
  );
  if (!rows.length) throw badRequest('Charge not found.', 404);
  return serializeCharge(rows[0]);
}

// Webhook: a charge's payment link was paid.
async function markChargePaidBySession(sessionId, paymentIntentId) {
  const { rows } = await query(
    `UPDATE additional_charges SET status='paid', paid_at=NOW(),
        stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id)
      WHERE stripe_session_id=$1 AND status <> 'paid' RETURNING id`,
    [sessionId, paymentIntentId || null]
  );
  return rows[0] || null;
}

// ── Rental extensions ──────────────────────────────────────────────────────
// new_return_date is the inclusive last rental day the customer wants (YYYY-MM-DD).
async function createExtension(bookingId, body, operatorId) {
  const booking = await bookingSvc.getById(bookingId);
  if (!booking) throw badRequest('Booking not found.', 404);
  if (booking.status !== 'out') throw badRequest('Only an out (active) rental can be extended.', 409);

  const newReturn = parseDateOnly(body.new_return_date || body.new_end_at);
  if (!newReturn) throw badRequest('A new return date is required.');
  const newEndExclusive = addDays(newReturn, 1); // end_at is the midnight after the last day
  const currentEnd = new Date(booking.end_at);
  if (newEndExclusive <= currentEnd) throw badRequest('The new return date must be after the current one.');

  const daysExtended = Math.round((newEndExclusive - currentEnd) / DAY_MS);
  if (daysExtended <= 0) throw badRequest('The new return date must be after the current one.');

  const trailer = await trailerSvc.getTrailerById(booking.trailer_id);
  if (!trailer) throw badRequest('Trailer not found.', 404);
  if (trailer.daily_rate == null) throw badRequest('This trailer has no daily rate to extend at.');

  // Availability over the extension window [currentEnd, newEndExclusive): a
  // blackout blocks it, or capacity is full with OTHER bookings overlapping.
  const fromIso = currentEnd.toISOString();
  const toIso = newEndExclusive.toISOString();
  const blackout = await query(
    `SELECT 1 FROM blackouts WHERE (trailer_id = $1 OR trailer_id IS NULL)
        AND start_at < $3 AND end_at > $2 LIMIT 1`,
    [trailer.id, fromIso, toIso]
  );
  if (blackout.rows.length) throw badRequest('Those dates are blocked — the rental cannot be extended.', 409);
  const cap = Math.max(0, (trailer.quantity_total ?? 1) - (trailer.quantity_on_hold ?? 0));
  const overlap = await query(
    `SELECT count(*)::int AS n FROM bookings
       WHERE trailer_id = $1 AND id <> $2 AND status = ANY($3)
         AND start_at < $5 AND end_at > $4`,
    [trailer.id, bookingId, OCCUPYING_STATUSES, fromIso, toIso]
  );
  if (overlap.rows[0].n >= cap) throw badRequest('Another booking needs the trailer then — cannot extend.', 409);

  const feeCents = trailer.daily_rate * daysExtended;

  const ins = await query(
    `INSERT INTO rental_extensions
       (booking_id, original_end_at, new_end_at, days_extended, extension_fee_cents, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [bookingId, booking.end_at, newEndExclusive.toISOString(), daysExtended, feeCents, operatorId || null]
  );
  let extension = ins.rows[0];

  let paymentLink = null;
  try {
    const link = await stripeSvc.createPaymentLink({
      amountCents: feeCents,
      productName: `Rental extension — ${booking.ref_code}`,
      description: `${daysExtended} extra day${daysExtended > 1 ? 's' : ''} on your ${booking.trailer_name}`,
      customerEmail: booking.customer_email || undefined,
      metadata: { type: 'extension', extension_id: extension.id, booking_id: bookingId, ref_code: booking.ref_code },
      successUrl: `${config.baseUrl}/book/${booking.ref_code}?paid=1`,
      cancelUrl: `${config.baseUrl}/book/${booking.ref_code}`,
    });
    paymentLink = link.url;
    const upd = await query(
      `UPDATE rental_extensions SET stripe_payment_link=$2, stripe_session_id=$3 WHERE id=$1 RETURNING *`,
      [extension.id, link.url, link.id]
    );
    extension = upd.rows[0];
  } catch (e) {
    console.error('[charges] extension payment link failed:', e.message);
  }

  const newReturnFmt = newReturn.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const feeFmt = formatCents(feeCents);
  await notifyCustomer(booking, {
    sms: `Glass City: your ${booking.trailer_name} rental is extended to ${newReturnFmt}. Extension fee ${feeFmt} due.${paymentLink ? ' Pay: ' + paymentLink : ''} Ref ${booking.ref_code}`,
    emailFn: () => emailSvc.sendExtensionNotice(booking, serializeExtension(extension), paymentLink, newReturnFmt, config.baseUrl),
  });

  return { extension: serializeExtension(extension), payment_link: paymentLink };
}

// Webhook: an extension fee was paid — move the booking's return date out.
async function markExtensionPaidBySession(sessionId, paymentIntentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE rental_extensions SET status='paid', paid_at=NOW(),
          stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id)
        WHERE stripe_session_id=$1 AND status <> 'paid'
        RETURNING id, booking_id, new_end_at`,
      [sessionId, paymentIntentId || null]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const ext = rows[0];
    await client.query(
      'UPDATE bookings SET end_at = $2, updated_at = NOW() WHERE id = $1',
      [ext.booking_id, ext.new_end_at]
    );
    await client.query('COMMIT');
    return ext;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Return condition / deposit settlement ──────────────────────────────────
// condition: { clean: bool, deductions: [{ charge_type, description, amount_cents, weight_tons? }],
//              operator_notes? }. Transitions the booking out → returned, settles
// the deposit (refund clean/partial; charge overage to card on file), records
// each deduction as an additional_charges row, and notifies the customer.
async function finalizeReturn(bookingId, condition, operatorId) {
  const booking = await bookingSvc.getById(bookingId);
  if (!booking) throw badRequest('Booking not found.', 404);
  if (booking.status !== 'out') throw badRequest(`Cannot return a '${booking.status}' booking.`, 409);

  const deposit = Math.max(0, Number(booking.deposit_paid_cents) || 0);
  const hasDeposit = booking.deposit_status === 'held' && deposit > 0;
  const clean = condition.clean === true || condition.clean === 'true';

  const rawDeductions = Array.isArray(condition.deductions) ? condition.deductions : [];
  const deductions = clean ? [] : rawDeductions.map((d) => ({
    charge_type: VALID_CHARGE_TYPES.has(String(d.charge_type)) ? String(d.charge_type) : 'other',
    description: String(d.description || chargeTypeLabel(d.charge_type) || 'Charge').trim(),
    amount_cents: Math.max(0, Math.round(Number(d.amount_cents) || 0)),
    weight_tons: d.weight_tons != null && d.weight_tons !== '' ? Number(d.weight_tons) : null,
  })).filter((d) => d.amount_cents > 0);

  const totalDeductions = deductions.reduce((s, d) => s + d.amount_cents, 0);
  if (!clean && totalDeductions === 0) throw badRequest('Add at least one deduction, or mark the return clean.');

  const refundCents = hasDeposit ? Math.max(0, deposit - totalDeductions) : 0;
  const keptFromDeposit = hasDeposit ? deposit - refundCents : 0;
  const overageCents = Math.max(0, totalDeductions - keptFromDeposit); // billed to card on file

  let newDepositStatus = booking.deposit_status;
  if (hasDeposit) {
    if (clean || totalDeductions === 0) newDepositStatus = 'refunded';
    else if (refundCents === 0) newDepositStatus = 'kept';
    else newDepositStatus = 'partially_kept';
  }

  // 1) Transaction: flip to returned, free the trailer, write deduction rows,
  //    set the intended deposit outcome.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT status, trailer_id FROM bookings WHERE id=$1 FOR UPDATE', [bookingId]);
    if (!cur.rows.length) throw badRequest('Booking not found.', 404);
    if (cur.rows[0].status !== 'out') throw badRequest(`Cannot return a '${cur.rows[0].status}' booking.`, 409);

    await client.query(
      `UPDATE bookings SET status='returned', returned_at=NOW(), managed_by=$2,
          deposit_status=$3, deposit_refunded_cents=$4, updated_at=NOW()
        WHERE id=$1`,
      [bookingId, operatorId || null, newDepositStatus, refundCents]
    );
    await client.query(
      `UPDATE trailers SET status='available', updated_at=NOW()
        WHERE id=$1 AND status <> 'out_of_service'`,
      [cur.rows[0].trailer_id]
    );

    // Record each deduction. Rows covered by the deposit are 'deposit'/'paid';
    // any overage portion is billed to the card on file.
    let budget = keptFromDeposit;
    for (const d of deductions) {
      const fromDeposit = Math.min(budget, d.amount_cents);
      budget -= fromDeposit;
      const method = fromDeposit >= d.amount_cents ? 'deposit' : (fromDeposit > 0 ? 'deposit' : 'card_on_file');
      await client.query(
        `INSERT INTO additional_charges
           (booking_id, charge_type, description, amount_cents, weight_tons, billing_method, status, notified_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'paid',NOW(),$7)`,
        [bookingId, d.charge_type, d.description, d.amount_cents, d.weight_tons, method, operatorId || null]
      );
    }

    if (condition.operator_notes) {
      await client.query('UPDATE bookings SET operator_notes = $2 WHERE id = $1',
        [bookingId, String(condition.operator_notes).trim() || null]);
    }

    await client.query(
      `INSERT INTO audit_log (admin_user_id, action_by, action, entity_type, entity_id, details)
       VALUES ($1,$1,'booking.return','booking',$2,$3)`,
      [operatorId || null, bookingId, JSON.stringify({
        clean, total_deductions_cents: totalDeductions, refund_cents: refundCents, overage_cents: overageCents,
      })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // 2) Best-effort Stripe settlement (outside the txn; logged on failure so the
  //    return still completes if the integration is down / unconfigured).
  const result = { refund_cents: refundCents, overage_cents: overageCents, refunded: false, charged: false };
  if (hasDeposit && refundCents > 0 && booking.stripe_payment_intent_id) {
    try {
      await stripeSvc.refund({ paymentIntentId: booking.stripe_payment_intent_id, amountCents: refundCents });
      result.refunded = true;
    } catch (e) {
      console.error('[charges] deposit refund failed:', e.message);
    }
  }
  if (overageCents > 0 && booking.stripe_customer_id && booking.stripe_payment_method_id) {
    try {
      const pi = await stripeSvc.chargeCardOnFile({
        customerId: booking.stripe_customer_id,
        paymentMethodId: booking.stripe_payment_method_id,
        amountCents: overageCents,
        description: `Return charges beyond deposit — ${booking.ref_code}`,
        metadata: { type: 'return_overage', booking_id: bookingId, ref_code: booking.ref_code },
      });
      result.charged = true;
      result.overage_payment_intent = pi.id;
    } catch (e) {
      console.error('[charges] overage charge failed:', e.message);
      result.charge_error = e.message;
    }
  }

  // 3) Notify the customer with an itemized summary.
  const updated = await bookingSvc.getById(bookingId);
  const summary = {
    clean, deductions, total_deductions_cents: totalDeductions,
    deposit_cents: deposit, refund_cents: refundCents, overage_cents: overageCents,
    deposit_status: newDepositStatus,
  };
  const lines = deductions.map((d) => `${chargeTypeLabel(d.charge_type)}: ${formatCents(d.amount_cents)}`).join(', ');
  const sms = clean
    ? (deposit > 0
        ? `Glass City: thanks for returning your ${booking.trailer_name}! Your ${formatCents(deposit)} deposit is being refunded (3–5 business days). Ref ${booking.ref_code}`
        : `Glass City: thanks for returning your ${booking.trailer_name}! Ref ${booking.ref_code}`)
    : `Glass City: your ${booking.trailer_name} return is processed. Deductions: ${lines}. ${refundCents > 0 ? `Refund ${formatCents(refundCents)} of your deposit.` : ''}${overageCents > 0 ? ` Additional ${formatCents(overageCents)} charged to your card on file.` : ''} Ref ${booking.ref_code}`;
  await notifyCustomer(booking, {
    sms,
    emailFn: () => emailSvc.sendDepositOutcome(booking, summary, config.baseUrl),
  });

  return { booking: updated, summary, settlement: result };
}

// ── Customer self-service cancellation ─────────────────────────────────────
// Policy: >48h before start → full rental refund; <48h and not yet started →
// 50%; already started (no-show) → 0%. The security deposit is always refunded
// in full. Public endpoint — the ref code is the secret. Returns a summary.
const CANCEL_WINDOW_MS = 48 * 60 * 60 * 1000;

async function cancelBooking(ref) {
  const booking = await bookingSvc.getByRef(ref);
  if (!booking) throw badRequest('Booking not found.', 404);
  if (booking.status === 'cancelled') throw badRequest('This booking is already cancelled.', 409);
  if (!['paid', 'confirmed'].includes(booking.status)) {
    throw badRequest('This booking can no longer be cancelled online. Please call (419) 654-3584.', 409);
  }

  const now = Date.now();
  const start = new Date(booking.start_at).getTime();
  let refundPct;
  let policyLabel;
  if (now >= start) { refundPct = 0; policyLabel = 'no-show (no refund)'; }
  else if (start - now > CANCEL_WINDOW_MS) { refundPct = 1; policyLabel = 'full refund'; }
  else { refundPct = 0.5; policyLabel = '50% refund (within 48 hours)'; }

  const rentalPaid = Math.max(0, Number(booking.amount_paid_cents) || 0);
  const rentalRefund = Math.round(rentalPaid * refundPct);
  const depositHeld = booking.deposit_status === 'held' ? Math.max(0, Number(booking.deposit_paid_cents) || 0) : 0;
  const totalRefund = rentalRefund + depositHeld;

  // 1) Mark cancelled + settle the deposit state in one transaction.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT status FROM bookings WHERE id = $1 FOR UPDATE', [booking.id]);
    if (!cur.rows.length) throw badRequest('Booking not found.', 404);
    if (!['paid', 'confirmed'].includes(cur.rows[0].status)) {
      throw badRequest('This booking can no longer be cancelled online.', 409);
    }
    await client.query(
      `UPDATE bookings SET status='cancelled', updated_at=NOW(),
          deposit_status = CASE WHEN $2 > 0 THEN 'refunded' ELSE deposit_status END,
          deposit_refunded_cents = CASE WHEN $2 > 0 THEN $2 ELSE deposit_refunded_cents END
        WHERE id=$1`,
      [booking.id, depositHeld]
    );
    await client.query(
      `INSERT INTO audit_log (action, entity_type, entity_id, details)
       VALUES ('booking.cancel', 'booking', $1, $2)`,
      [booking.id, JSON.stringify({ refund_pct: refundPct, rental_refund_cents: rentalRefund, deposit_refund_cents: depositHeld })]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // 2) Stripe refund (best-effort; one refund covers rental + deposit since both
  //    were captured on the same payment intent).
  const settlement = { refunded: false };
  if (totalRefund > 0 && booking.stripe_payment_intent_id) {
    try {
      await stripeSvc.refund({ paymentIntentId: booking.stripe_payment_intent_id, amountCents: totalRefund });
      settlement.refunded = true;
    } catch (e) {
      console.error('[charges] cancellation refund failed:', e.message);
      settlement.error = e.message;
    }
  }

  // 3) Notify the customer.
  const summary = {
    policy: policyLabel, refund_pct: refundPct,
    rental_refund_cents: rentalRefund, deposit_refund_cents: depositHeld, total_refund_cents: totalRefund,
  };
  const refundFmt = formatCents(totalRefund);
  await notifyCustomer(booking, {
    sms: totalRefund > 0
      ? `Glass City: your booking ${booking.ref_code} is cancelled. A refund of ${refundFmt} (${policyLabel}) is being processed. Questions? (419) 654-3584`
      : `Glass City: your booking ${booking.ref_code} is cancelled. Per our policy, no refund applies. Questions? (419) 654-3584`,
    emailFn: () => emailSvc.sendCancellation(booking, summary, config.baseUrl),
  });

  return { ref_code: booking.ref_code, status: 'cancelled', summary, settlement };
}

module.exports = {
  depositDueCents,
  listCharges, listExtensions, createCharge, updateCharge, markChargePaidBySession,
  createExtension, markExtensionPaidBySession,
  finalizeReturn, cancelBooking, chargeTypeLabel, serializeCharge, serializeExtension,
};
