// Exercises the cron planners in worker/push.js against a fake D1 and a
// stubbed network, plus the pure helpers each feature is built on. No
// dependencies; Node 20+.
//
//     node tools/push-logic-test.mjs

import { runClockFeatures as runBriefings, runAlerts } from '../worker/push.js';
import { isPushWorthy, referencedIds, formatAlertTime, alertGist, composeAlert, alertTtl, inNwsBox } from '../worker/alerts.js';
import { T, T_ALL, evaluateThresholds, composeThresholds, hourLabel } from '../worker/thresholds.js';
import { localIsoToEpoch } from '../worker/briefing.js';
import { nearbyFullMoons, solarTimes, moonDue, composeMoon, skyAt, moonIllumination } from '../worker/moon.js';
import { skyDue, composeSky, METEOR_SHOWERS, ECLIPSES } from '../worker/sky.js';
import { changesSlot, evaluateChanges, composeChanges, sinceWord } from '../worker/changes.js';

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
  briefing: 1, alerts: 0, thresholds: 0, threshold_hour: 17, threshold_mask: 63, moon: 0, sky: 0, changes: 0,
  last_sent_day: null, threshold_last_day: null, moon_last_key: null, sky_last_key: null,
  changes_snapshot: null, changes_last_slot: null, fail_count: 0, ...extra,
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
// Two days of hourly data starting at local midnight of NOW's day (UTC
// city). Calm by default; tests override single hours.
const hourly = (over = {}) => {
  const time = Array.from({ length: 48 }, (_, i) => new Date(Date.UTC(2026, 8, 15) + i * 3600000).toISOString().slice(0, 16));
  const fill = (v) => Array(48).fill(v);
  const h = { time, temperature_2m: fill(60), apparent_temperature: fill(60), wind_gusts_10m: fill(10), rain: fill(0), snowfall: fill(0), precipitation_probability: fill(0), cloud_cover: fill(20), weather_code: fill(1) };
  for (const [k, edits] of Object.entries(over)) for (const [i, v] of Object.entries(edits)) h[k][i] = v;
  return h;
};
const daily = (over = {}) => ({ time: ['2026-09-15', '2026-09-16'], temperature_2m_max: [70, 72], temperature_2m_min: [50, 51], weathercode: [1, 1], precipitation_probability_max: [10, 10], snowfall_sum: [0, 0], ...over });
let forecastJson = { daily: daily(), current: { temperature_2m: 60, weather_code: 1 }, hourly: hourly(), utc_offset_seconds: 0 };
let aqiJson = { hourly: { time: hourly().time, us_aqi: Array(48).fill(30) }, utc_offset_seconds: 0 };
let nwsJson = { features: [] };
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('air-quality')) return new Response(JSON.stringify(aqiJson));
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

