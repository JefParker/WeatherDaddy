// WeatherDaddy UI — the day graph (temperature line + precip / wind / tide / UV series).
//
// One of the ui-*.js files that extend the UI object defined in ui.js.
// No build step: index.html loads ui.js first, then these in order,
// then app.js. Methods reference each other only at call time, so
// cross-file calls resolve once every script has run. When adding a
// file, list it in index.html AND in sw.js ASSETS_TO_CACHE.

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

Object.assign(UI, {
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
        const t = WeatherAPI.marineTimeToSec(tTimes[i]);
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
});
