// WeatherDaddy UI — the dashboard: day list, hero, quick stats, hourly scroller, daily list.
//
// One of the ui-*.js files that extend the UI object defined in ui.js.
// No build step: index.html loads ui.js first, then these in order,
// then app.js. Methods reference each other only at call time, so
// cross-file calls resolve once every script has run. When adding a
// file, list it in index.html AND in sw.js ASSETS_TO_CACHE.

// Chevron for the quick-stats pager's edge arrows. One glyph, pointing
// left; the .next button mirrors it in CSS. 9px wide so it clears the
// grid's 16px side padding without ever reaching a stat's text.
const STATS_ARROW_SVG =
  '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" ' +
  'stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="15 5 8 12 15 19"></polyline></svg>';

Object.assign(UI, {
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
    // True UTC instant of a day's local midnight (DST-correct where
    // Open-Meteo covers the day; a day it doesn't cover usually means
    // omHourly is empty too and the top-up is a no-op).
    const dayStartFor = (day) => this._dayStartSec(day.key, tz, omDaily, currentWeather.timezone);
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

  // ── Dashboard ───────────────────────────────────────────────────────
  // renderDashboard is split into a CONTEXT builder (every figure the
  // sections share — the active day, the pinned hour, the hero's data,
  // per-day totals) and pure section builders that turn that context
  // into HTML. Nothing below reads state directly except through ctx, so
  // a new stat or hero line only touches its own builder.

  // Severity ranking used to pick a day's headline slot — a storm at
  // 3 AM is a more useful daily headline than a clear noon. Ties are
  // broken by closeness to local noon in _notableSlotFor. Used by both
  // the daily-list row and the hero (for non-today days), so the two
  // stay matched and the row→hero slide animation still ends on the
  // same illustration.
  NOTABILITY: {
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
  },

  STATS_PER_PAGE: 6,

  // Open-Meteo's daily summary, matched by city-local day KEY rather
  // than array index — daily[0] is "today", but rendered day 0 can
  // already be tomorrow near local midnight.
  _omDailyForKey(ctx, key) {
    return (ctx.state.omDaily || []).find(od => ctx.dayKeyFor(od.dt) === key) || null;
  },

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
  _dayExtremesC(ctx, day) {
    if (!day || !day.temps || !day.temps.length) return null;
    let hi = Math.max(...day.temps);
    let lo = Math.min(...day.temps);
    const om = day.key ? this._omDailyForKey(ctx, day.key) : null;
    if (om) {
      if (om.tempMax != null) hi = Math.max(hi, om.tempMax);
      if (om.tempMin != null) lo = Math.min(lo, om.tempMin);
    }
    return { hi, lo };
  },

  // Day totals for any forecast day: sum of rain+snow mm and max PoP
  // across the 3h slots in that day. Used identically for Today and
  // forecast days so the Precipitation / Probability rows update
  // consistently.
  //
  // `wholeDay` false means "rest of today": sum only the slots still
  // ahead, the way this has always worked for the Today tab.
  //
  // Open-Meteo's precipSum is a CALENDAR-DAY total, so using it for
  // today would report rain that already fell — at 6 PM on a clear
  // evening the row would read 18 mm because of a morning downpour.
  // The sibling popMax stat already refuses the daily figure for today
  // for exactly this reason; this keeps the two consistent.
  _dayTotals(ctx, day, wholeDay = true) {
    // hasWindow false, not undefined: no day means no forecast window
    // at all, and the hero must not assert "No precipitation expected"
    // off the back of it.
    if (!day) return { rainMM: 0, pop: 0, snowMM: null, hasWindow: false };
    // For a whole forecast day, Open-Meteo's exact total beats
    // re-summing sampled buckets: _omHourToOwmSlot multiplies ONE
    // sampled hour by three to stand in for a 3h bucket, so a short
    // convective storm either vanishes between samples or gets tripled.
    const om = (wholeDay && day.key) ? this._omDailyForKey(ctx, day.key) : null;
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
  },

  // The most "notable" hourly slot for a day, per NOTABILITY: strictly
  // higher severity always wins; among ties the slot closest to local
  // noon. That means:
  //   - any thunderstorm anywhere in the day → ⛈️ icon
  //   - else any snow → 🌨️ icon
  //   - else any rain → 🌧️ icon
  //   - else any dust/sand/smoke/haze/mist → that atmospheric icon
  //   - else cloudiest of the day → ☁️ / ⛅
  //   - else clear → ☀️
  _notableSlotFor(ctx, day) {
    if (!day || !day.hourly || !day.hourly.length) return null;
    let best = null;
    let bestScore = -1;
    let bestDiff  = Infinity;
    for (const slot of day.hourly) {
      if (!slot.weather || !slot.weather[0]) continue;
      const asset = this._weatherAssetName(slot.weather[0].icon, slot.weather[0].id);
      const score = this.NOTABILITY[asset] != null ? this.NOTABILITY[asset] : 0;
      const lh = this.localHour(slot.dt, ctx.tz);
      const diff = Math.abs(lh - 12);
      if (score > bestScore || (score === bestScore && diff < bestDiff)) {
        bestScore = score;
        bestDiff  = diff;
        best      = slot;
      }
    }
    return best;
  },

  // Sunrise/sunset for the calendar day containing `ts` at the city.
  // Today trusts OWM's values (sub-minute accurate); forecast days
  // compute locally since OWM's free /forecast endpoint doesn't include
  // them, and Open-Meteo-synthesised days carry their own.
  _sunTimesAt(ctx, ts) {
    const p = this.localParts(ts, ctx.tz);
    return this._solarTimes(
      p.year, p.month, p.day,
      ctx.currentWeather.coord.lat, ctx.currentWeather.coord.lon,
      ctx.tz
    );
  },

  // The day the dashboard is describing, in one shape whether it's the
  // live "today" view or a forecast day. Feeds the quick stats, the
  // temperature graph and the daily-list highlight; the hero reads
  // ctx.heroData instead (which is this unless an hour is pinned).
  _activeDayFor(ctx) {
    const { currentWeather, forecast, dailyData, selectedDayIndex, isToday } = ctx;
    if (isToday) {
      // Rest-of-today, not the calendar day — see _dayTotals.
      const totals = this._dayTotals(ctx, ctx.todayData, false);
      return {
        main: currentWeather.main,
        weather: currentWeather.weather,
        wind: currentWeather.wind,
        visibility: currentWeather.visibility,
        // Today's graph spans NOW → NOW + 24h (rolling window). Forecast
        // days use their local-calendar-day slots (below).
        hourly: forecast.list.slice(0, 8),
        sunrise: currentWeather.sys.sunrise,
        sunset: currentWeather.sys.sunset,
        pop: totals.pop,
        rainMM: totals.rainMM,
        snowMM: totals.snowMM,
        hasWindow: totals.hasWindow,
        // Used by the hero icon picker so a phase-correct moon shows
        // tonight if it's currently clear-night here. (Forecast days
        // get .dt via the `mid` spread below.)
        dt: currentWeather.dt
      };
    }
    const day = dailyData[selectedDayIndex];
    const mid = day.hourly[Math.floor(day.hourly.length / 2)];
    const totals = this._dayTotals(ctx, day);
    // Open-Meteo-synthesised days carry exact sunrise/sunset; otherwise
    // compute via the U.S. Naval Observatory formula.
    const sun = day._om
      ? { sunrise: day._om.sunrise, sunset: day._om.sunset }
      : this._sunTimesAt(ctx, day.dt);
    // Headline icon for the day = the most NOTABLE weather, tie-broken
    // by closeness to local noon. Matches the daily-list row picker
    // exactly, so the row→hero slide animation lands on the same art.
    const heroSlot = this._notableSlotFor(ctx, day) || mid;
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
  },

  // The exact slot behind a tapped hourly tile, or null. The day-level
  // activeDay keeps driving the quick stats, graph and daily-list
  // highlight (those describe the whole day); only the hero card swaps.
  // A missing dt (stale pin after refresh, city change, etc.) silently
  // falls back to the day view.
  _pinnedHourSlotFor(ctx) {
    const { selectedHourDt, dailyData, state } = ctx;
    if (selectedHourDt == null) return null;
    for (const d of dailyData) {
      if (!d || !d.hourly) continue;
      const found = d.hourly.find(h => h.dt === selectedHourDt);
      if (found) return found;
    }
    // Not on the 3h spine? The pin is one of the near-term 2h tiles —
    // display-layer slots that never live in day.hourly. Resolve it
    // straight from the Open-Meteo hourly series (which also keeps an
    // older 2h pin alive after it drifts out of the 24h tile window).
    const om = (state.omHourly || []).find(h => h.dt === selectedHourDt);
    return om ? this._omHourToOwmSlot(om) : null;
  },

  // What the hero card reads (main, weather, wind, dt): activeDay, or
  // the pinned slot's values layered on top of it with the hero icon's
  // asset name recomputed (and the ambient-fx selection downstream) so
  // it tracks the hour.
  _heroDataFor(ctx) {
    const { activeDay, pinnedHourSlot } = ctx;
    if (!pinnedHourSlot) return activeDay;
    const w0 = (pinnedHourSlot.weather && pinnedHourSlot.weather[0]) || activeDay.weather[0];
    const heroAsset = w0 ? this._weatherAssetName(w0.icon, w0.id) : null;
    const weatherWithAsset = (w0 && heroAsset)
      ? [{ ...w0, _asset: heroAsset }]
      : [w0];
    return {
      ...activeDay,
      main:    pinnedHourSlot.main    || activeDay.main,
      weather: weatherWithAsset,
      wind:    pinnedHourSlot.wind    || activeDay.wind,
      dt:      pinnedHourSlot.dt
    };
  },

  // Everything the dashboard sections share, computed once per render.
  _dashboardContext(state) {
    const { currentWeather, forecast, cityName } = state;
    // Canonical 8-day list + day keys. Built by the shared builder so
    // the rendered days can never diverge from what App's Copy-URL
    // sender/receiver resolves against. `tz` is the city's IANA zone
    // name when Open-Meteo supplied one, else OWM's fixed offset.
    const { dailyData, todayKey, dayKeyFor, tz } = this.buildDailyData(state);

    let selectedDayIndex = state.selectedDayIndex;
    if (selectedDayIndex >= dailyData.length) selectedDayIndex = -1;
    const selectedHourDt = state.selectedHourDt || null;
    // The Today tab (index 0) and the initial state (-1) both mean
    // "today" — unify them so the rolling 24h temperature graph and the
    // rest-of-today metrics are identical regardless of which path we
    // got here through.
    const isToday = selectedDayIndex === -1 || selectedDayIndex === 0;
    const nowSec = Math.floor(Date.now() / 1000);

    // ── Near-term 2h tiles ─────────────────────────────────────────
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

    const ctx = {
      state, currentWeather, forecast, cityName,
      cityChanged: this._renderedCityName !== cityName,
      tz, dayKeyFor, todayKey, dailyData,
      selectedDayIndex, selectedHourDt, isToday,
      todayData: dailyData[0],
      nowSec, nearTermByKey, lastNearTermDt,
      todayIdx, nowDayIdx, currentDayIdx
    };

    ctx.activeDay      = this._activeDayFor(ctx);
    ctx.pinnedHourSlot = this._pinnedHourSlotFor(ctx);
    ctx.heroData       = this._heroDataFor(ctx);

    const { activeDay, pinnedHourSlot } = ctx;
    ctx.activeDayEntry = isToday ? dailyData[0] : dailyData[selectedDayIndex];
    ctx.activeDayKey   = ctx.activeDayEntry ? ctx.activeDayEntry.key : null;
    // Open-Meteo's daily summary for the active day — the authoritative
    // whole-day numbers (max precip probability, max wind, sunshine)
    // that beat anything derived from sampled 3h slots.
    ctx.activeOmDay    = this._omDailyForKey(ctx, ctx.activeDayKey);

    // UV: current for today, daily-max for forecast days. Falls back to
    // '—' downstream if Open-Meteo was unreachable or had no data.
    const uv = state.uv || { current: null, daily: [] };
    const uvForKey = (key) => {
      const om = this._omDailyForKey(ctx, key);
      return om && om.uvIndexMax != null ? om.uvIndexMax : null;
    };
    let uvValue = isToday
      ? (uv.current != null ? uv.current : uvForKey(ctx.activeDayKey))
      : uvForKey(ctx.activeDayKey);
    // A pinned hour shows THAT hour's UV when Open-Meteo has it, not the
    // day max — matches how the rest of the hero tracks the pinned slot.
    if (pinnedHourSlot) {
      const omHour = (state.omHourly || []).find(h => h.dt === pinnedHourSlot.dt);
      if (omHour && omHour.uvIndex != null) uvValue = omHour.uvIndex;
    }
    ctx.uvValue = uvValue;

    // Precip chance: for forecast days prefer the daily max probability
    // over the max of sampled slots. Today keeps the rest-of-day slot
    // figure — the daily max can reflect rain that already fell.
    ctx.popValue = (!isToday && ctx.activeOmDay && ctx.activeOmDay.popMax != null)
      ? ctx.activeOmDay.popMax / 100
      : (activeDay.pop || 0);

    // Cloud cover: pinned hour → that slot; today → current conditions;
    // forecast day → mean over the day's slots that carry a value.
    ctx.cloudCover = (() => {
      if (pinnedHourSlot && pinnedHourSlot.clouds && pinnedHourSlot.clouds.all != null) {
        return pinnedHourSlot.clouds.all;
      }
      if (isToday && currentWeather.clouds && currentWeather.clouds.all != null) {
        return currentWeather.clouds.all;
      }
      const vals = ((ctx.activeDayEntry && ctx.activeDayEntry.hourly) || [])
        .map(h => h.clouds && h.clouds.all)
        .filter(v => v != null);
      if (!vals.length) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    })();

    ctx.dewPoint = this.calculateDewPoint(activeDay.main.temp, activeDay.main.humidity);
    ctx.aq = state.airQuality || { aqi: null, pollen: null, treePollen: null, grassPollen: null, weedPollen: null };

    // Coastal tests. Two separate questions, deliberately not conflated:
    //   marineCellIsLocal — is Open-Meteo's marine grid cell actually
    //     near this city? Governs WATER TEMP, which comes only from that
    //     cell. Longitude degrees shrink toward the poles, so the
    //     longitude term is scaled by cos(lat) for a true ~7km radius
    //     everywhere (a raw Pythagorean distance demoted Nordic coastal
    //     cities to the last stats page).
    //   touchesWater — should tide rows show at all? A matched NOAA
    //     station IS the coastal signal — stations only exist on tidal
    //     water — and is a far stronger yes than the proximity heuristic.
    // Reusing one flag for both would let a nearby station vouch for an
    // SST reading taken 40km offshore, behind a headland or up a bay.
    ctx.marineCellIsLocal = false;
    if (currentWeather.coord && state.tideCoords) {
      const latRad = currentWeather.coord.lat * Math.PI / 180;
      const dLat = state.tideCoords.lat - currentWeather.coord.lat;
      const dLon = (state.tideCoords.lon - currentWeather.coord.lon) * Math.cos(latRad);
      const degDiff = Math.sqrt(dLat * dLat + dLon * dLon);
      ctx.marineCellIsLocal = degDiff <= 0.065;
    }
    ctx.touchesWater = !!state.tidePredictions || ctx.marineCellIsLocal;

    ctx.cityClock = this.formatTime(nowSec, true, tz);
    return ctx;
  },

  // ── Hero ────────────────────────────────────────────────────────────

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
  _heroWhen(ctx) {
    const { pinnedHourSlot, tz, dayKeyFor, todayKey, isToday, dailyData, selectedDayIndex } = ctx;
    if (pinnedHourSlot) {
      const hourLabel = this.formatTime(pinnedHourSlot.dt, true, tz);
      const hourDayKey = dayKeyFor(pinnedHourSlot.dt);
      const localHour = this.localHour(pinnedHourSlot.dt, tz);
      if (hourDayKey === todayKey) {
        if (localHour >= 17 && localHour <= 20)      return `This evening at ${hourLabel}`;
        else if (localHour >= 21 || localHour <= 4)  return `Tonight at ${hourLabel}`;
        return `Today at ${hourLabel}`;
      }
      // Derive the weekday from the slot's canonical city-local dayKey
      // so a slot that's "Wednesday in Tokyo" doesn't render as
      // "Tuesday" just because the browser is in New York.
      return `${this._weekdayFromDayKey(hourDayKey)} at ${hourLabel}`;
    }
    if (!isToday) {
      const day = dailyData[selectedDayIndex];
      if (day && day.key) return `${this._weekdayFromDayKey(day.key)}'s forecast`;
    }
    return 'Right now';
  },

  // The previously rendered "today" temperature, when the new render is
  // ALSO a same-city, same-unit, unpinned today view — the only case
  // where a changed number should play the 3D flip. Reads the OUTGOING
  // DOM, so it must run before the innerHTML swap. '' means no flip.
  _previousHeroTemp(ctx) {
    const prevHeroTempEl = this.weatherView ? this.weatherView.querySelector('.hero-temp-large') : null;
    if (prevHeroTempEl &&
        !ctx.cityChanged &&
        this._lastIsToday &&
        this._lastPinnedHour === null &&
        ctx.isToday &&
        ctx.selectedHourDt === null &&
        this._lastTempUnit === Storage.getUnits().temp) {
      const prevBackEl = this.weatherView.querySelector('.hero-temp-flip-back');
      return (prevBackEl ? prevBackEl.textContent : prevHeroTempEl.textContent).trim();
    }
    return '';
  },

  // Big temperature readout.
  //   - hour pinned         → that hour's single temp (regardless of day)
  //   - today, no pin       → current temp (flip-animated when it changed)
  //   - other day, no pin   → the day's high / low
  // Returns { html, shouldFlip }.
  _heroTempHTML(ctx) {
    const { pinnedHourSlot, heroData, isToday, activeDay, dailyData, selectedDayIndex } = ctx;
    if (pinnedHourSlot) {
      return { html: `<div class="hero-temp-large">${this.formatTemp(heroData.main.temp)}°</div>`, shouldFlip: false };
    }
    if (isToday) {
      const oldTempStr = this._previousHeroTemp(ctx);
      const newTempStr = `${this.formatTemp(activeDay.main.temp)}°`;
      if (oldTempStr && oldTempStr !== newTempStr) {
        return {
          shouldFlip: true,
          html: `
          <div class="hero-temp-flip-container">
            <div class="hero-temp-flip-card">
              <div class="hero-temp-flip-front hero-temp-large">${oldTempStr}</div>
              <div class="hero-temp-flip-back hero-temp-large">${newTempStr}</div>
            </div>
          </div>
        `
        };
      }
      return { html: `<div class="hero-temp-large">${newTempStr}</div>`, shouldFlip: false };
    }
    const day = dailyData[selectedDayIndex];
    const ex = this._dayExtremesC(ctx, day);
    const hi = Math.round(this.convertTemp(ex ? ex.hi : Math.max(...day.temps)));
    const lo = Math.round(this.convertTemp(ex ? ex.lo : Math.min(...day.temps)));
    return { html: `<div class="hero-temp-large">${hi}° / ${lo}°</div>`, shouldFlip: false };
  },

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
  _heroPrecipMsg(ctx) {
    const { isToday, activeDay, popValue, pinnedHourSlot, state, nowSec, tz } = ctx;
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
    return precipMsg;
  },

  // "Warmer/cooler than this time yesterday" — the past_days=1 slice
  // of Open-Meteo's hourly series. Compare in the user's display unit
  // so the rounded degree difference matches what the hero shows.
  _heroYesterdayMsg(ctx) {
    const { isToday, pinnedHourSlot, nowSec, state, currentWeather } = ctx;
    if (!isToday || pinnedHourSlot) return '';
    const target = nowSec - 86400;
    let best = null, bestDiff = Infinity;
    for (const h of (state.omHourly || [])) {
      const d = Math.abs(h.dt - target);
      if (d < bestDiff) { bestDiff = d; best = h; }
    }
    if (!(best && bestDiff <= 3600 && best.temp != null)) return '';
    const diff = Math.round(this.convertTemp(currentWeather.main.temp) - this.convertTemp(best.temp));
    return diff === 0
      ? 'About the same as yesterday'
      : `${Math.abs(diff)}° ${diff > 0 ? 'warmer' : 'cooler'} than this time yesterday`;
  },

  // Returns { html, shouldFlip }.
  _heroHTML(ctx) {
    const { heroData } = ctx;
    const temp = this._heroTempHTML(ctx);
    // Breeze description tracks the hero (pinned hour wind if set,
    // otherwise the day's wind) so the "Feels like X — windy" subtitle
    // stays consistent with the rest of the hero card.
    const breeze = this.windDescription(heroData.wind.speed);
    const yesterdayMsg = this._heroYesterdayMsg(ctx);
    const precipMsg = this._heroPrecipMsg(ctx);
    const html = `<section class="hero-section">
        <div class="hero-when">${this.esc(this._heroWhen(ctx))}</div>
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
        ${temp.html}
        <div class="hero-feels-like">Feels like ${this.formatTemp(heroData.main.feels_like)}° - ${this.esc(breeze)}</div>
        ${yesterdayMsg ? `<div class="hero-yesterday">${this.esc(yesterdayMsg)}</div>` : ''}
        ${precipMsg ? `<div class="precip-message">${precipMsg}</div>` : ''}
      </section>`;
    return { html, shouldFlip: temp.shouldFlip };
  },

  // ── Quick stats ─────────────────────────────────────────────────────

  // One cell. The label is escaped, so cells whose label carries markup
  // (moon icon, UV / AQI pills) are built by hand.
  _statItem(label, value) {
    return `
      <div class="stat-item">
        <span class="stat-label">${this.esc(label)}</span>
        <span class="stat-value">${value}</span>
      </div>`;
  },

  // The full-moon card, when the hero's moment falls inside a
  // full-moon-visible window (sunset - 12h of the full-moon day through
  // the next sunrise). Returns { name, html } or null.
  _fullMoonCard(ctx) {
    const { heroData, tz } = ctx;
    const currentDt = heroData.dt;
    // Only the 3 full moons closest to currentDt can possibly bracket
    // it (previous / nearest / next by index). No year-scoped table
    // needed and no fixed 13-entry scan per render.
    for (const fm of getRelevantFullMoons(currentDt)) {
      const fmSun = this._sunTimesAt(ctx, fm.dt);
      const nextDaySun = this._sunTimesAt(ctx, fm.dt + 86400);
      if (!(fmSun.sunset && nextDaySun.sunrise)) continue;
      const startDt = fmSun.sunset - 12 * 3600;
      const endDt = nextDaySun.sunrise;
      if (!(currentDt >= startDt && currentDt <= endDt)) continue;

      let optimalDt = fm.dt;
      const fmPeakIsAtNight = fm.dt >= fmSun.sunset && fm.dt <= nextDaySun.sunrise;
      if (!fmPeakIsAtNight) {
        optimalDt = fmSun.sunset + (nextDaySun.sunrise - fmSun.sunset) / 2;
      }
      const optimalTimeStr = this.formatTime(optimalDt, true, tz);
      const moonFilter = FULL_MOON_FILTERS[fm.name] || FULL_MOON_FILTER_DEFAULT;
      const html = `
        <div class="stat-item full-moon-card" style="grid-column: span 3; display: flex; flex-direction: row; align-items: center; text-align: left; padding: 16px 20px; background: rgba(255, 255, 255, 0.03); border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.08); gap: 16px;">
          <img src="assets/icons/weather/moon-full.svg" alt="Full Moon" style="width: 48px; height: 48px; flex-shrink: 0; filter: ${moonFilter};" />
          <div style="min-width: 0;">
            <div style="font-size: 1.25rem; font-weight: 700; color: #eaeaea; line-height: 1.2;">${this.esc(fm.name)}</div>
            <div style="font-size: 0.95rem; color: #a0a0a0; margin-top: 4px;">Most Pronounced: ${optimalTimeStr}</div>
          </div>
        </div>
      `;
      return { name: fm.name, html };
    }
    return null;
  },

  // High / low tide cells. Two distinct questions depending on what
  // you're looking at:
  //
  //   Today, nothing pinned  → "what's next from right now"
  //   Any other day/hour     → "what happens on the day I selected"
  //
  // The old code always used `heroData.dt`, which on a forecast day is
  // the day's MIDDAY slot. That produced rows labelled "Next high tide"
  // that actually meant "first high tide after noon on that day" — and
  // the matching low routinely landed after local midnight, rendered as
  // a bare "1:40 AM" with nothing saying it belonged to the next day.
  //
  // Returns { high, low } (cell HTML) or null when there's no tide series.
  _tideStatItems(ctx) {
    const { state, isToday, pinnedHourSlot, heroData, activeDayKey, tz, dayKeyFor, currentWeather } = ctx;
    if (!(state.tideExtrema && state.tideExtrema.length > 0)) return null;

    const liveNow = isToday && !pinnedHourSlot;
    const anchorDt = heroData.dt;

    // Local-day window for the selected day, used for the non-live case.
    const dayStartSec = activeDayKey
      ? this._dayStartSec(activeDayKey, tz, state.omDaily, currentWeather.timezone)
      : null;

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
    const tideValue = (e) => {
      if (!e) return '—';
      // Heights are metres relative to MSL; below ±1.5 m the number is
      // noise for most readers, so only the time is shown.
      const heightStr = Math.abs(e.h) > 1.5 ? ` (${this.formatTideHeight(e.h)})` : '';
      // Only reachable in the live case, where "next" can cross midnight.
      const dayStr = dayKeyFor(e.dt) !== dayKeyFor(anchorDt) ? ' tomorrow' : '';
      return `${this.formatTime(e.dt, true, tz)}${dayStr}${heightStr}`;
    };

    return {
      high: this._statItem(liveNow ? 'Next high tide' : 'High tide', tideValue(pick('High'))),
      low:  this._statItem(liveNow ? 'Next low tide'  : 'Low tide',  tideValue(pick('Low')))
    };
  },

  // The quick-stats pages. The grid is capped at 2 rows / 6 cells per
  // page; items beyond that go on additional cube-swipeable pages.
  //
  // Page 1 is the top six of [notable..., routine...]: priority follows
  // NOTEWORTHINESS — extreme or unusual readings (a gale gust, Unhealthy
  // air, storm-low pressure) always outrank routine everyday stats,
  // which then fill whatever page-1 slots remain in their own order. A
  // "Moderate" AQI or a calm day's max wind is background info, not a
  // headline. Local time flexes into any spare page-1 slot. Page 2 leads
  // with Sunrise / Sunset / (Moon or UV) / Dew point / Moonrise /
  // Moonset, then the page-1 overflow, then low-priority extras.
  _buildStatsPages(ctx) {
    const { activeDay, activeOmDay, isToday, tz, uvValue, popValue, cloudCover, aq, dewPoint, cityClock, currentWeather, activeDayKey, state } = ctx;
    const item = (label, value) => this._statItem(label, value);
    const STATS_PER_PAGE = this.STATS_PER_PAGE;

    const hasGust       = this.isNoteworthyGust(activeDay.wind.speed, activeDay.wind.gust);
    const hasPressure   = this.isNoteworthyPressure(activeDay.main.pressure);
    const hasVisibility = this.isNoteworthyVisibility(activeDay.visibility);

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

    const fullMoon = this._fullMoonCard(ctx);
    const tideItems = this._tideStatItems(ctx);
    const { touchesWater, marineCellIsLocal } = ctx;

    if (touchesWater && tideItems) {
      routine.push(tideItems.high);
      routine.push(tideItems.low);
    }

    // Sea-surface temperature for the hour being viewed. Gated on
    // marineCellIsLocal rather than touchesWater: Open-Meteo's marine
    // cell is the sole source, so if that cell isn't near the city the
    // number isn't this city's water, whatever the tide station says.
    const waterTemp = this._waterTempAt(state.tides, ctx.heroData.dt);
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
      uvOnPage1 ? moonStatHTML : uvStatItem,
    ];
    if (!localTimeOnPage1) page2Forced.push(localTimeItem);
    page2Forced.push(item('Dew point', dewPoint != null ? `${this.formatTemp(dewPoint)}°` : '—'));

    // Moonrise / moonset for the active day, computed for the city's
    // local midnight (Open-Meteo's per-day dt when available — the
    // DST-correct instant — else derived from the day key + offset).
    if (activeDayKey) {
      const dayStartSec = this._dayStartSec(activeDayKey, tz, state.omDaily, currentWeather.timezone);
      const mt = this._moonTimes(dayStartSec, currentWeather.coord.lat, currentWeather.coord.lon);
      // A null is real astronomy (the moon skips a rise or set roughly
      // every couple of weeks) — show the em dash rather than hiding.
      page2Forced.push(item('Moonrise', mt.rise != null ? this.formatTime(mt.rise, true, tz) : '—'));
      page2Forced.push(item('Moonset',  mt.set  != null ? this.formatTime(mt.set,  true, tz) : '—'));
    }

    // Every page is padded out to exactly 6 cells with invisible
    // placeholders so the grid is always 2 rows tall — keeps the
    // cube-flip animation from causing a height change at the end.
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
    if (!touchesWater && tideItems) {
      lowPriority.push(tideItems.high);
      lowPriority.push(tideItems.low);
    }

    // The full-moon card spans all three columns of page 1's top row,
    // leaving room for three candidates beside it; the rest overflow.
    const page1Take = fullMoon ? 3 : STATS_PER_PAGE;
    const page1 = fullMoon
      ? [fullMoon.html, ...page1Candidates.slice(0, page1Take)].join('')
      : padToFull(page1Candidates.slice(0, page1Take));
    const overflow = page1Candidates.slice(page1Take);
    const page2AndAfter = [...page2Forced, ...overflow, ...lowPriority];

    const statsPages = [page1];
    for (let i = 0; i < page2AndAfter.length; i += STATS_PER_PAGE) {
      statsPages.push(padToFull(page2AndAfter.slice(i, i + STATS_PER_PAGE)));
    }
    return statsPages;
  },

  // ── Hourly scroller + daily list ────────────────────────────────────

  // Tiles for every day, with a synthetic "Now" tile leading today.
  //
  // Drops any slot whose start time is no longer in the future. OWM 3h
  // slots use their START time as dt — so once the 12 PM slot has
  // started, "Now" is the right label for it and the dedicated Now tile
  // takes over the visual spot. This also keeps the timeline from
  // showing a stale 9 AM tile next to "Now" at 11:30 AM. Open-Meteo
  // filler slots are 1h-spaced and only appear on forecast days
  // (entirely in the future), so the rule is a no-op there.
  //
  // The Now tile is sourced from the live currentWeather — its label
  // and data always reflect THIS moment, not a 3h-block snapshot.
  // Tapping it clears any pinned hour and returns the hero to the
  // "Right now" view (via onDayClick(nowDayIdx), which is what
  // handleDayClick does).
  //
  // Any day that becomes empty after filtering is skipped, and the
  // day-divider is suppressed before the first day actually rendered,
  // so the scroller can't lead with an orphan divider. Today never
  // becomes empty because the Now tile is always present.
  _hourlyScrollerHTML(ctx) {
    const { currentWeather: cw, dailyData, nowSec, nearTermByKey, lastNearTermDt, nowDayIdx, currentDayIdx, isToday, selectedHourDt, tz } = ctx;
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
  },

  // The 8-day hi/lo rows.
  _dailyListHTML(ctx) {
    const { dailyData, todayKey, selectedDayIndex, isToday, nowDayIdx } = ctx;
    return dailyData.slice(0, 8).map((d, i) => {
      // Derive the weekday/date strings from the canonical dayKey so the
      // label can never disagree with the entry's date (which used to
      // happen when re-shifting dt back through state.timezone).
      const date = this._dateFromDayKey(d.key);
      const isThisDayToday = d.key === todayKey;
      const dayName = isThisDayToday
        ? 'Today'
        : date.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' });
      const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
      // Round AFTER converting to the user's unit to avoid compounding errors.
      const dEx = this._dayExtremesC(ctx, d);
      const maxTemp = Math.round(this.convertTemp(dEx ? dEx.hi : Math.max(...d.temps)));
      const minTemp = Math.round(this.convertTemp(dEx ? dEx.lo : Math.min(...d.temps)));
      // Most-notable-weather icon for the day, identical picker as the
      // hero, so tapping this row slides into a matching illustration.
      const notable = this._notableSlotFor(ctx, d);
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
    }).join('');
  },

  // ── Wiring ──────────────────────────────────────────────────────────

  // Header star. Include cityName so name-match catches entries that
  // already sit in the saved list but whose stored coords drifted more
  // than SAME_LOCATION_DEG from what /weather just returned — otherwise
  // the star would flicker between saved and unsaved for the same place.
  _renderSaveButton(ctx, onSave) {
    const { currentWeather, cityName } = ctx;
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
  },

  // Listeners on the freshly rendered dashboard: hero dblclick unit
  // flip, daily-list rows, hourly tiles.
  _bindDashboard(ctx, onDayClick, onHourClick) {
    const { currentDayIdx, selectedHourDt, isToday, nowDayIdx } = ctx;

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
    // "Right now" view via onDayClick(nowDayIdx) (handleDayClick wipes
    // selectedHourDt).
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
  },

  // Position the hourly scroll: preserve the user's scroll on same-city
  // re-renders, otherwise frame the active day's first tile so a city
  // change or click-driven day change always shows the right day. Then
  // arm the scroll-into-new-day watcher.
  _positionHourlyScroll(ctx, prevHourlyScrollLeft, onDayClick) {
    const hourlyEl = this.weatherView.querySelector('.hourly-scroll');
    if (!hourlyEl) return;
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
    if (!ctx.cityChanged && prevHourlyScrollLeft != null && !this._snapHourlyToActiveDay) {
      hourlyEl.scrollLeft = prevHourlyScrollLeft;
    } else {
      const firstActiveTile = hourlyEl.querySelector(`.hourly-tile[data-day-index="${ctx.currentDayIdx}"]`);
      if (firstActiveTile) {
        // Bounding-rect math instead of offsetLeft — see the same-day
        // handler in _bindDashboard. In landscape, the .hourly-scroll
        // isn't a positioned ancestor, so a tile's offsetLeft can
        // include the full x-offset of the right grid column, causing
        // this "snap to start" to overshoot.
        const tileRect = firstActiveTile.getBoundingClientRect();
        const scrollRect = hourlyEl.getBoundingClientRect();
        hourlyEl.scrollLeft += (tileRect.left - scrollRect.left);
      }
    }
    this._snapHourlyToActiveDay = false;
    this._bindHourlyDayScroll(hourlyEl, ctx.currentDayIdx, onDayClick);
  },

  renderDashboard(state, onDayClick, onSave, onHourClick) {
    const ctx = this._dashboardContext(state);
    const { cityName, heroData, tz, isToday, pinnedHourSlot, selectedHourDt, dailyData, currentDayIdx, activeDay } = ctx;

    this.locationName.textContent = this.prettifyLocationName(cityName);
    this._renderSaveButton(ctx, onSave);

    // Hero subtitle clock keeps ticking between renders.
    this._clockTimezone = tz;
    this._ensureClockTimer();

    // Reads the OUTGOING DOM for the temperature flip — before the swap.
    const hero = this._heroHTML(ctx);

    const statsPages = this._buildStatsPages(ctx);
    // Reset to page 0 whenever the city changes; otherwise preserve.
    if (ctx.cityChanged) this._statsPageIdx = 0;
    if (this._statsPageIdx == null || this._statsPageIdx >= statsPages.length) this._statsPageIdx = 0;
    this._statsPages = statsPages;

    const html = `
      <!-- Left-column wrapper: hero + stats + temperature graph. Pairs
           with .dashboard-right (below) so the landscape two-column
           layout has exactly two grid cells, and the swipe-between-
           cities cube transition can spin each column independently
           instead of as one big cube. In portrait both wrappers stack
           as plain blocks, preserving the single-column layout. -->
      <div class="dashboard-left">
      ${hero.html}

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
        ${this._hourlyScrollerHTML(ctx)}
      </section>

      <section class="daily-list">
        ${this._dailyListHTML(ctx)}
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
    if (hero.shouldFlip) {
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

    this._bindDashboard(ctx, onDayClick, onHourClick);
    this._positionHourlyScroll(ctx, prevHourlyScrollLeft, onDayClick);

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
      tides: ctx.touchesWater ? tideSeries : null,
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

    this._bindHorizontalSwipe(hit, {
      onNudge: (dx) => { el.style.transform = `translateX(${dx * 0.2}px)`; },
      onRelease: () => this._releaseNudge(el),
      onSwipe: (dir) => this._changeStatsPage(dir)
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

  // Horizontal swipe anywhere ABOVE the temperature graph cycles through
  // the user's saved-locations list. Bound once at app init.
  bindCitySwipe(onSwipe) {
    if (this._citySwipeBound) return;
    this._citySwipeBound = true;

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

    this._bindHorizontalSwipe(document, {
      shouldStart: (e) => {
        // Don't trigger from inside an overlay (locations / menu / units).
        if (e.target.closest('.overlay-screen')) return false;
        // Don't trigger from interactive controls — they should still tap.
        if (e.target.closest('button, input, a')) return false;
        // The quick-stats pager has its own swipe handler that pages between
        // stat groups — don't also fire the city swipe from there.
        if (e.target.closest('.stats-pager, .quick-stats-grid')) return false;
        // Regions that own their own horizontal gestures. The geometric
        // "above the graph" check below isn't enough in the landscape
        // two-column layout, where the hourly scroller and daily list sit
        // in the right column — geometrically above the left column's
        // graph — and a drag meant to scroll the timeline would change
        // city instead.
        if (e.target.closest('.hourly-scroll, .daily-list, .graph-container')) return false;

        // Only above the temperature graph counts.
        const graph = document.getElementById('graph-container');
        if (graph) {
          const r = graph.getBoundingClientRect();
          if (e.clientY >= r.top) return false;
        }
        return true;
      },
      onStart: () => { nudgeTargets = liveTargets(); },
      onNudge: (dx) => {
        const t = `translateX(${dx * 0.2}px)`;
        nudgeTargets.forEach(el => { el.style.transform = t; });
      },
      onRelease: () => {
        if (nudgeTargets) nudgeTargets.forEach(el => this._releaseNudge(el));
        nudgeTargets = null;
      },
      onSwipe
    });
  },

  _bindGraphSwipe(currentIdx, maxIdx, onDayClick) {
    const el = document.getElementById('graph-container');
    if (!el) return;

    this._bindHorizontalSwipe(el, {
      // Slight follow-the-finger nudge for tactile feedback.
      onNudge: (dx) => { el.style.transform = `translateX(${dx * 0.25}px)`; },
      onRelease: () => this._releaseNudge(el),
      onSwipe: (dir) => {
        // Wrap around the ends: last day + swipe-left → first; first + swipe-right → last.
        const dayCount = maxIdx + 1;
        const next = dir === 'next'
          ? (currentIdx + 1) % dayCount
          : (currentIdx - 1 + dayCount) % dayCount;
        if (next === currentIdx) return;
        const targetRow = this.weatherView.querySelector(`.daily-item[data-index="${next}"]`);
        const finishHeroSlide = this.captureDayRowForHeroSlide(targetRow);
        this.changeDayWithGraphCube(next, dir, onDayClick);
        if (finishHeroSlide) finishHeroSlide();
      }
    });
  },
});
