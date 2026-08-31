// Traditional Farmer's Almanac full-moon names by Gregorian month
// (0-indexed). A second full moon in the SAME UTC month is called a
// Blue Moon regardless of its own month position — that override is
// applied by _fullMoonAt() below.
const FULL_MOON_NAMES = [
  'Wolf Moon',       // Jan
  'Snow Moon',       // Feb
  'Worm Moon',       // Mar
  'Pink Moon',       // Apr
  'Flower Moon',     // May
  'Strawberry Moon', // Jun
  'Buck Moon',       // Jul
  'Sturgeon Moon',   // Aug
  'Harvest Moon',    // Sep
  "Hunter's Moon",   // Oct
  'Beaver Moon',     // Nov
  'Cold Moon'        // Dec
];

// Synodic PERIOD matches moonPhaseName()'s; the EPOCHS deliberately do
// not. moonPhaseName() anchors to the actual new moon (2000-01-06
// 18:14 UTC) while this anchors to the actual full moon (2000-01-21
// 04:41 UTC) — the real interval between them is ~8h off from half a
// mean synodic month (orbital eccentricity), and each feature is most
// accurate anchored to its own observed phase. Deriving one epoch from
// the other would shift every full-moon timestamp ~8h from reality.
const FULL_MOON_SYNODIC_DAYS = 29.530588853;
const FULL_MOON_REF_MS = Date.UTC(2000, 0, 21, 4, 41);

// Return the full moon at index k (relative to FULL_MOON_REF_MS) with
// its traditional name and Blue-Moon override. k=0 → 2000-01-21;
// k=326 → the Wolf Moon of 2026, etc. Pure function of k, so we can
// compute the two nearest to `now` in O(1) instead of iterating a
// 13-entry per-year table.
function _fullMoonAt(k) {
  const dtMs = FULL_MOON_REF_MS + k * FULL_MOON_SYNODIC_DAYS * 86400000;
  const d = new Date(dtMs);
  const month = d.getUTCMonth();
  // Blue Moon = second full moon inside the same UTC calendar month.
  // We only need to look back one synodic period since two full moons
  // in the same month is the only Blue-Moon condition.
  const prevMs = FULL_MOON_REF_MS + (k - 1) * FULL_MOON_SYNODIC_DAYS * 86400000;
  const prevMonth = new Date(prevMs).getUTCMonth();
  const name = (prevMonth === month) ? 'Blue Moon' : FULL_MOON_NAMES[month];
  return { name, dt: Math.round(dtMs / 1000) };
}

// The renderer only cares whether the CURRENT time is inside any
// full-moon-visible window; that window brackets a single full-moon
// peak. Return the 3 candidates closest to `nowDt` (prev / nearest /
// next) — one of them will always be the right one to test, regardless
// of what side of the peak `nowDt` lands on.
function getRelevantFullMoons(nowDtSec) {
  const nowMs = nowDtSec * 1000;
  const kNear = Math.round(
    (nowMs - FULL_MOON_REF_MS) / (FULL_MOON_SYNODIC_DAYS * 86400000)
  );
  return [_fullMoonAt(kNear - 1), _fullMoonAt(kNear), _fullMoonAt(kNear + 1)];
}

// WHO UV Index band boundaries, shared by the graph's UV mode. The same
// numbers uvLabel() names: 8+ is "Very High", 11+ is "Extreme".
const UV_VERY_HIGH = 8;
const UV_EXTREME = 11;

// Feature Toggle: Set to true to use a dynamic temperature-based color gradient,
// or false to revert to the default orange temperature line style.
const CONFIG_TEMP_LINE_COLOR = {
  enabled: true, // Set to false to revert to the original orange style
  keyframes: [
    { temp: 10, color: [13, 71, 161] },   // Deep Blue (#0d47a1) - 50°F
    { temp: 15, color: [0, 172, 193] },   // Cool Teal (#00acc1) - 59°F
    { temp: 20, color: [139, 195, 74] },  // Soft Green/T-shirt weather (#8bc34a) - 68°F
    { temp: 25, color: [255, 179, 0] },   // Warm Amber (#ffb300) - 77°F
    { temp: 30, color: [183, 28, 28] }    // Deep Red (#b71c1c) - 86°F
  ]
};

