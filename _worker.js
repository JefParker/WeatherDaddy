// Cloudflare Worker — secure reverse proxy for OpenWeatherMap.
//
// Deployed via Cloudflare Pages "advanced mode": this file sits at the
// project root and intercepts every request before the static asset
// router. We route /api/owm/* into the proxy logic below, and let every
// other path (HTML, CSS, JS, icons, manifest, etc.) fall through to the
// Pages asset bundle via `env.ASSETS.fetch(request)`.
//
// Contract enforced in fetch():
//   1. PATH REWRITING        — strip the /api/owm/ prefix + any leading slash
//   2. API KEY RESOLUTION    — BYOK (?appid= or X-Custom-Api-Key) then env secret
//   3. UPSTREAM FETCHING     — appid is appended (or overwritten) on the way out
//   4. CORS                  — permissive headers on every response (including
//                              the missing-key error and OPTIONS preflight)
//
// Required Pages env binding: OPENWEATHER_API_KEY (encrypted secret).

const PROXY_PREFIX = '/api/owm';
const UPSTREAM     = 'https://api.openweathermap.org';

export default {
  async fetch(request, env /* , ctx */) {
    const url = new URL(request.url);

    // Anything outside the proxy namespace is a static asset — hand it
    // back to Pages so the PWA, its JS bundles, icons, etc. still load.
    if (
      url.pathname !== PROXY_PREFIX &&
      !url.pathname.startsWith(PROXY_PREFIX + '/')
    ) {
      return env.ASSETS.fetch(request);
    }

    // CORS preflight — answer immediately, never round-trip upstream.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // The spec only requires GET; reject other verbs explicitly so we
    // never forward a mutating request upstream.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'Method Not Allowed' }, 405);
    }

    // ── 1. PATH REWRITING ────────────────────────────────────────────
    // Strip the /api/owm prefix wholesale, then any leftover leading slash.
    // Examples:
    //   /api/owm/data/2.5/weather         → data/2.5/weather
    //   /api/owm//geo/1.0/direct          → geo/1.0/direct
    //   /api/owm                          → "" (empty, treated as bad request)
    let path = url.pathname.slice(PROXY_PREFIX.length);
    while (path.startsWith('/')) path = path.slice(1);
    if (!path) {
      return jsonResponse({ error: 'Missing upstream path' }, 400);
    }

    // ── 2. API KEY RESOLUTION ────────────────────────────────────────
    // Order: explicit ?appid= → X-Custom-Api-Key header → env secret.
    // (The header path lets future client code send keys without leaking
    // them into URLs / referrer headers / access logs.)
    const queryKey  = url.searchParams.get('appid');
    const headerKey = request.headers.get('x-custom-api-key');
    const apiKey = (queryKey && queryKey.trim()) ||
                   (headerKey && headerKey.trim()) ||
                   env.OPENWEATHER_API_KEY;

    if (!apiKey) {
      return jsonResponse({ error: 'API Key missing' }, 401);
    }

    // ── 3. UPSTREAM FETCHING ─────────────────────────────────────────
    // Rebuild the OWM URL with every original query param EXCEPT appid;
    // then set appid from the resolved key (so a BYOK ?appid= naturally
    // overrides the env fallback, and we never double-attach the param).
    const upstream = new URL(`${UPSTREAM}/${path}`);
    for (const [k, v] of url.searchParams) {
      if (k.toLowerCase() === 'appid') continue;
      upstream.searchParams.set(k, v);
    }
    upstream.searchParams.set('appid', apiKey);

    let upstreamRes;
    try {
      upstreamRes = await fetch(upstream.toString(), {
        // Light edge cache so repeat lookups for the same city don't
        // burn through the OWM free-tier quota.
        cf: { cacheTtl: 60, cacheEverything: true },
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      return jsonResponse(
        { error: `Upstream fetch failed: ${err && err.message ? err.message : 'unknown error'}` },
        502
      );
    }

    // ── 4. BROWSER COMPATIBILITY & CORS ──────────────────────────────
    // Forward the upstream status + body, but rewrite headers so the
    // client always sees JSON + permissive CORS regardless of what
    // OpenWeatherMap returns.
    const body = await upstreamRes.text();
    return new Response(body, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  },
};

// CORS preset — applied to every response this Worker emits, success
// or error, including 401 "API Key missing" so the PWA's fetch() can
// actually read the error body across origins.
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
