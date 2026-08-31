// DEPLOY RITUAL: bump CACHE_NAME on every shipped change to index.html /
// css / js. Static assets are served cache-first with no revalidation, so
// a client only picks up new files when a NEW worker installs — and the
// worker is byte-compared to decide whether it's new, which is what the
// bump guarantees.
//
// Install now fetches every entry with `cache: 'reload'` and cache.put()s
// it, so the precache is refreshed in place; the bump additionally drives
// the activate-time cleanup of old cache buckets. The chain that makes
// any of this reach an installed device is:
//   _worker.js sends `Cache-Control: no-cache` for /sw.js
//     → the browser actually re-fetches this file
//     → CACHE_NAME differs → install → skipWaiting → clients.claim
//     → app.js's controllerchange handler reloads the page
// Break any link and clients silently stay on the old version forever,
// which is exactly what used to happen on mobile.
//
// (index.html used to also carry ?v= query strings, but cacheKey()
// strips the query before caching, so they never did anything and were
// removed.)
const CACHE_NAME = 'weatherdaddy-v207';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/weather.js',
  './js/ui.js',
  './js/storage.js',
  './js/tide-stations.js',
  './js/location.js',
  './js/cities.js',
  './manifest.json',
  './favicon.ico',
  './favicon-32.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-192.png',
  './assets/icons/maskable-512.png',
  // Weather condition illustrations — referenced by every dashboard
  // render (hero + ~24 hourly tiles + 8 daily rows), so precaching them
  // keeps the dashboard usable offline without a flash of missing icons.
  './assets/icons/weather/clear-day.svg',
  './assets/icons/weather/clear-night.svg',
  './assets/icons/weather/few-clouds-day.svg',
  './assets/icons/weather/cloudy-night.svg',
  './assets/icons/weather/scattered-clouds.svg',
  './assets/icons/weather/broken-clouds.svg',
  './assets/icons/weather/shower-rain.svg',
  './assets/icons/weather/shower-rain-night.svg',
  './assets/icons/weather/thunderstorm.svg',
  './assets/icons/weather/thunderstorm-night.svg',
  './assets/icons/weather/snow.svg',
  './assets/icons/weather/snow-night.svg',
  './assets/icons/weather/mist.svg',
  './assets/icons/weather/haze.svg',
  './assets/icons/weather/smoke.svg',
  './assets/icons/weather/sand.svg',
  './assets/icons/weather/dust.svg',
  // Moon-phase art (7 of 8 phases — New moon has no illustration and
  // falls back to text-only in getMoonIconSVG).
  './assets/icons/weather/moon-waxing-crescent.svg',
  './assets/icons/weather/moon-first-quarter.svg',
  './assets/icons/weather/moon-waxing-gibbous.svg',
  './assets/icons/weather/moon-full.svg',
  './assets/icons/weather/moon-waning-gibbous.svg',
  './assets/icons/weather/moon-last-quarter.svg',
  './assets/icons/weather/moon-waning-crescent.svg'
];

// Strip ?v=... query strings so cache-busted asset URLs still hit the precache.
const cacheKey = (request) => {
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.toString(), { method: request.method });
};

