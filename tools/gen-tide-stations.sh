#!/usr/bin/env bash
#
# Regenerate js/tide-stations.js from NOAA CO-OPS.
#
# NOAA publishes no radius-search endpoint, so WeatherDaddy bundles the
# station catalogue and finds the nearest one locally. Run this from the
# repo root whenever you want to refresh it — the catalogue changes
# rarely, so in practice that's "if a coastal location unexpectedly falls
# back to the Open-Meteo model".
#
# Requires: curl, jq
#
#     ./tools/gen-tide-stations.sh
#
set -euo pipefail

OUT="js/tide-stations.js"
SRC="https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions"

if [ ! -d js ]; then
  echo "error: run this from the repo root (no ./js directory here)" >&2
  exit 1
fi

command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }

echo "Fetching NOAA station catalogue…" >&2
RAW="$(curl -fsS "$SRC")"

# [id, name, lat, lon] — positional to keep the file small. Stations
# without usable coordinates are dropped rather than shipped as nulls,
# which would poison the nearest-station distance search.
STATIONS="$(printf '%s' "$RAW" | jq -c '
  [ .stations[]
    | select(.lat != null and .lng != null)
    | [ (.id|tostring), (.name|tostring), (.lat|tonumber), (.lng|tonumber) ]
  ]
')"

COUNT="$(printf '%s' "$STATIONS" | jq 'length')"
if [ "$COUNT" -lt 100 ]; then
  echo "error: only $COUNT stations parsed — refusing to overwrite $OUT" >&2
  echo "       (NOAA may have changed the response shape)" >&2
  exit 1
fi

{
  echo "// NOAA CO-OPS tide-prediction stations — GENERATED FILE, DO NOT HAND-EDIT."
  echo "//"
  echo "// Regenerate with:"
  echo "//     ./tools/gen-tide-stations.sh"
  echo "//"
  echo "// Source: $SRC"
  echo "// Generated: $(date -u +%Y-%m-%d) · $COUNT stations"
  echo "//"
  echo "// Format is [id, name, lat, lon], positional to keep the bundle small."
  echo "// Read only by WeatherAPI.nearestTideStation(). An empty list is a valid"
  echo "// state — everything falls back to Open-Meteo's global marine model."
  printf 'const TIDE_STATIONS = %s;\n' "$STATIONS"
} > "$OUT"

echo "Wrote $OUT ($COUNT stations, $(wc -c < "$OUT") bytes)" >&2
echo "Remember to bump CACHE_NAME in sw.js before deploying." >&2
