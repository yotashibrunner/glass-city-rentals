# Glass City Trailer Rentals — Booking Platform

Full-stack booking + payment + e-signed contract platform: a customer-facing
site and an operator PWA. Single Express app, single Postgres database, deployed
to Railway. See [`../PLAN.md`](../PLAN.md) for the full architecture and phased
build plan.

> **Status:** Phases 0–2 complete. The marketing site is served at `/`, and the
> operator PWA (with JWT login) is at `/operator/`. The booking flow, payments,
> and contracts arrive in later phases.

## Stack

- **Runtime:** Node.js 22 LTS
- **Web:** Express 4 + EJS (server-rendered, no build step)
- **DB:** PostgreSQL, migrated with `node-pg-migrate` (plain SQL)
- **Hosting:** Railway

## Project layout

```
server/
  index.js          Express entrypoint (health, API mounts, static + PWA, fleet stub)
  config.js         Env config (DB, JWT)
  db.js             pg connection pool
  migrations/       node-pg-migrate SQL migrations
  routes/
    auth.js         POST /api/auth/login, /api/auth/refresh
    api-operator.js Operator API (JWT-protected): /me, /dashboard (empty in P2)
  middleware/
    auth.js         JWT verification guard for /api/operator/*
    rate-limit.js   In-memory fixed-window limiter (login: 5/min/IP)
  services/
    auth.js         bcrypt password hashing + JWT issue/verify
  views/            EJS templates
public/             Static marketing site (index.html + images), served at /
operator/           Operator PWA (vanilla SPA), served at /operator/
  index.html        App shell (login + dashboard views via <template>)
  manifest.json     PWA manifest (installable)
  service-worker.js Offline shell cache (API never cached)
  icons/            App icons (192, 512, 180 — generated from logo)
  css/app.css       Mobile-first dark theme
  js/api.js         JWT storage + auto-refresh fetch wrapper
  js/app.js         View controller + service-worker registration
scripts/
  seed-trailers.js  Seeds the 5 fleet items with current pricing
  create-admin.js   CLI to create/update an operator login
  generate-icons.js Regenerates PWA icons from public/images/logo.png
```

## Local setup

1. **Install dependencies**

   ```sh
   npm install
   ```

2. **Configure environment**

   ```sh
   cp .env.example .env
   ```

   Edit `.env` — at minimum set `DATABASE_URL` to a local Postgres database.
   Create the database first if needed: `createdb glasscity`.

3. **Run migrations**

   ```sh
   npm run migrate:up
   ```

4. **Seed the fleet** (4 trailers + 1 roll-off dumpster)

   ```sh
   npm run seed
   ```

5. **Start the server**

   ```sh
   npm run dev     # auto-reloads on change
   # or: npm start
   ```

   - `http://localhost:3000/health` → `{"ok":true}`
   - `http://localhost:3000/` → marketing site

## Environment variables

See [`.env.example`](.env.example) for the full list. Phase 0/1 needs `PORT`,
`DATABASE_URL`, and `DB_SSL`. Phase 2 adds **`JWT_SECRET`** — required in
production (the app refuses to boot without it). Generate one with:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Later phases add Stripe, Resend, Twilio, VAPID, and Sentry keys.

## Operator PWA

The operator app is a vanilla single-page PWA at `/operator/`, installable to a
phone home screen ("Add to Home Screen" on Android & iOS).

1. **Create the first operator login:**

   ```sh
   npm run create-admin -- --email you@example.com --name "Your Name" --role admin
   ```

   Omit `--password` to be prompted (hidden input). Re-running with the same
   email updates that account, so it doubles as a password reset.

2. **Log in:** open `/operator` on your phone, install to the home screen, and
   sign in. Auth uses bcrypt + JWT (15-minute access token, 30-day refresh
   stored in `localStorage`; the access token auto-refreshes on expiry).

3. **Regenerate PWA icons** (after changing `public/images/logo.png`):

   ```sh
   npm run generate-icons
   ```

## Database migrations

Plain-SQL migrations live in `server/migrations/` and use node-pg-migrate's
`-- Up Migration` / `-- Down Migration` markers.

```sh
npm run migrate:up      # apply all pending
npm run migrate:down    # roll back the last one
npx node-pg-migrate -j sql -m server/migrations create my_change   # new migration
```

## Deploy (Railway)

1. Create a Railway project, add the **PostgreSQL** plugin (sets `DATABASE_URL`).
2. Set `DB_SSL=true` and `NODE_ENV=production` in Railway variables.
3. Connect the GitHub repo. [`railway.toml`](railway.toml) runs
   `migrate:up` then `npm start` on each deploy, with `/health` as the
   healthcheck.
4. After the first deploy, seed once from the Railway shell: `npm run seed`.

## Fleet data

Pricing is stored in **integer cents** (no float math). The seed values mirror
the original marketing site's `FLEET` table:

| Slug         | Type     | Hourly | Daily | Weekly | Monthly |
|--------------|----------|--------|-------|--------|---------|
| car-hauler   | trailer  | $25    | $120  | $600   | $1800   |
| enclosed     | trailer  | $20    | $75   | $350   | $1100   |
| dump         | trailer  | $30    | $150  | $650   | $1950   |
| utility      | trailer  | —      | $50   | $250   | $750    |
| roll25       | dumpster | $420 drop-off (3 days incl.) · $25/extra day · $3/tire |
