# Spec — wind mode on the temperature graph

Hand this to Claude Code alongside `CODE_REVIEW.md`. Self-contained; read it fully before writing code.

## Goal

Add a second display mode to the day graph. The y-axis gutter becomes a tap target that toggles the bar series between **precipitation** (current behaviour, unchanged) and **sustained wind speed**. The temperature line, gradient, badges and time labels are identical in both modes — only the bars and the axis label change.

Scope: sustained wind speed only. No gusts, no direction. Don't add either without asking.

---

## 1. The data is already in hand — do not add an API call

`renderGraph(hourlyData, tz = 0, hourlyPrecip = [])` at `ui.js:3676` is called from `ui.js:2756` as:

```js
this.renderGraph(activeDay.hourly, tz, state.omHourly || []);
```

That third argument is **misnamed**. It isn't a precip series — it's the full Open-Meteo hourly array from `weather.js:212-224`, where each entry already carries `windSpeed` (m/s, because the request sets `windspeed_unit=ms` at `weather.js:205`) alongside `precipMM`.

So: **rename the parameter to `omHourly`** (and the `_lastGraph.hourlyPrecip` key at `ui.js:242` to match), then build a `windByHour` Map next to the existing `precipByHour` from the same array. No signature change, no new fetch, no cache-shape change.

**Fallback when Open-Meteo is unavailable.** `app.js:239` catches enrichment failures to `hourly: []`. Mirror the `fallback3hPerHour` pattern (`ui.js:3694-3697`) with a `fallback3hWind(p) => p?.wind?.speed`, reading OWM's 3h slots — also m/s, since `weather.js:189` requests `units: 'metric'`.

**One important difference from precip:** precip falls back to `0`. Wind must **not**. `0 m/s` is real data (dead calm) and is visually indistinguishable from "no data" if you conflate them. Missing wind should be `null` and render as no bar; a genuine `0` should also render as no bar but must still count as a real sample for the "is there any data at all" check below.

---

## 2. Mode state — must live outside the DOM

`renderGraph` replaces `container.innerHTML` wholesale (`ui.js:3770`), and `runElementCubeTransition` swaps in **innerHTML snapshot strings** (`ui.js:3390`, see the comment at 3397: *"pure SVG markup, no event listeners to preserve"*). Anything stored in the graph's DOM or bound to its children is destroyed on every day change.

- `UI._graphMode` — `'precip' | 'wind'`, default `'precip'`.
- Persist through `Storage`: add `getGraphMode()` / `setGraphMode(mode)` following the `getCustomApiKey` pattern at `storage.js:67-81` (try/catch, validate against the two allowed values, fall back to `'precip'` on anything unexpected). It should survive a reload.
- Mode is **global, not per-day and not per-city.** It must persist across day swipes, city swipes and the `_lastGraph` resize re-render at `ui.js:239-243`.

---

## 3. The tap target

### The trap

The y-axis labels at `ui.js:3787-3802` are rendered **only `if (hasRain)`**. On a dry day in precip mode there is nothing in the gutter — so there'd be no way to reach wind mode on exactly the days you'd most want it. This is the single most important thing to get right.

### Required

Emit a persistent hit area on **every** render, in both modes, regardless of `hasRain`:

- A `<rect class="graph-mode-toggle">` spanning the left gutter (`x=0` to `paddingX`, full height), `fill="transparent"`, `pointer-events: all`.
- `role="button"`, `tabindex="0"`, and an `aria-label` that states the current mode and the action, e.g. `"Showing precipitation. Activate to show wind speed."`
- Axis text drawn *after* the rect so it sits on top.
- `:focus-visible` outline matching the tile treatment Phase 2 added at `style.css:2405`.

Also render the gutter unit label in **both** modes at all times — in precip mode on a dry day it shows just the unit (`mm/h`) with no peak figure. Without a visible label the toggle is undiscoverable.

### Binding — use delegation, not a direct listener

Binding inside `renderGraph` after the innerHTML assignment is **not sufficient**. Trace a day swipe: `changeDayWithGraphCube` (`ui.js:3368`) captures `oldGraphHTML`, calls `onDayClick` which triggers a full re-render (binding a fresh listener), then `runElementCubeTransition` overwrites `innerHTML` with snapshot strings — orphaning that listener. The toggle would work until the first day swipe, then silently die.

Delegate once from `this.weatherView` behind a `_graphToggleBound` guard, following the `_resizeBound` pattern at `ui.js:237-246`. Match on `e.target.closest('.graph-mode-toggle')` — **not** on `#graph-container`, because Phase 2's fix strips ids from cube clone faces, so an id selector won't match during a transition.

Handle `click` plus Enter/Space. `_bindActivate` at `ui.js:1591` already does exactly this pairing — reuse it rather than hand-rolling the keydown check.

### Gesture conflict — verify, don't assume

