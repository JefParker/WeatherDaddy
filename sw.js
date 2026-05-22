const CACHE_NAME = 'weatherdaddy-v126';
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
  './assets/icons/maskable-512.png'
];

// Strip ?v=... query strings so cache-busted asset URLs still hit the precache.
const cacheKey = (request) => {
  const url = new URL(request.url);
  url.search = '';
  return new Request(url.toString(), { method: request.method });
};

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Treat both direct-to-OWM (Path A, BYOK) and our own Pages Function
  // proxy (Path B, /api/owm/...) as weather API calls for caching
  // purposes. Same stale-while-revalidate behaviour either way.
  const reqUrl = new URL(event.request.url);
  const isWeatherAPI =
    reqUrl.hostname === 'api.openweathermap.org' ||
    reqUrl.pathname.startsWith('/api/owm/');

  if (isWeatherAPI) {
    // Stale-while-revalidate, but only cache successful (200) responses.
    event.respondWith(
      caches.match(event.request).then(cached => {
        const network = fetch(event.request).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Static assets: try cache (ignoring ?v= query string), fall back to network.
  event.respondWith(
    caches.match(event.request).then(res =>
      res || caches.match(cacheKey(event.request)).then(res2 => res2 || fetch(event.request))
    )
  );
});
