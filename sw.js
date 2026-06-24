const CACHE_NAME = 'weatherdaddy-v171';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/weather.js',
  './js/ui.js',
  './js/storage.js',
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
          await cache.add(url);
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
  event.respondWith(handleFetch(event.request));
});

async function handleFetch(request) {
  try {
    const reqUrl = new URL(request.url);
    // Treat both direct-to-OWM (Path A, BYOK) and our own Pages
    // Function proxy (Path B, /api/owm/...) as weather API calls.
    const isWeatherAPI =
      reqUrl.hostname === 'api.openweathermap.org' ||
      reqUrl.pathname.startsWith('/api/owm/');
    if (isWeatherAPI) return await handleWeatherAPI(request);
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
// unbounded under stale-while-revalidate. We cap at WEATHER_CACHE_MAX
// entries (FIFO-evicted via Cache.keys() insertion order) and drop
// any entry whose served Response.date header is older than
// WEATHER_CACHE_MAX_AGE_MS, since the app always refreshes on view
// and a stale snapshot from a week ago is just dead bytes.
const WEATHER_CACHE_MAX = 80;
const WEATHER_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

const isWeatherURL = (urlOrRequest) => {
  try {
    const u = typeof urlOrRequest === 'string'
      ? new URL(urlOrRequest, self.location.href)
      : new URL(urlOrRequest.url);
    return u.hostname === 'api.openweathermap.org' ||
           u.pathname.startsWith('/api/owm/');
  } catch (_) { return false; }
};

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

// Stale-while-revalidate for the weather APIs. Cache wins on display;
// network refreshes in the background. When BOTH miss we return a 503
// JSON body so the WeatherAPI layer's existing error path runs.
async function handleWeatherAPI(request) {
  let cached = null;
  try {
    cached = await caches.match(request);
  } catch (_) {}

  const networkPromise = (async () => {
    try {
      const res = await fetch(request);
      if (res && res.ok) {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, res.clone());
          // Housekeep AFTER the put so a new entry can immediately
          // displace the oldest stale one. Runs in this same async
          // closure but we don't block the caller on it.
          pruneWeatherCache(cache);
        } catch (_) { /* quota / storage error — non-fatal */ }
      }
      return res;
    } catch (_) {
      return null;
    }
  })();

  if (cached) {
    // Let the refresh run; don't await it.
    networkPromise.catch(() => {});
    return cached;
  }
  const network = await networkPromise;
  if (network) return network;
  return new Response(OFFLINE_API_JSON, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
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
      const cachedHome =
        (await caches.match('./index.html')) ||
        (await caches.match('./'));
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
