-- Up Migration

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()

-- Trailers / dumpsters
CREATE TABLE trailers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR UNIQUE NOT NULL,      -- 'car-hauler', 'enclosed', etc.
  name VARCHAR NOT NULL,
  type VARCHAR NOT NULL,             -- 'trailer' | 'dumpster'
  size_label VARCHAR,                -- '7x20 ft'
  description TEXT,
  photo_url VARCHAR,

  -- Pricing in cents
  hourly_rate INTEGER,               -- null if not offered hourly
  daily_rate INTEGER,
  weekly_rate INTEGER,
  monthly_rate INTEGER,

  -- Roll-off dumpster pricing (only used when type='dumpster')
  flat_drop_off_cents INTEGER,       -- e.g. 42000 ($420) for 25yd
  flat_drop_off_days INTEGER,        -- e.g. 3 days included
  extra_day_cents INTEGER,           -- e.g. 2500 ($25/day) after included
  per_tire_cents INTEGER,            -- e.g. 300 ($3) if tires found

  -- Specs
  hitch_requirement VARCHAR,         -- '2 5/16" ball'
  plug_requirement VARCHAR,          -- '7-pin plug'
  specs JSONB DEFAULT '[]'::jsonb,   -- ['Winch', 'Power Tilt', ...]
  min_hours INTEGER,                 -- hourly minimum (e.g. 2), null if n/a

  -- State
  status VARCHAR NOT NULL DEFAULT 'available',  -- 'available' | 'out_of_service'
  display_order INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Customers (created on first booking)
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  phone VARCHAR NOT NULL,
  total_bookings INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_phone ON customers(phone);

-- Bookings
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_code VARCHAR UNIQUE NOT NULL,  -- 'GCT-A1B2' for customer-facing
  trailer_id UUID NOT NULL REFERENCES trailers(id),
  customer_id UUID NOT NULL REFERENCES customers(id),

  -- Time window
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  period_type VARCHAR NOT NULL,      -- 'hour'|'day'|'week'|'month'|'roll_off'
  quantity INTEGER NOT NULL,         -- hours/days/weeks/months OR extra days for roll-off
  tire_count INTEGER DEFAULT 0,      -- roll-off only

  -- Money (all in cents, customer pickup only -- no delivery)
  base_amount_cents INTEGER NOT NULL,
  extra_charges_cents INTEGER DEFAULT 0,  -- roll-off extra days, tires, etc.
  tax_cents INTEGER DEFAULT 0,
  total_cents INTEGER NOT NULL,           -- charged in full at booking
  amount_paid_cents INTEGER DEFAULT 0,

  -- Stripe
  stripe_session_id VARCHAR,
  stripe_payment_intent_id VARCHAR,

  -- E-signed rental agreement
  contract_version INTEGER,
  contract_signed_at TIMESTAMPTZ,
  contract_signed_name VARCHAR,           -- typed legal name
  contract_signed_ip VARCHAR,
  contract_signature_image TEXT,          -- base64 PNG of drawn signature (canvas)
  contract_pdf_url VARCHAR,               -- generated PDF stored on disk/S3

  -- State
  status VARCHAR NOT NULL DEFAULT 'pending',
  -- pending | signed | paid | confirmed | out | returned | cancelled
  picked_up_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,

  -- Notes
  customer_notes TEXT,
  operator_notes TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_bookings_trailer_dates ON bookings(trailer_id, start_at, end_at);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_start ON bookings(start_at);

-- Blackouts (maintenance, owner vacation, etc.)
CREATE TABLE blackouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trailer_id UUID REFERENCES trailers(id),  -- NULL = applies to ALL trailers
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  reason VARCHAR,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Operator accounts
CREATE TABLE admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR UNIQUE NOT NULL,
  phone VARCHAR,                     -- for SMS alerts
  password_hash VARCHAR NOT NULL,
  name VARCHAR,
  role VARCHAR DEFAULT 'operator',   -- 'operator' | 'admin'
  push_subscription JSONB,           -- WebPush PushSubscription object
  notify_via_sms BOOLEAN DEFAULT true,
  notify_via_push BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Key-value settings (business hours, tax rate, etc.)
CREATE TABLE settings (
  key VARCHAR PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Audit trail
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID REFERENCES admin_users(id),
  action VARCHAR NOT NULL,
  entity_type VARCHAR,
  entity_id UUID,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Down Migration

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS admin_users;
DROP TABLE IF EXISTS blackouts;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS trailers;
