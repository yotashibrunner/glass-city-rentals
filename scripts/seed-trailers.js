'use strict';

// Seeds the fleet from the data baked into the original marketing site
// (index.html `const FLEET`). Idempotent: re-running updates rows by slug.
//
//   npm run seed
//
// All prices are stored in CENTS (no float math anywhere downstream).

const { pool } = require('../server/db');

const d = (dollars) => (dollars == null ? null : Math.round(dollars * 100));

const TRAILERS = [
  {
    slug: 'car-hauler',
    name: '7×20 Car Hauler / Equipment',
    type: 'trailer',
    size_label: '7×20 ft',
    photo_url: '/images/trailer-car-hauler.jpg',
    hourly_rate: d(25),
    daily_rate: d(120),
    weekly_rate: d(600),
    monthly_rate: d(1800),
    hitch_requirement: '2 5/16" ball',
    plug_requirement: '7-pin plug',
    min_hours: 2,
    display_order: 1,
  },
  {
    slug: 'enclosed',
    name: '6×12 Enclosed Cargo',
    type: 'trailer',
    size_label: '6×12 ft',
    photo_url: '/images/trailer-enclosed.jpg',
    hourly_rate: d(20),
    daily_rate: d(75),
    weekly_rate: d(350),
    monthly_rate: d(1100),
    hitch_requirement: '2" ball',
    plug_requirement: '4-pin plug',
    min_hours: 2,
    display_order: 2,
  },
  {
    slug: 'dump',
    name: '7×16×4 Dump Trailer (17 yd)',
    type: 'trailer',
    size_label: '7×16×4 ft',
    photo_url: '/images/trailer-dump.jpg',
    hourly_rate: d(30),
    daily_rate: d(150),
    weekly_rate: d(650),
    monthly_rate: d(1950),
    hitch_requirement: '2 5/16" ball',
    plug_requirement: '7-pin plug',
    min_hours: 2,
    display_order: 3,
  },
  {
    slug: 'utility',
    name: '6×12 Utility Trailer',
    type: 'trailer',
    size_label: '6×12 ft',
    photo_url: '/images/trailer-utility.jpg',
    hourly_rate: null, // not offered hourly
    daily_rate: d(50),
    weekly_rate: d(250),
    monthly_rate: d(750),
    hitch_requirement: '2" ball',
    plug_requirement: '4-pin plug',
    min_hours: null,
    display_order: 4,
  },
  {
    slug: 'roll25',
    name: '25-Yard Roll-Off Bin',
    type: 'dumpster',
    size_label: '25 yd',
    photo_url: '/images/trailer-25yard.jpg',
    // Dumpster flat pricing
    flat_drop_off_cents: d(420),
    flat_drop_off_days: 3,
    extra_day_cents: d(25),
    per_tire_cents: d(3),
    hitch_requirement: null,
    plug_requirement: null,
    description: 'Drop-off & pickup included. 3 days included, $25/extra day, $3/tire if tires found.',
    display_order: 5,
  },
];

const UPSERT = `
  INSERT INTO trailers (
    slug, name, type, size_label, description, photo_url,
    hourly_rate, daily_rate, weekly_rate, monthly_rate,
    flat_drop_off_cents, flat_drop_off_days, extra_day_cents, per_tire_cents,
    hitch_requirement, plug_requirement, min_hours, display_order
  ) VALUES (
    $1, $2, $3, $4, $5, $6,
    $7, $8, $9, $10,
    $11, $12, $13, $14,
    $15, $16, $17, $18
  )
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    size_label = EXCLUDED.size_label,
    description = EXCLUDED.description,
    photo_url = EXCLUDED.photo_url,
    hourly_rate = EXCLUDED.hourly_rate,
    daily_rate = EXCLUDED.daily_rate,
    weekly_rate = EXCLUDED.weekly_rate,
    monthly_rate = EXCLUDED.monthly_rate,
    flat_drop_off_cents = EXCLUDED.flat_drop_off_cents,
    flat_drop_off_days = EXCLUDED.flat_drop_off_days,
    extra_day_cents = EXCLUDED.extra_day_cents,
    per_tire_cents = EXCLUDED.per_tire_cents,
    hitch_requirement = EXCLUDED.hitch_requirement,
    plug_requirement = EXCLUDED.plug_requirement,
    min_hours = EXCLUDED.min_hours,
    display_order = EXCLUDED.display_order,
    updated_at = NOW()
`;

async function main() {
  for (const t of TRAILERS) {
    await pool.query(UPSERT, [
      t.slug,
      t.name,
      t.type,
      t.size_label ?? null,
      t.description ?? null,
      t.photo_url ?? null,
      t.hourly_rate ?? null,
      t.daily_rate ?? null,
      t.weekly_rate ?? null,
      t.monthly_rate ?? null,
      t.flat_drop_off_cents ?? null,
      t.flat_drop_off_days ?? null,
      t.extra_day_cents ?? null,
      t.per_tire_cents ?? null,
      t.hitch_requirement ?? null,
      t.plug_requirement ?? null,
      t.min_hours ?? null,
      t.display_order ?? 0,
    ]);
    console.log(`  ✓ ${t.slug} — ${t.name}`);
  }

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM trailers');
  console.log(`Seeded fleet. trailers table now has ${rows[0].n} rows.`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seed failed:', err);
    pool.end();
    process.exit(1);
  });
