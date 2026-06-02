'use strict';

// Reminders cron. Two modes (Railway runs both on different schedules):
//
//   node scripts/send-reminders.js          (default "morning", run ~8am daily)
//     - 24-hour customer reminders (email + SMS) for bookings starting tomorrow
//     - morning operator summary SMS/push
//
//   node scripts/send-reminders.js hourly    (run hourly)
//     - 1-hour-before push for pickups, deliveries, and retrievals
//
// All sends are best-effort and safe to run when channels are unconfigured
// (they log and skip). Times are wall-clock UTC (see server/utils/date.js).

const { pool } = require('../server/db');
const config = require('../server/config');
const bookingSvc = require('../server/services/booking');
const notifySvc = require('../server/services/notify');
const pushSvc = require('../server/services/push');
const smsSvc = require('../server/services/sms');
const emailSvc = require('../server/services/email');
const { todayUTC, addDays } = require('../server/utils/date');

const REMINDER_SELECT = `
  SELECT b.id, b.ref_code, b.start_at, b.end_at, b.status, b.fulfillment, b.delivery_address,
         t.name AS trailer_name,
         c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone
    FROM bookings b
    JOIN trailers t ON t.id = b.trailer_id
    JOIN customers c ON c.id = b.customer_id`;

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return null;
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}
function fmtDay(iso) {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ── Morning: operator summary + 24h customer reminders ────────────────────
async function runMorning(baseUrl) {
  // Operator morning summary, in the requested format.
  const { pickups, dropoffs, retrievals, returns } = await bookingSvc.getDashboard();
  const nReturns = returns.length + retrievals.length;
  const starts = [...pickups, ...dropoffs]
    .map((b) => new Date(b.start_at)).filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);
  let firstStr = '';
  if (starts.length) {
    const t = fmtTime(starts[0].toISOString());
    if (t) firstStr = ` First at ${t}.`;
  }
  const summary = `Good morning. Today: ${pickups.length} pickups, ${dropoffs.length} deliveries, ${nReturns} returns.${firstStr} — Glass City`;
  console.log(`[reminders] ${summary}`);
  await notifySvc.notifyOperatorSummary(summary, baseUrl);

  // 24-hour customer reminders for anything happening tomorrow.
  const tomorrow = addDays(todayUTC(), 1);
  const dayAfter = addDays(tomorrow, 1);
  const t1 = tomorrow.toISOString();
  const t2 = dayAfter.toISOString();

  const { rows: pickupSoon } = await pool.query(
    `${REMINDER_SELECT} WHERE b.status IN ('paid','confirmed') AND b.start_at >= $1 AND b.start_at < $2`,
    [t1, t2]
  );
  const { rows: returnSoon } = await pool.query(
    `${REMINDER_SELECT} WHERE b.status = 'out' AND b.end_at > $1 AND b.end_at <= $2`,
    [t1, t2]
  );

  console.log(`[reminders] ${pickupSoon.length} pickup reminder(s), ${returnSoon.length} return reminder(s)`);
  for (const b of pickupSoon) await remindCustomer(b, 'pickup', baseUrl);
  for (const b of returnSoon) await remindCustomer(b, 'return', baseUrl);
}

// Email + SMS the customer about tomorrow's pickup/return.
async function remindCustomer(b, kind, baseUrl) {
  const isDelivery = b.fulfillment === 'delivery';
  const verb = kind === 'pickup' ? (isDelivery ? 'delivery' : 'pickup') : (isDelivery ? 'pickup of your bin' : 'return');
  console.log(`  ${kind} → ${b.ref_code} (${b.customer_email || 'no email'} / ${b.customer_phone || 'no phone'})`);
  await emailSvc.sendBookingReminder(b, kind, baseUrl).catch((e) => console.error('   email:', e.message));
  if (b.customer_phone) {
    const time = fmtTime(b.start_at);
    const msg = `Glass City reminder: your ${b.trailer_name} ${verb} is tomorrow (${fmtDay(b.start_at)})${time ? ' at ' + time : ''}. Ref ${b.ref_code}. Questions? (419) 654-3584`;
    await smsSvc.sendSMS(b.customer_phone, msg).catch((e) => console.error('   sms:', e.message));
  }
}

