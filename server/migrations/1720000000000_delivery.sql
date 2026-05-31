-- Up Migration
--
-- Delivery option: customers can choose pickup (free) or delivery (flat fee).
-- The fee is stored on the booking so the charged total and the historical
-- record stay accurate even if the fee changes later.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS fulfillment VARCHAR NOT NULL DEFAULT 'pickup',
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS delivery_fee_cents INTEGER NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE bookings
  DROP COLUMN IF EXISTS fulfillment,
  DROP COLUMN IF EXISTS delivery_address,
  DROP COLUMN IF EXISTS delivery_fee_cents;
