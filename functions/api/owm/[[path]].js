// Cloudflare Pages Function — OpenWeatherMap proxy.
//
// Route:   /api/owm/<owm-path>?<query>
// Example: /api/owm/data/2.5/weather?lat=35&lon=139&units=metric
//
// The function appends the OPENWEATHER_API_KEY secret (set in .dev.vars for
// local `wrangler pages dev`, and in Pages → Settings → Environment
// variables for production / preview) and forwards the upstream JSON back
// to the browser. The client never sees the key.
//
// Bound to the [[path]] catch-all so the four OWM endpoints the app uses
// (data/2.5/weather, data/2.5/forecast, geo/1.0/direct, geo/1.0/reverse)
// all flow through this single function.

const UPSTREAM = 'https://api.openweathermap.org';

// Only forward calls to the four endpoints the app actually uses, so a
// leaked/abused proxy URL can't be turned into a generic OWM relay.
const ALLOWED_PREFIXES = [
  'data/2.5/weather',
  'data/2.5/forecast',
  'geo/1.0/direct',
  'geo/1.0/reverse',
];

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET' } });
  }

  if (!env.OPENWEATHER_API_KEY) {
    return jsonError(500, 'Proxy is missing OPENWEATHER_API_KEY. Set it in .dev.vars locally or in the Pages dashboard for deployed environments.');
  }

  // params.path is an array of segments under [[path]]. Join, strip leading
  // slashes, and validate against the allowlist.
  const rawPath = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  const path = rawPath.replace(/^\/+/, '');
  if (!ALLOWED_PREFIXES.some(p => path === p || path.startsWith(p + '/'))) {
    return jsonError(400, `Unsupported OWM path: "${path}".`);
  }

  // Rebuild the upstream URL with the original query string + the appid.
  const incoming = new URL(request.url);
  const upstream = new URL(`${UPSTREAM}/${path}`);
  for (const [k, v] of incoming.searchParams) {
    // Defensive: never let a client-supplied appid through.
    if (k.toLowerCase() === 'appid') continue;
    upstream.searchParams.set(k, v);
  }
  upstream.searchParams.set('appid', env.OPENWEATHER_API_KEY);

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream.toString(), {
      // Lightweight edge cache (60s) — OWM data doesn't change that fast,
      // and this dramatically cuts our OWM quota for repeat lookups.
      cf: { cacheTtl: 60, cacheEverything: true },
      headers: { 'accept': 'application/json' },
    });
  } catch (e) {
    return jsonError(502, `Upstream fetch failed: ${e && e.message ? e.message : 'unknown'}`);
  }

  // Pass JSON through untouched; rewrite cache + CORS headers so the
  // browser can talk to us from the same origin (and we can experiment
  // with cross-origin Pages projects later if needed).
  const body = await upstreamRes.text();
  return new Response(body, {
    status: upstreamRes.status,
    headers: {
      'content-type': upstreamRes.headers.get('content-type') || 'application/json',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
    },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
