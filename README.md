# Glass City Trailer Rentals — Booking Platform

Full-stack booking + payment + e-signed contract platform: a customer-facing
site and an operator PWA. Single Express app, single Postgres database, deployed
to Railway. See [`../PLAN.md`](../PLAN.md) for the full architecture and phased
build plan.

> **Status:** Phase 0 (project setup) + Phase 1 (database + existing site)
> complete. The marketing site is served at `/`; the booking flow, operator PWA,
> payments, and contracts arrive in later phases.

## Stack

- **Runtime:** Node.js 22 LTS
- **Web:** Express 4 + EJS (server-rendered, no build step)
- **DB:** PostgreSQL, migrated with `node-pg-migrate` (plain SQL)
- **Hosting:** Railway

## Project layout

```
server/
  index.js          Express entrypoint (/health, /fleet/:slug stub, static site)
  config.js         Env config
  db.js             pg connection pool
  migrations/       node-pg-migrate SQL migrations
  views/            EJS templates
public/             Static marketing site (index.html + images), served at /
scripts/
  seed-trailers.js  Seeds the 5 fleet items with current pricing
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

See [`.env.example`](.env.example) for the full list. Phase 0/1 only needs
`PORT`, `DATABASE_URL`, and `DB_SSL`. Later phases add Stripe, Resend, Twilio,
VAPID, and Sentry keys.

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
