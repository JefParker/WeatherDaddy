// Rain nowcast: "Rain starting in ~15 min, lasting ~45 min", pushed
// shortly before precipitation reaches a subscriber's city — the Dark
// Sky notification. Checked every five minutes by its own cron (see
// runNowcast in push.js), on minutes offset from the alerts cron so the
// two never share an invocation's budgets.
//
// The data is Open-Meteo's 15-minute precipitation series, the same
// one the app's hero line reads (UI._precipNowcast in
// public/js/ui-format.js), with the same wet floor and the same "first
// wet↔dry edge, then the one after it" scan, so a push and the sentence
// under the temperature always agree. One call per rounded location
// per tick; the next six hours is enough to see the end of most rain.
// Note the series is true 15-minute model output in North America and
// central Europe and interpolated from hourly elsewhere — still
// worth having, just softer at the edges, hence the tildes.

import { localClock } from './briefing.js';
import { clockTime } from './moon.js';

const OM = 'https://api.open-meteo.com/v1/forecast';

export const NOWCAST_LEAD_S   = 20 * 60;  // send once the onset is this close
export const NOWCAST_REPEAT_S = 60 * 60;  // a new onset must be this far past the last one told
const WET_MM = 0.05;                      // mm per 15 min that counts as precipitating
// No rain pushes between these local hours (device timezone): a shower
// at 3 AM is not something to be woken for.
export const QUIET_FROM  = 22;
export const QUIET_UNTIL = 7;

// Subscribers within ~1 km share one call per tick.
export function nowcastKey(lat, lon) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

export function inQuietHours(row, now) {
  const { hour } = localClock(row.tz, now);
  return hour >= QUIET_FROM || hour < QUIET_UNTIL;
}

// The next six hours of 15-minute precipitation as
// [{ dt, mm, snow }], sorted. `snow` is the snowfall depth in cm for
// the slot; it only decides whether the push says rain or snow.
export async function fetchMinutely(lat, lon) {
  const url = new URL(OM);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('minutely_15', 'precipitation,snowfall');
  url.searchParams.set('forecast_minutely_15', '24');
  url.searchParams.set('timeformat', 'unixtime');
  url.searchParams.set('timezone', 'UTC');
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = await res.json();
  const m = data.minutely_15 || {};
  const times = Array.isArray(m.time) ? m.time : [];
  return times.map((t, i) => ({
    dt: t,
    mm: (m.precipitation && m.precipitation[i]) || 0,
    snow: (m.snowfall && m.snowfall[i]) || 0,
  })).sort((a, b) => a.dt - b.dt);
}

// Is precipitation about to start? Returns { dt, untilDt, snow } when
// the series is dry now and turns wet within `leadSec` — dt is the
// slot it starts, untilDt the slot it stops (null if it hasn't by the
// end of the series) — or null. Already raining is null too: that
// onset was either told or missed, and either way is not news.
export function nowcastOnset(series, nowSec, leadSec = NOWCAST_LEAD_S) {
  const upcoming = (series || []).filter((m) => m.dt + 900 > nowSec);
  if (upcoming.length < 2) return null;
  const wet = (m) => (m.mm || 0) >= WET_MM;
  if (wet(upcoming[0])) return null;
  const i = upcoming.findIndex((m, idx) => idx > 0 && wet(m));
  if (i < 0 || upcoming[i].dt > nowSec + leadSec) return null;
  let end = upcoming.length;
  for (let j = i + 1; j < upcoming.length; j++) if (!wet(upcoming[j])) { end = j; break; }
  const spell = upcoming.slice(i, end);
  return {
    dt: upcoming[i].dt,
    untilDt: end < upcoming.length ? upcoming[end].dt : null,
    snow: spell.some((m) => (m.snow || 0) > 0),
  };
}

// One push per spell of rain: an onset within NOWCAST_REPEAT_S of the
// last one this device was told about is the same spell, shifted by a
// model update, and stays quiet.
export function nowcastDue(row, onset) {
  if (!onset) return null;
  const last = Number(row.nowcast_last_dt) || 0;
  if (last && onset.dt - last < NOWCAST_REPEAT_S) return null;
  return onset;
}

// "~45 min" / "~1.5 h" — a span between two 15-minute slot edges.
export function spanLabel(sec) {
  const mins = Math.round(sec / 60);
  if (mins < 60) return `~${mins} min`;
  return `~${Math.round(mins / 30) / 2} h`;
}

// The notification, e.g.
//
//   Rain starting in ~15 min
//   Denver · lasting ~45 min, until about 3:30 PM
export function composeNowcast(row, onset, nowSec, nowMs = Date.now()) {
  const what = onset.snow ? 'Snow' : 'Rain';
  const mins = Math.max(1, Math.round((onset.dt - nowSec) / 60));
  const url = new URL('/', 'https://weatherdaddy.app');
  url.searchParams.set('lat', String(row.lat));
  url.searchParams.set('lon', String(row.lon));
  url.searchParams.set('name', row.city_name);
  const rest = onset.untilDt
    ? `lasting ${spanLabel(onset.untilDt - onset.dt)}, until about ${clockTime(onset.untilDt, row.tz, row.time_fmt)}`
    : 'through the next several hours';
  return {
    title: `${what} starting in ~${mins} min`,
    body: `${row.city_name} · ${rest}`,
    url: url.pathname + url.search,
    tag: 'nowcast',
    timestamp: nowMs,
  };
}

// A nowcast is stale the moment the rain arrives.
export function nowcastTtl(onset, nowSec) {
  return Math.max(60, onset.dt - nowSec);
}
