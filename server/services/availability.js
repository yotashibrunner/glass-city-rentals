'use strict';

// Availability for multi-unit inventory. A SKU (trailer/bin) can own several
// interchangeable units (quantity_total), some manually held out of service
// (quantity_on_hold). A given window is bookable while fewer than
// capacity = quantity_total - quantity_on_hold occupying bookings overlap it.
//
// Two sources still block a unit:
//   1. Bookings that occupy the trailer (anything not cancelled/returned)
//   2. Blackouts — treated as closing ALL units for the range (e.g. vacation);
//      a NULL trailer_id blackout applies to every trailer.
// The customer-facing calendar paints a day unavailable only when EVERY unit is
// booked (or a blackout covers it).

const { query } = require('../db');

const DAY_MS = 86400000;
const OCCUPYING_STATUSES = ['pending', 'signed', 'paid', 'confirmed', 'out'];

// Bookable units for a SKU = owned minus held. Never negative.
function capacity(trailer) {
  return Math.max(0, (trailer.quantity_total ?? 1) - (trailer.quantity_on_hold ?? 0));
}

// How many occupying bookings overlap [from, to). Optionally exclude one id.
// `db` lets callers run it inside a transaction client.
async function countOverlapping(trailerId, from, to, excludeId, db) {
  const q = db || { query };
  const params = [trailerId, OCCUPYING_STATUSES, from, to];
  let sql = `SELECT count(*)::int AS n FROM bookings
              WHERE trailer_id = $1 AND status = ANY($2)
                AND start_at < $4 AND end_at > $3`;
  if (excludeId) { params.push(excludeId); sql += ` AND id <> $5`; }
  const { rows } = await q.query(sql, params);
  return rows[0].n;
}

// Per-day busy ranges over [from, to) for the customer calendar. A day is busy
// when a blackout covers it, or all units are booked that day (overlap count >=
// capacity). For a single-unit SKU this is identical to the old behavior.
// `trailer` must carry id + quantity fields.
async function getBusyRanges(trailer, from, to) {
  const cap = capacity(trailer);

  const { rows: bookings } = await query(
    `SELECT start_at, end_at FROM bookings
      WHERE trailer_id = $1 AND status = ANY($2)
        AND start_at < $4 AND end_at > $3`,
    [trailer.id, OCCUPYING_STATUSES, from, to]
  );
  const { rows: blackouts } = await query(
    `SELECT start_at, end_at, reason FROM blackouts
      WHERE (trailer_id = $1 OR trailer_id IS NULL)
        AND start_at < $3 AND end_at > $2`,
    [trailer.id, from, to]
  );

  const bk = bookings.map((r) => ({ s: Date.parse(r.start_at), e: Date.parse(r.end_at) }));
  const bo = blackouts.map((r) => ({ s: Date.parse(r.start_at), e: Date.parse(r.end_at), reason: r.reason }));

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const busy = [];
  for (let t = fromMs; t < toMs; t += DAY_MS) {
    const ds = t;
    const de = t + DAY_MS;
    const black = bo.find((x) => x.s < de && x.e > ds);
    let reason = null;
    if (black) {
      reason = black.reason || 'unavailable';
    } else {
      const count = bk.filter((x) => x.s < de && x.e > ds).length;
      if (cap <= 0 || count >= cap) reason = 'booked';
    }
    if (reason) {
      // Coalesce a run of same-reason busy days into one range.
      const last = busy[busy.length - 1];
      if (last && last.reason === reason && Date.parse(last.end_at) === ds) {
        last.end_at = new Date(de).toISOString();
      } else {
        busy.push({ start_at: new Date(ds).toISOString(), end_at: new Date(de).toISOString(), reason });
      }
    }
  }
  return busy;
}

module.exports = { getBusyRanges, countOverlapping, capacity, OCCUPYING_STATUSES };