// ── Threshold evaluation ─────────────────────────────────────────────
// NOW is 20:07 UTC on the 15th → window is hours 21..44 (21:00 on the
// 15th through 20:00 on the 16th).
const nowSecT = NOW.getTime() / 1000;
const fc = (over) => ({ hourly: hourly(over), utcOffset: 0 });
const trow = (extra = {}) => row(0, { thresholds: 1, threshold_mask: 63, ...extra });
eq('iso→epoch honours the offset', localIsoToEpoch('2026-09-15T05:00', -21600), Date.UTC(2026, 8, 15, 11) / 1000);
eq('hour label 12h', hourLabel('2026-09-16T05:00', '12h'), 'Wed 5 AM');
eq('hour label 24h', hourLabel('2026-09-16T17:00', '24h'), 'Wed 17:00');
eq('calm forecast → nothing', evaluateThresholds(trow(), fc(), null, nowSecT), []);
eq('freeze: coldest hour named', evaluateThresholds(trow(), fc({ temperature_2m: { 29: 30, 30: 28, 31: 31 } }), null, nowSecT).map(i => i.text), ['Low of 28° around Wed 6 AM.']);
eq('freeze: outside the window is ignored', evaluateThresholds(trow(), fc({ temperature_2m: { 10: 20, 46: 20 } }), null, nowSecT), []);
eq('freeze: °C cutoff', evaluateThresholds(trow({ temp_unit: 'C', threshold_mask: T.FREEZE }), fc({ temperature_2m: { 30: 0 } }), null, nowSecT).map(i => i.bit), [T.FREEZE]);
eq('freeze: °C, 1° is not a freeze', evaluateThresholds(trow({ temp_unit: 'C', threshold_mask: T.FREEZE }), fc({ temperature_2m: { 30: 1 } }), null, nowSecT), []);
eq('heat: apparent temperature', evaluateThresholds(trow(), fc({ apparent_temperature: { 39: 104 } }), null, nowSecT).map(i => i.text), ['Feels like 104° around Wed 3 PM.']);
eq('wind: mph', evaluateThresholds(trow(), fc({ wind_gusts_10m: { 22: 52 } }), null, nowSecT).map(i => i.text), ['Gusts to 52 mph around Tue 10 PM.']);
eq('wind: km/h cutoff not reached at 52', evaluateThresholds(trow({ wind_unit: 'kmh' }), fc({ wind_gusts_10m: { 22: 52 } }), null, nowSecT), []);
eq('rain: totals over the window', evaluateThresholds(trow(), fc({ rain: { 25: 0.4, 26: 0.5, 27: 0.3 } }), null, nowSecT).map(i => i.text), ['1.2 in of rain by Wed 3 AM.']);
eq('rain: mm cutoff', evaluateThresholds(trow({ precip_unit: 'mm' }), fc({ rain: { 25: 20, 26: 6 } }), null, nowSecT).map(i => i.text), ['26 mm of rain by Wed 2 AM.']);
eq('snow: inches', evaluateThresholds(trow(), fc({ snowfall: { 30: 2, 31: 1.5 } }), null, nowSecT).map(i => i.text), ['3.5 in of snow by Wed 7 AM.']);
eq('aqi: needs the air-quality series', evaluateThresholds(trow(), fc(), null, nowSecT), []);
eq('aqi: worst hour', evaluateThresholds(trow(), fc(), { hourly: { time: hourly().time, us_aqi: Object.assign(Array(48).fill(30), { 35: 132, 36: 120 }) }, utcOffset: 0 }, nowSecT).map(i => i.text), ['AQI 132 around Wed 11 AM.']);
eq('mask: unticked items stay silent', evaluateThresholds(trow({ threshold_mask: T.HEAT }), fc({ temperature_2m: { 30: 20 }, apparent_temperature: { 39: 104 } }), null, nowSecT).map(i => i.bit), [T.HEAT]);
eq('umbrella: bit 64, T_ALL 127', [T.UMBRELLA, T_ALL], [64, 127]);
eq('umbrella: likeliest hour', evaluateThresholds(trow({ threshold_mask: T.UMBRELLA }), fc({ precipitation_probability: { 30: 40, 38: 70, 39: 65 } }), null, nowSecT).map(i => i.text), ['70% chance of rain around Wed 2 PM.']);
eq('umbrella: 49% is not worth carrying one', evaluateThresholds(trow({ threshold_mask: T.UMBRELLA }), fc({ precipitation_probability: { 38: 49 } }), null, nowSecT), []);
eq('umbrella: outside the window is ignored', evaluateThresholds(trow({ threshold_mask: T.UMBRELLA }), fc({ precipitation_probability: { 5: 90, 47: 90 } }), null, nowSecT), []);
eq('umbrella: says snow when snow falls that hour', evaluateThresholds(trow({ threshold_mask: T.UMBRELLA }), fc({ precipitation_probability: { 30: 80 }, snowfall: { 30: 0.4 } }), null, nowSecT).map(i => i.text), ['80% chance of snow around Wed 6 AM.']);
eq('umbrella: not ticked in the old default mask', evaluateThresholds(trow({ threshold_mask: 63 }), fc({ precipitation_probability: { 30: 80 } }), null, nowSecT), []);
eq('umbrella: title', composeThresholds(trow(), evaluateThresholds(trow({ threshold_mask: T.UMBRELLA }), fc({ precipitation_probability: { 30: 80 } }), null, nowSecT), NOW.getTime()).title, 'Umbrella · Denver');
{
  const items = evaluateThresholds(trow(), fc({ temperature_2m: { 30: 28 }, wind_gusts_10m: { 22: 52 } }), null, nowSecT);
  const one = composeThresholds(trow(), items.slice(0, 1), NOW.getTime());
  const two = composeThresholds(trow(), items, NOW.getTime());
  eq('compose: single item title', one.title, 'Freeze · Denver');
  eq('compose: two items', [two.title, two.body], ['Denver · 2 heads-ups', 'Low of 28° around Wed 6 AM.\nGusts to 52 mph around Tue 10 PM.']);
  eq('compose: tag', two.tag, 'thresholds');
}

