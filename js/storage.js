const Storage = {
  _read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      localStorage.removeItem(key);
      return fallback;
    }
  },

  saveLocation(lat, lon, name) {
    localStorage.setItem('weather_loc', JSON.stringify({ lat, lon, name }));
  },

  // BYOK: user's own OpenWeatherMap API key. Stored verbatim in
  // localStorage under 'owm_custom_api_key'. Empty / whitespace strings
  // are treated as "no key". Reading is sync so the WeatherAPI layer can
  // pick a routing path per request without a Promise hop.
  CUSTOM_KEY_STORAGE: 'owm_custom_api_key',
  getCustomApiKey() {
    try {
      const raw = localStorage.getItem(this.CUSTOM_KEY_STORAGE);
      const trimmed = (raw || '').trim();
      return trimmed || null;
    } catch (_) {
      return null;
    }
  },
  setCustomApiKey(key) {
    const trimmed = (key || '').trim();
    if (!trimmed) return false;
    try { localStorage.setItem(this.CUSTOM_KEY_STORAGE, trimmed); return true; }
    catch (_) { return false; }
  },
  clearCustomApiKey() {
    try { localStorage.removeItem(this.CUSTOM_KEY_STORAGE); } catch (_) {}
  },
  getLocation() {
    return this._read('weather_loc', null);
  },
  saveUnits(units) {
    localStorage.setItem('weather_units', JSON.stringify(units));
  },
  // On first launch we don't have stored unit prefs, so we derive sensible
  // defaults from the browser locale (US gets °F / mph / inHg / in / mi /
  // 12-hour; UK gets °C / mph / hPa / mm / mi / 24-hour; most of the rest
  // of the world gets full metric / 24-hour) and persist them immediately
  // so subsequent reads — including the next page load — return the same
  // values and the Units screen reflects them. After that, any change the
  // user makes through saveUnits() overrides these defaults permanently.
  getUnits() {
    const stored = this._read('weather_units', null);
    if (stored) return stored;
    const defaults = this._localeUnitDefaults();
    try { localStorage.setItem('weather_units', JSON.stringify(defaults)); } catch (_) {}
    return defaults;
  },
  _localeUnitDefaults() {
    // Pull the region (ISO 3166-1 alpha-2) out of the browser locale tag.
    // Intl.Locale handles tags like "en-US", "en-Latn-US", and (where the
    // browser supplies it) bare "en" via maximize().
    let region = '';
    let hourCycle = '';
    try {
      const tag = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
      const loc = (typeof Intl !== 'undefined' && Intl.Locale) ? new Intl.Locale(tag) : null;
      if (loc) {
        const max = (typeof loc.maximize === 'function') ? loc.maximize() : loc;
        region = (max.region || loc.region || '').toUpperCase();
        hourCycle = max.hourCycle || loc.hourCycle || '';
      }
      // Fallback: parse "xx-YY" by hand if Intl.Locale isn't available.
      if (!region) {
        const parts = tag.split('-');
        const last = parts[parts.length - 1];
        if (last && last.length === 2) region = last.toUpperCase();
      }
      // hourCycle can also be discovered from a DateTimeFormat with
      // hour:'numeric' (browsers fill .resolvedOptions().hourCycle in).
      if (!hourCycle && typeof Intl !== 'undefined') {
        const opts = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions();
        hourCycle = opts.hourCycle || '';
      }
    } catch (_) { /* fall through with empty region/hourCycle */ }

    // Country buckets (small enough to inline; not every imperial-ish edge
    // case is listed — Liberia/Myanmar still default to metric here,
    // matching what most weather apps do).
    const isUS         = region === 'US';
    const milesCountry = isUS || region === 'GB' || region === 'LR' || region === 'MM';
    const mphCountry   = isUS || region === 'GB';

    return {
      temp:     isUS ? 'F'    : 'C',
      wind:     mphCountry ? 'mph' : 'kmh',
      pressure: isUS ? 'inhg' : 'hpa',
      precip:   isUS ? 'in'   : 'mm',
      dist:     milesCountry ? 'mi' : 'km',
      time:     (hourCycle === 'h11' || hourCycle === 'h12') ? '12h' : '24h',
    };
  },
  getSavedList() {
    const list = this._read('weather_list', []);
    return Array.isArray(list) ? list : [];
  },

  // How close two locations must be to be considered the same place.
  // ~0.001° ≈ 100 m — tight enough that a landmark inside a saved city
  // (e.g. Hollywood Bowl inside Los Angeles) is its own distinct entry,
  // loose enough to dedupe minor geocoder rounding differences.
  SAME_LOCATION_DEG: 0.001,

  // True when any saved entry is within SAME_LOCATION_DEG of (lat, lon).
  // Name-only matching collides across the world (e.g. Springfield, IL vs MA),
  // so we compare coordinates only.
  isDuplicate(list, lat, lon /* name no longer used */) {
    return this.findIndexByCoords(list, lat, lon) !== -1;
  },
  // Index of the saved entry at (lat, lon), or -1 if none match.
  findIndexByCoords(list, lat, lon) {
    return list.findIndex(item =>
      Math.abs(item.lat - lat) < this.SAME_LOCATION_DEG &&
      Math.abs(item.lon - lon) < this.SAME_LOCATION_DEG
    );
  },
  addSavedList(lat, lon, name) {
    let list = this.getSavedList();
    if (!this.isDuplicate(list, lat, lon)) {
      list.unshift({ lat, lon, name });
      localStorage.setItem('weather_list', JSON.stringify(list));
    }
  },
  removeSavedList(index) {
    let list = this.getSavedList();
    list.splice(index, 1);
    localStorage.setItem('weather_list', JSON.stringify(list));
  },
  saveReorderedList(list) {
    localStorage.setItem('weather_list', JSON.stringify(list));
  },
  hasSeededCities() {
    return localStorage.getItem('weather_seeded') === 'true';
  },
  markSeeded() {
    localStorage.setItem('weather_seeded', 'true');
  },

  // ---- Per-city weather cache --------------------------------------------
  // Stores recent weather payloads keyed by rounded lat/lon so revisits can
  // render instantly. LRU-capped to keep localStorage well under quota.

  _CACHE_KEY: 'weather_cache',
  _CACHE_MAX: 20,

  _cacheKey(lat, lon) {
    return `${lat.toFixed(3)},${lon.toFixed(3)}`;
  },

  getWeatherCache(lat, lon) {
    const all = this._read(this._CACHE_KEY, {});
    return all[this._cacheKey(lat, lon)] || null;
  },

  setWeatherCache(lat, lon, payload) {
    let all = this._read(this._CACHE_KEY, {});
    all[this._cacheKey(lat, lon)] = { ...payload, ts: Date.now() };

    // LRU eviction: keep the freshest _CACHE_MAX entries.
    const entries = Object.entries(all);
    if (entries.length > this._CACHE_MAX) {
      entries.sort((a, b) => b[1].ts - a[1].ts);
      all = Object.fromEntries(entries.slice(0, this._CACHE_MAX));
    }

    try {
      localStorage.setItem(this._CACHE_KEY, JSON.stringify(all));
    } catch (_) {
      // Probably quota — try again with half as many entries.
      const half = Object.entries(all)
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, Math.floor(this._CACHE_MAX / 2));
      try { localStorage.setItem(this._CACHE_KEY, JSON.stringify(Object.fromEntries(half))); } catch (__) {}
    }
  }
};
