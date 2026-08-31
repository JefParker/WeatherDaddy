// WeatherDaddy UI — formatting, units, time zones, icons and astronomy helpers.
//
// One of the ui-*.js files that extend the UI object defined in ui.js.
// No build step: index.html loads ui.js first, then these in order,
// then app.js. Methods reference each other only at call time, so
// cross-file calls resolve once every script has run. When adding a
// file, list it in index.html AND in sw.js ASSETS_TO_CACHE.

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
// Glow / tint applied to the full-moon card's illustration, keyed by the
// traditional name above. Anything not listed gets the plain white glow.
const FULL_MOON_FILTERS = {
  'Wolf Moon':       'drop-shadow(0 0 10px rgba(255, 255, 255, 0.25))',
  'Snow Moon':       'drop-shadow(0 0 10px rgba(255, 255, 255, 0.25))',
  'Worm Moon':       'drop-shadow(0 0 10px rgba(255, 220, 150, 0.35)) saturate(1.2) hue-rotate(15deg)',
  'Pink Moon':       'drop-shadow(0 0 12px rgba(255, 105, 180, 0.45)) saturate(1.4) hue-rotate(320deg)',
  'Flower Moon':     'drop-shadow(0 0 12px rgba(255, 182, 193, 0.35)) saturate(1.3) hue-rotate(340deg)',
  'Blue Moon':       'drop-shadow(0 0 12px rgba(30, 144, 255, 0.5)) saturate(1.6) hue-rotate(180deg)',
  'Strawberry Moon': 'drop-shadow(0 0 14px rgba(255, 100, 100, 0.55)) saturate(1.5) hue-rotate(345deg)',
  'Buck Moon':       'drop-shadow(0 0 12px rgba(218, 165, 32, 0.45)) saturate(1.4) hue-rotate(10deg)',
  'Sturgeon Moon':   'drop-shadow(0 0 10px rgba(176, 196, 222, 0.35))',
  'Harvest Moon':    'drop-shadow(0 0 14px rgba(255, 140, 0, 0.6)) saturate(1.7) hue-rotate(15deg)',
  "Hunter's Moon":   'drop-shadow(0 0 14px rgba(255, 69, 0, 0.6)) saturate(1.6) hue-rotate(5deg)',
  'Beaver Moon':     'drop-shadow(0 0 12px rgba(205, 133, 63, 0.4)) saturate(1.1)',
  'Cold Moon':       'drop-shadow(0 0 12px rgba(0, 255, 255, 0.45)) saturate(1.3) hue-rotate(150deg)'
};
const FULL_MOON_FILTER_DEFAULT = 'drop-shadow(0 0 10px rgba(255, 255, 255, 0.25))';

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

Object.assign(UI, {
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
      const t = WeatherAPI.marineTimeToSec(times[i]);
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

  // A day key as a Date at UTC midnight of that calendar date. Only ever
  // paired with `timeZone: 'UTC'` formatters, so a label derived from it
  // can't disagree with the key (which used to happen when dt was
  // re-shifted through state.timezone).
  _dateFromDayKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  },

  // Weekday name for a city-local day key: 'long' → "Wednesday",
  // 'short' → "Wed". Browser locale, like the rest of the date labels.
  _weekdayFromDayKey(key, style = 'long') {
    return this._dateFromDayKey(key).toLocaleDateString([], { weekday: style, timeZone: 'UTC' });
  },

  // True UTC instant of a city-local day's midnight. Prefers Open-Meteo's
  // per-day dt (already the DST-correct local midnight); falls back to
  // fixed-offset arithmetic — `tz` when it's a numeric offset, else
  // `fallbackOffset` (OWM's state.timezone) — for a day Open-Meteo
  // doesn't cover.
  _dayStartSec(key, tz, omDaily, fallbackOffset) {
    for (const di of (omDaily || [])) {
      if (this.dayKey(di.dt, tz) === key) return di.dt;
    }
    const off = typeof tz === 'number' ? tz : (fallbackOffset || 0);
    return Math.floor(this._dateFromDayKey(key).getTime() / 1000) - off;
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
});