// ── Clock planner with mixed jobs ────────────────────────────────────
{
  // Three rows in one place, all due at 20:00: a briefing, a quiet
  // threshold check, and a threshold check that trips (AQI ticked →
  // the group spends a second subrequest on air quality).
  forecastJson = { ...forecastJson, hourly: hourly({ temperature_2m: { 30: 28 } }) };
  aqiJson = { hourly: { time: hourly().time, us_aqi: Object.assign(Array(48).fill(30), { 35: 150 }) }, utc_offset_seconds: 0 };
  const rows = [
    row('b'),
    row('q', { briefing: 0, thresholds: 1, threshold_hour: 20, threshold_mask: T.HEAT }),
    row('t', { briefing: 0, thresholds: 1, threshold_hour: 20, threshold_mask: 63 }),
    row('later', { briefing: 0, thresholds: 1, threshold_hour: 21, threshold_mask: 63 }),
    row('done', { briefing: 0, thresholds: 1, threshold_hour: 20, threshold_mask: 63, threshold_last_day: '2026-09-15' }),
  ];
  const env = { ...baseEnv, DB: fakeDB({ 'OR thresholds = 1': () => rows, 'WHERE briefing = 1': () => rows }) };
  pushed.length = 0;
  const s = await runBriefings(env, { now: NOW });
  eq('clock: 3 jobs due (briefing, quiet check, tripping check)', [s.due, s.briefings, s.thresholds, s.quiet], [3, 1, 2, 1]);
  eq('clock: 2 pushes, one forecast group', [s.sent, s.forecasts], [2, 1]);
  check('clock: quiet check still marked done', env.DB.writes.some(w => w.sql.includes('threshold_last_day') && w.binds[1] === 'https://push.example/q'));
  check('clock: tripping check marked done', env.DB.writes.some(w => w.sql.includes('threshold_last_day') && w.binds[1] === 'https://push.example/t'));
  check('clock: briefing marked done', env.DB.writes.some(w => w.sql.includes('last_sent_day') && w.binds[1] === 'https://push.example/b'));
  check('clock: threshold push has its topic', pushed.some(p => p.headers.Topic === 'thresholds'));
  forecastJson = { ...forecastJson, hourly: hourly() };
}

