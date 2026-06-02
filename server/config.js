'use strict';

// Centralized environment config. Loaded once, imported everywhere.
// dotenv only matters locally; on Railway the vars are injected directly.
require('dotenv').config();

function required(name, value) {
  if (value === undefined || value === '') {
    // We don't hard-crash in Phase 0/1 so the app can boot for the health
    // check and static site even before the DB is wired. Services that need
    // a missing var will fail loudly at point of use instead.
    console.warn(`[config] ${name} is not set`);
  }
  return value;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,

  // Postgres connection string (Railway provides DATABASE_URL).
  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),

  // Whether to require TLS on the DB connection. Railway managed Postgres
  // needs SSL; local Postgres usually does not.
  dbSsl: process.env.DB_SSL === 'true',

  // Public base URL of the site, used for building absolute links (Stripe
  // redirect URLs, email links, .ics, etc.). Filled in from Phase 5 onward.
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  // ── Auth (Phase 2) ──────────────────────────────────────────────────
  // Secret used to sign operator JWTs. MUST be set in production; in dev we
  // fall back to a fixed string so the app boots, but tokens won't survive a
  // restart-with-real-secret and are not secure.
  jwtSecret: required('JWT_SECRET', process.env.JWT_SECRET) || 'dev-insecure-jwt-secret-change-me',
  // Short-lived access token; sent on every API call.
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  // Long-lived refresh token; used to mint new access tokens.
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL || '30d',
  // bcrypt cost factor for password hashing (plan §13: 12 rounds).
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,

  // ── Payments — Stripe (Phase 5) ─────────────────────────────────────
  // Optional: when unset, the booking flow still works up through signing;
  // the checkout step reports that payments aren't configured yet.
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  // ── Email — Resend (Phase 5) ────────────────────────────────────────
  // Optional: when unset, confirmation emails are skipped (logged, not sent).
  resendApiKey: process.env.RESEND_API_KEY || '',
  fromEmail: process.env.FROM_EMAIL || 'bookings@glasscitytrailerrentals.com',

  // ── Web Push — VAPID (Phase 8 / Session 3) ──────────────────────────
  // Optional: when unset, push subscribe/send are no-ops (logged). Generate a
  // keypair with `npm run generate-vapid`. The VAPID subject can be given as a
  // bare email via VAPID_EMAIL (preferred) or a full mailto: via VAPID_SUBJECT.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject:
    process.env.VAPID_SUBJECT
    || (process.env.VAPID_EMAIL ? `mailto:${process.env.VAPID_EMAIL}` : 'mailto:owner@glasscitytrailerrentals.com'),

  // ── SMS — Twilio (Phase 8 / Session 3) ──────────────────────────────
  // Optional: when unset, SMS sends are skipped (logged). Uses the Twilio REST
  // API directly (no SDK dependency). The "from" number accepts either
  // TWILIO_PHONE_NUMBER (preferred) or TWILIO_FROM_NUMBER.
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromNumber: process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER || '',
  // The owner's personal cell for SMS alerts (always texted on new bookings, in
  // addition to any operator-account phone numbers).
  operatorPhone: process.env.OPERATOR_PHONE || '',

  // ── Reporting / commission (audit + sales tracking) ─────────────────
  // Operator commission rate on net revenue (default 15%). OWNER_EMAIL is the
  // business owner's address; monthly statements go to it + operator accounts.
  commissionRate: (() => {
    const r = parseFloat(process.env.COMMISSION_RATE);
    return Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.15;
  })(),
  ownerEmail: process.env.OWNER_EMAIL || '',

  // ── Monitoring — Sentry (Phase 9) ───────────────────────────────────
  // Optional: when unset, error reporting is a no-op (errors still log to the
  // console). Set SENTRY_DSN to capture server errors.
  sentryDsn: process.env.SENTRY_DSN || '',

  // ── Public site URL (SEO) ───────────────────────────────────────────
  // Canonical absolute origin used to build sitemap.xml / robots.txt links.
  // Falls back to BASE_URL, then to the request host at runtime.
  siteUrl: (process.env.SITE_URL || process.env.BASE_URL || '').replace(/\/+$/, ''),

  // ── Marketing analytics (optional, env-gated) ───────────────────────
  // When unset, no analytics scripts are emitted (silent). GA4 measurement ID
  // (G-XXXXXXXXXX) and Meta/Facebook Pixel ID.
  googleAnalyticsId: process.env.GOOGLE_ANALYTICS_ID || '',
  facebookPixelId: process.env.FACEBOOK_PIXEL_ID || '',

  // Direct Google review link for the post-return review request (cron). When
  // unset, the review request is skipped.
  googleReviewLink: process.env.GOOGLE_REVIEW_LINK || '',
};

config.isProduction = config.env === 'production';

// Never run production auth on the insecure dev fallback secret — fail loudly
// at boot rather than silently issuing forgeable tokens.
if (config.isProduction && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
