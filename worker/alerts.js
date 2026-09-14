// Severe-weather alerts: National Weather Service warnings and watches
// for a subscriber's location, checked every five minutes by the
// */5 cron (see runAlerts in push.js).
//
// One NWS call per rounded location, the same point query the app's
// alert bar uses (WeatherAPI.getAlerts), so a push and the in-app bar
// always agree. Only the point query is used, not the national feed:
// that feed is 1-5 MB and parsing it would blow the free plan's 10 ms
// CPU budget on its own.

const NWS_ACTIVE = 'https://api.weather.gov/alerts/active';
// NWS requires a User-Agent that identifies the application.
const NWS_UA = 'WeatherDaddy (weatherdaddy.app)';

// NWS covers US territory only; a point outside it is a 400. Same loose
// box as the client, so a non-US city costs nothing per tick.
export function inNwsBox(lat, lon) {
  return lat >= 17 && lat <= 72 && lon >= -180 && lon <= -65;
}

// Subscribers within ~1 km share one NWS call per tick.
export function alertKey(lat, lon) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

// Active alerts for a point, as their GeoJSON `properties` objects.
// `status=actual` drops tests and exercises; cancellations are not
// something to push.
export async function fetchActiveAlerts(lat, lon) {
  const url = new URL(NWS_ACTIVE);
  url.searchParams.set('point', `${lat.toFixed(4)},${lon.toFixed(4)}`);
  url.searchParams.set('status', 'actual');
  url.searchParams.set('message_type', 'alert,update');
  const res = await fetch(url.toString(), {
    headers: { accept: 'application/geo+json', 'user-agent': NWS_UA },
  });
  if (!res.ok) throw new Error(`nws ${res.status}`);
  const data = await res.json();
  return (data.features || []).map((f) => f.properties || {}).filter((p) => p.id && p.event);
}

// Warnings and watches only. Advisories, statements and outlooks are
// what people mean when they say a weather app is noisy, and the
// in-app alert bar still shows them.
export function isPushWorthy(p, nowSec = Date.now() / 1000) {
  if (!/ (Warning|Watch)$/.test(p.event || '')) return false;
  const ends = Date.parse(p.ends || p.expires || '');
  if (Number.isFinite(ends) && ends / 1000 < nowSec) return false;
  return true;
}

// Ids of earlier messages this one supersedes (an Update's `references`).
export function referencedIds(p) {
  return (Array.isArray(p.references) ? p.references : [])
    .map((r) => r && r.identifier).filter(Boolean);
}

// "Tue 2:45 PM" in the alert's own UTC offset (NWS timestamps carry the
// local offset of the issuing office, which is the subscriber's area).
export function formatAlertTime(iso, timeFmt = '12h', nowMs = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const local = new Date(t + offsetMin * 60000);
  const nowLocal = new Date(nowMs + offsetMin * 60000);
  const h = local.getUTCHours(), min = String(local.getUTCMinutes()).padStart(2, '0');
  const time = timeFmt === '24h'
    ? `${String(h).padStart(2, '0')}:${min}`
    : `${h % 12 || 12}:${min} ${h < 12 ? 'AM' : 'PM'}`;
  const sameDay = local.getUTCFullYear() === nowLocal.getUTCFullYear() &&
    local.getUTCMonth() === nowLocal.getUTCMonth() && local.getUTCDate() === nowLocal.getUTCDate();
  if (sameDay) return time;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][local.getUTCDay()];
  return `${day} ${time}`;
}

// The gist of an alert in one line: the "...WHAT..." paragraph of a
// long-fuse product (winter storm, flood), else the first sentence of
// the description (a tornado warning's "At 1:47 PM, a severe
// thunderstorm capable of producing a tornado was located..."), else
// the area.
export function alertGist(p, max = 160) {
  const desc = String(p.description || '').replace(/\r/g, '');
  let text = '';
  // NWS writes the segment as "* WHAT...text" or "...WHAT...text"; it
  // runs to a blank line or the next "* " / "..." segment.
  const what = /(?:\.\.\.|\*\s*)WHAT\.\.\.\s*([\s\S]*?)(?=\n\s*\n|\n\s*\*|\n\s*\.\.\.|$)/.exec(desc);
  if (what) text = what[1];
  else {
    const first = /^[\s\S]*?[.!?](?=\s|$)/.exec(desc.trim());
    text = first ? first[0] : '';
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) text = String(p.areaDesc || '').replace(/\s+/g, ' ').trim();
  if (text.length > max) text = text.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return text;
}

// The notification payload (rendered by sw.js), e.g.
//
//   Tornado Warning
//   Denver · until 2:45 PM
//   At 1:47 PM, a severe thunderstorm capable of producing a tornado was located…
export function composeAlert(row, p, nowMs = Date.now()) {
  const until = formatAlertTime(p.ends || p.expires, row.time_fmt, nowMs);
  const line1 = until ? `${row.city_name} · until ${until}` : row.city_name;
  const url = new URL('/', 'https://weatherdaddy.app');
  url.searchParams.set('lat', String(row.lat));
  url.searchParams.set('lon', String(row.lon));
  url.searchParams.set('name', row.city_name);
  return {
    title: p.event,
    body: [line1, alertGist(p)].filter(Boolean).join('\n'),
    url: url.pathname + url.search,
    // One tray entry per alert, not one per city: two simultaneous
    // warnings must both be visible.
    tag: `alert:${p.id}`,
    timestamp: nowMs,
  };
}

// Seconds the push service should hold an undelivered alert: until it
// ends, at least a minute, at most six hours.
export function alertTtl(p, nowSec = Date.now() / 1000) {
  const ends = Date.parse(p.ends || p.expires || '') / 1000;
  if (!Number.isFinite(ends)) return 3600;
  return Math.max(60, Math.min(6 * 3600, Math.round(ends - nowSec)));
}
