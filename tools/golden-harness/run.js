#!/usr/bin/env node
// Golden-master harness for WeatherDaddy.
//   node run.js --record      write goldens
//   node run.js --check       compare against goldens (exit 1 on diff)
//   node run.js --check --normalize   ignore whitespace-only differences
//   node run.js --only nyc-afternoon
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { buildFixture, SAMPLE_ALERT, SAMPLE_AFD, rawResponsesFor } = require('./fixtures');

const ROOT = process.env.WD_ROOT || require('path').resolve(__dirname, '..', '..');
const GOLDEN = path.join(__dirname, 'golden');
const args = process.argv.slice(2);
const MODE = args.includes('--record') ? 'record' : 'check';
const NORMALIZE = args.includes('--normalize');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

const METRIC24 = { temp: 'C', wind: 'kmh', pressure: 'hpa', precip: 'mm', dist: 'km', time: '24h' };
const IMPERIAL12 = { temp: 'F', wind: 'mph', pressure: 'inhg', precip: 'in', dist: 'mi', time: '12h' };
const MS24 = { temp: 'C', wind: 'ms', pressure: 'mmhg', precip: 'mm', dist: 'km', time: '24h' };

const T = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;
const NYC = { name: 'New York, New York', lat: 40.7128, lon: -74.006, tz: 'America/New_York', offsetSec: -14400 };

const SCENARIOS = [
  { id: 'nyc-afternoon', units: METRIC24, saved: true, graphModes: ['precip', 'wind', 'tide', 'uv'],
    fixture: { ...NYC, nowSec: T(2026, 9, 8, 18, 30), seed: 1, kind: 'mixed', coastal: true, noaa: true, peakUv: 9, aqi: 120, pollen: 60, alerts: [SAMPLE_ALERT], discussion: SAMPLE_AFD } },
  { id: 'nyc-night', units: IMPERIAL12, saved: false, graphModes: ['precip'],
    fixture: { ...NYC, nowSec: T(2026, 9, 9, 2, 30), seed: 2, kind: 'mixed', coastal: true, noaa: true, peakUv: 4, aqi: 60, alerts: [{ ...SAMPLE_ALERT, severity: 'Minor', event: 'Small Craft Advisory' }] } },
  { id: 'nyc-near-midnight', units: METRIC24, saved: true, graphModes: ['precip'],
    fixture: { ...NYC, nowSec: T(2026, 9, 9, 3, 50), seed: 3, kind: 'mixed', coastal: true, noaa: false, peakUv: 5, aqi: 20 } },
  { id: 'denver-snow', units: IMPERIAL12, saved: true, graphModes: ['precip', 'wind'],
    fixture: { name: 'Denver, Colorado', lat: 39.7392, lon: -104.9903, tz: 'America/Denver', offsetSec: -21600, nowSec: T(2026, 12, 14, 20, 0), seed: 4, kind: 'snowy', baseTemp: -3, amp: 4, coastal: false, peakUv: 2, aqi: 30 } },
  { id: 'tokyo-fullmoon', units: MS24, saved: true, graphModes: ['precip', 'tide'],
    fixture: { name: 'Tokyo, Japan', lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo', offsetSec: 32400, nowSec: T(2026, 9, 26, 12, 0), seed: 5, kind: 'clear', baseTemp: 24, coastal: true, noaa: false, peakUv: 5, aqi: 35 } },
  { id: 'london-no-enrichment', units: METRIC24, saved: false, graphModes: ['precip'],
    fixture: { name: 'London, GB', lat: 51.5074, lon: -0.1278, tz: 'Europe/London', offsetSec: 3600, nowSec: T(2026, 9, 8, 10, 0), seed: 6, kind: 'mixed', coastal: false, enrichment: false, aqi: null } },
  { id: 'reykjavik-bad-tzname', units: METRIC24, saved: true, graphModes: ['precip'],
    fixture: { name: 'Reykjavik, Iceland', lat: 64.1466, lon: -21.9426, tz: 'Atlantic/Reykjavik', offsetSec: 0, nowSec: T(2026, 6, 20, 23, 30), seed: 7, kind: 'clear', baseTemp: 11, amp: 3, coastal: true, noaa: false, peakUv: 3, aqi: 15, tzNameOverride: 'Not/AZone' } },
];

const SCRIPTS = () => {
  // Read the script order from index.html itself so the file split later is picked up automatically.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
};

async function makeWindow(nowSec, units, savedList, graphMode) {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = html.replace(/<script src="[^"]+"><\/script>\s*/g, '').replace(/<link rel="stylesheet"[^>]*>/, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  await new Promise(r => setTimeout(r, 0)); // let DOMContentLoaded pass before app.js is added

  window.fetch = () => Promise.reject(new Error('no network in harness'));
  window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  window.navigator.geolocation = undefined;
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 400; } });
  window.HTMLElement.prototype.scrollTo = function () {};
  window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.Date.now = () => nowSec * 1000;
  const errors = [];
  // Keep messages + call chain, drop file:line:col — line numbers move with every refactor.
  const scrub = (s) => String(s).split('\n')[0]; // message only — call chains and line numbers move with every refactor
  window.addEventListener('error', (e) => errors.push(scrub(e.error && e.error.stack || e.message)));
  window.console.error = (...a) => errors.push('console.error: ' + a.map(x => scrub(x && x.stack || x)).join(' '));
  window.console.warn = () => {};
  window.console.log = () => {};

  window.localStorage.setItem('weather_units', JSON.stringify(units));
  window.localStorage.setItem('weather_list', JSON.stringify(savedList));
  window.localStorage.setItem('weather_seeded', 'true');
  window.localStorage.setItem('cities_cache_v4', JSON.stringify(['New York, US', 'Denver, US', 'Tokyo, JP']));
  window.localStorage.setItem('graph_mode', graphMode);

  for (const src of SCRIPTS()) {
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(ROOT, src), 'utf8') + `\n//# sourceURL=${src}`;
    window.document.body.appendChild(el);
  }
  let App, UI, Storage, WeatherAPI;
  try { ({ App, UI, Storage, WeatherAPI } = window.eval('({ App, UI, Storage, WeatherAPI })')); } catch (e) { throw new Error('scripts failed to define App/UI: ' + e.message + '\n' + errors.join('\n')); }

  // Neuter everything that touches the network / SW / install flow, then run init for real.
  App.loadInitialWeather = async () => null;
  App.seedDefaultCities = async () => {};
  App._prefetchNeighborsOfCurrent = () => {};
  App.startAutoRefresh = () => {};
  App.registerServiceWorker = () => {};
  App.initInstallPrompt = () => {};
  const origPrefetch = App._prefetchCity;
  App._prefetchCity = async () => {};
  await App.init();
  App._origPrefetchCity = origPrefetch;
  return { window, dom, App, UI, Storage, WeatherAPI, errors };
}