// Interpolates a temperature (in Celsius) to an RGB color based on keyframes.
function getTempColor(tempC) {
  const kf = CONFIG_TEMP_LINE_COLOR.keyframes;
  if (!kf || kf.length === 0) return '#ff7043';
  
  if (tempC <= kf[0].temp) {
    const c = kf[0].color;
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }
  if (tempC >= kf[kf.length - 1].temp) {
    const c = kf[kf.length - 1].color;
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }
  
  for (let i = 0; i < kf.length - 1; i++) {
    const k1 = kf[i];
    const k2 = kf[i+1];
    if (tempC >= k1.temp && tempC <= k2.temp) {
      const ratio = (tempC - k1.temp) / (k2.temp - k1.temp);
      const r = Math.round(k1.color[0] + (k2.color[0] - k1.color[0]) * ratio);
      const g = Math.round(k1.color[1] + (k2.color[1] - k1.color[1]) * ratio);
      const b = Math.round(k1.color[2] + (k2.color[2] - k1.color[2]) * ratio);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  return '#ff7043';
}

// Chevron for the quick-stats pager's edge arrows. One glyph, pointing
// left; the .next button mirrors it in CSS. 9px wide so it clears the
// grid's 16px side padding without ever reaching a stat's text.
const STATS_ARROW_SVG =
  '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" ' +
  'stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="15 5 8 12 15 19"></polyline></svg>';

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

  importExportScreen: document.getElementById('import-export-screen'),
  gotoImportExportBtn: document.getElementById('goto-import-export-btn'),
  importExportBackBtn: document.getElementById('import-export-back-btn'),
  exportDataBtn: document.getElementById('export-data-btn'),
  importDataBtn: document.getElementById('import-data-btn'),
  importExportTextarea: document.getElementById('import-export-textarea'),
  exportApiKeyCheckbox: document.getElementById('export-api-key-checkbox'),
  exportApiKeyContainer: document.getElementById('export-api-key-container'),
  copyClipboardBtn: document.getElementById('copy-clipboard-btn'),
  pasteClipboardBtn: document.getElementById('paste-clipboard-btn'),
  importExportFeedback: document.getElementById('import-export-feedback'),

  _resizeBound: false,
  _lastGraph: null,
  // Series the graph's switch last offered, in cycle order. Written by
  // renderGraph, read by _toggleGraphMode — T and U come and go with the
  // city and the day, so the cycle can't be re-derived at tap time.
  _graphCycle: null,
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
    // Stash for handlers that need to fire a unit change from outside
    // the Units screen (e.g. double-tap on the hero temp toggles °F/°C).
    this._onUnitChange = onUnitChange;
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
    const copyUrlBtn = document.getElementById('copy-url-btn');
    if (copyUrlBtn) {
      copyUrlBtn.addEventListener('click', () => {
        this.toggleScreen('main-menu', false);
        this.handleCopyURL();
      });
    }
    if (this.aboutBackBtn) this.aboutBackBtn.addEventListener('click', () => {
      this.closeOverlayWithCube('about-screen');
    });

    if (this.gotoImportExportBtn) this.gotoImportExportBtn.addEventListener('click', () => {
      this.toggleScreen('main-menu', false);
      this.toggleScreen('import-export', true);
    });
    if (this.importExportBackBtn) this.importExportBackBtn.addEventListener('click', () => {
      this.closeOverlayWithCube('import-export-screen');
    });

    // Close any open overlay on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      ['alerts', 'about', 'units', 'locations', 'main-menu', 'import-export'].forEach(s => {
        const el = document.getElementById(s + '-screen') || document.getElementById(s);
        if (el && el.classList.contains('open')) {
          if (['about', 'units', 'locations', 'import-export'].includes(s)) {
             this.closeOverlayWithCube(el.id);
          } else {
             this.toggleScreen(s, false);
          }
        }
      });
    });

    document.querySelectorAll('.segmented-control button').forEach(btn => {
      btn.addEventListener('click', () => {
        // Use the bound button, not e.target — if a button ever gains
        // an inner <span>/<svg>, e.target would be that child and the
        // old parentElement/getAttribute code persisted
        // units[null] = null.
        const control = btn.closest('.segmented-control');
        if (!control) return;
        const setting = control.getAttribute('data-setting');
        const value = btn.getAttribute('data-value');

        control.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (onUnitChange) onUnitChange(setting, value);
      });
    });

    // Re-render the graph if the window resizes (or an overlay closes
    // and reveals a previously-hidden zero-width container).
    if (!this._resizeBound) {
      window.addEventListener('resize', () => {
        if (this._lastGraph) this.renderGraph(
          this._lastGraph.hourly,
          this._lastGraph.tz,
          this._lastGraph.omHourly || [],
          this._lastGraph.opts || {}
        );
      });
      this._resizeBound = true;
    }

    // Accordion toggles on About screen
    this._bindAccordions();

    this.updateUnitControls();

    // BYOK (bring-your-own OpenWeatherMap key) controls live in the
    // About overlay. Bind them once at init so the status badge reflects
    // any pre-existing saved key on first paint.
    this._initByokPanel();

    // Custom right-click / long-press menu mirroring the hamburger menu.
    this._bindContextMenu();

    // Import/Export panel setup
    this._initImportExportPanel();
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

  _bindAccordions() {
    const screen = document.getElementById('about-screen');
    if (!screen) return;
    screen.querySelectorAll('.accordion-header').forEach(header => {
      header.addEventListener('click', () => {
        const item = header.parentElement;
        const isOpen = item.classList.contains('open');

        // Close other open accordions. Null-guard the lookups so one
        // malformed item can't throw and kill the whole loop.
        screen.querySelectorAll('.accordion-item').forEach(otherItem => {
          if (otherItem !== item) {
            otherItem.classList.remove('open');
            const otherHeader  = otherItem.querySelector('.accordion-header');
            const otherContent = otherItem.querySelector('.accordion-content');
            if (otherHeader)  otherHeader.setAttribute('aria-expanded', 'false');
            if (otherContent) otherContent.style.maxHeight = null;
          }
        });

        item.classList.toggle('open', !isOpen);
        header.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
        const content = item.querySelector('.accordion-content');
        if (content) {
          content.style.maxHeight = !isOpen ? content.scrollHeight + 'px' : null;
        }
      });
    });
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
      else if (action === 'import-export') this.toggleScreen('import-export', true);
      else if (action === 'about') this.toggleScreen('about', true);
      else if (action === 'copy-url') this.handleCopyURL();
      else if (action === 'install') App.promptInstall();
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
      'discussion': document.getElementById('discussion-screen'),
      'about':     document.getElementById('about-screen'),
      'import-export': this.importExportScreen
    };
    const el = map[screen];
    if (!el) return;
    el.classList.toggle('open', !!show);

    if (screen === 'import-export' && show) {
      this.onShowImportExportScreen();
    }
    // Refreshed on every open rather than once at boot: the cache bucket
    // can change underneath a long-running session when a new worker
    // activates, and that transition is exactly what this readout is for.
    // Guarded because the mixed-version state this readout exists to
    // diagnose includes "new ui.js, stale app.js" — calling it
    // unconditionally would throw on every About open in exactly that
    // case, and the placeholder is supposed to be the signal instead.
    if (screen === 'about' && show && typeof App.renderBuildInfo === 'function') {
      App.renderBuildInfo();
    }
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
    this._prepCubeFace(front, true); // clone — strip its duplicated ids

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
    // Clones of the whole header + main content: without stripping,
    // #weather-view / #save-btn / #city-clock etc. are duplicated in
    // document.body and getElementById can resolve to the dead copy.
    this._prepCubeFace(back, true);

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
      this._prepCubeFace(front, true); // clone — strip its duplicated ids

      // ----- Back face: clone of the column wrapper -----
      const back = document.createElement('div');
      back.className = 'cube-face cube-face-left'; // rotate-right brings this in
      const colClone = columnEl.cloneNode(true);
      colClone.style.transform = 'none';
      // Fill the cube face so the clone matches the real column's render.
      back.appendChild(colClone);
      this._prepCubeFace(back, true); // also a clone — strip ids

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

  // List of every asset name the icon picker can resolve to. Lets
  // getWeatherIconSVG accept an already-resolved name. sw.js keeps its
  // OWN copy of this list in ASSETS_TO_CACHE (a worker can't import this
  // file) — add new art in both places or it won't be available offline.
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

  HEAVY_RAIN_IDS: new Set([
    302, // heavy intensity drizzle
    312, // heavy intensity drizzle rain
    314, // heavy shower rain and drizzle
    502, // heavy intensity rain
    503, // very heavy rain
    504, // extreme rain
    522, // heavy intensity shower rain
    531, // ragged shower rain
  ]),

  _fxClassFor(assetName, weatherId) {
    if (!assetName) return null;
    if (assetName.startsWith('thunderstorm'))         return 'fx-thunder';
    if (assetName.startsWith('shower-rain')) {
      const wid = Number(weatherId);
      if (this.LIGHT_RAIN_IDS.has(wid)) {
        return 'fx-rain-light';
      } else if (this.HEAVY_RAIN_IDS.has(wid)) {
        return 'fx-rain-heavy';
      } else {
        return 'fx-rain';
      }
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

  formatPrecip(mm) {
    if (mm == null) return '—';
    const unit = Storage.getUnits().precip;
    if (unit === 'in') return (mm / 25.4).toFixed(2) + ' in';
    return mm.toFixed(1) + ' mm';
  },

  // Snow ACCUMULATION, given as depth in cm. Keyed off the dist (km/mi)
  // setting for the same reason formatTideHeight is: it's a depth, and an
  // imperial user expects inches of snow even if they read rain in mm.
  formatSnowDepth(cm) {
    if (cm == null) return '—';
    if (Storage.getUnits().dist === 'mi') return (cm / 2.54).toFixed(1) + ' in';
    return cm.toFixed(1) + ' cm';
  },

  // Sea-surface temperature (°C) at the hour nearest `dt`, from the raw
  // marine hourly series. Returns null when there's no marine data, no
  // SST column (not every marine grid cell carries one), or the nearest
  // sample is more than an hour away — better a missing row than a
  // confidently wrong one.
  _waterTempAt(tides, dt) {
    if (!tides || !tides.time || !tides.sea_surface_temperature || dt == null) return null;
    const times = tides.time;
    const temps = tides.sea_surface_temperature;
    let best = null;
    let bestDelta = Infinity;
    for (let i = 0; i < times.length; i++) {
      const v = temps[i];
      if (v == null) continue;
      const t = App._marineTimeToSec(times[i]);
      if (t == null || !isFinite(t)) continue;
      const delta = Math.abs(t - dt);
      if (delta < bestDelta) { bestDelta = delta; best = v; }
    }
    return bestDelta <= 3600 ? best : null;
  },

  formatTideHeight(meters) {
    if (meters == null) return '—';
    // Tide height is a distance — key off the dist (km/mi) setting, not
    // precipitation (mm/in): an imperial user with metric rain prefs
    // still expects tides in feet.
    const unit = Storage.getUnits().dist;
    if (unit === 'mi') {
      const feet = meters * 3.28084;
      const sign = feet >= 0 ? '+' : '';
      return `${sign}${feet.toFixed(2)} ft`;
    } else {
      const sign = meters >= 0 ? '+' : '';
      return `${sign}${meters.toFixed(2)} m`;
    }
  },

  // Returns a temperature converted to the user's unit but NOT rounded.
  // Use this when you need to do math/aggregation before rounding.
  convertTemp(celsius) {
    return Storage.getUnits().temp === 'F' ? (celsius * 9/5) + 32 : celsius;
  },

  formatTemp(celsius) {
    return Math.round(this.convertTemp(celsius));
  },

  // One conversion table for wind display. The graph's y-axis wants the
  // bare number and unit on separate lines while formatWind wants them
  // joined — both go through here so the factors can't drift.
  _windToDisplay(ms) {
    const unit = Storage.getUnits().wind;
    if (unit === 'mph') return { value: ms * 2.237, unit: 'mph' };
    if (unit === 'ms')  return { value: ms,         unit: 'm/s' };
    return { value: ms * 3.6, unit: 'km/h' };
  },

  formatWind(ms) {
    const { value, unit } = this._windToDisplay(ms);
    return `${value.toFixed(1)} ${unit}`;
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

  // ── City-local time helpers ─────────────────────────────────────────
  // Everything below accepts a `tz` that is EITHER an IANA zone name
  // (string, from Open-Meteo — DST-correct for every timestamp) OR a
  // fixed utc-offset in seconds (number, OWM's `timezone` — the only
  // thing available when enrichment fails). cityTz() picks the best
  // handle for a given state.

  _tzFmtCache: Object.create(null),
  _tzInvalid: Object.create(null),

  _tzPartsFmt(zone) {
    let fmt = this._tzFmtCache[zone];
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric'
      });
      this._tzFmtCache[zone] = fmt;
    }
    return fmt;
  },

  // Preferred timezone handle for a city: the IANA zone name when we have
  // one the browser recognises, else OWM's fixed offset.
  cityTz(state) {
    const name = state && state.tzName;
    if (name && !this._tzInvalid[name]) {
      try {
        this._tzPartsFmt(name);
        return name;
      } catch (_) {
        this._tzInvalid[name] = true; // unknown zone — don't retry per render
      }
    }
    return (state && state.timezone) || 0;
  },

  // City-local wall-clock parts of a unix timestamp.
  localParts(unixSec, tz) {
    if (typeof tz === 'string') {
      const p = {};
      for (const part of this._tzPartsFmt(tz).formatToParts(unixSec * 1000)) {
        p[part.type] = part.value;
      }
      // % 24: some engines render h23 midnight as "24".
      return { year: +p.year, month: +p.month, day: +p.day, hour: (+p.hour) % 24, minute: +p.minute };
    }
    const d = new Date((unixSec + (tz || 0)) * 1000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  },

  localHour(unixSec, tz) {
    return this.localParts(unixSec, tz).hour;
  },

  // Canonical city-local day key: "YYYY-MM-DD" (1-based, zero-padded).
  dayKey(unixSec, tz) {
    const p = this.localParts(unixSec, tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  },

  formatTime(unix, showMinutes = true, tz = 0) {
    const unit = Storage.getUnits().time;
    const { hour: h, minute: m } = this.localParts(unix, tz);

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

  // Returns °C, or null when the inputs can't produce one — humidity can
  // be 0 or missing (Open-Meteo synthesised slots yield null), and
  // Math.log(0) is -Infinity which would surface as "NaN°" in the stat.
  calculateDewPoint(temp, humidity) {
    if (!Number.isFinite(temp) || !Number.isFinite(humidity) || humidity <= 0) return null;
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
  // `timezone` is a tz handle as accepted by localParts (IANA zone name
  // or fixed offset seconds); it's only used to snap the result onto the
  // requested local calendar day.
  _solarTimes(year, month /* 1-12 */, day, lat, lon, timezone = 0) {
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

    let sunrise = sr != null ? Math.round(utcMidnightSec + sr * 3600) : null;
    let sunset  = ss != null ? Math.round(utcMidnightSec + ss * 3600) : null;

    const adjustToLocalDay = (timestamp) => {
      if (timestamp == null) return null;
      const p = this.localParts(timestamp, timezone);
      const targetLocalMidnight = Date.UTC(year, month - 1, day) / 1000;
      const computedLocalMidnight = Date.UTC(p.year, p.month - 1, p.day) / 1000;

      if (computedLocalMidnight > targetLocalMidnight) {
        return timestamp - 86400;
      } else if (computedLocalMidnight < targetLocalMidnight) {
        return timestamp + 86400;
      }
      return timestamp;
    };

    return {
      sunrise: adjustToLocalDay(sunrise),
      sunset:  adjustToLocalDay(sunset)
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

  // Map WMO weather codes (used by Open-Meteo) onto OWM-style IDs
  wmoToOwmId(code) {
    if (code == null) return 800;
    const m = {
      0: 800,  // clear sky -> clear
      1: 801,  // mainly clear -> few clouds
      2: 802,  // partly cloudy -> scattered clouds
      3: 804,  // overcast -> broken clouds
      45: 741, // fog -> fog (mist)
      48: 741, // depositing rime fog -> fog
      51: 300, // light drizzle
      53: 301, // drizzle
      55: 302, // dense drizzle
      56: 310, // light freezing drizzle
      57: 311, // freezing drizzle
      61: 500, // light rain
      63: 501, // rain
      65: 502, // heavy rain
      66: 511, // light freezing rain
      67: 511, // freezing rain
      80: 520, // light showers
      81: 521, // showers
      82: 522, // violent showers
      85: 600, // light snow showers
      86: 601, // snow showers
      95: 211, // thunderstorm
      96: 212, // thunderstorm with hail
      99: 212  // thunderstorm with heavy hail
    };
    return m[code] || 800;
  },

  // Convert an Open-Meteo hourly entry into the OWM 3h-slot shape the rest
  // of the UI expects. Marks rain via the '3h' field by multiplying mm/h × 3
  // so per-day totals still come out correct (we sum '3h' / 3 ≈ mm/h elsewhere).
  _omHourToOwmSlot(h) {
    const slot = {
      dt: h.dt,
      // Marks the slot as Open-Meteo-derived, because the two sources
      // disagree about what `dt` MEANS. OWM's 3h buckets are treated as
      // period STARTS throughout this file (the graph spreads a bucket
      // forward from its dt). Open-Meteo's hourly precipitation is a
      // preceding-hour sum, so here dt is a period END — the value
      // describes [dt-1h, dt], and it then gets ×3 below. Any
      // "is this slot still in the future?" test has to branch on this
      // or it will count an hour that has already finished.
      _omDerived: true,
      main: {
        temp: h.temp,
        feels_like: h.feelsLike != null ? h.feelsLike : h.temp,
        humidity: h.humidity || 0,
        pressure: h.pressureMsl != null ? Math.round(h.pressureMsl) : 1013
      },
      weather: [{
        id: this.wmoToOwmId(h.weatherCode),
        icon: this.wmoToIcon(h.weatherCode, h.isDay),
        description: this.wmoDescription(h.weatherCode)
      }],
      wind: {
        speed: h.windSpeed || 0,
        deg:   h.windDir != null ? h.windDir : 0,
        gust:  h.windGust != null ? h.windGust : undefined
      },
      clouds: { all: h.cloudCover != null ? h.cloudCover : null },
      visibility: h.visibility != null ? h.visibility : 10000,
      pop: (h.precipProb || 0) / 100
    };
    // Split precipitation into its rain and snow shares. `precipMM` is
    // water-equivalent and ALREADY INCLUDES snow, so the snow share is
    // subtracted rather than added — the rain + snow total still equals
    // precipMM, which is what every downstream consumer sums.
    //
    // Before this, snow was silently folded into slot.rain, so on the
    // Open-Meteo-synthesised days (6-8, plus the top-up slots on OWM's
    // truncated last day) a blizzard was indistinguishable from rain.
    if (h.precipMM > 0) {
      const snowMM = this._snowCMToWaterMM(h.snowCM);
      const rainMM = Math.max(0, h.precipMM - snowMM);
      if (rainMM > 0) slot.rain = { '3h': rainMM * 3 };
      if (snowMM > 0) slot.snow = { '3h': Math.min(snowMM, h.precipMM) * 3 };
    }
    return slot;
  },

  // Open-Meteo gives snowfall as DEPTH in cm; everything downstream works
  // in water-equivalent mm. Their docs' worked example is 7 cm ≈ 10 mm,
  // i.e. divide by 0.7 (the "divide by 7" line in the same paragraph
  // contradicts the example and is a doc typo).
  SNOW_DEPTH_TO_WATER: 0.7,
  _snowCMToWaterMM(cm) {
    if (cm == null || !(cm > 0)) return 0;
    return cm / this.SNOW_DEPTH_TO_WATER;
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
  // Band name only — the number is what the word already says, so it
  // stays out of the UI.
  aqiLabel(aqi) {
    if (aqi == null) return 'N/A';
    const v = Math.round(aqi);
    if (v <= 50)  return 'Good';
    if (v <= 100) return 'Moderate';
    if (v <= 150) return 'Sensitive';
    if (v <= 200) return 'Unhealthy';
    if (v <= 300) return 'Very poor';
    return 'Hazardous';
  },

  // Sum of CAMS pollen grains/m³ → coarse Low/Moderate/High band.
  // Returns 'N/A' outside CAMS coverage (essentially anywhere not Europe).
  pollenLabel(pollen) {
    if (pollen == null) return 'N/A';
    if (pollen < 10)  return 'Low';
    if (pollen < 50)  return 'Moderate';
    return 'High';
  },

  // Moon altitude (radians) at a unix time for an observer — a compact
  // low-precision lunar ephemeris using the well-known SunCalc formulas.
  // Accurate to a few arcminutes, which puts rise/set within a couple of
  // minutes: plenty for a forecast stat.
  _moonAltitudeAt(sec, lat, lon) {
    const rad = Math.PI / 180;
    const d = (sec - 946728000) / 86400; // days since J2000.0
    const e = rad * 23.4397;             // Earth obliquity
    const L = rad * (218.316 + 13.176396 * d); // ecliptic longitude
    const M = rad * (134.963 + 13.064993 * d); // mean anomaly
    const F = rad * (93.272  + 13.229350 * d); // mean distance
    const l = L + rad * 6.289 * Math.sin(M);
    const b = rad * 5.128 * Math.sin(F);
    const ra  = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
    const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
    const lw  = rad * -lon;
    const phi = rad * lat;
    const H = rad * (280.16 + 360.9856235 * d) - lw - ra; // hour angle
    return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  },

  // Moonrise/moonset within the 24h starting at `startSec` (the CITY's
  // local midnight). SunCalc's method: sample altitude every 2h, fit a
  // parabola through each triple, and take its roots as the crossings.
  // Either value can be null — the moon genuinely doesn't rise or set
  // on some days (it drifts ~50min later each day), and never does
  // either during polar day/night.
  _moonTimes(startSec, lat, lon) {
    const hc = 0.133 * Math.PI / 180; // apparent-radius correction
    let h0 = this._moonAltitudeAt(startSec, lat, lon) - hc;
    let rise = null, set = null;
    for (let i = 1; i <= 24; i += 2) {
      const h1 = this._moonAltitudeAt(startSec + i * 3600, lat, lon) - hc;
      const h2 = this._moonAltitudeAt(startSec + (i + 1) * 3600, lat, lon) - hc;
      const a = (h0 + h2) / 2 - h1;
      const b = (h2 - h0) / 2;
      const xe = -b / (2 * a);
      const ye = (a * xe + b) * xe + h1;
      const disc = b * b - 4 * a * h1;
      let roots = 0, x1 = 0, x2 = 0;
      if (disc >= 0) {
        const dx = Math.sqrt(disc) / (Math.abs(a) * 2);
        x1 = xe - dx; x2 = xe + dx;
        if (Math.abs(x1) <= 1) roots++;
        if (Math.abs(x2) <= 1) roots++;
        if (x1 < -1) x1 = x2;
      }
      if (roots === 1) {
        if (h0 < 0) rise = i + x1; else set = i + x1;
      } else if (roots === 2) {
        rise = i + (ye < 0 ? x2 : x1);
        set  = i + (ye < 0 ? x1 : x2);
      }
      if (rise != null && set != null) break;
      h0 = h2;
    }
    return {
      rise: rise != null ? Math.round(startSec + rise * 3600) : null,
      set:  set  != null ? Math.round(startSec + set  * 3600) : null
    };
  },

  // Scan the 15-minute precipitation series for the next wet↔dry
  // transition inside `windowSec`. Returns { type: 'starts'|'ends',
  // dt } or null when there's no transition (or no data).
  _precipNowcast(minutely, nowSec, windowSec = 2 * 3600) {
    if (!minutely || !minutely.length) return null;
    const RAINING = 0.05; // mm per 15min that counts as precipitating
    const upcoming = minutely
      .filter(m => m.dt + 900 > nowSec && m.dt <= nowSec + windowSec)
      .sort((a, b) => a.dt - b.dt);
    if (upcoming.length < 2) return null;
    const rainingNow = (upcoming[0].precipMM || 0) >= RAINING;
    for (const m of upcoming.slice(1)) {
      const wet = (m.precipMM || 0) >= RAINING;
      if (wet !== rainingNow) return { type: wet ? 'starts' : 'ends', dt: m.dt };
    }
    return null;
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
      bar.classList.remove('alert-bar-slide-in');
      this._lastAnimatedAlertCity = '';
      this._lastAnimatedAlertEvent = '';
      return;
    }

    // Two presentation tiers from one list: Severe/Extreme keep the red
    // bar; anything lesser (Watches, Advisories, Statements) gets the
    // quieter amber styling. The bar leads with the severe set when both
    // exist; the overlay always lists everything.
    const severe = alerts.filter(a => a.severity === 'Severe' || a.severity === 'Extreme');
    const shown = severe.length ? severe : alerts;
    bar.classList.toggle('alert-bar-minor', severe.length === 0);

    const top = shown[0];
    const extra = alerts.length - 1;
    const textEl = document.getElementById('alert-bar-text');
    if (textEl) {
      textEl.textContent = extra > 0
        ? `${top.event} (+${extra} more)`
        : top.event;
    }

    const currentCity = this._renderedCityName || '';
    const currentEvent = top.event || '';
    const shouldAnimate = bar.hidden ||
                          (this._lastAnimatedAlertCity !== currentCity) ||
                          (this._lastAnimatedAlertEvent !== currentEvent);

    bar.hidden = false;
    document.body.classList.add('has-alert');

    if (shouldAnimate) {
      bar.classList.remove('alert-bar-slide-in');
      void bar.offsetWidth; // force layout reflow
      bar.classList.add('alert-bar-slide-in');
      this._lastAnimatedAlertCity = currentCity;
      this._lastAnimatedAlertEvent = currentEvent;
    }
  },

  // Quieter cousin of renderAlertBar: the NWS Area Forecast Discussion
  // bar (US-only). Slides in along the bottom — above the alert bar when
  // one is showing — and opens the full-narrative overlay on tap.
  renderDiscussionBar(discussion) {
    const bar = document.getElementById('discussion-bar');
    if (!bar) return;

    this._currentDiscussion = discussion || null;

    if (!this._discussionBarBound) {
      this._discussionBarBound = true;
      bar.addEventListener('click', () => {
        this.renderDiscussionOverlay(this._currentDiscussion);
        this.toggleScreen('discussion', true);
      });
      const backBtn = document.getElementById('discussion-back-btn');
      if (backBtn) backBtn.addEventListener('click', () => this.toggleScreen('discussion', false));
    }

    if (!discussion || !discussion.text) {
      bar.hidden = true;
      bar.classList.remove('alert-bar-slide-in');
      this._lastDiscussionCity = '';
      return;
    }

    const textEl = document.getElementById('discussion-bar-text');
    if (textEl) textEl.textContent = `Forecast discussion · NWS ${discussion.office || ''}`.trim();

    const currentCity = this._renderedCityName || '';
    const shouldAnimate = bar.hidden || this._lastDiscussionCity !== currentCity;
    bar.hidden = false;
    if (shouldAnimate) {
      bar.classList.remove('alert-bar-slide-in');
      void bar.offsetWidth; // force layout reflow
      bar.classList.add('alert-bar-slide-in');
      this._lastDiscussionCity = currentCity;
    }
  },

  // Turn raw AFD product text into displayable sections. AFDs are
  // hard-wrapped plain text: paragraphs separated by blank lines,
  // headings like ".SYNOPSIS..." or ".NEAR TERM /THROUGH TONIGHT/..."
  // on their own line, "&&" ending a section and "$$" the product.
  // We unwrap in-paragraph newlines (the ~66-char wire wrapping reads
  // terribly on a phone), split on headings, and drop the wire-format
  // preamble before the first titled section.
  _parseAfd(text) {
    const lines = String(text || '').split('\n');
    const sections = [];
    let cur = { title: null, paras: [] };
    let para = [];
    const flushPara = () => {
      if (para.length) { cur.paras.push(para.join(' ')); para = []; }
    };
    const flushSection = () => {
      flushPara();
      if (cur.title || cur.paras.length) sections.push(cur);
      cur = { title: null, paras: [] };
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.trim() === '&&') { flushSection(); continue; }
      // "$$" ends the product proper; what follows is forecaster
      // initials / routing codes — not content.
      if (line.trim() === '$$') { flushSection(); break; }
      const m = line.match(/^\.([A-Z][A-Za-z0-9 \/&.,'-]*?)\.\.\.(.*)$/);
      if (m) {
        flushSection();
        cur.title = m[1].trim();
        if (m[2] && m[2].trim()) para.push(m[2].trim());
        continue;
      }
      if (!line.trim()) { flushPara(); continue; }
      // Bullet lines stand alone instead of merging into the previous
      // wrapped paragraph.
      if (/^[*-]\s/.test(line.trim())) flushPara();
      para.push(line.trim());
    }
    flushSection();
    const firstTitled = sections.findIndex(s => s.title);
    return firstTitled > 0 ? sections.slice(firstTitled) : sections;
  },

  renderDiscussionOverlay(discussion) {
    const body = document.getElementById('discussion-body');
    if (!body) return;
    if (!discussion || !discussion.text) {
      body.innerHTML = '<p class="discussion-para">No forecast discussion available.</p>';
      return;
    }
    const sections = this._parseAfd(discussion.text);
    const issued = discussion.issued ? new Date(discussion.issued) : null;
    const meta = [
      discussion.office ? `NWS ${this.esc(discussion.office)}` : '',
      (issued && !isNaN(issued))
        ? `Issued ${issued.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : ''
    ].filter(Boolean).join(' · ');
    // Headings arrive SHOUTING; sentence-case them for the UI.
    const prettyTitle = (t) => {
      const s = t.toLowerCase();
      return s.charAt(0).toUpperCase() + s.slice(1);
    };
    body.innerHTML = `
      ${meta ? `<div class="discussion-meta">${meta}</div>` : ''}
      ${sections.map(s => `
        <section class="discussion-section">
          ${s.title ? `<h3 class="discussion-heading">${this.esc(prettyTitle(s.title))}</h3>` : ''}
          ${s.paras.map(p => `<p class="discussion-para">${this.esc(p)}</p>`).join('')}
        </section>`).join('')}
    `;
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

      // Scheme check as defense-in-depth: esc() neutralises HTML but not
      // a javascript:/data: href. Source is api.weather.gov today, but
      // this cell should stay safe if the alert pipeline ever changes.
      const link = (a.url && /^https?:\/\//i.test(a.url))
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

  // Wire a div that acts as a button (role="button" tabindex="0"):
  // click plus Enter/Space activation so the day-selection and
  // hour-pinning UI is reachable by keyboard.
  _bindActivate(el, handler) {
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); // keep Space from scrolling the page
      handler(e);
    });
  },

  // Canonical daily-data builder — the ONE place the 8-day list is
  // assembled. Groups OWM 3h slots and Open-Meteo filler days into a
  // single array keyed by CITY-local calendar day, then tops up
  // slot-starved days from Open-Meteo's hourly series.
  //
  // Used by renderDashboard (rendering) AND App.getDayKey /
  // App._resolveSharedDayAndHour (Copy-URL sender/receiver). One
  // implementation owns the merge rules so the day SET and ORDER can
  // never diverge between them — divergence used to shift Copy-URL
  // onto the wrong day.
  //
  // Days are keyed by the CITY's local calendar day, not the browser's
  // — otherwise viewing e.g. Tokyo weather from New York would split
  // slots into the wrong "days."
  //
  // Returns { dailyData, todayKey, dayKeyFor, tz } where each dailyData
  // entry is { key, dt, temps, icons, hourly, _om? } with hourly an
  // array of OWM-shaped slots.
  buildDailyData(state) {
    const currentWeather = state.currentWeather;
    const forecast = state.forecast;
    const tz = this.cityTz(state);
    const dayKeyFor = (unixSec) => this.dayKey(unixSec, tz);
    // Today's dayKey in the CITY's local time — used downstream to label
    // the correct entry "Today" instead of trusting array position.
    const todayKey = dayKeyFor(Math.floor(Date.now() / 1000));
    if (!currentWeather || !forecast || !forecast.list) {
      return { dailyData: [], todayKey, dayKeyFor, tz };
    }

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
      // Skip days with no 3h slots — a day that isn't rendered can't be
      // selected, so it never needs a shareable key either.
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
    // True UTC instant of a day's local midnight. Prefer Open-Meteo's
    // per-day dt (already the DST-correct local midnight); fall back to
    // fixed-offset arithmetic when the day has no Open-Meteo counterpart
    // (in which case omHourly is usually empty and the top-up is a no-op).
    const omMidnightByKey = new Map(omDaily.map(di => [dayKeyFor(di.dt), di.dt]));
    const dayStartFor = (day) => {
      const fromOm = omMidnightByKey.get(day.key);
      if (fromOm != null) return fromOm;
      const [yy, mo, dd] = day.key.split('-').map(Number);
      const off = typeof tz === 'number' ? tz : (currentWeather.timezone || 0);
      return Math.floor(Date.UTC(yy, mo - 1, dd) / 1000) - off;
    };
    for (const day of allDays.values()) {
      if (day.hourly.length >= MIN_SLOTS) continue;
      const dayStart = dayStartFor(day);
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

    return { dailyData, todayKey, dayKeyFor, tz };
  },

  renderDashboard(state, onDayClick, onSave, onHourClick) {
    const { currentWeather, forecast, cityName } = state;
    let selectedDayIndex = state.selectedDayIndex;
    const selectedHourDt = state.selectedHourDt || null;

    this.locationName.textContent = this.prettifyLocationName(cityName);

    // Header Save Button. Include cityName so name-match catches
    // entries that already sit in the saved list but whose stored
    // coords drifted more than SAME_LOCATION_DEG from what /weather
    // just returned — otherwise the star would flicker between saved
    // and unsaved for the same place.
    const savedList = Storage.getSavedList();
    const isSaved = Storage.isDuplicate(savedList, currentWeather.coord.lat, currentWeather.coord.lon, cityName);

    this.saveBtnContainer.innerHTML = `
      <button class="save-loc-btn ${isSaved ? 'saved' : ''}" id="save-btn" aria-label="${isSaved ? 'Remove Saved Location' : 'Save Location'}">
        ${isSaved
          ? `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`
          : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`
        }
      </button>
    `;
    document.getElementById('save-btn').addEventListener('click', onSave);

    // Canonical 8-day list + day keys. Built by the shared builder above
    // so the rendered days can never diverge from what App's Copy-URL
    // sender/receiver resolves against. `tz` is the city's IANA zone
    // name when Open-Meteo supplied one, else OWM's fixed offset.
    const { dailyData, todayKey, dayKeyFor, tz } = this.buildDailyData(state);

    if (selectedDayIndex >= dailyData.length) {
      selectedDayIndex = -1;
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // ── Near-term 2h tiles ─────────────────────────────────────────────
    // The hourly scroller shows 2-hour tiles for the next 24 hours,
    // sourced from Open-Meteo's true 1h series (OWM only offers 3h),
    // then continues on the regular 3h slots beyond that window —
    // denser exactly where forecasts are sharpest. day.hourly itself
    // stays on the 3h spine: the graph, the precip totals (which sum
    // 3h buckets) and Copy-URL day/hour resolution all key off it, so
    // only the scroller and the hour-pin lookup see these extra slots.
    // When enrichment is down the map stays empty and the scroller
    // renders exactly as before.
    const NEAR_TERM_SEC = 24 * 3600;
    const nearTermByKey = new Map(); // dayKey → 2h-spaced OWM-shaped slots
    let lastNearTermDt = 0;
    for (const h of (state.omHourly || [])) {
      if (h.dt <= nowSec || h.dt > nowSec + NEAR_TERM_SEC) continue;
      if (Math.floor(h.dt / 3600) % 2 !== 0) continue; // every 2nd hour
      const k = dayKeyFor(h.dt);
      if (!nearTermByKey.has(k)) nearTermByKey.set(k, []);
      nearTermByKey.get(k).push(this._omHourToOwmSlot(h));
      if (h.dt > lastNearTermDt) lastNearTermDt = h.dt;
    }

    // Day totals for any forecast day: sum of rain+snow mm and max PoP across
    // the 3h slots in that day. Used identically for Today and forecast days
    // so the Precipitation / Probability rows update consistently.
    // Open-Meteo's daily summary, matched by city-local day KEY rather
    // than array index — daily[0] is "today", but rendered day 0 can
    // already be tomorrow near local midnight. Defined up here because
    // the hero temperature, the daily list and the precip totals all
    // need it now, not just the UV lookup further down.
    const omDailyForKey = (key) => (state.omDaily || []).find(od => dayKeyFor(od.dt) === key) || null;

    // A day's high and low, in Celsius.
    //
    // Deriving these from `day.temps` alone under-reports: that array is
    // the 3-HOURLY spine, aligned to UTC hours, so the sampling phase
    // drifts per city and the real extreme can fall up to 1.5h from any
    // sample. Open-Meteo publishes the model's actual daily extremes and
    // we were already fetching and discarding them.
    //
    // Taking the UNION rather than simply preferring Open-Meteo: on days
    // 0-5 the spine is OWM's forecast while tempMax/tempMin come from
    // Open-Meteo, so picking one model outright could print a high LOWER
    // than the peak of the curve drawn right below it. Widening to cover
    // both keeps the headline consistent with the graph — the number is
    // never less than what the curve visibly reaches — while still
    // catching an extreme the sampling missed. On days 6-8 the spine is
    // Open-Meteo too, so the two agree and this is a pure improvement.
    const dayExtremesC = (day) => {
      if (!day || !day.temps || !day.temps.length) return null;
      let hi = Math.max(...day.temps);
      let lo = Math.min(...day.temps);
      const om = day.key ? omDailyForKey(day.key) : null;
      if (om) {
        if (om.tempMax != null) hi = Math.max(hi, om.tempMax);
        if (om.tempMin != null) lo = Math.min(lo, om.tempMin);
      }
      return { hi, lo };
    };

    // `wholeDay` false means "rest of today": sum only the slots still
    // ahead, the way this has always worked for the Today tab.
    //
    // Open-Meteo's precipSum is a CALENDAR-DAY total, so using it for
    // today would report rain that already fell — at 6 PM on a clear
    // evening the row would read 18 mm because of a morning downpour.
    // The sibling popMax stat already refuses the daily figure for today
    // for exactly this reason; this keeps the two consistent.
    const dayTotals = (day, wholeDay = true) => {
      // hasWindow false, not undefined: no day means no forecast window
      // at all, and the hero must not assert "No precipitation expected"
      // off the back of it.
      if (!day) return { rainMM: 0, pop: 0, snowMM: null, hasWindow: false };
      // For a whole forecast day, Open-Meteo's exact total beats
      // re-summing sampled buckets: _omHourToOwmSlot multiplies ONE
      // sampled hour by three to stand in for a 3h bucket, so a short
      // convective storm either vanishes between samples or gets tripled.
      const om = (wholeDay && day.key) ? omDailyForKey(day.key) : null;
      if (om && om.precipSum != null) {
        const pop = day.hourly.reduce((mx, h) => Math.max(mx, h.pop || 0), 0);
        // snowMM unused on this path — whole-day snow comes from
        // omDaily.snowSumCM, which is already a depth.
        return { rainMM: om.precipSum, pop, snowMM: null, hasWindow: true };
      }
      // "Rest of today" has to be enforced HERE, not assumed from the
      // slot list. buildDailyData's MIN_SLOTS top-up backfills any short
      // day from omHourly, which deliberately reaches 24h into the past —
      // so today's slots include hours that have already elapsed, and
      // summing them blindly reported this morning's rain as still to
      // come.
      //
      // The cutoff is source-aware because dt means different things (see
      // _omHourToOwmSlot): an OWM bucket starting an hour ago still holds
      // two hours of future weather and should count, whereas an
      // Open-Meteo slot stamped an hour ago describes an hour that has
      // entirely finished — and carries a ×3 multiplier, so admitting it
      // would add triple a fully-elapsed hour.
      const nowSec = Math.floor(Date.now() / 1000);
      const stillAhead = (h) => h._omDerived
        ? h.dt > nowSec
        : h.dt + 3 * 3600 > nowSec;
      const slots = wholeDay ? day.hourly : day.hourly.filter(stillAhead);
      let rainMM = 0;
      let snowMM = 0;
      for (const h of slots) {
        rainMM += (h.rain && h.rain['3h']) || 0;
        const s = (h.snow && h.snow['3h']) || 0;
        rainMM += s;   // total precipitation, water-equivalent
        snowMM += s;   // the frozen share of it, tracked separately
      }
      // Same window as the rain sum — a 90% chance from a shower that
      // came through at dawn isn't a forecast for the evening.
      const pop = slots.reduce((mx, h) => Math.max(mx, h.pop || 0), 0);
      // hasWindow false means there is nothing left of today to forecast,
      // which is different from "nothing is expected" — see the hero
      // precip line.
      return { rainMM, pop, snowMM, hasWindow: slots.length > 0 };
    };

    // The Today tab (index 0) and the initial state (-1) both mean "today" —
    // unify them so the rolling 24h temperature graph and the rest-of-today
    // metrics are identical regardless of which path we got here through.
    const isToday = selectedDayIndex === -1 || selectedDayIndex === 0;
    const todayData = dailyData[0];

    // Determine if we should perform a 3D flip animation of the hero temperature
    const cityChanged = this._renderedCityName !== cityName;
    let shouldFlip = false;
    let oldTempStr = '';
    const prevHeroTempEl = this.weatherView ? this.weatherView.querySelector('.hero-temp-large') : null;
    if (prevHeroTempEl &&
        !cityChanged &&
        this._lastIsToday &&
        this._lastPinnedHour === null &&
        isToday &&
        selectedHourDt === null &&
        this._lastTempUnit === Storage.getUnits().temp) {
      const prevBackEl = this.weatherView.querySelector('.hero-temp-flip-back');
      oldTempStr = (prevBackEl ? prevBackEl.textContent : prevHeroTempEl.textContent).trim();
    }

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
        const lh = this.localHour(slot.dt, tz);
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
      const p = this.localParts(dayDt, tz);
      return this._solarTimes(
        p.year,
        p.month,
        p.day,
        currentWeather.coord.lat,
        currentWeather.coord.lon,
        tz
      );
    };

    const activeDay = isToday ? (() => {
      // Rest-of-today, not the calendar day — see dayTotals.
      const totals = dayTotals(todayData, false);
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
        snowMM: totals.snowMM,
        hasWindow: totals.hasWindow,
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
        rainMM: totals.rainMM,
        // Carried so the Snow row can still work when Open-Meteo's daily
        // summary is missing (offline, outage, OWM-only cache) — the
        // slot-sum path computes a perfectly good snow figure that would
        // otherwise be discarded, leaving a card showing Precipitation
        // but no Snow for the same frozen precipitation.
        snowMM: totals.snowMM
      };
    })();

    // If the user has tapped a specific hourly tile, locate that exact slot
    // so we can project ITS conditions into the hero. The day-level
    // `activeDay` keeps driving the quick stats, temperature graph and
    // daily-list highlight (those describe the whole day, not one hour);
    // only the hero card swaps. A missing dt (stale pin after refresh,
    // city change, etc.) silently falls back to the day view.
    let pinnedHourSlot = null;
    if (selectedHourDt != null) {
      for (const d of dailyData) {
        if (!d || !d.hourly) continue;
        const found = d.hourly.find(h => h.dt === selectedHourDt);
        if (found) { pinnedHourSlot = found; break; }
      }
      // Not on the 3h spine? The pin is one of the near-term 2h tiles —
      // display-layer slots that never live in day.hourly. Resolve it
      // straight from the Open-Meteo hourly series (which also keeps an
      // older 2h pin alive after it drifts out of the 24h tile window).
      if (!pinnedHourSlot) {
        const om = (state.omHourly || []).find(h => h.dt === selectedHourDt);
        if (om) pinnedHourSlot = this._omHourToOwmSlot(om);
      }
    }

    // heroData mirrors the fields the hero card reads (main, weather, wind,
    // dt) — defaulting to activeDay so the existing render path "just
    // works" when no hour is pinned. When pinned, we layer the slot's
    // values on top, recomputing the hero icon's asset name (and the
    // matching ambient-fx selection downstream) so it tracks the hour.
    let heroData = activeDay;
    if (pinnedHourSlot) {
      const w0 = (pinnedHourSlot.weather && pinnedHourSlot.weather[0]) || activeDay.weather[0];
      const heroAsset = w0 ? this._weatherAssetName(w0.icon, w0.id) : null;
      const weatherWithAsset = (w0 && heroAsset)
        ? [{ ...w0, _asset: heroAsset }]
        : [w0];
      heroData = {
        ...activeDay,
        main:    pinnedHourSlot.main    || activeDay.main,
        weather: weatherWithAsset,
        wind:    pinnedHourSlot.wind    || activeDay.wind,
        dt:      pinnedHourSlot.dt
      };
    }

    const dewPoint = this.calculateDewPoint(activeDay.main.temp, activeDay.main.humidity);
    // Breeze description tracks the hero (pinned hour wind if set,
    // otherwise the day's wind) so the "Feels like X — windy" subtitle
    // stays consistent with the rest of the hero card.
    const breeze = this.windDescription(heroData.wind.speed);

    // Hero subtitle clock: short city name (before any comma) + local time.
    const cityShort = (cityName || '').split(',')[0].trim() || cityName || '';
    const cityClock = this.formatTime(nowSec, true, tz);
    this._clockTimezone = tz;
    this._ensureClockTimer();

    // Small label above the weather icon. Default behaviour:
    //   - today (no hour pinned)            → "Right now"
    //   - other day (no hour pinned)        → "Tuesday's forecast"
    // When a specific hourly tile is pinned, swap in a contextual phrase
    // that names both the relative day and the time-of-day band:
    //   - today + morning/afternoon hour    → "Today at 11 AM"
    //   - today + evening hour (17–20)      → "This evening at 8 PM"
    //   - today + night hour (21–23, 0–4)   → "Tonight at 10 PM"
    //   - any other day                     → "Tuesday at 3 PM"
    // The day-of-week comes from the hour's CITY-local date (via dayKeyFor),
    // not the dashboard's selectedDayIndex, so a tile from tomorrow's
    // slots in the scroller reads "Wednesday at..." even though the
    // dashboard day is also being switched.
    let heroWhen = 'Right now';
    if (pinnedHourSlot) {
      const hourLabel = this.formatTime(pinnedHourSlot.dt, true, tz);
      const hourDayKey = dayKeyFor(pinnedHourSlot.dt);
      const localHour = this.localHour(pinnedHourSlot.dt, tz);
      if (hourDayKey === todayKey) {
        if (localHour >= 17 && localHour <= 20)      heroWhen = `This evening at ${hourLabel}`;
        else if (localHour >= 21 || localHour <= 4)  heroWhen = `Tonight at ${hourLabel}`;
        else                                          heroWhen = `Today at ${hourLabel}`;
      } else {
        // Derive the weekday from the slot's canonical city-local dayKey
        // so a slot that's "Wednesday in Tokyo" doesn't render as
        // "Tuesday" just because the browser is in New York.
        const [ky, km, kd] = hourDayKey.split('-').map(Number);
        const d = new Date(Date.UTC(ky, km - 1, kd));
        const weekday = d.toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' });
        heroWhen = `${weekday} at ${hourLabel}`;
      }
    } else if (!isToday) {
      const day = dailyData[selectedDayIndex];
      if (day && day.key) {
        const [yy, mo, dd] = day.key.split('-').map(Number);
        const date = new Date(Date.UTC(yy, mo - 1, dd));
        const weekday = date.toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' });
        heroWhen = `${weekday}'s forecast`;
      }
    }

    // Big temperature readout.
    //   - hour pinned         → that hour's single temp (regardless of day)
    //   - today, no pin       → current temp
    //   - other day, no pin   → the day's high / low
    let heroTempHTML;
    if (pinnedHourSlot) {
      heroTempHTML = `<div class="hero-temp-large">${this.formatTemp(heroData.main.temp)}°</div>`;
    } else if (isToday) {
      const newTempStr = `${this.formatTemp(activeDay.main.temp)}°`;
      if (oldTempStr && oldTempStr !== newTempStr) {
        shouldFlip = true;
        heroTempHTML = `
          <div class="hero-temp-flip-container">
            <div class="hero-temp-flip-card">
              <div class="hero-temp-flip-front hero-temp-large">${oldTempStr}</div>
              <div class="hero-temp-flip-back hero-temp-large">${newTempStr}</div>
            </div>
          </div>
        `;
      } else {
        heroTempHTML = `<div class="hero-temp-large">${newTempStr}</div>`;
      }
    } else {
      const day = dailyData[selectedDayIndex];
      const ex = dayExtremesC(day);
      const hi = Math.round(this.convertTemp(ex ? ex.hi : Math.max(...day.temps)));
      const lo = Math.round(this.convertTemp(ex ? ex.lo : Math.min(...day.temps)));
      heroTempHTML = `<div class="hero-temp-large">${hi}° / ${lo}°</div>`;
    }

    // UV: current for today, daily-max for forecast days. Falls back to '—' if
    // Open-Meteo was unreachable or returned no data for this slot.
    // The daily max is matched by city-local day KEY, not array index —
    // Open-Meteo's daily[0] is "today", but rendered day 0 can already
    // be tomorrow near local midnight (OWM's forecast window), which
    // used to show every forecast day the previous day's UV max.
    const uv = state.uv || { current: null, daily: [] };
    // omDailyForKey is defined further up, alongside dayExtremesC.
    const uvForKey = (key) => {
      const om = omDailyForKey(key);
      return om && om.uvIndexMax != null ? om.uvIndexMax : null;
    };
    const activeDayEntry = isToday ? dailyData[0] : dailyData[selectedDayIndex];
    const activeDayUvKey = activeDayEntry ? activeDayEntry.key : null;
    // Open-Meteo's daily summary for the active day — the authoritative
    // whole-day numbers (max precip probability, max wind, sunshine)
    // that beat anything derived from sampled 3h slots.
    const activeOmDay = omDailyForKey(activeDayUvKey);
    let uvValue = isToday
      ? (uv.current != null ? uv.current : uvForKey(activeDayUvKey))
      : uvForKey(activeDayUvKey);
    // A pinned hour shows THAT hour's UV when Open-Meteo has it, not the
    // day max — matches how the rest of the hero tracks the pinned slot.
    if (pinnedHourSlot) {
      const omHour = (state.omHourly || []).find(h => h.dt === pinnedHourSlot.dt);
      if (omHour && omHour.uvIndex != null) uvValue = omHour.uvIndex;
    }

    // Precip chance: for forecast days prefer the daily max probability
    // over the max of sampled slots. Today keeps the rest-of-day slot
    // figure — the daily max can reflect rain that already fell.
    const popValue = (!isToday && activeOmDay && activeOmDay.popMax != null)
      ? activeOmDay.popMax / 100
      : (activeDay.pop || 0);

    // Cloud cover: pinned hour → that slot; today → current conditions;
    // forecast day → mean over the day's slots that carry a value.
    const cloudCover = (() => {
      if (pinnedHourSlot && pinnedHourSlot.clouds && pinnedHourSlot.clouds.all != null) {
        return pinnedHourSlot.clouds.all;
      }
      if (isToday && currentWeather.clouds && currentWeather.clouds.all != null) {
        return currentWeather.clouds.all;
      }
      const vals = ((activeDayEntry && activeDayEntry.hourly) || [])
        .map(h => h.clouds && h.clouds.all)
        .filter(v => v != null);
      if (!vals.length) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    })();

    const sunriseStat = activeDay.sunrise != null ? `
      <div class="stat-item">
        <span class="stat-label">Sunrise</span>
        <span class="stat-value">${this.formatTime(activeDay.sunrise, true, tz)}</span>
      </div>` : '';
    const sunsetStat = activeDay.sunset != null ? `
      <div class="stat-item">
        <span class="stat-label">Sunset</span>
        <span class="stat-value">${this.formatTime(activeDay.sunset, true, tz)}</span>
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

    const windArrow = Number.isFinite(activeDay.wind.deg)
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate(${activeDay.wind.deg}deg); margin-left: 2px; vertical-align: -2px;"><line x1="12" y1="4" x2="12" y2="20"></line><polyline points="18 14 12 20 6 14"></polyline></svg>`
      : '';

    // Build the moon-phase + UV-index cells once so the page-1 / page-2
    // logic below can shuffle them between pages without re-building.
    // Moon-phase is built by hand (not via item()) because item() escapes
    // its label, which would turn the icon's <img> markup into text.
    const moonStatHTML = (() => {
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
    })();
    // The "UV index" LABEL gets a WHO-colored pill only at the top two
    // bands — Very High (red) and Extreme (purple) — same treatment as
    // the Air quality label's EPA bands. Anything below stays plain.
    // Cell built by hand because item() escapes its label.
    const uvBandClass = (() => {
      if (uvValue == null || isNaN(uvValue)) return '';
      const v = Math.round(uvValue);
      if (v >= 11) return ' uv-band-extreme';
      if (v >= 8)  return ' uv-band-veryhigh';
      return '';
    })();
    const uvStatItem = `
      <div class="stat-item">
        <span class="stat-label${uvBandClass}">UV index</span>
        <span class="stat-value">${this.esc(this.uvLabel(uvValue))}</span>
      </div>`;

    // Is it night-time at the city for the active day? Two parallel
    // checks, ORed together:
    //   1) Sun-based: active slot is before today's sunrise or after
    //      today's sunset. Catches normal latitudes correctly.
    //   2) Clock-based: local hour at the city is in the 20:00 — 06:00
    //      band. Catches high-latitude "white nights" (e.g. Reykjavík
    //      in May/June where sunset is ~11:30 PM and a casual 10 PM
    //      user still expects to see the moon, not UV).
    //
    // Either signal alone is enough. The clock band also degrades
    // gracefully in winter at high latitudes (polar night): sun says
    // night all day, so isNightAtCity is true around the clock and
    // the moon takes page 1 — which is what you'd actually want when
    // it's literally dark out at noon.
    const sunSaysNight =
      activeDay.dt != null &&
      activeDay.sunrise != null && activeDay.sunset != null &&
      (activeDay.dt < activeDay.sunrise || activeDay.dt > activeDay.sunset);
    const localHourAtCity = activeDay.dt != null
      ? this.localHour(activeDay.dt, tz)
      : 12; // safe noon default if we have no timestamp
    const clockSaysNight = localHourAtCity >= 20 || localHourAtCity < 6;
    const isNightAtCity = sunSaysNight || clockSaysNight;

    // UV above the "Low" band (0-2 rounded) is health-relevant enough
    // that it always belongs on page 1, even at night — displacing the
    // moon back to page 2 when the two would otherwise compete. The
    // thresholds match uvLabel(): Moderate (3-5) / High (6-7) /
    // Very High (8-10) / Extreme (11+) all qualify.
    const uvRounded = (uvValue != null && !isNaN(uvValue)) ? Math.round(uvValue) : 0;
    const uvIsNoteworthy = uvRounded > 2;
    const uvOnPage1 = uvIsNoteworthy || !isNightAtCity;

    // Page-1 candidates (in priority order). Sunrise / Sunset / Dew point
    // are always on page 2. Moon phase / UV index swap pages based on
    // whether it's day or night at the city.
    // Page-1 candidates. Only the first six render on page 1, so order
    // is priority — and priority follows NOTEWORTHINESS: extreme or
    // unusual readings (a gale gust, Unhealthy air, storm-low pressure)
    // always outrank routine everyday stats, which then fill whatever
    // page-1 slots remain in their own order. A "Moderate" AQI or a
    // calm day's max wind is background info, not a headline.
    const notable = [];
    const routine = [];

    routine.push(item('Wind',
      `${this.formatWind(activeDay.wind.speed)}${
        this.windDirection(activeDay.wind.deg)
          ? ' ' + this.windDirection(activeDay.wind.deg) + windArrow : ''}`));
    if (hasGust) notable.push(item('Wind gust', this.formatWind(activeDay.wind.gust)));
    // Unusually dry or muggy air is notable; the broad middle is routine.
    const humidity = activeDay.main.humidity;
    (humidity <= 20 || humidity >= 85 ? notable : routine)
      .push(item('Humidity', `${humidity}%`));
    if (cloudCover != null) {
      routine.push(item('Cloud cover', `${Math.round(cloudCover)}%`));
    }
    // Precipitation amount and chance — only shown when actually
    // relevant; a real accumulation or a likely shower is notable, a
    // token few percent is not.
    if ((activeDay.rainMM || 0) > 0) {
      notable.push(item('Precipitation', this.formatPrecip(activeDay.rainMM)));
    }
    // Snow accumulation, whenever there is any. Always notable — snow is
    // the kind of thing you reorganise a day around, and unlike rain
    // there's no "token amount" worth suppressing.
    //
    // Today uses the SAME rest-of-day window as the Precipitation row
    // above, converted from water-equivalent back to depth. Using the
    // calendar-day snowSumCM here instead would put the two rows on
    // different clocks: at 6 PM after a morning fall you'd see no
    // Precipitation row (nothing left to come) but "Snow 5.0 cm" — and
    // since snow's water equivalent is already folded into rainMM, the
    // two would be describing overlapping amounts over different spans.
    // Forecast days prefer Open-Meteo's exact daily depth, but fall back
    // to the slot sum when enrichment is unavailable — otherwise the card
    // shows a Precipitation figure (which already includes snow) with no
    // Snow row beside it.
    const snowFromSlots = activeDay.snowMM != null
      ? activeDay.snowMM * this.SNOW_DEPTH_TO_WATER
      : 0;
    const snowDepthCM = (!isToday && activeOmDay && activeOmDay.snowSumCM != null)
      ? activeOmDay.snowSumCM
      : snowFromSlots;
    if (snowDepthCM > 0) {
      notable.push(item('Snow', this.formatSnowDepth(snowDepthCM)));
    }
    if (popValue > 0) {
      (popValue >= 0.3 ? notable : routine)
        .push(item('Precip chance', `${Math.round(popValue * 100)}%`));
    }
    // UV earns a headline slot only when it's actually elevated; UV
    // shown merely because it's daytime — and the moon — are routine.
    (uvOnPage1 && uvIsNoteworthy ? notable : routine)
      .push(uvOnPage1 ? uvStatItem : moonStatHTML);
    // Name the pollutant driving the AQI once it's past "Good" — when
    // the air is fine, blaming a pollutant is noise. Headline placement
    // starts at Unhealthy-for-Sensitive-Groups (AQI > 100).
    const aqiText = (aq.aqi != null && aq.aqi > 50 && aq.aqiPollutant)
      ? `${this.aqiLabel(aq.aqi)}, ${aq.aqiPollutant}`
      : this.aqiLabel(aq.aqi);
    // The "Air quality" LABEL gets an EPA-colored pill once the band
    // crosses into health-relevant territory: orange from Sensitive
    // (>100), red from Unhealthy (>150), purple from Very Unhealthy
    // (>200), maroon at Hazardous (>300). Below that, no highlight.
    // Cell built by hand because item() escapes its label.
    const aqiBandClass = (() => {
      if (aq.aqi == null) return '';
      const v = Math.round(aq.aqi);
      if (v > 300) return ' aqi-band-hazardous';
      if (v > 200) return ' aqi-band-veryunhealthy';
      if (v > 150) return ' aqi-band-unhealthy';
      if (v > 100) return ' aqi-band-sensitive';
      return '';
    })();
    const airQualityItem = `
      <div class="stat-item">
        <span class="stat-label${aqiBandClass}">Air quality</span>
        <span class="stat-value">${this.esc(aqiText)}</span>
      </div>`;
    (aq.aqi != null && aq.aqi > 100 ? notable : routine).push(airQualityItem);
    // Whole-day max sustained wind — notable from Beaufort "strong
    // breeze" (10.7 m/s ≈ 24 mph) upward.
    if (activeOmDay && activeOmDay.windMax != null) {
      (activeOmDay.windMax >= 10.7 ? notable : routine)
        .push(item('Max wind', this.formatWind(activeOmDay.windMax)));
      // Whole-day peak gust, on the same "only when it says something the
      // sustained figure doesn't" rule the hourly Wind gust stat uses.
      if (activeOmDay.gustMax != null &&
          this.isNoteworthyGust(activeOmDay.windMax, activeOmDay.gustMax)) {
        notable.push(item('Max gust', this.formatWind(activeOmDay.gustMax)));
      }
    }

    const getSunTimesForTimestamp = (ts) => {
      const local = this.localParts(ts, tz);
      return this._solarTimes(
        local.year,
        local.month,
        local.day,
        currentWeather.coord.lat,
        currentWeather.coord.lon,
        tz
      );
    };

    let activeFullMoon = null;
    let optimalTimeStr = '';
    let moonFilter = '';
    const currentDt = heroData.dt;

    // Only the 3 full moons closest to currentDt can possibly bracket
    // it (previous / nearest / next by index). No year-scoped table
    // needed and no fixed 13-entry scan per render.
    for (const fm of getRelevantFullMoons(currentDt)) {
      const fmSun = getSunTimesForTimestamp(fm.dt);
      const nextDaySun = getSunTimesForTimestamp(fm.dt + 86400);

      if (fmSun.sunset && nextDaySun.sunrise) {
        const startDt = fmSun.sunset - 12 * 3600;
        const endDt = nextDaySun.sunrise;

        if (currentDt >= startDt && currentDt <= endDt) {
          activeFullMoon = fm;

          let optimalDt = fm.dt;
          const fmPeakIsAtNight = fm.dt >= fmSun.sunset && fm.dt <= nextDaySun.sunrise;
          
          if (!fmPeakIsAtNight) {
            optimalDt = fmSun.sunset + (nextDaySun.sunrise - fmSun.sunset) / 2;
          }

          optimalTimeStr = this.formatTime(optimalDt, true, tz);

          switch (fm.name) {
            case 'Wolf Moon':
            case 'Snow Moon':
              moonFilter = 'drop-shadow(0 0 10px rgba(255, 255, 255, 0.25))';
              break;
            case 'Worm Moon':
              moonFilter = 'drop-shadow(0 0 10px rgba(255, 220, 150, 0.35)) saturate(1.2) hue-rotate(15deg)';
              break;
            case 'Pink Moon':
              moonFilter = 'drop-shadow(0 0 12px rgba(255, 105, 180, 0.45)) saturate(1.4) hue-rotate(320deg)';
              break;
            case 'Flower Moon':
              moonFilter = 'drop-shadow(0 0 12px rgba(255, 182, 193, 0.35)) saturate(1.3) hue-rotate(340deg)';
              break;
            case 'Blue Moon':
              moonFilter = 'drop-shadow(0 0 12px rgba(30, 144, 255, 0.5)) saturate(1.6) hue-rotate(180deg)';
              break;
            case 'Strawberry Moon':
              moonFilter = 'drop-shadow(0 0 14px rgba(255, 100, 100, 0.55)) saturate(1.5) hue-rotate(345deg)';
              break;
            case 'Buck Moon':
              moonFilter = 'drop-shadow(0 0 12px rgba(218, 165, 32, 0.45)) saturate(1.4) hue-rotate(10deg)';
              break;
            case 'Sturgeon Moon':
              moonFilter = 'drop-shadow(0 0 10px rgba(176, 196, 222, 0.35))';
              break;
            case 'Harvest Moon':
              moonFilter = 'drop-shadow(0 0 14px rgba(255, 140, 0, 0.6)) saturate(1.7) hue-rotate(15deg)';
              break;
            case 'Hunter\'s Moon':
              moonFilter = 'drop-shadow(0 0 14px rgba(255, 69, 0, 0.6)) saturate(1.6) hue-rotate(5deg)';
              break;
            case 'Beaver Moon':
              moonFilter = 'drop-shadow(0 0 12px rgba(205, 133, 63, 0.4)) saturate(1.1)';
              break;
            case 'Cold Moon':
              moonFilter = 'drop-shadow(0 0 12px rgba(0, 255, 255, 0.45)) saturate(1.3) hue-rotate(150deg)';
              break;
            default:
              moonFilter = 'drop-shadow(0 0 10px rgba(255, 255, 255, 0.25))';
          }
          break;
        }
      }
    }

    let moonCardHTML = '';
    if (activeFullMoon) {
      moonCardHTML = `
        <div class="stat-item full-moon-card" style="grid-column: span 3; display: flex; flex-direction: row; align-items: center; text-align: left; padding: 16px 20px; background: rgba(255, 255, 255, 0.03); border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.08); gap: 16px;">
          <img src="assets/icons/weather/moon-full.svg" alt="Full Moon" style="width: 48px; height: 48px; flex-shrink: 0; filter: ${moonFilter};" />
          <div style="min-width: 0;">
            <div style="font-size: 1.25rem; font-weight: 700; color: #eaeaea; line-height: 1.2;">${this.esc(activeFullMoon.name)}</div>
            <div style="font-size: 0.95rem; color: #a0a0a0; margin-top: 4px;">Most Pronounced: ${optimalTimeStr}</div>
          </div>
        </div>
      `;
    }

    // Tides. Two distinct questions depending on what you're looking at:
    //
    //   Today, nothing pinned  → "what's next from right now"
    //   Any other day/hour     → "what happens on the day I selected"
    //
    // The old code always used `heroData.dt`, which on a forecast day is
    // the day's MIDDAY slot. That produced rows labelled "Next high tide"
    // that actually meant "first high tide after noon on that day" — and
    // the matching low routinely landed after local midnight, rendered as
    // a bare "1:40 AM" with nothing saying it belonged to the next day.
    let nextHighItem = null;
    let nextLowItem = null;
    let tideRowsExpected = false;

    if (state.tideExtrema && state.tideExtrema.length > 0) {
      const liveNow = isToday && !pinnedHourSlot;
      const anchorDt = heroData.dt;

      // Local-day window for the selected day, used for the non-live case.
      const dayStartSec = activeOmDay
        ? activeOmDay.dt
        : (activeDayUvKey ? (() => {
            const [yy, mo, dd] = activeDayUvKey.split('-').map(Number);
            const off = typeof tz === 'number' ? tz : (currentWeather.timezone || 0);
            return Math.floor(Date.UTC(yy, mo - 1, dd) / 1000) - off;
          })() : null);

      const pick = (type) => {
        if (liveNow || dayStartSec == null) {
          return state.tideExtrema.find(e => e.type === type && e.dt > anchorDt) || null;
        }
        // Take the end from the NEXT day's local midnight rather than
        // +86400: Open-Meteo's per-day dt is DST-correct, so on a
        // spring-forward day the fixed offset would bleed an hour into
        // tomorrow (surfacing tomorrow's tide with no "tomorrow" label),
        // and on a fall-back day it would drop the last hour.
        const nextDay = (state.omDaily || []).find(d => d.dt > dayStartSec);
        const dayEndSec = nextDay ? nextDay.dt : dayStartSec + 86400;
        return state.tideExtrema.find(
          e => e.type === type && e.dt >= dayStartSec && e.dt < dayEndSec
        ) || null;
      };

      // The marine series covers the same 8 days as the forecast, so a
      // missing extremum is a genuine gap, not the range running out.
      // Render the em dash rather than dropping the row, matching how
      // Moonrise / Moonset handle a skipped rise.
      tideRowsExpected = true;

      const tideValue = (e) => {
        if (!e) return '—';
        // Heights are metres relative to MSL; below ±1.5 m the number is
        // noise for most readers, so only the time is shown.
        const heightStr = Math.abs(e.h) > 1.5 ? ` (${this.formatTideHeight(e.h)})` : '';
        // Only reachable in the live case, where "next" can cross midnight.
        const dayStr = dayKeyFor(e.dt) !== dayKeyFor(anchorDt) ? ' tomorrow' : '';
        return `${this.formatTime(e.dt, true, tz)}${dayStr}${heightStr}`;
      };

      const highLabel = liveNow ? 'Next high tide' : 'High tide';
      const lowLabel  = liveNow ? 'Next low tide'  : 'Low tide';
      nextHighItem = item(highLabel, tideValue(pick('High')));
      nextLowItem  = item(lowLabel,  tideValue(pick('Low')));
    }

    // Fallback coastal test: how close the marine grid cell the API
    // snapped to is to the city itself. Longitude degrees shrink toward
    // the poles, so the raw Pythagorean distance used before made the
    // effective radius ~7km at the equator but only ~3.5km at 60°N —
    // Nordic coastal cities were being demoted to the last stats page.
    // Scale the longitude term by cos(lat) for a true ~7km everywhere.
    //
    // A matched NOAA station IS the coastal signal — stations only exist
    // on tidal water, and it's a far stronger statement than "the marine
    // model grid snapped somewhere nearby". Checked first so a location
    // with good tide data never gets demoted to the last stats page
    // because the Open-Meteo grid cell happened to land far offshore.
    // Two separate questions, deliberately not conflated:
    //   marineCellIsLocal — is Open-Meteo's grid cell actually near this
    //     city? Governs WATER TEMP, which comes only from that cell.
    //   touchesWater — should tide rows show at all? A NOAA station is a
    //     stronger yes than any proximity heuristic.
    // Reusing one flag for both would let a nearby station vouch for an
    // SST reading taken 40km offshore, behind a headland or up a bay.
    let marineCellIsLocal = false;
    if (currentWeather.coord && state.tideCoords) {
      const latRad = currentWeather.coord.lat * Math.PI / 180;
      const dLat = state.tideCoords.lat - currentWeather.coord.lat;
      const dLon = (state.tideCoords.lon - currentWeather.coord.lon) * Math.cos(latRad);
      const degDiff = Math.sqrt(dLat * dLat + dLon * dLon);
      marineCellIsLocal = degDiff <= 0.065;
    }
    const touchesWater = !!state.tidePredictions || marineCellIsLocal;

    if (touchesWater && tideRowsExpected) {
      routine.push(nextHighItem);
      routine.push(nextLowItem);
    }

    // Sea-surface temperature for the hour being viewed. Gated on
    // marineCellIsLocal rather than touchesWater: Open-Meteo's marine
    // cell is the sole source, so if that cell isn't near the city the
    // number isn't this city's water, whatever the tide station says.
    const waterTemp = this._waterTempAt(state.tides, heroData.dt);
    if (marineCellIsLocal && waterTemp != null) {
      routine.push(item('Water temp', `${this.formatTemp(waterTemp)}°`));
    }

    // Pressure / visibility only render at all when unusual — notable
    // by definition. Pollen is notable from the "High" band (≥50).
    if (hasPressure)        notable.push(item('Pressure',   this.formatPressure(activeDay.main.pressure)));
    if (hasVisibility)      notable.push(item('Visibility', this.formatDist(activeDay.visibility)));
    if (aq.pollen != null) {
      (aq.pollen >= 50 ? notable : routine)
        .push(item('Pollen', this.esc(this.pollenLabel(aq.pollen))));
    }

    // Notable readings first, routine stats fill the rest — page 1 is
    // whatever the top six of that combined order turn out to be.
    const page1Candidates = [...notable, ...routine];

    const STATS_PER_PAGE = 6;

    // Local time is a "flex" item: it fills any unused slot on page 1
    // (so the city's current time stays visible by default whenever
    // possible), and falls back to page 2 if page 1 is already full.
    // The #city-clock id stays on the value span so the existing
    // ticking-clock interval keeps it updated without a full re-render.
    const localTimeItem = item('Local time', `<span id="city-clock">${this.esc(cityClock)}</span>`);
    const localTimeOnPage1 = page1Candidates.length < STATS_PER_PAGE;
    if (localTimeOnPage1) page1Candidates.push(localTimeItem);

    // Fixed page-2 leaders. Top line = Sunrise / Sunset / (Moon or UV);
    // second line begins with Local time (when page 1 had no room),
    // then Dew point. Whichever of Moon / UV got moved to page 1 is the
    // one MISSING here, so each value always appears exactly once.
    const page2Forced = [
      item('Sunrise',    activeDay.sunrise != null ? this.formatTime(activeDay.sunrise, true, tz) : '—'),
      item('Sunset',     activeDay.sunset  != null ? this.formatTime(activeDay.sunset,  true, tz) : '—'),
      // Whichever of moon / UV did NOT make it onto page 1 lives here.
      // The two together always cover both values exactly once.
      uvOnPage1 ? moonStatHTML : uvStatItem,
    ];
    if (!localTimeOnPage1) page2Forced.push(localTimeItem);
    page2Forced.push(item('Dew point', dewPoint != null ? `${this.formatTemp(dewPoint)}°` : '—'));

    // Moonrise / moonset for the active day, computed for the city's
    // local midnight (Open-Meteo's per-day dt when available — the
    // DST-correct instant — else derived from the day key + offset).
    if (activeDayUvKey) {
      const dayStartSec = activeOmDay ? activeOmDay.dt : (() => {
        const [yy, mo, dd] = activeDayUvKey.split('-').map(Number);
        const off = typeof tz === 'number' ? tz : (currentWeather.timezone || 0);
        return Math.floor(Date.UTC(yy, mo - 1, dd) / 1000) - off;
      })();
      const mt = this._moonTimes(dayStartSec, currentWeather.coord.lat, currentWeather.coord.lon);
      // A null is real astronomy (the moon skips a rise or set roughly
      // every couple of weeks) — show the em dash rather than hiding.
      page2Forced.push(item('Moonrise', mt.rise != null ? this.formatTime(mt.rise, true, tz) : '—'));
      page2Forced.push(item('Moonset',  mt.set  != null ? this.formatTime(mt.set,  true, tz) : '—'));
    }

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

    if (activeOmDay && activeOmDay.sunshineSec != null) {
      lowPriority.push(item('Sunshine', `${(activeOmDay.sunshineSec / 3600).toFixed(1)} h`));
    }

    // Marine data exists but the snapped grid cell is far from the city
    // (a lake town, or a coastal cell reached across a headland). Still
    // worth showing, just not competing for a page-1 slot.
    if (!touchesWater && tideRowsExpected) {
      lowPriority.push(nextHighItem);
      lowPriority.push(nextLowItem);
    }

    let statsPages = [];

    if (activeFullMoon) {
      const page1Items = [moonCardHTML, ...page1Candidates.slice(0, 3)];
      statsPages.push(page1Items.join(''));

      const overflow = page1Candidates.slice(3);
      const page2AndAfter = [...page2Forced, ...overflow, ...lowPriority];
      for (let i = 0; i < page2AndAfter.length; i += STATS_PER_PAGE) {
        statsPages.push(padToFull(page2AndAfter.slice(i, i + STATS_PER_PAGE)));
      }
    } else {
      const page1 = page1Candidates.slice(0, STATS_PER_PAGE);
      const overflow = page1Candidates.slice(STATS_PER_PAGE);
      const page2AndAfter = [...page2Forced, ...overflow, ...lowPriority];

      statsPages.push(padToFull(page1));
      for (let i = 0; i < page2AndAfter.length; i += STATS_PER_PAGE) {
        statsPages.push(padToFull(page2AndAfter.slice(i, i + STATS_PER_PAGE)));
      }
    }
    // Reset to page 0 whenever the city changes; otherwise preserve.
    if (this._renderedCityName !== cityName) this._statsPageIdx = 0;
    if (this._statsPageIdx == null || this._statsPageIdx >= statsPages.length) this._statsPageIdx = 0;
    this._statsPages = statsPages;

    // Precip line under the hero. A 15-minute nowcast transition inside
    // the next 2h beats the day-level percentage — "Rain starting around
    // 3:15 PM" is strictly more useful than "60% chance". Nowcast only
    // applies to the live "today" view.
    // Late in the evening the last 3h slot of today has passed, so the
    // rest-of-day window is empty and pop is 0 — which is the absence of
    // a forecast, not a forecast of nothing. Asserting "No precipitation
    // expected" there put that text on screen at 22:30 in a downpour,
    // next to a rain icon and a graph full of rain bars. Say nothing
    // instead; the hero already shows current conditions.
    const noWindow = isToday && activeDay.hasWindow === false;
    let precipMsg = popValue > 0.1
      ? `${Math.round(popValue * 100)}% chance of precipitation`
      : (noWindow ? '' : 'No precipitation expected');
    if (isToday && !pinnedHourSlot) {
      const cast = this._precipNowcast(state.omMinutely, nowSec);
      if (cast) {
        precipMsg = `Rain ${cast.type === 'starts' ? 'starting' : 'ending'} around ${this.formatTime(cast.dt, true, tz)}`;
      }
    }

    // "Warmer/cooler than this time yesterday" — the past_days=1 slice
    // of Open-Meteo's hourly series. Compare in the user's display unit
    // so the rounded degree difference matches what the hero shows.
    let yesterdayMsg = '';
    if (isToday && !pinnedHourSlot) {
      const target = nowSec - 86400;
      let best = null, bestDiff = Infinity;
      for (const h of (state.omHourly || [])) {
        const d = Math.abs(h.dt - target);
        if (d < bestDiff) { bestDiff = d; best = h; }
      }
      if (best && bestDiff <= 3600 && best.temp != null) {
        const diff = Math.round(this.convertTemp(currentWeather.main.temp) - this.convertTemp(best.temp));
        yesterdayMsg = diff === 0
          ? 'About the same as yesterday'
          : `${Math.abs(diff)}° ${diff > 0 ? 'warmer' : 'cooler'} than this time yesterday`;
      }
    }

    // Index of the real "today" entry in dailyData, matched by day KEY
    // instead of trusting array position (same rule as the daily list).
    // Today is chronologically first whenever present, so this is 0 in
    // practice — but near local midnight, when OWM's window has rolled
    // past the city's calendar day AND enrichment couldn't fill it in,
    // dailyData[0] is already tomorrow and no key matches. Fall back to
    // 0 then so the Now tile still anchors the scroller.
    const todayIdx = dailyData.findIndex(d => d.key === todayKey);
    const nowDayIdx = todayIdx !== -1 ? todayIdx : 0;
    // Index of the currently-displayed day in dailyData, used by the
    // hourly-scroll to highlight its tiles and detect scroll-driven day
    // changes. Both -1 (initial) and 0 (Today tab) map to the Now day.
    const currentDayIdx = isToday ? nowDayIdx : selectedDayIndex;

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
            heroData.weather[0]._asset || heroData.weather[0].icon,
            48,
            heroData.weather[0].id,
            // dt for phase substitution: today (no pin) uses the current
            // weather's dt (= now), forecast days use the mid-of-day
            // slot's dt; a pinned hour uses that hour's exact dt so the
            // moon-phase / day-vs-night art is hour-accurate.
            heroData.dt
          )}</div>
          <span class="hero-desc">${this.esc(heroData.weather[0].description)}</span>
        </div>
        ${heroTempHTML}
        <div class="hero-feels-like">Feels like ${this.formatTemp(heroData.main.feels_like)}° - ${this.esc(breeze)}</div>
        ${yesterdayMsg ? `<div class="hero-yesterday">${this.esc(yesterdayMsg)}</div>` : ''}
        ${precipMsg ? `<div class="precip-message">${precipMsg}</div>` : ''}
      </section>

      <!-- .stats-pager stays the OUTER box so every existing selector
           that reaches for it — the context-menu exclusion list, the
           city-swipe opt-out — keeps matching, arrows included. The id
           moves to the inner faces div: that's what _changeStatsPage
           replaces wholesale and spins, so anything meant to persist
           across a page flip has to live OUTSIDE it. -->
      <div class="stats-pager">
        <div class="stats-pager-faces" id="stats-pager">
          <section class="quick-stats-grid">
            ${statsPages[this._statsPageIdx] || ''}
          </section>
        </div>
        ${statsPages.length > 1 ? `
          <button type="button" class="stats-page-arrow prev" aria-label="Previous stats page">${STATS_ARROW_SVG}</button>
          <button type="button" class="stats-page-arrow next" aria-label="Next stats page">${STATS_ARROW_SVG}</button>
        ` : ''}
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
        ${(() => {
          // Drop any slot whose start time is no longer in the future.
          // OWM 3h slots use their START time as dt — so once the 12 PM
          // slot has started, "Now" is the right label for it and the
          // dedicated Now tile (below) takes over the visual spot. This
          // also keeps the timeline from showing a stale 9 AM tile next
          // to "Now" at 11:30 AM. Open-Meteo filler slots are 1h-spaced
          // and only appear on forecast days (entirely in the future),
          // so the rule is a no-op there.
          //
          // Today's section is also prefixed with a synthetic "Now" tile
          // sourced from the live currentWeather — its label and data
          // always reflect THIS moment, not a 3h-block snapshot. Tapping
          // it clears any pinned hour and returns the hero to the
          // "Right now" view (via onDayClick(nowDayIdx), which is what
          // handleDayClick does).
          //
          // We also skip any day that becomes empty after filtering and
          // suppress the day-divider before the first day actually
          // rendered, so the scroller can't lead with an orphan divider.
          // Today never becomes empty because the Now tile is always
          // present.
          const cw = currentWeather;
          let out = '';
          let firstShown = true;
          for (let dayIdx = 0; dayIdx < dailyData.length; dayIdx++) {
            const day = dailyData[dayIdx];
            if (!day || !day.hourly) continue;
            let slots = day.hourly.filter(h => h.dt > nowSec);
            // Swap in the denser near-term 2h tiles where they cover
            // this day, keeping only 3h slots that start ≥2h after the
            // last 2h tile so the seam doesn't produce near-duplicate
            // neighbours.
            const near = nearTermByKey.get(day.key);
            if (near && near.length) {
              slots = near.concat(slots.filter(h => h.dt >= lastNearTermDt + 2 * 3600));
            }
            const isTodayCol = dayIdx === nowDayIdx;
            if (!slots.length && !isTodayCol) continue;
            if (!firstShown) out += '<div class="hourly-day-divider"></div>';
            firstShown = false;

            if (isTodayCol) {
              // The Now tile is the hero-equivalent in the scroller: it
              // glows when the hero is showing "Right now" (i.e. today
              // is selected AND no hour is pinned) so the user can see
              // at a glance which tile their hero card represents.
              const nowActive =
                isToday && selectedHourDt == null
                  ? 'active-hour' : '';
              const nowStyle = CONFIG_TEMP_LINE_COLOR.enabled && nowActive
                ? `style="box-shadow: inset 0 0 0 2px ${getTempColor(cw.main.temp)} !important;"`
                : '';
              const w0 = cw.weather && cw.weather[0] ? cw.weather[0] : null;
              const nowIcon = w0
                ? this.getWeatherIconSVG(w0.icon, 28, w0.id, cw.dt)
                : '';
              out += `
                <div class="hourly-tile active-day ${nowActive}" data-day-index="${nowDayIdx}" data-now="1" role="button" tabindex="0" aria-label="Now, ${this.formatTemp(cw.main.temp)}°" ${nowStyle}>
                  <span class="hourly-time">Now</span>
                  <span class="hourly-icon">${nowIcon}</span>
                  <span class="hourly-temp">${this.formatTemp(cw.main.temp)}°</span>
                  <span class="hourly-pop">&nbsp;</span>
                </div>`;
            }

            for (const h of slots) {
              const isActive = selectedHourDt === h.dt;
              const cls =
                (dayIdx === currentDayIdx ? 'active-day ' : '') +
                (isActive ? 'active-hour' : '');
              const tileStyle = CONFIG_TEMP_LINE_COLOR.enabled && isActive
                ? `style="box-shadow: inset 0 0 0 2px ${getTempColor(h.main.temp)} !important;"`
                : '';
              // Guard weather[0] like the Now tile above does — a
              // malformed synthesised slot shouldn't kill the render.
              const hw = h.weather && h.weather[0] ? h.weather[0] : null;
              // Precip chance under the tile once it's worth acting on
              // (≥20%). The span always renders (nbsp when dry) so every
              // tile keeps the same height.
              const popPct = Math.round((h.pop || 0) * 100);
              const popTxt = popPct >= 20 ? `${popPct}%` : '&nbsp;';
              const popAria = popPct >= 20 ? `, ${popPct}% chance of precipitation` : '';
              out += `
                <div class="hourly-tile ${cls.trim()}" data-day-index="${dayIdx}" data-dt="${h.dt}" role="button" tabindex="0" aria-label="${this.formatTime(h.dt, true, tz)}, ${this.formatTemp(h.main.temp)}°${popAria}" ${tileStyle}>
                  <span class="hourly-time">${this.formatTime(h.dt, true, tz)}</span>
                  <span class="hourly-icon">${hw ? this.getWeatherIconSVG(hw.icon, 28, hw.id, h.dt) : ''}</span>
                  <span class="hourly-temp">${this.formatTemp(h.main.temp)}°</span>
                  <span class="hourly-pop">${popTxt}</span>
                </div>`;
            }
          }
          return out;
        })()}
      </section>

      <section class="daily-list">
        ${dailyData.slice(0, 8).map((d, i) => {
          // Derive the weekday/date strings from the canonical dayKey so the
          // label can never disagree with the entry's date (which used to
          // happen when re-shifting dt back through state.timezone).
          const [yy, mm, dd] = d.key.split('-').map(Number);
          const date = new Date(Date.UTC(yy, mm - 1, dd));
          const isThisDayToday = d.key === todayKey;
          const dayName = isThisDayToday
            ? 'Today'
            : date.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
          const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
          // Round AFTER converting to the user's unit to avoid compounding errors.
          const dEx = dayExtremesC(d);
          const maxTemp = Math.round(this.convertTemp(dEx ? dEx.hi : Math.max(...d.temps)));
          const minTemp = Math.round(this.convertTemp(dEx ? dEx.lo : Math.min(...d.temps)));
          // Most-notable-weather icon for the day (storm > snow > rain >
          // dust/haze > clouds > clear), tie-broken by closeness to
          // local noon. Identical picker as the hero, so tapping this
          // row slides into a matching hero illustration.
          const notable = notableSlotFor(d);
          const icon = (notable && notable.weather && notable.weather[0])
            ? this._weatherAssetName(notable.weather[0].icon, notable.weather[0].id)
            : (d.icons[Math.floor(d.icons.length / 2)] || d.icons[0]);
          const isActive = selectedDayIndex === i || (isToday && i === nowDayIdx);

          return `
            <div class="daily-item ${isActive ? 'active' : ''}" data-index="${i}" role="button" tabindex="0" aria-label="${dayName} ${dateStr}, high ${maxTemp}°, low ${minTemp}°">
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
    this._renderedCityName = cityName;

    this.weatherView.innerHTML = html;

    // Trigger flip animation if pending
    if (shouldFlip) {
      const flipCard = this.weatherView.querySelector('.hero-temp-flip-card');
      if (flipCard) {
        void flipCard.offsetHeight; // force reflow
        flipCard.classList.add('animate-flip');
      }
    }

    // Drive the ambient background-effects layer from whatever icon the
    // hero just landed on. Picks among fx-clouds / fx-rain / fx-snow /
    // fx-thunder / fx-fog / fx-haze / fx-smoke / fx-dust based on the
    // resolved asset name; clear-day / clear-night / moon-* deliberately
    // map to no effect (a clear sky has nothing to drift past).
    this.applyWeatherFX(
      (heroData.weather && heroData.weather[0] && heroData.weather[0]._asset) ||
      this._weatherAssetName(
        heroData.weather && heroData.weather[0] ? heroData.weather[0].icon : '',
        heroData.weather && heroData.weather[0] ? heroData.weather[0].id   : null
      ),
      // Pass wind so cloud/fog/dust drift direction matches the actual
      // wind direction (and speed scales animation duration). When an
      // hour is pinned this is the hour's wind; otherwise the day's.
      heroData.wind,
      // Pass the OWM weather id so the fx picker can distinguish light
      // rain / drizzle (sparse drops) from heavier rain (denser drops).
      heroData.weather && heroData.weather[0] ? heroData.weather[0].id : null
    );

    // Double-click / double-tap the big hero temperature to flip the
    // temperature unit (°F ↔ °C). Mirrors the segmented control on the
    // Units screen — same handleUnitChange path — so every temp in the
    // app (hero, hourly tiles, daily hi/lo, dew point, graph badges)
    // updates in one shot. Touch double-tap also reaches us via the
    // standard dblclick event because the element has
    // `touch-action: manipulation` in CSS, which suppresses the browser's
    // default double-tap-to-zoom and lets dblclick fire reliably.
    //
    // Bind ONE delegated listener on the stable .hero-section parent —
    // during the temp flip animation there are TWO .hero-temp-large
    // elements (flip-front and flip-back), so attaching directly to
    // each would toggle F↔C twice on a rapid double-tap and net out
    // to no change.
    const heroSection = this.weatherView.querySelector('.hero-section');
    if (heroSection && this._onUnitChange) {
      heroSection.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.hero-temp-large')) return;
        e.preventDefault();
        const current = Storage.getUnits().temp;
        const next = current === 'F' ? 'C' : 'F';
        // Keep the Units screen's segmented control visually in sync so
        // when the user opens that screen it reflects the new choice.
        const seg = document.querySelector('.segmented-control[data-setting="temp"]');
        if (seg) {
          seg.querySelectorAll('button').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-value') === next);
          });
        }
        this._onUnitChange('temp', next);
      });
    }

    this.weatherView.querySelectorAll('.daily-item').forEach(el => {
      this._bindActivate(el, () => {
        const idx = parseInt(el.getAttribute('data-index'), 10);
        // Same-day tap. Two sub-cases:
        //   (a) an hour is currently pinned → re-render to unpin (returns
        //       the hero to the day's headline view), and ask the hourly
        //       bar to snap to the day's first tile so the user sees
        //       "where they landed". For today that first tile IS the
        //       Now tile.
        //   (b) no hour pinned → no re-render needed; just smooth-scroll
        //       the hourly bar to this day's first tile so the user gets
        //       feedback from their tap. Most useful for "tap Today to
        //       jump the scroller back to Now" after they've scrolled
        //       off into tomorrow.
        if (idx === currentDayIdx) {
          if (selectedHourDt != null) {
            this._snapHourlyToActiveDay = true;
            onDayClick(idx);
            return;
          }
          const hourlyEl = this.weatherView.querySelector('.hourly-scroll');
          const firstTile = hourlyEl && hourlyEl.querySelector(`.hourly-tile[data-day-index="${idx}"]`);
          if (hourlyEl && firstTile) {
            // Suppress the scroll-into-new-day handler so this
            // programmatic smooth-scroll doesn't trigger a day change.
            // Generous window so the smooth-scroll has time to settle.
            this._suppressScrollDayChangeUntil = Date.now() + 800;
            // Compute target scrollLeft via bounding rects, NOT
            // offsetLeft. In landscape, .hourly-scroll lives inside the
            // right grid column and is not a positioned ancestor, so a
            // tile's offsetLeft can resolve relative to .app-container
            // (or further up) — yielding a number that includes the
            // entire dashboard-right x-offset on the page, scrolling
            // the bar way past the Now tile. The rect math is offset-
            // parent-agnostic and works in every layout.
            const tileRect = firstTile.getBoundingClientRect();
            const scrollRect = hourlyEl.getBoundingClientRect();
            const targetLeft =
              hourlyEl.scrollLeft + (tileRect.left - scrollRect.left);
            hourlyEl.scrollTo({ left: targetLeft, behavior: 'smooth' });
          }
          return;
        }
        const direction = idx > currentDayIdx ? 'next' : 'prev';
        const finishHeroSlide = this.captureDayRowForHeroSlide(el);
        this.changeDayWithGraphCube(idx, direction, onDayClick);
        if (finishHeroSlide) finishHeroSlide();
      });
    });

    // Hourly-tile taps → pin that hour into the hero. The tile's small
    // temp number and condition icon fly up to the hero's large slots
    // (same FLIP-style animation as the daily-list rows), then the
    // re-render swaps in the hour's data. Cross-day taps re-render
    // without an animated graph/cube — the hourly-scroll position is
    // preserved so the user stays oriented at the tile they tapped.
    //
    // The synthetic Now tile (data-now="1", no data-dt) is the inverse:
    // tapping it CLEARS any pinned hour and returns the hero to the
    // "Right now" view via onDayClick(0) (handleDayClick wipes
    // selectedHourDt and sets selectedDayIndex to 0).
    if (onHourClick) {
      this.weatherView.querySelectorAll('.hourly-tile').forEach(el => {
        this._bindActivate(el, () => {
          const isNow = el.hasAttribute('data-now');
          if (isNow) {
            // Already on "Right now"? Nothing to do.
            if (isToday && selectedHourDt == null) return;
            const finishHeroSlide = this.captureHourlyTileForHeroSlide(el);
            onDayClick(nowDayIdx);
            if (finishHeroSlide) finishHeroSlide();
            return;
          }
          const dt     = parseInt(el.getAttribute('data-dt'), 10);
          const dayIdx = parseInt(el.getAttribute('data-day-index'), 10);
          if (!isFinite(dt)) return;
          if (dt === selectedHourDt && dayIdx === currentDayIdx) return; // already pinned
          const finishHeroSlide = this.captureHourlyTileForHeroSlide(el);
          onHourClick(dt, dayIdx);
          if (finishHeroSlide) finishHeroSlide();
        });
      });
    }

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
        if (firstActiveTile) {
          // Bounding-rect math instead of offsetLeft — see comment in
          // the daily-item same-day handler above. In landscape, the
          // .hourly-scroll isn't a positioned ancestor, so a tile's
          // offsetLeft can include the full x-offset of the right
          // grid column, causing this "snap to start" to overshoot.
          const tileRect = firstActiveTile.getBoundingClientRect();
          const scrollRect = hourlyEl.getBoundingClientRect();
          hourlyEl.scrollLeft += (tileRect.left - scrollRect.left);
        }
      }
      this._snapHourlyToActiveDay = false;
      this._bindHourlyDayScroll(hourlyEl, currentDayIdx, onDayClick);
    }

    // Position marker: a solid line at the hour you pinned, or a dimmer
    // one at the live "now" on today. On a forecast day with nothing
    // pinned there is no marker — the hero's midday anchor is an internal
    // implementation detail, and drawing a line there would claim a
    // precision the user never asked for.
    //
    // "Now" is passed as a FLAG, not a timestamp: opts is stashed in
    // _lastGraph and replayed on resize and on every mode toggle, so a
    // baked-in timestamp would freeze the line at whenever the dashboard
    // last rendered. renderGraph reads the clock itself.
    // Prefer NOAA's harmonic curve over the Open-Meteo model for the same
    // reason the times come from NOAA — and so the drawn curve and the
    // high/low rows can never disagree about when the peak is.
    const tideSeries = (state.tidePredictions && state.tidePredictions.hourly)
      || state.tides;

    this.renderGraph(activeDay.hourly, tz, state.omHourly || [], {
      tides: touchesWater ? tideSeries : null,
      markerDt: pinnedHourSlot ? pinnedHourSlot.dt : null,
      markerIsNow: isToday && !pinnedHourSlot
    });

    // Swipe the temperature graph left/right to move through the days.
    const maxIdx = Math.min(7, dailyData.length - 1);
    this._bindGraphSwipe(currentDayIdx, maxIdx, onDayClick);

    // Horizontal swipe on the quick-stats grid pages through extra items
    // (anything beyond the first 6) using a 3D cube transition. Loops.
    this._bindStatsSwipe();
    this._bindStatsArrows();

    this._lastIsToday = isToday;
    this._lastPinnedHour = selectedHourDt;
    this._lastTempUnit = Storage.getUnits().temp;
  },

  // Horizontal swipe on the quick-stats pager → cube-flip to next/prev page.
  // We bind on the pager wrapper (block element) rather than the grid itself
  // so the cube perspective isn't placed as a single grid cell.
  //
  // Two elements, not one: gestures are tracked on the OUTER .stats-pager
  // so a swipe that happens to start on an edge arrow still pages (the
  // arrows sit inside it and their pointer events bubble), while the peek
  // translate is applied to the inner faces div — the arrows are chrome
  // and shouldn't slide with the content they point at.
  _bindStatsSwipe() {
    if (!this._statsPages || this._statsPages.length <= 1) return;
    const el = document.getElementById('stats-pager');
    if (!el) return;
    const hit = el.closest('.stats-pager') || el;

    const THRESHOLD = 50;
    const SLOP      = 1.2;
    let startX = 0, startY = 0, pointerId = null, tracking = false, peeking = false;

    hit.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
      tracking = true;
      peeking = false;
    });

    hit.addEventListener('pointermove', (e) => {
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

    hit.addEventListener('pointerup', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      const wasPeeking = peeking;
      reset();
      if (!wasPeeking) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) < THRESHOLD) return;
      this._changeStatsPage(dx < 0 ? 'next' : 'prev');
    });

    hit.addEventListener('pointercancel', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      el.style.transform = '';
    });
  },

  // One delegated listener for the pager's edge arrows. The dashboard's
  // markup is rebuilt on every render, so listeners bound to the buttons
  // themselves would be orphaned immediately — same reason
  // _bindGraphModeToggle delegates.
  //
  // Nothing to debounce against the swipe handler: a drag that ends on an
  // arrow already paged on pointerup, and the click that follows runs
  // into _changeStatsPage's own _statsCubeAnimating guard.
  _bindStatsArrows() {
    if (this._statsArrowsBound) return;
    this._statsArrowsBound = true;
    this.weatherView.addEventListener('click', (e) => {
      const btn = e.target.closest('.stats-page-arrow');
      if (!btn) return;
      this._changeStatsPage(btn.classList.contains('next') ? 'next' : 'prev');
    });
  },

  // Flip to the next or previous stats page with a 3D cube rotation.
  // Wraps at both ends.
  _changeStatsPage(direction) {
    if (this._statsCubeAnimating) return;
    // Mid city-swipe, #stats-pager resolves to the outgoing clone on the
    // cube face (ids are duplicated for the 800ms spin) — running an
    // inner cube against that dead DOM is pointless and racy. Swallow
    // the gesture; the pager is fully rebuilt when the cube lands.
    if (this._cubeAnimating) return;
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
        // Find the leading visible tile via bounding rects rather than
        // offsetLeft + scrollLeft. The latter pair only matches when
        // .hourly-scroll happens to be the tile's offsetParent — which
        // it isn't in landscape (the scroll container is statically
        // positioned, so the offsetParent walks up to .app-container
        // and offsetLeft picks up the right-column x-offset). Using
        // each tile's screen-space left against the scroller's screen-
        // space left works in every layout.
        const scrollRect = hourlyEl.getBoundingClientRect();
        let leading = null;
        for (const tile of tiles) {
          const r = tile.getBoundingClientRect();
          if (r.left >= scrollRect.left - 8) { leading = tile; break; }
        }
        if (!leading) leading = tiles[tiles.length - 1];
        const newDayIdx = parseInt(leading.getAttribute('data-day-index'), 10);
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

  // True while a city-swipe cube (either variant) is mid-flight.
  // App.renderAll() checks it and parks the render in _deferredRender
  // instead of wiping #weather-view under the animation; _cubeDone()
  // replays the parked render once the cube resolves.
  _cubeAnimating: false,
  _deferredRender: null,

  _cubeDone() {
    this._cubeAnimating = false;
    const deferred = this._deferredRender;
    this._deferredRender = null;
    if (deferred) deferred();
  },

  // Hygiene for cube faces, applied for the duration of a spin:
  //   - aria-hidden + inert so the face's copy of the app is invisible
  //     to assistive tech and unreachable via the tab order (without
  //     this, a screen reader sees the whole dashboard twice).
  //   - stripIds=true additionally removes every id in the face so
  //     getElementById can't resolve to dead DOM while both faces are
  //     mounted (e.g. the clock timer ticking a stale #city-clock).
  //     MUST stay false for faces holding LIVE nodes (city-cube back
  //     faces — those nodes return to the document when the cube lands)
  //     and for faces whose SVG needs its gradient id to paint.
  _prepCubeFace(face, stripIds) {
    if (stripIds) {
      face.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    }
    face.setAttribute('aria-hidden', 'true');
    face.inert = true;
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

    // Mark the transition in-flight BEFORE any frame/timer work so a
    // concurrent renderAll() (auto-refresh, visibilitychange, refresh
    // button, byok:changed) defers instead of re-rendering mid-spin —
    // its innerHTML swap would detach the cube and finish() would then
    // re-append the animating nodes AFTER the fresh dashboard,
    // duplicating the whole view.
    this._cubeAnimating = true;

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
    this._prepCubeFace(front, true); // clone — strip its duplicated ids

    const back = document.createElement('div');
    back.className = 'cube-face ' + (isNext ? 'cube-face-right' : 'cube-face-left');
    // Move the freshly-rendered NEW dashboard onto the cube's incoming face.
    // We move (not clone) the children so their event listeners survive.
    while (this.weatherView.firstChild) back.appendChild(this.weatherView.firstChild);
    this._prepCubeFace(back, false); // LIVE nodes — ids must survive

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
        // the app continues to find them via getElementById/querySelector —
        // but only while the cube is still mounted. If something replaced
        // #weather-view's contents mid-spin (showLoading, showError), the
        // nodes held in `back` are stale and re-appending them would
        // duplicate the dashboard.
        if (perspective.isConnected) {
          while (back.firstChild) this.weatherView.appendChild(back.firstChild);
        }
        perspective.remove();
        this._cubeDone();
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
      this._prepCubeFace(front, true); // clone — strip its duplicated ids

      const back = document.createElement('div');
      back.className = 'cube-face ' + backFaceClass;
      back.appendChild(newCol);
      this._prepCubeFace(back, false); // LIVE nodes — ids must survive

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
        // append order doesn't matter. Skip the restore if the cubes
        // were detached mid-spin (see runCubeTransition's finish) —
        // the wrappers are stale then and would duplicate the view.
        if (left.perspective.isConnected || right.perspective.isConnected) {
          this.weatherView.appendChild(newLeft);
          this.weatherView.appendChild(newRight);
        }
        left.perspective.remove();
        right.perspective.remove();
        this._cubeDone();
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

  // FLIP-style slide for the hourly tiles: same idea as
  // captureDayRowForHeroSlide above, but sourced from the small tile in
  // the hourly scroller (temp number + condition icon) rather than from
  // a daily-list row. Ghost flies the temp and icon up to the hero's
  // large slots, growing in size mid-flight so the landing is seamless.
  //
  // Called before re-render; returns a continuation that mounts the
  // ghosts once the new hero is in the DOM. Source tile is located in
  // the re-rendered DOM by data-dt so we can hide its "real" temp/icon
  // for the duration of the flight (the tile itself does not change,
  // just sprouts a pinned highlight).
  captureHourlyTileForHeroSlide(tileEl) {
    if (!tileEl) return null;
    const srcTemp = tileEl.querySelector('.hourly-temp');
    const srcIcon = tileEl.querySelector('.hourly-icon');
    const srcIconImg = srcIcon && srcIcon.querySelector('img, svg');
    if (!srcTemp || !srcIcon || !srcIconImg) return null;

    const tempRect = srcTemp.getBoundingClientRect();
    const iconRect = srcIcon.getBoundingClientRect();
    const tempHTML = srcTemp.outerHTML;
    const iconHTML = srcIcon.outerHTML;
    const tileDt   = tileEl.getAttribute('data-dt');

    const srcTempCS = getComputedStyle(srcTemp);
    const srcIconCS = getComputedStyle(srcIconImg);
    const srcTempFS     = srcTempCS.fontSize;
    const srcTempWeight = srcTempCS.fontWeight;
    const srcIconSize   = srcIconCS.width; // square

    return () => {
      const heroTemp = this.weatherView.querySelector('.hero-temp-large');
      const heroIcon = this.weatherView.querySelector('.hero-icon-large');
      const heroIconImg = heroIcon && heroIcon.querySelector('img, svg');
      if (!heroTemp || !heroIcon || !heroIconImg) return;

      const destTempRect = heroTemp.getBoundingClientRect();
      const destIconRect = heroIcon.getBoundingClientRect();
      const destTempCS   = getComputedStyle(heroTemp);
      const destIconCS   = getComputedStyle(heroIconImg);
      const destTempFS     = destTempCS.fontSize;
      const destTempWeight = destTempCS.fontWeight;
      const destIconSize   = destIconCS.width;

      heroTemp.classList.add('hero-slide-hidden');
      heroIcon.classList.add('hero-slide-hidden');

      const newTile = this.weatherView.querySelector(`.hourly-tile[data-dt="${tileDt}"]`);
      const newTileTemp = newTile && newTile.querySelector('.hourly-temp');
      const newTileIcon = newTile && newTile.querySelector('.hourly-icon');
      if (newTileTemp) newTileTemp.classList.add('hero-slide-hidden');
      if (newTileIcon) newTileIcon.classList.add('hero-slide-hidden');

      // Same makeGhost pattern as captureDayRowForHeroSlide. Anchored on
      // the hero's center; transform starts offset to the tile and
      // animates back to (0, 0).
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

      const tempGhost = makeGhost(
        tempHTML, tempRect, destTempRect,
        (inner) => {
          inner.style.fontSize   = srcTempFS;
          inner.style.fontWeight = srcTempWeight;
        },
        (inner) => {
          inner.style.fontSize   = destTempFS;
          inner.style.fontWeight = destTempWeight;
        },
      );

      const iconGhost = makeGhost(
        iconHTML, iconRect, destIconRect,
        (inner) => {
          const img = inner.querySelector('img, svg');
          if (img) { img.style.width = srcIconSize; img.style.height = srcIconSize; }
        },
        (inner) => {
          const img = inner.querySelector('img, svg');
          if (img) { img.style.width = destIconSize; img.style.height = destIconSize; }
        },
      );

      const cleanup = () => {
        tempGhost.remove();
        iconGhost.remove();
        heroTemp.classList.remove('hero-slide-hidden');
        heroIcon.classList.remove('hero-slide-hidden');
        if (newTileTemp) newTileTemp.classList.remove('hero-slide-hidden');
        if (newTileIcon) newTileIcon.classList.remove('hero-slide-hidden');
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
    // Mid city-swipe (this._cubeAnimating) two things break the cube
    // path: #graph-container resolves to the outgoing clone on the cube
    // face, and onDayClick's renderAll() is parked, so "re-renders
    // dashboard" below doesn't hold. Take the no-animation path — the
    // selection still lands and the deferred render paints the right
    // day once the city cube resolves.
    if (!graphEl || this._graphCubeAnimating || this._cubeAnimating) {
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
  //
  // `direction` picks the rotation axis as well as the way round:
  //   'next' / 'prev' — about the vertical axis (day changes, stats pager)
  //   'up'   / 'down' — about the horizontal axis (the graph's rain/wind
  //                     series flip, so a mode change doesn't read as
  //                     another day change)
  async runElementCubeTransition(targetEl, oldHTML, newHTML, direction) {
    if (!targetEl) return;
    const BACK_FACE = { next: 'cube-face-right', prev: 'cube-face-left', up: 'cube-face-bottom', down: 'cube-face-top' };
    const ROTATE    = { next: 'rotate-left',     prev: 'rotate-right',   up: 'rotate-up',        down: 'rotate-down' };
    const isVerticalAxis = direction === 'up' || direction === 'down';
    const height = targetEl.offsetHeight || 200;

    const perspective = document.createElement('div');
    perspective.className = 'cube-perspective';
    perspective.style.height = `${height}px`;
    // X-axis rotation: the face depth is half the face HEIGHT — the
    // default --cube-half is sized for the wide Y-axis cubes and would
    // make a 200px-tall graph fly absurdly far out of plane.
    if (isVerticalAxis) perspective.style.setProperty('--cube-half', `${height / 2}px`);

    const stage = document.createElement('div');
    stage.className = 'cube-stage';

    const front = document.createElement('div');
    front.className = 'cube-face cube-face-front';
    front.innerHTML = oldHTML;
    // Don't strip ids here: the graph SVG needs its (per-render unique)
    // gradient id to paint during the spin. Hide from AT / tab order only.
    this._prepCubeFace(front, false);

    const back = document.createElement('div');
    back.className = 'cube-face ' + (BACK_FACE[direction] || 'cube-face-right');
    back.innerHTML = newHTML;
    this._prepCubeFace(back, false);

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
          stage.classList.add(ROTATE[direction] || 'rotate-left');
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
      // Regions that own their own horizontal gestures. The geometric
      // "above the graph" check below isn't enough in the landscape
      // two-column layout, where the hourly scroller and daily list sit
      // in the right column — geometrically above the left column's
      // graph — and a drag meant to scroll the timeline would change
      // city instead.
      if (e.target.closest('.hourly-scroll, .daily-list, .graph-container')) return;

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

  // `tz` is a tz handle as accepted by formatTime (IANA zone name or
  // fixed offset seconds). `omHourly` is the full Open-Meteo hourly
  // array (state.omHourly) — it carries precipMM AND windSpeed, so both
  // bar series come from the one argument.
  renderGraph(hourlyData, tz = 0, omHourly = [], opts = {}) {
    const container = document.getElementById('graph-container');
    if (!container) return;

    // Remember the latest data so we can redraw on resize/visibility
    // changes and on mode toggles.
    this._lastGraph = { hourly: hourlyData, tz, omHourly, opts };

    // 'precip' | 'wind' | 'tide' | 'uv' — which secondary series the
    // graph shows. Global and persisted; lives on UI (not the DOM) because the
    // graph's innerHTML is replaced wholesale on every render and cube
    // transition.
    const saved = this._graphMode || (this._graphMode = Storage.getGraphMode());

    // Tide is only offered where there's marine data. An inland city
    // renders precip instead WITHOUT touching the stored preference, so
    // swiping back to the coast restores the tide view (see Storage's
    // getGraphMode note).
    const tideSeries = opts.tides || null;
    const tideAvailable = !!(tideSeries && tideSeries.time && tideSeries.sea_level_height_msl);
    // The full cycle — and which mode is actually SHOWN — is resolved
    // further down, once the day's peak UV is known: UV is the other
    // conditional series, and it can't be decided before the hourly
    // samples are in hand.

    // Interpolation and x-spacing both divide by (points - 1); a day
    // with fewer than two slots would render NaN geometry. Clear the
    // graph instead.
    if (!hourlyData || hourlyData.length < 2) {
      container.innerHTML = '';
      return;
    }

    const width = container.clientWidth;
    if (!width) return; // container hidden (e.g. behind an overlay); skip until visible
    const height = 180;
    const paddingX = 40;
    const paddingY = 40;

    // Build hour → mm and hour → m/s lookups from Open-Meteo's hourly
    // series (true 1h resolution). Fall back to OWM's 3h slots for any
    // hour the lookups don't cover (e.g. enrichment failed).
    const precipByHour = new Map();
    const windByHour = new Map();
    // UV index (dimensionless) by hour. Open-Meteo only — OWM's free
    // endpoints don't carry it, so there is no 3h fallback: an hour with
    // no sample simply has no curve there.
    const uvByHour = new Map();
    for (const h of omHourly) {
      precipByHour.set(Math.floor(h.dt / 3600), h.precipMM);
      // Only non-null wind counts as data — a null (column missing from
      // the API response) must fall through to the OWM fallback rather
      // than masquerading as a real sample.
      if (h.windSpeed != null) windByHour.set(Math.floor(h.dt / 3600), h.windSpeed);
      if (h.uvIndex != null) uvByHour.set(Math.floor(h.dt / 3600), h.uvIndex);
    }
    // Sea level (metres relative to MSL) by hour. Unlike precip and wind
    // this series is continuous and signed — a negative value is a real
    // low tide, not missing data — so it renders as a filled curve rather
    // than bars, and its scale is derived from the visible window instead
    // of anchored at zero.
    const tideByHour = new Map();
    if (tideAvailable) {
      const tTimes = tideSeries.time;
      const tLevels = tideSeries.sea_level_height_msl;
      for (let i = 0; i < tTimes.length; i++) {
        if (tLevels[i] == null) continue;
        const t = App._marineTimeToSec(tTimes[i]);
        if (t == null || !isFinite(t)) continue;
        tideByHour.set(Math.floor(t / 3600), tLevels[i]);
      }
    }
    // Count snow like dayTotals and the Precipitation stat do — without
    // it, a snowstorm with no Open-Meteo hourly data graphs as bone dry.
    const fallback3hPerHour = (p) => {
      const r = (p && p.rain && p.rain['3h']) || 0;
      const s = (p && p.snow && p.snow['3h']) || 0;
      return (r + s) / 3;
    };
    // Unlike precip, missing wind must NOT collapse to 0 — dead calm is
    // real data and would be indistinguishable from "no data". null means
    // no sample; it renders as no bar and is excluded from the has-data
    // check below.
    const fallback3hWind = (p) =>
      (p && p.wind && p.wind.speed != null) ? p.wind.speed : null;

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
      const windFallback = fallback3hWind(p1);

      // Step by the ACTUAL gap between slots, not an assumed 3h: the
      // OWM/Open-Meteo top-up merge (buildDailyData) can leave adjacent
      // slots 2h apart, and x-position is by array index — a fixed 3h
      // step would stop mapping linearly to time there.
      const gapHours = Math.max(1, Math.round((p2.dt - p1.dt) / 3600));
      for (let h = 0; h < gapHours; h++) {
        const dt = p1.dt + (h * 3600);
        const ratio = h / gapHours;
        const hourKey = Math.floor(dt / 3600);
        const precip = precipByHour.has(hourKey) ? precipByHour.get(hourKey) : fallback;
        const wind = windByHour.has(hourKey) ? windByHour.get(hourKey) : windFallback;
        hourly.push({
          temp: t1 + (t2 - t1) * ratio,
          precipPerHour: precip,
          windPerHour: wind,
          tideLevel: tideByHour.has(hourKey) ? tideByHour.get(hourKey) : null,
          uvIndex: uvByHour.has(hourKey) ? uvByHour.get(hourKey) : null,
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
      windPerHour: windByHour.has(lastHourKey) ? windByHour.get(lastHourKey) : fallback3hWind(last),
      tideLevel: tideByHour.has(lastHourKey) ? tideByHour.get(lastHourKey) : null,
      uvIndex: uvByHour.has(lastHourKey) ? uvByHour.get(lastHourKey) : null,
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

    // Wind stays m/s internally (like precip stays mm/h); converted only
    // at label time. A 0 is a real sample (counts as data, draws no
    // visible bar); null is a missing one. The 5 m/s (~11 mph) floor
    // keeps a dead-calm day from rescaling noise into a dramatic chart.
    const windSamples = hourly.map(h => h.windPerHour).filter(v => v != null);
    const hasWindData = windSamples.length > 0;
    const maxWind = Math.max(hasWindData ? Math.max(...windSamples) : 0, 5);

    // Tide scale is window-relative, not zero-anchored: sea level is
    // measured against MSL, so zero is the middle of the range rather
    // than the floor, and a 0.4m estuary range would be invisible on a
    // scale that had to contain a 12m Bay-of-Fundy day. A 0.5m minimum
    // span stops a near-slack day from amplifying model noise into a
    // dramatic curve.
    const tideSamples = hourly.map(h => h.tideLevel).filter(v => v != null);
    const hasTideData = tideSamples.length > 0;
    let tideMin = hasTideData ? Math.min(...tideSamples) : 0;
    let tideMax = hasTideData ? Math.max(...tideSamples) : 0;
    if (tideMax - tideMin < 0.5) {
      const mid = (tideMax + tideMin) / 2;
      tideMin = mid - 0.25;
      tideMax = mid + 0.25;
    }
    // Headroom so the curve's crest doesn't collide with the temp line.
    const tideSpan = (tideMax - tideMin) * 1.15;
    const tideBase = tideMin - (tideMax - tideMin) * 0.075;

    // UV is a health signal rather than a shape, so it only earns a slot
    // in the switch on days that actually reach the WHO "Very High" band
    // — the same threshold that puts the red pill on the UV stat. On a
    // mild day the mode simply isn't offered, which is the point: its
    // presence in the gutter is itself the warning.
    const uvSamples = hourly.map(h => h.uvIndex).filter(v => v != null);
    const hasUvData = uvSamples.length > 0;
    const peakUv = hasUvData ? Math.max(...uvSamples) : 0;
    const uvAvailable = Math.round(peakUv) >= UV_VERY_HIGH;
    // Zero-anchored and pinned to the Extreme boundary rather than to the
    // day's own peak: unlike rain or wind — where only the shape of that
    // day matters — a UV curve's HEIGHT should mean the same thing in
    // every city on every day. Days past 11 push the top up so the crest
    // still fits.
    const maxUv = Math.max(peakUv, UV_EXTREME);

    // Which series the switch offers, in cycle order. R and W are always
    // there; T and U join only where they carry information. They're
    // APPENDED rather than inserted so letters already on screen keep
    // their positions — the switch never appears to shift under your
    // thumb when you cross a coastline or swipe to a sunnier day.
    const cycle = ['precip', 'wind'];
    if (tideAvailable) cycle.push('tide');
    if (uvAvailable) cycle.push('uv');
    // A stored mode that isn't on offer here renders as precip WITHOUT
    // being overwritten (see Storage's getGraphMode note), so swiping
    // back to the coast — or on to a high-UV day — restores it untapped.
    const mode = cycle.includes(saved) ? saved : 'precip';
    // _toggleGraphMode cycles from what's actually on screen, so it reads
    // this back instead of re-deriving availability at tap time.
    this._graphCycle = cycle;

    const points = hourly.map((h, i) => {
      const tempC = this.convertTemp(h.temp);
      const x = paddingX + (i * (width - 2 * paddingX) / (hourly.length - 1));
      const yTemp = height - paddingY - ((tempC - minTemp) * (height - 2 * paddingY) / tempRange);
      const yPrecip = height - paddingY - (h.precipPerHour * (height - 2 * paddingY) / maxPrecip);
      const yWind = h.windPerHour != null
        ? height - paddingY - (h.windPerHour * (height - 2 * paddingY) / maxWind)
        : null;
      const yTide = h.tideLevel != null
        ? height - paddingY - ((h.tideLevel - tideBase) * (height - 2 * paddingY) / tideSpan)
        : null;
      const yUv = h.uvIndex != null
        ? height - paddingY - (h.uvIndex * (height - 2 * paddingY) / maxUv)
        : null;
      return {
        x, yTemp, yPrecip, yWind, yTide, yUv,
        temp: h.temp, precip: h.precipPerHour, wind: h.windPerHour, tide: h.tideLevel,
        uv: h.uvIndex,
        dt: h.dt,
        time: this.formatTime(h.dt, false, tz),
        isOriginal: h.isOriginal
      };
    });

    let pathD = `M ${points[0].x} ${points[0].yTemp}`;
    for (let i = 0; i < points.length - 1; i++) {
      const cp1x = points[i].x + (points[i+1].x - points[i].x) / 2;
      pathD += ` C ${cp1x} ${points[i].yTemp}, ${cp1x} ${points[i+1].yTemp}, ${points[i+1].x} ${points[i+1].yTemp}`;
    }

    const barWidth = (width - 2 * paddingX) / (hourly.length - 1);

    // Filled curve for whichever continuous series is active. Tide and UV
    // are instantaneous readings, not per-hour quantities, so the shape is
    // the information and bars would imply a discreteness neither has.
    // Contiguous runs of non-null samples are stroked separately so a
    // coverage hole never gets bridged by a straight line pretending to be
    // data. Same midpoint-control-point smoothing as the temperature line.
    const buildCurve = (yKey) => {
      const runs = [];
      let run = [];
      for (const p of points) {
        if (p[yKey] == null) { if (run.length) runs.push(run); run = []; continue; }
        run.push(p);
      }
      if (run.length) runs.push(run);

      const floorY = height - paddingY;
      let strokeD = '';
      let fillD = '';
      for (const r of runs) {
        if (r.length < 2) continue;
        let d = `M ${r[0].x} ${r[0][yKey]}`;
        for (let i = 0; i < r.length - 1; i++) {
          const cpx = r[i].x + (r[i + 1].x - r[i].x) / 2;
          d += ` C ${cpx} ${r[i][yKey]}, ${cpx} ${r[i + 1][yKey]}, ${r[i + 1].x} ${r[i + 1][yKey]}`;
        }
        strokeD += d + ' ';
        fillD += `${d} L ${r[r.length - 1].x} ${floorY} L ${r[0].x} ${floorY} Z `;
      }
      return { strokeD: strokeD.trim(), fillD: fillD.trim() };
    };

    const tideCurve = (mode === 'tide' && hasTideData) ? buildCurve('yTide') : null;
    const uvCurve = (mode === 'uv' && hasUvData) ? buildCurve('yUv') : null;
    // Where the Very High band starts, in plot coordinates — the line the
    // mode's existence is announcing.
    const uvThresholdY = height - paddingY - (UV_VERY_HIGH * (height - 2 * paddingY) / maxUv);

    // Vertical position marker. x is interpolated between the two
    // bracketing hourly points rather than snapped to the nearest one, so
    // the "now" line drifts smoothly across the hour instead of jumping.
    // Falls outside the plotted window on any day that isn't the one
    // being shown, in which case nothing is drawn.
    let markerX = null;
    // True when the marker was pulled to the left edge rather than placed
    // at its real time — the label is suppressed in that case, because
    // parking the word "now" on the 11 AM gridline states something
    // untrue. The bare line still usefully says "you are at or before
    // the start of this chart".
    let markerClamped = false;
    const markerIsPinned = opts.markerDt != null;
    const markerDt = markerIsPinned
      ? opts.markerDt
      : (opts.markerIsNow ? Math.floor(Date.now() / 1000) : null);

    if (markerDt != null && points.length > 1) {
      const first = points[0].dt;
      const lastDt = points[points.length - 1].dt;
      if (markerDt < first) {
        // Today's spine is OWM's 3-hourly list, which starts at the NEXT
        // 3h boundary — so "now" is almost always a little BEFORE the
        // first plotted point, and a strict range check would hide the
        // line on the one day it matters most. Pin it to the left edge
        // when it's within one slot; anything older is genuinely off-chart.
        if (first - markerDt <= 3 * 3600) {
          markerX = points[0].x;
          markerClamped = true;
        }
      } else if (markerDt <= lastDt) {
        for (let i = 0; i < points.length - 1; i++) {
          const a = points[i], b = points[i + 1];
          if (markerDt >= a.dt && markerDt <= b.dt) {
            const span = b.dt - a.dt;
            const ratio = span > 0 ? (markerDt - a.dt) / span : 0;
            markerX = a.x + (b.x - a.x) * ratio;
            break;
          }
        }
      }
    }
    const markerLabel = markerIsPinned ? this.formatTime(markerDt, true, tz) : 'now';

    // Unique per render: during a cube transition BOTH graphs are mounted
    // at once, and url(#id) resolves to the FIRST match in tree order — a
    // shared id would stroke the incoming line with the outgoing day's
    // gradient for the full spin.
    const gradientId = 'temp-line-gradient-' + (this._gradSeq = (this._gradSeq || 0) + 1);

    container.innerHTML = `
      <svg class="graph-svg" viewBox="0 0 ${width} ${height}">
        ${CONFIG_TEMP_LINE_COLOR.enabled ? `
        <defs>
          <linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${paddingX}" y1="0" x2="${width - paddingX}" y2="0">
            ${points.map((p, i) => {
              const offset = (i / (points.length - 1)) * 100;
              const color = getTempColor(p.temp);
              return `<stop offset="${offset}%" stop-color="${color}"></stop>`;
            }).join('')}
          </linearGradient>
        </defs>
        ` : ''}

        <line class="graph-guideline" x1="${paddingX}" y1="${height - paddingY}" x2="${width - paddingX}" y2="${height - paddingY}"></line>
        <line class="graph-guideline" x1="${paddingX}" y1="${paddingY}" x2="${width - paddingX}" y2="${paddingY}"></line>

        ${(() => {
          // Centred above the plot: the name of the series the bars or
          // curve are showing. The lit letter in the switch already says
          // WHICH one is active, but only to someone who knows the code —
          // this spells it out, and it's the piece that tells you what
          // changed after a mode flip.
          // Left gutter: pure axis labels — peak in the user's unit,
          // an always-visible unit line (so the axis is never blank on
          // a dry day), baseline 0 when there's data to scale.
          // Right gutter: the mode switch — stacked R / W / T / U letters
          // with the active series lit in its bar colour, sitting on a
          // transparent full-height hit rect. Tap it (or double-tap
          // anywhere on the graph) to swap series. Rect first so the
          // letters paint on top; letters are pointer-events:none in
          // CSS so taps on them fall through to the rect.
          const isWind = mode === 'wind';
          const isTide = mode === 'tide';
          const isUv = mode === 'uv';

          // `cycle` is built above: T only where there's marine data, U
          // only on a Very High UV day, so an inland city on a mild day
          // keeps the original two-state R/W switch.
          const nextMode = cycle[(cycle.indexOf(mode) + 1) % cycle.length];
          const nameOf = (m) => m === 'wind'
            ? (hasWindData ? 'wind speed' : 'wind speed (no data)')
            : m === 'tide' ? 'tide height'
            : m === 'uv' ? 'UV index' : 'precipitation';

          const letterX = width - paddingX / 2;
          // Letters stack downward from a fixed top anchor, so each one
          // keeps the position it had before the conditional letters
          // after it existed — the switch doesn't appear to shift when
          // you cross a coastline or swipe to a sunnier day.
          const letters = cycle.map((m, i) => {
            const active = m === mode;
            const tone = m === 'precip' ? 'rain'
              : m === 'wind' ? 'wind' : m === 'tide' ? 'tide' : 'uv';
            const y = paddingY + 5 + i * 15;
            const ch = m === 'precip' ? 'R'
              : m === 'wind' ? 'W' : m === 'tide' ? 'T' : 'U';
            return `<text class="graph-mode-letter ${active ? `active ${tone}` : ''}" x="${letterX}" y="${y}" aria-hidden="true">${ch}</text>`;
          }).join('');

          const toggle = `
            <rect class="graph-mode-toggle" x="${width - paddingX}" y="0" width="${paddingX}" height="${height}" fill="transparent" pointer-events="all" role="button" tabindex="0" aria-label="Showing ${nameOf(mode)}. Activate to show ${nameOf(nextMode)}."></rect>
            ${letters}`;

          // Peak value in the user's unit; internal storage stays mm/h,
          // m/s and metres. Peak + baseline only when there's data.
          let peakDisplay = '';
          let unitLabel = '';
          let floorDisplay = '0';
          if (isWind) {
            if (hasWindData) {
              const disp = this._windToDisplay(maxWind);
              peakDisplay = disp.value.toFixed(0);
              unitLabel = disp.unit;
            } else {
              peakDisplay = '—'; // wind unavailable from both sources
            }
          } else if (isTide) {
            // The tide axis is signed and window-relative, so both ends
            // are labelled — a bare "0" floor would be a lie here.
            const isFeet = Storage.getUnits().dist === 'mi';
            const conv = (m) => isFeet ? m * 3.28084 : m;
            unitLabel = isFeet ? 'ft' : 'm';
            // Without the guard the 0.5m minimum-span widening turns an
            // empty series into a confident-looking "0.3 m" peak on a
            // graph that has no curve to justify it.
            peakDisplay = hasTideData ? conv(tideMax).toFixed(1) : '—';
            floorDisplay = conv(tideMin).toFixed(1);
          } else if (isUv) {
            // The index is dimensionless, so the "unit" line says what the
            // number IS. The top of the axis is the Extreme boundary, not
            // the day's own peak — see maxUv — which is exactly what makes
            // the curve's height comparable between days.
            unitLabel = 'UV';
            peakDisplay = String(Math.round(maxUv));
          } else {
            const isInches = Storage.getUnits().precip === 'in';
            unitLabel = isInches ? 'in/h' : 'mm/h';
            if (hasRain) {
              peakDisplay = isInches ? (maxPrecip / 25.4).toFixed(2) : maxPrecip.toFixed(1);
            }
          }
          const cls = 'graph-y-axis-label' +
            (isWind ? ' wind' : '') + (isTide ? ' tide' : '') + (isUv ? ' uv' : '');
          const showFloor = isWind ? hasWindData
            : isTide ? hasTideData : isUv ? hasUvData : hasRain;

          // Sits at y=12, above everything: the ±2° headroom baked into
          // the temperature scale keeps the topmost badge below y=25, and
          // the position marker's label is lower still at paddingY - 16.
          const title = nameOf(mode);
          return toggle + `
            <text class="graph-series-label" x="${width / 2}" y="12">${this.esc(title.charAt(0).toUpperCase() + title.slice(1))}</text>
            ${peakDisplay ? `<text class="${cls}" x="5" y="${paddingY + 5}">${peakDisplay}</text>` : ''}
            ${unitLabel ? `<text class="${cls}" x="5" y="${paddingY + 15}">${unitLabel}</text>` : ''}
            ${showFloor ? `<text class="${cls}" x="5" y="${height - paddingY - 5}">${floorDisplay}</text>` : ''}
          `;
        })()}

        ${tideCurve && tideCurve.strokeD ? `
          <path class="graph-tide-area" d="${tideCurve.fillD}"></path>
          <path class="graph-tide-line" d="${tideCurve.strokeD}" fill="none"></path>
        ` : ''}

        ${uvCurve && uvCurve.strokeD ? `
          <line class="graph-uv-threshold" x1="${paddingX}" y1="${uvThresholdY}" x2="${width - paddingX}" y2="${uvThresholdY}"></line>
          <path class="graph-uv-area" d="${uvCurve.fillD}"></path>
          <path class="graph-uv-line" d="${uvCurve.strokeD}" fill="none"></path>
        ` : ''}

        ${points.map((p) => {
          // tide and UV draw as curves, not bars
          if (mode === 'tide' || mode === 'uv') return '';
          if (mode === 'wind') {
            // null = no sample; 0 = calm (real sample, zero-height bar
            // either way, so skip the element for both).
            if (!(p.wind > 0)) return '';
            return `<rect class="graph-wind-bar" x="${p.x - barWidth/2}" y="${p.yWind}" width="${barWidth + 0.5}" height="${height - paddingY - p.yWind}"></rect>`;
          }
          if (p.precip === 0) return '';
          return `<rect class="graph-precip-bar" x="${p.x - barWidth/2}" y="${p.yPrecip}" width="${barWidth + 0.5}" height="${height - paddingY - p.yPrecip}"></rect>`;
        }).join('')}

        <path class="graph-path" d="${pathD}" fill="none" stroke="${CONFIG_TEMP_LINE_COLOR.enabled ? `url(#${gradientId})` : '#ff7043'}" style="${CONFIG_TEMP_LINE_COLOR.enabled ? `stroke: url(#${gradientId}) !important;` : ''}" stroke-width="3"></path>

        ${markerX != null ? `
          <line class="graph-position-line${markerIsPinned ? ' pinned' : ''}"
                x1="${markerX}" y1="${paddingY - 12}" x2="${markerX}" y2="${height - paddingY}"></line>
          ${markerClamped ? '' : `<text class="graph-position-label${markerIsPinned ? ' pinned' : ''}"
                x="${markerX}" y="${paddingY - 16}">${this.esc(markerLabel)}</text>`}
        ` : ''}

        ${points.map(p => {
          if (!p.isOriginal) return '';
          const badgeColor = CONFIG_TEMP_LINE_COLOR.enabled ? getTempColor(p.temp) : '#ff7043';
          return `
            <rect class="graph-badge" x="${p.x - 12}" y="${p.yTemp - 25}" width="24" height="18" rx="4" style="fill: ${badgeColor} !important;"></rect>
            <path d="M ${p.x - 4} ${p.yTemp - 7} L ${p.x} ${p.yTemp - 2} L ${p.x + 4} ${p.yTemp - 7} Z" fill="${badgeColor}"></path>
            <text class="graph-temp-badge-text" x="${p.x}" y="${p.yTemp - 12}">${this.formatTemp(p.temp)}°</text>
            <text class="graph-time-text" x="${p.x}" y="${height - 10}">${p.time}</text>
          `;
        }).join('')}
      </svg>
    `;

    this._bindGraphModeToggle();
  },

  // One delegated listener on #weather-view for the graph's mode toggle.
  // A listener bound to the rect itself would die on the first day swipe:
  // changeDayWithGraphCube re-renders (fresh listener), then
  // runElementCubeTransition overwrites innerHTML with snapshot strings
  // and orphans it. Delegation by CLASS, not #graph-container — the
  // cube-clone id stripping means an id selector can't be trusted while
  // a transition is mounted.
  _bindGraphModeToggle() {
    if (this._graphToggleBound) return;
    this._graphToggleBound = true;
    const onActivate = (e) => {
      if (!e.target.closest('.graph-mode-toggle')) return;
      if (e.type === 'keydown') {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); // keep Space from scrolling the page
      }
      this._toggleGraphMode();
    };
    this.weatherView.addEventListener('click', onActivate);
    this.weatherView.addEventListener('keydown', onActivate);

    // Double-tap / double-click anywhere on the graph also swaps the
    // series — same gesture family as the hero temp's dblclick °F/°C
    // flip. .graph-container's `touch-action: pan-y` already suppresses
    // browser double-tap zoom, so dblclick fires reliably on touch. The
    // two clicks of a double-tap landing on the R/W switch itself can't
    // double-fire: the first click starts the flip and
    // _graphCubeAnimating swallows everything until it lands.
    this.weatherView.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.graph-container')) return;
      e.preventDefault();
      this._toggleGraphMode();
    });
  },

  // Advance the graph to the next series in the cycle with the same
  // element-cube animation the day changes and stats pager use.
  _toggleGraphMode() {
    // Same guards as _changeStatsPage: never run an inner cube while the
    // graph cube is mid-flight or while the whole dashboard is on a
    // city-swipe cube face.
    if (this._graphCubeAnimating || this._cubeAnimating) return;

    const graphEl = document.getElementById('graph-container');
    if (!graphEl || !this._lastGraph) return; // nothing visible; next render picks the mode up

    // T and U are conditional — marine data, and a day that reaches Very
    // High UV — so the cycle is whatever the last render actually put on
    // screen rather than something re-derived from opts here. An inland
    // city on a mild day toggles between R and W exactly as before.
    const cycle = this._graphCycle || ['precip', 'wind'];

    // Start from what's actually ON SCREEN, not the stored preference —
    // those differ when a saved 'tide' or 'uv' is being displayed as
    // precip (inland city, mild day), and cycling from the invisible
    // value would appear to skip a mode.
    const shown = cycle.includes(this._graphMode) ? this._graphMode : cycle[0];
    const idx = cycle.indexOf(shown);
    const next = cycle[(idx + 1) % cycle.length];
    this._graphMode = next;
    Storage.setGraphMode(next);

    // Re-render from the stored args (the resize path), then cube-flip
    // from the old markup to the new. Keyboard focus dies with the old
    // rect, so restore it onto the fresh one after the flip.
    const hadFocus = document.activeElement &&
      document.activeElement.classList &&
      document.activeElement.classList.contains('graph-mode-toggle');
    const oldHTML = graphEl.innerHTML;
    this.renderGraph(
      this._lastGraph.hourly,
      this._lastGraph.tz,
      this._lastGraph.omHourly || [],
      this._lastGraph.opts || {}
    );
    const newHTML = graphEl.innerHTML;
    if (newHTML === oldHTML) return; // hidden container etc. — mode saved, nothing to animate

    this._graphCubeAnimating = true;
    // Horizontal-axis flip, distinct from the vertical-axis day changes.
    // Advancing through the cycle always rolls UP so the motion reads as
    // "next series" regardless of which one you land on; only the wrap
    // back to the start rolls down, mirroring the way a carousel returns.
    const direction = next === cycle[0] ? 'down' : 'up';
    this.runElementCubeTransition(graphEl, oldHTML, newHTML, direction)
      .finally(() => {
        this._graphCubeAnimating = false;
        if (hadFocus) {
          const rect = graphEl.querySelector('.graph-mode-toggle');
          if (rect) rect.focus();
        }
      });
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
        onDelete(parseInt(btn.getAttribute('data-index'), 10));
      });
    });
  },

  // Pointer-Events reorder handler for the saved-locations list.
  //
  // Cards default to CSS `touch-action: pan-y` so the list scrolls
  // normally; `.dragging` switches to `touch-action: none` for the
  // duration of a drag. Drag-to-reorder must be intentionally invoked:
  //   - Mouse: press + move past 6px → drag immediately.
  //   - Touch: press and hold 350ms without significant movement → drag
  //     mode; any earlier movement cancels the timer and lets the
  //     browser scroll.
  // Once drag mode begins, pointermove preventDefault()s to claim the
  // gesture (the browser hasn't committed to a scroll yet because the
  // finger was still during the long-press). Pointer up without ever
  // entering drag mode → tap → select.
  _bindCardInteractions(list, onSelect, onReorder) {
    const DRAG_THRESHOLD = 6; // px before press is treated as drag
    const cards = Array.from(this.savedLocationsList.querySelectorAll('.location-card'));

    const measure = () => cards.map(c => {
      const r = c.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, mid: r.top + r.height / 2, height: r.height };
    });

    cards.forEach(card => {
      const fromIdx = parseInt(card.getAttribute('data-index'), 10);
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

        // The measured rects are viewport coordinates captured at drag
        // start — a wheel/momentum scroll mid-drag would silently shift
        // every drop target. Re-measure whenever any ancestor scrolls
        // (capture catches scrolls on the overlay's scroll container).
        const onAnyScroll = () => { if (dragging) rects = measure(); };
        window.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });

        const cleanup = () => {
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('scroll', onAnyScroll, { capture: true });
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
  },

  _initImportExportPanel() {
    if (!this.importExportScreen) return;
    
    if (this.copyClipboardBtn) {
      this.copyClipboardBtn.addEventListener('click', () => this.handleCopyToClipboard());
    }
    
    if (this.pasteClipboardBtn) {
      this.pasteClipboardBtn.addEventListener('click', () => this.handlePasteFromClipboard());
    }
    
    if (this.importExportTextarea) {
      const updateBtn = () => this.updateImportButtonState();
      this.importExportTextarea.addEventListener('input', updateBtn);
      this.importExportTextarea.addEventListener('change', updateBtn);
      this.importExportTextarea.addEventListener('keyup', updateBtn);
    }
    
    if (this.exportDataBtn) {
      this.exportDataBtn.addEventListener('click', () => App.handleExportData());
    }
    
    if (this.importDataBtn) {
      this.importDataBtn.addEventListener('click', () => App.handleImportData());
    }
  },

  onShowImportExportScreen() {
    const hasKey = !!Storage.getCustomApiKey();
    if (this.exportApiKeyContainer) {
      this.exportApiKeyContainer.style.display = hasKey ? 'block' : 'none';
    }
    if (this.exportApiKeyCheckbox) {
      // Default OFF — the key is a secret, and exports often get pasted
      // into chats/pastebins. Including it must be an explicit opt-in
      // each time the screen opens.
      this.exportApiKeyCheckbox.checked = false;
    }
    if (this.importExportTextarea) {
      this.importExportTextarea.value = '';
    }
    if (this.importExportFeedback) {
      this.importExportFeedback.textContent = '';
      this.importExportFeedback.className = 'byok-feedback';
    }
    this.updateImportButtonState();
  },

  updateImportButtonState() {
    if (!this.importExportTextarea || !this.importDataBtn) return;
    const text = this.importExportTextarea.value.trim();
    let isValid = false;
    if (text) {
      try {
        const data = JSON.parse(text);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const hasLocations = Array.isArray(data.locations);
          const hasCurrentLoc = data.currentLocation && typeof data.currentLocation === 'object';
          const hasApiKey = typeof data.apiKey === 'string';

          if (hasLocations || hasCurrentLoc || hasApiKey) {
            isValid = true;

            if (hasLocations) {
              for (const loc of data.locations) {
                if (loc && (typeof loc.lat !== 'number' || typeof loc.lon !== 'number' || typeof loc.name !== 'string')) {
                  isValid = false;
                  break;
                }
              }
            }
            if (hasCurrentLoc && isValid) {
              const loc = data.currentLocation;
              if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number' || typeof loc.name !== 'string') {
                isValid = false;
              }
            }
          }
        }
      } catch (e) {
        isValid = false;
      }
    }
    this.importDataBtn.disabled = !isValid;
  },

  async handlePasteFromClipboard() {
    const feedback = this.importExportFeedback;
    const textarea = this.importExportTextarea;
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      if (feedback) {
        feedback.textContent = 'Clipboard API not supported. Please paste manually using Ctrl+V.';
        feedback.className = 'byok-feedback is-error';
      }
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (textarea) {
        textarea.value = text;
        this.updateImportButtonState();
      }
      if (feedback) {
        feedback.textContent = 'Clipboard pasted successfully.';
        feedback.className = 'byok-feedback is-success';
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err);
      if (feedback) {
        feedback.textContent = 'Could not access clipboard. Please paste manually.';
        feedback.className = 'byok-feedback is-error';
      }
    }
  },

  async handleCopyToClipboard() {
    const feedback = this.importExportFeedback;
    const textarea = this.importExportTextarea;
    if (!textarea || !textarea.value.trim()) return;
    
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      if (feedback) {
        feedback.textContent = 'Clipboard API not supported. Please select and copy manually.';
        feedback.className = 'byok-feedback is-error';
      }
      return;
    }
    
    try {
      await navigator.clipboard.writeText(textarea.value);
      if (feedback) {
        feedback.textContent = 'Copied to clipboard successfully!';
        feedback.className = 'byok-feedback is-success';
      }
    } catch (err) {
      console.error('Failed to write clipboard:', err);
      if (feedback) {
        feedback.textContent = 'Could not copy to clipboard. Please select and copy manually.';
        feedback.className = 'byok-feedback is-error';
      }
    }
  },

  fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    let successful = false;
    try {
      successful = document.execCommand('copy');
    } catch (err) {
      console.error('Fallback copy failed:', err);
    }
    document.body.removeChild(textArea);
    return successful;
  },

  async handleCopyURL() {
    const loc = Storage.getLocation();
    if (!loc) {
      this.showToast('No active location to copy URL for.', true);
      return;
    }
    
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set('lat', loc.lat);
    url.searchParams.set('lon', loc.lon);
    url.searchParams.set('name', loc.name);

    const state = App.state;
    if (state && (state.selectedDayIndex !== -1 || state.selectedHourDt !== null)) {
      const dayKey = App.getDayKey(state.selectedDayIndex);
      if (dayKey) {
        url.searchParams.set('day', dayKey);
      }
      // Guard against state.currentWeather being null (mid-cityswitch,
      // after a failed fetch, etc.) — without this, .timezone throws
      // a TypeError and the toast never appears. Skip the hour param
      // in that case; the receiver's day-only URL still round-trips.
      if (state.selectedHourDt !== null && state.currentWeather) {
        url.searchParams.set('dt', state.selectedHourDt);
        url.searchParams.set('hour', this.localHour(state.selectedHourDt, this.cityTz(state)));
      }
    }
    
    const shareUrl = url.toString();
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        this.showToast('URL copied to clipboard!');
        return;
      } catch (err) {
        console.warn('Clipboard API write failed, trying fallback:', err);
      }
    }
    
    if (this.fallbackCopyTextToClipboard(shareUrl)) {
      this.showToast('URL copied to clipboard!');
    } else {
      this.showToast('Could not copy URL.', true);
    }
  },

  showToast(message, isError = false) {
    const toast = document.getElementById('toast-notification');
    const toastMsg = document.getElementById('toast-message');
    if (!toast || !toastMsg) return;
    
    toastMsg.textContent = message;
    
    const icon = toast.querySelector('svg');
    if (icon) {
      if (isError) {
        icon.innerHTML = `<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>`;
        icon.style.color = '#ff5252';
      } else {
        icon.innerHTML = `<polyline points="20 6 9 17 4 12"></polyline>`;
        icon.style.color = 'var(--accent-color)';
      }
    }
    
    toast.classList.add('visible');
    toast.setAttribute('aria-hidden', 'false');
    
    if (this._toastTimeout) {
      clearTimeout(this._toastTimeout);
    }
    
    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('visible');
      toast.setAttribute('aria-hidden', 'true');
    }, 3000);
  }
};
