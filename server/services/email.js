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
    : `Pickup at 4041 Navarre Ave, Oregon, OH 43616 (7am–7pm)${timeStr ? `, around <strong>${timeStr}</strong>` : ''}.`;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:560px">
      <h2 style="color:#1faa30">Booking confirmed — ${ref}</h2>
      <p>Hi ${booking.customer_name || 'there'}, your Glass City Trailer Rentals booking is confirmed and paid.</p>
      <table style="font-size:14px;border-collapse:collapse">${rows}</table>
      <p>${logistics} Your signed rental agreement is attached as a PDF.</p>
      <p><a href="${baseUrl}/book/${ref}" style="color:#1faa30">View your booking</a></p>
      <p style="font-size:13px;color:#555">Need to make changes? <a href="${baseUrl}/my-booking?ref=${ref}" style="color:#1faa30">Manage your booking</a> (view details or cancel).</p>
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
    ? 'Pickup is at 4041 Navarre Ave, Oregon, OH 43616 (7am–7pm). Bring a properly rated tow vehicle.'
    : 'Please return to 4041 Navarre Ave, Oregon, OH 43616 (7am–7pm) by end of day to avoid late charges.';

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

// Shared shell so the new transactional emails match the confirmation styling.
function shell(title, bodyHtml) {
  return `
    <div style="font-family:Arial,sans-serif;color:#0a0d0a;max-width:560px">
      <h2 style="color:#1faa30">${title}</h2>
      ${bodyHtml}
      <p style="color:#888;font-size:12px">Glass City Trailer Rentals LLC · (419) 654-3584</p>
    </div>`;
}

function payButton(link) {
  if (!link) return '';
  return `<p><a href="${link}" style="background:#1faa30;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Pay now</a></p>`;
}

// Notify the customer of a post-rental additional charge (damage, tires, etc.).
async function sendChargeNotice(booking, charge, paymentLink, baseUrl) {
  const resend = getClient();
  if (!resend) return { skipped: true };
  if (!booking.customer_email) return { skipped: true };
  const onCard = charge.billing_method === 'card_on_file';
  const body = `
    <p>Hi ${booking.customer_name || 'there'}, a charge has been added to your rental <strong>${booking.ref_code}</strong> (${booking.trailer_name}).</p>
    <table style="font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#555">Reason</td><td><strong>${charge.type_label}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555">Details</td><td>${charge.description}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555">Amount</td><td><strong>${charge.amount_fmt}</strong></td></tr>
    </table>
    ${onCard
      ? '<p>This amount was charged to the card on file.</p>'
      : `<p>Please pay the amount due online.</p>${payButton(paymentLink)}`}`;
  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: `${charge.type_label} charge — Glass City ${booking.ref_code}`,
    html: shell(`Charge added — ${booking.ref_code}`, body),
  });
}

// Notify the customer their rental was extended + the fee is due.
async function sendExtensionNotice(booking, extension, paymentLink, newReturnFmt, baseUrl) {
  const resend = getClient();
  if (!resend) return { skipped: true };
  if (!booking.customer_email) return { skipped: true };
  const days = extension.days_extended;
  const body = `
    <p>Hi ${booking.customer_name || 'there'}, your <strong>${booking.trailer_name}</strong> rental (${booking.ref_code}) has been extended.</p>
    <table style="font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#555">New return date</td><td><strong>${newReturnFmt}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555">Extra days</td><td>${days}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#555">Extension fee</td><td><strong>${extension.extension_fee_fmt}</strong></td></tr>
    </table>
    <p>Please complete the extension fee payment to confirm your new return date.</p>
    ${payButton(paymentLink)}`;
  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: `Rental extended to ${newReturnFmt} — Glass City ${booking.ref_code}`,
    html: shell(`Rental extended — ${booking.ref_code}`, body),
  });
}

