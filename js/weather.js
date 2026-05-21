// Path-B proxy base. Same-origin so it resolves against whatever host the
// app is served from — Cloudflare Pages preview, production, or local
// `wrangler pages dev`. The Pages Function at functions/api/owm/[[path]].js
// reads OPENWEATHER_API_KEY from env (from .dev.vars locally, dashboard in
// prod) and forwards the call to OpenWeatherMap. No key ever ships with
// the client bundle.
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

  // Same-origin call to the Cloudflare Pages Function under
  // /api/owm/<owm-path>. The function appends OPENWEATHER_API_KEY from
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
    const url = `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${enc(lat)}&longitude=${enc(lon)}` +
      `&current=uv_index` +
      `&daily=uv_index_max,temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum,sunrise,sunset` +
      `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,precipitation_probability,weathercode,windspeed_10m,winddirection_10m,windgusts_10m,is_day` +
      `&windspeed_unit=ms&timezone=auto&timeformat=unixtime&forecast_days=8`;
    const res = await fetch(url);
    if (!res.ok) return { uv: { current: null, daily: [] }, hourly: [], daily: [] };
    const data = await res.json();

    const h = data.hourly || {};
    const times = h.time || [];
    const hourly = times.map((t, i) => ({
      dt:          t,
      temp:        h.temperature_2m         ? h.temperature_2m[i]         : null,
      feelsLike:   h.apparent_temperature   ? h.apparent_temperature[i]   : null,
      humidity:    h.relative_humidity_2m   ? h.relative_humidity_2m[i]   : null,
      precipMM:    h.precipitation          ? h.precipitation[i] || 0     : 0,
      precipProb:  h.precipitation_probability ? h.precipitation_probability[i] || 0 : 0,
      weatherCode: h.weathercode            ? h.weathercode[i]            : null,
      windSpeed:   h.windspeed_10m          ? h.windspeed_10m[i]          : null,
      windDir:     h.winddirection_10m      ? h.winddirection_10m[i]      : null,
      windGust:    h.windgusts_10m          ? h.windgusts_10m[i]          : null,
      isDay:       h.is_day                 ? !!h.is_day[i]               : true
    }));

    const d = data.daily || {};
    const dTimes = d.time || [];
    const daily = dTimes.map((t, i) => ({
      dt:           t,
      tempMax:      d.temperature_2m_max  ? d.temperature_2m_max[i]  : null,
      tempMin:      d.temperature_2m_min  ? d.temperature_2m_min[i]  : null,
      weatherCode:  d.weathercode         ? d.weathercode[i]         : null,
      precipSum:    d.precipitation_sum   ? d.precipitation_sum[i] || 0 : 0,
      sunrise:      d.sunrise             ? d.sunrise[i]             : null,
      sunset:       d.sunset              ? d.sunset[i]              : null,
      uvIndexMax:   d.uv_index_max        ? d.uv_index_max[i]        : null
    }));

    return {
      uv: {
        current: data.current && data.current.uv_index != null ? data.current.uv_index : null,
        daily: (d.uv_index_max) || []
      },
      hourly,
      daily
    };
  },

  // Active National Weather Service alerts for a point. US-only; returns
  // [] for any non-US coordinate (the NWS API just returns no features).
  // Filtered to only the "red" alerts — Severe and Extreme severity —
  // which excludes Statements, Advisories, Watches, and other Moderate /
  // Minor messages we don't want to pop up at the user.
  async getAlerts(lat, lon) {
    try {
      const res = await fetch(
        `https://api.weather.gov/alerts/active?point=${enc(lat)},${enc(lon)}`,
        { headers: { 'Accept': 'application/geo+json' } }
      );
      if (!res.ok) return [];
      const data = await res.json();
      const RED_LEVELS = new Set(['Severe', 'Extreme']);
      const features = (data.features || []).filter(f =>
        RED_LEVELS.has(f.properties && f.properties.severity)
      );
      // Most severe first within the filtered set.
      const severityOrder = { Extreme: 4, Severe: 3 };
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
    const empty = { aqi: null, pollen: null, treePollen: null, grassPollen: null, weedPollen: null };

    const url = `https://air-quality-api.open-meteo.com/v1/air-quality` +
      `?latitude=${enc(lat)}&longitude=${enc(lon)}` +
      `&current=us_aqi,${POLLEN_FIELDS.join(',')}` +
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
      // Diagnostic: CAMS pollen is Europe-only — outside that coverage every
      // field is null and the per-bucket totals stay null. Log the raw
      // species values + bucket totals so it's obvious from devtools whether
      // the API actually returned anything for this location.
      console.log('[WeatherDaddy] pollen current:', {
        raw: POLLEN_FIELDS.reduce((o, k) => (o[k] = cur[k], o), {}),
        treePollen, grassPollen, weedPollen,
      });
      const hasPollen = POLLEN_FIELDS.some(k => cur[k] != null);
      const pollen = hasPollen
        ? POLLEN_FIELDS.reduce((s, k) => s + (typeof cur[k] === 'number' ? cur[k] : 0), 0)
        : null;
      return { aqi, pollen, treePollen, grassPollen, weedPollen };
    } catch (_) {
      return empty;
    }
  }
};
