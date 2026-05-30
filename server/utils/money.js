'use strict';

// Money helpers. Every amount in the system is an integer number of cents —
// no floats are ever stored or math'd. These helpers only format / derive.

// 12000 -> "$120", 50408 -> "$504.08", null -> null.
function formatCents(cents) {
  if (cents == null) return null;
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

// Sales tax on a base amount, rounded to the nearest cent.
function calcTax(baseCents, rate) {
  return Math.round(baseCents * rate);
}

module.exports = { formatCents, calcTax };