// ── Full moon ────────────────────────────────────────────────────────
{
  const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 16);
  eq('moons near mid-September 2026', nearbyFullMoons(Date.parse('2026-09-14T00:00Z') / 1000).map(m => m.name), ['Sturgeon Moon', 'Harvest Moon', "Hunter's Moon"]);
  eq('second full moon in May 2026 is a Blue Moon', nearbyFullMoons(Date.parse('2026-05-20T00:00Z') / 1000).map(m => m.name), ['Flower Moon', 'Blue Moon', 'Strawberry Moon']);
  const den = solarTimes(2026, 9, 26, 39.74, -104.99, 'America/Denver');
  eq('Denver sunset 2026-09-26 ≈ 00:50Z (6:50 PM MDT)', iso(den.sunset), '2026-09-27T00:50');
  eq('Tokyo sunrise 2026-09-26 ≈ 20:31Z (5:31 JST)', iso(solarTimes(2026, 9, 26, 35.68, 139.69, 'Asia/Tokyo').sunrise), '2026-09-25T20:31');
  check('polar night → null', solarTimes(2026, 12, 21, 78.2, 15.6, 'Arctic/Longyearbyen').sunset === null);

  const mrow = (extra = {}) => row('m', { briefing: 0, moon: 1, tz: 'America/Denver', ...extra });
  const harvest = nearbyFullMoons(Date.parse('2026-09-26T12:00Z') / 1000)[1];
  eq('the Harvest Moon peak', iso(harvest.dt), '2026-09-26T06:56');
  // Its local day in Denver is the 26th; sunset that day is 00:50Z on the 27th.
  const sunset = den.sunset;
  check('due 45 min before sunset', !!moonDue(mrow(), sunset - 45 * 60));
  check('due at 75 min before (window start)', !!moonDue(mrow(), sunset - 75 * 60));
  check('not due 2 h before sunset', !moonDue(mrow(), sunset - 120 * 60));
  check('not due 10 min before sunset (window closed)', !moonDue(mrow(), sunset - 10 * 60));
  check('not due the evening before', !moonDue(mrow(), sunset - 86400 - 45 * 60));
  check('not due the evening after', !moonDue(mrow(), sunset + 86400 - 45 * 60));
  check('not due once sent for this moon', !moonDue(mrow({ moon_last_key: String(harvest.dt) }), sunset - 45 * 60));
  check('due again for the next moon despite last key', !!moonDue(mrow({ moon_last_key: 'old' }), sunset - 45 * 60));
  const job = moonDue(mrow(), sunset - 45 * 60);
  eq('job key is the peak', job.key, String(harvest.dt));
  check('peak (06:56Z on the 26th) is not in the night → best viewing is mid-night', job.best !== harvest.dt && job.best > job.sunset && job.best < job.sunrise);

  // A forecast whose hourly series covers that night, in Denver time.
  const t0 = Date.UTC(2026, 8, 26, 6); // local midnight MDT = 06:00Z
  const times = Array.from({ length: 48 }, (_, i) => new Date(t0 + i * 3600000 - 6 * 3600000).toISOString().slice(0, 16));
  const fcm = (cc, code = 1) => ({ hourly: { time: times, cloud_cover: Array(48).fill(cc), weather_code: Array(48).fill(code) }, utcOffset: -21600, timezone: 'America/Denver' });
  eq('sky: clear', skyAt(fcm(10), job.best), 'Clear skies expected.');
  eq('sky: partly', skyAt(fcm(50), job.best), 'Partly cloudy.');
  eq('sky: overcast', skyAt(fcm(90), job.best), 'Mostly cloudy — it may stay hidden.');
  eq('sky: rain code wins', skyAt(fcm(10, 61), job.best), 'Precipitation likely — it may stay hidden.');
  eq('sky: series does not reach that hour', skyAt({ hourly: { time: times.slice(0, 5), cloud_cover: [1, 1, 1, 1, 1] }, utcOffset: -21600 }, job.best), '');
  const note = composeMoon(mrow(), job, fcm(10), NOW.getTime());
  eq('compose: title', note.title, 'Harvest Moon tonight');
  eq('compose: body', note.body, 'Denver · sunset 6:50 PM\nBest viewing around 12:51 AM. Clear skies expected.');
  eq('compose: 24h clock', composeMoon(mrow({ time_fmt: '24h' }), job, fcm(10), NOW.getTime()).body.split('\n')[0], 'Denver · sunset 18:50');
  eq('compose: tag', note.tag, 'moon');

  // Through the planner: a moon job and a briefing for the same row in
  // one tick share the forecast call.
  const when = new Date((sunset - 45 * 60) * 1000);
  const hourThen = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hourCycle: 'h23' }).format(when));
  const rows = [mrow({ briefing: 1, hour: hourThen })];
  forecastJson = { ...forecastJson, hourly: fcm(10).hourly, utc_offset_seconds: -21600, timezone: 'America/Denver' };
  const env = { ...baseEnv, DB: fakeDB({ 'OR thresholds = 1': () => rows }) };
  pushed.length = 0;
  const st = await runBriefings(env, { now: when });
  eq('clock: moon + briefing → 2 jobs, 1 forecast, 2 sent', [st.due, st.moons, st.briefings, st.forecasts, st.sent], [2, 1, 1, 1, 2]);
  check('clock: moon_last_key written', env.DB.writes.some(w => w.sql.includes('moon_last_key') && w.binds[0] === String(harvest.dt)));
  check('clock: moon push has its topic', pushed.some(p => p.headers.Topic === 'moon'));
  forecastJson = { ...forecastJson, hourly: hourly(), utc_offset_seconds: 0, timezone: null };
}

