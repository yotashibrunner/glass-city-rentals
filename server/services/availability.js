'use strict';

// Availability = the busy windows that block a trailer. Two sources:
//   1. Bookings that still occupy the trailer (anything not cancelled/returned)
//   2. Blackouts (maintenance, owner vacation) — a NULL trailer_id blackout
//      applies to every trailer
// Returned ranges overlap the requested [from, to] window. The customer-facing
// calendar paints any day touching a busy range as unavailable.

const { query } = require('../db');

const OCCUPYING_STATUSES = ['pending', 'signed', 'paid', 'confirmed', 'out'];

async function getBusyRanges(trailerId, from, to) {
  const { rows: bookings } = await query(
    `SELECT start_at, end_at FROM bookings
      WHERE trailer_id = $1
        AND status = ANY($2)
        AND start_at < $4 AND end_at > $3
      ORDER BY start_at`,
    [trailerId, OCCUPYING_STATUSES, from, to]
  );

  const { rows: blackouts } = await query(
    `SELECT start_at, end_at, reason FROM blackouts
      WHERE (trailer_id = $1 OR trailer_id IS NULL)
        AND start_at < $3 AND end_at > $2
      ORDER BY start_at`,
    [trailerId, from, to]
  );

  return [
    ...bookings.map((r) => ({ start_at: r.start_at, end_at: r.end_at, reason: 'booked' })),
    ...blackouts.map((r) => ({ start_at: r.start_at, end_at: r.end_at, reason: r.reason || 'unavailable' })),
  ];
}

module.exports = { getBusyRanges, OCCUPYING_STATUSES };