`_bindGraphSwipe` (`ui.js:3610`) binds pointerdown/move/up on `#graph-container`, which contains the toggle. Reading it, a clean tap should be safe: `finish` returns early at line 3649 `if (!peeking)`, and `peeking` requires >10px of horizontal travel (line 3632). Confirm this holds in practice on touch, where a "tap" often carries a few px of drift. If a slow tap does trigger a day change, the fix is to let the toggle handler call `e.stopPropagation()` on pointerdown — do **not** raise the `peeking` threshold, which would make day swipes feel sluggish.

---

## 4. Scale and axis label

- Keep everything in **m/s internally**; convert only at label time. This mirrors how precip stores mm/h and converts at `ui.js:3791-3796`.
- `maxWind = Math.max(peakWind, FLOOR)` with `FLOOR = 5` m/s (≈11 mph). Without a floor, a dead-calm day amplifies noise into a dramatic-looking chart.
- Axis label uses `Storage.getUnits().wind` with the same factors as `formatWind` (`ui.js:1025-1030`): `2.237` mph, `3.6` km/h, `1` m/s.
- **Don't call `formatWind` directly for the axis** — it appends the unit string and fixes one decimal, but the gutter wants a bare number on one line and the unit on the next (the two-line pattern at `ui.js:3798-3799`). Extract a `_windToDisplay(ms) → { value, unit }` helper and refactor `formatWind` to use it, so there is one conversion table rather than two that can drift.
- The label must react to a wind-unit change. Verify the units-change path re-renders the graph — `ui.js:231` calls `onUnitChange`, which reaches `App.handleUnitChange` → `renderAll`. Confirm that actually repaints the graph in both modes.

---

## 5. Rendering the bars

Reuse the precip bar geometry at `ui.js:3804-3807` exactly — same `barWidth` (3762), same baseline, same `y`/`height` math against `maxWind`. The only differences:

- class `graph-wind-bar` instead of `graph-precip-bar`
- skip the rect when the value is `null`/`undefined` (no data), not when it's `0`

**Colour.** `.graph-precip-bar` is teal `#4db6ac` @ 0.6 opacity (`style.css:1262-1265`) and `.graph-y-axis-label` is hardcoded the same teal (`style.css:1278-1282`). Pick a clearly distinct blue for wind — something around `#5c9ce6` — and make the axis label colour follow the active mode rather than staying teal. Two modes that look the same are worse than one mode.

**"No data at all" case.** If every wind sample is null (Open-Meteo down *and* OWM slots lack wind), don't render an empty chart with a misleading axis. Show the temperature line with the gutter reading `—` and an `aria-label` noting wind is unavailable.

---

## 6. Toggle animation

Use `runElementCubeTransition` to flip between modes — it's the established vocabulary for both day changes and the stats pager. Guard it exactly the way `_changeStatsPage` does at `ui.js:2791-2797`: bail on `this._graphCubeAnimating`, and bail on `this._cubeAnimating` (mid city-swipe, the graph is on a cube face).

Re-render after the toggle via the stored `this._lastGraph` args rather than reaching for state — that path already exists for resize.

---

## 7. Prerequisite

**Fix finding #21 first, or in the same change.** `ui.js:3748-3754` positions x by array index assuming uniform 3-hour spacing, but the OWM/Open-Meteo top-up merge can emit 2-hour gaps. The wind series added here inherits the identical skew, so fixing it afterwards means touching this code twice.

---

## 8. Don't

- Don't touch the temperature line, gradient, badges or time labels — identical in both modes.
- Don't change `renderGraph`'s arity (the rename in §1 is a rename, not a signature change).
- Don't add gusts or direction.
- Don't add an API call or change the cached payload shape.

---

## 9. Verification

Bump `CACHE_NAME` (currently `weatherdaddy-v181`, `sw.js:6`) or you'll test stale files.

1. **Toggle survives a day swipe** — switch to wind, swipe to the next day, confirm it's still wind and the bars repaint. This is the delegation trap in §3; a direct listener passes step 1 of nothing and fails here.
2. **Toggle survives a city swipe and a reload.**
3. **Discoverable on a dry day** — find a city with no rain in the forecast, confirm the gutter is tappable in precip mode.
4. **Tap vs. swipe** — tap the gutter on touch; must not change day. Swipe from the gutter; must change day.
5. **Keyboard** — Tab to the toggle, confirm the focus ring is visible, activate with Enter and with Space.
6. **Units** — change wind units in settings while wind mode is showing; axis label updates without a manual re-render.
7. **Calm day** — a city with near-zero wind should show a flat-ish chart against the 5 m/s floor, not a noisy one rescaled to 0.4 m/s.
8. **Open-Meteo down** — block `api.open-meteo.com` in DevTools, load a windy city, confirm the OWM 3h fallback still draws bars.
9. **Mid-transition** — start a city swipe and tap the gutter during the 800ms spin; nothing should happen and nothing should break.

Report anything in §3 or §4 that turns out to be wrong once you're in the code, rather than working around it.
