// Morning briefing: what a subscriber's local clock says, the one
// forecast call every clock-driven feature shares, and the text of the
// briefing notification.
//
// Weather comes from Open-Meteo rather than the OpenWeatherMap proxy:
// one call returns today's high/low, condition, precipitation chance
// and current temperature, already converted to the subscriber's units,
// and it needs no API key. The app's own 8-day view is built on the
// same daily fields (see WeatherAPI.getOpenMeteoEnrichment), so the
// briefing agrees with what they see when they tap it. The same call
// carries two days of hourly data and sunrise/sunset for the threshold
// and full-moon features (worker/thresholds.js, worker/moon.js), so a
// location costs one subrequest per tick however many features fire.

// Wall-clock in an IANA zone. An unknown zone falls back to UTC rather
// than throwing — a stale row must never take the whole cron down.
export function localClock(tz, now = new Date()) {
  const opts = {
    hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long',
  };
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }); }
  catch (_) { fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }); }
  const p = {};
  for (const part of fmt.formatToParts(now)) if (part.type !== 'literal') p[part.type] = part.value;
  return {
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    dateKey: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
  };
}

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch (_) { return false; }
}

// Subscribers within ~1 km share one forecast call per cron tick.
export function forecastKey(lat, lon, units) {
  return `${lat.toFixed(2)},${lon.toFixed(2)},${units.temp},${units.wind},${units.precip}`;
}

const OM = 'https://api.open-meteo.com/v1/forecast';

// Local ISO time from Open-Meteo ("2026-09-15T05:00", in the city's
// zone) → epoch seconds, given the response's utc_offset_seconds.
export function localIsoToEpoch(iso, utcOffset) {
  const t = Date.parse(iso + 'Z');
  return Number.isFinite(t) ? Math.round(t / 1000) - (utcOffset || 0) : NaN;
}

export async function fetchForecast(lat, lon, units) {
  const url = new URL(OM);
  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max,precipitation_sum,snowfall_sum,windgusts_10m_max,sunrise,sunset');
  url.searchParams.set('hourly', 'temperature_2m,apparent_temperature,wind_gusts_10m,rain,snowfall,cloud_cover,weather_code');
  url.searchParams.set('current', 'temperature_2m,weather_code');
  // The CITY's timezone: "today" is the city's today, which is what a
  // briefing about that city means even for someone reading it elsewhere.
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set('temperature_unit', units.temp === 'C' ? 'celsius' : 'fahrenheit');
  url.searchParams.set('wind_speed_unit', units.wind === 'mph' ? 'mph' : units.wind === 'ms' ? 'ms' : 'kmh');
  url.searchParams.set('precipitation_unit', units.precip === 'in' ? 'inch' : 'mm');

  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = await res.json();
  const d = data.daily || {};
  const c = data.current || {};
  const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
  return {
    // Today, flattened: what composeBriefing reads.
    tempMax:   first(d.temperature_2m_max),
    tempMin:   first(d.temperature_2m_min),
    code:      first(d.weathercode),
    popMax:    first(d.precipitation_probability_max),
    precipSum: first(d.precipitation_sum),
    snowSum:   first(d.snowfall_sum),
    gustMax:   first(d.windgusts_10m_max),
    nowTemp:   typeof c.temperature_2m === 'number' ? c.temperature_2m : null,
    nowCode:   typeof c.weather_code === 'number' ? c.weather_code : null,
    // The raw two-day series for the other features.
    daily:     d,
    hourly:    data.hourly || {},
    utcOffset: typeof data.utc_offset_seconds === 'number' ? data.utc_offset_seconds : 0,
    timezone:  typeof data.timezone === 'string' ? data.timezone : null,
  };
}

// Kept for callers that only want today's numbers.
export const fetchDailyForecast = fetchForecast;

// Same table the app uses for Open-Meteo days (UI.wmoDescription).
const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'light snow showers', 86: 'snow showers',
  95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with heavy hail',
};
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86, 56, 57, 66, 67]);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const deg = (t) => `${Math.round(t)}°`;

// The notification payload the service worker renders. Body is two
// lines: numbers first, words second.
//
//   Denver
//   Now 52° · High 71° · Low 48°
//   Partly cloudy, 30% chance of rain. Gusts to 40 mph.
export function composeBriefing(row, f) {
  const parts = [];
  if (f.nowTemp != null) parts.push(`Now ${deg(f.nowTemp)}`);
  if (f.tempMax != null) parts.push(`High ${deg(f.tempMax)}`);
  if (f.tempMin != null) parts.push(`Low ${deg(f.tempMin)}`);
  const line1 = parts.join(' · ');

  const words = [];
  const code = f.code != null ? f.code : f.nowCode;
  let condition = WMO[code] || null;
  const pop = typeof f.popMax === 'number' ? Math.round(f.popMax) : null;
  if (pop != null && pop >= 20) {
    if (code != null && code >= 51 && condition) {
      // The condition already names the precipitation ("light rain",
      // "snow showers"): say how likely it is, not "snow, chance of snow".
      condition = `${cap(condition)}, ${pop}% likely`;
    } else {
      const what = (SNOW_CODES.has(code) || (f.snowSum || 0) > 0) ? 'snow' : 'rain';
      condition = `${condition ? cap(condition) + ', ' : ''}${pop}% chance of ${what}`;
    }
  } else if (condition) {
    condition = cap(condition);
  }
  if (condition) words.push(condition + '.');

  const gustLimit = row.wind_unit === 'mph' ? 30 : row.wind_unit === 'ms' ? 13 : 48;
  if (typeof f.gustMax === 'number' && f.gustMax >= gustLimit) {
    const unit = row.wind_unit === 'ms' ? 'm/s' : row.wind_unit === 'mph' ? 'mph' : 'km/h';
    words.push(`Gusts to ${Math.round(f.gustMax)} ${unit}.`);
  }
  const line2 = words.join(' ');

  // Opening the notification lands on this city, via the same URL
  // shape Copy URL produces.
  const url = new URL('/', 'https://weatherdaddy.app');
  url.searchParams.set('lat', String(row.lat));
  url.searchParams.set('lon', String(row.lon));
  url.searchParams.set('name', row.city_name);

  return {
    title: row.city_name,
    body: [line1, line2].filter(Boolean).join('\n'),
    url: url.pathname + url.search,
    tag: 'briefing',
    timestamp: Date.now(),
  };
}
