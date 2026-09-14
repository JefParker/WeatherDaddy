// Exercises the cron planners in worker/push.js against a fake D1 and a
// stubbed network, plus the pure helpers each feature is built on. No
// dependencies; Node 20+.
//
//     node tools/push-logic-test.mjs

import { runBriefings, runAlerts } from '../worker/push.js';
import { isPushWorthy, referencedIds, formatAlertTime, alertGist, composeAlert, alertTtl, inNwsBox } from '../worker/alerts.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) === JSON.stringify(want) ? '' : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);

// ── Fixtures ─────────────────────────────────────────────────────────
const b64u = (b) => Buffer.from(b).toString('base64url');
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const p256dh = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey)));
const auth = b64u(crypto.getRandomValues(new Uint8Array(16)));
const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const baseEnv = {
  VAPID_PUBLIC_KEY: b64u(new Uint8Array(await crypto.subtle.exportKey('raw', vk.publicKey))),
  VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', vk.privateKey)).d,
};
const NOW = new Date('2026-09-15T20:07:00Z');
const row = (i, extra = {}) => ({
  endpoint: `https://push.example/${i}`, p256dh, auth, lat: 39.74, lon: -104.99, city_name: 'Denver', tz: 'UTC',
  hour: 20, temp_unit: 'F', wind_unit: 'mph', precip_unit: 'in', time_fmt: '12h',
  briefing: 1, alerts: 0, thresholds: 0, threshold_hour: 17, threshold_mask: 63, moon: 0,
  last_sent_day: null, threshold_last_day: null, moon_last_key: null, fail_count: 0, ...extra,
});

// A fake D1: `tables` answers SELECTs by a substring of the SQL; every
// write is recorded as its SQL + binds.
function fakeDB(tables) {
  const writes = [];
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: (Object.entries(tables).find(([k]) => sql.includes(k)) || [, () => []])[1](binds) }),
    first: async () => null,
    run: async () => { writes.push({ sql, binds }); return {}; },
    _sql: sql, _binds: binds,
  });
  return { writes, prepare: (sql) => stmt(sql), batch: async (stmts) => { for (const s of stmts) writes.push({ sql: s._sql, binds: s._binds }); } };
}

const pushed = [];
const forecastJson = { daily: { temperature_2m_max: [70], temperature_2m_min: [50], weathercode: [1], precipitation_probability_max: [10] }, current: { temperature_2m: 60, weather_code: 1 } };
let nwsJson = { features: [] };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('open-meteo')) return new Response(JSON.stringify(forecastJson));
  if (u.includes('api.weather.gov')) return new Response(JSON.stringify(nwsJson));
  pushed.push({ url: u, headers: init.headers });
  return new Response('', { status: u.includes('/dead') ? 410 : 201 });
};

// ── Briefing planner ─────────────────────────────────────────────────
{
  const env = { ...baseEnv, DB: fakeDB({ 'WHERE briefing = 1': () => Array.from({ length: 60 }, (_, i) => row(i)) }) };
  const s = await runBriefings(env, { now: NOW });
  eq('briefing: 60 due in one place → 25 sent, 35 deferred', [s.due, s.sent, s.deferred, s.forecasts], [60, 25, 35, 1]);
}
{
  const env = { ...baseEnv, DB: fakeDB({ 'WHERE briefing = 1': () => Array.from({ length: 30 }, (_, i) => row(i, { lat: 30 + i })) }) };
  const s = await runBriefings(env, { now: NOW });
  eq('briefing: 30 places → 22 sent (a fetch each), 8 deferred', [s.sent, s.deferred, s.forecasts], [22, 8, 22]);
}
{
  const env = { ...baseEnv, DB: fakeDB({ 'WHERE briefing = 1': () => [row(0), row('dead'), row(2, { last_sent_day: '2026-09-15' })] }) };
  const s = await runBriefings(env, { now: NOW });
  eq('briefing: dead endpoint dropped, already-sent skipped', [s.due, s.sent, s.gone], [2, 1, 1]);
  check('briefing: last_sent_day written for the sent row', env.DB.writes.some(w => w.sql.includes('last_sent_day') && w.binds[0] === '2026-09-15' && w.binds[1] === 'https://push.example/0'));
  check('briefing: dead row deleted', env.DB.writes.some(w => w.sql.startsWith('DELETE FROM push_subscriptions') && w.binds[0] === 'https://push.example/dead'));
}

