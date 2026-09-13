// Push notifications: the /api/push/* routes the app calls, and the
// cron-driven morning-briefing run.
//
// There are no accounts. A push endpoint is an unguessable URL minted
// by the browser's push service, so presenting it is what authorises
// reading, changing or deleting that one row. Rows live in D1 (binding
// DB; schema in migrations/).
//
// Free-plan budgets that shape the cron run (numbers from
// developers.cloudflare.com/workers/platform/limits, Sept 2026):
//   - 50 subrequests per invocation → forecasts + sends capped at 45
//   - 6 simultaneous outgoing connections → sends go 5 at a time
//   - 50 D1 queries per invocation → one SELECT plus one batch

import { sendPush, b64uToBytes } from './webpush.js';
import {
  localClock, isValidTimeZone, forecastKey, fetchDailyForecast, composeBriefing,
} from './briefing.js';

const MAX_SUBREQUESTS  = 45;
const SEND_CONCURRENCY = 5;
const MAX_FAILS        = 8;        // consecutive delivery failures before the row is dropped
const TEST_COOLDOWN_S  = 30;
const MAX_BODY_BYTES   = 8 * 1024;

const TEMP_UNITS   = new Set(['C', 'F']);
const WIND_UNITS   = new Set(['ms', 'kmh', 'mph']);
const PRECIP_UNITS = new Set(['mm', 'in']);
const TIME_FMTS    = new Set(['12h', '24h']);

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

// ── validation ────────────────────────────────────────────────────────

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
  return { lat, lon, name, tz: p.tz, hour, units };
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
    briefing: !!row.briefing,
    lastSentDay: row.last_sent_day || null,
  };
}

// ── routes ────────────────────────────────────────────────────────────

// `path` is what follows /api/push/.
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

async function subscribe(env, body) {
  const sub = parseSubscription(body.subscription);
  const prefs = parsePrefs(body.prefs);
  if (!sub)   return json({ error: 'Invalid subscription' }, 400);
  if (!prefs) return json({ error: 'Invalid preferences' }, 400);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO push_subscriptions
      (endpoint, p256dh, auth, lat, lon, city_name, tz, hour,
       temp_unit, wind_unit, precip_unit, time_fmt, briefing, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh, auth = excluded.auth,
      lat = excluded.lat, lon = excluded.lon, city_name = excluded.city_name,
      tz = excluded.tz, hour = excluded.hour,
      temp_unit = excluded.temp_unit, wind_unit = excluded.wind_unit,
      precip_unit = excluded.precip_unit, time_fmt = excluded.time_fmt,
      briefing = 1, fail_count = 0, updated_at = excluded.updated_at
  `).bind(
    sub.endpoint, sub.p256dh, sub.auth, prefs.lat, prefs.lon, prefs.name, prefs.tz, prefs.hour,
    prefs.units.temp, prefs.units.wind, prefs.units.precip, prefs.units.time, now
  ).run();
  const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1').bind(sub.endpoint).first();
  return json({ ok: true, prefs: publicPrefs(row) });
}

async function unsubscribe(env, body) {
  const endpoint = parseEndpoint(body.endpoint);
  if (!endpoint) return json({ error: 'Invalid endpoint' }, 400);
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).run();
  return json({ ok: true });
}

async function status(env, body) {
  const endpoint = parseEndpoint(body.endpoint);
  if (!endpoint) return json({ error: 'Invalid endpoint' }, 400);
  const row = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint).first();
  return json(row ? { subscribed: true, prefs: publicPrefs(row) } : { subscribed: false, prefs: null });
}

// The browser's push subscription was rotated (service worker
// `pushsubscriptionchange`): move the row to the new endpoint so the
// preferences survive.
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
  try { forecast = await fetchDailyForecast(row.lat, row.lon, unitsOf(row)); }
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

// ── cron ──────────────────────────────────────────────────────────────

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// One cron tick. Every subscriber whose local clock is inside their
// chosen hour and who hasn't had today's briefing gets one. Rows are
// grouped by rounded location so nearby subscribers share a forecast
// call, and the whole tick stays under the subrequest budget; anything
// that doesn't fit is picked up by the :30 tick.
export async function runBriefings(env, { now = new Date() } = {}) {
  const vapid = vapidFrom(env);
  const stats = { total: 0, due: 0, sent: 0, gone: 0, failed: 0, deferred: 0, forecasts: 0, forecastErrors: 0 };
  if (!vapid || !env.DB) return { ...stats, skipped: 'not configured' };

  const { results: rows } = await env.DB.prepare('SELECT * FROM push_subscriptions WHERE briefing = 1').all();
  stats.total = rows.length;

  const groups = new Map();
  for (const row of rows) {
    const clock = localClock(row.tz, now);
    if (clock.hour !== row.hour || row.last_sent_day === clock.dateKey) continue;
    stats.due++;
    const key = forecastKey(row.lat, row.lon, unitsOf(row));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, day: clock.dateKey });
  }
  if (!stats.due) return stats;

  // Budget: one forecast fetch per group plus one send per row.
  let budget = MAX_SUBREQUESTS;
  const plan = [];
  for (const [key, items] of groups) {
    if (budget < 2) { stats.deferred += items.length; continue; }
    const take = Math.min(items.length, budget - 1);
    stats.deferred += items.length - take;
    budget -= 1 + take;
    plan.push({ key, items: items.slice(0, take) });
  }

  const writes = [];
  const markSent = (endpoint, day) => writes.push(env.DB
    .prepare('UPDATE push_subscriptions SET last_sent_day = ?1, fail_count = 0, updated_at = ?2 WHERE endpoint = ?3')
    .bind(day, Math.floor(Date.now() / 1000), endpoint));
  const drop = (endpoint) => writes.push(env.DB
    .prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(endpoint));
  const markFailed = (row) => {
    if (row.fail_count + 1 >= MAX_FAILS) return drop(row.endpoint);
    writes.push(env.DB
      .prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE endpoint = ?1')
      .bind(row.endpoint));
  };

  for (const { items } of plan) {
    const sample = items[0].row;
    let forecast;
    stats.forecasts++;
    try { forecast = await fetchDailyForecast(sample.lat, sample.lon, unitsOf(sample)); }
    catch (err) {
      // Leave last_sent_day alone so the next tick retries this group.
      stats.forecastErrors++;
      console.warn('[briefing] forecast failed', sample.lat, sample.lon, err && err.message);
      continue;
    }
    await pool(items, SEND_CONCURRENCY, async ({ row, day }) => {
      const payload = composeBriefing(row, forecast);
      const result = await sendPush(row, payload, vapid, { ttl: 6 * 3600, urgency: 'normal', topic: 'briefing' });
      if (result.ok)        { stats.sent++;   markSent(row.endpoint, day); }
      else if (result.gone) { stats.gone++;   drop(row.endpoint); }
      else                  { stats.failed++; markFailed(row); console.warn('[briefing] push failed', result.status, result.error); }
    });
  }

  if (writes.length) await env.DB.batch(writes);
  return stats;
}

export async function handleScheduled(event, env) {
  const stats = await runBriefings(env);
  console.log(JSON.stringify({ cron: event.cron, ...stats }));
}
