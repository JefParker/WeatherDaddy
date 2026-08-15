# Handoff prompt for Claude Code

Open a terminal in `~/Documents/WeatherDaddy` and run `claude`. Paste everything below the line.

---

I'm handing you a code review of this project. Read `CODE_REVIEW.md` in the repo root — it lists 30 findings with file:line references, severity, and suggested fixes. I want you to work through all of them.

## Project context

WeatherDaddy is a vanilla-JS PWA weather app (no build step, no framework, no test suite). Structure:

- `index.html` — single page, scripts loaded in order at end of body: `storage.js → location.js → weather.js → ui.js → app.js`
- `js/ui.js` — ~4000 lines, all rendering. Builds HTML via template strings and assigns to `innerHTML`. Owns the cube transitions, graph SVG, unit formatting.
- `js/app.js` — state, orchestration, fetch tokens, city cycling, cache-then-network
- `js/weather.js` — OpenWeatherMap (via proxy or BYOK direct) + Open-Meteo + NWS alerts
- `js/storage.js` — localStorage wrappers, LRU weather cache
- `sw.js` — service worker, cache-first static / network-first API
- `_worker.js` — Cloudflare Pages advanced-mode worker, reverse proxy for OWM

Globals are plain object literals (`UI`, `App`, `Storage`, `WeatherAPI`, `LocationService`). No modules, no bundler. Match the existing style: 2-space indent, template literals, `this.esc()` for anything user- or API-derived that lands in `innerHTML`.

## How I want you to work

Do it in phases, and **stop after each phase** so I can pull the site up and check it. Don't batch all 30 into one commit.

**Phase 1 — the three that matter (findings 1, 2, 3).**

- #1 cube transition duplicating the dashboard. Guard `finish()` on `perspective.isConnected` in both `runCubeTransition` and `_runTwoColumnCubeTransition`, and add a `_cubeAnimating` flag that `App.renderAll()` respects (defer the render until the transition resolves rather than dropping it).
- #2 the DST day-drop. Open-Meteo already returns an IANA zone name — plumb it through `getEnrichment()` and use `Intl.DateTimeFormat(locale, { timeZone })` for day keys and local-time display instead of `new Date((unix + offset) * 1000).getUTC*()`. If the full conversion is too invasive, do the minimum patch first (key Open-Meteo days off their own returned local date) and tell me what's left.
- #3 the duplicated day-key builder in `app.js:_buildDailyData` and `ui.js:renderDashboard`. Extract one shared function both call. This one is a prerequisite for #2 not regressing, so do #3 before or with #2.

**Phase 2 — the rest of the medium findings (4–11).** Mostly independent; batch them.

**Phase 3 — the low table (12–30).** Skip anything that turns out to be a false positive rather than forcing a fix — tell me which and why. #17 (`currentPrecipMM`) and #30 (orphan assets) are deletions; confirm with me before removing.

## Constraints

- **Don't touch `_worker.js`** — the two notes at the bottom of the review are decisions for me, not fixes.
- **Bump `CACHE_NAME` in `sw.js` on every phase** or I'll be testing stale files. Finding #11 is about the `?v=` strings in `index.html` having drifted out of sync — resolve that in Phase 2 and tell me which convention you settled on.
- No new dependencies, no build step, no framework.
- There's no test suite. After each phase, tell me exactly what to click to verify the fix — especially for #1 (needs a city swipe overlapping a refresh) and #2 (needs a city whose forecast window crosses a DST boundary, or a clock override).

## First thing

Read `CODE_REVIEW.md`, then read `js/ui.js` around the cube transition (2786–2960) and the day-building code (1546–1660) before changing anything. If any finding looks wrong to you after reading the actual code, say so instead of implementing a fix for a bug that isn't there.
