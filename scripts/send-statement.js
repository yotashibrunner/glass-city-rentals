'use strict';

// Monthly operator statement cron. Runs on the 1st of each month and emails the
// PRIOR month's statement PDF to OWNER_EMAIL + all active operator/admin
// accounts. Best-effort and safe when email is unconfigured (logs + skips).
//
//   node scripts/send-statement.js

const { pool } = require('../server/db');
const config = require('../server/config');
const reportsSvc = require('../server/services/reports');
const { generateStatementPdf } = require('../server/services/statement');
const emailSvc = require('../server/services/email');

async function main() {
  // Prior calendar month (UTC).
  const now = new Date();
  const prior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = prior.getUTCMonth() + 1;
  const year = prior.getUTCFullYear();

  const statement = await reportsSvc.statement(month, year);
  const pdf = await generateStatementPdf(statement);

  const { rows } = await pool.query(
    "SELECT email FROM admin_users WHERE active = true AND role IN ('admin','operator') AND email IS NOT NULL"
  );
  const recipients = [...new Set([config.ownerEmail, ...rows.map((r) => r.email)].filter(Boolean))];

  const result = await emailSvc.sendStatement(recipients, pdf, statement);
  console.log(
    `[statement] ${statement.label}: ${statement.totals.booking_count} bookings, `
    + `total due ${statement.totals.total_due_fmt} → ${recipients.join(', ') || '(no recipients)'} :: ${JSON.stringify(result)}`
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Statement cron failed:', err);
    pool.end();
    process.exit(1);
  });
