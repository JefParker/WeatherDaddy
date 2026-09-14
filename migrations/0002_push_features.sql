-- Per-feature flags for the three notification types that join the
-- morning briefing (2026-09-14). All four share one row per device and
-- one city (lat/lon/city_name). Every column defaults to "off" so the
-- Worker deployed before this migration keeps working against it.

-- Severe weather: NWS warnings and watches for the row's location,
-- checked by the */5 cron.
ALTER TABLE push_subscriptions ADD COLUMN alerts INTEGER NOT NULL DEFAULT 0;

-- Threshold alerts: freeze / heat / wind / rain / snow / air quality for
-- the next 24 hours, evaluated once a day at threshold_hour (device
-- local). threshold_mask is a bitmask of the checked items
-- (worker/thresholds.js); threshold_last_day dedupes like last_sent_day.
ALTER TABLE push_subscriptions ADD COLUMN thresholds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN threshold_hour INTEGER NOT NULL DEFAULT 17;
ALTER TABLE push_subscriptions ADD COLUMN threshold_mask INTEGER NOT NULL DEFAULT 63;
ALTER TABLE push_subscriptions ADD COLUMN threshold_last_day TEXT;

-- Named full moon: one push before sunset on the night of each full
-- moon. moon_last_key is the peak's epoch seconds, so each moon fires once.
ALTER TABLE push_subscriptions ADD COLUMN moon INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN moon_last_key TEXT;

-- Which NWS alert ids each device has already been told about (or has
-- been spared because an Update superseded one it was told about).
-- Pruned to the last 7 days on every alert run.
CREATE TABLE IF NOT EXISTS push_alerts_sent (
  endpoint TEXT    NOT NULL,
  alert_id TEXT    NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (endpoint, alert_id)
);
CREATE INDEX IF NOT EXISTS idx_push_alerts_sent_at ON push_alerts_sent (sent_at);
