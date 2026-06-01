'use strict';

// Transactional email via Resend. Guarded by RESEND_API_KEY: with no key,
// sends are logged and skipped so the booking flow never fails on email.

const { Resend } = require('resend');
const config = require('../config');
const { formatCents } = require('../utils/money');

let client = null;
function getClient() {
  if (!config.resendApiKey) return null;
  if (!client) client = new Resend(config.resendApiKey);
  return client;
}

function isConfigured() {
  return !!config.resendApiKey;
}

async function sendBookingConfirmation(booking, pdfBuffer, baseUrl) {
  const resend = getClient();
  if (!resend) {
    console.log(`[email] Resend not configured — skipping confirmation for ${booking.ref_code}`);
    return { skipped: true };
  }
  if (!booking.customer_email) {
    console.log(`[email] no email on file for ${booking.ref_code} — skipping`);
    return { skipped: true };
  }

  const ref = booking.ref_code;
  const isDelivery = booking.fulfillment === 'delivery';
  const td = 'style="padding:4px 12px 4px 0;color:#555"';

  // Requested time-of-day (stored on start_at as wall-clock UTC; null at midnight).
  const sd = new Date(booking.start_at);
  const hasTime = !(sd.getUTCHours() === 0 && sd.getUTCMinutes() === 0);
  const timeStr = hasTime
    ? sd.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
    : null;
  const timeLabel = isDelivery ? 'Delivery time' : (booking.trailer_type === 'dumpster' ? 'Drop-off time' : 'Pickup time');

  const rows = [
    `<tr><td ${td}>Equipment</td><td><strong>${booking.trailer_name}</strong></td></tr>`,
    `<tr><td ${td}>Reference</td><td>${ref}</td></tr>`,
    `<tr><td ${td}>Fulfillment</td><td>${isDelivery ? 'Delivery' : 'Customer pickup'}</td></tr>`,
    isDelivery && booking.delivery_address ? `<tr><td ${td}>Address</td><td>${booking.delivery_address}</td></tr>` : '',
    timeStr ? `<tr><td ${td}>${timeLabel}</td><td><strong>${timeStr}</strong></td></tr>` : '',
    `<tr><td ${td}>Total paid</td><td>${formatCents(booking.total_cents)}</td></tr>`,
  ].filter(Boolean).join('');

  const logistics = isDelivery
    ? `We’ll deliver to <strong>${booking.delivery_address || 'your address'}</strong>${timeStr ? ` around <strong>${timeStr}</strong>` : ''} and pick it back up.`
    : `Pickup at 2004 Front Street, Toledo, OH 43605 (7am–7pm)${timeStr ? `, around <strong>${timeStr}</strong>` : ''}.`;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:560px">
      <h2 style="color:#1faa30">Booking confirmed — ${ref}</h2>
      <p>Hi ${booking.customer_name || 'there'}, your Glass City Trailer Rentals booking is confirmed and paid.</p>
      <table style="font-size:14px;border-collapse:collapse">${rows}</table>
      <p>${logistics} Your signed rental agreement is attached as a PDF.</p>
      <p><a href="${baseUrl}/book/${ref}" style="color:#1faa30">View your booking</a></p>
      <p style="color:#888;font-size:12px">Glass City Trailer Rentals LLC · (419) 654-3584</p>
    </div>`;

  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: `Your Glass City booking ${ref} is confirmed`,
    html,
    attachments: pdfBuffer
      ? [{ filename: `rental-agreement-${ref}.pdf`, content: pdfBuffer }]
      : undefined,
  });
}

// 24-hour reminder email (driven by the reminders cron). `kind` is 'pickup' or
// 'return'. Guarded like the confirmation send.
async function sendBookingReminder(booking, kind, baseUrl) {
  const resend = getClient();
  if (!resend) {
    console.log(`[email] Resend not configured — skipping ${kind} reminder for ${booking.ref_code}`);
    return { skipped: true };
  }
  if (!booking.customer_email) return { skipped: true };

  const ref = booking.ref_code;
  const isPickup = kind === 'pickup';
  const action = isPickup
    ? 'Your pickup is tomorrow.'
    : 'Your rental is due back tomorrow.';
  const detail = isPickup
    ? 'Pickup is at 2004 Front Street, Toledo, OH 43605 (7am–7pm). Bring a properly rated tow vehicle.'
    : 'Please return to 2004 Front Street, Toledo, OH 43605 (7am–7pm) by end of day to avoid late charges.';

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:560px">
      <h2 style="color:#1faa30">Reminder — ${ref}</h2>
      <p>Hi ${booking.customer_name || 'there'}, ${action}</p>
      <table style="font-size:14px;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#555">Equipment</td><td><strong>${booking.trailer_name}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#555">Reference</td><td>${ref}</td></tr>
      </table>
      <p>${detail}</p>
      <p><a href="${baseUrl || ''}/book/${ref}" style="color:#1faa30">View your booking</a></p>
      <p style="color:#888;font-size:12px">Glass City Trailer Rentals LLC · (419) 654-3584</p>
    </div>`;

  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: isPickup ? `Reminder: pickup tomorrow (${ref})` : `Reminder: return due tomorrow (${ref})`,
    html,
  });
}

