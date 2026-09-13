-- One row per browser push subscription. The endpoint is the identity:
-- it is an unguessable URL minted by the push service, so knowing it is
-- what authorises status / unsubscribe / test calls (there are no user
-- accounts). Preferences ride along on the row because the server has
-- no other way to learn them.
--
-- `briefing` is a per-feature flag so severe-alert and rain-nowcast
-- pushes can later share the same row instead of needing their own
-- subscriptions.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint      TEXT PRIMARY KEY,
  p256dh        TEXT    NOT NULL,
  auth          TEXT    NOT NULL,
  lat           REAL    NOT NULL,
  lon           REAL    NOT NULL,
  city_name     TEXT    NOT NULL,
  tz            TEXT    NOT NULL,             -- IANA zone of the DEVICE, not the city
  hour          INTEGER NOT NULL DEFAULT 6,   -- local hour (0-23) the briefing is due
  temp_unit     TEXT    NOT NULL DEFAULT 'F',
  wind_unit     TEXT    NOT NULL DEFAULT 'mph',
  precip_unit   TEXT    NOT NULL DEFAULT 'in',
  time_fmt      TEXT    NOT NULL DEFAULT '12h',
  briefing      INTEGER NOT NULL DEFAULT 1,
  last_sent_day TEXT,                         -- YYYY-MM-DD in `tz`; dedupes the half-hourly cron
  last_test_at  INTEGER,                      -- epoch seconds; rate-limits "send a test"
  fail_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_hour ON push_subscriptions (hour);
