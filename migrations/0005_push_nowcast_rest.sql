-- Rain nowcast polling gate (2026-09-14, worker/nowcast.js
-- nowcastRest): when the 15-minute series shows nothing wet within the
-- hour, the location's rows rest until this epoch (half an hour) and
-- the five-minute cron skips their fetch. Null means poll on the next
-- tick.
ALTER TABLE push_subscriptions ADD COLUMN nowcast_next_at INTEGER;