// ── Sky events ───────────────────────────────────────────────────────
{
  const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 16);
  const srow = (extra = {}) => row('s', { briefing: 0, sky: 1, tz: 'America/Denver', ...extra });
  const tokyo = (extra = {}) => srow({ lat: 35.68, lon: 139.69, tz: 'Asia/Tokyo', city_name: 'Tokyo', ...extra });
  check('every shower and eclipse has a unique key', new Set([...METEOR_SHOWERS, ...ECLIPSES].map(e => e.key)).size === METEOR_SHOWERS.length + ECLIPSES.length);
  check('eclipse times parse', ECLIPSES.every(e => Number.isFinite(Date.parse(e.max))));
  check('solar eclipses carry a box and a partial region', ECLIPSES.filter(e => e.kind === 'solar').every(e => e.box && e.box.length === 4 && e.partial));
  eq('moon illumination: full', Math.round(moonIllumination(Date.parse('2026-09-26T16:49Z') / 1000) * 100), 100);
  eq('moon illumination: new (Perseids 2026 peak)', Math.round(moonIllumination(Date.parse('2026-08-12T17:37Z') / 1000) * 100), 0);

  // Perseids: peak night Aug 12. Denver sunset that day ≈ 02:03Z on the 13th.
  const sunset = solarTimes(2026, 8, 12, 39.74, -104.99, 'America/Denver').sunset;
  eq('Denver sunset 2026-08-12 ≈ 02:00Z (8:00 PM MDT)', iso(sunset), '2026-08-13T02:00');
  check('perseids: due 45 min before sunset', !!skyDue(srow(), sunset - 45 * 60));
  check('perseids: not due 2 h before', !skyDue(srow(), sunset - 120 * 60));
  check('perseids: not due after the window', !skyDue(srow(), sunset - 10 * 60));
  check('perseids: not due the night before', !skyDue(srow(), sunset - 86400 - 45 * 60));
  check('perseids: once per year', !skyDue(srow({ sky_last_key: 'perseids-2026' }), sunset - 45 * 60));
  check('perseids: a different key does not block', !!skyDue(srow({ sky_last_key: 'perseids-2025' }), sunset - 45 * 60));
  const pj = skyDue(srow(), sunset - 45 * 60);
  eq('perseids: job', [pj.key, pj.what, pj.event.name], ['perseids-2026', 'meteor', 'Perseids']);
  check('perseids: best viewing two hours before dawn', pj.best === pj.sunrise - 7200 && pj.best > pj.sunset);
  const t0 = Date.UTC(2026, 7, 12, 6);
  const times = Array.from({ length: 48 }, (_, i) => new Date(t0 + i * 3600000 - 6 * 3600000).toISOString().slice(0, 16));
  const fcs = (cc) => ({ hourly: { time: times, cloud_cover: Array(48).fill(cc), weather_code: Array(48).fill(1) }, utcOffset: -21600, timezone: 'America/Denver' });
  const note = composeSky(srow(), pj, fcs(10), NOW.getTime());
  eq('perseids: title', note.title, 'Perseids peak tonight');
  eq('perseids: body', note.body, 'Denver · up to 100 meteors an hour under a dark sky\nBest after midnight, away from city lights. Clear skies expected. Moon 0% lit.');
  eq('perseids: tag', note.tag, 'sky');

  // Partial lunar eclipse 2026-08-28 04:13Z: 10:13 PM MDT on the 27th in
  // Denver (night of the 27th), 1:13 PM JST in Tokyo (daytime, unseen).
  const lmax = Date.parse('2026-08-28T04:13Z') / 1000;
  const dsunset = solarTimes(2026, 8, 27, 39.74, -104.99, 'America/Denver').sunset;
  check('lunar: due before sunset on the night of the 27th in Denver', !!skyDue(srow(), dsunset - 45 * 60));
  check('lunar: not due the evening before', !skyDue(srow(), dsunset - 86400 - 45 * 60));
  check('lunar: not due the evening after', !skyDue(srow(), dsunset + 86400 - 45 * 60));
  const tsunset = solarTimes(2026, 8, 28, 35.68, 139.69, 'Asia/Tokyo').sunset;
  check('lunar: not visible from Tokyo (Moon down at greatest eclipse)', !skyDue(tokyo(), tsunset - 45 * 60) && !skyDue(tokyo(), tsunset - 86400 - 45 * 60));
  const lj = skyDue(srow(), dsunset - 45 * 60);
  eq('lunar: job', [lj.key, lj.what, lj.max], ['lunar-2026-08-28', 'lunar', lmax]);
  const lt0 = Date.UTC(2026, 7, 27, 6);
  const ltimes = Array.from({ length: 48 }, (_, i) => new Date(lt0 + i * 3600000 - 6 * 3600000).toISOString().slice(0, 16));
  const lnote = composeSky(srow(), lj, { hourly: { time: ltimes, cloud_cover: Array(48).fill(50), weather_code: Array(48).fill(2) }, utcOffset: -21600, timezone: 'America/Denver' }, NOW.getTime());
  eq('lunar: title', lnote.title, 'Partial lunar eclipse tonight');
  eq('lunar: body', lnote.body, "Denver · greatest at 10:13 PM\nEarth's shadow takes a bite out of the Moon around then. Partly cloudy.");

  // Total solar eclipse 2026-08-12 17:46Z: Denver is inside the coarse
  // box with the Sun up (11:46 AM MDT); Tokyo is outside the box.
  const smax = Date.parse('2026-08-12T17:46Z') / 1000;
  check('solar: due 2 h before the peak in Denver', !!skyDue(srow(), smax - 120 * 60));
  check('solar: not due 3 h before', !skyDue(srow(), smax - 180 * 60));
  check('solar: not due an hour before', !skyDue(srow(), smax - 60 * 60));
  check('solar: not due in Tokyo', !skyDue(tokyo(), smax - 120 * 60));
  check('solar: sent once', !skyDue(srow({ sky_last_key: 'solar-2026-08-12' }), smax - 120 * 60));
  const sj = skyDue(srow(), smax - 120 * 60);
  eq('solar: job', [sj.key, sj.what], ['solar-2026-08-12', 'solar']);
  const snote = composeSky(srow(), sj, fcs(10), NOW.getTime());
  eq('solar: title', snote.title, 'Total solar eclipse today');
  eq('solar: body', snote.body, 'Denver · peak around 11:46 AM\nTotal over Greenland, Iceland and northern Spain, partial across northern North America, Europe and North Africa. Eclipse glasses only. Clear skies expected.');
  eq('solar: 24h clock', composeSky(srow({ time_fmt: '24h' }), sj, fcs(10), NOW.getTime()).body.split('\n')[0], 'Denver · peak around 11:46');
  // The same evening has both the Perseids and (2 h earlier) the solar
  // eclipse; after the eclipse is sent the shower is still due.
  check('perseids still due after the eclipse was sent', skyDue(srow({ sky_last_key: 'solar-2026-08-12' }), sunset - 45 * 60).key === 'perseids-2026');

  // Through the planner: a sky job shares the forecast with a briefing.
  const when = new Date((sunset - 45 * 60) * 1000);
  const hourThen = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hourCycle: 'h23' }).format(when));
  const rows = [srow({ briefing: 1, hour: hourThen })];
  forecastJson = { ...forecastJson, hourly: fcs(10).hourly, utc_offset_seconds: -21600, timezone: 'America/Denver' };
  const env = { ...baseEnv, DB: fakeDB({ 'OR thresholds = 1': () => rows }) };
  pushed.length = 0;
  const st = await runBriefings(env, { now: when });
  eq('clock: sky + briefing → 2 jobs, 1 forecast, 2 sent', [st.due, st.skies, st.briefings, st.forecasts, st.sent], [2, 1, 1, 1, 2]);
  check('clock: sky_last_key written', env.DB.writes.some(w => w.sql.includes('sky_last_key') && w.binds[0] === 'perseids-2026'));
  check('clock: sky push has its topic', pushed.some(p => p.headers.Topic === 'sky'));
  forecastJson = { ...forecastJson, hourly: hourly(), utc_offset_seconds: 0, timezone: null };
}

