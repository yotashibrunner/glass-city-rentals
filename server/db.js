'use strict';

// Single shared pg connection pool for the whole app.
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // A pooled client errored while idle. Log it; the pool will replace it.
  console.error('[db] unexpected idle client error', err);
});

module.exports = {
  pool,
  // Thin query helper so callers don't need to grab/release clients for
  // one-off queries. Use pool.connect() directly for transactions.
  query: (text, params) => pool.query(text, params),
};
