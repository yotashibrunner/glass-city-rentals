'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
const monitoring = require('./services/monitoring');

// Initialize error monitoring as early as possible (no-op without SENTRY_DSN).
monitoring.init();
const { reportError } = monitoring;

const app = express();

// Railway terminates TLS at its edge proxy; trust it so req.ip / secure
// cookies behave correctly behind the proxy.
app.set('trust proxy', 1);

// EJS server-rendered pages live in server/views.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Marketing analytics tags (GA4 + Pixel), env-gated. Exposed to every EJS view
// via app.locals so each <head> can include them; empty string when unset.
const analytics = require('./services/analytics');
app.locals.analyticsHead = analytics.headTags();
app.locals.facebookPixelId = analytics.PIXEL_ID;
app.locals.siteUrl = config.siteUrl;

// Stripe webhook needs the raw request body to verify the signature, so it is
// registered before the JSON body parser. Use type: '*/*' so the raw body is
// captured regardless of the Content-Type Stripe sends.
const webhookRoutes = require('./routes/webhooks');
app.use('/webhooks', express.raw({ type: '*/*' }), webhookRoutes);

app.use(express.json({ limit: '1mb' })); // headroom for base64 signature images
app.use(express.urlencoded({ extended: true }));

const authRoutes = require('./routes/auth');
const operatorRoutes = require('./routes/api-operator');
const apiPublicRoutes = require('./routes/api-public');
const publicPageRoutes = require('./routes/public');
const { requireAuth } = require('./middleware/auth');

// --- Health check (Phase 0 acceptance) ---
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// --- JSON API ---
// Auth endpoints are public (login/refresh); everything under /api/operator
// requires a valid access token.
app.use('/api/auth', authRoutes);
app.use('/api/operator', requireAuth, operatorRoutes);
// Public customer API (trailers, availability, quote). No auth.
app.use('/api', apiPublicRoutes);

// --- Operator PWA (Phase 2) ---
// Single-page app served from operator/. Mounted before the static marketing
// site so /operator/* resolves here. express.static serves index.html for both
// /operator and /operator/. The service worker must be served with no-cache so
// clients pick up new versions immediately, and its scope is the /operator/
// subtree (it lives at the root of that path).
const operatorDir = path.join(__dirname, '..', 'operator');
app.use(
  '/operator',
  express.static(operatorDir, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('service-worker.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/operator/');
      }
    },
  })
);

// --- Server-rendered booking pages (Phase 4) ---
// Trailer detail + availability calendar at /fleet/:slug and the dedicated
// roll-off flow at /book/dumpster. Unknown slugs fall through to the 404.
app.use('/', publicPageRoutes);

// --- Static marketing site, served at / ---
// Placed after explicit routes so /health and /fleet/* win. index.html is the
// directory index, so GET / serves the existing marketing page unchanged.
const publicDir = path.join(__dirname, '..', 'public');

// The marketing homepage is a static file, so it can't read env vars to gate
// analytics. When analytics is configured, inject the tags into <head> once at
// boot and serve that cached HTML for GET / (otherwise express.static serves
// the file untouched).
if (app.locals.analyticsHead) {
  try {
    const homepageHtml = require('fs')
      .readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replace('</head>', `${app.locals.analyticsHead}\n</head>`);
    app.get('/', (req, res) => res.type('html').send(homepageHtml));
  } catch (e) {
    console.error('[analytics] homepage injection skipped:', e.message);
  }
}

app.use(express.static(publicDir));

// API/webhook requests get JSON; browser page requests get a rendered HTML page.
function wantsJson(req) {
  return req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')
    || (req.get('accept') || '').includes('application/json');
}

// --- 404 ---
app.use((req, res) => {
  if (wantsJson(req)) {
    return res.status(404).json({ error: 'Not Found' });
  }
  res.status(404).render('error', {
    code: 404,
    title: 'Page not found',
    message: "We couldn't find that page — it may have moved or the link may be out of date. Head back home or give us a call.",
  });
});

// --- Centralized error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  reportError(err, req);
  const status = err.status || 500;
  if (wantsJson(req)) {
    return res.status(status).json({ error: status === 500 ? 'Internal Server Error' : (err.message || 'Error') });
  }
  res.status(status).render('error', {
    code: status,
    title: status === 404 ? 'Page not found' : 'Something went wrong',
    message: status === 404
      ? "We couldn't find that page — head back home or give us a call."
      : 'Something went wrong on our end. Please try again in a moment, or call us directly and we’ll sort it out.',
  });
});

const server = app.listen(config.port, () => {
  console.log(`Glass City Rentals listening on :${config.port} (${config.env})`);
  // One-line integration readiness check — handy for diagnosing why an
  // email/SMS/push didn't fire after a deploy.
  const on = (v) => (v ? 'on' : 'OFF');
  console.log(
    '[integrations] '
    + `stripe=${on(config.stripeSecretKey)} webhook_secret=${on(config.stripeWebhookSecret)} `
    + `resend=${on(config.resendApiKey)} push=${on(config.vapidPublicKey && config.vapidPrivateKey)} `
    + `twilio=${on(config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber)} `
    + `operator_phone=${on(config.operatorPhone)}`
  );
});

// Graceful shutdown so Railway redeploys don't drop in-flight requests.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
