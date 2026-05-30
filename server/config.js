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
};

config.isProduction = config.env === 'production';

module.exports = config;
