// NOAA CO-OPS tide-prediction stations — GENERATED FILE, DO NOT HAND-EDIT.
//
// Regenerate with:
//     ./tools/gen-tide-stations.sh
//
// Format is [id, name, lat, lon], deliberately positional rather than
// keyed: at ~3,300 stations, object keys would roughly triple the file
// size for no benefit, and this list is only ever read by
// WeatherAPI.nearestTideStation(). Same reasoning as the bundled
// cities15000 dictionary in cities.js.
//
// Why bundled instead of fetched: NOAA has no radius-search endpoint, so
// the alternative is downloading the entire ~2MB station catalogue at
// runtime. Bundling keeps tides working offline and costs nothing per
// launch. The catalogue changes rarely — regenerate if a coastal spot
// starts falling back to the Open-Meteo model unexpectedly.
//
// An EMPTY list is a valid state: WeatherAPI.getNoaaTides() returns null
// and everything falls back to Open-Meteo's global marine model, exactly
// as it did before NOAA was added. Nothing breaks; US tide times are just
// less accurate until this is generated.
const TIDE_STATIONS = [];
