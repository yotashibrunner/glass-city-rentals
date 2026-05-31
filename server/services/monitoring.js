'use strict';

// Error monitoring via Sentry. Guarded by SENTRY_DSN: with no DSN, init is a
// no-op and reportError just relies on console logging (done by the caller).
// Kept tiny on purpose — we only capture server-side exceptions.

const config = require('../config');

let Sentry = null;
let enabled = false;

function init() {
  if (!config.sentryDsn) return false;
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: config.sentryDsn,
      environment: config.env,
      // Errors only by default; turn on tracing later if needed.
      tracesSampleRate: 0,
    });
    enabled = true;
    console.log('[monitoring] Sentry initialized');
  } catch (err) {
    console.error('[monitoring] Sentry init failed:', err.message);
  }
  return enabled;
}

function isEnabled() {
  return enabled;
}

// Capture a server error. Attaches the request method/path when available.
// Safe to call whether or not Sentry is configured.
function reportError(err, req) {
  if (!enabled || !Sentry) return;
  try {
    Sentry.withScope((scope) => {
      if (req) {
        scope.setContext('request', { method: req.method, path: req.path });
      }
      Sentry.captureException(err);
    });
  } catch (e) {
    // Never let error reporting throw.
  }
}

module.exports = { init, isEnabled, reportError };
