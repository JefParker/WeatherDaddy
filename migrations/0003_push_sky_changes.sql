-- Two more per-feature flags on the one row per device (2026-09-14),
-- both "off" by default so the Worker deployed before this migration
-- keeps working against it. (The umbrella threshold that ships with
-- them is a new bit, 64, in threshold_mask and needs no schema change;
-- the column's default of 63 stays — the app always writes the mask.)

-- Sky events: meteor-shower peaks and eclipses (worker/sky.js), sent
-- before sunset on the night, or before the peak of a solar eclipse.
-- sky_last_key is the event's key (plus year for a shower), so each
-- fires once.
ALTER TABLE push_subscriptions ADD COLUMN sky INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN sky_last_key TEXT;

-- Forecast changes (worker/changes.js): looked at twice a day, at the
-- row's briefing hour and threshold hour. changes_snapshot is the JSON
-- the last look stored for the next to compare with; changes_last_slot
-- ("YYYY-MM-DDTHH") dedupes the half-hourly cron.
ALTER TABLE push_subscriptions ADD COLUMN changes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN changes_snapshot TEXT;
ALTER TABLE push_subscriptions ADD COLUMN changes_last_slot TEXT;
