'use strict';

// Operator notifications orchestrator. Composes the message once and fans it out
// over both channels (Web Push + Twilio SMS) in parallel. Every send is
// best-effort and swallowed — a notification failure must never break the
// booking flow that triggered it.

const push = require('./push');
const sms = require('./sms');
const { formatCents } = require('../utils/money');

function fmtDay(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Fire push + SMS together; resolve once both settle. Returns per-channel result.
async function dispatch({ push: pushPayload, sms: smsText }) {
  const [pushRes, smsRes] = await Promise.allSettled([
    push.sendToOperators(pushPayload),
    sms.notifyOperators(smsText),
  ]);
  return {
    push: pushRes.status === 'fulfilled' ? pushRes.value : { error: String(pushRes.reason) },
    sms: smsRes.status === 'fulfilled' ? smsRes.value : { error: String(smsRes.reason) },
  };
}

// New paid booking → alert the operator(s) on every channel.
async function notifyNewBooking(booking, baseUrl) {
  const ref = booking.ref_code;
  const when = fmtDay(booking.start_at);
  const summary = `${booking.customer_name || 'Customer'} · ${booking.trailer_name || 'Trailer'} · ${when}`;
  const url = `${baseUrl || ''}/operator/?booking=${booking.id}`;

  return dispatch({
    push: {
      title: `New booking — ${ref}`,
      body: summary,
      url,
      tag: `booking-${booking.id}`,
    },
    sms:
      `Glass City: new booking ${ref}. ${summary}. ` +
      `${formatCents(booking.total_cents)} paid. ${booking.customer_phone || ''}`.trim(),
  });
}

// Daily operator summary (used by the reminders cron). `text` is a prebuilt
// single-line summary.
async function notifyOperatorSummary(text, baseUrl) {
  return dispatch({
    push: { title: 'Today at Glass City', body: text, url: `${baseUrl || ''}/operator/`, tag: 'daily-summary' },
    sms: `Glass City — ${text}`,
  });
}

module.exports = { notifyNewBooking, notifyOperatorSummary, dispatch };
