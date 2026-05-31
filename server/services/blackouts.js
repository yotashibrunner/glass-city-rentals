'use strict';

// Blackouts block a trailer (or, with a NULL trailer_id, the whole fleet) for a
// date range — maintenance, owner vacation, etc. They feed the same
// availability surface as bookings (services/availability.js getBusyRanges), so
// creating one here immediately makes those days unavailable on the
// customer-facing calendar.
//
// Operators think in inclusive dates ("block Dec 24–26"), but the schema stores
// an exclusive end (the midnight after the last blocked day), matching the
// booking convention. We convert on the way in and back out on the way out.

const { pool, query } = require('../db');
const { parseDateOnly, addDays, toDateOnly } = require('../utils/date');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badRequest(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Shape a row for the API: expose the inclusive end date the operator entered,
// plus a fleet-wide flag and trailer label.
function serialize(row) {
  // end_at is the exclusive midnight after the last blocked day.
  const lastDay = toDateOnly(addDays(new Date(row.end_at), -1));
  return {
    id: row.id,
    trailer_id: row.trailer_id,
    trailer_name: row.trailer_id ? row.trailer_name : null,
    trailer_slug: row.trailer_id ? row.trailer_slug : null,
    fleet_wide: !row.trailer_id,
    start_date: toDateOnly(row.start_at),
    end_date: lastDay,
    start_at: row.start_at,
    end_at: row.end_at,
    reason: row.reason,
    created_at: row.created_at,
  };
}

const SELECT = `
  SELECT b.id, b.trailer_id, b.start_at, b.end_at, b.reason, b.created_at,
         t.name AS trailer_name, t.slug AS trailer_slug
    FROM blackouts b
    LEFT JOIN trailers t ON t.id = b.trailer_id`;

async function listBlackouts() {
  const { rows } = await query(`${SELECT} ORDER BY b.start_at, t.name`);
  return rows.map(serialize);
}

// Blackouts overlapping [from, to) — for the calendar view.
async function getBlackoutsInRange(from, to) {
  const { rows } = await query(
    `${SELECT} WHERE b.start_at < $2 AND b.end_at > $1 ORDER BY b.start_at, t.name`,
    [from, to]
  );
  return rows.map(serialize);
}

// Create a blackout. `trailer_id` null/empty blocks the whole fleet. `start` and
// `end` are inclusive 'YYYY-MM-DD' dates. Runs in a transaction with an audit
// entry. Returns the serialized row.
async function createBlackout({ trailer_id, start, end, reason }, adminUserId) {
  const startD = parseDateOnly(start);
  const endD = parseDateOnly(end);
  if (!startD || !endD) throw badRequest('Valid start and end dates are required.');
  if (endD < startD) throw badRequest('The end date must be on or after the start date.');
  const endExclusive = addDays(endD, 1); // store exclusive end (midnight after last day)

  let trailerId = null;
  if (trailer_id) {
    if (!UUID_RE.test(trailer_id)) throw badRequest('Invalid trailer id.');
    const t = await query('SELECT id FROM trailers WHERE id = $1', [trailer_id]);
    if (!t.rows.length) throw badRequest('Trailer not found.', 404);
    trailerId = trailer_id;
  }

  const reasonText =
    typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO blackouts (trailer_id, start_at, end_at, reason)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [trailerId, startD.toISOString(), endExclusive.toISOString(), reasonText]
    );
    await client.query(
      `INSERT INTO audit_log (admin_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'blackout.create', 'blackout', $2, $3)`,
      [adminUserId || null, ins.rows[0].id, JSON.stringify({
        trailer_id: trailerId, start: toDateOnly(startD), end: toDateOnly(endD),
      })]
    );
    await client.query('COMMIT');

    const { rows } = await query(`${SELECT} WHERE b.id = $1`, [ins.rows[0].id]);
    return serialize(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Delete a blackout. Returns true if a row was removed.
async function deleteBlackout(id, adminUserId) {
  if (!UUID_RE.test(id)) throw badRequest('Invalid blackout id.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query('DELETE FROM blackouts WHERE id = $1 RETURNING id', [id]);
    if (!del.rows.length) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO audit_log (admin_user_id, action, entity_type, entity_id, details)
       VALUES ($1, 'blackout.delete', 'blackout', $2, '{}'::jsonb)`,
      [adminUserId || null, id]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { listBlackouts, getBlackoutsInRange, createBlackout, deleteBlackout };
