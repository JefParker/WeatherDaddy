# Golden-master harness

Renders the real app (index.html + the real scripts, loaded in the order
index.html lists them) inside jsdom against deterministic synthetic
weather payloads, and snapshots the resulting DOM, stats pages, graph
options, share URLs, cache writes and interaction outcomes. 315 captures
across 7 cities/times × units × graph modes × selections, plus simulated
swipes, the element-cube fallback path and a fake-network run through
fetchAndDisplay / refreshCurrentWeather / _prefetchCity.

Dev-only. jsdom is the only dependency; nothing here ships.

    cd tools/golden-harness
    npm install
    npm run check            # compare against golden/*.json (exit 1 on drift)
    npm run record           # accept the current output as the new golden

`WD_ROOT=/path/to/checkout node run.js --check` points it at another
checkout (e.g. a git worktree of an older commit) — that's how the
refactor baseline was recorded.

The goldens in golden/ were recorded from commit 41c7d0a (Phase A of the
structural refactor) and every later phase matched them byte-for-byte.
Re-record deliberately whenever a rendering change is intentional.

## Real-browser smoke test

`smoke.js` drives headless Chrome against a local `wrangler pages dev .`
(port 8788, which needs `.dev.vars` with OPENWEATHER_API_KEY): loads the
app with three seeded cities, then taps a daily row, pins an hourly tile,
pages the stats (arrow + swipe), double-taps the graph, swipes the graph,
swipes cities (portrait single cube and landscape dual cube), opens and
cube-closes the Locations overlay, and reads the About build line. Fails
on any console error, page error, failed request or 4xx/5xx.

    npx wrangler pages dev . --port 8788 &        # from the repo root
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable npm run smoke
