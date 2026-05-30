'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');

const app = express();

// Railway terminates TLS at its edge proxy; trust it so req.ip / secure
// cookies behave correctly behind the proxy.
app.set('trust proxy', 1);

// EJS server-rendered pages live in server/views.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
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
app.use(express.static(publicDir));

// --- 404 ---
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// --- Centralized error handler ---
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: 'Internal Server Error' });
});

const server = app.listen(config.port, () => {
  console.log(`Glass City Rentals listening on :${config.port} (${config.env})`);
});

// Graceful shutdown so Railway redeploys don't drop in-flight requests.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
