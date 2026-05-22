const UI = {
  // Screens & Overlays
  mainMenuScreen: document.getElementById('main-menu-screen'),
  locationsScreen: document.getElementById('locations-screen'),
  unitsScreen: document.getElementById('units-screen'),
  weatherView: document.getElementById('weather-view'),
  locationName: document.getElementById('location-name'),
  saveBtnContainer: document.getElementById('save-btn-container'),
  cityInput: document.getElementById('city-input'),
  searchBtn: document.getElementById('search-btn'),
  menuBtn: document.getElementById('menu-btn'),
  refreshBtn: document.getElementById('refresh-btn'),
  mainMenuBackBtn: document.getElementById('main-menu-back-btn'),
  locationsBackBtn: document.getElementById('locations-back-btn'),
  unitsBackBtn: document.getElementById('units-back-btn'),
  gotoLocationsBtn: document.getElementById('goto-locations-btn'),
  gotoUnitsBtn: document.getElementById('goto-units-btn'),
  gotoAboutBtn: document.getElementById('goto-about-btn'),
  aboutBackBtn: document.getElementById('about-back-btn'),
  locationBtn: document.getElementById('location-btn'),
  savedLocationsList: document.getElementById('saved-locations-list'),

  _resizeBound: false,
  _lastGraph: null,
  _clockTimezone: 0,
  _clockTimer: null,

  // Keep the per-city clock in the hero subtitle ticking. The element gets
  // re-rendered whenever the dashboard renders, so the timer just looks it
  // up and updates its text every 30s.
  _ensureClockTimer() {
    if (this._clockTimer) return;
    this._clockTimer = setInterval(() => {
      const el = document.getElementById('city-clock');
      if (!el) return;
      el.textContent = this.formatTime(
        Math.floor(Date.now() / 1000),
        true,
        this._clockTimezone
      );
    }, 30000);
  },

  init(onUnitChange) {
    this.menuBtn.addEventListener('click', () => this.toggleScreen('main-menu', true));

    this.mainMenuBackBtn.addEventListener('click', () => this.toggleScreen('main-menu', false));
    this.locationsBackBtn.addEventListener('click', () => {
      this.closeOverlayWithCube('locations-screen');
    });
    this.unitsBackBtn.addEventListener('click', () => {
      this.closeOverlayWithCube('units-screen');
    });

    this.gotoLocationsBtn.addEventListener('click', () => {
      this.toggleScreen('main-menu', false);
      this.toggleScreen('locations', true);
    });
    this.gotoUnitsBtn.addEventListener('click', () => {
      this.toggleScreen('main-menu', false);
      this.toggleScreen('units', true);
    });
    if (this.gotoAboutBtn) this.gotoAboutBtn.addEventListener('click', () => {
      this.toggleScreen('main-menu', false);
      this.toggleScreen('about', true);
    });
    if (this.aboutBackBtn) this.aboutBackBtn.addEventListener('click', () => {
      this.closeOverlayWithCube('about-screen');
    });

    // Close any open overlay on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      ['alerts', 'about', 'units', 'locations', 'main-menu'].forEach(s => {
        const el = document.getElementById(s + '-screen') || document.getElementById(s);
        if (el && el.classList.contains('open')) {
          if (['about', 'units', 'locations'].includes(s)) {
             this.closeOverlayWithCube(el.id);
          } else {
             this.toggleScreen(s, false);
          }
        }
      });
    });

    document.querySelectorAll('.segmented-control button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const control = e.target.parentElement;
        const setting = control.getAttribute('data-setting');
        const value = e.target.getAttribute('data-value');

        control.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');

        if (onUnitChange) onUnitChange(setting, value);
      });
    });

    // Re-render the graph if the window resizes (or an overlay closes
    // and reveals a previously-hidden zero-width container).
    if (!this._resizeBound) {
      window.addEventListener('resize', () => {
        if (this._lastGraph) this.renderGraph(
          this._lastGraph.hourly,
          this._lastGraph.offset,
          this._lastGraph.hourlyPrecip || []
        );
      });
      this._resizeBound = true;
    }

    this.updateUnitControls();

    // BYOK (bring-your-own OpenWeatherMap key) controls live in the
    // About overlay. Bind them once at init so the status badge reflects
    // any pre-existing saved key on first paint.
    this._initByokPanel();

    // Custom right-click / long-press menu mirroring the hamburger menu.
    this._bindContextMenu();
  },

  // BYOK panel wiring. All state lives in localStorage (via Storage), so
  // this is just glue between the DOM and Storage + WeatherAPI.getKeyMode().
  // Exposes refreshByokStatus() for callers that want to re-sync after a
  // network failure tells them the key is bad.
  _initByokPanel() {
    const input    = document.getElementById('byok-input');
    const toggle   = document.getElementById('byok-toggle');
    const saveBtn  = document.getElementById('byok-save');
    const clearBtn = document.getElementById('byok-clear');
    const feedback = document.getElementById('byok-feedback');
    if (!input || !saveBtn || !clearBtn) return; // panel not in DOM

    // Populate input with the existing saved key (if any) and sync badge.
    const existing = Storage.getCustomApiKey();
    if (existing) input.value = existing;
    this.refreshByokStatus();

    // Show/hide toggle — flips the input type and swaps the eye icon.
    if (toggle) {
      toggle.addEventListener('click', () => {
        const hidden = input.type === 'password';
        input.type = hidden ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
        toggle.setAttribute('aria-label', hidden ? 'Hide API key' : 'Show API key');
        const showEye = toggle.querySelector('.byok-eye-show');
        const hideEye = toggle.querySelector('.byok-eye-hide');
        if (showEye && hideEye) {
          showEye.hidden = hidden;
          hideEye.hidden = !hidden;
        }
      });
    }

    const setFeedback = (msg, kind) => {
      if (!feedback) return;
      feedback.textContent = msg || '';
      feedback.classList.remove('is-success', 'is-error');
      if (kind === 'success') feedback.classList.add('is-success');
      if (kind === 'error')   feedback.classList.add('is-error');
    };

    saveBtn.addEventListener('click', () => {
      const value = (input.value || '').trim();
      if (!value) {
        setFeedback('Please paste your API key first.', 'error');
        input.focus();
        return;
      }
      // Light sanity check: OWM keys are 32 hex characters. We don't reject
      // mismatches outright (in case OWM changes the format), but we warn.
      const looksReasonable = /^[A-Za-z0-9]{16,}$/.test(value);
      const ok = Storage.setCustomApiKey(value);
      if (!ok) {
        setFeedback('Could not save key (localStorage unavailable).', 'error');
        return;
      }
      this.refreshByokStatus();
      setFeedback(
        looksReasonable
          ? 'Key saved. Your next request will use it. (New keys can take up to 2 hours to activate.)'
          : 'Key saved, but it doesn\'t look like a typical OWM key — double-check if you hit errors.',
        'success'
      );
      // Notify the rest of the app — App listens to retry the current city.
      document.dispatchEvent(new CustomEvent('byok:changed', { detail: { mode: 'custom' } }));
    });

    clearBtn.addEventListener('click', () => {
      Storage.clearCustomApiKey();
      input.value = '';
      // Reset masked view so a future paste starts hidden.
      if (input.type !== 'password') {
        input.type = 'password';
        if (toggle) {
          toggle.setAttribute('aria-pressed', 'false');
          toggle.setAttribute('aria-label', 'Show API key');
          const showEye = toggle.querySelector('.byok-eye-show');
          const hideEye = toggle.querySelector('.byok-eye-hide');
          if (showEye) showEye.hidden = false;
          if (hideEye) hideEye.hidden = true;
        }
      }
      this.refreshByokStatus();
      setFeedback('Custom key cleared. Falling back to the default shared service.', 'success');
      document.dispatchEvent(new CustomEvent('byok:changed', { detail: { mode: 'default' } }));
    });
  },

  // Re-read the saved key and recolor the status badge. Safe to call any
  // time; idempotent.
  refreshByokStatus() {
    const badge = document.getElementById('byok-status');
    const text  = document.getElementById('byok-status-text');
    if (!badge || !text) return;
    const mode = (typeof WeatherAPI !== 'undefined' && WeatherAPI.getKeyMode)
      ? WeatherAPI.getKeyMode()
      : (Storage.getCustomApiKey() ? 'custom' : 'default');
    badge.classList.toggle('is-custom',  mode === 'custom');
    badge.classList.toggle('is-default', mode !== 'custom');
    text.textContent = mode === 'custom'
      ? '● Status: Using Custom API Key'
      : '● Status: Using Default Shared Service';
  },

  // Mirrors the hamburger menu via right-click (desktop) and long-press
  // (touch). Suppressed on areas that already own a gesture (location
  // cards, stats pager, graph swipe, hourly scroll, overlays) and on
  // interactive elements (buttons, inputs, links) so we don't fight
  // with the user's intended interaction.
  _bindContextMenu() {
    const menu = document.getElementById('context-menu');
    if (!menu || this._contextMenuBound) return;
    this._contextMenuBound = true;

    const EXCLUDE = '.overlay-screen, .location-card, .stats-pager, ' +
                    '.quick-stats-grid, .graph-container, .hourly-scroll, ' +
                    '.alert-bar, .a2hs-prompt, button, input, a, [role="dialog"]';

    const isExcluded = (target) => target && target.closest && target.closest(EXCLUDE);

    const openAt = (clientX, clientY) => {
      // Reveal the menu off-screen to measure it, then position with
      // edge guards so it never overflows the viewport.
      menu.hidden = false;
      menu.style.left = '-9999px';
      menu.style.top  = '-9999px';
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      const PAD = 8;
      const x = Math.max(PAD, Math.min(clientX, window.innerWidth  - w - PAD));
      const y = Math.max(PAD, Math.min(clientY, window.innerHeight - h - PAD));
      menu.style.left = `${x}px`;
      menu.style.top  = `${y}px`;
      // Move focus inside for keyboard users.
      const first = menu.querySelector('.context-menu-item');
      if (first) first.focus({ preventScroll: true });
    };

    const close = () => { menu.hidden = true; };

    // --- Desktop right-click ---
    document.addEventListener('contextmenu', (e) => {
      if (isExcluded(e.target)) return;
      e.preventDefault();
      openAt(e.clientX, e.clientY);
    });

    // --- Touch long-press (500 ms) ---
    let longPressId = null;
    let touchX = 0, touchY = 0;
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) return;
      if (isExcluded(e.target)) return;
      // Don't trigger while the menu is already open — let outside-tap close it.
      if (!menu.hidden) return;
      const t = e.touches[0];
      touchX = t.clientX;
      touchY = t.clientY;
      longPressId = setTimeout(() => {
        longPressId = null;
        if (navigator.vibrate) navigator.vibrate(15);
        openAt(touchX, touchY);
      }, 500);
    }, { passive: true });
    const cancelLongPress = () => {
      if (longPressId) { clearTimeout(longPressId); longPressId = null; }
    };
    document.addEventListener('touchmove', (e) => {
      if (!longPressId) return;
      const t = e.touches[0];
      if (!t) return;
      if (Math.hypot(t.clientX - touchX, t.clientY - touchY) > 10) cancelLongPress();
    }, { passive: true });
    document.addEventListener('touchend',    cancelLongPress);
    document.addEventListener('touchcancel', cancelLongPress);

    // --- Outside-click & Escape close ---
    document.addEventListener('mousedown', (e) => {
      if (menu.hidden) return;
      if (!menu.contains(e.target)) close();
    });
    document.addEventListener('touchstart', (e) => {
      if (menu.hidden) return;
      if (!menu.contains(e.target)) close();
    }, { passive: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) close();
    });

    // --- Menu item actions (same as hamburger menu) ---
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.context-menu-item');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      close();
      if (action === 'locations') this.toggleScreen('locations', true);
      else if (action === 'units') this.toggleScreen('units', true);
      else if (action === 'about') this.toggleScreen('about', true);
    });
  },

  updateUnitControls() {
    const units = Storage.getUnits();
    Object.entries(units).forEach(([setting, value]) => {
      const control = document.querySelector(`.segmented-control[data-setting="${setting}"]`);
      if (control) {
        control.querySelectorAll('button').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-value') === value);
        });
      }
    });
  },

  toggleScreen(screen, show) {
    const map = {
      'main-menu': this.mainMenuScreen,
      'locations': this.locationsScreen,
      'units':     this.unitsScreen,
      'alerts':    document.getElementById('alerts-screen'),
      'about':     document.getElementById('about-screen')
    };
    const el = map[screen];
    if (!el) return;
    el.classList.toggle('open', !!show);
  },

  closeOverlayWithCube(overlayId) {
    const overlay = document.getElementById(overlayId);
    if (!overlay || !overlay.classList.contains('open')) return;

    // Remove focus to prevent virtual keyboard popping up during transition
    if (document.activeElement) document.activeElement.blur();

    // Hide the overlay immediately so the main app is visible underneath
    // (though our perspective wrapper will cover it)
    overlay.classList.remove('open');

    // Landscape two-column layout: animate each column on its own cube,
    // matching the city-swipe dual-cube transition. Without this branch,
    // the portrait code below renders a single 500px-wide cube anchored
    // at viewport center, which looks like an awkward floating sliver
    // in the middle of a wide landscape dashboard.
    const isTwoColumn = getComputedStyle(this.weatherView).display === 'grid';
    const leftEl  = this.weatherView.querySelector('.dashboard-left');
    const rightEl = this.weatherView.querySelector('.dashboard-right');
    if (isTwoColumn && leftEl && rightEl) {
      return this._closeOverlayWithDualCube(overlay, leftEl, rightEl);
    }

    const perspective = document.createElement('div');
    perspective.className = 'cube-perspective';
    perspective.style.position = 'fixed';
    perspective.style.top = '0';
    perspective.style.left = '50%';
    perspective.style.transform = 'translateX(-50%)';
    perspective.style.width = '100%';
    perspective.style.maxWidth = '500px';
    perspective.style.height = '100%';
    perspective.style.zIndex = '9999';

    const stage = document.createElement('div');
    stage.className = 'cube-stage';
    stage.style.width = '100%';
    stage.style.height = '100%';

    const front = document.createElement('div');
    front.className = 'cube-face cube-face-front';
    const overlayClone = overlay.cloneNode(true);
    overlayClone.style.transform = 'none'; // Ensure the clone is visible
    front.appendChild(overlayClone);

    const back = document.createElement('div');
    back.className = 'cube-face cube-face-left'; // We rotate right, so left face slides in
    
    // Clone the main app to place on the incoming face
    const headerClone = document.querySelector('.app-header').cloneNode(true);
    const mainClone = document.querySelector('.main-content').cloneNode(true);
    
    const fakeApp = document.createElement('div');
    fakeApp.className = 'app-container';
    fakeApp.style.height = '100%';
    fakeApp.style.overflow = 'hidden';
    fakeApp.style.position = 'relative';

    // Disable position sticky on the clone so it doesn't do anything weird
    headerClone.style.position = 'relative';
    headerClone.style.zIndex = '10';

    // Shift the main content up to match the scroll position
    mainClone.style.transform = `translateY(-${window.scrollY}px)`;

    fakeApp.appendChild(headerClone);
    fakeApp.appendChild(mainClone);
    back.appendChild(fakeApp);

    stage.appendChild(front);
    stage.appendChild(back);
    perspective.appendChild(stage);
    document.body.appendChild(perspective);

    return new Promise(resolve => {
      stage.offsetHeight; // Force reflow
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          stage.classList.add('rotate-right');
        });
      });

      const finish = () => {
        perspective.remove();
        resolve();
      };
      stage.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 800);
    });
  },

  // Landscape variant of closeOverlayWithCube: two fixed-position
  // perspectives stacked over the live .dashboard-left / .dashboard-right
  // wrappers, each spinning in parallel like the city-swipe dual cube.
  //
  // Front face of each cube: a full-viewport clone of the overlay, offset
  // so the slice visible through the column-shaped face shows exactly the
  // portion of the overlay that was sitting over that column. Combined,
  // the two front faces look like the unbroken overlay.
  //
  // Back face: a clone of the corresponding column wrapper, so as the
  // cubes rotate, the overlay halves spin away and the column halves of
  // the dashboard spin in.
  async _closeOverlayWithDualCube(overlay, leftEl, rightEl) {
    const leftRect  = leftEl.getBoundingClientRect();
    const rightRect = rightEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const buildSide = (rect, columnEl) => {
      const perspective = document.createElement('div');
      perspective.className = 'cube-perspective';
      perspective.style.position = 'fixed';
      perspective.style.left   = `${rect.left}px`;
      perspective.style.top    = `${rect.top}px`;
      perspective.style.width  = `${rect.width}px`;
      perspective.style.height = `${rect.height}px`;
      perspective.style.zIndex = '9999';
      // Cube depth tuned per column so each side's rotation looks correct
      // at its actual width (instead of the global 250px default that's
      // sized for the portrait 500px cube).
      perspective.style.setProperty('--cube-half', `${rect.width / 2}px`);

      const stage = document.createElement('div');
      stage.className = 'cube-stage';

      // ----- Front face: full-viewport overlay clone, clipped -----
      const front = document.createElement('div');
      front.className = 'cube-face cube-face-front';
      const overlayClone = overlay.cloneNode(true);
      // Force the clone into absolute positioning relative to the front
      // face so we can place it deterministically — bypasses any
      // position:fixed-in-transformed-ancestor quirks.
      overlayClone.style.position  = 'absolute';
      overlayClone.style.left      = `${-rect.left}px`;
      overlayClone.style.top       = `${-rect.top}px`;
      overlayClone.style.width     = `${vw}px`;
      overlayClone.style.height    = `${vh}px`;
      overlayClone.style.maxWidth  = 'none';
      overlayClone.style.transform = 'none';
      // Front face already has overflow:hidden via .cube-face CSS, so
      // only the column-shaped slice of the overlay will be visible.
      front.appendChild(overlayClone);

      // ----- Back face: clone of the column wrapper -----
      const back = document.createElement('div');
      back.className = 'cube-face cube-face-left'; // rotate-right brings this in
      const colClone = columnEl.cloneNode(true);
      colClone.style.transform = 'none';
      // Fill the cube face so the clone matches the real column's render.
      back.appendChild(colClone);

      stage.appendChild(front);
      stage.appendChild(back);
      perspective.appendChild(stage);
      document.body.appendChild(perspective);
      return { perspective, stage };
    };

    const left  = buildSide(leftRect,  leftEl);
    const right = buildSide(rightRect, rightEl);

    return new Promise(resolve => {
      // Force layout, then rotate both stages on the same frame so they
      // spin in lockstep instead of one finishing before the other.
      // eslint-disable-next-line no-unused-expressions
      left.stage.offsetHeight; right.stage.offsetHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          left.stage.classList.add('rotate-right');
          right.stage.classList.add('rotate-right');
        });
      });

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        left.perspective.remove();
        right.perspective.remove();
        resolve();
      };
      // Either stage's transitionend is fine — they fire on the same
      // frame since the duration / easing are identical.
      left.stage.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 800);
    });
  },

  showLoading() {
    this.weatherView.innerHTML = '<div class="loader">Loading weather data...</div>';
  },

  showError(msg) {
    this.weatherView.textContent = '';
    const div = document.createElement('div');
    div.className = 'error-msg';
    div.style.cssText = 'padding: 40px; text-align: center; color: #ff5252;';
    div.textContent = msg;
    this.weatherView.appendChild(div);
  },

  // Map OWM's icon code (and optional numeric weather id for distinguishing
  // 50d atmospheric variants) to the filename of an SVG in
  // assets/icons/weather/. Returns a name WITHOUT extension; callers slap
  // ".svg" on it. Returning a single token (rather than the icon code +
  // night flag separately) means we can also use these as the "mode" keys
  // when picking the day's representative icon in the daily list.
  //
  //   01 → clear-day / clear-night
  //   02 → few-clouds-day / cloudy-night (no dedicated "few-clouds-night")
  //   03 → scattered-clouds
  //   04 → broken-clouds
  //   09 / 10 → shower-rain / shower-rain-night
  //   11 → thunderstorm / thunderstorm-night
  //   13 → snow / snow-night
  //   50 → mist / smoke / haze / sand / dust depending on weather.id
  _weatherAssetName(iconCode, weatherId) {
    const code   = (iconCode || '').toLowerCase();
    const isNight = code.endsWith('n');
    if (code.startsWith('50')) {
      // 7xx series in OWM — the icon code collapses them all to 50d.
      switch (Number(weatherId)) {
        case 701: case 741: return 'mist';   // Mist or Fog
        case 711:           return 'smoke';
        case 721:           return 'haze';
        case 731: case 751: return 'sand';   // Sand/dust whirls or Sand
        case 761: case 762: return 'dust';   // Dust or volcanic ash
        default:            return 'mist';   // safe fallback for unknown ids
      }
    }
    switch (code.slice(0, 2)) {
      case '01': return isNight ? 'clear-night'        : 'clear-day';
      case '02': return isNight ? 'cloudy-night'       : 'few-clouds-day';
      case '03': return 'scattered-clouds';
      case '04': return 'broken-clouds';
      case '09': return isNight ? 'shower-rain-night'  : 'shower-rain';
      case '10': return isNight ? 'shower-rain-night'  : 'shower-rain';
      case '11': return isNight ? 'thunderstorm-night' : 'thunderstorm';
      case '13': return isNight ? 'snow-night'         : 'snow';
      default:   return isNight ? 'clear-night'        : 'clear-day';
    }
  },

  // List of every asset name the icon picker can resolve to. Used by the
  // service worker so the bundled weather illustrations are precached and
  // available offline.
  WEATHER_ICON_ASSETS: [
    'clear-day', 'clear-night',
    'few-clouds-day', 'cloudy-night',
    'scattered-clouds', 'broken-clouds',
    'shower-rain', 'shower-rain-night',
    'thunderstorm', 'thunderstorm-night',
    'snow', 'snow-night',
    'mist', 'haze', 'smoke', 'sand', 'dust',
  ],

  // Render a weather-condition icon as an <img> pointing at the bundled
  // SVG asset. Returns markup so callers can interpolate into innerHTML
  // exactly like the old inline-SVG version did.
  //
  // Accepts either:
  //   getWeatherIconSVG(iconCode, size)
  //   getWeatherIconSVG(iconCode, size, weatherId)   // disambiguates 50d
  //   getWeatherIconSVG(assetName, size)             // already-resolved name
  //
  // The third form lets the daily-list "mode" logic store fully-resolved
  // names in `d.icons` and pass them straight through here without a
  // second lookup.
  // ── Ambient weather-effects layer ─────────────────────────────────
  // Toggles the body-level #weather-fx element's class based on what
  // the dashboard's headline icon is. The CSS does the actual animation
  // work; this is the only piece of JS involved (no timers — the
  // @keyframes loops pace themselves with long off-screen sections so
  // the "every ~20 s" cadence falls out naturally).
  //
  // Pass null / unrecognised → effect layer is cleared (clear sky).
  // OWM `weather.id` values that mean "very light precipitation" — used
  // to pick the fx-rain-light variant (fewer drops, slower fall) instead
  // of the default fx-rain. Covers explicit "light intensity" rain +
  // drizzle codes; heavier rain stays on fx-rain.
  LIGHT_RAIN_IDS: new Set([
    300, // light intensity drizzle
    301, // drizzle
    310, // light intensity drizzle rain
    311, // drizzle rain
    500, // light rain
    520, // light intensity shower rain
  ]),

  _fxClassFor(assetName, weatherId) {
    if (!assetName) return null;
    if (assetName.startsWith('thunderstorm'))         return 'fx-thunder';
    if (assetName.startsWith('shower-rain')) {
      return this.LIGHT_RAIN_IDS.has(Number(weatherId))
        ? 'fx-rain-light'
        : 'fx-rain';
    }
    if (assetName.startsWith('snow'))                 return 'fx-snow';
    if (assetName === 'broken-clouds' ||
        assetName === 'scattered-clouds')             return 'fx-clouds-many';
    if (assetName === 'few-clouds-day' ||
        assetName === 'cloudy-night')                 return 'fx-clouds';
    if (assetName === 'mist')                         return 'fx-fog';
    if (assetName === 'haze')                         return 'fx-haze';
    if (assetName === 'smoke')                        return 'fx-smoke';
    if (assetName === 'sand' || assetName === 'dust') return 'fx-dust';
    return null; // clear-day / clear-night / moon-* → no effect
  },

  // Apply the matching ambient effect class to #weather-fx AND publish
  // wind direction + speed to the layer via CSS custom properties so the
  // cloud-drift animation reflects the actual wind (clouds drift the
  // direction the wind is blowing TOWARD, at a duration scaled by wind
  // speed). Skips the class swap when the right class is already
  // applied — but always refreshes the wind vars so a same-condition
  // city change still updates wind direction.
  applyWeatherFX(assetName, wind = null, weatherId = null) {
    const el = document.getElementById('weather-fx');
    if (!el) return;

    // Wind to CSS custom properties:
    //   --fx-wind-start-x, --fx-wind-start-y → translate at 0%   of cycle
    //   --fx-wind-end-x,   --fx-wind-end-y   → translate at 30%  of cycle
    //                                          (and held to 100%)
    //   --fx-wind-dir                        → legacy 1D (kept for fog/dust)
    //   --fx-wind-speed                      → animation-duration divisor
    //
    // OWM gives wind direction in meteorological convention: degrees the
    // wind is coming FROM. Project onto SCREEN axes (y is down):
    //   toward_x = -sin(deg)   westerly (270°) → +x → drift right
    //   toward_y =  cos(deg)   northerly (  0°) → +y → drift down
    // The layer translates from -toward × TRAVEL to +toward × TRAVEL so
    // the clouds inside it enter from the upwind edge and exit on the
    // downwind edge — including diagonal motion when the wind isn't
    // purely horizontal. TRAVEL is in vmax so the angle stays correct
    // on non-square viewports.
    const windDeg   = wind && typeof wind.deg   === 'number' ? wind.deg   : 270;
    const windSpeed = wind && typeof wind.speed === 'number' ? wind.speed : 5;
    const towardX = -Math.sin(windDeg * Math.PI / 180);
    const towardY =  Math.cos(windDeg * Math.PI / 180);
    const TRAVEL  = 200; // vmax units of travel each way (off-screen padding)
    el.style.setProperty('--fx-wind-start-x', `${(-towardX * TRAVEL).toFixed(1)}vmax`);
    el.style.setProperty('--fx-wind-start-y', `${(-towardY * TRAVEL).toFixed(1)}vmax`);
    el.style.setProperty('--fx-wind-end-x',   `${( towardX * TRAVEL).toFixed(1)}vmax`);
    el.style.setProperty('--fx-wind-end-y',   `${( towardY * TRAVEL).toFixed(1)}vmax`);
    // Speed multiplier 0.1..0.625 with 0.25 at 5 m/s baseline. Halved
    // again from the previous (0.2..1.25 / 0.5 at 5 m/s) — clouds now
    // drift about four times slower than the original setting, more
    // like a lazy afternoon sky than a moving radar map.
    const mult = Math.max(0.1, Math.min(0.625, windSpeed / 20));
    el.style.setProperty('--fx-wind-speed', mult.toFixed(2));
    // Legacy 1D direction (still used by fog / haze / dust which only
    // animate background-position-x).
    el.style.setProperty('--fx-wind-dir', towardX >= 0 ? 'normal' : 'reverse');

    const next = this._fxClassFor(assetName, weatherId);
    if (this._activeFxClass === next) return;
    // Wipe any prior fx-* class.
    el.className = '';
    if (next) el.classList.add(next);
    this._activeFxClass = next;
  },

  // ── Moon-phase art ────────────────────────────────────────────────
  // moonPhaseName() returns one of eight strings. We have art for seven
  // of them — the "New" moon has no dedicated illustration (it's
  // essentially invisible), so the caller is expected to fall back to a
  // text-only display when this returns null.
  //
  // Files live alongside the weather illustrations in
  // assets/icons/weather/, prefixed with `moon-` so they're easy to
  // spot. Add the same prefix to any future additions.
  MOON_PHASE_ASSETS: {
    'Waxing crescent':  'moon-waxing-crescent',
    'First quarter':    'moon-first-quarter',
    'Waxing gibbous':   'moon-waxing-gibbous',
    'Full':             'moon-full',
    'Waning gibbous':   'moon-waning-gibbous',
    'Last quarter':     'moon-last-quarter',
    'Waning crescent':  'moon-waning-crescent',
    // 'New' intentionally absent — handled as a text-only fallback by
    // getMoonIconSVG (returns empty string).
  },

  _moonAssetName(phaseName) {
    return this.MOON_PHASE_ASSETS[phaseName] || null;
  },

  // Render the moon-phase illustration matching the given phase name.
  // Returns an <img> tag (same approach as getWeatherIconSVG) sized to
  // `size` px. For 'New' (no asset) returns the empty string so the
  // caller's surrounding text falls through cleanly.
  getMoonIconSVG(phaseName, size = 24) {
    const asset = this._moonAssetName(phaseName);
    if (!asset) return '';
    return `<img class="moon-icon" src="assets/icons/weather/${asset}.svg" width="${size}" height="${size}" alt="" draggable="false">`;
  },

  getWeatherIconSVG(iconCodeOrAsset, size = 24, weatherId = null, dtSeconds = null) {
    let asset;
    if (this.WEATHER_ICON_ASSETS.includes(iconCodeOrAsset)) {
      // Already an asset name (from the mode-icon path).
      asset = iconCodeOrAsset;
    } else {
      asset = this._weatherAssetName(iconCodeOrAsset, weatherId);
    }
    // Phase-correct clear-night substitution. When the icon would be a
    // generic crescent moon (clear-night) AND we know the timestamp this
    // icon represents, swap in the actual moon-phase illustration for
    // that date so the hero / hourly / daily icons reflect the sky the
    // user would actually see that night. The five other night-variant
    // assets (cloudy-night, shower-rain-night, thunderstorm-night,
    // snow-night) keep their painted-in crescent — phase-correct
    // versions of those would need 7 hand-drawn variants each.
    if (asset === 'clear-night' && dtSeconds != null) {
      const phase = this.moonPhaseName(dtSeconds * 1000);
      const moonAsset = this._moonAssetName(phase);
      // _moonAssetName returns null for 'New' (no art) — keep
      // clear-night as the visual fallback in that case.
      if (moonAsset) asset = moonAsset;
    }
    return `<img class="weather-icon" src="assets/icons/weather/${asset}.svg" width="${size}" height="${size}" alt="" draggable="false">`;
  },

  // Beaufort scale (m/s) → short description for the hero subtitle.
  windDescription(ms) {
    if (ms < 0.5)  return 'Calm';
    if (ms < 1.5)  return 'Light air';
    if (ms < 3.3)  return 'Light breeze';
    if (ms < 5.5)  return 'Gentle breeze';
    if (ms < 7.9)  return 'Moderate breeze';
    if (ms < 10.7) return 'Fresh breeze';
    if (ms < 13.8) return 'Strong breeze';
    if (ms < 17.1) return 'Near gale';
    if (ms < 20.7) return 'Gale';
    if (ms < 24.4) return 'Strong gale';
    if (ms < 28.4) return 'Storm';
    return 'Violent storm';
  },

  // Returns mm of rain over the next ~hour from current weather, or null.
  currentPrecipMM(currentWeather, forecast) {
    if (currentWeather.rain && currentWeather.rain['1h'] != null) return currentWeather.rain['1h'];
    if (currentWeather.snow && currentWeather.snow['1h'] != null) return currentWeather.snow['1h'];
    const f = forecast && forecast.list && forecast.list[0];
    if (f && f.rain && f.rain['3h'] != null) return f.rain['3h'] / 3;
    if (f && f.snow && f.snow['3h'] != null) return f.snow['3h'] / 3;
    return 0;
  },

  formatPrecip(mm) {
    if (mm == null) return '—';
    const unit = Storage.getUnits().precip;
    if (unit === 'in') return (mm / 25.4).toFixed(2) + ' in';
    return mm.toFixed(1) + ' mm';
  },

  // Returns a temperature converted to the user's unit but NOT rounded.
  // Use this when you need to do math/aggregation before rounding.
  convertTemp(celsius) {
    return Storage.getUnits().temp === 'F' ? (celsius * 9/5) + 32 : celsius;
  },

  formatTemp(celsius) {
    return Math.round(this.convertTemp(celsius));
  },

  formatWind(ms) {
    const unit = Storage.getUnits().wind;
    if (unit === 'mph') return (ms * 2.237).toFixed(1) + ' mph';
    if (unit === 'ms')  return ms.toFixed(1) + ' m/s';
    return (ms * 3.6).toFixed(1) + ' km/h';
  },

  // 8-point compass bearing from a meteorological "wind FROM" degree.
  windDirection(deg) {
    if (typeof deg !== 'number' || !isFinite(deg)) return '';
    const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
    return points[idx];
  },

  // Gusts are worth highlighting when they meaningfully exceed the sustained
  // wind — pick the looser of: 3 m/s absolute, or 50% above sustained.
  isNoteworthyGust(speedMs, gustMs) {
    if (typeof gustMs !== 'number' || !isFinite(gustMs)) return false;
    if (typeof speedMs !== 'number' || !isFinite(speedMs)) return false;
    const delta = gustMs - speedMs;
    return delta >= 3 || (speedMs > 0 && gustMs / speedMs >= 1.5);
  },

  formatPressure(hpa) {
    const unit = Storage.getUnits().pressure;
    if (unit === 'inhg') return (hpa * 0.02953).toFixed(2) + ' inHg';
    if (unit === 'mmhg') return (hpa * 0.75006).toFixed(0) + ' mmHg';
    return hpa + ' hPa';
  },

  formatDist(meters) {
    const unit = Storage.getUnits().dist;
    if (unit === 'mi') return (meters / 1609.34).toFixed(1) + ' mi';
    return (meters / 1000).toFixed(1) + ' km';
  },

  formatTime(unix, showMinutes = true, offset = 0) {
    const unit = Storage.getUnits().time;
    const date = new Date((unix + offset) * 1000);
    const h = date.getUTCHours();
    const m = date.getUTCMinutes();

    if (unit === '12h') {
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hour12 = h % 12 || 12;
      const min = showMinutes ? `:${m.toString().padStart(2, '0')}` : '';
      return `${hour12}${min} ${ampm}`;
    }

    const hour24 = h.toString().padStart(2, '0');
    const min = showMinutes ? `:${m.toString().padStart(2, '0')}` : '';
    return `${hour24}${min}`;
  },

  calculateDewPoint(temp, humidity) {
    const a = 17.27;
    const b = 237.7;
    const alpha = ((a * temp) / (b + temp)) + Math.log(humidity / 100.0);
    return (b * alpha) / (a - alpha);
  },

  isNoteworthyVisibility(meters) {
    return typeof meters === 'number' && meters < 8000;
  },

  isNoteworthyPressure(hpa) {
    return typeof hpa === 'number' && (hpa < 990 || hpa > 1030);
  },

  // Approximate sunrise/sunset for a given local calendar date at lat/lon.
  // Based on the U.S. Naval Observatory "Almanac for Computers" algorithm —
  // accurate to within a couple of minutes, which is plenty for a forecast UI.
  // Returns UNIX seconds (UTC) for the rise/set, or null when the sun never
  // crosses the horizon on that day (polar regions).
  _solarTimes(year, month /* 1-12 */, day, lat, lon) {
    const N1 = Math.floor(275 * month / 9);
    const N2 = Math.floor((month + 9) / 12);
    const N3 = 1 + Math.floor((year - 4 * Math.floor(year / 4) + 2) / 3);
    const N  = N1 - (N2 * N3) + day - 30;

    const lngHour = lon / 15;
    const zenith  = 90.833 * Math.PI / 180;
    const latRad  = lat * Math.PI / 180;

    const compute = (rising) => {
      const t = rising ? N + ((6 - lngHour) / 24) : N + ((18 - lngHour) / 24);

      const M = (0.9856 * t) - 3.289;
      const Mrad = M * Math.PI / 180;
      let L = M + (1.916 * Math.sin(Mrad)) + (0.020 * Math.sin(2 * Mrad)) + 282.634;
      L = ((L % 360) + 360) % 360;
      const Lrad = L * Math.PI / 180;

      let RA = Math.atan(0.91764 * Math.tan(Lrad)) * 180 / Math.PI;
      RA = ((RA % 360) + 360) % 360;
      const Lquadrant  = Math.floor(L  / 90) * 90;
      const RAquadrant = Math.floor(RA / 90) * 90;
      RA = (RA + (Lquadrant - RAquadrant)) / 15;

      const sinDec = 0.39782 * Math.sin(Lrad);
      const cosDec = Math.cos(Math.asin(sinDec));

      const cosH = (Math.cos(zenith) - (sinDec * Math.sin(latRad))) / (cosDec * Math.cos(latRad));
      if (cosH > 1 || cosH < -1) return null;

      let H = rising
        ? 360 - (Math.acos(cosH) * 180 / Math.PI)
        :         Math.acos(cosH) * 180 / Math.PI;
      H = H / 15;

      const T = H + RA - (0.06571 * t) - 6.622;
      let UT = T - lngHour;
      UT = ((UT % 24) + 24) % 24;
      return UT;
    };

    const utcMidnightSec = Date.UTC(year, month - 1, day) / 1000;
    const sr = compute(true);
    const ss = compute(false);
    return {
      sunrise: sr != null ? Math.round(utcMidnightSec + sr * 3600) : null,
      sunset:  ss != null ? Math.round(utcMidnightSec + ss * 3600) : null
    };
  },

  // Map WMO weather codes (used by Open-Meteo) onto OWM-style icon strings
  // so getWeatherIconSVG keeps working for synthesised days 6-8.
  wmoToIcon(code, isDay = true) {
    const dn = isDay ? 'd' : 'n';
    if (code == null) return `04${dn}`;
    if (code === 0)                       return `01${dn}`;
    if (code === 1)                       return `02${dn}`;
    if (code === 2)                       return `03${dn}`;
    if (code === 3)                       return `04${dn}`;
    if (code === 45 || code === 48)       return `04${dn}`;            // fog — no fog SVG, use overcast
    if (code >= 51 && code <= 55)         return `09${dn}`;            // drizzle
    if (code === 56 || code === 57)       return `13${dn}`;            // freezing drizzle
    if (code >= 61 && code <= 65)         return `10${dn}`;            // rain
    if (code === 66 || code === 67)       return `13${dn}`;            // freezing rain
    if (code >= 71 && code <= 77)         return `13${dn}`;            // snow
    if (code >= 80 && code <= 82)         return `09${dn}`;            // rain showers
    if (code === 85 || code === 86)       return `13${dn}`;            // snow showers
    if (code >= 95)                       return `11${dn}`;            // thunderstorm
    return `04${dn}`;
  },

  wmoDescription(code) {
    const m = {
      0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
      45: 'fog', 48: 'depositing rime fog',
      51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
      56: 'light freezing drizzle', 57: 'freezing drizzle',
      61: 'light rain', 63: 'rain', 65: 'heavy rain',
      66: 'light freezing rain', 67: 'freezing rain',
      71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
      80: 'light showers', 81: 'showers', 82: 'violent showers',
      85: 'light snow showers', 86: 'snow showers',
      95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail'
    };
    return m[code] || 'unknown';
  },

  // Convert an Open-Meteo hourly entry into the OWM 3h-slot shape the rest
  // of the UI expects. Marks rain via the '3h' field by multiplying mm/h × 3
  // so per-day totals still come out correct (we sum '3h' / 3 ≈ mm/h elsewhere).
  _omHourToOwmSlot(h) {
    const slot = {
      dt: h.dt,
      main: {
        temp: h.temp,
        feels_like: h.feelsLike != null ? h.feelsLike : h.temp,
        humidity: h.humidity || 0,
        pressure: 1013 // not requested from Open-Meteo; benign default
      },
      weather: [{
        icon: this.wmoToIcon(h.weatherCode, h.isDay),
        description: this.wmoDescription(h.weatherCode)
      }],
      wind: {
        speed: h.windSpeed || 0,
        deg:   h.windDir != null ? h.windDir : 0,
        gust:  h.windGust != null ? h.windGust : undefined
      },
      visibility: 10000,
      pop: (h.precipProb || 0) / 100
    };
    if (h.precipMM > 0) slot.rain = { '3h': h.precipMM * 3 };
    return slot;
  },

  // WHO UV Index categories.
  uvLabel(uv) {
    if (uv == null) return '—';
    const v = Math.round(uv);
    let label;
    if (v <= 2)       label = 'Low';
    else if (v <= 5)  label = 'Moderate';
    else if (v <= 7)  label = 'High';
    else if (v <= 10) label = 'Very High';
    else              label = 'Extreme';
    return `${label} (${v})`;
  },

  // US AQI categories (EPA breakpoints).
  aqiLabel(aqi) {
    if (aqi == null) return 'N/A';
    const v = Math.round(aqi);
    let label;
    if (v <= 50)       label = 'Good';
    else if (v <= 100) label = 'Moderate';
    else if (v <= 150) label = 'Sensitive';
    else if (v <= 200) label = 'Unhealthy';
    else if (v <= 300) label = 'Very poor';
    else               label = 'Hazardous';
    return `${label} (${v})`;
  },

  // Sum of CAMS pollen grains/m³ → coarse Low/Moderate/High band.
  // Returns 'N/A' outside CAMS coverage (essentially anywhere not Europe).
  pollenLabel(pollen) {
    if (pollen == null) return 'N/A';
    if (pollen < 10)  return 'Low';
    if (pollen < 50)  return 'Moderate';
    return 'High';
  },

  // Moon phase name at a given moment. Defaults to "now" so existing
  // callers don't change, but takes a ms timestamp so forecast days /
  // hourly tiles can show the correct phase for THEIR date rather than
  // always "today's phase". Synodic period 29.530588 days, anchored to
  // the new moon on 2000-01-06 18:14 UTC.
  moonPhaseName(atMs = Date.now()) {
    const SYNODIC = 29.530588853;
    const REF_MS = Date.UTC(2000, 0, 6, 18, 14);
    const daysSince = (atMs - REF_MS) / 86400000;
    const p = (((daysSince % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC; // 0..1
    if (p < 0.03 || p >= 0.97) return 'New';
    if (p < 0.22) return 'Waxing crescent';
    if (p < 0.28) return 'First quarter';
    if (p < 0.47) return 'Waxing gibbous';
    if (p < 0.53) return 'Full';
    if (p < 0.72) return 'Waning gibbous';
    if (p < 0.78) return 'Last quarter';
    return 'Waning crescent';
  },

  // US state code → full name. Used by prettifyLocationName so saved
  // entries spell out their state regardless of what the geocoder returned.
  US_STATE_NAMES: {
    AL: 'Alabama',   AK: 'Alaska',     AZ: 'Arizona',     AR: 'Arkansas',
    CA: 'California', CO: 'Colorado',  CT: 'Connecticut', DE: 'Delaware',
    FL: 'Florida',   GA: 'Georgia',    HI: 'Hawaii',      ID: 'Idaho',
    IL: 'Illinois',  IN: 'Indiana',    IA: 'Iowa',        KS: 'Kansas',
    KY: 'Kentucky',  LA: 'Louisiana',  ME: 'Maine',       MD: 'Maryland',
    MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
    MO: 'Missouri',  MT: 'Montana',    NE: 'Nebraska',    NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
    NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
    OR: 'Oregon',    PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
    SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
    VT: 'Vermont',   VA: 'Virginia',   WA: 'Washington',  WV: 'West Virginia',
    WI: 'Wisconsin', WY: 'Wyoming',    DC: 'District of Columbia',
    PR: 'Puerto Rico', VI: 'U.S. Virgin Islands', GU: 'Guam', MP: 'Northern Mariana Islands'
  },

  // Expand abbreviated state / country codes in a stored location name so
  // every saved entry reads consistently spelled-out, regardless of which
  // geocoder produced it. "Los Angeles, CA" → "Los Angeles, California";
  // "Tokyo, JP" → "Tokyo, Japan"; already-expanded names pass through.
  prettifyLocationName(name) {
    if (!name || typeof name !== 'string') return name;
    const parts = name.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return name;

    // Lazily build the country-name lookup. Intl.DisplayNames is widely
    // supported; on the off chance it isn't, we leave codes as-is.
    let countryNamer = this._countryNamer;
    if (countryNamer === undefined) {
      try { countryNamer = new Intl.DisplayNames(['en'], { type: 'region' }); }
      catch (_) { countryNamer = null; }
      this._countryNamer = countryNamer;
    }

    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      const upper = p.toUpperCase();
      if (this.US_STATE_NAMES[upper]) { parts[i] = this.US_STATE_NAMES[upper]; continue; }
      if (/^[A-Z]{2}$/.test(upper) && countryNamer) {
        const full = countryNamer.of(upper);
        if (full && full !== upper) parts[i] = full;
      }
    }
    return parts.join(', ');
  },

  // HTML-escape a string for safe interpolation into innerHTML templates.
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  // Show or hide the bottom NWS alert bar based on the supplied alerts
  // array. The bar is a button — tapping it opens the alerts overlay
  // with the full text of every active warning, courtesy of
  // renderAlertsOverlay() below.
  renderAlertBar(alerts) {
    const bar = document.getElementById('alert-bar');
    if (!bar) return;

    // Stash the alerts so the bar's click handler can read the latest set.
    this._currentAlerts = alerts || [];

    // One-time bindings: click → open overlay, back button → close it.
    if (!this._alertBarBound) {
      this._alertBarBound = true;
      bar.addEventListener('click', () => {
        this.renderAlertsOverlay(this._currentAlerts);
        this.toggleScreen('alerts', true);
      });
      const backBtn = document.getElementById('alerts-back-btn');
      if (backBtn) backBtn.addEventListener('click', () => this.toggleScreen('alerts', false));
    }

    if (!alerts || alerts.length === 0) {
      bar.hidden = true;
      document.body.classList.remove('has-alert');
      return;
    }
    const top = alerts[0];
    const extra = alerts.length - 1;
    const textEl = document.getElementById('alert-bar-text');
    if (textEl) {
      textEl.textContent = extra > 0
        ? `${top.event} (+${extra} more)`
        : top.event;
    }
    bar.hidden = false;
    document.body.classList.add('has-alert');
  },

  // Populate the alerts overlay with one card per active warning, showing
  // the full headline, description, instruction, area, timing, source,
  // and a link to the official NWS detail page.
  renderAlertsOverlay(alerts) {
    const body = document.getElementById('alerts-body');
    if (!body) return;
    if (!alerts || alerts.length === 0) {
      body.innerHTML = '<div style="color: #a0a0a0; text-align: center; padding: 40px;">No active alerts.</div>';
      return;
    }

    const fmtTime = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d)) return '';
      return d.toLocaleString([], {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    };

    // NWS narrative text is wrapped at ~70 chars with hard \n inside each
    // paragraph and a blank line between paragraphs (legacy AWIPS format).
    // Re-flow it: split on blank lines to keep paragraph boundaries, then
    // collapse whitespace within each paragraph so it can soft-wrap to the
    // viewport. Bullet items beginning with "*" stay on their own line.
    const reflow = (text) => {
      return text
        .split(/\n\s*\n/)
        .flatMap(block => {
          // Split bulleted sections on "* " (the NWS bullet marker) so
          // each "* WHAT…", "* WHERE…" lives in its own paragraph.
          if (block.includes('* ')) {
            return block.split(/\n(?=\* )/).map(s => s.trim()).filter(Boolean);
          }
          return [block];
        })
        .map(p => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    };

    const renderParas = (text) =>
      reflow(text).map(p => `<p>${this.esc(p)}</p>`).join('');

    body.innerHTML = alerts.map(a => {
      const sections = [];
      if (a.headline) {
        sections.push(`<div class="alert-card-headline">${this.esc(a.headline)}</div>`);
      }
      if (a.description) {
        sections.push(`
          <div class="alert-card-section">
            <div class="alert-card-section-label">What's happening</div>
            <div class="alert-card-section-body">${renderParas(a.description)}</div>
          </div>`);
      }
      if (a.instruction) {
        sections.push(`
          <div class="alert-card-section">
            <div class="alert-card-section-label">What to do</div>
            <div class="alert-card-section-body">${renderParas(a.instruction)}</div>
          </div>`);
      }

      const meta = [];
      if (a.areaDesc) meta.push(`<span><strong>Area:</strong> ${this.esc(a.areaDesc)}</span>`);
      if (a.severity) meta.push(`<span><strong>Severity:</strong> ${this.esc(a.severity)}</span>`);
      const eff = fmtTime(a.effective);
      const exp = fmtTime(a.expires);
      if (eff) meta.push(`<span><strong>Issued:</strong> ${this.esc(eff)}</span>`);
      if (exp) meta.push(`<span><strong>Until:</strong> ${this.esc(exp)}</span>`);
      if (a.sender) meta.push(`<span><strong>Source:</strong> ${this.esc(a.sender)}</span>`);

      const link = a.url
        ? `<a class="alert-card-link" href="${this.esc(a.url)}" target="_blank" rel="noopener noreferrer">View on weather.gov ↗</a>`
        : '';

      return `
        <div class="alert-card">
          <div class="alert-card-event">${this.esc(a.event)}</div>
          ${sections.join('')}
          <div class="alert-card-meta">${meta.join('')}</div>
          ${link}
        </div>
      `;
    }).join('');
  },

  renderDashboard(state, onDayClick, onSave) {
    const { currentWeather, forecast, cityName, selectedDayIndex } = state;

    this.locationName.textContent = this.prettifyLocationName(cityName);

    // Header Save Button
    const savedList = Storage.getSavedList();
    const isSaved = Storage.isDuplicate(savedList, currentWeather.coord.lat, currentWeather.coord.lon);

    this.saveBtnContainer.innerHTML = `
      <button class="save-loc-btn ${isSaved ? 'saved' : ''}" id="save-btn" aria-label="Save Location">
        ${isSaved
          ? `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`
        }
      </button>
    `;
    document.getElementById('save-btn').addEventListener('click', onSave);

    // Group forecast points by the CITY's local calendar day, not the
    // browser's. Without this, viewing e.g. Tokyo weather from New York
    // would split slots into the wrong "days."
    const dayKeyFor = (unixSec) => {
      const local = new Date((unixSec + currentWeather.timezone) * 1000);
      return `${local.getUTCFullYear()}-${local.getUTCMonth()}-${local.getUTCDate()}`;
    };
    // Today's dayKey in the CITY's local time — used downstream to label
    // the correct entry "Today" instead of trusting array position.
    const todayKey = dayKeyFor(Math.floor(Date.now() / 1000));

    // Build a Map keyed by city-local day. OWM days are added first (richer
    // 3h slots), then Open-Meteo fills in any missing calendar days so we
    // can show 8 total. Sorting chronologically afterwards guarantees the
    // visible order is never out of sequence even when OWM's first slot is
    // already "tomorrow" (late-night case).
    const TARGET_DAYS = 8;
    const omDaily  = state.omDaily  || [];
    const omHourly = state.omHourly || [];
    const allDays  = new Map();

    forecast.list.forEach(item => {
      const key = dayKeyFor(item.dt);
      if (!allDays.has(key)) {
        allDays.set(key, { key, temps: [], icons: [], hourly: [], dt: item.dt });
      }
      const d = allDays.get(key);
      d.temps.push(item.main.temp);
      // Store the fully-resolved asset name (e.g. "few-clouds-day",
      // "haze") so the daily-list "mode" calculation can distinguish
      // 50d sub-types (mist / smoke / haze / sand / dust) which all
      // share the same OWM icon code.
      d.icons.push(this._weatherAssetName(item.weather[0].icon, item.weather[0].id));
      d.hourly.push(item);
    });

    for (const dayInfo of omDaily) {
      const key = dayKeyFor(dayInfo.dt);
      if (allDays.has(key)) continue;

      const dayStart = dayInfo.dt;
      const dayEnd   = dayStart + 24 * 3600;
      // Pull every 3rd hour so the synthesized day has roughly the same
      // density as OWM's native 3h slots, which keeps the graph clean.
      const slots = omHourly
        .filter(h => h.dt >= dayStart && h.dt < dayEnd && (Math.floor(h.dt / 3600) % 3 === 0))
        .map(h => this._omHourToOwmSlot(h));
      if (!slots.length) continue;

      allDays.set(key, {
        key,
        temps: slots.map(s => s.main.temp),
        icons: slots.map(s => this._weatherAssetName(s.weather[0].icon, s.weather[0].id)),
        hourly: slots,
        dt: dayStart,
        _om: dayInfo // marker + accurate sunrise/sunset for this day
      });
    }

    // OWM's last covered day often has just 1-3 slots (its 5-day window
    // ends mid-day). Top those up with Open-Meteo's hourly so every day's
    // graph has ~8 evenly-spaced points like a normal full day.
    const MIN_SLOTS = 8;
    const dayStartFromKey = (key) => {
      const [yy, mo, dd] = key.split('-').map(Number);
      return Math.floor(Date.UTC(yy, mo, dd) / 1000) - currentWeather.timezone;
    };
    for (const day of allDays.values()) {
      if (day.hourly.length >= MIN_SLOTS) continue;
      const dayStart = dayStartFromKey(day.key);
      const dayEnd   = dayStart + 24 * 3600;
      const existingHours = new Set(day.hourly.map(s => Math.floor(s.dt / 3600)));
      const omSlots = omHourly
        .filter(h => h.dt >= dayStart && h.dt < dayEnd && (Math.floor(h.dt / 3600) % 3 === 0));
      for (const omH of omSlots) {
        const omHour = Math.floor(omH.dt / 3600);
        // Skip if an OWM slot already lives within ±1h of this Open-Meteo hour.
        let collides = false;
        for (const h of existingHours) {
          if (Math.abs(h - omHour) <= 1) { collides = true; break; }
        }
        if (collides) continue;
        const slot = this._omHourToOwmSlot(omH);
        day.hourly.push(slot);
        day.temps.push(slot.main.temp);
        day.icons.push(this._weatherAssetName(slot.weather[0].icon, slot.weather[0].id));
        existingHours.add(omHour);
      }
      day.hourly.sort((a, b) => a.dt - b.dt);
    }

    const dailyData = Array.from(allDays.values())
      .sort((a, b) => a.dt - b.dt)
      .slice(0, TARGET_DAYS);

    // Day totals for any forecast day: sum of rain+snow mm and max PoP across
    // the 3h slots in that day. Used identically for Today and forecast days
    // so the Precipitation / Probability rows update consistently.
    const dayTotals = (day) => {
      if (!day) return { rainMM: 0, pop: 0 };
      const rainMM = day.hourly.reduce((sum, h) => {
        const r = (h.rain && h.rain['3h']) || 0;
        const s = (h.snow && h.snow['3h']) || 0;
        return sum + r + s;
      }, 0);
      const pop = day.hourly.reduce((mx, h) => Math.max(mx, h.pop || 0), 0);
      return { rainMM, pop };
    };

    // The Today tab (index 0) and the initial state (-1) both mean "today" —
    // unify them so the rolling 24h temperature graph and the rest-of-today
    // metrics are identical regardless of which path we got here through.
    const isToday = selectedDayIndex === -1 || selectedDayIndex === 0;
    const todayData = dailyData[0];

    // Compute sunrise/sunset for a given calendar day at the city. For Today
    // we trust OWM's values (sub-minute accurate); for forecast days we compute
    // locally since OWM's free /forecast endpoint doesn't include them.
    // Pick the most "notable" hourly slot for a day — a storm at 3 AM is
    // a more useful daily headline than a clear noon, so we rank slots
    // by severity first and use closeness to local noon only as a tie
    // breaker among slots that share the highest severity. That means:
    //   - any thunderstorm anywhere in the day → ⛈️ icon
    //   - else any snow → 🌨️ icon
    //   - else any rain → 🌧️ icon
    //   - else any dust/sand/smoke/haze/mist → that atmospheric icon
    //   - else cloudiest of the day → ☁️ / ⛅
    //   - else clear → ☀️
    // Used by both the daily-list row and the hero (for non-today days),
    // so the two stay matched and the row→hero slide animation still
    // ends on the same illustration.
    const NOTABILITY = {
      'thunderstorm': 9, 'thunderstorm-night': 9,
      'snow':          8, 'snow-night':          8,
      'shower-rain':   7, 'shower-rain-night':   7,
      'sand':          6, 'dust':                6,
      'smoke':         5, 'haze':                5,
      'mist':          4,
      'broken-clouds': 3,
      'scattered-clouds': 2,
      'few-clouds-day': 1, 'cloudy-night':       1,
      'clear-day':     0, 'clear-night':         0,
    };
    const notableSlotFor = (day) => {
      if (!day || !day.hourly || !day.hourly.length) return null;
      let best = null;
      let bestScore = -1;
      let bestDiff  = Infinity;
      for (const slot of day.hourly) {
        if (!slot.weather || !slot.weather[0]) continue;
        const asset = this._weatherAssetName(slot.weather[0].icon, slot.weather[0].id);
        const score = NOTABILITY[asset] != null ? NOTABILITY[asset] : 0;
        const lh = (((slot.dt + state.timezone) / 3600) % 24 + 24) % 24;
        const diff = Math.abs(lh - 12);
        // Strictly higher severity always wins; among ties we keep the
        // slot closest to local noon.
        if (score > bestScore || (score === bestScore && diff < bestDiff)) {
          bestScore = score;
          bestDiff  = diff;
          best      = slot;
        }
      }
      return best;
    };

    const sunTimesForDay = (dayDt) => {
      const localMs = (dayDt + state.timezone) * 1000;
      const d = new Date(localMs);
      return this._solarTimes(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        currentWeather.coord.lat,
        currentWeather.coord.lon
      );
    };

    const activeDay = isToday ? (() => {
      const totals = dayTotals(todayData);
      return {
        main: currentWeather.main,
        weather: currentWeather.weather,
        wind: currentWeather.wind,
        visibility: currentWeather.visibility,
        // Today's graph spans NOW → NOW + 24h (rolling window). Forecast
        // days use their local-calendar-day slots (handled in the else
        // branch below).
        hourly: forecast.list.slice(0, 8),
        sunrise: currentWeather.sys.sunrise,
        sunset: currentWeather.sys.sunset,
        pop: totals.pop,
        rainMM: totals.rainMM,
        // Used by the hero icon picker so a phase-correct moon shows
        // tonight if it's currently clear-night here. (Forecast days
        // get .dt via the `mid` spread in the else branch.)
        dt: currentWeather.dt
      };
    })() : (() => {
      const day = dailyData[selectedDayIndex];
      const mid = day.hourly[Math.floor(day.hourly.length / 2)];
      const totals = dayTotals(day);
      // Open-Meteo-synthesised days carry exact sunrise/sunset; otherwise
      // compute via the U.S. Naval Observatory formula.
      const sun = day._om
        ? { sunrise: day._om.sunrise, sunset: day._om.sunset }
        : sunTimesForDay(day.dt);
      // Headline icon for the day = the most NOTABLE weather (storm /
      // snow / rain / dust / haze / clouds, in that order), tie-broken
      // by closeness to local noon. Matches the daily-list row picker
      // exactly, so the row→hero slide animation lands on the same art.
      const heroSlot = notableSlotFor(day) || mid;
      const heroAsset = (heroSlot.weather && heroSlot.weather[0])
        ? this._weatherAssetName(heroSlot.weather[0].icon, heroSlot.weather[0].id)
        : null;
      // Stash the resolved asset name on a synthetic _asset field so the
      // hero render can pass it directly into getWeatherIconSVG (which
      // accepts asset names as well as OWM codes).
      const modeWeather = (heroSlot.weather && heroSlot.weather[0] && heroAsset)
        ? [{ ...heroSlot.weather[0], _asset: heroAsset }]
        : mid.weather;
      return {
        ...mid,
        weather: modeWeather,
        hourly: day.hourly,
        sunrise: sun.sunrise,
        sunset: sun.sunset,
        pop: totals.pop,
        rainMM: totals.rainMM
      };
    })();

    const dewPoint = this.calculateDewPoint(activeDay.main.temp, activeDay.main.humidity);
    const breeze = this.windDescription(activeDay.wind.speed);

    // Hero subtitle clock: short city name (before any comma) + local time.
    const cityShort = (cityName || '').split(',')[0].trim() || cityName || '';
    const nowSec = Math.floor(Date.now() / 1000);
    const cityClock = this.formatTime(nowSec, true, state.timezone);
    this._clockTimezone = state.timezone;
    this._ensureClockTimer();

    // Small label above the weather icon: "Right now" for today,
    // "Tuesday's forecast" for any other day.
    let heroWhen = 'Right now';
    if (!isToday) {
      const day = dailyData[selectedDayIndex];
      if (day && day.key) {
        const [yy, mo, dd] = day.key.split('-').map(Number);
        const date = new Date(Date.UTC(yy, mo, dd));
        const weekday = date.toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' });
        heroWhen = `${weekday}'s forecast`;
      }
    }

    // Big temperature readout. Today → current temp. Other days → high/low.
    let heroTempHTML;
    if (isToday) {
      heroTempHTML = `<div class="hero-temp-large">${this.formatTemp(activeDay.main.temp)}°</div>`;
    } else {
      const day = dailyData[selectedDayIndex];
      const hi = Math.round(this.convertTemp(Math.max(...day.temps)));
      const lo = Math.round(this.convertTemp(Math.min(...day.temps)));
      heroTempHTML = `<div class="hero-temp-large">${hi}° / ${lo}°</div>`;
    }

    // UV: current for today, daily-max for forecast days. Falls back to '—' if
    // Open-Meteo was unreachable or returned no data for this slot.
    const uv = state.uv || { current: null, daily: [] };
    const uvValue = isToday
      ? (uv.current != null ? uv.current : uv.daily[0])
      : uv.daily[selectedDayIndex];

    const sunriseStat = activeDay.sunrise != null ? `
      <div class="stat-item">
        <span class="stat-label">Sunrise</span>
        <span class="stat-value">${this.formatTime(activeDay.sunrise, true, state.timezone)}</span>
      </div>` : '';
    const sunsetStat = activeDay.sunset != null ? `
      <div class="stat-item">
        <span class="stat-label">Sunset</span>
        <span class="stat-value">${this.formatTime(activeDay.sunset, true, state.timezone)}</span>
      </div>` : '';

    // Quick-stats grid is 3 columns. Count what will be shown so we can
    // The quick-stats grid is capped at 2 rows / 6 items per page. Items
    // beyond that go on additional cube-swipeable pages. Order matters:
    // the first 6 most-important items live on page 1; everything else
    // appears at the top of page 2+ as the user swipes.
    const hasGust       = this.isNoteworthyGust(activeDay.wind.speed, activeDay.wind.gust);
    const hasPressure   = this.isNoteworthyPressure(activeDay.main.pressure);
    const hasVisibility = this.isNoteworthyVisibility(activeDay.visibility);
    const aq = state.airQuality || { aqi: null, pollen: null, treePollen: null, grassPollen: null, weedPollen: null };

    const item = (label, value) => `
      <div class="stat-item">
        <span class="stat-label">${this.esc(label)}</span>
        <span class="stat-value">${value}</span>
      </div>`;

    const windArrow = activeDay.wind.deg != null
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${activeDay.wind.deg}deg); margin-left: 2px; vertical-align: -2px;"><line x1="12" y1="4" x2="12" y2="20"></line><polyline points="18 14 12 20 6 14"></polyline></svg>`
      : '';

    // Page-1 candidates (in priority order). Sunrise / Sunset / Dew point
    // / Moon phase are intentionally NOT here — they always live on page 2.
    const page1Candidates = [
      item('Wind',
        `${this.formatWind(activeDay.wind.speed)}${
          this.windDirection(activeDay.wind.deg)
            ? ' ' + this.windDirection(activeDay.wind.deg) + windArrow : ''}`),
    ];
    if (hasGust) page1Candidates.push(item('Wind gust', this.formatWind(activeDay.wind.gust)));
    page1Candidates.push(item('Humidity', `${activeDay.main.humidity}%`));
    // Precipitation amount and chance — only shown when actually relevant.
    if ((activeDay.rainMM || 0) > 0) {
      page1Candidates.push(item('Precipitation', this.formatPrecip(activeDay.rainMM)));
    }
    if ((activeDay.pop || 0) > 0) {
      page1Candidates.push(item('Precip chance', `${Math.round(activeDay.pop * 100)}%`));
    }
    page1Candidates.push(
      item('UV index',    this.esc(this.uvLabel(uvValue))),
      item('Air quality', this.esc(this.aqiLabel(aq.aqi)))
    );
    if (hasPressure)        page1Candidates.push(item('Pressure',   this.formatPressure(activeDay.main.pressure)));
    if (hasVisibility)      page1Candidates.push(item('Visibility', this.formatDist(activeDay.visibility)));
    if (aq.pollen != null)  page1Candidates.push(item('Pollen',     this.esc(this.pollenLabel(aq.pollen))));

    const STATS_PER_PAGE = 6;

    // Local time is a "flex" item: it fills any unused slot on page 1
    // (so the city's current time stays visible by default whenever
    // possible), and falls back to page 2 if page 1 is already full.
    // The #city-clock id stays on the value span so the existing
    // ticking-clock interval keeps it updated without a full re-render.
    const localTimeItem = item('Local time', `<span id="city-clock">${this.esc(cityClock)}</span>`);
    const localTimeOnPage1 = page1Candidates.length < STATS_PER_PAGE;
    if (localTimeOnPage1) page1Candidates.push(localTimeItem);

    // Fixed page-2 leaders. Top line = Sunrise / Sunset / Moon phase;
    // second line begins with Local time (when page 1 had no room),
    // then Dew point.
    const page2Forced = [
      item('Sunrise',    activeDay.sunrise != null ? this.formatTime(activeDay.sunrise, true, state.timezone) : '—'),
      item('Sunset',     activeDay.sunset  != null ? this.formatTime(activeDay.sunset,  true, state.timezone) : '—'),
      // Moon-phase stat: inline the matching illustration alongside the
      // word "Moon phase" in the label row (instead of stacking the icon
      // on its own line above the value). Hand-rolled instead of using
      // the shared item() helper because item() escapes the label, which
      // would turn the icon's <img> markup into literal text. Phase name
      // stays in the .stat-value row beneath it. getMoonIconSVG and the
      // phase label both come from the same moonPhaseName() result, so
      // the icon can't drift out of sync with the name.
      //
      // IMPORTANT: when the user switches to another day in the daily
      // list, moonPhaseName() needs to compute the phase for THAT day,
      // not today. activeDay.dt is the slot timestamp (Unix seconds) for
      // the currently-selected day's mid-hour; converting to ms gives us
      // a moment squarely inside that day, so the moon icon + name
      // update along with the rest of the dashboard.
      (() => {
        const dtMs = activeDay.dt != null ? activeDay.dt * 1000 : Date.now();
        const phase = this.moonPhaseName(dtMs);
        const icon  = this.getMoonIconSVG(phase, 18);
        return `
          <div class="stat-item">
            <span class="stat-label stat-label-with-icon">
              <span>Moon phase</span>
              ${icon}
            </span>
            <span class="stat-value">${this.esc(phase)}</span>
          </div>`;
      })(),
    ];
    if (!localTimeOnPage1) page2Forced.push(localTimeItem);
    page2Forced.push(item('Dew point', `${this.formatTemp(dewPoint)}°`));

    // First 6 candidates fill page 1; rest overflows to page 2 after the
    // forced items. Every page is padded out to exactly 6 cells with
    // invisible placeholders so the grid is always 2 rows tall — keeps
    // the cube-flip animation from causing a height change at the end.
    const PLACEHOLDER = '<div class="stat-item stat-item-placeholder" aria-hidden="true"><span class="stat-label">&nbsp;</span><span class="stat-value">&nbsp;</span></div>';
    const padToFull = (cells) => {
      const out = [...cells];
      while (out.length < STATS_PER_PAGE) out.push(PLACEHOLDER);
      return out.join('');
    };

    // Low-priority items live AFTER the overflow tail, so they always end up
    // on the last page(s). Per-category pollen (tree / grass / weed) is
    // shown whenever ANY pollen has been detected for that bucket — pollen
    // counts under 10 grains/m³ are still real exposure and worth surfacing,
    // they just get the "Low" label. We suppress only zeros and nulls
    // (the latter is what CAMS returns outside European coverage).
    const POLLEN_NOTABLE = 1;
    const lowPriority = [];
    const pushPollen = (label, value) => {
      if (value != null && value >= POLLEN_NOTABLE) {
        lowPriority.push(item(label, this.esc(this.pollenLabel(value))));
      }
    };
    pushPollen('Tree pollen',  aq.treePollen);
    pushPollen('Grass pollen', aq.grassPollen);
    pushPollen('Weed pollen',  aq.weedPollen);

    const page1 = page1Candidates.slice(0, STATS_PER_PAGE);
    const overflow = page1Candidates.slice(STATS_PER_PAGE);
    const page2AndAfter = [...page2Forced, ...overflow, ...lowPriority];

    const statsPages = [padToFull(page1)];
    for (let i = 0; i < page2AndAfter.length; i += STATS_PER_PAGE) {
      statsPages.push(padToFull(page2AndAfter.slice(i, i + STATS_PER_PAGE)));
    }
    // Reset to page 0 whenever the city changes; otherwise preserve.
    if (this._renderedCityName !== cityName) this._statsPageIdx = 0;
    if (this._statsPageIdx == null || this._statsPageIdx >= statsPages.length) this._statsPageIdx = 0;
    this._statsPages = statsPages;

    const precipMsg = (activeDay.pop || 0) > 0.1
      ? `${Math.round(activeDay.pop * 100)}% chance of precipitation`
      : 'No precipitation expected';

    // Index of the currently-displayed day in dailyData, used by the
    // hourly-scroll to highlight its tiles and detect scroll-driven day
    // changes. Both -1 (initial) and 0 (Today tab) map to 0.
    const currentDayIdx = isToday ? 0 : selectedDayIndex;

    let html = `
      <!-- Left-column wrapper: hero + stats + temperature graph. Pairs
           with .dashboard-right (below) so the landscape two-column
           layout has exactly two grid cells, and the swipe-between-
           cities cube transition can spin each column independently
           instead of as one big cube. In portrait both wrappers stack
           as plain blocks, preserving the single-column layout. -->
      <div class="dashboard-left">
      <section class="hero-section">
        <div class="hero-when">${this.esc(heroWhen)}</div>
        <div class="hero-condition">
          <div class="hero-icon-large">${this.getWeatherIconSVG(
            activeDay.weather[0]._asset || activeDay.weather[0].icon,
            48,
            activeDay.weather[0].id,
            // dt for phase substitution: today uses the current weather's
            // dt (= now), forecast days use the mid-of-day slot's dt
            // (activeDay spreads from `mid` so .dt is that slot's time).
            activeDay.dt
          )}</div>
          <span class="hero-desc">${this.esc(activeDay.weather[0].description)}</span>
        </div>
        ${heroTempHTML}
        <div class="hero-feels-like">Feels like ${this.formatTemp(activeDay.main.feels_like)}° - ${this.esc(breeze)}</div>
        <div class="precip-message">${precipMsg}</div>
      </section>

      <div class="stats-pager" id="stats-pager">
        <section class="quick-stats-grid">
          ${statsPages[this._statsPageIdx] || ''}
        </section>
      </div>

      <section class="day-detail-section">
        <div class="graph-container" id="graph-container"></div>
      </section>
      </div>

      <!-- Right-column wrapper: hourly bar + 8-day hi/lo list. See
           comment on .dashboard-left above for why both columns are
           wrapped. -->
      <div class="dashboard-right">
      <section class="hourly-scroll">
        ${dailyData.map((day, dayIdx) => `
          ${dayIdx > 0 ? '<div class="hourly-day-divider"></div>' : ''}
          ${day.hourly.map(h => `
            <div class="hourly-tile ${dayIdx === currentDayIdx ? 'active-day' : ''}" data-day-index="${dayIdx}">
              <span class="hourly-time">${this.formatTime(h.dt, true, state.timezone)}</span>
              <span class="hourly-icon">${this.getWeatherIconSVG(h.weather[0].icon, 28, h.weather[0].id, h.dt)}</span>
              <span class="hourly-temp">${this.formatTemp(h.main.temp)}°</span>
            </div>
          `).join('')}
        `).join('')}
      </section>

      <section class="daily-list">
        ${dailyData.slice(0, 8).map((d, i) => {
          // Derive the weekday/date strings from the canonical dayKey so the
          // label can never disagree with the entry's date (which used to
          // happen when re-shifting dt back through state.timezone).
          const [yy, mm, dd] = d.key.split('-').map(Number);
          const date = new Date(Date.UTC(yy, mm, dd));
          const isThisDayToday = d.key === todayKey;
          const dayName = isThisDayToday
            ? 'Today'
            : date.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
          const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
          // Round AFTER converting to the user's unit to avoid compounding errors.
          const maxTemp = Math.round(this.convertTemp(Math.max(...d.temps)));
          const minTemp = Math.round(this.convertTemp(Math.min(...d.temps)));
          // Most-notable-weather icon for the day (storm > snow > rain >
          // dust/haze > clouds > clear), tie-broken by closeness to
          // local noon. Identical picker as the hero, so tapping this
          // row slides into a matching hero illustration.
          const notable = notableSlotFor(d);
          const icon = (notable && notable.weather && notable.weather[0])
            ? this._weatherAssetName(notable.weather[0].icon, notable.weather[0].id)
            : (d.icons[Math.floor(d.icons.length / 2)] || d.icons[0]);
          const isActive = selectedDayIndex === i || (isToday && i === 0);

          return `
            <div class="daily-item ${isActive ? 'active' : ''}" data-index="${i}">
              <div class="daily-day-date">
                <span class="daily-day">${dayName}</span>
                <span class="daily-date">${dateStr}</span>
              </div>
              <div class="daily-right">
                <span class="daily-temps">${maxTemp}° / ${minTemp}°</span>
                <span class="daily-icon">${this.getWeatherIconSVG(icon, 24, null, d.dt)}</span>
              </div>
            </div>
          `;
        }).join('')}
      </section>
      </div>
    `;

    // Capture the existing hourly scroll position BEFORE we blow away the
    // DOM, so a same-city re-render (background refresh, day switch) can
    // keep the user's scroll exactly where it was.
    const prevHourly = this.weatherView.querySelector('.hourly-scroll');
    const prevHourlyScrollLeft = prevHourly ? prevHourly.scrollLeft : null;
    const cityChanged = this._renderedCityName !== cityName;
    this._renderedCityName = cityName;

    this.weatherView.innerHTML = html;

    // Drive the ambient background-effects layer from whatever icon the
    // hero just landed on. Picks among fx-clouds / fx-rain / fx-snow /
    // fx-thunder / fx-fog / fx-haze / fx-smoke / fx-dust based on the
    // resolved asset name; clear-day / clear-night / moon-* deliberately
    // map to no effect (a clear sky has nothing to drift past).
    this.applyWeatherFX(
      (activeDay.weather && activeDay.weather[0] && activeDay.weather[0]._asset) ||
      this._weatherAssetName(
        activeDay.weather && activeDay.weather[0] ? activeDay.weather[0].icon : '',
        activeDay.weather && activeDay.weather[0] ? activeDay.weather[0].id   : null
      ),
      // Pass wind so cloud/fog/dust drift direction matches the actual
      // wind direction (and speed scales animation duration).
      activeDay.wind,
      // Pass the OWM weather id so the fx picker can distinguish light
      // rain / drizzle (sparse drops) from heavier rain (denser drops).
      activeDay.weather && activeDay.weather[0] ? activeDay.weather[0].id : null
    );

    this.weatherView.querySelectorAll('.daily-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.getAttribute('data-index'));
        if (idx === currentDayIdx) return;
        const direction = idx > currentDayIdx ? 'next' : 'prev';
        const finishHeroSlide = this.captureDayRowForHeroSlide(el);
        this.changeDayWithGraphCube(idx, direction, onDayClick);
        if (finishHeroSlide) finishHeroSlide();
      });
    });

    // Position the hourly scroll: preserve user's scroll on same-city
    // re-renders, otherwise center on the active day's first tile so a
    // city change or click-driven day change always frames the right day.
    const hourlyEl = this.weatherView.querySelector('.hourly-scroll');
    if (hourlyEl) {
      // Suppress the scroll-into-new-day handler in _bindHourlyDayScroll
      // for a beat after we set scrollLeft programmatically. Without this,
      // clicking the LAST day in the daily list runs into a feedback loop:
      // we try to scroll the hourly bar to that day's first tile, but
      // there aren't enough tiles after it to fill the bar so the browser
      // silently CLAMPS scrollLeft to its max — short of the target tile.
      // The scroll event from that clamp fires, the handler sees a tile
      // from the second-to-last day as the leading tile, and bounces the
      // user back to that day. The 600ms window comfortably outlasts the
      // 180ms debounce in the scroll handler.
      this._suppressScrollDayChangeUntil = Date.now() + 600;
      if (!cityChanged && prevHourlyScrollLeft != null && !this._snapHourlyToActiveDay) {
        hourlyEl.scrollLeft = prevHourlyScrollLeft;
      } else {
        const firstActiveTile = hourlyEl.querySelector(`.hourly-tile[data-day-index="${currentDayIdx}"]`);
        if (firstActiveTile) hourlyEl.scrollLeft = firstActiveTile.offsetLeft;
      }
      this._snapHourlyToActiveDay = false;
      this._bindHourlyDayScroll(hourlyEl, currentDayIdx, onDayClick);
    }

    this.renderGraph(activeDay.hourly, state.timezone, state.omHourly || []);

    // Swipe the temperature graph left/right to move through the days.
    const maxIdx = Math.min(7, dailyData.length - 1);
    this._bindGraphSwipe(currentDayIdx, maxIdx, onDayClick);

    // Horizontal swipe on the quick-stats grid pages through extra items
    // (anything beyond the first 6) using a 3D cube transition. Loops.
    this._bindStatsSwipe();
  },

  // Horizontal swipe on the quick-stats pager → cube-flip to next/prev page.
  // We bind on the pager wrapper (block element) rather than the grid itself
  // so the cube perspective isn't placed as a single grid cell.
  _bindStatsSwipe() {
    if (!this._statsPages || this._statsPages.length <= 1) return;
    const el = document.getElementById('stats-pager');
    if (!el) return;

    const THRESHOLD = 50;
    const SLOP      = 1.2;
    let startX = 0, startY = 0, pointerId = null, tracking = false, peeking = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
      tracking = true;
      peeking = false;
    });

    el.addEventListener('pointermove', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!peeking && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * SLOP) {
        peeking = true;
      }
      if (peeking) {
        if (e.cancelable) e.preventDefault();
        el.style.transform = `translateX(${dx * 0.2}px)`;
      }
    }, { passive: false });

    const reset = () => {
      el.style.transition = 'transform 0.2s ease';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; }, 220);
    };

    el.addEventListener('pointerup', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      const wasPeeking = peeking;
      reset();
      if (!wasPeeking) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) < THRESHOLD) return;
      this._changeStatsPage(dx < 0 ? 'next' : 'prev');
    });

    el.addEventListener('pointercancel', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      el.style.transform = '';
    });
  },

  // Flip to the next or previous stats page with a 3D cube rotation.
  // Wraps at both ends.
  _changeStatsPage(direction) {
    if (this._statsCubeAnimating) return;
    const total = this._statsPages.length;
    if (total <= 1) return;

    const newIdx = direction === 'next'
      ? (this._statsPageIdx + 1) % total
      : (this._statsPageIdx - 1 + total) % total;

    const el = document.getElementById('stats-pager');
    if (!el) return;

    // Each cube face contains its own full <section class="quick-stats-grid">
    // so the grid styling is self-contained inside the face.
    const wrapPage = (cells) => `<section class="quick-stats-grid">${cells}</section>`;
    const oldHTML = el.innerHTML;
    const newHTML = wrapPage(this._statsPages[newIdx]);
    this._statsPageIdx = newIdx;

    this._statsCubeAnimating = true;
    this.runElementCubeTransition(el, oldHTML, newHTML, direction)
      .finally(() => { this._statsCubeAnimating = false; });
  },

  // Watch the hourly-scroll for the user scrolling into another day's
  // tiles. When the leading visible tile belongs to a different day,
  // trigger the same cube transition we use for tap/swipe day changes.
  // Also wires desktop mouse-wheel → horizontal scroll so users without
  // touchscreens can advance the bar.
  _bindHourlyDayScroll(hourlyEl, currentDayIdx, onDayClick) {
    // Vertical mouse-wheel → horizontal scroll. Trackpad two-finger
    // horizontal swipes (deltaX dominant) are left alone for native handling.
    hourlyEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      hourlyEl.scrollLeft += e.deltaY;
    }, { passive: false });

    let pendingId = null;
    const onScroll = () => {
      if (pendingId) clearTimeout(pendingId);
      pendingId = setTimeout(() => {
        pendingId = null;
        // Skip if this scroll event was triggered by our own programmatic
        // scrollLeft set in renderDashboard (snap-to-active-day). See the
        // long comment there for why this matters — clicking the LAST day
        // would otherwise bounce back to the second-to-last.
        if (this._suppressScrollDayChangeUntil &&
            Date.now() < this._suppressScrollDayChangeUntil) return;
        const tiles = hourlyEl.querySelectorAll('.hourly-tile');
        if (!tiles.length) return;
        const left = hourlyEl.scrollLeft;
        let leading = null;
        for (const tile of tiles) {
          if (tile.offsetLeft >= left - 8) { leading = tile; break; }
        }
        if (!leading) leading = tiles[tiles.length - 1];
        const newDayIdx = parseInt(leading.getAttribute('data-day-index'));
        if (newDayIdx === currentDayIdx) return;
        const direction = newDayIdx > currentDayIdx ? 'next' : 'prev';
        // Same hi/lo → hero slide animation we run on daily-row taps and
        // graph swipes. Capture the target day's row BEFORE the
        // re-render (so the source rects are still in the live DOM),
        // then trigger the day change, then run the continuation which
        // mounts the flying ghost on top of the freshly-rendered hero.
        const targetRow = this.weatherView.querySelector(
          `.daily-item[data-index="${newDayIdx}"]`
        );
        const finishHeroSlide = this.captureDayRowForHeroSlide(targetRow);
        // Scroll-driven → preserve scroll position across the re-render.
        this.changeDayWithGraphCube(newDayIdx, direction, onDayClick, false);
        if (finishHeroSlide) finishHeroSlide();
      }, 180);
    };
    hourlyEl.addEventListener('scroll', onScroll, { passive: true });
  },

  // Run a 3D cube-rotation transition between two dashboards. The current
  // contents of #weather-view (the NEW city, which the caller has already
  // rendered) are moved onto one side of the cube; the supplied snapshot of
  // the OLD city goes on the front face. Resolves once the rotation
  // completes and the new content has been restored to #weather-view with
  // its event listeners intact.
  //
  //   direction = 'next' → cube rotates left, new city was on the right face
  //   direction = 'prev' → cube rotates right, new city was on the left face
  async runCubeTransition(oldClone, direction) {
    if (!this.weatherView.firstChild) return; // nothing new to show

    // Landscape two-column layout: animate each column on its own cube,
    // rotating in parallel — looks like two cards flipping side by side
    // instead of one big cube swallowing the whole dashboard.
    const isTwoColumn = getComputedStyle(this.weatherView).display === 'grid';
    if (isTwoColumn) {
      const oldLeft  = oldClone.querySelector('.dashboard-left');
      const oldRight = oldClone.querySelector('.dashboard-right');
      const newLeft  = this.weatherView.querySelector('.dashboard-left');
      const newRight = this.weatherView.querySelector('.dashboard-right');
      if (oldLeft && oldRight && newLeft && newRight) {
        return this._runTwoColumnCubeTransition(oldLeft, oldRight, newLeft, newRight, direction);
      }
      // Fall through to single-cube if the wrappers somehow aren't present
      // (older cached DOM, etc.) — better to play any animation than none.
    }

    const isNext = direction === 'next';

    // Use the taller of the two so neither face gets clipped during the spin.
    const oldHeight = oldClone.offsetHeight ||
      Array.from(oldClone.childNodes).reduce((h, n) => h + (n.offsetHeight || 0), 0);
    const newHeight = this.weatherView.offsetHeight;
    const stageHeight = Math.max(oldHeight, newHeight, 400);

    const perspective = document.createElement('div');
    perspective.className = 'cube-perspective';
    perspective.style.height = `${stageHeight}px`;

    const stage = document.createElement('div');
    stage.className = 'cube-stage';

    const front = document.createElement('div');
    front.className = 'cube-face cube-face-front';
    while (oldClone.firstChild) front.appendChild(oldClone.firstChild);

    const back = document.createElement('div');
    back.className = 'cube-face ' + (isNext ? 'cube-face-right' : 'cube-face-left');
    // Move the freshly-rendered NEW dashboard onto the cube's incoming face.
    // We move (not clone) the children so their event listeners survive.
    while (this.weatherView.firstChild) back.appendChild(this.weatherView.firstChild);

    stage.appendChild(front);
    stage.appendChild(back);
    perspective.appendChild(stage);
    this.weatherView.appendChild(perspective);

    return new Promise((resolve) => {
      // Force a layout, then on the next frame trigger the rotation so the
      // transition actually plays (rather than collapsing into one frame).
      // eslint-disable-next-line no-unused-expressions
      stage.offsetHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          stage.classList.add(isNext ? 'rotate-left' : 'rotate-right');
        });
      });

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        // Restore the new dashboard's nodes to weather-view so the rest of
        // the app continues to find them via getElementById/querySelector.
        while (back.firstChild) this.weatherView.appendChild(back.firstChild);
        perspective.remove();
        resolve();
      };
      stage.addEventListener('transitionend', finish, { once: true });
      // Fallback in case transitionend doesn't fire (e.g. tab backgrounded).
      setTimeout(finish, 800);
    });
  },

  // Landscape (two-column) variant of the city-swipe cube. Builds two
  // independent cubes — one per column — and rotates them in parallel,
  // so visually each half of the dashboard spins as its own card.
  //
  //   oldLeft/oldRight  — column wrappers cloned from the OUTGOING DOM
  //                       (detached nodes inside oldClone). Move them
  //                       onto each cube's front face.
  //   newLeft/newRight  — the live wrappers currently mounted under
  //                       #weather-view. Moving them onto the cube backs
  //                       takes them out of the grid while the cube
  //                       animates; we put them back when it's done.
  //
  // Per-column --cube-half is set from the measured wrapper width so
  // the 3D depth math is correct for each column's actual width (rather
  // than the global 50vw / 250px default, which assumes the portrait
  // layout's ~500px-wide single cube).
  async _runTwoColumnCubeTransition(oldLeft, oldRight, newLeft, newRight, direction) {
    const isNext = direction === 'next';
    const rotateClass   = isNext ? 'rotate-left' : 'rotate-right';
    const backFaceClass = isNext ? 'cube-face-right' : 'cube-face-left';

    const buildColumn = (oldCol, newCol, gridColumn) => {
      // Measure BEFORE moving, while the new column is still in the
      // grid — once detached its offsetWidth/Height go to 0.
      const colWidth = newCol.offsetWidth || oldCol.offsetWidth || 300;
      const stageHeight = Math.max(
        oldCol.offsetHeight || 0,
        newCol.offsetHeight || 0,
        200
      );

      const perspective = document.createElement('div');
      perspective.className = 'cube-perspective';
      perspective.style.gridColumn = gridColumn;
      perspective.style.gridRow = '1';
      perspective.style.height = `${stageHeight}px`;
      perspective.style.setProperty('--cube-half', `${colWidth / 2}px`);

      const stage = document.createElement('div');
      stage.className = 'cube-stage';

      const front = document.createElement('div');
      front.className = 'cube-face cube-face-front';
      front.appendChild(oldCol);

      const back = document.createElement('div');
      back.className = 'cube-face ' + backFaceClass;
      back.appendChild(newCol);

      stage.appendChild(front);
      stage.appendChild(back);
      perspective.appendChild(stage);
      return { perspective, stage };
    };

    const left  = buildColumn(oldLeft,  newLeft,  '1');
    const right = buildColumn(oldRight, newRight, '2');

    this.weatherView.appendChild(left.perspective);
    this.weatherView.appendChild(right.perspective);

    return new Promise((resolve) => {
      // Force layout, then rotate on the next frame so the transition
      // actually plays rather than collapsing into one frame.
      // eslint-disable-next-line no-unused-expressions
      left.stage.offsetHeight; right.stage.offsetHeight;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          left.stage.classList.add(rotateClass);
          right.stage.classList.add(rotateClass);
        });
      });

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        // Restore the new wrappers back into weather-view so the rest
        // of the app continues to find them via querySelector. Grid
        // placement is by class (.dashboard-left → col 1, etc.), so
        // append order doesn't matter.
        this.weatherView.appendChild(newLeft);
        this.weatherView.appendChild(newRight);
        left.perspective.remove();
        right.perspective.remove();
        resolve();
      };
      // Listen on one stage — both finish on the same frame since the
      // transition duration / easing are identical.
      left.stage.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 800);
    });
  },

  // FLIP-style slide: capture position + computed type metrics of the
  // clicked (or swiped-to) daily row's temps and icon BEFORE the re-render,
  // and return a continuation that, once the new hero is in the DOM, floats
  // ghost clones from the row up to the hero's high/low and icon slots.
  //
  // The ghost is anchored to the hero's center and animates two things in
  // parallel: a transform translation (centers travel from row → hero) and
  // the *real* font-size / svg dimensions (text grows smoothly instead of
  // being scaled bitmap-style). When the transition lands the ghost it is
  // already at the hero's exact computed type metrics, so swapping it for
  // the real hero element produces no visible pop.
  captureDayRowForHeroSlide(rowEl) {
    if (!rowEl) return null;
    const srcTemps = rowEl.querySelector('.daily-temps');
    const srcIcon  = rowEl.querySelector('.daily-icon');
    // Weather icons render as <img> now (was inline <svg>); animation
    // logic below targets the img element for width/height transitions.
    const srcIconSvg = srcIcon && srcIcon.querySelector('img, svg');
    if (!srcTemps || !srcIcon || !srcIconSvg) return null;

    let  tempsRect = srcTemps.getBoundingClientRect();
    const iconRect = srcIcon.getBoundingClientRect();
    let  tempsHTML = srcTemps.outerHTML;
    const iconHTML = srcIcon.outerHTML;
    const rowIndex = rowEl.getAttribute('data-index');

    // The hero shows a single current temp on Today, but two numbers
    // (high / low) on every other day. When the user taps the Today row,
    // flying the row's "hi° / lo°" up and then snapping it into the
    // single hero number looks like a pop. Detect the Today row by its
    // label text and rebuild the ghost source as just the high number,
    // anchored to the high number's actual rect (via Range) so it
    // launches from the right spot instead of the full "hi / lo" left
    // edge.
    const dayLabel = rowEl.querySelector('.daily-day');
    const isTodayRow = !!(dayLabel && dayLabel.textContent.trim() === 'Today');
    if (isTodayRow) {
      const fullText = srcTemps.textContent || '';
      // Row format from the renderer is `${max}° / ${min}°` — split on
      // " /" so we keep the degree glyph attached to the high number.
      const sepIdx = fullText.indexOf(' /');
      const highText = sepIdx > -1 ? fullText.slice(0, sepIdx) : fullText;

      const textNode = srcTemps.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE && highText.length > 0) {
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(highText.length, textNode.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0) tempsRect = r;
      }
      tempsHTML = `<span class="daily-temps">${this.esc(highText)}</span>`;
    }

    const srcTempsCS = getComputedStyle(srcTemps);
    const srcIconCS  = getComputedStyle(srcIconSvg);
    const srcTempsFS    = srcTempsCS.fontSize;
    const srcTempsWeight = srcTempsCS.fontWeight;
    const srcSvgSize    = srcIconCS.width; // square

    return () => {
      const heroTemp = this.weatherView.querySelector('.hero-temp-large');
      const heroIcon = this.weatherView.querySelector('.hero-icon-large');
      const heroIconSvg = heroIcon && heroIcon.querySelector('img, svg');
      if (!heroTemp || !heroIcon || !heroIconSvg) return;

      const destTempRect = heroTemp.getBoundingClientRect();
      const destIconRect = heroIcon.getBoundingClientRect();
      const destTempCS   = getComputedStyle(heroTemp);
      const destIconCS   = getComputedStyle(heroIconSvg);
      const destTempsFS    = destTempCS.fontSize;
      const destTempsWeight = destTempCS.fontWeight;
      const destSvgSize    = destIconCS.width;

      heroTemp.classList.add('hero-slide-hidden');
      heroIcon.classList.add('hero-slide-hidden');

      const newRow = this.weatherView.querySelector(`.daily-item[data-index="${rowIndex}"]`);
      const newRowTemps = newRow && newRow.querySelector('.daily-temps');
      const newRowIcon  = newRow && newRow.querySelector('.daily-icon');
      if (newRowTemps) newRowTemps.classList.add('hero-slide-hidden');
      if (newRowIcon)  newRowIcon.classList.add('hero-slide-hidden');

      // Anchor: position the ghost so its center sits exactly on the hero
      // element's center, then translate by (src - dest) to start it on the
      // row. Animating the translation back to (0,0) lands it on the hero
      // regardless of how the ghost's auto-sizing reflows mid-animation.
      const makeGhost = (html, srcRect, destRect, applyStart, applyEnd) => {
        const ghost = document.createElement('div');
        ghost.className = 'day-slide-ghost';
        const destCX = destRect.left + destRect.width  / 2;
        const destCY = destRect.top  + destRect.height / 2;
        const srcCX  = srcRect.left  + srcRect.width   / 2;
        const srcCY  = srcRect.top   + srcRect.height  / 2;
        ghost.style.left = `${destCX}px`;
        ghost.style.top  = `${destCY}px`;
        ghost.innerHTML = html;
        const inner = ghost.firstElementChild;
        applyStart(inner);
        // Centered on dest, offset back to src for frame 0.
        ghost.style.transform = `translate(calc(-50% + ${srcCX - destCX}px), calc(-50% + ${srcCY - destCY}px))`;
        document.body.appendChild(ghost);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            ghost.classList.add('day-slide-ghost--flying');
            ghost.style.transform = 'translate(-50%, -50%)';
            applyEnd(inner);
          });
        });
        return ghost;
      };

      const tempsGhost = makeGhost(
        tempsHTML, tempsRect, destTempRect,
        (inner) => {
          inner.style.fontSize   = srcTempsFS;
          inner.style.fontWeight = srcTempsWeight;
        },
        (inner) => {
          inner.style.fontSize   = destTempsFS;
          inner.style.fontWeight = destTempsWeight;
        },
      );

      const iconGhost = makeGhost(
        iconHTML, iconRect, destIconRect,
        (inner) => {
          const svg = inner.querySelector('img, svg');
          if (svg) { svg.style.width = srcSvgSize; svg.style.height = srcSvgSize; }
        },
        (inner) => {
          const svg = inner.querySelector('img, svg');
          if (svg) { svg.style.width = destSvgSize; svg.style.height = destSvgSize; }
        },
      );

      const cleanup = () => {
        tempsGhost.remove();
        iconGhost.remove();
        heroTemp.classList.remove('hero-slide-hidden');
        heroIcon.classList.remove('hero-slide-hidden');
        if (newRowTemps) newRowTemps.classList.remove('hero-slide-hidden');
        if (newRowIcon)  newRowIcon.classList.remove('hero-slide-hidden');
      };
      setTimeout(cleanup, 560);
    };
  },

  // Switch to a different forecast day and play the graph's 3D cube
  // rotation between the outgoing and incoming chart. Used by both the
  // graph swipe gesture, clicks on the daily-list rows, and scroll-driven
  // day changes from the hourly bar.
  //
  // snapHourly = true → after re-render, scroll the hourly bar to frame
  //   the new active day's first tile (right for clicks/swipes from
  //   outside the hourly bar). false → preserve current scroll position
  //   (right for scroll-driven day changes initiated from within the bar).
  changeDayWithGraphCube(newIdx, direction, onDayClick, snapHourly = true) {
    const graphEl = document.getElementById('graph-container');
    if (!graphEl || this._graphCubeAnimating) {
      this._snapHourlyToActiveDay = snapHourly;
      onDayClick(newIdx);
      return;
    }
    const oldGraphHTML = graphEl.innerHTML;
    this._snapHourlyToActiveDay = snapHourly;
    onDayClick(newIdx); // re-renders dashboard; #graph-container now holds the new SVG

    const newEl = document.getElementById('graph-container');
    if (!newEl) return;
    const newGraphHTML = newEl.innerHTML;

    this._graphCubeAnimating = true;
    this.runElementCubeTransition(newEl, oldGraphHTML, newGraphHTML, direction)
      .finally(() => { this._graphCubeAnimating = false; });
  },

  // Cube transition scoped to a single element — used for the temperature
  // graph so that only the chart itself rotates when the user swipes to
  // another day. oldHTML and newHTML are inner-HTML snapshots (pure SVG
  // markup, no event listeners to preserve), so we just swap text content.
  async runElementCubeTransition(targetEl, oldHTML, newHTML, direction) {
    if (!targetEl) return;
    const isNext = direction === 'next';
    const height = targetEl.offsetHeight || 200;

    const perspective = document.createElement('div');
    perspective.className = 'cube-perspective';
    perspective.style.height = `${height}px`;

    const stage = document.createElement('div');
    stage.className = 'cube-stage';

    const front = document.createElement('div');
    front.className = 'cube-face cube-face-front';
    front.innerHTML = oldHTML;

    const back = document.createElement('div');
    back.className = 'cube-face ' + (isNext ? 'cube-face-right' : 'cube-face-left');
    back.innerHTML = newHTML;

    stage.appendChild(front);
    stage.appendChild(back);
    perspective.appendChild(stage);

    // Replace the element's content with the cube while we animate.
    targetEl.innerHTML = '';
    targetEl.appendChild(perspective);

    return new Promise((resolve) => {
      // eslint-disable-next-line no-unused-expressions
      stage.offsetHeight; // force reflow so the transition actually plays
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          stage.classList.add(isNext ? 'rotate-left' : 'rotate-right');
        });
      });

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        targetEl.innerHTML = newHTML;
        resolve();
      };
      stage.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 800);
    });
  },

  // Horizontal swipe anywhere ABOVE the temperature graph cycles through
  // the user's saved-locations list. Bound once at app init.
  bindCitySwipe(onSwipe) {
    if (this._citySwipeBound) return;
    this._citySwipeBound = true;

    const THRESHOLD = 50;
    const SLOP      = 1.2; // dx must beat dy by this factor → horizontal
    let startX = 0, startY = 0, pointerId = null, tracking = false, peeking = false;
    let nudgeTargets = null;

    const liveTargets = () => {
      // Translate the chrome above the graph during the swipe for tactile
      // feedback — header location chip, hero block, quick-stats grid.
      return [
        document.querySelector('.location-display'),
        document.querySelector('.hero-section'),
        document.querySelector('.quick-stats-grid')
      ].filter(Boolean);
    };

    document.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Don't trigger from inside an overlay (locations / menu / units).
      if (e.target.closest('.overlay-screen')) return;
      // Don't trigger from interactive controls — they should still tap.
      if (e.target.closest('button, input, a')) return;
      // The quick-stats pager has its own swipe handler that pages between
      // stat groups — don't also fire the city swipe from there.
      if (e.target.closest('.stats-pager, .quick-stats-grid')) return;

      // Only above the temperature graph counts.
      const graph = document.getElementById('graph-container');
      if (graph) {
        const r = graph.getBoundingClientRect();
        if (e.clientY >= r.top) return;
      }

      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
      tracking = true;
      peeking = false;
      nudgeTargets = null;
    });

    document.addEventListener('pointermove', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!peeking && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * SLOP) {
        peeking = true;
        nudgeTargets = liveTargets();
      }
      if (peeking) {
        if (e.cancelable) e.preventDefault();
        const t = `translateX(${dx * 0.2}px)`;
        nudgeTargets.forEach(el => { el.style.transform = t; });
      }
    }, { passive: false });

    const reset = () => {
      if (nudgeTargets) {
        nudgeTargets.forEach(el => {
          el.style.transition = 'transform 0.2s ease';
          el.style.transform = '';
          setTimeout(() => { el.style.transition = ''; }, 220);
        });
        nudgeTargets = null;
      }
    };

    document.addEventListener('pointerup', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      const wasPeeking = peeking;
      reset();
      if (!wasPeeking) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) < THRESHOLD) return;
      onSwipe(dx < 0 ? 'next' : 'prev');
    });

    document.addEventListener('pointercancel', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      reset();
    });
  },

  _bindGraphSwipe(currentIdx, maxIdx, onDayClick) {
    const el = document.getElementById('graph-container');
    if (!el) return;

    const THRESHOLD = 50;     // px of horizontal travel to count as a swipe
    const SLOP      = 1.2;    // dx must beat dy by this factor to be horizontal
    let startX = 0, startY = 0, pointerId = null, tracking = false, peeking = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
      tracking = true;
      peeking = false;
    });

    el.addEventListener('pointermove', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Only take over the gesture once it's clearly horizontal.
      if (!peeking && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * SLOP) {
        peeking = true;
      }
      if (peeking) {
        if (e.cancelable) e.preventDefault();
        // Slight follow-the-finger nudge for tactile feedback.
        el.style.transform = `translateX(${dx * 0.25}px)`;
      }
    }, { passive: false });

    const finish = (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      el.style.transition = 'transform 0.2s ease';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; }, 220);

      if (!peeking) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) < THRESHOLD) return;

      // Wrap around the ends: last day + swipe-left → first; first + swipe-right → last.
      const dayCount = maxIdx + 1;
      const next = dx < 0
        ? (currentIdx + 1) % dayCount
        : (currentIdx - 1 + dayCount) % dayCount;
      if (next === currentIdx) return;
      const dir = dx < 0 ? 'next' : 'prev';
      const targetRow = this.weatherView.querySelector(`.daily-item[data-index="${next}"]`);
      const finishHeroSlide = this.captureDayRowForHeroSlide(targetRow);
      this.changeDayWithGraphCube(next, dir, onDayClick);
      if (finishHeroSlide) finishHeroSlide();
    };

    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      el.style.transform = '';
    });
  },

  renderGraph(hourlyData, offset = 0, hourlyPrecip = []) {
    const container = document.getElementById('graph-container');
    if (!container) return;

    // Remember the latest data so we can redraw on resize/visibility changes.
    this._lastGraph = { hourly: hourlyData, offset, hourlyPrecip };

    const width = container.clientWidth;
    if (!width) return; // container hidden (e.g. behind an overlay); skip until visible
    const height = 180;
    const paddingX = 40;
    const paddingY = 40;

    // Build an hour → mm lookup from Open-Meteo's hourly precipitation
    // (true 1h resolution). Falls back to OWM's 3h-divided-by-3 estimate
    // for any hour the lookup doesn't cover.
    const precipByHour = new Map();
    for (const h of hourlyPrecip) {
      precipByHour.set(Math.floor(h.dt / 3600), h.precipMM);
    }
    const fallback3hPerHour = (p) => (p && p.rain && p.rain['3h']) ? p.rain['3h'] / 3 : 0;

    // Interpolate OWM's 3-hour temperature data to 1-hour steps. The precip
    // value for each 1h bar now comes from Open-Meteo's hourly series, not
    // a 3h spread.
    const hourly = [];
    for (let i = 0; i < hourlyData.length - 1; i++) {
      const p1 = hourlyData[i];
      const p2 = hourlyData[i + 1];
      const t1 = p1.main.temp;
      const t2 = p2.main.temp;
      const fallback = fallback3hPerHour(p1);

      for (let h = 0; h < 3; h++) {
        const dt = p1.dt + (h * 3600);
        const ratio = h / 3;
        const hourKey = Math.floor(dt / 3600);
        const precip = precipByHour.has(hourKey) ? precipByHour.get(hourKey) : fallback;
        hourly.push({
          temp: t1 + (t2 - t1) * ratio,
          precipPerHour: precip,
          dt,
          isOriginal: h === 0
        });
      }
    }
    const last = hourlyData[hourlyData.length - 1];
    const lastHourKey = Math.floor(last.dt / 3600);
    const lastPrecip = precipByHour.has(lastHourKey)
      ? precipByHour.get(lastHourKey)
      : fallback3hPerHour(last);
    hourly.push({
      temp: last.main.temp,
      precipPerHour: lastPrecip,
      dt: last.dt,
      isOriginal: true
    });

    const temps = hourly.map(h => this.convertTemp(h.temp));
    let minTemp = Math.min(...temps) - 2;
    let maxTemp = Math.max(...temps) + 2;
    let tempRange = maxTemp - minTemp;
    if (!isFinite(tempRange) || tempRange < 0.1) tempRange = 1; // guard divide-by-zero

    const precipData = hourly.map(h => h.precipPerHour);
    const peakPrecipPerHour = Math.max(...precipData);
    const hasRain = peakPrecipPerHour > 0;
    // Scale precipitation by mm-per-hour (consistent with axis labels)
    const maxPrecip = Math.max(peakPrecipPerHour, 2);

    const points = hourly.map((h, i) => {
      const tempC = this.convertTemp(h.temp);
      const x = paddingX + (i * (width - 2 * paddingX) / (hourly.length - 1));
      const yTemp = height - paddingY - ((tempC - minTemp) * (height - 2 * paddingY) / tempRange);
      const yPrecip = height - paddingY - (h.precipPerHour * (height - 2 * paddingY) / maxPrecip);
      return { x, yTemp, yPrecip, temp: h.temp, precip: h.precipPerHour, time: this.formatTime(h.dt, false, offset), isOriginal: h.isOriginal };
    });

    let pathD = `M ${points[0].x} ${points[0].yTemp}`;
    for (let i = 0; i < points.length - 1; i++) {
      const cp1x = points[i].x + (points[i+1].x - points[i].x) / 2;
      pathD += ` C ${cp1x} ${points[i].yTemp}, ${cp1x} ${points[i+1].yTemp}, ${points[i+1].x} ${points[i+1].yTemp}`;
    }

    const barWidth = (width - 2 * paddingX) / (hourly.length - 1);

    container.innerHTML = `
      <svg class="graph-svg" viewBox="0 0 ${width} ${height}">
        <line class="graph-guideline" x1="${paddingX}" y1="${height - paddingY}" x2="${width - paddingX}" y2="${height - paddingY}"></line>
        <line class="graph-guideline" x1="${paddingX}" y1="${paddingY}" x2="${width - paddingX}" y2="${paddingY}"></line>

        ${hasRain ? (() => {
          // Display the y-axis peak in the user's chosen precip unit.
          // The model stores mm/h internally; convert + format here so
          // the label matches what the user picked in Units → Precipitation.
          const precipUnit = Storage.getUnits().precip;
          const isInches = precipUnit === 'in';
          const peakDisplay = isInches
            ? (maxPrecip / 25.4).toFixed(2)
            : maxPrecip.toFixed(1);
          const unitLabel = isInches ? 'in/h' : 'mm/h';
          return `
            <text class="graph-y-axis-label" x="5" y="${paddingY + 5}">${peakDisplay}</text>
            <text class="graph-y-axis-label" x="5" y="${paddingY + 15}">${unitLabel}</text>
            <text class="graph-y-axis-label" x="5" y="${height - paddingY - 5}">0</text>
          `;
        })() : ''}

        ${points.map((p) => {
          if (p.precip === 0) return '';
          return `<rect class="graph-precip-bar" x="${p.x - barWidth/2}" y="${p.yPrecip}" width="${barWidth + 0.5}" height="${height - paddingY - p.yPrecip}"></rect>`;
        }).join('')}

        <path class="graph-path" d="${pathD}" fill="none" stroke="#ff7043" stroke-width="3"></path>

        ${points.map(p => {
          if (!p.isOriginal) return '';
          return `
            <rect class="graph-badge" x="${p.x - 12}" y="${p.yTemp - 25}" width="24" height="18" rx="4"></rect>
            <path d="M ${p.x - 4} ${p.yTemp - 7} L ${p.x} ${p.yTemp - 2} L ${p.x + 4} ${p.yTemp - 7} Z" fill="#ff7043"></path>
            <text class="graph-temp-badge-text" x="${p.x}" y="${p.yTemp - 12}">${this.formatTemp(p.temp)}°</text>
            <text class="graph-time-text" x="${p.x}" y="${height - 10}">${p.time}</text>
          `;
        }).join('')}
      </svg>
    `;
  },

  renderSavedLocations(list, onSelect, onDelete, onReorder) {
    if (!list || list.length === 0) {
      this.savedLocationsList.innerHTML = '<div style="color: #a0a0a0; text-align: center; padding: 20px;">No saved locations.</div>';
      return;
    }

    this.savedLocationsList.innerHTML = list.map((item, index) => `
      <div class="location-card" data-index="${index}">
        <div class="location-card-name">${this.esc(this.prettifyLocationName(item.name))}</div>
        <button class="delete-location-btn" data-index="${index}" aria-label="Delete location">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `).join('');

    this._bindCardInteractions(list, onSelect, onReorder);

    this.savedLocationsList.querySelectorAll('.delete-location-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete(parseInt(btn.getAttribute('data-index')));
      });
    });
  },

  // Pointer-Events reorder handler for the saved-locations list.
  //
  // Cards default to `touch-action: pan-y` so the list scrolls normally.
  // Drag-to-reorder must be intentionally invoked:
  //   - Mouse: press + move past 6px → drag immediately.
  //   - Touch: press and hold 1s without significant movement → drag mode;
  //     any earlier movement cancels the timer and lets the browser scroll.
  // Once drag mode begins, pointermove preventDefault()s to claim the
  // gesture (the browser hasn't committed to a scroll yet because the
  // finger was still during the long-press).
  // Pointer-Events reorder handler for the saved-locations list.
  //
  // Cards have CSS `touch-action: none` so the browser doesn't claim
  // vertical touches for scrolling — vital because iOS Safari locks a
  // gesture's touch-action at pointerdown and won't re-evaluate later.
  //
  // Behaviour (same for mouse and touch):
  //   - Pointer up without crossing the movement threshold → tap → select.
  //   - Move past the threshold → enter drag mode, follow the pointer,
  //     show a drop indicator, commit on release.
  _bindCardInteractions(list, onSelect, onReorder) {
    const DRAG_THRESHOLD = 6; // px before press is treated as drag
    const cards = Array.from(this.savedLocationsList.querySelectorAll('.location-card'));

    const measure = () => cards.map(c => {
      const r = c.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, mid: r.top + r.height / 2, height: r.height };
    });

    cards.forEach(card => {
      const fromIdx = parseInt(card.getAttribute('data-index'));
      let suppressClick = false;
      let dragging = false;

      // Prevent scrolling when dragging is active
      card.addEventListener('touchmove', (e) => {
        if (dragging) e.preventDefault();
      }, { passive: false });

      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete-location-btn')) return;
        if (suppressClick) {
          suppressClick = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onSelect(list[fromIdx]);
      });

      card.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.delete-location-btn')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        const pointerId = e.pointerId;
        const startX    = e.clientX;
        const startY    = e.clientY;
        const isTouch   = e.pointerType !== 'mouse';

        dragging      = false;
        let rects     = null;
        let toIdx     = fromIdx;
        let indicator = null;
        let tiltDeg   = 0;
        let dragTimer = null;

        // Touch pointers are implicitly captured by their starting element,
        // and explicit capture can break native scrolling. Mouse needs it.
        if (!isTouch) {
          try { card.setPointerCapture?.(pointerId); } catch (_) {}
        }

        const enterDragMode = () => {
          if (dragging) return;
          dragging = true;
          rects = measure();
          card.classList.add('dragging');
          // Tilt toward the side being touched for tactile drag feedback.
          const cardRect = card.getBoundingClientRect();
          const cardCenterX = cardRect.left + cardRect.width / 2;
          tiltDeg = startX < cardCenterX ? -1.5 : 1.5;
          indicator = document.createElement('div');
          indicator.className = 'drop-indicator';
          this.savedLocationsList.appendChild(indicator);
          document.body.style.userSelect = 'none';
          if (isTouch && navigator.vibrate) navigator.vibrate(15);
        };

        if (isTouch) {
          dragTimer = setTimeout(() => enterDragMode(), 350);
        }

        const onMove = (ev) => {
          if (ev.pointerId !== pointerId) return;
          const dy = ev.clientY - startY;
          const dx = ev.clientX - startX;

          if (!dragging) {
            if (isTouch) {
              if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
                if (dragTimer) clearTimeout(dragTimer);
                dragTimer = null;
              }
              return;
            } else {
              if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
              enterDragMode();
            }
          }

          if (ev.cancelable) ev.preventDefault();

          card.style.transform = `translateY(${dy}px) rotateZ(${tiltDeg}deg)`;

          const y = ev.clientY;
          let insertAt = rects.length;
          for (let i = 0; i < rects.length; i++) {
            if (i === fromIdx) continue;
            if (y < rects[i].mid) { insertAt = i; break; }
          }
          if (insertAt > fromIdx) insertAt -= 1;
          toIdx = insertAt;

          const listRect = this.savedLocationsList.getBoundingClientRect();
          const visualIdx = toIdx >= fromIdx ? toIdx + 1 : toIdx;
          const indicatorY = visualIdx >= rects.length
            ? rects[rects.length - 1].bottom - listRect.top
            : rects[visualIdx].top - listRect.top;
          indicator.style.transform = `translateY(${indicatorY}px)`;
        };

        const cleanup = () => {
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.removeEventListener('pointercancel', onCancel);
          try { card.releasePointerCapture?.(pointerId); } catch (_) {}
        };

        const onUp = (ev) => {
          if (ev.pointerId !== pointerId) return;
          if (dragTimer) clearTimeout(dragTimer);
          cleanup();

          if (!dragging) return; // tap → click handler runs

          card.style.transform = '';
          card.classList.remove('dragging');
          document.body.style.userSelect = '';
          if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);

          suppressClick = true;
          setTimeout(() => { suppressClick = false; }, 250);

          if (toIdx !== fromIdx) onReorder(fromIdx, toIdx);
        };

        const onCancel = (ev) => {
          if (ev.pointerId !== pointerId) return;
          if (dragTimer) clearTimeout(dragTimer);
          cleanup();
          if (!dragging) return;
          card.style.transform = '';
          card.classList.remove('dragging');
          document.body.style.userSelect = '';
          if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
        };

        card.addEventListener('pointermove', onMove, { passive: false });
        card.addEventListener('pointerup', onUp);
        card.addEventListener('pointercancel', onCancel);
      });
    });
  }
};
