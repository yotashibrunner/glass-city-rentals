'use strict';

// Reminders cron (plan §8). Run once daily (e.g. early morning) via Railway's
// cron / an external scheduler:
//
//   npm run reminders
//
// It does two things, both best-effort and safe to run when channels are
// unconfigured (sends are logged and skipped):
//   1. Operator daily summary — today's pickups / returns / active, via push + SMS.
//   2. 24-hour customer reminders — emails customers whose pickup or return is
//      tomorrow.
// Idempotency note: this is intended to run once per day. Running it twice sends
// duplicate reminders; schedule it on a single daily trigger.

const { pool } = require('../server/db');
const config = require('../server/config');
const bookingSvc = require('../server/services/booking');
const notifySvc = require('../server/services/notify');
const emailSvc = require('../server/services/email');
const { todayUTC, addDays } = require('../server/utils/date');

const REMINDER_SELECT = `
  SELECT b.id, b.ref_code, b.start_at, b.end_at, b.status,
         t.name AS trailer_name,
         c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
    FROM bookings b
    JOIN trailers t ON t.id = b.trailer_id
    JOIN customers c ON c.id = b.customer_id`;

async function main() {
  const baseUrl = config.baseUrl;

  // 1. Operator morning summary.
  const { pickups, returns, active } = await bookingSvc.getDashboard();
  const summary = `Today: ${pickups.length} pickup(s), ${returns.length} return(s), ${active.length} out.`;
  console.log(`[reminders] operator summary — ${summary}`);
  await notifySvc.notifyOperatorSummary(summary, baseUrl);

  // 2. 24-hour customer reminders. "Tomorrow" anchored to UTC midnight.
  const tomorrow = addDays(todayUTC(), 1);
  const dayAfter = addDays(tomorrow, 1);
  const t1 = tomorrow.toISOString();
  const t2 = dayAfter.toISOString();

  // Pickups tomorrow: confirmed rentals starting within tomorrow.
  const { rows: pickupSoon } = await pool.query(
    `${REMINDER_SELECT}
      WHERE b.status IN ('paid','confirmed') AND b.start_at >= $1 AND b.start_at < $2`,
    [t1, t2]
  );
  // Returns tomorrow: out rentals whose last day is tomorrow (exclusive end = dayAfter).
  const { rows: returnSoon } = await pool.query(
    `${REMINDER_SELECT}
      WHERE b.status = 'out' AND b.end_at > $1 AND b.end_at <= $2`,
    [t1, t2]
  );

  console.log(`[reminders] ${pickupSoon.length} pickup reminder(s), ${returnSoon.length} return reminder(s)`);
  for (const b of pickupSoon) {
    console.log(`  pickup → ${b.ref_code} (${b.customer_email || 'no email'})`);
    await emailSvc.sendBookingReminder(b, 'pickup', baseUrl).catch((e) => console.error('  ', e.message));
  }
  for (const b of returnSoon) {
    console.log(`  return → ${b.ref_code} (${b.customer_email || 'no email'})`);
    await emailSvc.sendBookingReminder(b, 'return', baseUrl).catch((e) => console.error('  ', e.message));
  }

  console.log('[reminders] done');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Reminders failed:', err);
    pool.end();
    process.exit(1);
  });