// Last-ditch HTML shown when:
//   - the user navigates to the app while offline AND
//   - the index.html precache entry is also missing (e.g. the very
//     first visit was offline, so install never ran successfully).
// Kept tiny and inline so it works even when nothing else is cached.
// Mirrors the dashboard's dark theme so it doesn't read as a generic
// browser error page.
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>WeatherDaddy — Offline</title>
  <meta name="theme-color" content="#121212">
  <style>
    :root { color-scheme: dark; }
    html, body {
      margin: 0; padding: 0; min-height: 100vh;
      background: #121212; color: #eaeaea;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
    }
    main {
      max-width: 360px; padding: 32px 24px; text-align: center;
    }
    .icon {
      width: 64px; height: 64px; margin: 0 auto 16px;
      border-radius: 16px; background: #1f1f1f;
      display: grid; place-items: center;
      color: #ff6d00; font-size: 28px;
    }
    h1 { font-size: 1.4rem; margin: 0 0 8px; font-weight: 500; }
    p  { font-size: 0.95rem; line-height: 1.45; color: #a0a0a0; margin: 0 0 20px; }
    button {
      appearance: none; border: 0; cursor: pointer;
      background: #ff6d00; color: #121212;
      font: inherit; font-weight: 600;
      padding: 10px 20px; border-radius: 999px;
    }
    button:hover { filter: brightness(1.1); }
  </style>
</head>
<body>
  <main>
    <div class="icon" aria-hidden="true">☁︎</div>
    <h1>WeatherDaddy is offline</h1>
    <p>No connection right now, and we don't have a cached copy of the page yet. Reconnect and reload to get back to your forecast.</p>
    <button onclick="location.reload()">Try again</button>
  </main>
</body>
</html>`;

// JSON envelope for weather API requests that miss cache AND fail
// network. The app's WeatherAPI layer handles non-2xx responses already,
// so returning a 503 here surfaces as a clean error in the UI rather
// than an uncaught fetch rejection.
const OFFLINE_API_JSON = JSON.stringify({
  error: 'offline',
  message: 'No cached data for this request and the network is unreachable.'
});

// Install: precache critical assets. Each entry is added individually
// inside its own try/catch so a single 404 (e.g. a renamed icon) can't
// abort the whole precache and leave the app uninstallable.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(ASSETS_TO_CACHE.map(async (url) => {
        try {
          // `cache: 'reload'` bypasses the browser's HTTP cache. A plain
          // cache.add() fetches with default cache mode, so a new worker
          // could precache STALE bytes under the new CACHE_NAME — a
          // version bump that ships nothing, which is the most confusing
          // possible failure. Only sw.js gets a no-cache header from the
          // Worker; this makes the rest deterministic too.
          const res = await fetch(new Request(url, { cache: 'reload' }));
          if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
          // The asset router 30x-redirects /index.html to /, and a browser
          // REFUSES to answer a navigation with a response whose
          // `redirected` flag is set — it shows its own network-error page
          // instead. cache.add() would happily store the followed response
          // with that flag intact, so rebuild it to strip the flag.
          await cache.put(url, res.redirected
            ? new Response(await res.blob(), {
                status: res.status,
                statusText: res.statusText,
                headers: res.headers
              })
            : res);
        } catch (e) {
          // Log + continue; missing one asset shouldn't fail install.
          console.warn('[WeatherDaddy SW] failed to precache', url, e);
        }
      }));
    } catch (e) {
      console.warn('[WeatherDaddy SW] install error:', e);
    }
    try { await self.skipWaiting(); } catch (_) {}
  })());
});

// Activate: drop any previous-version caches. Errors are non-fatal —
// leftover storage is harmless; we'd rather the new SW activate.
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k).catch(() => {}))
      );
    } catch (e) {
      console.warn('[WeatherDaddy SW] activate cleanup error:', e);
    }
    try { await self.clients.claim(); } catch (_) {}
  })());
});

// All fetch routing is funnelled through a single async handler so
// every error path can be caught and mapped to a meaningful response.
// respondWith MUST resolve to a Response (never reject), or the
// browser shows its own "no internet" page.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(handleFetch(event));
});

const isWeatherURL = (urlOrRequest) => {
  try {
    const u = typeof urlOrRequest === 'string'
      ? new URL(urlOrRequest, self.location.href)
      : new URL(urlOrRequest.url);
    // Every upstream the app reads weather-ish data from. NWS (alerts +
    // forecast discussion), NOAA CO-OPS (tide predictions) and Nominatim
    // (landmark geocoding) used to fall through to the cache-first STATIC
    // handler, which never writes — so they had no offline fallback and
    // no TTL pruning, unlike the other APIs.
    return u.hostname === 'api.openweathermap.org' ||
           u.hostname.endsWith('open-meteo.com') ||
           u.hostname === 'api.weather.gov' ||
           u.hostname === 'api.tidesandcurrents.noaa.gov' ||
           u.hostname === 'nominatim.openstreetmap.org' ||
           u.pathname.startsWith('/api/owm/');
  } catch (_) { return false; }
};

async function handleFetch(event) {
  const request = event.request;
  try {
    if (isWeatherURL(request)) return await handleWeatherAPI(request, event);
    return await handleStaticAsset(request);
  } catch (e) {
    // Unexpected error inside the SW itself (bad URL, storage quota,
    // etc.) — degrade to the offline fallback rather than letting
    // respondWith reject.
    console.warn('[WeatherDaddy SW] fetch handler error:', e);
    return offlineFallback(request);
  }
}

// Weather-API cache bounds. Each saved city makes ~5 endpoint calls,
// and the URL varies by units / BYOK toggle, so the cache can grow
// unbounded under network-first fallback caching. We cap at WEATHER_CACHE_MAX
// entries (FIFO-evicted via Cache.keys() insertion order) and drop
// any entry whose served Response.date header is older than
// WEATHER_CACHE_MAX_AGE_MS.
const WEATHER_CACHE_MAX = 80;
const WEATHER_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

// Pruning does a cache.match() per entry (up to WEATHER_CACHE_MAX) and a
// single city load fires ~5 weather fetches, so per-write pruning is
// mostly redundant work. Throttle to once per interval. The timestamp
// lives in SW global scope and resets when the browser kills the worker
// — that just means one extra prune on the next wake, which is harmless.
const WEATHER_PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 10 min
let lastWeatherPruneAt = 0;

// Drop expired weather entries and FIFO-evict the oldest until the
// total count is within WEATHER_CACHE_MAX. Best-effort; any storage
// error is swallowed so the SW doesn't fail the request because of
// housekeeping.
async function pruneWeatherCache(cache) {
  try {
    const all = await cache.keys();
    const weatherKeys = all.filter(req => isWeatherURL(req));
    const now = Date.now();

    // 1) TTL: drop entries whose Date header is past the max age.
    for (const req of weatherKeys) {
      try {
        const res = await cache.match(req);
        if (!res) continue;
        const dateHdr = res.headers.get('date');
        const t = dateHdr ? Date.parse(dateHdr) : NaN;
        if (!isNaN(t) && (now - t) > WEATHER_CACHE_MAX_AGE_MS) {
          await cache.delete(req);
        }
      } catch (_) { /* skip this entry */ }
    }

    // 2) FIFO cap: Cache.keys() returns insertion order, so re-query
    //    after the TTL pass and delete the oldest until under cap.
    const remaining = (await cache.keys()).filter(req => isWeatherURL(req));
    const overflow = remaining.length - WEATHER_CACHE_MAX;
    for (let i = 0; i < overflow; i++) {
      try { await cache.delete(remaining[i]); } catch (_) {}
    }
  } catch (_) { /* non-fatal */ }
}

// Network-first for the weather APIs. The app handles its own instant
// stale render via localStorage; this layer ensures we fetch fresh data
// if online, and fall back to the Cache API if offline. When BOTH miss
// we return a 503 JSON body so the WeatherAPI layer's existing error path runs.
async function handleWeatherAPI(request, event) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const clone = res.clone();
      // Tie the cache write to the event's lifetime — once respondWith
      // settles, the browser may terminate the SW, silently dropping a
      // floating put() and leaving the offline fallback cache stale.
      const putDone = caches.open(CACHE_NAME).then(async (cache) => {
        try {
          await cache.put(request, clone);
          if (Date.now() - lastWeatherPruneAt > WEATHER_PRUNE_INTERVAL_MS) {
            lastWeatherPruneAt = Date.now();
            await pruneWeatherCache(cache);
          }
        } catch (_) {}
      });
      if (event && event.waitUntil) event.waitUntil(putDone);
    }
    return res;
  } catch (_) {
    try {
      const cached = await caches.match(request);
      if (cached) return cached;
    } catch (_) {}
    
    return new Response(OFFLINE_API_JSON, {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}

// Cache-first for static assets, falling back to network. If network
// also fails — typical first-time-offline navigation — we return the
// most appropriate fallback (offline HTML for navigations, generic
// 503 text otherwise).
async function handleStaticAsset(request) {
  try {
    const exact = await caches.match(request);
    if (exact) return exact;
  } catch (_) {}

  // ?v= cache-busted asset: try the canonical URL too.
  try {
    const stripped = await caches.match(cacheKey(request));
    if (stripped) return stripped;
  } catch (_) {}

  try {
    const res = await fetch(request);
    if (res) return res;
  } catch (_) {
    // fall through to offline
  }
  return offlineFallback(request);
}

// Final fallback selector. Navigations (or anything that accepts HTML)
// get the cached homepage if it's around, then OFFLINE_HTML; everything
// else gets a plain 503.
async function offlineFallback(request) {
  const accept = (request.headers.get('accept') || '').toLowerCase();
  const isNavOrHTML =
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    accept.includes('text/html');

  if (isNavOrHTML) {
    try {
      // './' FIRST, deliberately. The server 30x-redirects /index.html to
      // /, so the './index.html' precache entry is stored with
      // response.redirected === true — and a browser refuses to answer a
      // navigation with a redirected response, failing to a network-error
      // page instead of this fallback. './' is fetched directly and
      // carries no redirect flag.
      const cachedHome =
        (await caches.match('./')) ||
        (await caches.match('./index.html'));
      if (cachedHome) return cachedHome;
    } catch (_) {}
    return new Response(OFFLINE_HTML, {
      status: 200,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
  return new Response('Offline', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
