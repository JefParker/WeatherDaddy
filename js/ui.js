// WeatherDaddy UI — shell: DOM handles, init, screens, BYOK panel,
// context menu, alert bar, discussion overlay, import-export, toast.
//
// The UI object is DEFINED here and EXTENDED by the ui-*.js files that
// index.html loads after this one (Object.assign onto the same object):
//   ui-format.js       units, time zones, icons, astronomy helpers
//   ui-transitions.js  cube transitions, hero-slide, swipe recogniser
//   ui-graph.js        the day graph
//   ui-dashboard.js    buildDailyData + renderDashboard and its pieces
//   ui-locations.js    the saved-locations list
// Everything is a method on one object, so `this` works the same in
// every file. Add new files to index.html AND sw.js ASSETS_TO_CACHE.

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

    // Forecast-discussion overlay: opened by the Forecaster's Notes
    // button under the graph (ui-dashboard.js), closed here.
    const discussionBack = document.getElementById('discussion-back-btn');
    if (discussionBack) discussionBack.addEventListener('click', () => this.toggleScreen('discussion', false));

    // Close any open overlay on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      ['alerts', 'discussion', 'about', 'units', 'locations', 'main-menu', 'import-export'].forEach(s => {
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

    const setFeedback = (msg, kind) => this.setFeedback(feedback, msg, kind);

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

  // Status line under a form (BYOK panel, import/export screen). kind is
  // 'success' | 'error' | null (neutral). Every feedback write goes
  // through here so the class names can't drift between the panels.
  setFeedback(el, msg, kind) {
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'byok-feedback' +
      (kind === 'success' ? ' is-success' : kind === 'error' ? ' is-error' : '');
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
    this.setFeedback(this.importExportFeedback, '', null);
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
      this.setFeedback(feedback, 'Clipboard API not supported. Please paste manually using Ctrl+V.', 'error');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (textarea) {
        textarea.value = text;
        this.updateImportButtonState();
      }
      this.setFeedback(feedback, 'Clipboard pasted successfully.', 'success');
    } catch (err) {
      console.error('Failed to read clipboard:', err);
      this.setFeedback(feedback, 'Could not access clipboard. Please paste manually.', 'error');
    }
  },

  async handleCopyToClipboard() {
    const feedback = this.importExportFeedback;
    const textarea = this.importExportTextarea;
    if (!textarea || !textarea.value.trim()) return;
    
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      this.setFeedback(feedback, 'Clipboard API not supported. Please select and copy manually.', 'error');
      return;
    }
    
    try {
      await navigator.clipboard.writeText(textarea.value);
      this.setFeedback(feedback, 'Copied to clipboard successfully!', 'success');
    } catch (err) {
      console.error('Failed to write clipboard:', err);
      this.setFeedback(feedback, 'Could not copy to clipboard. Please select and copy manually.', 'error');
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
