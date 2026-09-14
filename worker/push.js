// Push notifications: the /api/push/* routes the app calls, and the
// cron-driven notification runs.
//
// There are no accounts. A push endpoint is an unguessable URL minted
// by the browser's push service, so presenting it is what authorises
// reading, changing or deleting that one row. Rows live in D1 (binding
// DB; schema in migrations/). One row per device carries one city and
// a flag per feature: morning briefing, severe weather alerts, threshold
// alerts, full moon.
//
// Two crons (wrangler.jsonc): */30 runs the clock-driven features
// (briefing, thresholds, moon) and */5 runs the severe-weather check.
// Each invocation gets its own budget below.
//
// Free-plan budgets that shape a cron run (numbers from
// developers.cloudflare.com/workers/platform/limits, Sept 2026):
//   - 50 subrequests per invocation → forecasts + sends capped at 45
//   - 10 ms CPU per cron invocation → sends capped at 25 (measured
//     2026-09-14 on the real runtime: ~0.3 ms per push for the ECDH +
//     AES-GCM + ES256 work, ~1 ms fixed, so 40 sends ran 11-20 ms;
//     Cloudflare tolerates an occasional overrun, not a daily one)
//   - 6 simultaneous outgoing connections → sends go 5 at a time
//   - 50 D1 queries per invocation → a few SELECTs plus one batch

import { sendPush, b64uToBytes } from './webpush.js';
import {
  localClock, isValidTimeZone, forecastKey, fetchForecast, composeBriefing,
} from './briefing.js';
import {
  inNwsBox, alertKey, fetchActiveAlerts, isPushWorthy, referencedIds, composeAlert, alertTtl,
} from './alerts.js';
import { T, fetchAirQuality, evaluateThresholds, composeThresholds } from './thresholds.js';

const MAX_SUBREQUESTS  = 45;
const MAX_SENDS        = 25;       // CPU budget; anything past it waits for the next tick
const SEND_CONCURRENCY = 5;
const MAX_FAILS        = 8;        // consecutive delivery failures before the row is dropped
const TEST_COOLDOWN_S  = 30;
const MAX_BODY_BYTES   = 8 * 1024;
const ALERT_MEMORY_S   = 7 * 86400; // how long push_alerts_sent remembers an id

export const CRON_CLOCK  = '*/30 * * * *';
export const CRON_ALERTS = '*/5 * * * *';

const TEMP_UNITS   = new Set(['C', 'F']);
const WIND_UNITS   = new Set(['ms', 'kmh', 'mph']);
const PRECIP_UNITS = new Set(['mm', 'in']);
const TIME_FMTS    = new Set(['12h', '24h']);
const THRESHOLD_MASK_ALL = 63;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function vapidFrom(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'https://weatherdaddy.app',
  };
}

export function pushConfigured(env) {
  return !!(env.DB && vapidFrom(env));
}

// ── Input validation ──────────────────────────────────────────────────

function parseEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1500) return null;
  let u;
  try { u = new URL(value); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  return u.toString();
}

function parseSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = parseEndpoint(sub.endpoint);
  const keys = sub.keys || {};
  if (!endpoint || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  try {
    const p = b64uToBytes(keys.p256dh);
    const a = b64uToBytes(keys.auth);
    if (p.length !== 65 || p[0] !== 0x04 || a.length !== 16) return null;
  } catch (_) { return null; }
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

const hourOf = (v, dflt) => (Number.isInteger(v) && v >= 0 && v <= 23) ? v : dflt;

// Preferences as the app sends them (UI._pushPrefsPayload). `features`
// is optional so a pre-1.9 client, which only knows the briefing, still
// subscribes to exactly that.
function parsePrefs(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 80) : '';
  if (!name) return null;
  if (!isValidTimeZone(p.tz)) return null;
  const hour = Number(p.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const u = p.units || {};
  const units = {
    temp:   TEMP_UNITS.has(u.temp)     ? u.temp   : 'F',
    wind:   WIND_UNITS.has(u.wind)     ? u.wind   : 'mph',
    precip: PRECIP_UNITS.has(u.precip) ? u.precip : 'in',
    time:   TIME_FMTS.has(u.time)      ? u.time   : '12h',
  };
  const f = (p.features && typeof p.features === 'object') ? p.features : { briefing: true };
  const features = {
    briefing:   f.briefing === true,
    alerts:     f.alerts === true,
    thresholds: f.thresholds === true,
    moon:       f.moon === true,
  };
  const thresholdHour = hourOf(Number(p.thresholdHour), 17);
  const m = Number(p.thresholdMask);
  const thresholdMask = (Number.isInteger(m) && m >= 0 && m <= THRESHOLD_MASK_ALL) ? m : THRESHOLD_MASK_ALL;
  return { lat, lon, name, tz: p.tz, hour, units, features, thresholdHour, thresholdMask };
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('body too large');
  return JSON.parse(text);
}

const unitsOf = (row) => ({ temp: row.temp_unit, wind: row.wind_unit, precip: row.precip_unit, time: row.time_fmt });

function publicPrefs(row) {
  return {
    lat: row.lat, lon: row.lon, name: row.city_name, tz: row.tz, hour: row.hour,
    units: unitsOf(row),
    features: {
      briefing:   !!row.briefing,
      alerts:     !!row.alerts,
      thresholds: !!row.thresholds,
      moon:       !!row.moon,
    },
    thresholdHour: row.threshold_hour,
    thresholdMask: row.threshold_mask,
    // Kept at the top level for the 1.8 client, which reads it there.
    briefing: !!row.briefing,
    lastSentDay: row.last_sent_day || null,
    thresholdLastDay: row.threshold_last_day || null,
  };
}

// ── Routes ────────────────────────────────────────────────────────────

export async function handlePushRoute(request, env, ctx, path) {
  if (path === 'config') {
    if (request.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);
    return json({ configured: pushConfigured(env), publicKey: env.VAPID_PUBLIC_KEY || null });
  }
  if (request.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  if (!pushConfigured(env)) return json({ error: 'Push notifications are not configured on this deployment' }, 503);

  let body;
  try { body = await readJson(request); }
  catch (_) { return json({ error: 'Bad JSON' }, 400); }

  switch (path) {
    case 'subscribe':   return subscribe(env, body);
    case 'unsubscribe': return unsubscribe(env, body);
    case 'status':      return status(env, body);
    case 'test':        return sendTest(env, body);
    case 'resubscribe': return resubscribe(env, body);
    default:            return json({ error: 'Not Found' }, 404);
  }
}

// Create or fully replace this device's row. The app always sends the
// complete preference set, so every feature flag is written.
async function subscribe(env, body) {
  const sub = parseSubscription(body.subscription);
  const prefs = parsePrefs(body.prefs);
  if (!sub)   return json({ error: 'Invalid subscription' }, 400);
  if (!prefs) return json({ error: 'Invalid preferences' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const f = prefs.features;
  await env.DB.prepare(`
    INSERT INTO push_subscriptions
      (endpoint, p256dh, auth, lat, lon, city_name, tz, hour,
       temp_unit, wind_unit, precip_unit, time_fmt,
       briefing, alerts, thresholds, threshold_hour, threshold_mask, moon,
       created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh, auth = excluded.auth,
      lat = excluded.lat, lon = excluded.lon, city_name = excluded.city_name,
      tz = excluded.tz, hour = excluded.hour,
      temp_unit = excluded.temp_unit, wind_unit = excluded.wind_unit,
      precip_unit = excluded.precip_unit, time_fmt = excluded.time_fmt,
      briefing = excluded.briefing, alerts = excluded.alerts,
      thresholds = excluded.thresholds, threshold_hour = excluded.threshold_hour,
      threshold_mask = excluded.threshold_mask, moon = excluded.moon,
      fail_count = 0, updated_at = excluded.updated_at
  `).bind(
    sub.endpoint, sub.p256dh, sub.auth, prefs.lat, prefs.lon, prefs.name, prefs.tz, prefs.hour,
    prefs.units.temp, prefs.units.wind, prefs.units.precip, prefs.units.time,
    f.briefing ? 1 : 0, f.alerts ? 1 : 0, f.thresholds ? 1 : 0, prefs.thresholdHour, prefs.thresholdMask, f.moon ? 1 : 0,
    now
  ).run();
  const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1').bind(sub.endpoint).first();
  return json({ ok: true, prefs: publicPrefs(row) });
}

async function unsubscribe(env, body) {
  const endpoint = parseEndpoint(body.endpoint);
  if (!endpoint) return json({ error: 'Invalid endpoint' }, 400);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint),
    env.DB.prepare('DELETE FROM push_alerts_sent WHERE endpoint = ?1').bind(endpoint),
  ]);
  return json({ ok: true });
}

async function status(env, body) {
  const endpoint = parseEndpoint(body.endpoint);
  if (!endpoint) return json({ error: 'Invalid endpoint' }, 400);
  const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).first();
  return json(row ? { subscribed: true, prefs: publicPrefs(row) } : { subscribed: false, prefs: null });
}

