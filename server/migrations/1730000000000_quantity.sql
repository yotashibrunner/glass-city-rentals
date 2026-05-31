-- Up Migration
--
-- Multi-unit inventory: a trailer/bin SKU can have several interchangeable
-- units. quantity_total = how many are owned; quantity_on_hold = how many are
-- manually held out of service (maintenance, etc.). Availability counts
-- overlapping bookings against (quantity_total - quantity_on_hold).

ALTER TABLE trailers
  ADD COLUMN IF NOT EXISTS quantity_total INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS quantity_on_hold INTEGER NOT NULL DEFAULT 0;

-- Down Migration

ALTER TABLE trailers
  DROP COLUMN IF EXISTS quantity_total,
  DROP COLUMN IF EXISTS quantity_on_hold;
