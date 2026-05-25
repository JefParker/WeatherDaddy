const App = {
  state: {
    currentWeather: null,
    forecast: null,
    cityName: '',
    selectedDayIndex: -1, // -1 means today, 0-6 means forecast days
    // Unix-seconds dt of a specific hourly tile the user has tapped, so the
    // hero displays that exact 3-hour slot's data instead of the day's
    // headline. null = no hour pinned (hero shows current weather for today
    // or notable-slot for forecast days, as before).
    selectedHourDt: null
  },

  async init() {
    UI.init((setting, value) => this.handleUnitChange(setting, value));
    this.initAutocomplete();
    this._bindByokChangeListener();

    UI.cityInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleSearch();
    });

    if (UI.searchBtn) {
      UI.searchBtn.addEventListener('click', () => this.handleSearch());
    }

    UI.locationBtn.addEventListener('click', () => this.handleLocation());

    UI.locationName.addEventListener('click', () => {
      UI.toggleScreen('main-menu', false);
      UI.toggleScreen('locations', true);
    });

    if (UI.refreshBtn) {
      UI.refreshBtn.addEventListener('click', () => {
        UI.refreshBtn.classList.add('spinning');
        this.refreshCurrentWeather().finally(() => {
          setTimeout(() => UI.refreshBtn.classList.remove('spinning'), 400);
        });
      });
    }

    // Bind the swipe-to-cycle-cities handler before fetching weather so it's
    // active during the initial network wait, not only after data arrives.
    UI.bindCitySwipe((direction) => this.cycleCity(direction));

    // Load initial data — returns the user's geolocation/country (if granted)
    // so the first-launch seed can pick cities near them instead of the
    // generic world top-10.
    const userGeo = await this.loadInitialWeather();

    // Seed default cities on first-ever load
    await this.seedDefaultCities(userGeo);
    
    // Initial render of saved locations list
    this.updateSavedLocations();

    // Pre-warm the cities adjacent to wherever we just landed so the very
    // first swipe in either direction shows fresh data.
    this._prefetchNeighborsOfCurrent();

    // Auto-refresh weather every 60 minutes
    this.startAutoRefresh();

    // Show iOS Add-to-Home-Screen prompt if appropriate.
    this.maybeShowA2HSPrompt();

    // Register Service Worker
    this.registerServiceWorker();
  },

  // iOS Safari has no native install prompt API — we have to coach the user
  // through the Share → Add to Home Screen flow ourselves. Show a one-time
  // dismissable card to do that, only when:
  //   - the browser is iOS / iPadOS Safari, AND
  //   - the app isn't already running in standalone mode, AND
  //   - the user hasn't dismissed the prompt before
  maybeShowA2HSPrompt() {
    const ua = navigator.userAgent || '';
    const isIOS = (/iPad|iPhone|iPod/.test(ua) ||
                   (ua.includes('Mac') && navigator.maxTouchPoints > 1)) // iPadOS 13+
                  && !window.MSStream;
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    const DISMISS_KEY = 'a2hs_dismissed_v1';

    if (!isIOS || isStandalone) return;
    if (localStorage.getItem(DISMISS_KEY)) return;

    const prompt = document.getElementById('a2hs-prompt');
    const closeBtn = document.getElementById('a2hs-close');
    if (!prompt || !closeBtn) return;

    // Delay a moment so it doesn't pop in during the first paint.
    setTimeout(() => prompt.classList.add('visible'), 1200);

    closeBtn.addEventListener('click', () => {
      prompt.classList.remove('visible');
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) {}
    });
  },

  // Move to the next or previous city in the user's saved list, wrapping
  // around the ends. If the currently-displayed city isn't on the list,
  // 'next' starts at the first saved city, 'prev' at the last.
  // The transition between cities plays as a 3D cube rotation.
  async cycleCity(direction) {
    const list = Storage.getSavedList();
    if (!list || list.length === 0) return;
    if (list.length === 1) return; // nothing to cycle to
    if (this._cycling) return;     // ignore rapid repeat swipes mid-animation

    const currentLoc = Storage.getLocation();
    const currentIdx = currentLoc
      ? Storage.findIndexByCoords(list, currentLoc.lat, currentLoc.lon)
      : -1;

    let nextIdx;
    if (currentIdx === -1) {
      nextIdx = direction === 'next' ? 0 : list.length - 1;
    } else {
      nextIdx = direction === 'next'
        ? (currentIdx + 1) % list.length
        : (currentIdx - 1 + list.length) % list.length;
    }

    const next = list[nextIdx];

    this._cycling = true;
    try {
      // Snapshot the outgoing dashboard before we re-render.
      const oldClone = UI.weatherView.cloneNode(true);

      // Bump the fetch token so any in-flight request from a previous swipe
      // is invalidated, and apply the new city's CACHE synchronously so the
      // cube animation starts immediately — no waiting on the network.
      this._fetchToken = (this._fetchToken || 0) + 1;
      const token = this._fetchToken;
      const hadCache = this._applyCachedCity(next.lat, next.lon, next.name);
      if (!hadCache) UI.showLoading();

      // Kick off the adjacent-city prefetch IMMEDIATELY — in parallel with
      // the cube animation and the current-city refresh. This way the next
      // and previous saved cities are getting fresh data the moment the
      // user lands on this one, instead of having to wait until the current
      // city's refresh completes. Crucial when the user swipes rapidly.
      this._prefetchAdjacentCities(nextIdx);

      await UI.runCubeTransition(oldClone, direction);

      // Now that the user has landed on the new city visually, refresh from
      // the network in the background. If there was no cache, this still
      // populates the (loader-showing) dashboard with real data when ready.
      this._refreshCity(next.lat, next.lon, next.name, token, hadCache);
    } finally {
      this._cycling = false;
    }
  },

  // Find the currently-displayed city in the saved list and prefetch its
  // neighbors. Used at app init so the first swipe is fast.
  _prefetchNeighborsOfCurrent() {
    const list = Storage.getSavedList();
    const currentLoc = Storage.getLocation();
    if (!list || list.length < 2 || !currentLoc) return;
    const idx = Storage.findIndexByCoords(list, currentLoc.lat, currentLoc.lon);
    if (idx === -1) {
      // Current city isn't in the saved list — just pre-warm the first
      // and last so swipes in either direction are ready.
      this._prefetchCity(list[0].lat, list[0].lon, list[0].name);
      const last = list[list.length - 1];
      this._prefetchCity(last.lat, last.lon, last.name);
      return;
    }
    this._prefetchAdjacentCities(idx);
  },

  // Silently fetch the cities immediately before and after `currentIdx` in
  // the saved list and write them to the weather cache. Always refreshes
  // (no cache-age gate) so an adjacent city visited days ago still gets
  // current data before the user lands on it. Best-effort — failures are
  // swallowed and concurrent calls for the same city are coalesced.
  _prefetchAdjacentCities(currentIdx) {
    const list = Storage.getSavedList();
    if (!list || list.length < 2) return;

    const seen = new Set();
    const candidates = [
      (currentIdx + 1) % list.length,
      (currentIdx - 1 + list.length) % list.length
    ];

    for (const idx of candidates) {
      if (idx === currentIdx) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);

      const city = list[idx];
      this._prefetchCity(city.lat, city.lon, city.name);
    }
  },

  // Fetch a city's weather and store it in the cache without touching the
  // current dashboard state. Used to pre-warm adjacent saved cities.
  // Coalesces concurrent calls for the same lat/lon so rapid swipes don't
  // fire duplicate network requests.
  async _prefetchCity(lat, lon, name) {
    if (!this._prefetchInFlight) this._prefetchInFlight = new Map();
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (this._prefetchInFlight.has(key)) return this._prefetchInFlight.get(key);

    const promise = (async () => {
      try {
        const [currentWeather, forecast, enrichment, airQuality, alerts] = await Promise.all([
          WeatherAPI.getCurrentWeather(lat, lon),
          WeatherAPI.getForecast(lat, lon),
          WeatherAPI.getEnrichment(lat, lon).catch(() => ({ uv: { current: null, daily: [] }, hourly: [], daily: [] })),
          WeatherAPI.getAirQuality(lat, lon).catch(() => ({ aqi: null, pollen: null, treePollen: null, grassPollen: null, weedPollen: null })),
          WeatherAPI.getAlerts(lat, lon).catch(() => [])
        ]);
        Storage.setWeatherCache(lat, lon, {
          currentWeather,
          forecast,
          uv: enrichment.uv,
          omHourly: enrichment.hourly,
          omDaily: enrichment.daily,
          airQuality,
          alerts,
          cityName: name || currentWeather.name
        });
      } catch (_) {
        // Best-effort; pre-warming a city is not user-visible.
      } finally {
        this._prefetchInFlight.delete(key);
      }
    })();

    this._prefetchInFlight.set(key, promise);
    return promise;
  },

  startAutoRefresh() {
    const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

    // Periodic refresh while the tab is open
    setInterval(() => this.refreshCurrentWeather(), INTERVAL_MS);

    // Also refresh when the user returns to the tab after being away ≥15 min
    let hiddenAt = null;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt !== null && Date.now() - hiddenAt >= INTERVAL_MS) {
        this.refreshCurrentWeather();
      }
    });
  },

  async refreshCurrentWeather() {
    const loc = Storage.getLocation();
    if (!loc) return;
    try {
      await this.fetchAndDisplay(loc.lat, loc.lon, loc.name);
    } catch (e) {
      console.warn('Auto-refresh failed:', e);
    }
  },

  initAutocomplete() {
    const input   = UI.cityInput;
    const list    = document.getElementById('city-autocomplete');
    const spinner = document.getElementById('city-load-spinner');
    let CITIES    = null;
    let activeIdx = -1;
    let debounceTimer = null;

    const close = () => { list.innerHTML = ''; activeIdx = -1; };

    const highlight = (text, query) => {
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return text;
      return text.slice(0, idx) + '<strong>' + text.slice(idx, idx + query.length) + '</strong>' + text.slice(idx + query.length);
    };

    const render = (matches, query) => {
      list.innerHTML = '';
      activeIdx = -1;
      matches.forEach(city => {
        const li = document.createElement('li');
        li.innerHTML = highlight(city, query);
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = city.split(',')[0].trim();
          close();
          this.handleSearchByLabel(city);
        });
        list.appendChild(li);
      });
    };

    // Promise that resolves once CITIES is populated (either from the
    // localStorage cache or the freshly-loaded script). seedDefaultCities()
    // awaits this so a first-ever launch can pick country-local cities
    // instead of racing against the dynamic <script> tag below.
    this._citiesReady = new Promise((resolve) => { this._resolveCitiesReady = resolve; });

    const onCitiesReady = () => {
      spinner.classList.remove('visible');
      input.disabled = false;
      input.placeholder = 'Search for a city or landmark...';
      input.focus(); // ready to type immediately
      if (this._resolveCitiesReady) { this._resolveCitiesReady(); this._resolveCitiesReady = null; }
    };

    // --- Load cities: localStorage cache first, then dynamic script tag ---
    // Using a <script> tag (not fetch) so it works on file://, http://, and offline.
    const CACHE_KEY = 'cities_cache_v4'; // bump when cities.js grows/changes
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        this._cities = JSON.parse(cached);
        CITIES = this._cities;
        onCitiesReady();
      } catch (e) {
        // Corrupt cache — remove it and fall through to script load
        localStorage.removeItem(CACHE_KEY);
      }
    }

    if (!CITIES) {
      spinner.classList.add('visible');
      const script = document.createElement('script');
      script.src = 'js/cities.js?v=3';
      script.async = true;
      script.onload = () => {
        // cities.js sets the global window.CITIES array
        CITIES = window.CITIES;
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(CITIES)); } catch(e) { /* quota */ }
        onCitiesReady();
      };
      script.onerror = () => {
        spinner.classList.remove('visible');
        input.placeholder = 'Search for a city...';
        input.disabled = false;
        // Resolve anyway so seedDefaultCities() doesn't hang — it'll just
        // fall through to the world-top-10 fallback.
        if (this._resolveCitiesReady) { this._resolveCitiesReady(); this._resolveCitiesReady = null; }
      };
      document.head.appendChild(script);
    }

    // --- Input events (only fire when CITIES is ready) ---
    input.addEventListener('input', () => {
      if (!CITIES) return;
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      debounceTimer = setTimeout(() => {
        const ql = q.toLowerCase();
        const sw = [], co = [];
        for (const c of CITIES) {
          const cl = c.toLowerCase();
          if (cl.startsWith(ql)) sw.push(c);
          else if (cl.includes(ql)) co.push(c);
          if (sw.length + co.length >= 8) break;
        }
        const matches = [...sw, ...co].slice(0, 8);
        matches.length ? render(matches, q) : close();
      }, 120);
    });

    input.addEventListener('keydown', (e) => {
      const items = list.querySelectorAll('li');
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[activeIdx]?.classList.remove('ac-active');
        activeIdx = (activeIdx + 1) % items.length;
        items[activeIdx].classList.add('ac-active');
        input.value = items[activeIdx].textContent;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[activeIdx]?.classList.remove('ac-active');
        activeIdx = (activeIdx - 1 + items.length) % items.length;
        items[activeIdx].classList.add('ac-active');
        input.value = items[activeIdx].textContent;
      } else if (e.key === 'Escape') {
        close();
      }
    });

    document.addEventListener('click', (e) => {
      if (!input.contains(e.target) && !list.contains(e.target)) close();
    });
  },

  handleUnitChange(setting, value) {
    const units = Storage.getUnits();
    units[setting] = value;
    Storage.saveUnits(units);
    this.renderAll();
  },

  // Builds "City, State" or "City, Country" for display in the header
  buildLocationName(name, state, country) {
    if (state)   return `${name}, ${state}`;
    if (country) return `${name}, ${country}`;
    return name;
  },

  async loadInitialWeather() {
    const saved = Storage.getLocation();
    if (saved) {
      await this.fetchAndDisplay(saved.lat, saved.lon, saved.name);
      return null; // no fresh geolocation hint for seeding
    }
    try {
      const coords = await LocationService.getCurrentPosition();
      let name = 'Current Location';
      let country = '';
      try {
        const geo = await WeatherAPI.reverseGeocode(coords.lat, coords.lon);
        if (geo) {
          name = this.buildLocationName(geo.name, geo.state, geo.country);
          country = (geo.country || '').toUpperCase();
        }
      } catch (_) {}
      await this.fetchAndDisplay(coords.lat, coords.lon, name);
      return { lat: coords.lat, lon: coords.lon, country };
    } catch (e) {
      console.log('Geolocation not available/allowed, falling back to London');
      try {
        const fallback = await WeatherAPI.getCoordinatesByCity('London');
        const name = this.buildLocationName(fallback.name, fallback.state, fallback.country);
        await this.fetchAndDisplay(fallback.lat, fallback.lon, name);
      } catch (err) {
        UI.showError('Failed to load fallback city.');
      }
      return null;
    }
  },

  async handleSearch() {
    const city = UI.cityInput.value.trim();
    if (!city) return;
    UI.showLoading();
    try {
      const coords = await WeatherAPI.getCoordinatesByCity(city);
      const name = this.buildLocationName(coords.name, coords.state, coords.country);
      await this.fetchAndDisplay(coords.lat, coords.lon, name);
      UI.cityInput.value = '';
      // Cube-flip the locations overlay away so it matches the
      // dual-cube (landscape) / single-cube (portrait) animation that
      // the < Back button uses. Dashboard already rendered above, so
      // the cube's back face captures the NEW city, not the old.
      UI.closeOverlayWithCube('locations-screen');
    } catch (e) {
      UI.showError('Could not find that location. Please try again.');
    }
  },

  // Called when selecting an autocomplete suggestion (e.g. "Columbus, OH, US").
  // Uses the full label for accurate geocoding; builds "City, State" for display.
  async handleSearchByLabel(label) {
    UI.showLoading();
    const parts = label.split(',').map(s => s.trim());
    const query = parts.join(','); // OWM accepts "City,StateCode,CountryCode"
    try {
      const coords = await WeatherAPI.getCoordinatesByCity(query);
      const name = this.buildLocationName(coords.name, coords.state, coords.country);
      await this.fetchAndDisplay(coords.lat, coords.lon, name);
      UI.cityInput.value = '';
      UI.closeOverlayWithCube('locations-screen');
    } catch (e) {
      UI.showError('Could not find that location. Please try again.');
    }
  },

  async handleLocation() {
    UI.showLoading();
    try {
      const coords = await LocationService.getCurrentPosition();
      let name = 'Current Location';
      try {
        const geo = await WeatherAPI.reverseGeocode(coords.lat, coords.lon);
        if (geo) name = this.buildLocationName(geo.name, geo.state, geo.country);
      } catch (_) {}
      await this.fetchAndDisplay(coords.lat, coords.lon, name);
      UI.closeOverlayWithCube('locations-screen');
    } catch (e) {
      UI.showError('Could not get current location.');
    }
  },

  // Cache-then-network: if we have a recent cached payload for this lat/lon,
  // render it immediately so navigation feels instant. Then fetch fresh data
  // in the background and re-render. A monotonically-increasing fetch token
  // guards against the user switching cities mid-flight (older response loses).
  async fetchAndDisplay(lat, lon, name) {
    this._fetchToken = (this._fetchToken || 0) + 1;
    const token = this._fetchToken;

    const renderedFromCache = this._applyCachedCity(lat, lon, name);
    if (!renderedFromCache) UI.showLoading();

    await this._refreshCity(lat, lon, name, token, renderedFromCache);
  },

  // Synchronously apply a cached city to state + render, IF the cache is
  // fresh enough to be useful. Returns true on success.
  _applyCachedCity(lat, lon, name) {
    const cached = Storage.getWeatherCache(lat, lon);
    if (!cached) return false;

    const cityName = name || cached.cityName;
    Storage.saveLocation(lat, lon, cityName);

    this.state.currentWeather   = cached.currentWeather;
    this.state.forecast         = cached.forecast;
    this.state.uv               = cached.uv;
    this.state.omHourly         = cached.omHourly || cached.hourlyPrecip || [];
    this.state.omDaily          = cached.omDaily || [];
    this.state.airQuality       = cached.airQuality || { aqi: null, pollen: null, treePollen: null, grassPollen: null, weedPollen: null };
    this.state.alerts           = cached.alerts || [];
    this.state.cityName         = cityName;
    this.state.timezone         = cached.currentWeather.timezone;
    this.state.selectedDayIndex = -1;
    this.state.selectedHourDt   = null;
    this.renderAll();
    return true;
  },

  // Network fetch + apply. Race-safe via the supplied token (or a new one).
  // hadCache lets us preserve the user's day selection on background refresh.
  async _refreshCity(lat, lon, name, token = null, hadCache = false) {
    if (token == null) {
      this._fetchToken = (this._fetchToken || 0) + 1;
      token = this._fetchToken;
    }

    try {
      const [currentWeather, forecast, enrichment, airQuality, alerts] = await Promise.all([
        WeatherAPI.getCurrentWeather(lat, lon),
        WeatherAPI.getForecast(lat, lon),
        WeatherAPI.getEnrichment(lat, lon).catch(() => ({ uv: { current: null, daily: [] }, hourly: [], daily: [] })),
        WeatherAPI.getAirQuality(lat, lon).catch(() => ({ aqi: null, pollen: null, treePollen: null, grassPollen: null, weedPollen: null })),
        WeatherAPI.getAlerts(lat, lon).catch(() => [])
      ]);

      if (token !== this._fetchToken) return;

      const cityName = name || currentWeather.name;

      Storage.setWeatherCache(lat, lon, {
        currentWeather,
        forecast,
        uv: enrichment.uv,
        omHourly: enrichment.hourly,
        omDaily: enrichment.daily,
        airQuality,
        alerts,
        cityName
      });
      Storage.saveLocation(lat, lon, cityName);

      const keepDay = hadCache ? this.state.selectedDayIndex : -1;

      this.state.currentWeather   = currentWeather;
      this.state.forecast         = forecast;
      this.state.uv               = enrichment.uv;
      this.state.omHourly         = enrichment.hourly;
      this.state.omDaily          = enrichment.daily;
      this.state.airQuality       = airQuality;
      this.state.alerts           = alerts;
      this.state.cityName         = cityName;
      this.state.timezone         = currentWeather.timezone;
      this.state.selectedDayIndex = keepDay;
      // A pinned hour is tied to an exact dt that no longer exists in the
      // fresh forecast (slots roll forward), so clearing keeps the hero
      // honest after a refresh / city change.
      this.state.selectedHourDt   = null;

      this.renderAll();
    } catch (e) {
      if (token !== this._fetchToken) return;
      // BYOK: surface inactive/invalid user keys as a clear, actionable
      // message instead of the generic "Failed to load weather data."
      if (e && e.name === 'InvalidApiKeyError') {
        UI.showError(e.message);
        if (UI.refreshByokStatus) UI.refreshByokStatus();
      } else if (!hadCache) {
        // No cache for this city means fetchAndDisplay() already replaced
        // the dashboard with the loader. We MUST replace it with something
        // — either real data (success path above) or an error — otherwise
        // the user is stuck on "Loading weather data..." forever. The
        // previous condition also checked `!state.currentWeather`, which
        // skipped this branch whenever any city had loaded earlier, so a
        // failed second-city search left the loader on screen.
        UI.showError('Failed to load weather data.');
      }
      console.error(e);
    }
  },

  // Re-fetch the current city whenever the user changes their BYOK key, so
  // the dashboard updates immediately to reflect "this is now using your
  // key" (or "back to the shared service").
  _bindByokChangeListener() {
    if (this._byokBound) return;
    this._byokBound = true;
    document.addEventListener('byok:changed', () => {
      const loc = Storage.getLocation();
      if (loc) this.fetchAndDisplay(loc.lat, loc.lon, loc.name);
    });
  },

  handleDayClick(index) {
    this.state.selectedDayIndex = index;
    // Picking a day always returns the hero to "the whole day" view —
    // tapping "Today" restores "Right now", tapping any other day shows
    // that day's notable-slot headline. Any previously-pinned hour is
    // dropped.
    this.state.selectedHourDt = null;
    this.renderAll();
  },

  // User tapped a specific tile in the hourly scroller. Pin that hour
  // (hero swaps in its data + a contextual label like "This evening at
  // 8 PM") and switch the dashboard to that tile's day so the rest of
  // the UI (quick stats, daily-list highlight) stays in sync.
  handleHourClick(dt, dayIdx) {
    this.state.selectedDayIndex = dayIdx;
    this.state.selectedHourDt   = dt;
    this.renderAll();
  },

  handleSaveLocation() {
    if (!this.state.currentWeather) return;
    const { lat, lon } = this.state.currentWeather.coord;
    const name = this.state.cityName;

    const list = Storage.getSavedList();
    const idx = Storage.findIndexByCoords(list, lat, lon);
    if (idx !== -1) {
      Storage.removeSavedList(idx);
    } else {
      Storage.addSavedList(lat, lon, name);
    }
    
    this.updateSavedLocations();
    this.renderAll();
  },

  renderAll() {
    if (!this.state.currentWeather || !this.state.forecast) return;
    UI.renderDashboard(
      this.state,
      (idx) => this.handleDayClick(idx),
      () => this.handleSaveLocation(),
      (dt, dayIdx) => this.handleHourClick(dt, dayIdx)
    );
    UI.renderAlertBar(this.state.alerts || []);
  },

  // First-launch seed for the saved-locations list.
  //
  // When the user grants geolocation we pass the resolved country code in
  // via `userGeo.country` and use it to pick the 10 most-populous cities in
  // that same country from the bundled GeoNames cities15000 list (which is
  // already sorted descending by population). That gives a US user a US
  // top-10, a UK user a UK top-10, etc. — meaningfully "nearer" than the
  // world top-10.
  //
  // When geolocation is unavailable / denied, or we can't find at least
  // ~5 in-country candidates (very small countries), we fall back to (or
  // pad with) the world's biggest cities so the user still lands on a
  // fully-populated list.
  //
  // Geocoding to lat/lon goes through the existing OWM geocoder (same path
  // used by the search box), in parallel, with per-city failures ignored.
  async seedDefaultCities(userGeo) {
    if (Storage.hasSeededCities()) return;

    const TARGET = 10;
    // World's 10 largest cities by population — preserved for the no-geo
    // fallback and for padding small-country lists.
    const WORLD_TOP = [
      { name: 'Tokyo',       lat: 35.6895,  lon: 139.6917 },
      { name: 'Delhi',       lat: 28.6139,  lon: 77.2090  },
      { name: 'Shanghai',    lat: 31.2304,  lon: 121.4737 },
      { name: 'Dhaka',       lat: 23.8103,  lon: 90.4125  },
      { name: 'São Paulo',   lat: -23.5505, lon: -46.6333 },
      { name: 'Cairo',       lat: 30.0444,  lon: 31.2357  },
      { name: 'Mexico City', lat: 19.4326,  lon: -99.1332 },
      { name: 'Beijing',     lat: 39.9042,  lon: 116.4074 },
      { name: 'Mumbai',      lat: 19.0760,  lon: 72.8777  },
      { name: 'Osaka',       lat: 34.6937,  lon: 135.5023 },
    ];

    const country = (userGeo && userGeo.country) ? userGeo.country.toUpperCase() : '';
    let resolved = [];

    // Wait (briefly) for the cities dataset to load — initAutocomplete kicks
    // off either an instant cache-hit or a dynamic <script> fetch, and we
    // need the population-sorted list to pick country-local cities. Cap
    // the wait so a slow/offline first launch still proceeds with the
    // world-top-10 fallback instead of stalling here.
    if (this._citiesReady && country) {
      try {
        await Promise.race([
          this._citiesReady,
          new Promise((r) => setTimeout(r, 4000)),
        ]);
      } catch (_) {}
    }
    const cityList = this._cities || window.CITIES;

    if (country && Array.isArray(cityList)) {
      // window.CITIES entries look like "Houston, US" — filter for the
      // user's country and take the top TARGET by their existing
      // population-descending order.
      const suffix = `, ${country}`;
      const candidates = cityList
        .filter(entry => typeof entry === 'string' && entry.endsWith(suffix))
        .slice(0, TARGET);

      // Geocode in parallel. Failures (network, unknown city) get filtered
      // out — we'll pad with WORLD_TOP below if we end up short.
      const results = await Promise.all(candidates.map(async (label) => {
        try {
          const c = await WeatherAPI.getCoordinatesByCity(label);
          if (!c || c.lat == null || c.lon == null) return null;
          return {
            name: this.buildLocationName(c.name, c.state, c.country),
            lat:  c.lat,
            lon:  c.lon,
          };
        } catch (_) {
          return null;
        }
      }));
      resolved = results.filter(Boolean);
    }

    // Pad to TARGET with WORLD_TOP entries that aren't already in the list
    // (dedupe by rounded coordinate so a Tokyo from in-country doesn't get
    // duplicated by the world list's Tokyo).
    const keyOf = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
    const seen = new Set(resolved.map(keyOf));
    for (const w of WORLD_TOP) {
      if (resolved.length >= TARGET) break;
      if (seen.has(keyOf(w))) continue;
      resolved.push(w);
      seen.add(keyOf(w));
    }

    // Add in reverse so rank #1 (most-populous in country / world) ends
    // up visually at the TOP of the saved-locations list.
    for (let i = resolved.length - 1; i >= 0; i--) {
      const c = resolved[i];
      Storage.addSavedList(c.lat, c.lon, c.name);
    }

    Storage.markSeeded();
  },

  updateSavedLocations() {
    const list = Storage.getSavedList();
    UI.renderSavedLocations(
      list,
      (loc) => {
        // Render the new city FIRST so the cube's back-face clone
        // captures the new dashboard, not the old one. _applyCachedCity
        // inside fetchAndDisplay runs synchronously when the city is in
        // cache, so by the time closeOverlayWithCube clones the columns
        // they already show the destination weather. (No cache → loader,
        // which is still better than briefly snapping to the OLD city
        // at the end of the cube rotation.)
        this.fetchAndDisplay(loc.lat, loc.lon, loc.name);
        UI.closeOverlayWithCube('locations-screen');
      },
      (idx) => {
        Storage.removeSavedList(idx);
        this.updateSavedLocations();
      },
      (fromIdx, toIdx) => {
        const item = list.splice(fromIdx, 1)[0];
        list.splice(toIdx, 0, item);
        Storage.saveReorderedList(list);
        this.updateSavedLocations();
      }
    );
  },

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then(reg => {
          reg.update();
        }).catch(err => console.log('SW registration failed', err));
      });
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
