const Storage = {
  // One-time sweep of abandoned versioned keys from previous releases.
  // We bump suffixes like `cities_cache_v4` and `a2hs_dismissed_v1`
  // whenever the underlying schema changes; the old keys aren't read
  // by the new code but they'd otherwise sit in localStorage forever
  // (cities_cache_v3 alone is ~MB of stale GeoNames data).
  //
  // Idempotent — safe to call on every page load. We don't track a
  // "last cleaned" flag because the sweep is O(n) over localStorage
  // keys (~10 entries in practice) and the cost is negligible.
  CURRENT_CITIES_KEY: 'cities_cache_v4',
  CURRENT_A2HS_KEY:   'a2hs_dismissed_v1',
  cleanupStaleKeys() {
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        // Versioned key families: keep ONLY the current suffix for each.
        if (k.startsWith('cities_cache_v') && k !== this.CURRENT_CITIES_KEY) toRemove.push(k);
        if (k.startsWith('a2hs_dismissed_v') && k !== this.CURRENT_A2HS_KEY) toRemove.push(k);
      }
      toRemove.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) { /* localStorage unavailable — nothing to clean */ }

    // Also dedupe the saved-locations list: users who ran the app
    // before the tolerance widening + name-match landed may already
    // have duplicate entries (same city stored twice with slightly
    // different coords). Run the current isDuplicate() over the
    // stored list, keeping the FIRST occurrence of each place.
    try {
      const list = this._read('weather_list', []);
      if (Array.isArray(list) && list.length > 1) {
        const deduped = [];
        for (const item of list) {
          if (!item || typeof item.lat !== 'number' || typeof item.lon !== 'number') continue;
          if (this.isDuplicate(deduped, item.lat, item.lon, item.name)) continue;
          deduped.push(item);
        }
        if (deduped.length !== list.length) {
          localStorage.setItem('weather_list', JSON.stringify(deduped));
        }
      }
    } catch (_) { /* leave the list alone if anything goes wrong */ }
  },

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
  // ~0.005° ≈ 500 m — loose enough to absorb the coordinate drift you
  // see when OWM's /weather rounds a geocoder point to its own nearest
  // known city center (previously 0.001° = 100 m, which was too tight
  // and let the same city get saved twice with slightly different
  // coords, and made the header star flicker between "saved" and
  // "unsaved" for the same place).
  SAME_LOCATION_DEG: 0.005,

  // Normalise a display name for equality checks. Trims whitespace and
  // lowercases so "Paris, FR" and " paris, fr " collapse to one.
  _normName(name) {
    return (name || '').trim().toLowerCase();
  },

  // True when the list already contains an entry considered "the same
  // place." Match is (coords within SAME_LOCATION_DEG) OR (exact
  // display-name match once normalised). The name fallback catches
  // cases where the geocoder-side and /weather-side coords drift by
  // more than the tolerance but the user is looking at what's clearly
  // the same city ("Springfield, IL" saved twice with different
  // rounding on the same actual town). Different cities with the same
  // bare name (Springfield, IL vs Springfield, MO) never collide
  // because their display names include the state.
  isDuplicate(list, lat, lon, name) {
    return this.findIndexByCoords(list, lat, lon, name) !== -1;
  },
  // Index of the saved entry at (lat, lon) or with a matching display
  // name, or -1 if none. When `name` is omitted we fall back to
  // coordinates-only (used by callers that only have a lat/lon in hand,
  // e.g. cycleCity comparing Storage.getLocation() against the list).
  findIndexByCoords(list, lat, lon, name) {
    const nameKey = name != null ? this._normName(name) : null;
    return list.findIndex(item => {
      let lonDiff = Math.abs(item.lon - lon);
      if (lonDiff > 180) lonDiff = 360 - lonDiff;
      const coordMatch =
        Math.abs(item.lat - lat) < this.SAME_LOCATION_DEG &&
        lonDiff < this.SAME_LOCATION_DEG;
      if (coordMatch) return true;
      if (nameKey && this._normName(item.name) === nameKey) return true;
      return false;
    });
  },
  addSavedList(lat, lon, name) {
    let list = this.getSavedList();
    if (!this.isDuplicate(list, lat, lon, name)) {
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

  // Drop a single city's cached payload — call when the user removes
  // that city from their saved list so its weather data doesn't linger
  // in localStorage until LRU eventually evicts it.
  removeWeatherCache(lat, lon) {
    const all = this._read(this._CACHE_KEY, {});
    const key = this._cacheKey(lat, lon);
    if (key in all) {
      delete all[key];
      try { localStorage.setItem(this._CACHE_KEY, JSON.stringify(all)); } catch (_) {}
    }
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
