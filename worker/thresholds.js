// Threshold alerts: once a day, at the hour the subscriber picked, look
// 24 hours ahead for the conditions they ticked and push one
// notification listing whatever is coming. Nothing coming → nothing
// sent (the day is still marked done so the hour isn't re-evaluated).
//
// Items are bits in push_subscriptions.threshold_mask; the client's
// checklist (UI.PUSH_THRESHOLDS) uses the same bits. Cutoffs are fixed
// per unit system rather than user-entered — the checklist is the
// configuration — and are the values the app's own quick stats treat
// as noteworthy.

import { localIsoToEpoch } from './briefing.js';

export const T = { FREEZE: 1, HEAT: 2, WIND: 4, RAIN: 8, SNOW: 16, AQI: 32 };
export const T_ALL = 63;

const AQI_API = 'https://air-quality-api.open-meteo.com/v1/air-quality';

// Cutoffs in the row's own units, so no conversion touches the numbers
// the subscriber sees.
function cutoffs(row) {
  return {
    freeze: row.temp_unit === 'C' ? 0 : 32,
    heat:   row.temp_unit === 'C' ? 38 : 100,
    gust:   row.wind_unit === 'mph' ? 45 : row.wind_unit === 'ms' ? 20 : 72,
    rain:   row.precip_unit === 'in' ? 1 : 25,
    // Open-Meteo reports snowfall in inches with precipitation_unit=inch,
    // otherwise in centimetres.
    snow:   row.precip_unit === 'in' ? 3 : 7,
    aqi:    101,
  };
}

const unitWord = {
  wind:   (row) => row.wind_unit === 'ms' ? 'm/s' : row.wind_unit === 'mph' ? 'mph' : 'km/h',
  precip: (row) => row.precip_unit === 'in' ? 'in' : 'mm',
  snow:   (row) => row.precip_unit === 'in' ? 'in' : 'cm',
};

export async function fetchAirQuality(lat, lon) {
  const url = new URL(AQI_API);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'us_aqi');
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set('timezone', 'auto');
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`open-meteo aqi ${res.status}`);
  const data = await res.json();
  return {
    hourly: data.hourly || {},
    utcOffset: typeof data.utc_offset_seconds === 'number' ? data.utc_offset_seconds : 0,
  };
}

// "Tue 5 AM" / "Tue 05:00" for an Open-Meteo local time string.
export function hourLabel(iso, timeFmt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(iso || '');
  if (!m) return '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(+m[1], m[2] - 1, +m[3])).getUTCDay()];
  const h = Number(m[4]);
  return timeFmt === '24h' ? `${day} ${String(h).padStart(2, '0')}:00` : `${day} ${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

// The hourly entries covering the next 24 hours from `nowSec`.
function window24(series, utcOffset, nowSec) {
  const times = Array.isArray(series.time) ? series.time : [];
  const start = times.findIndex((t) => localIsoToEpoch(t, utcOffset) >= nowSec);
  if (start < 0) return null;
  return { from: start, to: Math.min(times.length, start + 24) };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt1 = (v) => (Math.round(v * 10) / 10).toString();

// Evaluate the row's ticked items against the forecast. Returns
// [{ bit, label, text }] in checklist order; empty when all is calm.
export function evaluateThresholds(row, forecast, aqi, nowSec = Date.now() / 1000) {
  const mask = row.threshold_mask | 0;
  const out = [];
  const h = forecast.hourly || {};
  const w = window24(h, forecast.utcOffset, nowSec);
  if (!w) return out;
  const c = cutoffs(row);
  const times = h.time;

  // Extreme (min or max) of a series inside the window, with its hour.
  const extreme = (arr, pick) => {
    let best = null, at = -1;
    for (let i = w.from; i < w.to; i++) {
      const v = num(arr && arr[i]);
      if (v == null) continue;
      if (best == null || pick(v, best)) { best = v; at = i; }
    }
    return best == null ? null : { value: best, when: hourLabel(times[at], row.time_fmt) };
  };
  const total = (arr) => {
    let sum = 0, any = false, last = -1;
    for (let i = w.from; i < w.to; i++) {
      const v = num(arr && arr[i]);
      if (v == null) continue;
      sum += v; any = true; if (v > 0) last = i;
    }
    return any ? { value: sum, when: last >= 0 ? hourLabel(times[last], row.time_fmt) : '' } : null;
  };

  if (mask & T.FREEZE) {
    const e = extreme(h.temperature_2m, (v, b) => v < b);
    if (e && e.value <= c.freeze) out.push({ bit: T.FREEZE, label: 'Freeze', text: `Low of ${Math.round(e.value)}° around ${e.when}.` });
  }
  if (mask & T.HEAT) {
    const e = extreme(h.apparent_temperature, (v, b) => v > b);
    if (e && e.value >= c.heat) out.push({ bit: T.HEAT, label: 'Extreme heat', text: `Feels like ${Math.round(e.value)}° around ${e.when}.` });
  }
  if (mask & T.WIND) {
    const e = extreme(h.wind_gusts_10m, (v, b) => v > b);
    if (e && e.value >= c.gust) out.push({ bit: T.WIND, label: 'High wind', text: `Gusts to ${Math.round(e.value)} ${unitWord.wind(row)} around ${e.when}.` });
  }
  if (mask & T.RAIN) {
    const t = total(h.rain);
    if (t && t.value >= c.rain) out.push({ bit: T.RAIN, label: 'Heavy rain', text: `${fmt1(t.value)} ${unitWord.precip(row)} of rain by ${t.when}.` });
  }
  if (mask & T.SNOW) {
    const t = total(h.snowfall);
    if (t && t.value >= c.snow) out.push({ bit: T.SNOW, label: 'Heavy snow', text: `${fmt1(t.value)} ${unitWord.snow(row)} of snow by ${t.when}.` });
  }
  if ((mask & T.AQI) && aqi) {
    const aw = window24(aqi.hourly || {}, aqi.utcOffset, nowSec);
    if (aw) {
      let best = null, at = -1;
      for (let i = aw.from; i < aw.to; i++) {
        const v = num(aqi.hourly.us_aqi && aqi.hourly.us_aqi[i]);
        if (v != null && (best == null || v > best)) { best = v; at = i; }
      }
      if (best != null && best >= c.aqi) out.push({ bit: T.AQI, label: 'Poor air quality', text: `AQI ${Math.round(best)} around ${hourLabel(aqi.hourly.time[at], row.time_fmt)}.` });
    }
  }
  return out;
}

// One notification for everything that tripped, e.g.
//
//   Freeze · Denver                      Denver · 2 heads-ups
//   Low of 28° around Wed 5 AM.          Low of 28° around Wed 5 AM.
//                                        Gusts to 52 mph around Tue 9 PM.
export function composeThresholds(row, items, nowMs = Date.now()) {
  const url = new URL('/', 'https://weatherdaddy.app');
  url.searchParams.set('lat', String(row.lat));
  url.searchParams.set('lon', String(row.lon));
  url.searchParams.set('name', row.city_name);
  return {
    title: items.length === 1 ? `${items[0].label} · ${row.city_name}` : `${row.city_name} · ${items.length} heads-ups`,
    body: items.map((i) => i.text).join('\n'),
    url: url.pathname + url.search,
    tag: 'thresholds',
    timestamp: nowMs,
  };
}
