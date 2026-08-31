// Capture the browser's native install prompt as early as possible. Chrome
// / Edge / Samsung Internet fire `beforeinstallprompt` once the PWA
// installability criteria are met — often before App.init() runs — so the
// listener has to live at file scope, not inside init(). We stash the
// event and re-broadcast a custom event that App.initInstallPrompt() can
// react to whether it fires before or after init.
window.__wdDeferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();               // suppress Chrome's mini-infobar; we show our own UI
  window.__wdDeferredInstallPrompt = e;
  window.dispatchEvent(new CustomEvent('wd:installable'));
});
window.addEventListener('appinstalled', () => {
  window.__wdDeferredInstallPrompt = null;
  window.dispatchEvent(new CustomEvent('wd:installed'));
});

const App = {
  state: {
    currentWeather: null,
    forecast: null,
    cityName: '',
    // IANA zone name for the current city (from Open-Meteo enrichment),
    // or null when enrichment failed — UI.cityTz() then falls back to
    // OWM's fixed offset in state.timezone.
    tzName: null,
    selectedDayIndex: -1, // -1 means today, 0-6 means forecast days
    // Unix-seconds dt of a specific hourly tile the user has tapped, so the
    // hero displays that exact 3-hour slot's data instead of the day's
    // headline. null = no hour pinned (hero shows current weather for today
    // or notable-slot for forecast days, as before).
    selectedHourDt: null
  },

  async init() {
    // Sweep abandoned versioned localStorage keys (cities_cache_v3 from
    // older releases, etc.) before anything else touches storage.
    Storage.cleanupStaleKeys();
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

    // BEFORE the first await, deliberately — this attaches the
    // controllerchange handler. init() runs on DOMContentLoaded, while
    // index.html's inline bootstrap calls reg.update() on `load`, so
    // placing this here guarantees the handler exists before any update
    // is even requested. Where it used to sit — after
    // `await loadInitialWeather()`, a real network round trip — a worker
    // that installed, skipWaiting'd and claimed during that wait would
    // fire controllerchange into the void, and the page would sit on old
    // code for the whole session with nothing to reconcile it.
    this.registerServiceWorker();

    // Wire up PWA installation (native prompt where supported, coach card
    // elsewhere) and the "Install App" menu entries. Also before the first
    // await: loadInitialWeather() can block on the geolocation permission
    // prompt, and installability shouldn't wait on that.
    this.initInstallPrompt();

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

    // Auto-refresh weather every 15 minutes (see startAutoRefresh)
    this.startAutoRefresh();

    // (registerServiceWorker / initInstallPrompt moved above the first
    // await — see there.)

    // Handle initial hash routing for PWA shortcuts
    this.handleHashRoute();
    window.addEventListener('hashchange', () => this.handleHashRoute());
  },

  handleHashRoute() {
    const hash = window.location.hash;
    if (hash === '#locations') {
      UI.toggleScreen('main-menu', false);
      UI.toggleScreen('locations', true);
    } else if (hash === '#refresh') {
      const refreshBtn = document.getElementById('refresh-btn');
      if (refreshBtn) {
        refreshBtn.click();
      }
      history.replaceState(null, '', window.location.pathname);
    }
  },

  // ── PWA installation ──────────────────────────────────────────────
  // Two very different worlds:
  //   1. Browsers with the `beforeinstallprompt` API (Chrome, Edge, Samsung
  //      Internet, Chrome/Edge on Android, ...). We keep the deferred event
  //      and fire the real browser install dialog from our own Install
  //      button (card + menu item).
  //   2. Everything else (iOS/iPadOS — every browser, Firefox on Android,
  //      Safari on macOS, Firefox desktop). No API, so we show a coach
  //      card with the exact manual steps for that platform.
  // In both cases nothing is shown when the app is already running
  // standalone (i.e. it's installed), and a dismissed card stays hidden for
  // INSTALL_DISMISS_DAYS. The "Install App" menu item is always available
  // as a user-initiated path regardless of dismissal.
  INSTALL_DISMISS_KEY: 'install_dismissed_at',
  INSTALL_DISMISS_KEY_LEGACY: 'a2hs_dismissed_v1',
  INSTALL_DISMISS_DAYS: 30,

  isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.matchMedia('(display-mode: window-controls-overlay)').matches ||
           window.matchMedia('(display-mode: minimal-ui)').matches ||
           window.navigator.standalone === true;
  },

  // Coarse platform detection purely for choosing install instructions.
  detectInstallPlatform() {
    const ua = navigator.userAgent || '';
    const isIOS = (/iPad|iPhone|iPod/.test(ua) ||
                   (ua.includes('Mac') && navigator.maxTouchPoints > 1)) // iPadOS 13+ masquerades as Mac
                  && !window.MSStream;
    const isAndroid   = /Android/i.test(ua);
    const isFirefox   = /Firefox\//.test(ua) && !/Seamonkey/.test(ua);
    const isChromium  = /Chrome\/|Chromium\/|CriOS\//.test(ua) || /Edg\//.test(ua);
    const isMacSafari = !isIOS && /Macintosh/.test(ua) && /Safari\//.test(ua) && !isChromium && !isFirefox;
    if (isIOS) return 'ios';
    if (isAndroid && isFirefox) return 'android-firefox';
    if (isMacSafari) return 'mac-safari';
    if (isFirefox) return 'firefox-desktop';
    if (isChromium) return 'chromium';
    return 'other';
  },

  // Card copy for each platform. `html` is trusted, static markup.
  installCoachContent(platform) {
    const shareIcon = '<svg class="a2hs-share-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>';
    const dotsIcon  = '<svg class="a2hs-share-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>';
    switch (platform) {
      case 'ios':
        return { title: 'Install WeatherDaddy',
                 html: `Tap ${shareIcon} then <strong>Add to Home Screen</strong>` };
      case 'android-firefox':
        return { title: 'Install WeatherDaddy',
                 html: `Tap the ${dotsIcon} menu, then <strong>Add to Home screen</strong> (or <strong>Install</strong>)` };
      case 'mac-safari':
        return { title: 'Install WeatherDaddy',
                 html: `In Safari's <strong>File</strong> menu choose <strong>Add to Dock…</strong>` };
      case 'firefox-desktop':
        return { title: 'Install WeatherDaddy',
                 html: `Firefox desktop can't install web apps. Open this page in Chrome, Edge or Safari to install it.` };
      case 'chromium':
        // beforeinstallprompt hasn't fired (already installed elsewhere,
        // criteria not met yet, or the user recently declined).
        return { title: 'Install WeatherDaddy',
                 html: `Use the install icon in the address bar, or the browser ${dotsIcon} menu → <strong>Install WeatherDaddy</strong>` };
      default:
        return { title: 'Install WeatherDaddy',
                 html: `Open your browser's menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>` };
    }
  },

  _installDismissedRecently() {
    try {
      // Migrate the old boolean key (permanent dismissal) to a timestamp.
      if (localStorage.getItem(this.INSTALL_DISMISS_KEY_LEGACY)) {
        localStorage.removeItem(this.INSTALL_DISMISS_KEY_LEGACY);
        localStorage.setItem(this.INSTALL_DISMISS_KEY, String(Date.now()));
      }
      const at = parseInt(localStorage.getItem(this.INSTALL_DISMISS_KEY) || '0', 10);
      if (!at) return false;
      return (Date.now() - at) < this.INSTALL_DISMISS_DAYS * 24 * 60 * 60 * 1000;
    } catch (_) { return false; }
  },

  _rememberInstallDismissed() {
    try { localStorage.setItem(this.INSTALL_DISMISS_KEY, String(Date.now())); } catch (_) {}
  },

  // Show / hide the "Install App" entries in the hamburger + context menus.
  // Hidden once the app is running standalone (nothing left to install).
  _syncInstallMenuItems() {
    const show = !this.isStandalone() && !this._installedThisSession;
    ['goto-install-btn', 'ctx-install-btn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.hidden = !show;
    });
  },

  // Populate + reveal the card. mode: 'native' | 'coach'.
  _showInstallCard(mode, platform) {
    const card    = document.getElementById('a2hs-prompt');
    const title   = document.getElementById('a2hs-title');
    const body    = document.getElementById('a2hs-body');
    const install = document.getElementById('a2hs-install');
    if (!card || !title || !body || !install) return;

    if (mode === 'native') {
      title.textContent = 'Install WeatherDaddy';
      body.textContent  = 'Get the full-screen app with offline forecasts.';
      install.hidden = false;
    } else {
      const c = this.installCoachContent(platform);
      title.textContent = c.title;
      body.innerHTML    = c.html;
      install.hidden = true;
    }
    card.classList.add('visible');
  },

  _hideInstallCard() {
    const card = document.getElementById('a2hs-prompt');
    if (card) card.classList.remove('visible');
  },

  initInstallPrompt() {
    const card       = document.getElementById('a2hs-prompt');
    const closeBtn   = document.getElementById('a2hs-close');
    const installBtn = document.getElementById('a2hs-install');
    const menuBtn    = document.getElementById('goto-install-btn');
    if (!card || !closeBtn || !installBtn) return;

    this._installPlatform = this.detectInstallPlatform();
    this._syncInstallMenuItems();

    closeBtn.addEventListener('click', () => {
      this._hideInstallCard();
      this._rememberInstallDismissed();
    });
    installBtn.addEventListener('click', () => this.promptInstall());
    if (menuBtn) menuBtn.addEventListener('click', () => {
      UI.toggleScreen('main-menu', false);
      this.promptInstall();
    });

    // Native path: the deferred event may already be waiting (fired before
    // init) or may arrive later — handle both.
    const onInstallable = () => {
      if (this.isStandalone() || this._installDismissedRecently()) return;
      // Delay a moment so it doesn't pop in during the first paint.
      setTimeout(() => {
        if (window.__wdDeferredInstallPrompt && !this.isStandalone()) {
          this._showInstallCard('native');
        }
      }, 1200);
    };
    window.addEventListener('wd:installable', onInstallable);
    if (window.__wdDeferredInstallPrompt) onInstallable();

    window.addEventListener('wd:installed', () => {
      this._installedThisSession = true;
      this._hideInstallCard();
      this._syncInstallMenuItems();
      UI.showToast('WeatherDaddy installed!');
    });

    // If the display mode changes (e.g. the tab gets adopted by the
    // installed app window), re-sync.
    try {
      window.matchMedia('(display-mode: standalone)')
            .addEventListener('change', () => { this._syncInstallMenuItems(); if (this.isStandalone()) this._hideInstallCard(); });
    } catch (_) {}

    // Coach path (mobile only — desktop users get the menu item instead of
    // an unsolicited card). Only when no native API is on offer.
    const autoCoach = ['ios', 'android-firefox'].includes(this._installPlatform);
    if (autoCoach && !('onbeforeinstallprompt' in window) &&
        !this.isStandalone() && !this._installDismissedRecently()) {
      setTimeout(() => {
        if (!window.__wdDeferredInstallPrompt && !this.isStandalone()) {
          this._showInstallCard('coach', this._installPlatform);
        }
      }, 1200);
    }
  },

  // User-initiated install (Install button on the card, or the menu item).
  // Fires the real browser dialog when we have a deferred prompt; otherwise
  // shows the platform coach card (ignoring any prior dismissal, since the
  // user explicitly asked).
  async promptInstall() {
    if (this.isStandalone()) {
      UI.showToast('WeatherDaddy is already installed.');
      return;
    }
    const evt = window.__wdDeferredInstallPrompt;
    if (evt && typeof evt.prompt === 'function') {
      this._hideInstallCard();
      try {
        evt.prompt();
        const choice = await evt.userChoice;
        // The event is single-use either way; Chrome will fire a fresh
        // beforeinstallprompt later if the criteria are still met.
        window.__wdDeferredInstallPrompt = null;
        if (choice && choice.outcome === 'dismissed') {
          this._rememberInstallDismissed();
        }
        // 'accepted' → the appinstalled event handles the rest.
      } catch (e) {
        console.warn('Install prompt failed', e);
        window.__wdDeferredInstallPrompt = null;
        this._showInstallCard('coach', this._installPlatform);
      }
      return;
    }
    this._showInstallCard('coach', this._installPlatform);
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
      ? Storage.findIndexByCoords(list, currentLoc.lat, currentLoc.lon, currentLoc.name)
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
    const idx = Storage.findIndexByCoords(list, currentLoc.lat, currentLoc.lon, currentLoc.name);
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
        // No discussion on the prefetch path (three extra NWS round trips
        // per neighbour); setWeatherCache merges, so one _refreshCity
        // cached earlier survives this write.
        Storage.setWeatherCache(lat, lon, await this._fetchCityPayload(lat, lon, name));
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
      // Background refresh of the city already on screen: keep whatever
      // day / hour the user is looking at.
      await this.fetchAndDisplay(loc.lat, loc.lon, loc.name, { preserveSelection: true });
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
      // Only steal focus when the Locations screen is actually open —
      // cities usually finish loading during app init, when this input
      // sits inside a closed overlay. Focusing it then parks the user's
      // keyboard in an invisible field (stray typing + Enter would fire
      // a surprise search).
      if (UI.locationsScreen && UI.locationsScreen.classList.contains('open')) {
        input.focus(); // ready to type immediately
      }
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
      // No ?v= here, deliberately. The service worker's cacheKey() strips
      // query strings before matching (sw.js), so a busted URL resolves
      // straight back to the precached ./js/cities.js and the bump does
      // nothing — it just looks like cache-busting. Shipping a new city
      // list actually requires bumping BOTH CACHE_NAME in sw.js and
      // Storage.CURRENT_CITIES_KEY, since returning users are served from
      // the localStorage copy and never re-request this script at all.
      script.src = 'js/cities.js';
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
        // Consume the key so the document-level Escape handler doesn't
        // ALSO close the whole Locations overlay in the same press —
        // first Escape closes the dropdown, a second closes the screen.
        e.stopPropagation();
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
    const urlParams = new URLSearchParams(window.location.search);
    const latParam = urlParams.get('lat');
    const lonParam = urlParams.get('lon');
    const nameParam = urlParams.get('name');

    const dayParam = urlParams.get('day');
    const dtParam = urlParams.get('dt');
    const hourParam = urlParams.get('hour');

    // Only honour day/dt/hour params when the URL ALSO carries a valid
    // lat/lon. A bookmark like ?day=X&hour=Y with no coordinates has no
    // way to name the city those params refer to, and applying them to
    // whatever Storage.getLocation() happens to return silently pins
    // day/hour onto the wrong city (possibly in a different timezone).
    if (latParam && lonParam) {
      const lat = parseFloat(latParam);
      const lon = parseFloat(lonParam);
      if (!isNaN(lat) && !isNaN(lon)) {
        if (dayParam || dtParam || hourParam) {
          this._sharedStateToRestore = {
            day: dayParam,
            dt: dtParam ? parseInt(dtParam, 10) : null,
            hour: hourParam ? parseInt(hourParam, 10) : null
          };
        }
        const name = nameParam || 'Shared Location';
        await this.fetchAndDisplay(lat, lon, name);

        try {
          const cleanUrl = window.location.origin + window.location.pathname;
          window.history.replaceState(null, '', cleanUrl);
        } catch (e) {
          console.warn('Failed to clear URL query parameters:', e);
        }

        return null;
      }
    }

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

  // A failed lookup (geocode, geolocation, or a no-cache network fetch)
  // must not destroy the dashboard: the previous city's data is still in
  // state, so repaint it and surface the problem as a toast. Only fall
  // back to the full-screen error when there's nothing to repaint
  // (first launch, nothing loaded yet).
  _showLookupError(msg) {
    if (this.state.currentWeather && this.state.forecast) {
      this.renderAll();
      UI.showToast(msg, true);
    } else {
      UI.showError(msg);
    }
  },

  async handleSearch() {
    const city = UI.cityInput.value.trim();
    if (!city) return;
    // No showLoading() here — fetchAndDisplay swaps in cache/loader once
    // the geocode succeeds. Blanking the dashboard before then meant a
    // typo'd search destroyed the currently-displayed city.
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
      this._showLookupError('Could not find that location. Please try again.');
    }
  },

  // Called when selecting an autocomplete suggestion (e.g. "Columbus, OH, US").
  // Uses the full label for accurate geocoding; builds "City, State" for display.
  async handleSearchByLabel(label) {
    const parts = label.split(',').map(s => s.trim());
    const query = parts.join(','); // OWM accepts "City,StateCode,CountryCode"
    try {
      const coords = await WeatherAPI.getCoordinatesByCity(query);
      const name = this.buildLocationName(coords.name, coords.state, coords.country);
      await this.fetchAndDisplay(coords.lat, coords.lon, name);
      UI.cityInput.value = '';
      UI.closeOverlayWithCube('locations-screen');
    } catch (e) {
      this._showLookupError('Could not find that location. Please try again.');
    }
  },

  async handleLocation() {
    // Geolocation (permission prompt + fix) can take several seconds, so
    // show progress ON the button itself — a spinner replaces the pin
    // icon — rather than blanking the dashboard with the full-screen
    // loader (which used to destroy the current city on failure).
    const btn = UI.locationBtn;
    if (btn && btn.classList.contains('loading')) return; // already in flight
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
    }
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
      this._showLookupError('Could not get current location.');
    } finally {
      if (btn) {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    }
  },

  // Cache-then-network: if we have a recent cached payload for this lat/lon,
  // render it immediately so navigation feels instant. Then fetch fresh data
  // in the background and re-render. A monotonically-increasing fetch token
  // guards against the user switching cities mid-flight (older response loses).
  // opts.preserveSelection — see _applyCachedCity. Set by the refresh
  // paths, which re-render the city already on screen.
  async fetchAndDisplay(lat, lon, name, opts = {}) {
    this._fetchToken = (this._fetchToken || 0) + 1;
    const token = this._fetchToken;

    const preserve = opts.preserveSelection === true;
    const renderedFromCache = this._applyCachedCity(lat, lon, name, preserve);
    if (!renderedFromCache) UI.showLoading();

    // `preserve` is passed SEPARATELY from renderedFromCache. Inferring
    // it from the cache hit alone loses the intent whenever the cached
    // payload is missing or older than WEATHER_CACHE_MAX_AGE_MS — which
    // is precisely the tab-left-open-overnight case, where returning to
    // the tab would land on Today. (The loader still shows there, since
    // 6h-stale data isn't worth painting; only the selection is kept.)
    await this._refreshCity(lat, lon, name, token, renderedFromCache, preserve);
  },

  // ── One city, one payload ─────────────────────────────────────────
  // _fetchCityPayload builds it from the network, Storage.setWeatherCache
  // stores it, _applyPayload copies it into state — the same object shape
  // whether it came from a fresh fetch or from the cache. Before this the
  // three sites each spelled the ~14 fields out by hand, and a field added
  // to one but not another (discussion, on the prefetch path) silently
  // went missing.

  // Every upstream in parallel. OWM current + forecast are required;
  // everything else is best-effort and degrades to its empty value so one
  // flaky upstream can't fail the whole city.
  //   withDiscussion — the NWS Area Forecast Discussion costs three extra
  //     requests; the prefetch path skips it. When skipped the key is
  //     ABSENT (not null) so a cache merge keeps an earlier value.
  async _fetchCityPayload(lat, lon, name, { withDiscussion = false } = {}) {
    const [currentWeather, forecast, enrichment, airQuality, alerts, tides, noaaTides, discussion] = await Promise.all([
      WeatherAPI.getCurrentWeather(lat, lon),
      WeatherAPI.getForecast(lat, lon),
      WeatherAPI.getEnrichment(lat, lon).catch(() => WeatherAPI.emptyEnrichment()),
      WeatherAPI.getAirQuality(lat, lon).catch(() => WeatherAPI.emptyAirQuality()),
      WeatherAPI.getAlerts(lat, lon).catch(() => []),
      // Both, deliberately: NOAA gives accurate tide TIMES for US
      // coasts, Open-Meteo's marine call is the only source of
      // sea-surface temperature and the global tide fallback.
      WeatherAPI.getMarine(lat, lon).catch(() => null),
      WeatherAPI.getNoaaTides(lat, lon).catch(() => null),
      withDiscussion
        ? WeatherAPI.getForecastDiscussion(lat, lon).catch(() => null)
        : Promise.resolve(undefined)
    ]);
    const payload = {
      currentWeather,
      forecast,
      uv: enrichment.uv,
      omHourly: enrichment.hourly,
      omDaily: enrichment.daily,
      omMinutely: enrichment.minutely || [],
      tzName: enrichment.tzName || null,
      airQuality,
      alerts,
      tides: tides ? tides.hourly : null,
      tideCoords: tides ? { lat: tides.latitude, lon: tides.longitude } : null,
      tidePredictions: noaaTides || null,
      cityName: name || currentWeather.name
    };
    if (withDiscussion) payload.discussion = discussion || null;
    return payload;
  },

  // Copy a payload into state — everything except the selection, which
  // each caller resolves under its own rules (see _applyCachedCity and
  // _refreshCity). Tolerates cache entries from older builds.
  _applyPayload(payload) {
    const s = this.state;
    s.currentWeather   = payload.currentWeather;
    s.forecast         = payload.forecast;
    s.uv               = payload.uv;
    s.omHourly         = payload.omHourly || payload.hourlyPrecip || []; // hourlyPrecip: pre-rename cache entries
    s.omDaily          = payload.omDaily || [];
    s.omMinutely       = payload.omMinutely || [];
    s.tzName           = payload.tzName || null;
    s.airQuality       = payload.airQuality || WeatherAPI.emptyAirQuality();
    s.alerts           = payload.alerts || [];
    s.tides            = payload.tides || null;
    s.tideCoords       = payload.tideCoords || null;
    s.tidePredictions  = payload.tidePredictions || null;
    // NOAA hands us exact turning points, so skip the extrema search
    // entirely on that path — no hourly-sampling error, no quadratic
    // refinement, no phantom extrema across coverage gaps.
    s.tideExtrema      = s.tidePredictions
      ? s.tidePredictions.extrema
      : (s.tides ? WeatherAPI.findTideExtrema(s.tides) : []);
    s.discussion       = payload.discussion || null;
    s.cityName         = payload.cityName;
    s.timezone         = payload.currentWeather.timezone;
  },

  // Does a payload still contain the slot a pinned hour points at? The pin
  // may live on an OWM 3h slot OR an Open-Meteo-synthesised slot (days
  // 6-8, the top-up at the end of OWM's window, the near-term 2h tiles),
  // so both series count — checking forecast.list alone silently unpinned
  // OM hours on every refresh.
  _payloadHasHour(payload, dt) {
    if (dt == null) return false;
    return !!(
      (payload.forecast && payload.forecast.list && payload.forecast.list.some(h => h.dt === dt)) ||
      (payload.omHourly || payload.hourlyPrecip || []).some(h => h.dt === dt)
    );
  },

  // How old a cached payload can be and still be worth rendering. Past
  // this, "Right now" data is a lie and the hourly scroller is mostly
  // empty (past slots are filtered out), so we show the loader and wait
  // for the network instead.
  WEATHER_CACHE_MAX_AGE_MS: 6 * 60 * 60 * 1000, // 6 hours

  // Synchronously apply a cached city to state + render, IF the cache is
  // fresh enough to be useful. Returns true on success.
  // `preserveSelection` is set by the refresh paths — the 15-minute
  // timer, the tab-return refresh, the refresh button and the #refresh
  // route all land here via refreshCurrentWeather. They re-render the
  // city already on screen and must not move the user's feet. Every
  // other caller — city swipe, search, saved-list tap, "use current
  // location" — is deliberate navigation and resets to Today.
  //
  // It's an explicit flag rather than a "did the coords change?" test on
  // purpose: the request coords and the coords OWM echoes back routinely
  // drift by more than SAME_LOCATION_DEG when OWM snaps to a station
  // centroid (see the note in UI.buildDailyData), so a coordinate
  // comparison would silently fail for exactly those cities.
  _applyCachedCity(lat, lon, name, preserveSelection = false) {
    const cached = Storage.getWeatherCache(lat, lon);
    // A partial entry (older build, interrupted write, hand-edited
    // storage) must read as a MISS: _applyPayload dereferences
    // currentWeather.timezone, and a throw here aborts a city swipe
    // mid-animation with nothing rendered.
    if (!cached || !cached.currentWeather || !cached.forecast) return false;
    if (Date.now() - (cached.ts || 0) > this.WEATHER_CACHE_MAX_AGE_MS) return false;

    const cityName = name || cached.cityName;

    // Captured BEFORE the state swap, for the same reason _refreshCity
    // captures its oldDayKey early: getDayKey derives the day list from
    // current state, so asking after the swap would just describe the
    // incoming payload and tell us nothing. Indices -1 and 0 both mean
    // "today" and should follow a rollover, so only a real forward
    // selection is worth re-anchoring.
    const prevDayKey = (preserveSelection && this.state.selectedDayIndex > 0)
      ? this.getDayKey(this.state.selectedDayIndex)
      : null;

    Storage.saveLocation(lat, lon, cityName);
    this._applyPayload({ ...cached, cityName });

    // Resetting unconditionally here made _refreshCity's whole
    // selection-preservation path dead code: this function runs first on
    // every cache-then-network pass, so by the time _refreshCity read
    // state.selectedDayIndex it was always -1. The visible symptom was
    // that every auto-refresh snapped the dashboard back to Today and
    // dropped any pinned hour — and it happened at the renderAll() below,
    // before the network had even answered.
    if (!preserveSelection) {
      this.state.selectedDayIndex = -1;
      this.state.selectedHourDt   = null;
    } else if (prevDayKey != null) {
      // Re-anchor the day INDEX against the payload we're about to
      // render, the same way _refreshCity does. buildDailyData doesn't
      // drop past days, so a cached forecast that still contains
      // yesterday shifts every index by one — without this, a cached
      // paint that crosses local midnight highlights the wrong day for
      // the second or so until the network response lands. It can also
      // strand an index past the end of a shortened list (enrichment
      // down → days 6-8 disappear), which renderDashboard clamps
      // visually but never writes back, so the stale index springs back
      // the moment enrichment recovers.
      const idx = this._buildDailyData().findIndex(d => d.key === prevDayKey);
      this.state.selectedDayIndex = idx !== -1 ? idx : -1;
    }
    // Revalidate the pin against the payload we're about to render.
    // _refreshCity does this for the network response, but if that
    // request then fails (offline) nothing else would ever clear a pin
    // whose slot has rolled out of the forecast — leaving the hero
    // silently unpinned while Copy URL still emitted the dead dt.
    if (preserveSelection && !this._payloadHasHour(cached, this.state.selectedHourDt)) {
      this.state.selectedHourDt = null;
    }

    if (this._sharedStateToRestore) {
      this._resolveSharedDayAndHour(false);
    }

    this.renderAll();
    return true;
  },

  // Network fetch + apply. Race-safe via the supplied token (or a new one).
  //
  // hadCache — a cached payload was already rendered, so the user's
  //   selection is on screen and must be carried over. Also gates the
  //   error path, which only has to repaint when a loader is covering
  //   the dashboard.
  // preserveSelection — the caller is refreshing the city already shown
  //   (see _applyCachedCity). Independent of hadCache, because a refresh
  //   whose cache has aged out still has the selection live in state.
  async _refreshCity(lat, lon, name, token = null, hadCache = false, preserveSelection = false) {
    if (token == null) {
      this._fetchToken = (this._fetchToken || 0) + 1;
      token = this._fetchToken;
    }

    try {
      const payload = await this._fetchCityPayload(lat, lon, name, { withDiscussion: true });

      // Superseded by a newer fetch (the user navigated mid-flight).
      // Drop any pending share-link restore on the way out: it targets
      // THIS city, and leaving it set would apply a stranger's day/hour
      // pin to whichever city the user just moved to. _resolveSharedDayAndHour
      // assigns unconditionally, so even a total match failure would
      // clobber their current selection with -1/null.
      if (token !== this._fetchToken) {
        this._sharedStateToRestore = null;
        return;
      }

      Storage.setWeatherCache(lat, lon, payload);
      Storage.saveLocation(lat, lon, payload.cityName);

      // Keep the user's place when we rendered from cache (the selection
      // is still on screen) OR when the caller explicitly asked to — the
      // latter covers a refresh whose cache had already aged out, where
      // the selection lives only in state.
      const keepPlace = hadCache || preserveSelection;

      const keepDay = keepPlace ? this.state.selectedDayIndex : -1;
      // selectedDayIndex is a POSITION in the daily list, and that list is
      // rebuilt from the incoming forecast. When a background refresh
      // crosses the city's local midnight, yesterday drops off the front
      // and every index shifts down by one — so a preserved index quietly
      // starts pointing at the day AFTER the one the user chose.
      //
      // Anchor to the day's KEY (its local date) before the swap and
      // re-resolve the position afterwards. Indices -1 and 0 both mean
      // "today" and SHOULD follow the rollover to the new today, so
      // they're deliberately excluded.
      const oldDayKey = (keepPlace && this.state.selectedDayIndex > 0)
        ? this.getDayKey(this.state.selectedDayIndex)
        : null;
      // A pinned hour is a specific dt in the OLD forecast. When slots
      // roll forward (auto-refresh, city switch) that dt may no longer
      // be a real slot — hero would then silently unpin visually while
      // state.selectedHourDt still holds the stale dt, and Copy URL
      // would emit a dt no receiver can resolve. So we keep the pin
      // only if the incoming forecast still contains it.
      const oldHourDt = keepPlace ? this.state.selectedHourDt : null;
      const keepHour = this._payloadHasHour(payload, oldHourDt) ? oldHourDt : null;

      this._applyPayload(payload);
      this.state.selectedDayIndex = keepDay;
      this.state.selectedHourDt   = keepHour;

      // Re-anchor the selection against the REBUILT day list. Must run
      // after _applyPayload, because _buildDailyData reads from state —
      // asking before the swap would just re-derive the old list and
      // tell us nothing.
      if (oldDayKey != null || keepHour != null) {
        const dailyData = this._buildDailyData();

        if (oldDayKey != null) {
          const idx = dailyData.findIndex(d => d.key === oldDayKey);
          // Not found means the selected day rolled off into the past.
          // Today is the only sane landing spot.
          this.state.selectedDayIndex = idx !== -1 ? idx : -1;
        }

        // A surviving pin is the stronger signal: the hour knows which
        // day it belongs to, so let it override whatever index we
        // inferred. Without this the hero could describe a pinned hour
        // while the quick stats and daily-list highlight showed a
        // different day.
        if (keepHour != null) {
          const idx = dailyData.findIndex(
            d => d.hourly && d.hourly.some(h => h.dt === keepHour)
          );
          if (idx !== -1) {
            this.state.selectedDayIndex = idx;
          } else {
            // The pin validated against enrichment.hourly, which reaches
            // 24h into the PAST (past_days=1) — so a pin on last evening
            // survives a refresh that crossed midnight, and would render
            // as "Saturday at 9 PM" with yesterday's temperature while
            // the daily list highlighted Today.
            //
            // A miss alone isn't fatal: near-term 2h tiles legitimately
            // never appear on the 3h spine. Only drop the pin when its
            // whole DAY has rolled out of the list.
            const pinKey = UI.dayKey(keepHour, UI.cityTz(this.state));
            const dayIdx = dailyData.findIndex(d => d.key === pinKey);
            if (dayIdx === -1) this.state.selectedHourDt = null;
            else if (oldDayKey == null) this.state.selectedDayIndex = dayIdx;
          }
        }
      }

      if (this._sharedStateToRestore) {
        this._resolveSharedDayAndHour(true);
      }

      this.renderAll();
    } catch (e) {
      // Same reasoning as the stale-token return above — a share-link
      // restore that never got consumed must not survive to be applied
      // to a different city later.
      this._sharedStateToRestore = null;
      if (token !== this._fetchToken) return;
      // BYOK: surface inactive/invalid user keys as a clear, actionable
      // message instead of the generic "Failed to load weather data."
      if (e && e.name === 'InvalidApiKeyError') {
        UI.showError(e.message);
        if (UI.refreshByokStatus) UI.refreshByokStatus();
      } else if (!hadCache) {
        // No cache for this city means fetchAndDisplay() already replaced
        // the dashboard with the loader. We MUST replace it with something
        // — real data (success path above), the previous city's dashboard
        // + an error toast, or the full-screen error when nothing has ever
        // loaded — otherwise the user is stuck on "Loading weather
        // data..." forever. State still holds the previous city here
        // (assignment only happens on success), so _showLookupError can
        // repaint it.
        this._showLookupError('Failed to load weather data.');
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
    const idx = Storage.findIndexByCoords(list, lat, lon, name);
    if (idx !== -1) {
      const savedItem = list[idx];
      Storage.removeSavedList(idx);
      // The user explicitly unsaved this city — drop its weather cache
      // too so we're not holding stale data the user no longer wants.
      Storage.removeWeatherCache(savedItem.lat, savedItem.lon);
    } else {
      Storage.addSavedList(lat, lon, name);
    }

    this.updateSavedLocations();
    this.renderAll();
  },

  renderAll() {
    if (!this.state.currentWeather || !this.state.forecast) return;
    // A city-swipe cube is mid-flight: rendering now would detach the
    // animating faces and duplicate the dashboard when the transition
    // restores them. Park the render instead — UI._cubeDone() replays
    // it (with whatever state is current by then) once the cube lands.
    if (UI._cubeAnimating) {
      UI._deferredRender = () => this.renderAll();
      return;
    }
    UI.renderDashboard(
      this.state,
      (idx) => this.handleDayClick(idx),
      () => this.handleSaveLocation(),
      (dt, dayIdx) => this.handleHourClick(dt, dayIdx)
    );
    UI.renderAlertBar(this.state.alerts || []);
    UI.renderDiscussionBar(this.state.discussion || null);
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
        // Capture the city's coords before removal so we can drop its
        // weather-cache entry too — otherwise the stale payload sits
        // in localStorage until LRU eventually evicts it.
        const removed = list[idx];
        Storage.removeSavedList(idx);
        if (removed) Storage.removeWeatherCache(removed.lat, removed.lon);
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

  handleExportData() {
    const data = {
      locations: Storage.getSavedList(),
      currentLocation: Storage.getLocation()
    };
    
    const includeKey = UI.exportApiKeyCheckbox && UI.exportApiKeyCheckbox.checked;
    const apiKey = Storage.getCustomApiKey();
    if (includeKey && apiKey) {
      data.apiKey = apiKey;
    }
    
    if (UI.importExportTextarea) {
      UI.importExportTextarea.value = JSON.stringify(data, null, 2);
      UI.updateImportButtonState();
    }
    
    UI.setFeedback(UI.importExportFeedback, 'Data exported successfully.', 'success');
  },

  async handleImportData() {
    if (!UI.importExportTextarea) return;
    const text = UI.importExportTextarea.value.trim();
    if (!text) return;
    
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      UI.setFeedback(UI.importExportFeedback, 'Invalid JSON format.', 'error');
      return;
    }
    
    // 1. Import locations (don't lose existing, no duplicates)
    const currentList = Storage.getSavedList();
    const importedLocations = Array.isArray(data.locations) ? data.locations : [];
    let addedCount = 0;
    
    for (const loc of importedLocations) {
      if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number' && loc.name) {
        if (!Storage.isDuplicate(currentList, loc.lat, loc.lon, loc.name)) {
          currentList.push({ lat: loc.lat, lon: loc.lon, name: loc.name });
          addedCount++;
        }
      }
    }
    
    if (addedCount > 0) {
      Storage.saveReorderedList(currentList);
      this.updateSavedLocations();
    }
    
    // 2. Import API key if present
    let apiImported = false;
    if (data.apiKey && typeof data.apiKey === 'string') {
      const trimmed = data.apiKey.trim();
      if (trimmed) {
        Storage.setCustomApiKey(trimmed);
        UI.refreshByokStatus();
        const byokInput = document.getElementById('byok-input');
        if (byokInput) byokInput.value = trimmed;
        document.dispatchEvent(new CustomEvent('byok:changed', { detail: { mode: 'custom' } }));
        apiImported = true;
      }
    }
    
    // 3. Import current location if present
    let locationChanged = false;
    if (data.currentLocation && typeof data.currentLocation.lat === 'number' && typeof data.currentLocation.lon === 'number' && data.currentLocation.name) {
      Storage.saveLocation(data.currentLocation.lat, data.currentLocation.lon, data.currentLocation.name);
      locationChanged = true;
    }
    
    // 4. Update UI feedback
    let msg = `Successfully imported ${addedCount} location(s).`;
    if (apiImported) msg += ' Custom API key imported.';
    if (locationChanged) msg += ' Current location updated.';
    UI.setFeedback(UI.importExportFeedback, msg, 'success');
    
    // 5. Refresh / Re-render dashboard
    if (locationChanged) {
      this.fetchAndDisplay(data.currentLocation.lat, data.currentLocation.lon, data.currentLocation.name);
    } else {
      this.renderAll();
    }

    // 6. Clear textbox and disable import button
    UI.importExportTextarea.value = '';
    UI.updateImportButtonState();
  },

  // Canonical daily-data lives in UI.buildDailyData — one implementation
  // owns the merge rules so getDayKey (Copy-URL sender),
  // _resolveSharedDayAndHour (receiver), and renderDashboard can't
  // disagree on which days exist or their order. Mismatch used to cause
  // Copy-URL for an om-only day to silently resolve to day 0 on paste.
  _buildDailyData() {
    return UI.buildDailyData(this.state).dailyData;
  },

  getDayKey(index) {
    const dailyData = this._buildDailyData();
    if (!dailyData.length) return null;
    const targetIdx = index === -1 ? 0 : index;
    if (targetIdx >= 0 && targetIdx < dailyData.length) {
      return dailyData[targetIdx].key;
    }
    return null;
  },

  _resolveSharedDayAndHour(consume = false) {
    if (!this._sharedStateToRestore) return;
    if (!this.state.currentWeather || !this.state.forecast) return;

    const { day, dt, hour } = this._sharedStateToRestore;
    if (consume) {
      this._sharedStateToRestore = null;
    }

    const tz = UI.cityTz(this.state);
    const dailyData = this._buildDailyData();

    let resolvedDayIdx = -1;

    if (day !== null) {
      const matchedIdx = dailyData.findIndex(d => d.key === day);
      if (matchedIdx !== -1) {
        resolvedDayIdx = matchedIdx;
      } else {
        const idx = parseInt(day, 10);
        if (!isNaN(idx) && idx >= -1 && idx < dailyData.length) {
          resolvedDayIdx = idx;
        }
      }
    }

    let resolvedHourDt = null;
    const targetDay = dailyData[resolvedDayIdx === -1 ? 0 : resolvedDayIdx];

    if (targetDay && targetDay.hourly && targetDay.hourly.length > 0) {
      if (dt !== null) {
        const parsedDt = parseInt(dt, 10);
        const found = targetDay.hourly.find(h => h.dt === parsedDt);
        if (found) {
          resolvedHourDt = found.dt;
        }
      }

      if (resolvedHourDt === null && hour !== null) {
        const targetHour = parseInt(hour, 10);
        if (!isNaN(targetHour)) {
          let closestSlot = null;
          let minDiff = Infinity;

          // Distance is CIRCULAR on the 24-hour clock: |21 - 23| = 2
          // straight-line, but |0 - 23| wrapping = 1 — 0 is the nearer
          // wall-clock hour to 23. Without the min(d, 24-d) fold, a
          // hour=23 URL restored against slots {0, 21} would incorrectly
          // pick 21.
          targetDay.hourly.forEach(slot => {
            const slotHour = UI.localHour(slot.dt, tz);
            const raw = Math.abs(slotHour - targetHour);
            const diff = Math.min(raw, 24 - raw);
            if (diff < minDiff) {
              minDiff = diff;
              closestSlot = slot;
            }
          });

          if (closestSlot) {
            resolvedHourDt = closestSlot.dt;
          }
        }
      }
    }

    this.state.selectedDayIndex = resolvedDayIdx;
    this.state.selectedHourDt = resolvedHourDt;
  },

  // Build stamp for the JAVASCRIPT bundle, deliberately separate from the
  // version chip hard-coded in index.html. The two are what caught the
  // mixed-cache bug: About read v1.3.0 (fresh index.html) on a device
  // whose ui.js was still the previous build, so the version number
  // confidently described code that wasn't running. Bump this with the
  // chip in index.html on every release — a mismatch on screen IS the
  // diagnosis.
  BUILD: '1.5.0',

  // Writes "JS <build> · cache <bucket>" under the About version chip.
  // Note what happens when js/app.js is STALE: old code has no
  // renderBuildInfo, so the element keeps its "Checking build…"
  // placeholder. A stuck placeholder therefore means "the JS you're
  // running predates this feature" — the missing readout is itself the
  // signal, which is why the placeholder isn't empty.
  async renderBuildInfo() {
    const el = document.getElementById('about-build');
    if (!el) return;

    let bucket = 'none';
    try {
      // caches.keys() is readable straight from the page — no round trip
      // through the worker, which matters because a wedged worker is
      // precisely the situation being diagnosed.
      const mine = (await caches.keys()).filter(k => k.startsWith('weatherdaddy-'));
      // More than one bucket means an activate cleanup hasn't finished;
      // showing all of them is more useful than picking one.
      if (mine.length) bucket = mine.join(', ');
    } catch (_) {
      bucket = 'unavailable';
    }

    const controlled = ('serviceWorker' in navigator) && !!navigator.serviceWorker.controller;
    el.textContent = `JS ${this.BUILD} · cache ${bucket}` + (controlled ? '' : ' · not cached');
  },

  registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // Was this page already under a service worker when it loaded? If not,
    // this is a first install and clients.claim() will fire controllerchange
    // for it — reloading there would bounce every new visitor once for no
    // reason. Captured synchronously, before any registration work.
    const hadController = !!navigator.serviceWorker.controller;

    // sw.js calls skipWaiting() + clients.claim(), so a new worker takes
    // over the moment it installs. But THIS page is still running the old
    // JS it booted from the old cache, and nothing here used to react to
    // the handover — so the app kept showing old code until the user
    // performed a full navigation. A desktop user reflexively hits reload;
    // an installed PWA gets restored from a frozen state and may never
    // navigate again, which is why phones appeared to be stuck on an old
    // version no amount of reopening would fix.
    // Reload-loop brake. A closure flag only dedupes within ONE page load
    // — the reload destroys it — so a rollout serving mixed sw.js versions
    // across edge nodes could otherwise flip a client back and forth
    // forever. sessionStorage survives the reload without outliving the tab.
    const RELOAD_STAMP = 'sw_reloaded_at';
    const recentlyReloaded = () => {
      try {
        const delta = Date.now() - parseInt(sessionStorage.getItem(RELOAD_STAMP) || '0', 10);
        // delta < 0 means the clock stepped BACKWARD since we stamped (NTP
        // correction, manual change). Without the lower bound that reads as
        // "just reloaded" and suppresses every update for the rest of the
        // tab's life. A garbage value parses to NaN and fails both
        // comparisons, which correctly fails open.
        return delta >= 0 && delta < 60000;
      } catch (_) { return false; }
    };

    let reloading = false;
    let deferred = false;
    const doReload = () => {
      if (reloading) return;
      reloading = true;
      try { sessionStorage.setItem(RELOAD_STAMP, String(Date.now())); } catch (_) {}
      window.location.reload();
    };

    // A tab that is never backgrounded would otherwise sit on old code
    // forever: document.hidden only goes true when the tab is backgrounded
    // or the window minimised, so alt-tabbing away from a desktop window
    // doesn't count. Fall back to reloading after a stretch of no input,
    // which is the other moment nobody is mid-thought.
    const IDLE_MS = 5 * 60 * 1000;
    let idleTimer = null;
    const armIdleReload = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(doReload, IDLE_MS);
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || deferred || recentlyReloaded()) return;
      deferred = true;

      // Never yank the page out from under someone mid-look. The selected
      // day, pinned hour, open overlay, scroll position and a typed-but-
      // unsaved API key all live only in memory, so reloading while the
      // app is on screen would silently throw them away — and the update
      // check runs on foreground, i.e. exactly when the user has just
      // come back to look at something. Swap versions while hidden.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { doReload(); return; }
        // Visible again means the reload never actually committed — iOS
        // can suspend a backgrounded PWA before the navigation lands.
        // Unlatch so the next background retries, rather than pinning
        // this document to old code for the rest of its life.
        reloading = false;
        armIdleReload();
      });

      // mousemove/touchmove matter as much as clicks here: someone can
      // read the dashboard for five minutes without ever clicking,
      // typing or scrolling, and reloading them mid-read would discard
      // the very state the hidden-only path exists to protect.
      ['pointerdown', 'keydown', 'scroll', 'mousemove', 'touchmove'].forEach(ev =>
        window.addEventListener(ev, armIdleReload, { passive: true })
      );
      armIdleReload();

      if (document.hidden) doReload();
    });

    // index.html carries an inline bootstrap that already owns
    // registration and update polling. It runs first and can't be stale,
    // so defer to it — otherwise we'd stack a second visibilitychange
    // listener and a second hourly interval doing identical work. The
    // controllerchange handler above still applies either way; that's the
    // part app.js uniquely contributes.
    if (window.__swBootstrapped) return;

    const start = () => {
      navigator.serviceWorker.register('./sw.js').then(reg => {
        reg.update().catch(() => {});

        // An installed PWA can stay open for days without a single fresh
        // navigation, so without these it would never even ASK whether a
        // new version exists. Checking on foreground is what makes a
        // deploy show up promptly.
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) reg.update().catch(() => {});
        });
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      }).catch(err => console.log('SW registration failed', err));
    };

    // The readyState check is why deploys now reach installed clients.
    // This used to be a bare `load` listener, and registerServiceWorker
    // used to run AFTER `await loadInitialWeather()` — a real network
    // round trip. On a returning visit every subresource comes out of the
    // SW precache in milliseconds, so `load` had long since fired by the
    // time this line was reached, and a listener added to an event that
    // already fired never runs. register() and reg.update() were simply
    // never called; the SW kept working only because registrations persist
    // across sessions, and it never once checked for a new version. The
    // call has since moved above init()'s first await, but keep the
    // readyState branch: this path still runs when index.html is old
    // enough to lack the inline bootstrap.
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
  }
};

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
