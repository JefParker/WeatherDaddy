# WeatherDaddy — Code Review

Reviewed: `_worker.js`, `sw.js`, `js/app.js`, `js/ui.js`, `js/weather.js`, `js/storage.js`, `js/location.js`, `index.html`, `css/style.css`, `manifest.json`.

No secrets are committed — `.dev.vars` and `.wrangler/` are correctly gitignored and untracked.

---

## High

### 1. Cube transition can duplicate the entire dashboard
`js/ui.js:2828, 2852` (and `_runTwoColumnCubeTransition` ~2943)

`runCubeTransition` *moves* the freshly-rendered nodes into the cube's back face, then re-appends them to `#weather-view` 800 ms later in `finish()`. Nothing prevents `renderDashboard` from running in that window — and it does `this.weatherView.innerHTML = html` (line 2433), which detaches the cube but leaves `back` holding the old children in memory. `finish()` then appends them *after* the new dashboard: two `#graph-container`, two `#stats-pager`, two `#save-btn`, two clocks, two cities visible.

Triggers are routine: the 15-minute auto-refresh (`app.js:271`), the `visibilitychange` refresh (`app.js:275`), the refresh button, or a `byok:changed` re-fetch landing mid-animation. `_fetchToken` does not protect against this — those refreshes hold a valid token.

**Fix:** guard the restore, and have `renderAll()` defer while a transition is running.

```js
const finish = () => {
  if (done) return;
  done = true;
  if (perspective.isConnected) {
    while (back.firstChild) this.weatherView.appendChild(back.firstChild);
  }
  perspective.remove();
  resolve();
};
```

### 2. Fixed timezone offset breaks across DST — and silently drops a forecast day
`js/ui.js:1546-1549, 1580, 1606, 2616`; same pattern in `js/app.js:1064-1066`

OWM's `timezone` is a single scalar offset valid *at request time*. It's applied uniformly to timestamps up to 8 days out via `new Date((unix + timezone) * 1000).getUTC*()`.

- Every local time shown after a DST transition inside the forecast window is off by an hour (hourly tiles, sunrise/sunset, "Tonight at 10 PM", graph axis).
- Concretely at `ui.js:1580`: Open-Meteo is requested with `timezone=auto&timeformat=unixtime` (`weather.js:205`), so `omDaily[i].dt` is the true UTC instant of that day's local midnight — DST-correct per day. Re-keying it through OWM's *fixed* offset lands at 23:00 of the previous day after a spring-forward, so the key collides and the day is `continue`d away. **The user loses a forecast day.**

**Fix:** carry the IANA zone (Open-Meteo returns it) and derive day keys via `Intl.DateTimeFormat(locale, { timeZone })`. Minimum patch: key Open-Meteo days off their own returned local date instead of re-deriving through OWM's offset.

### 3. Day-key logic is duplicated in two files and must not drift
`js/app.js:1061` `_buildDailyData` vs `js/ui.js:1546+` `renderDashboard`

Both build the 8-day list independently with the same merge rules, and the doc comment in `app.js` explicitly warns that any divergence shifts Copy-URL onto the wrong day. This is a correctness landmine — the DST bug above already causes them to disagree in one direction. Extract a single shared builder.

---

## Medium

### 4. Duplicate SVG gradient id — new graph painted with old colors
`js/ui.js:3554` (definition), `3589` (two references)

`id="temp-line-gradient"` is hardcoded per render. During any cube transition both graphs are mounted at once, and SVG `url(#id)` resolves to the **first** match in tree order — always the outgoing face. The incoming temperature line is stroked with the outgoing day's gradient for the full 800 ms, then snaps.

**Fix:** unique id per render — `const gid = 'temp-line-gradient-' + (this._gradSeq = (this._gradSeq || 0) + 1);` interpolated into the `<linearGradient id>` and both `url(#${gid})` references.

### 5. "Now" tile pinned to array index 0
`js/ui.js:2336, 2341` — `const isTodayCol = dayIdx === 0;`

