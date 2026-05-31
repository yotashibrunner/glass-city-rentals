'use strict';

// SMS via the Twilio REST API (no SDK — a single form-encoded POST). Guarded by
// the Twilio credentials: with none set, sends are logged and skipped so the
// booking flow never fails on SMS. Used as the backup channel to Web Push.

const config = require('../config');
const { query } = require('../db');

function isConfigured() {
  return !!(config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber);
}

// Send one SMS. Returns { sid } on success, { skipped } when unconfigured, or
// { error } on failure — never throws (callers treat SMS as best-effort).
async function sendSms(to, body) {
  if (!isConfigured()) {
    console.log(`[sms] Twilio not configured — skipping SMS to ${to}: ${body}`);
    return { skipped: true };
  }
  if (!to) return { skipped: true };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`;
  const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
  const form = new URLSearchParams({ To: to, From: config.twilioFromNumber, Body: body });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[sms] Twilio error ${res.status}:`, data.message || '');
      return { error: data.message || `HTTP ${res.status}` };
    }
    return { sid: data.sid };
  } catch (err) {
    console.error('[sms] send failed:', err.message);
    return { error: err.message };
  }
}

// Text every opted-in operator who has a phone number on file. Never throws.
async function notifyOperators(body) {
  if (!isConfigured()) {
    console.log(`[sms] Twilio not configured — skipping operator SMS: ${body}`);
    return { skipped: true, sent: 0 };
  }
  let recipients;
  try {
    const { rows } = await query(
      `SELECT phone FROM admin_users
        WHERE notify_via_sms = true AND phone IS NOT NULL AND phone <> ''`
    );
    recipients = rows;
  } catch (err) {
    console.error('[sms] could not load operators:', err.message);
    return { sent: 0, error: err.message };
  }

  let sent = 0;
  for (const r of recipients) {
    const result = await sendSms(r.phone, body);
    if (result.sid) sent++;
  }
  return { sent };
}

module.exports = { isConfigured, sendSms, notifyOperators };
