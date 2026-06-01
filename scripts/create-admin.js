'use strict';

// Creates (or updates) an operator/admin account for the PWA login.
//
//   npm run create-admin -- --email owner@example.com --name "Owner" --role admin
//   npm run create-admin -- --email owner@example.com --password 's3cret'
//
// If --password is omitted you'll be prompted for it (input hidden). Re-running
// with an existing email updates that account's password/name/role/phone
// instead of erroring, so it doubles as a password-reset tool.
//
// Password is bcrypt-hashed (cost from config.bcryptRounds, default 12).

const readline = require('readline');
const { pool } = require('../server/db');
const { hashPassword } = require('../server/services/auth');

// --- Tiny --flag value arg parser -----------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true; // boolean flag
      } else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

// Prompt for a password without echoing it. Standard readline trick: show the
// prompt but swallow the characters readline would otherwise echo back.
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let muted = false;
    rl._writeToOutput = (str) => {
      if (!muted || str.includes(question)) rl.output.write(str);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const email = String(args.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    console.error('Error: a valid --email is required.');
    console.error('Usage: npm run create-admin -- --email you@example.com [--name "Name"] [--role admin|operator|owner] [--phone +14195551234] [--password secret]');
    process.exit(1);
  }

  const name = args.name ? String(args.name) : null;
  const phone = args.phone ? String(args.phone) : null;
  const ROLES = ['admin', 'operator', 'owner'];
  const role = ROLES.includes(args.role) ? args.role : 'operator';

  let password = args.password ? String(args.password) : '';
  if (!password) {
    password = await promptHidden(`Password for ${email}: `);
  }
  if (!password || password.length < 8) {
    console.error('Error: password must be at least 8 characters.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const { rows } = await pool.query(
    `INSERT INTO admin_users (email, name, phone, role, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, admin_users.name),
       phone = COALESCE(EXCLUDED.phone, admin_users.phone),
       role = EXCLUDED.role,
       password_hash = EXCLUDED.password_hash
     RETURNING id, email, name, role, (xmax = 0) AS inserted`,
    [email, name, phone, role, passwordHash]
  );

  const u = rows[0];
  const verb = u.inserted ? 'Created' : 'Updated';
  console.log(`${verb} ${u.role} account: ${u.email} (id ${u.id})`);
  console.log('You can now log in at /operator on your phone.');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('create-admin failed:', err.message || err);
    pool.end();
    process.exit(1);
  });