The comment at `ui.js:1550-1552` says the code deliberately uses `todayKey` "instead of trusting array position," and the daily list does exactly that (`d.key === todayKey`, line 2391). The hourly scroller doesn't. Near local midnight, when OWM's window has rolled past the city's current calendar day, `dailyData[0]` is *tomorrow* — so the live "Now" tile is injected under tomorrow's heading, the hero says "Right now" while highlighting tomorrow, and the daily list shows no "Today" row.

**Fix:** `const isTodayCol = day.key === todayKey;` and derive `currentDayIdx` from `dailyData.findIndex(d => d.key === todayKey)`.

### 6. Clones duplicate every `id` in the document
`js/ui.js:2822, 568-569, 648, 666`

`runCubeTransition` appends the **old** clone *before* the new nodes, so for ~800 ms `getElementById('graph-container' | 'stats-pager' | 'city-clock' | 'save-btn')` resolves to the stale clone. `_ensureClockTimer` (line 144) ticks the dead clone. `closeOverlayWithCube` clones `.app-header` + `.main-content` into `document.body` without `aria-hidden`/`inert`, exposing a full duplicate app to screen readers and the tab order.

**Fix:** strip ids from clones (`clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'))`) and mark cube faces `aria-hidden="true" inert`.

### 7. Landscape swipe-to-change-city steals the hourly scroller
`js/ui.js:3326-3338`

`bindCitySwipe` gates on "is the pointer above `#graph-container`". In the two-column layout (`style.css:1568, 1681`) `.hourly-scroll` sits in the right column at grid-row 1, geometrically *above* the graph in the left column — so a horizontal drag meant to scroll the timeline changes city instead. `_bindContextMenu`'s exclusion list (line 401) already lists `.hourly-scroll`; `bindCitySwipe` was never updated to match.

**Fix:** `if (e.target.closest('.hourly-scroll, .daily-list, .graph-container')) return;`

### 8. Graph precip fallback ignores snow
`js/ui.js:3484` — `(p && p.rain && p.rain['3h']) ? p.rain['3h'] / 3 : 0`

`dayTotals` (1647) and `currentPrecipMM` (978) both count `snow['3h']`; this one doesn't. When the Open-Meteo hourly series fails (`app.js:239` catches to `hourly: []`), a snowstorm renders a flat graph with zero bars while the Precipitation stat above shows a real number.

**Fix:** `const r = p?.rain?.['3h'] || 0, s = p?.snow?.['3h'] || 0; return (r + s) / 3;`

### 9. Interactive tiles are keyboard-inaccessible
`js/ui.js:2357, 2373, 2410`

`.hourly-tile`, the Now tile, and `.daily-item` are bare `<div>`s with click listeners — no `role="button"`, no `tabindex`, no key handling. The entire day-selection / hour-pinning UI is unreachable by keyboard. Separately, `#save-btn`'s `aria-label` is hardcoded `"Save Location"` (line 1534) even in the state where it *removes* the location.

### 10. `user-scalable=no` disables pinch-zoom
`index.html:5` — fails WCAG 1.4.4 / 1.4.10. Drop `user-scalable=no` and `maximum-scale=1.0`.

### 11. Cache-bust versions have drifted
`sw.js:6` `CACHE_NAME = 'weatherdaddy-v178'` vs `index.html:120, 671-675` `?v=155`

`sw.js`'s own header comment says both must be bumped together. Because `cacheKey()` strips the query string, the `?v=` scheme is currently doing nothing — only a `CACHE_NAME` bump actually forces installed clients to refetch. Either resync them or drop `?v=` as redundant.

---

## Low