// The push service rotated the endpoint (sw.js pushsubscriptionchange).
async function resubscribe(env, body) {
  const oldEndpoint = parseEndpoint(body.oldEndpoint);
  const sub = parseSubscription(body.subscription);
  if (!oldEndpoint || !sub) return json({ error: 'Invalid subscription' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(`
    UPDATE push_subscriptions
       SET endpoint = ?1, p256dh = ?2, auth = ?3, fail_count = 0, updated_at = ?4
     WHERE endpoint = ?5
  `).bind(sub.endpoint, sub.p256dh, sub.auth, now, oldEndpoint).run();
  if (!res.meta || !res.meta.changes) return json({ error: 'Unknown subscription' }, 404);
  return json({ ok: true });
}

// "Send a test now": today's briefing for the row's city, right away.
async function sendTest(env, body) {
  const endpoint = parseEndpoint(body.endpoint);
  if (!endpoint) return json({ error: 'Invalid endpoint' }, 400);
  const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).first();
  if (!row) return json({ error: 'Not subscribed' }, 404);

  const now = Math.floor(Date.now() / 1000);
  if (row.last_test_at && now - row.last_test_at < TEST_COOLDOWN_S) {
    return json({ error: `Please wait ${TEST_COOLDOWN_S - (now - row.last_test_at)}s before sending another test` }, 429);
  }
  await env.DB.prepare('UPDATE push_subscriptions SET last_test_at = ?1 WHERE endpoint = ?2').bind(now, endpoint).run();

  let forecast;
  try { forecast = await fetchForecast(row.lat, row.lon, unitsOf(row)); }
  catch (err) { return json({ error: `Forecast unavailable (${err.message})` }, 502); }

  const payload = composeBriefing(row, forecast);
  const result = await sendPush(row, payload, vapidFrom(env), { ttl: 300, urgency: 'high', topic: 'briefing-test' });
  if (result.gone) {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).run();
    return json({ error: 'The push service says this subscription has expired. Turn the briefing off and on again.' }, 410);
  }
  if (!result.ok) return json({ error: `Push service replied ${result.status}${result.error ? ': ' + result.error : ''}` }, 502);
  return json({ ok: true, preview: payload });
}

// ── Cron runs ─────────────────────────────────────────────────────────

// Run `fn` over `items` with at most `n` in flight.
async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// The D1 writes a run accumulates and flushes in one batch at the end,
// plus the delivery bookkeeping every feature shares: a dead endpoint
// (404/410) is dropped at once, a failing one after MAX_FAILS in a row.
function makeLedger(env) {
  const writes = [];
  const nowSec = () => Math.floor(Date.now() / 1000);
  const ledger = {
    writes,
    update(endpoint, sql, ...binds) {
      writes.push(env.DB.prepare(sql).bind(...binds, endpoint));
    },
    drop(endpoint) {
      writes.push(env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint));
    },
    failed(row) {
      if (row.fail_count + 1 >= MAX_FAILS) return ledger.drop(row.endpoint);
      writes.push(env.DB.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?1').bind(row.endpoint));
    },
    // Deliver one payload and record the outcome. `onSent` runs only on
    // success so a deferred or failed item is retried next tick.
    async deliver(row, payload, vapid, opts, stats, onSent) {
      const result = await sendPush(row, payload, vapid, opts);
      if (result.ok) {
        stats.sent++;
        writes.push(env.DB.prepare('UPDATE push_subscriptions SET fail_count = 0, updated_at = ?1 WHERE endpoint = ?2').bind(nowSec(), row.endpoint));
        if (onSent) onSent();
      } else if (result.gone) {
        stats.gone++;
        ledger.drop(row.endpoint);
      } else {
        stats.failed++;
        ledger.failed(row);
        console.warn('[push] send failed', result.status, result.error);
      }
    },
    async flush() {
      if (writes.length) await env.DB.batch(writes);
    },
  };
  return ledger;
}