function snapshot(window, UI, App) {
  const d = window.document;
  const fx = d.getElementById('weather-fx');
  const alertBar = d.getElementById('alert-bar');
  const discBar = d.getElementById('discussion-bar');
  return {
    weatherView: d.getElementById('weather-view').innerHTML,
    saveBtn: d.getElementById('save-btn-container').innerHTML,
    locationName: d.getElementById('location-name').textContent,
    fx: { className: fx.className, style: fx.getAttribute('style') },
    alertBar: { hidden: alertBar.hidden, className: alertBar.className, text: d.getElementById('alert-bar-text').textContent },
    discBar: { hidden: discBar.hidden, className: discBar.className, text: d.getElementById('discussion-bar-text').textContent },
    bodyClass: d.body.className,
    statsPages: UI._statsPages,
    statsPageIdx: UI._statsPageIdx,
    graphCycle: UI._graphCycle,
    graphMode: UI._graphMode,
    lastGraphOpts: UI._lastGraph && UI._lastGraph.opts,
    lastGraphTz: UI._lastGraph && UI._lastGraph.tz,
    lastGraphHourlyDts: UI._lastGraph && UI._lastGraph.hourly.map(h => h.dt),
    clockTz: UI._clockTimezone,
    state: { day: App.state.selectedDayIndex, hour: App.state.selectedHourDt, tzName: App.state.tzName, timezone: App.state.timezone, cityName: App.state.cityName, tideExtremaN: (App.state.tideExtrema || []).length }
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runScenario(sc) {
  const captures = {};
  const { payload, meta } = buildFixture(sc.fixture);
  const savedList = sc.saved ? [{ lat: meta.lat, lon: meta.lon, name: payload.cityName }, { lat: 34.05, lon: -118.24, name: 'Los Angeles, California' }] : [{ lat: 34.05, lon: -118.24, name: 'Los Angeles, California' }];

  for (const graphMode of sc.graphModes) {
    const { window, App, UI, Storage, WeatherAPI, errors } = await makeWindow(meta.nowSec, sc.units, savedList, graphMode);
    const tag = (s) => `${graphMode}/${s}`;

    // ── Apply the payload via the cache path (exercises _applyCachedCity) ──
    Storage.setWeatherCache(meta.lat, meta.lon, payload);
    const hit = App._applyCachedCity(meta.lat, meta.lon, payload.cityName, false);
    captures[tag('cacheHit')] = hit;
    captures[tag('render/today')] = snapshot(window, UI, App);

    // Day-list shape + share keys
    const daily = App._buildDailyData();
    captures[tag('dailyData')] = daily.map(d => ({ key: d.key, dt: d.dt, n: d.hourly.length, om: !!d._om, temps: d.temps.length, icons: d.icons.slice(0, 3) }));
    captures[tag('dayKeys')] = [-1, 0, 1, 2, 5, 6, 7, 8].map(i => App.getDayKey(i));

    // Tide extrema (function lives on App today; may move)
    const fte = App.findTideExtrema || (WeatherAPI && WeatherAPI.findTideExtrema);
    if (payload.tides && fte) captures[tag('tideExtrema')] = fte.call(App.findTideExtrema ? App : WeatherAPI, payload.tides).slice(0, 12);

    // ── Selections ──
    const selections = [{ label: 'day2', day: 2, hour: null }, { label: 'day6', day: 6, hour: null }, { label: 'lastday', day: daily.length - 1, hour: null }];
    if (daily[1] && daily[1].hourly[3]) selections.push({ label: 'pin-3h-day1', day: 1, hour: daily[1].hourly[3].dt });
    const nearTile = (payload.omHourly || []).find(h => h.dt > meta.nowSec && Math.floor(h.dt / 3600) % 2 === 0 && Math.floor(h.dt / 3600) % 3 !== 0);
    if (nearTile) selections.push({ label: 'pin-2h-today', day: 0, hour: nearTile.dt });
    selections.push({ label: 'day0', day: 0, hour: null });
    for (const s of selections) {
      if (s.hour != null) App.handleHourClick(s.hour, s.day); else App.handleDayClick(s.day);
      captures[tag(`render/${s.label}`)] = snapshot(window, UI, App);
    }
    App.handleDayClick(-1);

    if (graphMode === sc.graphModes[0]) {
      // ── Unit flip via hero dblclick path (handleUnitChange) ──
      App.handleUnitChange('temp', sc.units.temp === 'C' ? 'F' : 'C');
      captures[tag('render/unitFlip')] = snapshot(window, UI, App);
      App.handleUnitChange('temp', sc.units.temp);

      // ── Overlays ──
      UI.renderAlertsOverlay(payload.alerts || []);
      captures[tag('alertsOverlay')] = window.document.getElementById('alerts-body').innerHTML;
      UI.renderDiscussionOverlay(payload.discussion);
      captures[tag('discussionOverlay')] = window.document.getElementById('discussion-body').innerHTML;

      // ── Share URL ──
      let copied = null;
      window.navigator.clipboard = { writeText: async (t) => { copied = t; } };
      App.handleDayClick(2);
      await UI.handleCopyURL();
      captures[tag('shareUrl/day2')] = copied;
      if (daily[1] && daily[1].hourly[3]) { App.handleHourClick(daily[1].hourly[3].dt, 1); await UI.handleCopyURL(); captures[tag('shareUrl/pin')] = copied; }
      App.handleDayClick(-1);

      // ── Shared-state restore (receiver side) ──
      App._sharedStateToRestore = { day: daily[2] ? daily[2].key : '2026-01-01', dt: null, hour: 15 };
      App._resolveSharedDayAndHour(true);
      captures[tag('sharedRestore')] = { day: App.state.selectedDayIndex, hour: App.state.selectedHourDt };
      App.handleDayClick(-1);

      // ── Interactions that run the element cube (fallback timer path) ──
      const dailyRows = window.document.querySelectorAll('.daily-item');
      if (dailyRows[3]) { dailyRows[3].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(950); captures[tag('click/dailyRow3')] = snapshot(window, UI, App); }
      const tiles = window.document.querySelectorAll('.hourly-tile[data-dt]');
      if (tiles[2]) { tiles[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50); captures[tag('click/tile2')] = snapshot(window, UI, App); }
      const nowTile = window.document.querySelector('.hourly-tile[data-now]');
      if (nowTile) { nowTile.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await sleep(50); captures[tag('click/nowTile')] = snapshot(window, UI, App); }
      if (UI._statsPages && UI._statsPages.length > 1) { UI._changeStatsPage('next'); await sleep(950); captures[tag('statsNext')] = snapshot(window, UI, App); }
      UI._toggleGraphMode(); await sleep(950); captures[tag('graphToggle')] = snapshot(window, UI, App);
      captures[tag('graphModeStored')] = window.localStorage.getItem('graph_mode');

      // ── Pointer swipes: graph (day change) and stats pager ──
      {
        const d = window.document;
        const PE = window.PointerEvent || window.MouseEvent;
        const swipe = (el, x0, x1, y = 100) => {
          const mk = (type, x) => { const e = new PE(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }); if (e.pointerId === undefined) Object.defineProperty(e, 'pointerId', { value: 7 }); if (e.pointerType === undefined) Object.defineProperty(e, 'pointerType', { value: 'touch' }); return e; };
          el.dispatchEvent(mk('pointerdown', x0));
          el.dispatchEvent(mk('pointermove', x0 + (x1 - x0) * 0.3));
          el.dispatchEvent(mk('pointermove', x1));
          el.dispatchEvent(mk('pointerup', x1));
        };
        App.handleDayClick(-1);
        const g0 = d.getElementById('graph-container');
        swipe(g0, 300, 150); await sleep(950);
        const afterLeft = { day: App.state.selectedDayIndex, hasCube: !!d.querySelector('.cube-perspective') };
        swipe(d.getElementById('graph-container'), 100, 300); await sleep(950);
        const afterRight = { day: App.state.selectedDayIndex, transform: d.getElementById('graph-container').style.transform };
        // short drag: below threshold → no change
        swipe(d.getElementById('graph-container'), 200, 170); await sleep(950);
        const afterShort = { day: App.state.selectedDayIndex };
        // vertical drag: not horizontal → no change
        const g = d.getElementById('graph-container');
        const mkv = (type, x, y) => { const e = new PE(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }); if (e.pointerId === undefined) Object.defineProperty(e, 'pointerId', { value: 7 }); return e; };
        g.dispatchEvent(mkv('pointerdown', 200, 100)); g.dispatchEvent(mkv('pointermove', 190, 200)); g.dispatchEvent(mkv('pointerup', 190, 200)); await sleep(50);
        const afterVertical = { day: App.state.selectedDayIndex };
        let stats = null;
        const pager = d.querySelector('.stats-pager');
        if (pager && UI._statsPages.length > 1) {
          const before = UI._statsPageIdx;
          swipe(pager, 300, 100); await sleep(950);
          const afterNext = UI._statsPageIdx;
          swipe(d.querySelector('.stats-pager'), 100, 300); await sleep(950);
          stats = { before, afterNext, afterPrev: UI._statsPageIdx, page: d.getElementById('stats-pager').innerHTML };
        }
        captures[tag('swipes')] = { afterLeft, afterRight, afterShort, afterVertical, stats, pointerEventSupported: !!window.PointerEvent };
        App.handleDayClick(-1);
      }

      // ── Real network path through a fake fetch: _refreshCity / _prefetchCity / weather.js parsers ──
      {
        const respond = rawResponsesFor(payload, meta);
        const calls = [];
        window.fetch = async (url) => {
          calls.push(String(url).replace(/appid=[^&]+/, 'appid=X'));
          const [status, body] = respond(String(url));
          return { ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this; }, text: async () => JSON.stringify(body) };
        };
        const cacheKeys = () => Object.keys(Storage.getWeatherCache(meta.lat, meta.lon) || {}).sort();
        // No cache → loader → network → render. Selection resets to today.
        window.localStorage.removeItem('weather_cache');
        App.handleDayClick(3);
        await App.fetchAndDisplay(meta.lat, meta.lon, payload.cityName);
        captures[tag('net/fetchAndDisplay')] = snapshot(window, UI, App);
        captures[tag('net/cacheKeys')] = cacheKeys();
        captures[tag('net/urls')] = calls.map(c => c.replace(/[?].*/, '')).sort();
        const st = App.state;
        captures[tag('net/stateShape')] = { tzName: st.tzName, omH: st.omHourly.length, omD: st.omDaily.length, omM: st.omMinutely.length, uv: st.uv, aq: st.airQuality, alerts: st.alerts.length, tides: !!st.tides, tideCoords: st.tideCoords, noaa: st.tidePredictions && { station: st.tidePredictions.station.id, extrema: st.tidePredictions.extrema.length, hourly: st.tidePredictions.hourly.time.length }, extrema: st.tideExtrema.slice(0, 3), discussion: st.discussion && { office: st.discussion.office, issued: st.discussion.issued, len: st.discussion.text.length } };
        // Background refresh keeps the selected day + pinned hour.
        App.handleDayClick(2);
        await App.refreshCurrentWeather();
        const keptDay = { day: App.state.selectedDayIndex, hour: App.state.selectedHourDt };
        const d1 = App._buildDailyData()[1];
        if (d1 && d1.hourly[2]) { App.handleHourClick(d1.hourly[2].dt, 1); await App.refreshCurrentWeather(); }
        captures[tag('net/refreshKeeps')] = { keptDay, keptPin: { day: App.state.selectedDayIndex, hour: App.state.selectedHourDt } };
        // Prefetch must not strip the discussion the refresh cached (merge semantics).
        await App._origPrefetchCity.call(App, meta.lat, meta.lon, payload.cityName);
        captures[tag('net/prefetchMerge')] = { keys: cacheKeys(), discussionKept: !!(Storage.getWeatherCache(meta.lat, meta.lon) || {}).discussion === !!payload.discussion };
        // Stale-token: an older response must be dropped.
        const p1 = App._refreshCity(meta.lat, meta.lon, payload.cityName);
        App._fetchToken++;
        await p1;
        captures[tag('net/staleTokenKeepsState')] = App.state.cityName;
        // Total network failure with a loader showing → error path repaints the previous city.
        window.fetch = () => Promise.reject(new Error('no network in harness'));
        App.handleDayClick(-1);
      }

      // ── Refresh with preserveSelection (cache path) keeps the day ──
      App.handleDayClick(2);
      App._applyCachedCity(meta.lat, meta.lon, payload.cityName, true);
      captures[tag('preserveSelection')] = { day: App.state.selectedDayIndex, hour: App.state.selectedHourDt };

      // ── Save/unsave toggle ──
      App.handleDayClick(-1);
      App.handleSaveLocation();
      captures[tag('saveToggle')] = { list: Storage.getSavedList().map(l => l.name), btn: window.document.getElementById('save-btn-container').innerHTML };
      App.handleSaveLocation();

      // ── Saved-locations list render ──
      App.updateSavedLocations();
      captures[tag('savedList')] = window.document.getElementById('saved-locations-list').innerHTML;

      // ── Feedback lines: BYOK panel + import/export ──
      {
        const d = window.document;
        const fb = () => { const e = d.getElementById('byok-feedback'); return e && { text: e.textContent, cls: e.className }; };
        const st = () => ({ badge: d.getElementById('byok-status').className, text: d.getElementById('byok-status-text').textContent });
        const seq = [];
        d.getElementById('byok-save').click(); seq.push(['save-empty', fb(), st()]);
        d.getElementById('byok-input').value = 'abc'; d.getElementById('byok-save').click(); seq.push(['save-odd', fb(), st()]);
        d.getElementById('byok-input').value = '0123456789abcdef0123456789abcdef'; d.getElementById('byok-save').click(); seq.push(['save-ok', fb(), st(), Storage.getCustomApiKey()]);
        d.getElementById('byok-clear').click(); seq.push(['clear', fb(), st(), Storage.getCustomApiKey()]);
        const ie = () => { const e = d.getElementById('import-export-feedback'); return e && { text: e.textContent, cls: e.className, ta: d.getElementById('import-export-textarea').value, btn: d.getElementById('import-data-btn').disabled }; };
        UI.toggleScreen('import-export', true); seq.push(['ie-open', ie()]);
        App.handleExportData(); seq.push(['export', ie()]);
        d.getElementById('import-export-textarea').value = 'not json'; UI.updateImportButtonState(); await App.handleImportData(); seq.push(['import-bad', ie()]);
        d.getElementById('import-export-textarea').value = JSON.stringify({ locations: [{ lat: 48.85, lon: 2.35, name: 'Paris, France' }], apiKey: 'ffffffffffffffffffffffffffffffff' }); UI.updateImportButtonState(); await App.handleImportData(); seq.push(['import-ok', ie(), Storage.getSavedList().map(l => l.name), Storage.getCustomApiKey()]);
        await sleep(30);
        Storage.clearCustomApiKey();
        UI.toggleScreen('import-export', false);
        App.handleDayClick(-1);
        captures[tag('feedbackFlows')] = seq;
      }

      // ── Pure helpers ──
      captures[tag('helpers')] = {
        prettify: ['Los Angeles, CA', 'Tokyo, JP', 'Paris, France', 'Springfield'].map(n => UI.prettifyLocationName(n)),
        wind: [0.2, 4, 12, 30].map(v => UI.formatWind(v)),
        windDesc: [0.2, 4, 12, 30].map(v => UI.windDescription(v)),
        temps: [-3.4, 0, 21.5].map(v => UI.formatTemp(v)),
        times: [meta.nowSec, meta.nowSec + 7 * 3600].map(t => UI.formatTime(t, true, UI.cityTz(App.state))),
        dayKey: UI.dayKey(meta.nowSec, UI.cityTz(App.state)),
        moon: UI.moonPhaseName(meta.nowSec * 1000),
        dew: UI.calculateDewPoint(20, 60),
        uv: [0, 3, 8, 11].map(UI.uvLabel.bind(UI)),
        aqi: [10, 120, 400].map(UI.aqiLabel.bind(UI)),
        solar: UI._solarTimes(2026, 9, 8, meta.lat, meta.lon, UI.cityTz(App.state)),
        moonTimes: UI._moonTimes(meta.todayMidnight, meta.lat, meta.lon),
        nowcast: UI._precipNowcast(payload.omMinutely, meta.nowSec),
        precip: [0, 0.4, 12.34].map(v => UI.formatPrecip(v)),
        snow: [0, 3.2].map(v => UI.formatSnowDepth(v)),
        tide: [-1.234, 0.5].map(v => UI.formatTideHeight(v)),
        pressure: UI.formatPressure(1013), dist: UI.formatDist(8000),
        esc: UI.esc('<a href="x">&\'"</a>'),
        icon: UI.getWeatherIconSVG('01n', 24, 800, meta.nowSec),
        asset50: UI._weatherAssetName('50d', 721),
        afd: UI._parseAfd(SAMPLE_AFD.text)
      };
    }

    await sleep(30); // let any async chains kicked off above (byok:changed → fetch reject) settle before teardown
    captures[tag('errors')] = errors;
    window.close();
  }
  return captures;
}