| # | Location | Issue |
|---|---|---|
| 12 | `js/ui.js:1503` | `href="${this.esc(a.url)}"` — `esc` doesn't block `javascript:`/`data:`. Source is api.weather.gov so not exploitable today; add `/^https?:\/\//i.test(url)` as defense-in-depth. |
| 13 | `js/ui.js:1958` | `rotate(${activeDay.wind.deg}deg)` interpolated into a `style` attribute with only a `!= null` check. Use `Number.isFinite()`. |
| 14 | `js/ui.js:1074` | Dew point: `Math.log(humidity / 100)` → `NaN°` when humidity is 0 or null (`weather.js:216` yields null when missing). |
| 15 | `js/ui.js:2375` | `h.weather[0].icon` unguarded, while the Now tile at 2352 does guard. Throws on a malformed synthesised slot. |
| 16 | `js/ui.js:993-1004` | Tide height unit keys off the **precipitation** setting (mm/in) rather than `dist`. |
| 17 | `js/ui.js:976-984` | `currentPrecipMM` contradicts its comment (returns `0`, not `null`, on miss) and mixes a 1h accumulation with an mm/h rate. Appears to have no callers — likely dead code. |
| 18 | `js/ui.js:20-25` vs `1299` | `FULL_MOON_REF_MS` and `moonPhaseName`'s epoch disagree by ~8 h despite the comment claiming they match. Derive one from the other. |
| 19 | `js/ui.js:215-218` | Segmented control uses `e.target.parentElement` / `e.target.getAttribute('data-value')`. Adding an icon `<span>` to any button would persist `units[null] = null`. Use `e.target.closest('button')`. |
| 20 | `js/ui.js:3654, 3744` | Drag-reorder captures `getBoundingClientRect()` once at drag start but compares against live `clientY` — scrolling mid-drag makes every drop target wrong. |
| 21 | `js/ui.js:3490-3509` | Graph interpolator hardcodes 3-hour spacing and positions x by array index; the OWM/Open-Meteo top-up merge (1619-1624) can produce 2-hour-spaced slots, so the x-axis stops mapping linearly to time. |
| 22 | `js/ui.js:2499, 2625, 2757, 3660` | `parseInt()` without a radix. |
| 23 | `js/ui.js:373` | `_bindAccordions` dereferences `.accordion-header` / `.accordion-content` with no null guard; one malformed item kills the whole binding loop. |
| 24 | `js/ui.js:3630-3649` vs `3727-3733` | Two contradictory doc blocks over `_bindCardInteractions`; both disagree with the code (`touch-action: none`, 350 ms, not 1 s). |
| 25 | `js/weather.js:3-6, 66` | Comments reference `functions/api/owm/[[path]].js`, which no longer exists — the proxy is `_worker.js` (advanced mode). |
| 26 | `manifest.json:5` | `"id": "/weatherdaddy/"` doesn't match `start_url`/`scope` of `"./"` — orphan from an earlier subpath deploy. Set to `"./"`. |
| 27 | `index.html:114, 118` | `og:image` / `twitter:image` are root-relative; most scrapers won't resolve them. Needs the absolute production URL. |
| 28 | `sw.js:209` | `pruneWeatherCache` does a `cache.match()` per entry (up to 80) on *every* successful weather fetch — ~5 fetches per city load. Prune on a timer or every Nth write. |
| 29 | `css/style.css:1548, 1672` | Landscape media queries leave a gap: height ≥ 501px and width < 900px falls through to the single-column layout. |
| 30 | assets | `assets/icon.png`, `app-icon.png`, `icon-192.png`, `icon-512.png`, `icons/icon-{16,32,48,1024}.png` are referenced by nothing — dead weight in the bundle. |

---

## Notes on `_worker.js`

The path allowlist is good. Two things worth a decision rather than a fix:

- **`Access-Control-Allow-Origin: *`** means any third-party page can call your proxy and burn your OWM quota against the allowlisted endpoints. The allowlist caps the blast radius (no paid endpoints), but consider an `Origin` check or a rate limit.
- **`?appid=` passthrough** (line 75) is dead in practice — the client's BYOK path goes direct to OWM (`weather.js:48`) and never routes through the proxy. It's harmless, but it's also an unused code path an attacker could probe.

Also: `Cache-Control: public, max-age=60` is applied to upstream **error** responses too, so a transient upstream 401/404 gets cached at the edge for a minute.