// ── Hourly: 1-hour-before push for pickups / deliveries / retrievals ──────
async function runHourly(baseUrl) {
  // Window ≈ the next hour: [now+60min, now+120min). Run hourly so each booking
  // lands in exactly one window, ~1 hour before its time.
  const now = Date.now();
  const from = new Date(now + 60 * 60000).toISOString();
  const to = new Date(now + 120 * 60000).toISOString();

  const { rows: starting } = await pool.query(
    `${REMINDER_SELECT} WHERE b.status IN ('paid','confirmed') AND b.start_at >= $1 AND b.start_at < $2 ORDER BY b.start_at`,
    [from, to]
  );
  const { rows: retrievals } = await pool.query(
    `${REMINDER_SELECT} WHERE b.status = 'out' AND b.fulfillment = 'delivery' AND b.end_at >= $1 AND b.end_at < $2 ORDER BY b.end_at`,
    [from, to]
  );

  console.log(`[reminders:hourly] ${starting.length} upcoming start(s), ${retrievals.length} retrieval(s)`);
  for (const b of starting) {
    const isDelivery = b.fulfillment === 'delivery';
    await pushSvc.sendToOperators({
      title: `${isDelivery ? 'Delivery' : 'Pickup'} in ~1 hour`,
      body: `${b.customer_name} · ${b.trailer_name}${fmtTime(b.start_at) ? ' · ' + fmtTime(b.start_at) : ''}${isDelivery && b.delivery_address ? ' · ' + b.delivery_address : ''}`,
      url: `${baseUrl || ''}/operator/?booking=${b.id}`,
      tag: `soon-${b.id}`,
    });
  }
  for (const b of retrievals) {
    await pushSvc.sendToOperators({
      title: 'Retrieval in ~1 hour',
      body: `${b.customer_name} · ${b.trailer_name}${b.delivery_address ? ' · ' + b.delivery_address : ''}`,
      url: `${baseUrl || ''}/operator/?booking=${b.id}`,
      tag: `retrieve-${b.id}`,
    });
  }
}

// ── Post-return review request ────────────────────────────────────────────
// ~4 hours after a return, ask the customer for a Google review (once). The
// window floor (24h) avoids ever messaging pre-feature/old returns; the ceiling
// (3.5h) gives the customer a beat after drop-off. review_requested_at guards
// against duplicates. Skipped entirely when GOOGLE_REVIEW_LINK is unset.
async function runReviewRequests(baseUrl) {
  if (!config.googleReviewLink) {
    console.log('[reminders] GOOGLE_REVIEW_LINK not set — skipping review requests');
    return;
  }
  const now = Date.now();
  const floor = new Date(now - 24 * 60 * 60000).toISOString();   // not older than 24h
  const ceiling = new Date(now - 3.5 * 60 * 60000).toISOString(); // at least 3.5h ago

  const { rows } = await pool.query(
    `${REMINDER_SELECT}
      WHERE b.status = 'returned' AND b.review_requested_at IS NULL
        AND b.returned_at >= $1 AND b.returned_at <= $2`,
    [floor, ceiling]
  );
  console.log(`[reminders] ${rows.length} review request(s)`);
  const link = config.googleReviewLink;
  for (const b of rows) {
    await emailSvc.sendReviewRequest(b, link, baseUrl).catch((e) => console.error('   review email:', e.message));
    if (b.customer_phone) {
      const msg = `Thanks for renting with Glass City! Hope everything went smoothly. A quick Google review would mean a lot to us: ${link}`;
      await smsSvc.sendSMS(b.customer_phone, msg).catch((e) => console.error('   review sms:', e.message));
    }
    await pool.query('UPDATE bookings SET review_requested_at = NOW() WHERE id = $1', [b.id])
      .catch((e) => console.error('   review flag:', e.message));
  }
}

async function main() {
  const mode = process.argv[2] === 'hourly' ? 'hourly' : 'morning';
  const baseUrl = config.baseUrl;
  if (mode === 'hourly') await runHourly(baseUrl);
  else await runMorning(baseUrl);
  // Review requests run in both modes (idempotent) so a missed hourly run is
  // still caught by the next pass.
  await runReviewRequests(baseUrl);
  console.log('[reminders] done');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Reminders failed:', err);
    pool.end();
    process.exit(1);
  });
