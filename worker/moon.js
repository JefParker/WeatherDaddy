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
const RAD = Math.PI / 180;

// The instant of full moon number `k` (0 = 2000-01-21), epoch seconds:
// Meeus, Astronomical Algorithms ch. 49, which is good to a minute or
// two. The mean lunation alone (REF_MS + k × SYNODIC_DAYS) can be
// ±14 hours out because of the Moon's orbital eccentricity, which is
// enough to put "the night of the full moon" on the wrong calendar day.
// Same code as _fullMoonEpoch in public/js/ui-format.js.
export function fullMoonEpoch(k) {
  const kk = k + 0.5;                      // Meeus counts lunations from the 2000-01-06 new moon
  const T = kk / 1236.85;
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  let jde = 2451550.09766 + 29.530588861 * kk + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;
  const E  = 1 - 0.002516 * T - 0.0000074 * T2;
  const M  = RAD * (2.5534   + 29.10535670  * kk - 0.0000014 * T2 - 0.00000011 * T3);   // Sun's mean anomaly
  const Mp = RAD * (201.5643 + 385.81693528 * kk + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4); // Moon's
  const F  = RAD * (160.7108 + 390.67050284 * kk - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4); // argument of latitude
  const O  = RAD * (124.7746 - 1.56375588   * kk + 0.0020672 * T2 + 0.00000215 * T3);   // longitude of the ascending node
  const s = Math.sin;
  jde += -0.40614 * s(Mp) + 0.17302 * E * s(M) + 0.01614 * s(2 * Mp) + 0.01043 * s(2 * F)
    + 0.00734 * E * s(Mp - M) - 0.00515 * E * s(Mp + M) + 0.00209 * E * E * s(2 * M)
    - 0.00111 * s(Mp - 2 * F) - 0.00057 * s(Mp + 2 * F) + 0.00056 * E * s(2 * Mp + M)
    - 0.00042 * s(3 * Mp) + 0.00042 * E * s(M + 2 * F) + 0.00038 * E * s(M - 2 * F)
    - 0.00024 * E * s(2 * Mp - M) - 0.00017 * s(O) - 0.00007 * s(Mp + 2 * M)
    + 0.00004 * s(2 * Mp - 2 * F) + 0.00004 * s(3 * M) + 0.00003 * s(Mp + M - 2 * F)
    + 0.00003 * s(2 * Mp + 2 * F) - 0.00003 * s(Mp + M + 2 * F) + 0.00003 * s(Mp - M + 2 * F)
    - 0.00002 * s(Mp - M - 2 * F) - 0.00002 * s(3 * Mp + M) + 0.00002 * s(4 * Mp);
  // Planetary arguments (Meeus 49.7-49.9): a minute or two at most.
  const A = [
    [0.000325, 299.77 + 0.107408 * kk - 0.009173 * T2], [0.000165, 251.88 + 0.016321 * kk],
    [0.000164, 251.83 + 26.651886 * kk], [0.000126, 349.42 + 36.412478 * kk],
    [0.000110, 84.66 + 18.206239 * kk], [0.000062, 141.74 + 53.303771 * kk],
    [0.000060, 207.14 + 2.453732 * kk], [0.000056, 154.84 + 7.306860 * kk],
    [0.000047, 34.52 + 27.261239 * kk], [0.000042, 207.19 + 0.121824 * kk],
    [0.000040, 291.34 + 1.844379 * kk], [0.000037, 161.72 + 24.198154 * kk],
    [0.000035, 239.56 + 25.513099 * kk], [0.000023, 331.55 + 3.592518 * kk],
  ];
  for (const [c, a] of A) jde += c * s(RAD * a);
  // JDE is Terrestrial Time, which runs ~69 s ahead of UTC in the 2020s.
  return Math.round((jde - 2440587.5) * 86400 - 69);
}

export function fullMoonAt(k) {
  const dt = fullMoonEpoch(k);
  const month = new Date(dt * 1000).getUTCMonth();
  const prevMonth = new Date(fullMoonEpoch(k - 1) * 1000).getUTCMonth();
  return { name: prevMonth === month ? 'Blue Moon' : FULL_MOON_NAMES[month], dt };
}

// Fraction of the Moon's disc lit at `sec`, 0 (new) to 1 (full), from
// the phase angle alone — plenty for "how much will it wash out the sky".
export function moonIllumination(sec) {
  const cycles = (sec * 1000 - REF_MS) / (SYNODIC_DAYS * 86400000);
  const phase = cycles - Math.floor(cycles); // 0 = full, 0.5 = new
  return (1 + Math.cos(2 * Math.PI * phase)) / 2;
}

// The three full moons nearest `nowSec` (previous / nearest / next).
// The mean lunation picks the index; the exact times come from above.
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

// The night of a full moon: sunset and the following sunrise, for the
// night whose dark hours contain the peak — a peak at 1:49 AM belongs
// to the evening before, not the one after. A daytime peak takes the
// night that starts on its local date. null in polar day/night. Same
// rule as UI._fullMoonNight on the dashboard's full-moon card, so the
// push and the card agree on the night; the device timezone stands in
// for the city's, which only matters for a city many zones away.
export function fullMoonNight(fm, row) {
  const tz = row.tz;
  let fallback = null;
  for (const anchor of [fm.dt, fm.dt - 86400]) {
    const [y, m, d] = localClock(tz, new Date(anchor * 1000)).dateKey.split('-').map(Number);
    const today = solarTimes(y, m, d, row.lat, row.lon, tz);
    if (!today.sunset) continue;
    const next = solarTimes(...nextDay(y, m, d), row.lat, row.lon, tz);
    const night = { sunset: today.sunset, sunrise: next.sunrise || today.sunset + 12 * 3600 };
    if (fm.dt >= night.sunset && fm.dt <= night.sunrise) return { ...night, peakAtNight: true };
    if (!fallback) fallback = { ...night, peakAtNight: false };
  }
  return fallback;
}

// Is there a full-moon push due for this row right now? Returns the job
// (key, moon, sunset, next sunrise, best viewing time) or null.
export function moonDue(row, nowSec) {
  for (const fm of nearbyFullMoons(nowSec)) {
    if (row.moon_last_key === String(fm.dt)) continue;
    const night = fullMoonNight(fm, row);
    if (!night) continue;
    if (nowSec < night.sunset - WINDOW_BEFORE_S || nowSec > night.sunset - WINDOW_UNTIL_S) continue;
    // Best viewing: the peak if it falls in the night, else mid-night.
    const best = night.peakAtNight ? fm.dt : Math.round(night.sunset + (night.sunrise - night.sunset) / 2);
    return { key: String(fm.dt), moon: fm, sunset: night.sunset, sunrise: night.sunrise, best };
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
