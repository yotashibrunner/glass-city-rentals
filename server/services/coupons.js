'use strict';

// Coupons / discount codes. Codes are case-insensitive. Discounts are computed
// server-side and never trusted from the client. use_count only increments when
// a booking is actually PAID (recordUse, called from the Stripe webhook), so an
// abandoned checkout doesn't burn a coupon.

const crypto = require('crypto');
const { pool, query } = require('../db');
const { formatCents } = require('../utils/money');

const DISCOUNT_TYPES = new Set(['percentage', 'flat', 'free_delivery']);

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Unambiguous code alphabet (no 0/O/1/I) for an auto-generated 6-char code.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// Discount in cents for a coupon against a given base subtotal. free_delivery
// applies only when the customer chose delivery (and equals the delivery fee).
function computeDiscount(coupon, baseCents, deliveryFeeCents = 0, fulfillment = 'pickup') {
  const base = Math.max(0, Number(baseCents) || 0);
  if (coupon.discount_type === 'percentage') {
    const pct = Math.max(0, Math.min(100, Number(coupon.discount_value) || 0));
    return Math.min(base, Math.round(base * pct / 100));
  }
  if (coupon.discount_type === 'flat') {
    return Math.min(base, Math.max(0, Number(coupon.discount_value) || 0));
  }
  if (coupon.discount_type === 'free_delivery') {
    return fulfillment === 'delivery' ? Math.max(0, Number(deliveryFeeCents) || 0) : 0;
  }
  return 0;
}

function couponByCode(code) {
  return query('SELECT * FROM coupons WHERE lower(code) = lower($1) LIMIT 1', [String(code || '').trim()])
    .then((r) => r.rows[0] || null);
}

// Validate a code for a (trailer, base subtotal). Returns a structured result
// with a clear message for each failure case. `valid` is false on any failure.
async function validateCoupon({ code, trailerId, baseAmountCents }) {
  const base = Math.max(0, Number(baseAmountCents) || 0);
  const fail = (message) => ({ valid: false, message });

  if (!code || !String(code).trim()) return fail('Enter a discount code.');
  const coupon = await couponByCode(code);
  if (!coupon) return fail('That code isn’t valid.');
  if (!coupon.active) return fail('That code is no longer active.');
  if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) return fail('That code has expired.');
  if (coupon.max_uses != null && coupon.use_count >= coupon.max_uses) return fail('That code has reached its usage limit.');
  if (coupon.min_booking_cents && base < coupon.min_booking_cents) {
    return fail(`This code needs a minimum of ${formatCents(coupon.min_booking_cents)} before tax.`);
  }
  if (coupon.trailer_id && trailerId && coupon.trailer_id !== trailerId) {
    return fail('That code doesn’t apply to this trailer.');
  }

  const discountApplied = computeDiscount(coupon, base);
  const isFreeDelivery = coupon.discount_type === 'free_delivery';
  const message = isFreeDelivery
    ? 'Free delivery applied — choose delivery at the next step.'
    : `Discount applied: −${formatCents(discountApplied)}`;
  return {
    valid: true,
    coupon_id: coupon.id,
    code: coupon.code,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    discount_applied_cents: discountApplied,
    final_amount_cents: Math.max(0, base - discountApplied),
    free_delivery: isFreeDelivery,
    message,
  };
}

// Server-side resolution used by createBooking. Throws a tagged error when the
// code is present but invalid, so the customer is told rather than silently
// charged full price. Returns { couponId, discountCents } (zeros when no code).
async function resolveForBooking({ code, trailerId, baseAmountCents, deliveryFeeCents, fulfillment }) {
  if (!code || !String(code).trim()) return { couponId: null, discountCents: 0 };
  const result = await validateCoupon({ code, trailerId, baseAmountCents });
  if (!result.valid) throw badRequest(result.message);
  const coupon = await couponByCode(code);
  const discountCents = computeDiscount(coupon, baseAmountCents, deliveryFeeCents, fulfillment);
  return { couponId: coupon.id, discountCents };
}

