'use strict';

// Sales / commission reporting. Revenue is recognized on a booking's created_at
// (the sale date; online bookings are paid within minutes of creation) and only
// bookings that actually collected money (amount_paid_cents > 0) count.
//
// Money model (all integer cents):
//   gross      = total charged
//   stripe fee = estimated 2.9% + $0.30 per paid booking
//   net        = gross - stripe fee
//   commission = net * COMMISSION_RATE (operator's cut, default 15%)
//   retainer   = flat monthly fee by revenue tier (below)
//   total due  = commission + retainer
// Adjust COMMISSION_RATE (env) and RETAINER_TIERS to your actual agreement.

const { query } = require('../db');
const config = require('../config');
const { formatCents } = require('../utils/money');

const COMMISSION_RATE = config.commissionRate;

// Flat monthly retainer by gross-revenue tier. Highest matching tier wins.
const RETAINER_TIERS = [
  { name: 'Starter', minGrossCents: 0, retainerCents: 0 },
  { name: 'Growth', minGrossCents: 300000, retainerCents: 15000 },   // ≥ $3,000 → $150
  { name: 'Scale', minGrossCents: 750000, retainerCents: 30000 },    // ≥ $7,500 → $300
];

function tierFor(grossCents) {
  let tier = RETAINER_TIERS[0];
  for (const t of RETAINER_TIERS) if (grossCents >= t.minGrossCents) tier = t;
  return tier;
}

// Estimated Stripe processing fee for a charge (2.9% + 30¢).
function stripeFee(totalCents) {
  return totalCents > 0 ? Math.round(totalCents * 0.029) + 30 : 0;
}

// UTC month window [from, to). month is 1-12.
function monthRange(month, year) {
  const m = Math.min(12, Math.max(1, parseInt(month, 10)));
  const y = parseInt(year, 10);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const label = from.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { from: from.toISOString(), to: to.toISOString(), label, month: m, year: y };
}

// Paid bookings (money collected) created within [from, to).
async function paidBookingsInRange(from, to) {
  const { rows } = await query(
    `SELECT b.ref_code, b.created_at, b.start_at, b.end_at, b.status, b.fulfillment,
            b.total_cents, b.amount_paid_cents, b.base_amount_cents, b.tax_cents, b.delivery_fee_cents,
            t.name AS trailer_name, t.slug AS trailer_slug,
            c.name AS customer_name, c.phone AS customer_phone
       FROM bookings b
       JOIN trailers t ON t.id = b.trailer_id
       JOIN customers c ON c.id = b.customer_id
      WHERE b.amount_paid_cents > 0 AND b.created_at >= $1 AND b.created_at < $2
      ORDER BY b.created_at`,
    [from, to]
  );
  return rows;
}

// One booking → its financial breakdown.
function lineFor(b) {
  const gross = b.total_cents;
  const fee = stripeFee(gross);
  const net = gross - fee;
  const commission = Math.round(net * COMMISSION_RATE);
  return { gross, fee, net, commission };
}

function summarize(rows) {
  let gross = 0; let fees = 0; let net = 0; let commission = 0;
  for (const b of rows) {
    const l = lineFor(b);
    gross += l.gross; fees += l.fee; net += l.net; commission += l.commission;
  }
  const tier = tierFor(gross);
  const retainer = tier.retainerCents;
  const totalDue = commission + retainer;
  return {
    booking_count: rows.length,
    commission_rate: COMMISSION_RATE,
    gross_cents: gross, stripe_fees_cents: fees, net_cents: net,
    commission_cents: commission,
    retainer_tier: tier.name, retainer_cents: retainer,
    total_due_cents: totalDue,
    // Formatted for display.
    gross_fmt: formatCents(gross), stripe_fees_fmt: formatCents(fees), net_fmt: formatCents(net),
    commission_fmt: formatCents(commission), retainer_fmt: formatCents(retainer), total_due_fmt: formatCents(totalDue),
  };
}

async function summary(from, to) {
  return summarize(await paidBookingsInRange(from, to));
}

async function byTrailer(from, to) {
  const rows = await paidBookingsInRange(from, to);
  const total = rows.reduce((s, b) => s + b.total_cents, 0) || 1;
  const map = new Map();
  for (const b of rows) {
    const key = b.trailer_slug;
    const e = map.get(key) || { trailer: b.trailer_name, slug: key, count: 0, gross_cents: 0 };
    e.count += 1; e.gross_cents += b.total_cents;
    map.set(key, e);
  }
  return [...map.values()]
    .sort((a, b) => b.gross_cents - a.gross_cents)
    .map((e) => ({ ...e, gross_fmt: formatCents(e.gross_cents), pct: Math.round((e.gross_cents / total) * 1000) / 10 }));
}

async function bookingsBreakdown(from, to) {
  const rows = await paidBookingsInRange(from, to);
  return rows.map((b) => {
    const l = lineFor(b);
    return {
      ref_code: b.ref_code,
      date: b.created_at,
      customer_name: b.customer_name, customer_phone: b.customer_phone,
      trailer_name: b.trailer_name,
      start_at: b.start_at, end_at: b.end_at,
      status: b.status, fulfillment: b.fulfillment,
      gross_cents: l.gross, stripe_fee_cents: l.fee, net_cents: l.net, commission_cents: l.commission,
      gross_fmt: formatCents(l.gross), stripe_fee_fmt: formatCents(l.fee), net_fmt: formatCents(l.net), commission_fmt: formatCents(l.commission),
    };
  });
}

// Full statement for a month: range label, itemized bookings, totals.
async function statement(month, year) {
  const range = monthRange(month, year);
  const rows = await paidBookingsInRange(range.from, range.to);
  return {
    label: range.label, month: range.month, year: range.year,
    from: range.from, to: range.to,
    totals: summarize(rows),
    items: await bookingsBreakdown(range.from, range.to),
  };
}

// CSV export of the per-booking breakdown.
function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dollars = (c) => (c / 100).toFixed(2);
  const dateOnly = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
  const header = ['ref_code', 'date', 'customer_name', 'phone', 'trailer', 'start', 'end',
    'gross', 'stripe_fee', 'net', 'commission', 'status', 'fulfillment'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.ref_code, dateOnly(r.date), r.customer_name, r.customer_phone, r.trailer_name,
      dateOnly(r.start_at), dateOnly(r.end_at),
      dollars(r.gross_cents), dollars(r.stripe_fee_cents), dollars(r.net_cents), dollars(r.commission_cents),
      r.status, r.fulfillment,
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

module.exports = {
  COMMISSION_RATE, RETAINER_TIERS,
  monthRange, summary, byTrailer, bookingsBreakdown, statement, toCsv, stripeFee,
};
