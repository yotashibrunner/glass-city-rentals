'use strict';

// Date-only helpers for the booking calendar. Rentals are reasoned about in
// whole calendar days; we anchor each day to UTC midnight so day math never
// drifts with the server's local timezone. (Toledo is Eastern; this is close
// enough for the 60-day availability horizon and is revisited if hour-level
// scheduling needs true local time.)

const DAY_MS = 86400000;

// Accepts a Date or an ISO string; returns 'YYYY-MM-DD'.
function toDateOnly(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' (or longer ISO) -> Date at UTC midnight, or null if unparseable.
function parseDateOnly(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(date, n) {
  return new Date(date.getTime() + n * DAY_MS);
}

// Inclusive day count between two date strings: same day = 1, returns null if
// invalid or end precedes start.
function inclusiveDays(startStr, endStr) {
  const a = parseDateOnly(startStr);
  const b = parseDateOnly(endStr);
  if (!a || !b) return null;
  const diff = Math.round((b - a) / DAY_MS);
  return diff < 0 ? null : diff + 1;
}

// Today at UTC midnight.
function todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

module.exports = { DAY_MS, toDateOnly, parseDateOnly, addDays, inclusiveDays, todayUTC };
