// Path-B proxy base. Same-origin so it resolves against whatever host the
// app is served from — Cloudflare Pages preview, production, or local
// `wrangler pages dev`. The advanced-mode Pages worker (_worker.js at the
// repo root) reads OPENWEATHER_API_KEY from env (from .dev.vars locally,
// dashboard in prod) and forwards the call to OpenWeatherMap. No key ever
// ships with the client bundle.
const PROXY_BASE = '/api/owm';

const enc = encodeURIComponent;

// Custom error class so the UI layer can detect "this is a BYOK key
// problem" (401 / 403 from OWM) and show the right message.
class InvalidApiKeyError extends Error {
  constructor(message) { super(message); this.name = 'InvalidApiKeyError'; }
}

const WeatherAPI = {
  InvalidApiKeyError,

  // Active state: 'custom' when the user has saved their own key,
  // 'default' when we route through the shared proxy fallback. UI
  // queries this to render the status badge.
  getKeyMode() {
    return Storage.getCustomApiKey() ? 'custom' : 'default';
  },

  // Centralized OpenWeatherMap fetcher. All four OWM endpoints (geocode,
  // reverse-geocode, current, forecast) go through here so BYOK / proxy
  // routing lives in exactly one place.
  //
  //   path   — e.g. 'data/2.5/weather'
  //   params — object of query params (no appid — added here per route)
  //
  // Path A: user has saved their own key → direct call to OWM with the
  //         user's appid. A 401 / 403 surfaces as InvalidApiKeyError so
  //         the UI can prompt them to re-check their key.
  // Path B: no user key → _fetchViaProxy(), which today is mocked but
  //         is the swap-in point for a real server-side proxy.
  async _owmFetch(path, params) {
    const userKey = Storage.getCustomApiKey();
    const qs = Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join('&');

    if (userKey) {
      // ----- Path A: direct, with the user's own key -----
      const url = `https://api.openweathermap.org/${path}?${qs}${qs ? '&' : ''}appid=${enc(userKey)}`;
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) {
        throw new InvalidApiKeyError(
          'Your OpenWeatherMap API key was rejected. New keys can take up to 2 hours ' +
          'to activate — if you just created it, please try again later. Otherwise, ' +
          'double-check the key in About → API key.'
        );
      }
      if (!res.ok) throw new Error(`OWM ${path} ${res.status}`);
      return res.json();
    }

    // ----- Path B: same-origin proxy -----
    return this._fetchViaProxy(path, params);
  },

  // Same-origin call to the Cloudflare Pages worker (_worker.js) under
  // /api/owm/<owm-path>. The worker appends OPENWEATHER_API_KEY from
  // env (sourced from .dev.vars for local dev, the Pages dashboard for
  // deployed environments) and forwards the call to OpenWeatherMap. The
  // browser never sees the key.
  //
  // For local development, run `wrangler pages dev .` (or your project's
  // build command) so Functions are mounted. Opening index.html directly
  // off the filesystem will fail this fetch because there's no Function
  // host backing /api/owm — surface a clear error in that case.
  async _fetchViaProxy(path, params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join('&');
    const url = `${PROXY_BASE}/${path}${qs ? '?' + qs : ''}`;

    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(
        `Proxy unreachable. If running locally, start the app with ` +
        `\`wrangler pages dev .\` so Cloudflare Pages Functions are served. ` +
        `(${e && e.message ? e.message : 'fetch failed'})`
      );
    }

    if (!res.ok) {
      // Surface the function's structured error body when present, so
      // a missing OPENWEATHER_API_KEY etc. shows up clearly in devtools.
      let detail = '';
      try {
        const errBody = await res.clone().json();
        if (errBody && errBody.error) detail = ` — ${errBody.error}`;
      } catch (_) {}
      throw new Error(`Proxy ${path} ${res.status}${detail}`);
    }
    return res.json();
  },

  // Convenience: route lat/lon current-weather + forecast through the
  // central wrapper. Spec'd by the BYOK requirements, useful for callers
  // that want both calls in one shot.
  async fetchWeatherData(lat, lon) {
    const [current, forecast] = await Promise.all([
      this.getCurrentWeather(lat, lon),
      this.getForecast(lat, lon),
    ]);
    return { current, forecast };
  },
  // Look up the coordinates for a place. Tries OpenWeatherMap's city
  // geocoder first (fastest, best for cities), then falls back to
  // OpenStreetMap Nominatim which can find landmarks, stadiums, parks,
  // addresses, points of interest, etc. — anything in OSM.
  async getCoordinatesByCity(query) {
    try {
      const data = await this._owmFetch('geo/1.0/direct', { q: query, limit: 1 });
      if (Array.isArray(data) && data.length > 0) {
        return {
          lat:     data[0].lat,
          lon:     data[0].lon,
          name:    data[0].name,
          state:   data[0].state   || '',
          country: data[0].country || ''
        };
      }
    } catch (e) {
      // Bad BYOK key shouldn't silently fall through to OSM — let the UI
      // know so the user can fix it. Other failures (network, 404) fall
      // through to Nominatim as before.
      if (e instanceof InvalidApiKeyError) throw e;
    }
    return await this._geocodeNominatim(query);
  },

  // Free OSM-backed geocoder used to resolve landmarks/POIs that OWM
  // doesn't know about (e.g. "Hollywood Bowl", "Dodger Stadium",
  // "1600 Pennsylvania Ave"). No API key required, CORS-enabled.
  async _geocodeNominatim(query) {
    const url = `https://nominatim.openstreetmap.org/search` +
      `?q=${enc(query)}&format=json&limit=1&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Place not found');
    const data = await res.json();
    if (!data.length) throw new Error('Place not found');
    const r = data[0];
    const addr = r.address || {};
    // Prefer the spelled-out state name (e.g. "California") for display
    // consistency with OWM's geocoder; fall back to the regional code if
    // Nominatim didn't give us a state name.
    const regionCode = (addr['ISO3166-2-lvl4'] || '').split('-').pop();
    // Nominatim doesn't return a clean "name" field for many POIs — fall
    // back to the first comma-separated segment of the display_name.
    const displayName = r.display_name || query;
    return {
      lat:     parseFloat(r.lat),
      lon:     parseFloat(r.lon),
      name:    r.name || displayName.split(',')[0].trim() || query,
      state:   addr.state || regionCode || '',
      country: (addr.country_code || '').toUpperCase()
    };
  },

  async reverseGeocode(lat, lon) {
    try {
      const data = await this._owmFetch('geo/1.0/reverse', { lat, lon, limit: 1 });
      if (!Array.isArray(data) || !data.length) return null;
      return {
        name:    data[0].name,
        state:   data[0].state   || '',
        country: data[0].country || ''
      };
    } catch (e) {
      if (e instanceof InvalidApiKeyError) throw e;
      return null;
    }
  },

  async getCurrentWeather(lat, lon) {
    return this._owmFetch('data/2.5/weather', { lat, lon, units: 'metric' });
  },

  async getForecast(lat, lon) {
    return this._owmFetch('data/2.5/forecast', { lat, lon, units: 'metric' });
  },

  // Open-Meteo enrichment data (free, no API key). Returns:
  //   - UV index (current + daily max for the next 8 days)
  //   - Hourly weather covering 8 days, for the temperature graph's 1h
  //     precipitation bars AND for synthesising days beyond OWM's 5-day
  //     /forecast coverage.
  //   - Daily summaries for 8 days (high/low/icon/sunrise/sunset/etc.) —
  //     used to extend the daily list and to build days 6-8 of the app.
  async getEnrichment(lat, lon) {
    // past_days=1: yesterday's hourlies power the "warmer/cooler than
    // this time yesterday" hero line. NOTE this means `hourly` reaches
    // 24h into the past — every consumer already filters by dt range.
    // `daily` is filtered below so it still starts at today.
    // minutely_15: 15-minute precipitation for the next 24h, for the
    // "rain starting/ending around ..." nowcast.
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${enc(lat)}&longitude=${enc(lon)}` +
      `&current=uv_index` +
      `&daily=uv_index_max,temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum,snowfall_sum,sunrise,sunset,precipitation_probability_max,windspeed_10m_max,windgusts_10m_max,sunshine_duration` +
      `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,snowfall,precipitation_probability,weathercode,windspeed_10m,winddirection_10m,windgusts_10m,is_day,cloud_cover,visibility,pressure_msl,uv_index,dew_point_2m` +
      `&minutely_15=precipitation&forecast_minutely_15=96` +
      `&windspeed_unit=ms&timezone=auto&timeformat=unixtime&forecast_days=8&past_days=1`;
    const res = await fetch(url);
    if (!res.ok) return { uv: { current: null, daily: [] }, hourly: [], daily: [], minutely: [] };
    const data = await res.json();

    const h = data.hourly || {};
    const times = h.time || [];
    const hourly = times.map((t, i) => ({
      dt:          t,
      temp:        h.temperature_2m         ? h.temperature_2m[i]         : null,
      feelsLike:   h.apparent_temperature   ? h.apparent_temperature[i]   : null,
      humidity:    h.relative_humidity_2m   ? h.relative_humidity_2m[i]   : null,
      precipMM:    h.precipitation          ? h.precipitation[i] || 0     : 0,
      // Open-Meteo reports snowfall as DEPTH in cm, while `precipitation`
      // is water-equivalent mm and ALREADY INCLUDES that snow. Keep the
      // raw cm here; _omHourToOwmSlot converts to water-equivalent mm
      // (cm / 0.7, per Open-Meteo's 7 cm ≈ 10 mm example) and subtracts
      // it from precipMM to get the rain share. Storing depth rather than
      // a pre-derived split keeps a future "snow accumulation" readout
      // possible without another fetch.
      snowCM:      h.snowfall              ? h.snowfall[i] || 0          : 0,
      precipProb:  h.precipitation_probability ? h.precipitation_probability[i] || 0 : 0,
      weatherCode: h.weathercode            ? h.weathercode[i]            : null,
      windSpeed:   h.windspeed_10m          ? h.windspeed_10m[i]          : null,
      windDir:     h.winddirection_10m      ? h.winddirection_10m[i]      : null,
      windGust:    h.windgusts_10m          ? h.windgusts_10m[i]          : null,
      isDay:       h.is_day                 ? !!h.is_day[i]               : true,
      cloudCover:  h.cloud_cover            ? h.cloud_cover[i]            : null,
      visibility:  h.visibility             ? h.visibility[i]             : null,
      pressureMsl: h.pressure_msl           ? h.pressure_msl[i]           : null,
      uvIndex:     h.uv_index               ? h.uv_index[i]               : null,
      // Exact model dew point. UI falls back to its Magnus approximation
      // when this is null (older cache entries, or a missing column).
      dewPoint:    h.dew_point_2m           ? h.dew_point_2m[i]           : null
    }));

    const d = data.daily || {};
    const dTimes = d.time || [];
    // Drop fully-past days (past_days=1 puts yesterday at index 0) so
    // downstream day-building keeps its "today sorts first" invariant.
    const nowSec = Math.floor(Date.now() / 1000);
    const daily = dTimes.map((t, i) => ({
      dt:           t,
      tempMax:      d.temperature_2m_max  ? d.temperature_2m_max[i]  : null,
      tempMin:      d.temperature_2m_min  ? d.temperature_2m_min[i]  : null,
      weatherCode:  d.weathercode         ? d.weathercode[i]         : null,
      // NOT `|| 0` — that coerced a missing column and a genuine null to
      // the same 0, so a consumer could never tell "Open-Meteo says it's
      // dry" from "Open-Meteo has no figure", and any fallback guarded on
      // `!= null` was dead code. A real 0 still comes through as 0.
      precipSum:    d.precipitation_sum   ? d.precipitation_sum[i] : null,
      sunrise:      d.sunrise             ? d.sunrise[i]             : null,
      sunset:       d.sunset              ? d.sunset[i]              : null,
      uvIndexMax:   d.uv_index_max        ? d.uv_index_max[i]        : null,
      popMax:       d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
      windMax:      d.windspeed_10m_max   ? d.windspeed_10m_max[i]   : null,
      gustMax:      d.windgusts_10m_max   ? d.windgusts_10m_max[i]   : null,
      // Depth in cm, same convention as hourly snowCM. Null-preserving
      // for the same reason as precipSum above — `|| 0` would make the
      // "is this figure available?" guard in the Snow stat dead code.
      snowSumCM:    d.snowfall_sum        ? d.snowfall_sum[i]        : null,
      sunshineSec:  d.sunshine_duration   ? d.sunshine_duration[i]   : null
    })).filter(day => day.dt + 86400 > nowSec);

    const m = data.minutely_15 || {};
    const minutely = (m.time || []).map((t, i) => ({
      dt: t,
      precipMM: m.precipitation ? m.precipitation[i] || 0 : 0
    }));

    return {
      uv: {
        current: data.current && data.current.uv_index != null ? data.current.uv_index : null,
        daily: daily.map(day => day.uvIndexMax)
      },
      hourly,
      daily,
      minutely,
      // IANA zone name for the requested point (timezone=auto), e.g.
      // "America/New_York". Unlike OWM's fixed utc-offset this stays
      // correct across DST transitions inside the 8-day window, so the
      // UI prefers it for day keys and local-time display.
      tzName: data.timezone || null
    };
  },

  // Active National Weather Service alerts for a point. US-only; returns
  // [] for any non-US coordinate (the NWS API just returns no features).
  // Returns every severity, sorted most-severe first — the UI shows
  // Severe/Extreme as the red alert bar and lesser messages (Watches,
  // Advisories, Statements) as a quieter amber tier.
  async getAlerts(lat, lon) {
    // NWS only covers US territory (CONUS + AK + HI + PR + USVI + Guam etc.).
    // Calling /alerts/active with a point outside that bounding box returns
    // 400 Bad Request, which the browser logs as a noisy network error even
    // though we catch it. Skip the request entirely for clearly-non-US
    // coordinates. The box is intentionally loose — false positives just
    // become a single 400 we catch below, false negatives would silently
    // miss real alerts.
    const inUSBox =
      lat >= 17 && lat <= 72 &&
      lon >= -180 && lon <= -65;
    if (!inUSBox) return [];

    try {
      const res = await fetch(
        `https://api.weather.gov/alerts/active?point=${enc(lat)},${enc(lon)}`,
        { headers: { 'Accept': 'application/geo+json' } }
      );
      if (!res.ok) return [];
      const data = await res.json();
      // ALL severities come through; the UI decides presentation —
      // Severe/Extreme get the red alert bar, everything else (Watches,
      // Advisories, Statements) the quieter amber tier.
      const features = (data.features || []).filter(f =>
        f.properties && f.properties.severity
      );
      // Most severe first.
      const severityOrder = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };
      features.sort((a, b) =>
        (severityOrder[b.properties.severity] || 0) -
        (severityOrder[a.properties.severity] || 0)
      );
      return features.map(f => {
        const p = f.properties || {};
        return {
          id:          p.id || '',
          event:       p.event || 'Weather alert',
          headline:    p.headline || '',
          description: p.description || '',
          instruction: p.instruction || '',
          severity:    p.severity || 'Unknown',
          urgency:     p.urgency || '',
          areaDesc:    p.areaDesc || '',
          sender:      p.senderName || '',
          effective:   p.effective || '',
          expires:     p.expires || '',
          // properties.web is the official NWS detail page when available;
          // otherwise fall back to a forecast-by-point URL that lists all
          // current alerts for the location.
          url:         p.web ||
                       `https://forecast.weather.gov/MapClick.php?lat=${lat}&lon=${lon}`
        };
      });
    } catch (_) {
      return [];
    }
  },

  // Air quality + pollen via Open-Meteo's free Air Quality API.
  // Returns { aqi: number|null, pollen: number|null }.
  //   aqi    — US AQI (0-500), available globally
  //   pollen — sum of CAMS pollen values (grains/m³); only populated in
  //            Europe where the CAMS forecast has coverage.
  async getAirQuality(lat, lon) {
    // CAMS individual pollen species, grouped into the three categories the
    // UI surfaces (tree / grass / weed). Mapping follows the standard
    // allergy-forecast convention: alder/birch/olive are tree pollens,
    // mugwort/ragweed are weed pollens, grass is its own bucket.
    const TREE_FIELDS  = ['alder_pollen', 'birch_pollen', 'olive_pollen'];
    const GRASS_FIELDS = ['grass_pollen'];
    const WEED_FIELDS  = ['mugwort_pollen', 'ragweed_pollen'];
    const POLLEN_FIELDS = [...TREE_FIELDS, ...GRASS_FIELDS, ...WEED_FIELDS];
    // Per-pollutant US AQI sub-indices — Open-Meteo computes these for
    // us, so "which pollutant is driving the number" is just an argmax,
    // no EPA breakpoint tables needed.
    const SUB_AQI = {
      us_aqi_pm2_5:            'PM2.5',
      us_aqi_pm10:             'PM10',
      us_aqi_ozone:            'O₃',
      us_aqi_nitrogen_dioxide: 'NO₂',
      us_aqi_sulphur_dioxide:  'SO₂',
      us_aqi_carbon_monoxide:  'CO'
    };
    const empty = { aqi: null, aqiPollutant: null, pollen: null, treePollen: null, grassPollen: null, weedPollen: null };

    const url = `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${enc(lat)}&longitude=${enc(lon)}` +
      `&current=us_aqi,${Object.keys(SUB_AQI).join(',')},${POLLEN_FIELDS.join(',')}` +
      `&timezone=auto`;
    try {
      const res = await fetch(url);
      if (!res.ok) return empty;
      const data = await res.json();
      const cur = data.current || {};
      const aqi = cur.us_aqi != null ? cur.us_aqi : null;
      const sum = (fields) => {
        const has = fields.some(k => cur[k] != null);
        return has ? fields.reduce((s, k) => s + (typeof cur[k] === 'number' ? cur[k] : 0), 0) : null;
      };
      const treePollen  = sum(TREE_FIELDS);
      const grassPollen = sum(GRASS_FIELDS);
      const weedPollen  = sum(WEED_FIELDS);
      const hasPollen = POLLEN_FIELDS.some(k => cur[k] != null);
      const pollen = hasPollen
        ? POLLEN_FIELDS.reduce((s, k) => s + (typeof cur[k] === 'number' ? cur[k] : 0), 0)
        : null;
      // Dominant pollutant = the sub-index equal to (or nearest) the
      // headline AQI, since US AQI is defined as the max sub-index.
      let aqiPollutant = null;
      let bestSub = -1;
      for (const [field, label] of Object.entries(SUB_AQI)) {
        if (cur[field] != null && cur[field] > bestSub) {
          bestSub = cur[field];
          aqiPollutant = label;
        }
      }
      return { aqi, aqiPollutant, pollen, treePollen, grassPollen, weedPollen };
    } catch (_) {
      return empty;
    }
  },

  // NWS Area Forecast Discussion — the local forecast office's long-form
  // narrative about what's driving the forecast. US-only (same bounding
  // box as getAlerts). Three requests: point → office id, AFD product
  // list → latest product id, product → text. Any failure returns null
  // and the feature is simply absent.
  async getForecastDiscussion(lat, lon) {
    const inUSBox =
      lat >= 17 && lat <= 72 &&
      lon >= -180 && lon <= -65;
    if (!inUSBox) return null;
    try {
      const ptRes = await fetch(
        `https://api.weather.gov/points/${enc(lat)},${enc(lon)}`,
        { headers: { 'Accept': 'application/geo+json' } }
      );
      if (!ptRes.ok) return null;
      const pt = await ptRes.json();
      const office = pt.properties && pt.properties.cwa;
      if (!office) return null;

      const listRes = await fetch(
        `https://api.weather.gov/products/types/AFD/locations/${enc(office)}`,
        { headers: { 'Accept': 'application/ld+json' } }
      );
      if (!listRes.ok) return null;
      const list = await listRes.json();
      const latest = list['@graph'] && list['@graph'][0];
      if (!latest || !latest['@id']) return null;

      const prodRes = await fetch(latest['@id'], { headers: { 'Accept': 'application/ld+json' } });
      if (!prodRes.ok) return null;
      const prod = await prodRes.json();
      if (!prod.productText) return null;

      return {
        office,
        issued: prod.issuanceTime || latest.issuanceTime || null,
        // AFDs run 5–30KB; cap so the localStorage weather cache can't
        // be blown up by one unusually chatty office.
        text: String(prod.productText).slice(0, 30000)
      };
    } catch (_) {
      return null;
    }
  },

  // ── NOAA CO-OPS tide predictions ─────────────────────────────────────
  //
  // Open-Meteo's `sea_level_height_msl` is a global OCEAN MODEL sampled at
  // a grid cell, and its phase can differ substantially from the harbour
  // you actually care about — measured against Honolulu Harbor it ran
  // ~100 minutes early on the low and ~76 on the high. NOAA publishes
  // station-based HARMONIC predictions, which is what printed tide tables
  // use, so prefer those wherever a station is close enough. Open-Meteo
  // stays as the global fallback (and remains the only source of
  // sea-surface temperature — NOAA predictions carry no SST).
  //
  // 50 km: US station density is high enough that a real coastal location
  // almost always has one much closer, and beyond ~50 km the phase
  // difference this exists to fix starts creeping back in.
  NOAA_TIDE_MAX_KM: 50,

  _haversineKm(aLat, aLon, bLat, bLon) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  },

  // Linear scan over the bundled catalogue (~3,300 entries) — a few
  // thousand haversines is nothing next to the network calls that follow,
  // and it avoids shipping a spatial index for one lookup per city.
  nearestTideStation(lat, lon) {
    const list = (typeof TIDE_STATIONS !== 'undefined' && TIDE_STATIONS) || [];
    let best = null;
    let bestKm = Infinity;
    for (const s of list) {
      const km = this._haversineKm(lat, lon, s[2], s[3]);
      if (km < bestKm) { bestKm = km; best = s; }
    }
    if (!best || bestKm > this.NOAA_TIDE_MAX_KM) return null;
    return { id: best[0], name: best[1], lat: best[2], lon: best[3], km: bestKm };
  },

  // Returns { station, extrema, hourly } or null. `hourly` deliberately
  // mirrors Open-Meteo's { time[], sea_level_height_msl[] } shape so the
  // graph renderer doesn't need to know which source it's drawing.
  //
  // datum=MSL, not the MLLW that tide tables print: it matches what
  // Open-Meteo returns, so heights mean the same thing regardless of
  // source and the display threshold doesn't have to branch. Times are
  // identical under either datum — only the zero point moves.
  async getNoaaTides(lat, lon) {
    const station = this.nearestTideStation(lat, lon);
    if (!station) return null;

    const ymd = (d) => `${d.getUTCFullYear()}` +
      `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
      `${String(d.getUTCDate()).padStart(2, '0')}`;
    const now = Date.now();
    // -1/+8 days mirrors the main forecast's past_days=1 / forecast_days=8,
    // so tide rows never run out before the day list does.
    const begin = ymd(new Date(now - 86400000));
    const end = ymd(new Date(now + 8 * 86400000));

    const base = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter' +
      '?product=predictions&application=WeatherDaddy&datum=MSL&units=metric' +
      '&time_zone=gmt&format=json' +
      `&station=${enc(station.id)}&begin_date=${enc(begin)}&end_date=${enc(end)}`;

    // GMT timestamps, "YYYY-MM-DD HH:MM" with no zone marker.
    const toSec = (t) => Date.parse(String(t).replace(' ', 'T') + 'Z') / 1000;

    try {
      // hilo gives the turning points EXACTLY, so unlike the Open-Meteo
      // path there's no need to hunt for extrema in an hourly series and
      // no interpolation error. The hourly series is fetched only to draw
      // the curve.
      const [hiloRes, hourlyRes] = await Promise.all([
        fetch(base + '&interval=hilo'),
        fetch(base + '&interval=h')
      ]);
      if (!hiloRes.ok || !hourlyRes.ok) return null;

      const [hilo, hourly] = await Promise.all([hiloRes.json(), hourlyRes.json()]);
      if (!hilo || !hilo.predictions || !hourly || !hourly.predictions) return null;

      const extrema = hilo.predictions
        .map(p => ({
          type: p.type === 'H' ? 'High' : 'Low',
          dt: toSec(p.t),
          h: parseFloat(p.v)
        }))
        .filter(e => isFinite(e.dt) && isFinite(e.h))
        .sort((a, b) => a.dt - b.dt);

      const time = [];
      const levels = [];
      for (const p of hourly.predictions) {
        const dt = toSec(p.t);
        const v = parseFloat(p.v);
        if (!isFinite(dt) || !isFinite(v)) continue;
        time.push(dt);
        levels.push(v);
      }

      // A station that returns one but not the other is unusable — fall
      // back rather than render half a feature.
      if (!extrema.length || !time.length) return null;

      return {
        station,
        extrema,
        hourly: { time, sea_level_height_msl: levels }
      };
    } catch (_) {
      return null;
    }
  },

  // Session-scoped memo of coordinates the marine API has already told us
  // it has no data for. Without it, every landlocked saved city fires a
  // doomed marine request on every 15-minute auto-refresh and on every
  // adjacent-city prefetch. Keyed at ~1km resolution (3dp) so returning to
  // the same city hits the memo. Session-only on purpose: coverage can
  // change with model updates, and a page reload is a cheap re-check.
  _marineMisses: new Set(),
  _marineKey(lat, lon) {
    return `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
  },

  // Marine conditions for coastal points: the sea-level (tide) curve plus
  // sea-surface temperature. Inland coordinates 400 here, which is how the
  // app decides a location isn't coastal — there is no bathymetry lookup
  // to pre-check against.
  //
  // forecast_days=8 matches the main forecast's range; the API's 7-day
  // default used to make tide rows silently vanish on day 8. past_days=1
  // backfills the hours a city far west of UTC would otherwise lose,
  // because the series starts at 00:00 UTC.
  async getMarine(lat, lon) {
    const key = this._marineKey(lat, lon);
    if (this._marineMisses.has(key)) return null;
    const url = `https://marine-api.open-meteo.com/v1/marine` +
      `?latitude=${enc(lat)}&longitude=${enc(lon)}` +
      `&hourly=sea_level_height_msl,sea_surface_temperature` +
      `&timeformat=unixtime&timezone=auto&forecast_days=8&past_days=1`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        // 400 = no marine coverage. Other failures (429/5xx) are transient
        // and must NOT poison the memo.
        if (res.status === 400) this._marineMisses.add(key);
        return null;
      }
      const data = await res.json();
      const hourly = data.hourly || null;
      // A 200 with an all-null sea-level column is the other shape "not
      // coastal" arrives in. Treat it the same as a 400.
      const levels = hourly && hourly.sea_level_height_msl;
      if (!levels || !levels.some(v => v != null)) {
        this._marineMisses.add(key);
        return null;
      }
      return {
        // The marine grid-cell centre the request snapped to, NOT the
        // requested coords. The UI measures the distance between the two
        // to decide how prominently to show tides.
        latitude: data.latitude,
        longitude: data.longitude,
        hourly
      };
    } catch (_) {
      return null;
    }
  }
};

