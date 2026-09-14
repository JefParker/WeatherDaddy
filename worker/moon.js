// Named full moon: one push shortly before sunset on the night of each
// full moon — "Harvest Moon tonight" — with sunset, the best viewing
// time and the sky forecast for that hour.
//
// The moon table and the sunrise/sunset formula are the app's own
// (public/js/ui-format.js: FULL_MOON_NAMES, _fullMoonAt, _solarTimes),
// so the push names the same moon the dashboard's full-moon card shows
// and quotes the same times. No API is involved in deciding WHEN to
// send: a full-moon evening is pure arithmetic, so the */30 cron spends
// nothing on the other 350 days. The forecast fetch the tick makes
// anyway supplies the cloud cover.

import { localClock, localIsoToEpoch } from './briefing.js';

// Traditional Farmer's Almanac names by Gregorian month (0-indexed). A
// second full moon in the same UTC month is a Blue Moon.
const FULL_MOON_NAMES = [
  'Wolf Moon', 'Snow Moon', 'Worm Moon', 'Pink Moon', 'Flower Moon', 'Strawberry Moon',
  'Buck Moon', 'Sturgeon Moon', 'Harvest Moon', "Hunter's Moon", 'Beaver Moon', 'Cold Moon',
];
const SYNODIC_DAYS = 29.530588853;
const REF_MS = Date.UTC(2000, 0, 21, 4, 41); // an observed full moon

export function fullMoonAt(k) {
  const dtMs = REF_MS + k * SYNODIC_DAYS * 86400000;
  const month = new Date(dtMs).getUTCMonth();
  const prevMonth = new Date(REF_MS + (k - 1) * SYNODIC_DAYS * 86400000).getUTCMonth();
  return { name: prevMonth === month ? 'Blue Moon' : FULL_MOON_NAMES[month], dt: Math.round(dtMs / 1000) };
}

// Fraction of the Moon's disc lit at `sec`, 0 (new) to 1 (full), from
// the phase angle alone — plenty for "how much will it wash out the sky".
export function moonIllumination(sec) {
  const cycles = (sec * 1000 - REF_MS) / (SYNODIC_DAYS * 86400000);
  const phase = cycles - Math.floor(cycles); // 0 = full, 0.5 = new
  return (1 + Math.cos(2 * Math.PI * phase)) / 2;
}

// The three full moons nearest `nowSec` (previous / nearest / next).
export function nearbyFullMoons(nowSec) {
  const k = Math.round((nowSec * 1000 - REF_MS) / (SYNODIC_DAYS * 86400000));
  return [fullMoonAt(k - 1), fullMoonAt(k), fullMoonAt(k + 1)];
}

// Sunrise/sunset (epoch seconds) for a local calendar date at lat/lon:
// the U.S. Naval Observatory "Almanac for Computers" algorithm, good to
// a couple of minutes. null when the sun never crosses the horizon.
export function solarTimes(year, month /* 1-12 */, day, lat, lon, tz) {
  const N1 = Math.floor(275 * month / 9);
  const N2 = Math.floor((month + 9) / 12);
  const N3 = 1 + Math.floor((year - 4 * Math.floor(year / 4) + 2) / 3);
  const N  = N1 - (N2 * N3) + day - 30;
  const lngHour = lon / 15;
  const zenith  = 90.833 * Math.PI / 180;
  const latRad  = lat * Math.PI / 180;

  const compute = (rising) => {
    const t = rising ? N + ((6 - lngHour) / 24) : N + ((18 - lngHour) / 24);
    const M = (0.9856 * t) - 3.289;
    const Mrad = M * Math.PI / 180;
    let L = M + (1.916 * Math.sin(Mrad)) + (0.020 * Math.sin(2 * Mrad)) + 282.634;
    L = ((L % 360) + 360) % 360;
    const Lrad = L * Math.PI / 180;
    let RA = Math.atan(0.91764 * Math.tan(Lrad)) * 180 / Math.PI;
    RA = ((RA % 360) + 360) % 360;
    RA = (RA + (Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90)) / 15;
    const sinDec = 0.39782 * Math.sin(Lrad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith) - (sinDec * Math.sin(latRad))) / (cosDec * Math.cos(latRad));
    if (cosH > 1 || cosH < -1) return null;
    let H = rising ? 360 - (Math.acos(cosH) * 180 / Math.PI) : Math.acos(cosH) * 180 / Math.PI;
    H = H / 15;
    const T = H + RA - (0.06571 * t) - 6.622;
    return ((T - lngHour) % 24 + 24) % 24;
  };

  const utcMidnight = Date.UTC(year, month - 1, day) / 1000;
  const want = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const onLocalDay = (ut) => {
    if (ut == null) return null;
    let ts = Math.round(utcMidnight + ut * 3600);
    const got = localClock(tz, new Date(ts * 1000)).dateKey;
    if (got > want) ts -= 86400;
    else if (got < want) ts += 86400;
    return ts;
  };
  return { sunrise: onLocalDay(compute(true)), sunset: onLocalDay(compute(false)) };
}