// One */30 tick, for the features driven by the subscriber's clock:
// the morning briefing at `hour`, the threshold check at
// `threshold_hour`, the full-moon note before sunset. Each row yields
// zero or more jobs for this tick; jobs are grouped by rounded location
// and units so one forecast call serves every job at that place, and
// the whole tick stays under the subrequest and send budgets. Whatever
// doesn't fit is picked up by the next tick, because a job only marks
// itself done once its push is accepted.
export async function runClockFeatures(env, { now = new Date() } = {}) {
  const vapid = vapidFrom(env);
  const stats = {
    total: 0, due: 0, sent: 0, gone: 0, failed: 0, deferred: 0, forecasts: 0, forecastErrors: 0,
    briefings: 0, thresholds: 0, quiet: 0,
  };
  if (!vapid || !env.DB) return { ...stats, skipped: 'not configured' };
  const nowSec = Math.floor(now.getTime() / 1000);

  const { results: rows } = await env.DB
    .prepare('SELECT * FROM push_subscriptions WHERE briefing = 1 OR thresholds = 1 OR moon = 1').all();
  stats.total = rows.length;

  const groups = new Map();
  const add = (row, job) => {
    stats.due++;
    const key = forecastKey(row.lat, row.lon, unitsOf(row));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, ...job });
  };
  for (const row of rows) {
    const clock = localClock(row.tz, now);
    if (row.briefing && clock.hour === row.hour && row.last_sent_day !== clock.dateKey) {
      add(row, { kind: 'briefing', day: clock.dateKey });
    }
    if (row.thresholds && (row.threshold_mask | 0) && clock.hour === row.threshold_hour && row.threshold_last_day !== clock.dateKey) {
      add(row, { kind: 'thresholds', day: clock.dateKey });
    }
  }
  if (!stats.due) return stats;

  // Budget: one forecast fetch per group (two when a threshold job there
  // wants air quality) plus one send per job, and no more than MAX_SENDS
  // sends in total however the groups fall.
  let budget = MAX_SUBREQUESTS;
  let sends = MAX_SENDS;
  const plan = [];
  for (const [key, items] of groups) {
    const wantAqi = items.some((j) => j.kind === 'thresholds' && (j.row.threshold_mask & T.AQI));
    const fetches = wantAqi ? 2 : 1;
    if (budget < fetches + 1 || sends < 1) { stats.deferred += items.length; continue; }
    const take = Math.min(items.length, budget - fetches, sends);
    stats.deferred += items.length - take;
    budget -= fetches + take;
    sends -= take;
    plan.push({ key, items: items.slice(0, take), wantAqi });
  }

  const ledger = makeLedger(env);
  for (const { items, wantAqi } of plan) {
    const sample = items[0].row;
    let forecast, aqi = null;
    stats.forecasts++;
    try { forecast = await fetchForecast(sample.lat, sample.lon, unitsOf(sample)); }
    catch (err) {
      // Nothing is marked done, so the next tick retries this group.
      stats.forecastErrors++;
      console.warn('[push] forecast failed', sample.lat, sample.lon, err && err.message);
      continue;
    }
    if (wantAqi) {
      try { aqi = await fetchAirQuality(sample.lat, sample.lon); }
      catch (err) { console.warn('[push] air quality failed', sample.lat, sample.lon, err && err.message); }
    }
    await pool(items, SEND_CONCURRENCY, async (job) => {
      const { row } = job;
      if (job.kind === 'briefing') {
        stats.briefings++;
        await ledger.deliver(row, composeBriefing(row, forecast), vapid, { ttl: 6 * 3600, urgency: 'normal', topic: 'briefing' }, stats,
          () => ledger.update(row.endpoint, 'UPDATE push_subscriptions SET last_sent_day = ?1 WHERE endpoint = ?2', job.day));
      } else if (job.kind === 'thresholds') {
        stats.thresholds++;
        const items = evaluateThresholds(row, forecast, aqi, nowSec);
        const done = () => ledger.update(row.endpoint, 'UPDATE push_subscriptions SET threshold_last_day = ?1 WHERE endpoint = ?2', job.day);
        if (!items.length) { stats.quiet++; done(); return; }
        await ledger.deliver(row, composeThresholds(row, items, now.getTime()), vapid, { ttl: 6 * 3600, urgency: 'normal', topic: 'thresholds' }, stats, done);
      }
    });
  }
  await ledger.flush();
  return stats;
}

