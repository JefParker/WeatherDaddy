// WeatherDaddy UI — the radar overlay (animated precipitation map).
//
// One of the ui-*.js files that extend the UI object defined in ui.js.
// No build step: index.html loads ui.js first, then these in order,
// then app.js. Methods reference each other only at call time, so
// cross-file calls resolve once every script has run. When adding a
// file, list it in index.html AND in sw.js ASSETS_TO_CACHE.
//
// Two radar providers, picked by location (see RADAR_PROVIDERS):
//   - NOAA NEXRAD composite tiles, served by the Iowa Environmental
//     Mesonet cache, for the contiguous US. Real radar, 5-minute steps,
//     roughly an hour of history. No key, no manifest: the past frames
//     are fixed layer names (…-m05m … …-m55m).
//   - RainViewer everywhere else, and as the fallback when the IEM cache
//     is unreachable. Global composite, 10-minute steps, two hours of
//     history, one manifest fetch first. Free for personal use with
//     attribution — in About and in the map's attribution corner.
// The basemap is OpenFreeMap's dark style, lightened a little after it
// loads (BASEMAP_LIFT): keyless, no stated limits, vector tiles (hence
// MapLibre rather than Leaflet). It renders
// OpenStreetMap data, whose licence wants the "© OpenStreetMap
// contributors" credit ON the map, not just in About — MapLibre's
// attribution control carries it.
//
// MapLibre is vendored under js/vendor and injected on the first tap of
// the Radar button rather than loaded with the page: it is ~1 MB that
// most sessions never need. It still sits in the service-worker precache
// so later opens don't depend on fetching it.
//
// The map is built fresh on every open and destroyed on close. Frames go
// stale within minutes anyway, and a live WebGL context is the wrong
// thing to keep around behind a forecast dashboard on a phone.
Object.assign(UI, {
  RADAR: {
    BASEMAP_STYLE: 'https://tiles.openfreemap.org/styles/dark',
    MAPLIBRE_JS:   'js/vendor/maplibre-gl.js',
    MAPLIBRE_CSS:  'css/maplibre-gl.css',
    // ~150–300 miles across on a phone: wide enough to see what is
    // upstream and heading in, which is what people open radar for.
    ZOOM: 7,
    MIN_ZOOM: 3,
    MAX_ZOOM: 11,
    OPACITY: 0.72,
    // OpenFreeMap's dark style is near-black: land rgb(12,12,12), water
    // rgb(27,27,29), mid-grey labels on black. Under the radar colours
    // it reads as a void — coastlines and roads vanish. Every colour in
    // the style is lifted this fraction of the way toward white once it
    // loads (see _radarLiftBasemap), which keeps its own contrast
    // relationships intact. 0 leaves the style as served.
    BASEMAP_LIFT: 0.14,
    // Even lifted, the style's water is a grey a few levels off the
    // land. A cool tint on the water layers (see _radarLiftBasemap)
    // makes the coastline readable at a glance without touching
    // anything else. Empty string: leave the water as the style has it.
    WATER_COLOR: 'rgb(46,60,80)',
    FRAME_MS: 450,
    // Linger on the newest frame so the loop reads as "…and here is now".
    LAST_FRAME_HOLD_MS: 1600,
    PROBE_TIMEOUT_MS: 8000
  },

  RADAR_PROVIDERS: {
    nexrad: {
      id: 'nexrad',
      label: 'NOAA NEXRAD',
      attribution: 'Radar: NOAA NEXRAD via <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener noreferrer">IEM</a>',
      tileSize: 256,
      maxzoom: 10,
      // The IEM composite is CONUS only. Alaska, Hawaii and Puerto Rico
      // go to RainViewer, which folds NOAA's radars into its mosaic.
      covers(lat, lon) {
        return lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66;
      },
      async frames() {
        const base = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913';
        const now = Math.floor(Date.now() / 1000);
        const out = [];
        for (let m = 55; m >= 5; m -= 5) {
          const mm = String(m).padStart(2, '0');
          out.push({ time: now - m * 60, tiles: `${base}-m${mm}m/{z}/{x}/{y}.png` });
        }
        out.push({ time: now, tiles: `${base}/{z}/{x}/{y}.png` });
        return out;
      }
    },
    rainviewer: {
      id: 'rainviewer',
      label: 'RainViewer',
      attribution: 'Radar: <a href="https://www.rainviewer.com/" target="_blank" rel="noopener noreferrer">RainViewer</a>',
      // RainViewer's radar stops at zoom 7: anything deeper returns a
      // "Zoom Level Not Supported" placeholder image, not a 404. 512px
      // tiles at maxzoom 7 give MapLibre real data at the opening zoom
      // (a 256px source would already be asking for z8 there) and let
      // it upsample from z7 for anything closer.
      tileSize: 512,
      maxzoom: 7,
      covers() { return true; },
      async frames() {
        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' });
        if (!res.ok) throw new Error('RainViewer manifest HTTP ' + res.status);
        const m = await res.json();
        const past = (m && m.radar && Array.isArray(m.radar.past)) ? m.radar.past : [];
        if (!past.length || !m.host) throw new Error('RainViewer manifest has no frames');
        // Colour scheme 6 is RainViewer's NEXRAD Level III palette, so a
        // RainViewer city reads the same as a NEXRAD one. 1_1 = smoothed,
        // snow in its own colours. Nowcast frames are deliberately left
        // out so both providers present the identical control.
        return past
          .slice()
          .sort((a, b) => a.time - b.time)
          .map(f => ({ time: f.time, tiles: `${m.host}${f.path}/512/{z}/{x}/{y}/6/1_1.png` }));
      }
    }
  },

  // How long the basemap style may take before "Loading radar…" gives
  // way to a message; a working connection loads it in a few seconds.
  RADAR_LOAD_TIMEOUT_MS: 20000,
  _radar: null,
  _radarToken: 0,
  _maplibrePromise: null,
  _webgl2Supported: null,

  // ── Open / close ────────────────────────────────────────────────────

  // Entry point from the Radar button under the day graph. Opens the
  // overlay immediately (so the tap feels acknowledged), then loads the
  // library, picks a provider and builds the map in the background.
  async openRadar(lat, lon) {
    lat = Number(lat); lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    this._teardownRadar();
    const token = ++this._radarToken;
    const r = this._radar = {
      token, lat, lon,
      provider: null, frames: [], idx: -1,
      map: null, timer: null, playing: false,
      loaded: false, loadTimer: null
    };

    this._radarSetProvider(null);
    this._radarStatus('Loading radar…');
    this._radarSetControlsEnabled(false);
    this.toggleScreen('radar', true);

    try {
      if (!this._hasWebGL2()) {
        this._radarStatus('Radar needs a newer browser (WebGL2).');
        return;
      }
      await this._loadMapLibre();
      if (token !== this._radarToken) return;

      const { provider, frames } = await this._radarFramesWithFallback(lat, lon);
      if (token !== this._radarToken) return;

      r.provider = provider;
      r.frames = frames;
      this._radarSetProvider(provider);
      this._buildRadarMap(r);
    } catch (e) {
      console.warn('[WeatherDaddy Radar]', e);
      if (token !== this._radarToken) return;
      this._radarStatus(navigator.onLine === false
        ? 'Radar needs a connection.'
        : 'Radar is unavailable right now. Try again in a minute.');
    }
  },

  closeRadar() {
    this.toggleScreen('radar', false);
  },

  // Called from toggleScreen('radar', false) — the single close path,
  // whether via the back button, Escape, or a programmatic close.
  _teardownRadar() {
    const r = this._radar;
    this._radarToken++;
    if (!r) return;
    this._radar = null;
    if (r.timer) clearTimeout(r.timer);
    if (r.loadTimer) clearTimeout(r.loadTimer);
    if (r.map) {
      try { r.map.remove(); } catch (_) { /* already gone */ }
    }
    this._radarSetPlaying(false);
  },

  // ── Provider selection ──────────────────────────────────────────────

  // Primary is whichever provider covers the point (NEXRAD inside CONUS,
  // RainViewer elsewhere); the other is tried when the primary's frame
  // list or its newest tile can't be fetched. The probe is one plain
  // fetch of the tile under the city, at the opening zoom — cheap, and
  // it turns "the map stays blank" into a deterministic fallback instead
  // of guessing from MapLibre's per-tile error events.
  async _radarFramesWithFallback(lat, lon) {
    const P = this.RADAR_PROVIDERS;
    const order = P.nexrad.covers(lat, lon)
      ? [P.nexrad, P.rainviewer]
      : [P.rainviewer];
    let lastErr = null;
    for (const provider of order) {
      try {
        const frames = await provider.frames();
        if (!frames.length) throw new Error(provider.id + ': no frames');
        await this._probeRadarTile(frames[frames.length - 1].tiles, lat, lon);
        return { provider, frames };
      } catch (e) {
        console.warn('[WeatherDaddy Radar] provider ' + provider.id + ' failed:', e);
        lastErr = e;
      }
    }
    throw lastErr || new Error('No radar provider available');
  },

  async _probeRadarTile(template, lat, lon) {
    const z = this.RADAR.ZOOM;
    const n = Math.pow(2, z);
    const x = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.RADAR.PROBE_TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, { mode: 'cors', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error('tile probe HTTP ' + res.status);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  // ── Map ─────────────────────────────────────────────────────────────

  _buildRadarMap(r) {
    const ml = window.maplibregl;
    const R = this.RADAR;
    const container = document.getElementById('radar-map');
    if (!container) return;
    container.innerHTML = '';

    const map = new ml.Map({
      container,
      style: R.BASEMAP_STYLE,
      center: [r.lon, r.lat],
      zoom: R.ZOOM,
      minZoom: R.MIN_ZOOM,
      maxZoom: R.MAX_ZOOM,
      attributionControl: false,
      // A flat, north-up map: rotation and pitch add nothing to radar
      // and make the touch gestures fight the scrubber.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0
    });
    r.map = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    // OpenStreetMap's credit comes from the style's own source metadata;
    // the radar provider's is added here. Never compact: the OSM credit
    // has to stay visible, and the line is short enough to afford it.
    map.addControl(new ml.AttributionControl({
      compact: false,
      customAttribution: r.provider.attribution
    }), 'bottom-left');
    map.addControl(new ml.NavigationControl({ showCompass: false, showZoom: true }), 'top-right');

    const dot = document.createElement('div');
    dot.className = 'radar-marker';
    dot.setAttribute('aria-hidden', 'true');
    new ml.Marker({ element: dot }).setLngLat([r.lon, r.lat]).addTo(map);

    // "Loading radar…" must not be the last word. The frames and the
    // tile probe succeeded, but the basemap style is a separate host:
    // if it fails (or the connection drops between the probe and the
    // style fetch) `load` never fires, so say so rather than sit on the
    // loading message with the controls disabled.
    const failedToLoad = () => {
      if (r !== this._radar || r.loaded) return;
      this._radarStatus(navigator.onLine === false
        ? 'Radar needs a connection.'
        : 'The radar map couldn’t load. Close it and try again in a minute.');
    };
    r.loadTimer = setTimeout(failedToLoad, this.RADAR_LOAD_TIMEOUT_MS);

    map.on('error', (e) => {
      // MapLibre reports every failed tile here. Radar tiles for an
      // out-of-coverage corner of the view 404 routinely; log once per
      // open rather than spamming the console.
      if (!r._loggedError) {
        r._loggedError = true;
        console.warn('[WeatherDaddy Radar] map error:', e && e.error ? e.error.message || e.error : e);
      }
      // Before `load`, an error that isn't a tile is usually the style
      // (or a source it names) failing to fetch, after which the map
      // never loads — but a sprite or glyph miss reports the same way
      // and the style still loads, so give `load` a few more seconds
      // rather than calling it at once. A late `load` still wins.
      if (!r.loaded && !(e && e.tile) && r === this._radar) {
        clearTimeout(r.loadTimer);
        r.loadTimer = setTimeout(failedToLoad, 5000);
      }
    });

    map.on('load', () => {
      if (r !== this._radar || r.loaded) return;
      r.loaded = true;
      clearTimeout(r.loadTimer);
      this._radarLiftBasemap(map);
      this._addRadarLayers(r);
      this._radarStatus(null);
      this._radarSetControlsEnabled(true);
      this._radarShowFrame(r, r.frames.length - 1);
      // Start the loop once the first pass of tiles is in, so it doesn't
      // stutter through half-loaded frames on a slow connection.
      map.once('idle', () => {
        if (r !== this._radar) return;
        this._radarPlay(r);
      });
    });
  },

  // Lighten the basemap by BASEMAP_LIFT: every plain colour string in
  // every layer's paint (fills, lines, text, halos) moves the same
  // fraction toward white, so the style's dark-on-darker hierarchy
  // survives, just brighter. Colours given as zoom expressions (one
  // motorway fill in the current style) are left alone. A 2D canvas
  // does the colour parsing — it normalises any CSS colour the style
  // can contain (hex, rgb, hsl, with or without alpha) to one of two
  // shapes, which is far less code than parsing them by hand.
  _radarLiftBasemap(map) {
    const k = this.RADAR.BASEMAP_LIFT;
    if (!(k > 0)) return;
    let ctx;
    try { ctx = document.createElement('canvas').getContext('2d'); } catch (_) { return; }
    if (!ctx) return;
    const SENTINEL = '#010203';
    const lift = (color) => {
      if (typeof color !== 'string') return null;
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = color;
      const norm = ctx.fillStyle;
      if (norm === SENTINEL) return null;
      let r, g, b, a = 1;
      let m = /^#([0-9a-f]{6})$/i.exec(norm);
      if (m) {
        const n = parseInt(m[1], 16);
        r = n >> 16; g = (n >> 8) & 255; b = n & 255;
      } else if ((m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(norm))) {
        r = +m[1]; g = +m[2]; b = +m[3]; a = +m[4];
      } else {
        return null;
      }
      const up = c => Math.round(c + (255 - c) * k);
      return `rgba(${up(r)},${up(g)},${up(b)},${a})`;
    };
    let layers;
    try { layers = (map.getStyle() || {}).layers || []; } catch (_) { return; }
    layers.forEach(l => {
      const paint = l.paint || {};
      Object.keys(paint).forEach(key => {
        if (!/-color$/.test(key)) return;
        const c = lift(paint[key]);
        if (c) { try { map.setPaintProperty(l.id, key, c); } catch (_) {} }
      });
    });
    // Water after the lift, so the tint is exactly WATER_COLOR. The
    // style's water fill and its waterway lines share one colour.
    const water = this.RADAR.WATER_COLOR;
    if (water) {
      layers.forEach(l => {
        if (l.id !== 'water' && l.id !== 'waterway') return;
        const key = l.type === 'line' ? 'line-color' : 'fill-color';
        try { map.setPaintProperty(l.id, key, water); } catch (_) {}
      });
    }
  },

  // One raster source + layer per frame, all added up front with opacity
  // 0 except the current one. Layers with visibility:visible fetch their
  // tiles even at opacity 0, which is the preload that makes playback
  // smooth — a dozen frames' worth of small PNGs for the view, fetched
  // once per open. Inserted beneath the first symbol layer so place
  // names stay legible over the colour.
  _addRadarLayers(r) {
    const map = r.map;
    const p = r.provider;
    let beforeId;
    try {
      const layers = (map.getStyle() || {}).layers || [];
      const sym = layers.find(l => l.type === 'symbol');
      beforeId = sym ? sym.id : undefined;
    } catch (_) { beforeId = undefined; }

    r.frames.forEach((f, i) => {
      const id = 'radar-' + i;
      map.addSource(id, {
        type: 'raster',
        tiles: [f.tiles],
        tileSize: p.tileSize,
        maxzoom: p.maxzoom
      });
      map.addLayer({
        id,
        type: 'raster',
        source: id,
        paint: {
          'raster-opacity': 0,
          'raster-opacity-transition': { duration: 0, delay: 0 },
          'raster-fade-duration': 0
        }
      }, beforeId);
    });
  },

  // ── Playback ────────────────────────────────────────────────────────

  _radarShowFrame(r, idx) {
    if (!r.map || !r.frames.length) return;
    const n = r.frames.length;
    idx = Math.max(0, Math.min(n - 1, idx | 0));
    if (r.idx >= 0 && r.idx !== idx) {
      try { r.map.setPaintProperty('radar-' + r.idx, 'raster-opacity', 0); } catch (_) {}
    }
    try { r.map.setPaintProperty('radar-' + idx, 'raster-opacity', this.RADAR.OPACITY); } catch (_) {}
    r.idx = idx;

    const range = document.getElementById('radar-scrubber');
    if (range) {
      range.max = String(n - 1);
      if (String(range.value) !== String(idx)) range.value = String(idx);
    }
    const label = document.getElementById('radar-time');
    if (label) label.textContent = this._radarFrameLabel(r.frames[idx].time);
  },

  _radarFrameLabel(timeSec) {
    const mins = Math.max(0, Math.round((Date.now() / 1000 - timeSec) / 60));
    if (mins <= 2) return 'Now';
    return mins + ' min ago';
  },

  _radarPlay(r) {
    if (!r || r !== this._radar) return;
    r.playing = true;
    this._radarSetPlaying(true);
    this._radarScheduleNext(r);
  },

  _radarPause(r) {
    if (!r) return;
    r.playing = false;
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    this._radarSetPlaying(false);
  },

  _radarScheduleNext(r) {
    if (r.timer) clearTimeout(r.timer);
    const n = r.frames.length;
    const delay = r.idx >= n - 1 ? this.RADAR.LAST_FRAME_HOLD_MS : this.RADAR.FRAME_MS;
    r.timer = setTimeout(() => {
      r.timer = null;
      if (r !== this._radar || !r.playing) return;
      this._radarShowFrame(r, (r.idx + 1) % n);
      this._radarScheduleNext(r);
    }, delay);
  },

  // ── Chrome ──────────────────────────────────────────────────────────

  // Wired once from UI.init(): back button, play/pause, scrubber,
  // recenter. The overlay markup is static in index.html so these
  // listeners never go stale.
  _bindRadarControls() {
    const back = document.getElementById('radar-back-btn');
    if (back) back.addEventListener('click', () => this.closeRadar());

    const play = document.getElementById('radar-play');
    if (play) play.addEventListener('click', () => {
      const r = this._radar;
      if (!r || !r.map) return;
      if (r.playing) this._radarPause(r); else this._radarPlay(r);
    });

    const range = document.getElementById('radar-scrubber');
    if (range) range.addEventListener('input', () => {
      const r = this._radar;
      if (!r || !r.map) return;
      this._radarPause(r);
      this._radarShowFrame(r, parseInt(range.value, 10) || 0);
    });

    const recenter = document.getElementById('radar-recenter');
    if (recenter) recenter.addEventListener('click', () => {
      const r = this._radar;
      if (!r || !r.map) return;
      r.map.easeTo({ center: [r.lon, r.lat], zoom: this.RADAR.ZOOM, duration: 500 });
    });

    // The overlay slides in with a transform transition. The container
    // already has its final size while off-screen, so the map is built
    // straight away — but a resize once the slide finishes is cheap
    // insurance against a stale canvas size on the first paint.
    const screen = document.getElementById('radar-screen');
    if (screen) screen.addEventListener('transitionend', (e) => {
      if (e.target !== screen) return;
      const r = this._radar;
      if (r && r.map) { try { r.map.resize(); } catch (_) {} }
    });
  },

  _radarStatus(text) {
    const el = document.getElementById('radar-status');
    if (!el) return;
    if (text) { el.textContent = text; el.hidden = false; }
    else { el.textContent = ''; el.hidden = true; }
  },

  _radarSetProvider(provider) {
    const el = document.getElementById('radar-provider');
    if (el) el.textContent = provider ? provider.label : '';
  },

  _radarSetControlsEnabled(on) {
    ['radar-play', 'radar-scrubber', 'radar-recenter'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !on;
    });
    if (!on) {
      const label = document.getElementById('radar-time');
      if (label) label.textContent = '';
      const range = document.getElementById('radar-scrubber');
      if (range) { range.value = '0'; range.max = '0'; }
    }
  },

  _radarSetPlaying(playing) {
    const btn = document.getElementById('radar-play');
    if (!btn) return;
    btn.classList.toggle('is-playing', !!playing);
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
  },

  // ── Library loading ─────────────────────────────────────────────────

  _hasWebGL2() {
    if (this._webgl2Supported !== null) return this._webgl2Supported;
    let ok = false;
    try {
      const c = document.createElement('canvas');
      ok = !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
    } catch (_) { ok = false; }
    this._webgl2Supported = ok;
    return ok;
  },

  _loadMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    if (this._maplibrePromise) return this._maplibrePromise;
    const R = this.RADAR;
    this._maplibrePromise = new Promise((resolve, reject) => {
      if (!document.getElementById('maplibre-css')) {
        const link = document.createElement('link');
        link.id = 'maplibre-css';
        link.rel = 'stylesheet';
        link.href = R.MAPLIBRE_CSS;
        document.head.appendChild(link);
      }
      const s = document.createElement('script');
      s.src = R.MAPLIBRE_JS;
      s.async = true;
      s.onload = () => {
        if (window.maplibregl) resolve();
        else { this._maplibrePromise = null; reject(new Error('MapLibre loaded but maplibregl is missing')); }
      };
      s.onerror = () => {
        this._maplibrePromise = null;
        s.remove();
        reject(new Error('Could not load the map library'));
      };
      document.head.appendChild(s);
    });
    return this._maplibrePromise;
  }
});