// Notify the customer of the return outcome + deposit settlement.
async function sendDepositOutcome(booking, summary, baseUrl) {
  const resend = getClient();
  if (!resend) return { skipped: true };
  if (!booking.customer_email) return { skipped: true };
  const dRows = (summary.deductions || []).map((d) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555">${({
      damage: 'Damage', tonnage_overage: 'Tonnage overage', prohibited_items: 'Prohibited items',
      tires: 'Tires', late_return: 'Late return', other: 'Other', deposit_deduction: 'Deduction',
    })[d.charge_type] || 'Charge'}</td><td>${formatCents(d.amount_cents)}</td></tr>`).join('');
  const body = summary.clean
    ? `<p>Hi ${booking.customer_name || 'there'}, thanks for returning your <strong>${booking.trailer_name}</strong> (${booking.ref_code}) in good condition.</p>
       ${summary.deposit_cents > 0 ? `<p>Your <strong>${formatCents(summary.deposit_cents)}</strong> security deposit is being refunded to your original payment method (typically 3–5 business days).</p>` : ''}`
    : `<p>Hi ${booking.customer_name || 'there'}, here's the summary for your returned rental <strong>${booking.ref_code}</strong> (${booking.trailer_name}).</p>
       <table style="font-size:14px;border-collapse:collapse">
         ${dRows}
         <tr><td style="padding:6px 12px 4px 0;color:#555"><strong>Total deductions</strong></td><td><strong>${formatCents(summary.total_deductions_cents)}</strong></td></tr>
         ${summary.deposit_cents > 0 ? `<tr><td style="padding:4px 12px 4px 0;color:#555">Deposit held</td><td>${formatCents(summary.deposit_cents)}</td></tr>` : ''}
         ${summary.refund_cents > 0 ? `<tr><td style="padding:4px 12px 4px 0;color:#555">Deposit refunded</td><td><strong>${formatCents(summary.refund_cents)}</strong></td></tr>` : ''}
         ${summary.overage_cents > 0 ? `<tr><td style="padding:4px 12px 4px 0;color:#555">Charged to card on file</td><td><strong>${formatCents(summary.overage_cents)}</strong></td></tr>` : ''}
       </table>
       ${summary.refund_cents > 0 ? '<p>Refunds typically post in 3–5 business days.</p>' : ''}`;
  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: `Return summary — Glass City ${booking.ref_code}`,
    html: shell(`Return processed — ${booking.ref_code}`, body),
  });
}

// Notify the customer their booking was cancelled + the refund outcome.
async function sendCancellation(booking, summary, baseUrl) {
  const resend = getClient();
  if (!resend) return { skipped: true };
  if (!booking.customer_email) return { skipped: true };
  const body = `
    <p>Hi ${booking.customer_name || 'there'}, your booking <strong>${booking.ref_code}</strong> (${booking.trailer_name}) has been cancelled.</p>
    <table style="font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#555">Cancellation policy</td><td>${summary.policy}</td></tr>
      ${summary.rental_refund_cents > 0 ? `<tr><td style="padding:4px 12px 4px 0;color:#555">Rental refund</td><td>${formatCents(summary.rental_refund_cents)}</td></tr>` : ''}
      ${summary.deposit_refund_cents > 0 ? `<tr><td style="padding:4px 12px 4px 0;color:#555">Deposit refund</td><td>${formatCents(summary.deposit_refund_cents)}</td></tr>` : ''}
      <tr><td style="padding:6px 12px 4px 0;color:#555"><strong>Total refund</strong></td><td><strong>${formatCents(summary.total_refund_cents)}</strong></td></tr>
    </table>
    ${summary.total_refund_cents > 0 ? '<p>Refunds typically post to your original payment method in 3–5 business days.</p>' : '<p>Per our cancellation policy, no refund applies to this cancellation.</p>'}`;
  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: `Booking ${booking.ref_code} cancelled — Glass City`,
    html: shell(`Booking cancelled — ${booking.ref_code}`, body),
  });
}

// Post-return review request (~4h after a return). Guarded like the rest.
async function sendReviewRequest(booking, reviewLink, baseUrl) {
  const resend = getClient();
  if (!resend) return { skipped: true };
  if (!booking.customer_email) return { skipped: true };
  const body = `
    <p>Hi ${booking.customer_name || 'there'}, thanks for renting the <strong>${booking.trailer_name}</strong> from Glass City Trailer Rentals — we hope everything went smoothly.</p>
    <p>If you have a minute, a quick Google review would mean a lot to a small local business like ours and helps other folks find us.</p>
    ${payButton(reviewLink)}
    <p style="font-size:13px;color:#555">Or paste this link: <a href="${reviewLink}">${reviewLink}</a></p>
    <p>Need a trailer or dumpster again? <a href="${baseUrl || ''}/" style="color:#1faa30">Book online anytime.</a></p>`;
  return resend.emails.send({
    from: config.fromEmail,
    to: booking.customer_email,
    subject: 'How did it go? Leave Glass City a quick review',
    html: shell('Thanks for renting with Glass City!', body),
  });
}

module.exports = {
  isConfigured, sendBookingConfirmation, sendBookingReminder, sendTest, sendStatement,
  sendChargeNotice, sendExtensionNotice, sendDepositOutcome, sendCancellation, sendReviewRequest,
};
