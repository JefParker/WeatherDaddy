-- Rain nowcast (2026-09-14, worker/nowcast.js): "Rain starting in
-- ~15 min, lasting ~45 min", checked every five minutes on its own
-- cron. Off by default so the Worker deployed before this migration
-- keeps working against it. nowcast_last_dt is the epoch of the onset
-- slot the device was last told about; an onset within an hour of it
-- is the same spell of rain and is not sent again.
ALTER TABLE push_subscriptions ADD COLUMN nowcast INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN nowcast_last_dt INTEGER;
