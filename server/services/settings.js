'use strict';

// Business settings, stored as JSONB rows in the `settings` table. For now the
// only one the booking flow needs is the sales-tax rate. Plan §10 sets the
// default at 7.25% (Ohio state + Lucas County); Phase 5 may switch to Stripe
// Tax for multi-jurisdiction accuracy. Operators can override via a settings
// row without a code change.

const { query } = require('../db');

const DEFAULT_TAX_RATE = 0.0725;

async function getTaxRate() {
  try {
    const { rows } = await query("SELECT value FROM settings WHERE key = 'tax_rate'");
    if (rows.length) {
      const v = typeof rows[0].value === 'number' ? rows[0].value : Number(rows[0].value);
      if (Number.isFinite(v) && v >= 0 && v < 1) return v;
    }
  } catch (err) {
    console.error('[settings] tax_rate lookup failed, using default', err.message);
  }
  return DEFAULT_TAX_RATE;
}

module.exports = { getTaxRate, DEFAULT_TAX_RATE };
