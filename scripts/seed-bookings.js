'use strict';

// Seeds a handful of test bookings directly via SQL so the operator dashboard
// and schedule have real data to display before Stripe/email are wired up.
//
//   npm run seed:bookings          insert (or re-insert) the test bookings
//   npm run seed:bookings clean    remove all test data this script created
//
// All test bookings use ref codes prefixed 'TEST-' and a couple of throwaway
// customers, so the script is idempotent (it clears its own rows first) and
// fully reversible. Dates are anchored to UTC midnight to match how the rest of
// the app reasons about rental days (server/utils/date.js).

const { pool } = require('../server/db');
const { todayUTC, addDays } = require('../server/utils/date');
const { getTaxRate } = require('../server/services/settings');
const { buildAgreement, toPlainText, CONTRACT_VERSION } = require('../server/services/contract');

const REF_PREFIX = 'TEST-';

// Throwaway customers. Identified by these emails for find-or-create + cleanup.
const CUSTOMERS = [
  { key: 'marcus', name: 'Marcus Webb', email: 'test+marcus@glasscity.test', phone: '(419) 555-0142' },
  { key: 'dana', name: 'Dana Reyes', email: 'test+dana@glasscity.test', phone: '(419) 555-0173' },
  { key: 'sam', name: 'Sam Okafor', email: 'test+sam@glasscity.test', phone: '(567) 555-0198' },
];

// Test bookings, relative to today. `days` is the inclusive rental length;
// `startOffset` is days from today the rental starts (negative = in the past).
//   pickup-today : starts today, still 'paid' (awaiting pickup)  → Pickups Today
//   return-today : out now, last rental day is today             → Returns Today + Active
//   active-later : out now, due back in a few days               → Active
const BOOKINGS = [
  {
    ref: 'TEST-PICKUP', slug: 'dump', customer: 'marcus',
    startOffset: 0, days: 3, status: 'paid', pickedUp: false,
    notes: 'First-time renter — walk through the electric dump controls.',
  },
  {
    ref: 'TEST-RETURN', slug: 'car-hauler', customer: 'dana',
    startOffset: -2, days: 3, status: 'out', pickedUp: true,
    notes: 'Hauling a project car. Has own straps.',
  },
  {
    ref: 'TEST-ACTIVE', slug: 'enclosed', customer: 'sam',
    startOffset: -1, days: 4, status: 'out', pickedUp: true,
    notes: null,
  },
];

async function clean(client) {
  // Bookings first (FK to customers), then the throwaway customers.
  const delB = await client.query(
    "DELETE FROM bookings WHERE ref_code LIKE $1",
    [`${REF_PREFIX}%`]
  );
  const emails = CUSTOMERS.map((c) => c.email.toLowerCase());
  const delC = await client.query(
    'DELETE FROM customers WHERE lower(email) = ANY($1)',
    [emails]
  );
  return { bookings: delB.rowCount, customers: delC.rowCount };
}

async function findOrCreateCustomer(client, c) {
  const found = await client.query(
    'SELECT id FROM customers WHERE lower(email) = $1 LIMIT 1',
    [c.email.toLowerCase()]
  );
  if (found.rows.length) return found.rows[0].id;
  const ins = await client.query(
    'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
    [c.name, c.email.toLowerCase(), c.phone]
  );
  return ins.rows[0].id;
}

async function main() {
  const mode = process.argv[2];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cleared = await clean(client);

    if (mode === 'clean') {
      await client.query('COMMIT');
      console.log(`Removed ${cleared.bookings} test booking(s) and ${cleared.customers} test customer(s).`);
      return;
    }

    const taxRate = await getTaxRate();
    const today = todayUTC();

    // Look up the trailers we reference, by slug.
    const slugs = [...new Set(BOOKINGS.map((b) => b.slug))];
    const { rows: trailerRows } = await client.query(
      `SELECT id, slug, name, type, size_label, hitch_requirement, plug_requirement,
              daily_rate, flat_drop_off_cents, extra_day_cents, per_tire_cents
         FROM trailers WHERE slug = ANY($1)`,
      [slugs]
    );
    const trailers = Object.fromEntries(trailerRows.map((t) => [t.slug, t]));

    // Create / reuse the throwaway customers.
    const customerIds = {};
    for (const c of CUSTOMERS) customerIds[c.key] = await findOrCreateCustomer(client, c);

    for (const b of BOOKINGS) {
      const trailer = trailers[b.slug];
      if (!trailer) throw new Error(`Trailer '${b.slug}' not found — run 'npm run seed' first.`);

      const start = addDays(today, b.startOffset);
      const end = addDays(start, b.days); // exclusive end (midnight after last day)

      const dailyRate = trailer.daily_rate || 0;
      const baseAmount = dailyRate * b.days;
      const tax = Math.round(baseAmount * taxRate);
      const total = baseAmount + tax;
      const customer = CUSTOMERS.find((c) => c.key === b.customer);
      const pickedUpAt = b.pickedUp ? addDays(start, 0).toISOString() : null;

      const insert = await client.query(
        `INSERT INTO bookings
           (ref_code, trailer_id, customer_id, start_at, end_at, period_type, quantity,
            base_amount_cents, extra_charges_cents, tax_cents, total_cents, amount_paid_cents,
            status, picked_up_at, customer_notes,
            contract_version, contract_signed_at, contract_signed_name, contract_signed_ip)
         VALUES ($1,$2,$3,$4,$5,'day',$6,$7,0,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16)
         RETURNING id`,
        [
          b.ref, trailer.id, customerIds[b.customer],
          start.toISOString(), end.toISOString(), b.days,
          baseAmount, tax, total, total,
          b.status, pickedUpAt, b.notes,
          CONTRACT_VERSION, customer.name, '203.0.113.10',
        ]
      );
      const bookingId = insert.rows[0].id;

      // Store the immutable contract snapshot so the signed-contract PDF link
      // works end-to-end from the operator detail screen.
      const bookingRow = {
        ref_code: b.ref, start_at: start.toISOString(), end_at: end.toISOString(),
        period_type: 'day', quantity: b.days,
        base_amount_cents: baseAmount, extra_charges_cents: 0, tax_cents: tax, total_cents: total,
      };
      const agreement = buildAgreement({
        booking: bookingRow,
        trailer,
        customer: { name: customer.name, email: customer.email, phone: customer.phone },
      });
      await client.query(
        'UPDATE bookings SET contract_snapshot = $2 WHERE id = $1',
        [bookingId, toPlainText(agreement)]
      );

      console.log(`  ✓ ${b.ref} — ${customer.name} · ${trailer.name} · ${b.status}`);
    }

    await client.query('COMMIT');
    console.log(`\nSeeded ${BOOKINGS.length} test bookings (cleared ${cleared.bookings} prior).`);
    console.log("Open the operator PWA dashboard to see Pickups / Returns / Active.");
    console.log("Run 'npm run seed:bookings clean' to remove them.");
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seed failed:', err);
    pool.end();
    process.exit(1);
  });
