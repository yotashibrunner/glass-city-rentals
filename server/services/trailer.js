'use strict';

// Trailer reads for the public/customer surface. Only the fields a customer
// should see are selected — no internal flags beyond `status` (so the page can
// show "currently unavailable"). Only `active` rows are listed publicly.

const { query } = require('../db');

const PUBLIC_COLUMNS = [
  'id', 'slug', 'name', 'type', 'size_label', 'description', 'photo_url',
  'hourly_rate', 'daily_rate', 'weekly_rate', 'monthly_rate',
  'flat_drop_off_cents', 'flat_drop_off_days', 'extra_day_cents', 'per_tire_cents',
  'hitch_requirement', 'plug_requirement', 'specs', 'min_hours', 'status',
  'quantity_total', 'quantity_on_hold',
].join(', ');

async function getActiveTrailers() {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM trailers WHERE active = true ORDER BY display_order, name`
  );
  return rows;
}

async function getTrailerBySlug(slug) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM trailers WHERE slug = $1 AND active = true`,
    [slug]
  );
  return rows[0] || null;
}

async function getTrailerById(id) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM trailers WHERE id = $1 AND active = true`,
    [id]
  );
  return rows[0] || null;
}

// First active dumpster — backs the dedicated /book/dumpster flow.
async function getDumpster() {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM trailers
     WHERE active = true AND type = 'dumpster' ORDER BY display_order, name LIMIT 1`
  );
  return rows[0] || null;
}

module.exports = { getActiveTrailers, getTrailerBySlug, getTrailerById, getDumpster };