// Record a coupon use on payment (idempotent via the unique index on
// coupon_uses.booking_id). Increments use_count only on first insert.
async function recordUse(couponId, bookingId, discountCents) {
  if (!couponId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO coupon_uses (coupon_id, booking_id, discount_applied_cents)
       VALUES ($1,$2,$3) ON CONFLICT (booking_id) DO NOTHING RETURNING id`,
      [couponId, bookingId, Math.max(0, Number(discountCents) || 0)]
    );
    if (ins.rows.length) {
      await client.query('UPDATE coupons SET use_count = use_count + 1 WHERE id = $1', [couponId]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[coupons] recordUse failed:', err.message);
  } finally {
    client.release();
  }
}

// ── Operator CRUD ───────────────────────────────────────────────────────────
function serialize(c) {
  return {
    ...c,
    value_fmt: c.discount_type === 'percentage' ? `${c.discount_value}%`
      : c.discount_type === 'free_delivery' ? 'Free delivery' : formatCents(c.discount_value),
    min_booking_fmt: formatCents(c.min_booking_cents || 0),
  };
}

async function listCoupons() {
  const { rows } = await query(
    `SELECT c.*, t.name AS trailer_name
       FROM coupons c LEFT JOIN trailers t ON t.id = c.trailer_id
      ORDER BY c.active DESC, c.created_at DESC`
  );
  return rows.map(serialize);
}

async function createCoupon(body, adminId) {
  const discountType = String(body.discount_type || '').trim();
  if (!DISCOUNT_TYPES.has(discountType)) throw badRequest("discount_type must be 'percentage', 'flat', or 'free_delivery'.");

  let discountValue = parseInt(body.discount_value, 10);
  if (discountType === 'free_delivery') discountValue = 0;
  else if (!Number.isInteger(discountValue) || discountValue <= 0) throw badRequest('A positive discount value is required.');
  else if (discountType === 'percentage' && discountValue > 100) throw badRequest('A percentage discount cannot exceed 100.');

  let code = String(body.code || '').trim().toUpperCase();
  if (!code) code = generateCode();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw badRequest('Code must be 3–32 letters, numbers, hyphen, or underscore.');

  const minBooking = Math.max(0, parseInt(body.min_booking_cents, 10) || 0);
  const maxUses = body.max_uses == null || body.max_uses === '' ? null : Math.max(1, parseInt(body.max_uses, 10) || 0) || null;
  const trailerId = body.trailer_id && /^[0-9a-f-]{36}$/i.test(body.trailer_id) ? body.trailer_id : null;
  const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw badRequest('Invalid expiry date.');

  try {
    const { rows } = await query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, min_booking_cents,
                            max_uses, trailer_id, expires_at, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING *`,
      [code, (body.description || '').trim() || null, discountType, discountValue, minBooking,
        maxUses, trailerId, expiresAt ? expiresAt.toISOString() : null, adminId || null]
    );
    return serialize(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw badRequest('That code already exists.', 409);
    throw e;
  }
}

async function updateCoupon(id, patch) {
  const sets = [];
  const values = [];
  const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };
  if (patch.active !== undefined) {
    if (typeof patch.active !== 'boolean') throw badRequest('active must be true or false.');
    push('active', patch.active);
  }
  if (patch.description !== undefined) push('description', (patch.description || '').trim() || null);
  if (patch.expires_at !== undefined) {
    const d = patch.expires_at ? new Date(patch.expires_at) : null;
    if (d && Number.isNaN(d.getTime())) throw badRequest('Invalid expiry date.');
    push('expires_at', d ? d.toISOString() : null);
  }
  if (patch.max_uses !== undefined) {
    const m = patch.max_uses == null || patch.max_uses === '' ? null : Math.max(1, parseInt(patch.max_uses, 10) || 0) || null;
    push('max_uses', m);
  }
  if (!sets.length) throw badRequest('No fields to update.');
  values.push(id);
  const { rows } = await query(`UPDATE coupons SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
  if (!rows.length) throw badRequest('Coupon not found.', 404);
  return serialize(rows[0]);
}

async function deleteCoupon(id) {
  const { rows } = await query('SELECT use_count FROM coupons WHERE id = $1', [id]);
  if (!rows.length) throw badRequest('Coupon not found.', 404);
  if (rows[0].use_count > 0) throw badRequest('This coupon has been used and cannot be deleted — deactivate it instead.', 409);
  await query('DELETE FROM coupons WHERE id = $1', [id]);
  return { ok: true };
}

module.exports = {
  validateCoupon, resolveForBooking, computeDiscount, recordUse, generateCode,
  listCoupons, createCoupon, updateCoupon, deleteCoupon,
};
