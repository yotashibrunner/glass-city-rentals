-- Up Migration

-- ── Coupons / discount codes ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR UNIQUE NOT NULL,
  description VARCHAR,
  discount_type VARCHAR NOT NULL,          -- 'percentage' | 'flat' | 'free_delivery'
  discount_value INTEGER NOT NULL,         -- percent (integer) OR cents
  min_booking_cents INTEGER DEFAULT 0,
  max_uses INTEGER,                        -- NULL = unlimited
  use_count INTEGER DEFAULT 0,
  trailer_id UUID REFERENCES trailers(id), -- NULL = all trailers
  expires_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES admin_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(lower(code));

CREATE TABLE IF NOT EXISTS coupon_uses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id UUID NOT NULL REFERENCES coupons(id),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  discount_applied_cents INTEGER NOT NULL,
  used_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_uses_booking ON coupon_uses(booking_id);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_applied_cents INTEGER NOT NULL DEFAULT 0;

-- ── Post-return review request (cron) ───────────────────────────────────────
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE bookings DROP COLUMN IF EXISTS review_requested_at;
ALTER TABLE bookings DROP COLUMN IF EXISTS discount_applied_cents;
ALTER TABLE bookings DROP COLUMN IF EXISTS coupon_id;
DROP TABLE IF EXISTS coupon_uses;
DROP TABLE IF EXISTS coupons;
