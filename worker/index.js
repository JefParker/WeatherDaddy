// Cloudflare Worker — secure reverse proxy for OpenWeatherMap, plus the
// static-asset front door for the PWA.
//
// Deployed as a Cloudflare Worker with static assets (see wrangler.jsonc).
// `assets.run_worker_first` routes /api/* and the three update-bootstrap
// files through here; we handle /api/owm/* with the proxy logic below and
// hand anything else back to the asset router via `env.ASSETS.fetch()`.
//
// /api/push/* is delegated to worker/push.js; the scheduled() export
// runs the notification crons from the same module.
//
// Contract enforced in fetch() for the proxy:
//   1. PATH REWRITING        — strip the /api/owm/ prefix + any leading slash
//   2. API KEY RESOLUTION    — BYOK (?appid= or X-Custom-Api-Key) then env secret
//   3. UPSTREAM FETCHING     — appid is appended (or overwritten) on the way out
//   4. CORS                  — permissive headers on every response (including
//                              the missing-key error and OPTIONS preflight)
//
// Required secret: OPENWEATHER_API_KEY (`wrangler secret put`; .dev.vars
// locally).

import { handlePushRoute, handleScheduled } from './push.js';

const PROXY_PREFIX = '/api/owm';
const PUSH_PREFIX  = '/api/push/';
const UPSTREAM     = 'https://api.openweathermap.org';

// Only the endpoints the app actually calls. Without this allowlist the
// proxy was an open, CORS-* relay to EVERY OpenWeatherMap endpoint with
// our shared key attached — any third-party page or script could burn
// the quota (including paid endpoints the key may be entitled to).
const ALLOWED_PATHS = new Set([
  'data/2.5/weather',
  'data/2.5/forecast',
  'geo/1.0/direct',
  'geo/1.0/reverse',
]);

export default {
  // Cron Triggers (wrangler.jsonc → triggers.crons): notifications.
  async scheduled(event, env, ctx) {
    await handleScheduled(event, env, ctx);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Push-notification API (subscriptions, test sends). Same-origin
    // only, so no CORS preset — see worker/push.js.
    if (url.pathname.startsWith(PUSH_PREFIX)) {
      return handlePushRoute(request, env, ctx, url.pathname.slice(PUSH_PREFIX.length));
    }

    // Anything outside the proxy namespace is a static asset — hand it
    // back to the asset router so the PWA, its JS bundles, icons, etc.
    // still load.
    if (
      url.pathname !== PROXY_PREFIX &&
      !url.pathname.startsWith(PROXY_PREFIX + '/')
    ) {
      return serveAsset(request, url, env);
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
    if (!ALLOWED_PATHS.has(path)) {
      return jsonResponse({ error: 'Path not allowed' }, 403);
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
        // burn through the OWM free-tier quota. Successes only: a
        // cached 401 or 429 would keep answering for a minute after
        // the key or the quota had recovered.
        cf: { cacheTtlByStatus: { '200-299': 60 }, cacheEverything: true },
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
        // Same rule for the browser's cache: an error is not worth a minute.
        'Cache-Control': upstreamRes.ok ? 'public, max-age=60' : 'no-store',
      },
    });
  },
};

// Static assets, with one override: the two files that BOOTSTRAP an
// update must always be revalidated.
//
// The service worker serves everything else cache-first, so the only way
// a new deploy reaches an installed client is:
//   sw.js is re-fetched → its CACHE_NAME differs → install → skipWaiting
// If sw.js can itself be answered from the browser's HTTP cache, that
// chain never starts and the device stays on the old version
// indefinitely — which is exactly what happened on mobile, where the
// browser is far more willing to reuse a cached response than desktop.
//
// `no-cache` here means "revalidate before reusing", NOT "don't store":
// the ETag still yields a cheap 304 when nothing has changed.
//
// This lives in the Worker rather than a `_headers` file on purpose —
// `_headers` only decorates responses the asset router produces on its
// own, and these three paths are routed through the Worker first.
const ALWAYS_REVALIDATE = new Set(['/sw.js', '/', '/index.html']);

async function serveAsset(request, url, env) {
  const res = await env.ASSETS.fetch(request);
  if (!ALWAYS_REVALIDATE.has(url.pathname)) return res;

  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

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