// Send between 75 and 15 minutes before sunset: the */30 cron lands in
// a 60-minute window at least once.
const WINDOW_BEFORE_S = 75 * 60;
const WINDOW_UNTIL_S  = 15 * 60;

// Is there a full-moon push due for this row right now? Returns the job
// (key, moon, sunset, next sunrise, best viewing time) or null. "The
// night of the full moon" is the local calendar day of the peak, as on
// the dashboard's full-moon card; the device timezone stands in for the
// city's, which only matters for a city many zones away with a peak
// near midnight.
export function moonDue(row, nowSec) {
  const tz = row.tz;
  for (const fm of nearbyFullMoons(nowSec)) {
    if (row.moon_last_key === String(fm.dt)) continue;
    const day = localClock(tz, new Date(fm.dt * 1000)).dateKey;
    const [y, m, d] = day.split('-').map(Number);
    const today = solarTimes(y, m, d, row.lat, row.lon, tz);
    if (!today.sunset) continue;
    if (nowSec < today.sunset - WINDOW_BEFORE_S || nowSec > today.sunset - WINDOW_UNTIL_S) continue;
    const next = solarTimes(...nextDay(y, m, d), row.lat, row.lon, tz);
    const sunrise = next.sunrise || today.sunset + 12 * 3600;
    // Best viewing: the peak if it falls in the night, else mid-night.
    const peakAtNight = fm.dt >= today.sunset && fm.dt <= sunrise;
    const best = peakAtNight ? fm.dt : Math.round(today.sunset + (sunrise - today.sunset) / 2);
    return { key: String(fm.dt), moon: fm, sunset: today.sunset, sunrise, best };
  }
  return null;
}

export function nextDay(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d) + 86400000);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

export function clockTime(sec, tz, timeFmt) {
  const opts = { hour: 'numeric', minute: '2-digit', hour12: timeFmt !== '24h' };
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(sec * 1000)); }
  catch (_) { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(sec * 1000)); }
}

// Sky at the best viewing hour, from the shared forecast's hourly cloud
// cover; '' when the series doesn't reach that hour.
export function skyAt(forecast, sec) {
  const h = (forecast && forecast.hourly) || {};
  const times = Array.isArray(h.time) ? h.time : [];
  let at = -1, gap = Infinity;
  for (let i = 0; i < times.length; i++) {
    const g = Math.abs(localIsoToEpoch(times[i], forecast.utcOffset) - sec);
    if (g < gap) { gap = g; at = i; }
  }
  if (at < 0 || gap > 3600) return '';
  const code = h.weather_code && h.weather_code[at];
  if (typeof code === 'number' && code >= 51) return 'Precipitation likely — it may stay hidden.';
  const cc = h.cloud_cover && h.cloud_cover[at];
  if (typeof cc !== 'number') return '';
  if (cc <= 25) return 'Clear skies expected.';
  if (cc <= 60) return 'Partly cloudy.';
  return 'Mostly cloudy — it may stay hidden.';
}

// The notification, e.g.
//
//   Harvest Moon tonight
//   Denver · sunset 6:52 PM
//   Best viewing around 12:30 AM. Clear skies expected.
export function composeMoon(row, job, forecast, nowMs = Date.now()) {
  const tz = (forecast && forecast.timezone) || row.tz;
  const url = new URL('/', 'https://weatherdaddy.app');
  url.searchParams.set('lat', String(row.lat));
  url.searchParams.set('lon', String(row.lon));
  url.searchParams.set('name', row.city_name);
  const line2 = [`Best viewing around ${clockTime(job.best, tz, row.time_fmt)}.`, skyAt(forecast, job.best)].filter(Boolean).join(' ');
  return {
    title: `${job.moon.name} tonight`,
    body: `${row.city_name} · sunset ${clockTime(job.sunset, tz, row.time_fmt)}\n${line2}`,
    url: url.pathname + url.search,
    tag: 'moon',
    timestamp: nowMs,
  };
}