function normalize(v) {
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = normalize(v[k]); return o; }
  return v;
}

function firstDiff(a, b) {
  const sa = typeof a === 'string' ? a : JSON.stringify(a, null, 1);
  const sb = typeof b === 'string' ? b : JSON.stringify(b, null, 1);
  let i = 0; while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  const ctx = (s) => s.slice(Math.max(0, i - 160), i + 240).replace(/\n/g, '⏎');
  return `    @${i}\n    - ${ctx(sa)}\n    + ${ctx(sb)}`;
}

(async () => {
  fs.mkdirSync(GOLDEN, { recursive: true });
  let failed = 0, checked = 0;
  for (const sc of SCENARIOS) {
    if (ONLY && sc.id !== ONLY) continue;
    const t0 = Date.now();
    const captures = await runScenario(sc);
    const file = path.join(GOLDEN, sc.id + '.json');
    const errs = Object.entries(captures).filter(([k, v]) => k.endsWith('errors') && v.length);
    if (MODE === 'record') {
      fs.writeFileSync(file, JSON.stringify(captures, null, 1));
      console.log(`recorded ${sc.id} (${Object.keys(captures).length} captures, ${Date.now() - t0}ms)${errs.length ? '  ⚠ runtime errors: ' + JSON.stringify(errs) : ''}`);
    } else {
      const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
      const keys = new Set([...Object.keys(golden), ...Object.keys(captures)]);
      const diffs = [];
      for (const k of keys) {
        checked++;
        let a = golden[k], b = captures[k];
        if (NORMALIZE) { a = normalize(a); b = normalize(b); }
        if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(k);
      }
      if (diffs.length) {
        failed += diffs.length;
        console.log(`✗ ${sc.id}: ${diffs.length} differing capture(s)`);
        for (const k of diffs.slice(0, 6)) console.log(`  ${k}\n${firstDiff(NORMALIZE ? normalize(golden[k]) : golden[k], NORMALIZE ? normalize(captures[k]) : captures[k])}`);
        if (diffs.length > 6) console.log(`  … and ${diffs.length - 6} more: ${diffs.slice(6).join(', ')}`);
      } else {
        console.log(`✓ ${sc.id} (${keys.size} captures)${errs.length ? '  ⚠ runtime errors: ' + JSON.stringify(errs) : ''}`);
      }
    }
  }
  if (MODE === 'check') { console.log(failed ? `\n${failed} of ${checked} captures differ` : `\nall ${checked} captures match`); process.exit(failed ? 1 : 0); }
})().catch(e => { console.error(e); process.exit(2); });