// Send a simple test email and surface the real outcome (including Resend's
// error, e.g. an unverified sending domain) so an admin can diagnose delivery.
async function sendTest(to) {
  const resend = getClient();
  if (!resend) return { skipped: true, reason: 'RESEND_API_KEY is not set on the server.' };
  if (!to) return { error: 'No recipient email.' };
  try {
    const { data, error } = await resend.emails.send({
      from: config.fromEmail,
      to,
      subject: 'Glass City — test email ✅',
      html:
        '<div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:520px">'
        + '<h2 style="color:#1faa30">Email is working</h2>'
        + '<p>This is a test from your Glass City operator app. If it reached you, '
        + 'booking confirmations will send too.</p>'
        + `<p style="color:#888;font-size:12px">Sent from ${config.fromEmail}</p></div>`,
    });
    if (error) return { error: error.message || (typeof error === 'string' ? error : JSON.stringify(error)) };
    return { id: data && data.id };
  } catch (e) {
    return { error: e.message };
  }
}

// Email the monthly statement PDF to one or more recipients. Returns
// {id}/{skipped}/{error} so callers can report the outcome.
async function sendStatement(recipients, pdf, statement) {
  const resend = getClient();
  if (!resend) return { skipped: true, reason: 'RESEND_API_KEY is not set.' };
  const to = (Array.isArray(recipients) ? recipients : [recipients])
    .map((e) => (e || '').trim()).filter(Boolean);
  if (!to.length) return { skipped: true, reason: 'No recipients (set OWNER_EMAIL and/or operator emails).' };

  const t = statement.totals;
  const td = 'style="padding:4px 14px 4px 0;color:#555"';
  const html = `
    <div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:560px">
      <h2 style="color:#1faa30">Operator statement — ${statement.label}</h2>
      <table style="font-size:14px;border-collapse:collapse">
        <tr><td ${td}>Bookings</td><td>${t.booking_count}</td></tr>
        <tr><td ${td}>Gross revenue</td><td>${t.gross_fmt}</td></tr>
        <tr><td ${td}>Stripe fees</td><td>- ${t.stripe_fees_fmt}</td></tr>
        <tr><td ${td}>Net revenue</td><td><strong>${t.net_fmt}</strong></td></tr>
        <tr><td ${td}>Commission (${(t.commission_rate * 100).toFixed(0)}%)</td><td>${t.commission_fmt}</td></tr>
        <tr><td ${td}>Retainer (${t.retainer_tier})</td><td>${t.retainer_fmt}</td></tr>
        <tr><td ${td}><strong>Total due to operator</strong></td><td><strong style="color:#1faa30">${t.total_due_fmt}</strong></td></tr>
      </table>
      <p>The full itemized statement is attached as a PDF.</p>
      <p style="color:#888;font-size:12px">${'Glass City Trailer Rentals LLC'} · (419) 654-3584</p>
    </div>`;

  const filename = `glass-city-statement-${statement.year}-${String(statement.month).padStart(2, '0')}.pdf`;
  try {
    const { data, error } = await resend.emails.send({
      from: config.fromEmail,
      to,
      subject: `Glass City operator statement — ${statement.label}`,
      html,
      attachments: pdf ? [{ filename, content: pdf }] : undefined,
    });
    if (error) return { error: error.message || JSON.stringify(error) };
    return { id: data && data.id, to };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { isConfigured, sendBookingConfirmation, sendBookingReminder, sendTest, sendStatement };