// ── Forecast changes ─────────────────────────────────────────────────
{
  const crow = (extra = {}) => row('c', { briefing: 0, changes: 1, hour: 6, threshold_hour: 17, ...extra });
  const clock = (hour, dateKey = '2026-09-15') => ({ hour, dateKey });
  eq('slot: briefing hour looks at today', changesSlot(crow(), clock(6)), { key: '2026-09-15T06', target: 'today' });
  eq('slot: threshold hour looks at tomorrow', changesSlot(crow(), clock(17)), { key: '2026-09-15T17', target: 'tomorrow' });
  eq('slot: other hours are nothing', changesSlot(crow(), clock(12)), null);
  eq('slot: same hour → tomorrow', changesSlot(crow({ hour: 17 }), clock(17)).target, 'tomorrow');
  const tsec = Date.parse('2026-09-15T17:05Z') / 1000;
  eq('since: this morning', sinceWord(Date.parse('2026-09-15T06:05Z') / 1000, 'UTC', tsec), 'this morning');
  eq('since: last night', sinceWord(Date.parse('2026-09-14T17:05Z') / 1000, 'UTC', tsec), 'last night');
  eq('since: yesterday morning', sinceWord(Date.parse('2026-09-14T06:05Z') / 1000, 'UTC', tsec), 'yesterday morning');

  const fcd = (over) => ({ daily: daily(over), hourly: hourly(), utcOffset: 0 });
  const evening = { key: '2026-09-15T17', target: 'tomorrow' };
  const morning = { key: '2026-09-15T06', target: 'today' };
  const first = evaluateChanges(crow(), fcd(), evening, tsec);
  eq('first look: nothing to compare, snapshot stored', [first.items, first.since], [[], '']);
  const snap = JSON.parse(first.snapshot);
  eq('snapshot: keyed by date with the four fields', [Object.keys(snap.days), snap.days['2026-09-16']], [['2026-09-15', '2026-09-16'], { hi: 72, lo: 51, pop: 10, snow: 0 }]);
  const withSnap = (at = Date.parse('2026-09-15T06:05Z') / 1000) => crow({ changes_snapshot: JSON.stringify({ ...snap, at }) });
  eq('quiet: small moves are nothing', evaluateChanges(withSnap(), fcd({ temperature_2m_max: [70, 78], precipitation_probability_max: [10, 40] }), evening, tsec).items, []);
  eq('high dropped', evaluateChanges(withSnap(), fcd({ temperature_2m_max: [70, 62] }), evening, tsec).items, ["Tomorrow's high 62°, was 72°"]);
  eq('°C cutoff is 4', evaluateChanges(withSnap({ }), { ...fcd({ temperature_2m_max: [70, 68] }) }, evening, tsec).items, []);
  eq('°C: 4° moves', evaluateChanges(crow({ temp_unit: 'C', changes_snapshot: JSON.stringify({ ...snap, at: Date.parse('2026-09-15T06:05Z') / 1000 }) }), fcd({ temperature_2m_max: [70, 68] }), evening, tsec).items, ["Tomorrow's high 68°, was 72°"]);
  eq('rain chance up', evaluateChanges(withSnap(), fcd({ precipitation_probability_max: [10, 70] }), evening, tsec).items, ['Rain chance 70%, was 10%']);
  eq('snow now expected', evaluateChanges(withSnap(), fcd({ snowfall_sum: [0, 4.5] }), evening, tsec).items, ['Snow now expected: 4.5 in']);
  eq('several at once, in order', evaluateChanges(withSnap(), fcd({ temperature_2m_max: [70, 60], temperature_2m_min: [50, 40], precipitation_probability_max: [10, 80] }), evening, tsec).items.length, 3);
  eq('morning look compares today', evaluateChanges(withSnap(Date.parse('2026-09-14T17:05Z') / 1000), fcd({ temperature_2m_max: [58, 72] }), morning, Date.parse('2026-09-15T06:05Z') / 1000).items, ["Today's high 58°, was 70°"]);
  eq('stale snapshot is replaced, not compared', evaluateChanges(withSnap(Date.parse('2026-09-13T06:05Z') / 1000), fcd({ temperature_2m_max: [70, 40] }), evening, tsec).items, []);
  const res = evaluateChanges(withSnap(), fcd({ temperature_2m_max: [70, 62], precipitation_probability_max: [10, 70] }), evening, tsec);
  const cnote = composeChanges(crow(), res, NOW.getTime());
  eq('compose: title', cnote.title, 'Forecast changed · Denver');
  eq('compose: body', cnote.body, "Tomorrow's high 62°, was 72° this morning.\nRain chance 70%, was 10%.");
  eq('compose: tag', cnote.tag, 'changes');

  // Through the planner at 20:07 UTC: a row whose briefing hour is 20
  // takes the "today" look; one already looked this slot is skipped.
  forecastJson = { ...forecastJson, daily: daily({ temperature_2m_max: [58, 72] }) };
  const morningSnap = JSON.stringify({ at: Date.parse('2026-09-15T06:05Z') / 1000, days: { '2026-09-15': { hi: 70, lo: 50, pop: 10, snow: 0 }, '2026-09-16': { hi: 72, lo: 51, pop: 10, snow: 0 } } });
  const rows = [
    crow({ hour: 20, changes_snapshot: morningSnap }),
    row('c2', { briefing: 0, changes: 1, hour: 20, changes_snapshot: null }),
    row('c3', { briefing: 0, changes: 1, hour: 20, changes_last_slot: '2026-09-15T20' }),
  ];
  const env = { ...baseEnv, DB: fakeDB({ 'OR thresholds = 1': () => rows }) };
  pushed.length = 0;
  const st = await runBriefings(env, { now: NOW });
  eq('clock: two looks due, one changed, one quiet, one forecast', [st.due, st.changes, st.quiet, st.sent, st.forecasts], [2, 2, 1, 1, 1]);
  check('clock: both looks stored a snapshot and the slot', ['https://push.example/c', 'https://push.example/c2'].every(ep => env.DB.writes.some(w => w.sql.includes('changes_snapshot') && w.binds[1] === '2026-09-15T20' && w.binds[2] === ep && w.binds[0].includes('"2026-09-16"'))));
  check('clock: changes push has its topic', pushed.some(p => p.headers.Topic === 'changes'));
  forecastJson = { ...forecastJson, daily: daily() };
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
  eq('alerts: 3 ids remembered', env.DB.writes.filter(w => w.sql.includes('INSERT OR IGNORE INTO push_alerts_sent')).map(w => w.binds.slice(0, 2)).sort((a, b) => a.join().localeCompare(b.join())),
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
