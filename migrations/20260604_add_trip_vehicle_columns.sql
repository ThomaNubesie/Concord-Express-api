-- Per-trip vehicle snapshot
-- Lets a driver with more than one car choose which vehicle a given trip uses.
-- When these are NULL, the app falls back to the driver's profile vehicle.
-- All columns are nullable and additive — safe to run on a live database.

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS vehicle_make      TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_model     TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_year      INTEGER,
  ADD COLUMN IF NOT EXISTS vehicle_color     TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_plate     TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_province  TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_seats     INTEGER,
  ADD COLUMN IF NOT EXISTS vehicle_image_url TEXT;