// One */5 tick. Every location with an alerts subscriber gets one NWS
// point query; each warning or watch the device hasn't been told about
// becomes a push. An Update that supersedes an alert the device already
// knows is recorded but not sent — a flood warning re-issued hourly is
// one notification, not twelve — while a genuinely new alert of the
// same kind (no references) is sent again.
export async function runAlerts(env, { now = new Date() } = {}) {
  const vapid = vapidFrom(env);
  const stats = { total: 0, locations: 0, fetched: 0, fetchErrors: 0, active: 0, sent: 0, gone: 0, failed: 0, deferred: 0, superseded: 0 };
  if (!vapid || !env.DB) return { ...stats, skipped: 'not configured' };
  const nowSec = Math.floor(now.getTime() / 1000);

  const { results: rows } = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE alerts = 1').all();
  stats.total = rows.length;
  if (!rows.length) return stats;

  const groups = new Map();
  for (const row of rows) {
    if (!inNwsBox(row.lat, row.lon)) continue;
    const key = alertKey(row.lat, row.lon);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  stats.locations = groups.size;
  if (!groups.size) return stats;

  // Everything sent in the last week, as "endpoint|alertId". Small
  // table, one query; pruned here so it stays small.
  await env.DB.prepare('DELETE FROM push_alerts_sent WHERE sent_at < ?1').bind(nowSec - ALERT_MEMORY_S).run();
  const { results: sentRows } = await env.DB.prepare('SELECT endpoint, alert_id FROM push_alerts_sent').all();
  const seen = new Set(sentRows.map((r) => `${r.endpoint}|${r.alert_id}`));

  const ledger = makeLedger(env);
  const remember = (endpoint, id) => {
    seen.add(`${endpoint}|${id}`);
    ledger.writes.push(env.DB
      .prepare('INSERT OR IGNORE INTO push_alerts_sent (endpoint, alert_id, sent_at) VALUES (?1, ?2, ?3)')
      .bind(endpoint, id, nowSec));
  };

  let budget = MAX_SUBREQUESTS;
  let sends = MAX_SENDS;
  for (const [, members] of groups) {
    if (budget < 1) { stats.deferred += members.length; continue; }
    budget--;
    stats.fetched++;
    let alerts;
    try { alerts = (await fetchActiveAlerts(members[0].lat, members[0].lon)).filter((p) => isPushWorthy(p, nowSec)); }
    catch (err) {
      stats.fetchErrors++;
      console.warn('[alerts] fetch failed', members[0].lat, members[0].lon, err && err.message);
      continue;
    }
    stats.active += alerts.length;
    if (!alerts.length) continue;

    const jobs = [];
    for (const row of members) {
      for (const p of alerts) {
        if (seen.has(`${row.endpoint}|${p.id}`)) continue;
        if (referencedIds(p).some((id) => seen.has(`${row.endpoint}|${id}`))) {
          stats.superseded++;
          remember(row.endpoint, p.id);
          continue;
        }
        jobs.push({ row, p });
      }
    }
    const take = Math.min(jobs.length, budget, sends);
    stats.deferred += jobs.length - take;
    budget -= take;
    sends -= take;
    await pool(jobs.slice(0, take), SEND_CONCURRENCY, ({ row, p }) =>
      ledger.deliver(row, composeAlert(row, p, now.getTime()), vapid, { ttl: alertTtl(p, nowSec), urgency: 'high' }, stats,
        () => remember(row.endpoint, p.id)));
    if (budget < 1 || sends < 1) break;
  }
  await ledger.flush();
  return stats;
}

export async function handleScheduled(event, env) {
  const stats = event.cron === CRON_ALERTS ? await runAlerts(env) : await runClockFeatures(env);
  console.log(JSON.stringify({ cron: event.cron, ...stats }));
}
