'use strict';

// Web Push (VAPID) to operator devices. Guarded by the VAPID keys: with no keys
// configured, subscribe/send are no-ops (logged) so the booking flow never
// fails on notifications. Subscriptions live on admin_users.push_subscription.

const webpush = require('web-push');
const config = require('../config');
const { pool, query } = require('../db');

let configured = false;
if (config.vapidPublicKey && config.vapidPrivateKey) {
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  configured = true;
}

function isConfigured() {
  return configured;
}

function getPublicKey() {
  return config.vapidPublicKey || null;
}

// A valid PushSubscription has at least an https endpoint.
function isValidSubscription(sub) {
  return !!(sub && typeof sub === 'object' && typeof sub.endpoint === 'string'
    && /^https?:\/\//.test(sub.endpoint));
}

async function saveSubscription(adminUserId, subscription) {
  if (!isValidSubscription(subscription)) {
    const err = new Error('A valid push subscription is required.');
    err.status = 400;
    throw err;
  }
  await query('UPDATE admin_users SET push_subscription = $2 WHERE id = $1',
    [adminUserId, JSON.stringify(subscription)]);
}

async function clearSubscription(adminUserId) {
  await query('UPDATE admin_users SET push_subscription = NULL WHERE id = $1', [adminUserId]);
}

// Send to one stored subscription. Returns { ok } or { expired } so callers can
// prune dead subscriptions (browsers return 404/410 once a sub is gone).
async function sendToSubscription(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return { expired: true };
    console.error('[push] send failed:', err.statusCode || '', err.message);
    return { ok: false, error: err.message };
  }
}

// Fan out a notification to every opted-in operator with a stored subscription.
// Prunes subscriptions the push service reports as gone. Never throws.
async function sendToOperators(payload) {
  if (!configured) {
    console.log(`[push] VAPID not configured — skipping push "${payload.title}"`);
    return { skipped: true, sent: 0 };
  }
  let recipients;
  try {
    const { rows } = await query(
      `SELECT id, push_subscription FROM admin_users
        WHERE notify_via_push = true AND push_subscription IS NOT NULL`
    );
    recipients = rows;
  } catch (err) {
    console.error('[push] could not load subscriptions:', err.message);
    return { sent: 0, error: err.message };
  }

  let sent = 0;
  let pruned = 0;
  for (const r of recipients) {
    const sub = typeof r.push_subscription === 'string'
      ? JSON.parse(r.push_subscription) : r.push_subscription;
    const result = await sendToSubscription(sub, payload);
    if (result.ok) sent++;
    else if (result.expired) {
      pruned++;
      await pool.query('UPDATE admin_users SET push_subscription = NULL WHERE id = $1', [r.id])
        .catch(() => {});
    }
  }
  if (pruned) console.log(`[push] pruned ${pruned} expired subscription(s)`);
  return { sent, pruned };
}

module.exports = {
  isConfigured, getPublicKey, saveSubscription, clearSubscription,
  sendToSubscription, sendToOperators,
};