// ── Alert helpers ────────────────────────────────────────────────────
const nowSec = NOW.getTime() / 1000;
const alert = (over = {}) => ({
  id: 'urn:oid:1', event: 'Tornado Warning', severity: 'Extreme', messageType: 'Alert', references: [],
  sent: '2026-09-15T14:00:00-06:00', ends: '2026-09-15T14:45:00-06:00', expires: '2026-09-15T14:45:00-06:00',
  areaDesc: 'Denver, CO; Adams, CO', headline: 'Tornado Warning issued …',
  description: 'At 200 PM MDT, a severe thunderstorm capable of producing a tornado was located near Denver, moving northeast at 25 mph. HAZARD...Tornado.', ...over,
});
check('worthy: warning', isPushWorthy(alert(), nowSec));
check('worthy: watch', isPushWorthy(alert({ event: 'Flood Watch' }), nowSec));
check('not worthy: advisory', !isPushWorthy(alert({ event: 'Heat Advisory' }), nowSec));
check('not worthy: statement', !isPushWorthy(alert({ event: 'Special Weather Statement' }), nowSec));
check('not worthy: already ended', !isPushWorthy(alert({ ends: '2026-09-15T13:00:00-06:00' }), nowSec));
eq('references', referencedIds(alert({ references: [{ identifier: 'a' }, { identifier: 'b' }] })), ['a', 'b']);
eq('time: same day 12h', formatAlertTime('2026-09-15T14:45:00-06:00', '12h', NOW.getTime()), '2:45 PM');
eq('time: same day 24h', formatAlertTime('2026-09-15T14:45:00-06:00', '24h', NOW.getTime()), '14:45');
eq('time: another day', formatAlertTime('2026-09-16T06:00:00-06:00', '12h', NOW.getTime()), 'Wed 6:00 AM');
eq('gist: first sentence', alertGist(alert()), 'At 200 PM MDT, a severe thunderstorm capable of producing a tornado was located near Denver, moving northeast at 25 mph.');
eq('gist: WHAT paragraph', alertGist(alert({ description: '* WHAT...Heavy snow expected. Total snow\naccumulations of 8 to 14 inches.\n\n* WHERE...Front Range.' })), 'Heavy snow expected. Total snow accumulations of 8 to 14 inches.');
eq('gist: ...WHAT... form', alertGist(alert({ description: '...WHAT...Heavy rain.\n...WHERE...Here.' })), 'Heavy rain.');
eq('gist: falls back to area', alertGist(alert({ description: '' })), 'Denver, CO; Adams, CO');
{
  const p = composeAlert(row(0), alert(), NOW.getTime());
  eq('compose: title', p.title, 'Tornado Warning');
  eq('compose: body line 1', p.body.split('\n')[0], 'Denver · until 2:45 PM');
  eq('compose: tag per alert', p.tag, 'alert:urn:oid:1');
  eq('compose: url', p.url, '/?lat=39.74&lon=-104.99&name=Denver');
}
eq('ttl: until ends', alertTtl(alert(), nowSec), 38 * 60);
eq('ttl: floor', alertTtl(alert({ ends: '2026-09-15T14:07:30-06:00' }), nowSec), 60);
check('nws box: Denver in, London out, Honolulu in', inNwsBox(39.74, -104.99) && !inNwsBox(51.5, -0.12) && inNwsBox(21.3, -157.86));

// ── Alert planner ────────────────────────────────────────────────────
{
  nwsJson = { features: [{ properties: alert() }, { properties: alert({ id: 'urn:oid:2', event: 'Heat Advisory' }) }, { properties: alert({ id: 'urn:oid:3', event: 'Flood Watch' }) }] };
  const rows = [row(0, { alerts: 1 }), row(1, { alerts: 1 }), row('london', { alerts: 1, lat: 51.5, lon: -0.12 })];
  const env = { ...baseEnv, DB: fakeDB({ 'WHERE alerts = 1': () => rows, 'FROM push_alerts_sent': () => [{ endpoint: 'https://push.example/1', alert_id: 'urn:oid:1' }] }) };
  pushed.length = 0;
  const s = await runAlerts(env, { now: NOW });
  eq('alerts: one US place fetched, London skipped', [s.total, s.locations, s.fetched], [3, 1, 1]);
  eq('alerts: 2 worthy of 3 active', s.active, 2);
  eq('alerts: row0 gets both, row1 already had the warning → 3 sent', s.sent, 3);
  check('alerts: prune ran', env.DB.writes.some(w => w.sql.startsWith('DELETE FROM push_alerts_sent WHERE sent_at')));
  eq('alerts: 3 ids remembered', env.DB.writes.filter(w => w.sql.includes('INSERT OR IGNORE INTO push_alerts_sent')).map(w => w.binds.slice(0, 2)),
    [['https://push.example/0', 'urn:oid:1'], ['https://push.example/0', 'urn:oid:3'], ['https://push.example/1', 'urn:oid:3']]);
  check('alerts: urgency high', pushed.every(p => p.headers.Urgency === 'high'));
}
{
  // An Update that references an id the device knows is recorded, not sent.
  nwsJson = { features: [{ properties: alert({ id: 'urn:oid:9', messageType: 'Update', references: [{ identifier: 'urn:oid:1' }] }) }] };
  const env = { ...baseEnv, DB: fakeDB({ 'WHERE alerts = 1': () => [row(0, { alerts: 1 }), row(1, { alerts: 1 })], 'FROM push_alerts_sent': () => [{ endpoint: 'https://push.example/1', alert_id: 'urn:oid:1' }] }) };
  const s = await runAlerts(env, { now: NOW });
  eq('alerts: update sent to the row that never saw the original, superseded for the other', [s.sent, s.superseded], [1, 1]);
  check('alerts: the superseded id is remembered too', env.DB.writes.some(w => w.sql.includes('push_alerts_sent (endpoint') && w.binds[0] === 'https://push.example/1' && w.binds[1] === 'urn:oid:9'));
}
{
  // Send cap across many subscribers under one warning.
  nwsJson = { features: [{ properties: alert() }] };
  const env = { ...baseEnv, DB: fakeDB({ 'WHERE alerts = 1': () => Array.from({ length: 40 }, (_, i) => row(i, { alerts: 1 })), 'FROM push_alerts_sent': () => [] }) };
  const s = await runAlerts(env, { now: NOW });
  eq('alerts: 40 under one warning → 25 sent, 15 deferred to the next 5-minute tick', [s.sent, s.deferred], [25, 15]);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall push logic checks pass');
process.exit(failures ? 1 : 0);
