// Deterministic synthetic weather payloads in the exact shapes the app
// consumes (OWM /weather + /forecast, Open-Meteo enrichment, marine, NOAA
// tide predictions). Seeded PRNG so every run produces identical data.

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Local-hour helper using Intl so fixtures are DST-correct like the app.
function localHour(unixSec, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(unixSec * 1000).find(x => x.type === 'hour');
  return (+p.value) % 24;
}
function localMidnight(unixSec, tz) {
  // walk back to the most recent local 00:00
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  }).formatToParts(unixSec * 1000).reduce((o, p) => (o[p.type] = p.value, o), {});
  const secsIntoDay = (+parts.hour % 24) * 3600 + (+parts.minute) * 60 + (+parts.second);
  return unixSec - secsIntoDay;
}

// weather "profiles" drive icons/codes. Each returns {owmId, icon, desc, wmo, rainMM, snowCM, pop}
function profileAt(kind, hourIdx, rnd, isDay) {
  const dn = isDay ? 'd' : 'n';
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  switch (kind) {
    case 'mixed': {
      const phase = Math.floor(hourIdx / 9) % 6;
      if (phase === 0) return { owmId: 800, icon: '01' + dn, desc: 'clear sky', wmo: 0, rainMM: 0, snowCM: 0, pop: 0 };
      if (phase === 1) return { owmId: 802, icon: '03' + dn, desc: 'scattered clouds', wmo: 2, rainMM: 0, snowCM: 0, pop: 0.05 };
      if (phase === 2) return { owmId: 500, icon: '10' + dn, desc: 'light rain', wmo: 61, rainMM: 0.6 + rnd(), snowCM: 0, pop: 0.6 };
      if (phase === 3) return { owmId: 211, icon: '11' + dn, desc: 'thunderstorm', wmo: 95, rainMM: 3 + rnd() * 4, snowCM: 0, pop: 0.9 };
      if (phase === 4) return { owmId: 804, icon: '04' + dn, desc: 'overcast clouds', wmo: 3, rainMM: 0, snowCM: 0, pop: 0.1 };
      return { owmId: 721, icon: '50' + dn, desc: 'haze', wmo: 45, rainMM: 0, snowCM: 0, pop: 0 };
    }
    case 'snowy': {
      const phase = Math.floor(hourIdx / 12) % 3;
      if (phase === 0) return { owmId: 601, icon: '13' + dn, desc: 'snow', wmo: 73, rainMM: 1.2 + rnd(), snowCM: 1.5 + rnd(), pop: 0.85 };
      if (phase === 1) return { owmId: 803, icon: '04' + dn, desc: 'broken clouds', wmo: 3, rainMM: 0, snowCM: 0, pop: 0.1 };
      return { owmId: 800, icon: '01' + dn, desc: 'clear sky', wmo: 0, rainMM: 0, snowCM: 0, pop: 0 };
    }
    case 'clear':
    default:
      return rnd() < 0.15
        ? { owmId: 801, icon: '02' + dn, desc: 'few clouds', wmo: 1, rainMM: 0, snowCM: 0, pop: 0 }
        : { owmId: 800, icon: '01' + dn, desc: 'clear sky', wmo: 0, rainMM: 0, snowCM: 0, pop: 0 };
  }
}

function buildFixture(opts) {
  const {
    name, lat, lon, tz, offsetSec, nowSec, seed = 1, kind = 'mixed',
    baseTemp = 18, amp = 7, coastal = false, noaa = false,
    peakUv = 6, aqi = 42, pollen = null, enrichment = true, alerts = [],
    discussion = null, tzNameOverride
  } = opts;
  const rnd = mulberry32(seed);
  const todayMidnight = localMidnight(nowSec, tz);
  const startHour = todayMidnight - 86400; // past_days=1
  const HOURS = 9 * 24;

  const tempAt = (t) => {
    const lh = localHour(t, tz);
    const dayIdx = Math.floor((t - todayMidnight) / 86400);
    return baseTemp + dayIdx * 0.4 + amp * Math.sin((lh - 9) / 24 * 2 * Math.PI) + (rnd() - 0.5);
  };
  const isDayAt = (t) => { const h = localHour(t, tz); return h >= 6 && h < 19; };

  // ── Open-Meteo hourly ────────────────────────────────────────────
  const omHourly = [];
  for (let i = 0; i < HOURS; i++) {
    const dt = startHour + i * 3600;
    const p = profileAt(kind, i, rnd, isDayAt(dt));
    const lh = localHour(dt, tz);
    const uv = isDayAt(dt) ? Math.max(0, peakUv * Math.sin((lh - 6) / 13 * Math.PI)) : 0;
    const temp = tempAt(dt);
    omHourly.push({
      dt,
      temp: +temp.toFixed(1),
      feelsLike: +(temp - 1.2).toFixed(1),
      humidity: Math.round(55 + 25 * Math.sin(i / 7)),
      precipMM: +p.rainMM.toFixed(2),
      snowCM: +p.snowCM.toFixed(2),
      precipProb: Math.round(p.pop * 100),
      weatherCode: p.wmo,
      windSpeed: +(3 + 4 * Math.abs(Math.sin(i / 5))).toFixed(1),
      windDir: Math.round((200 + i * 3) % 360),
      windGust: +(6 + 6 * Math.abs(Math.sin(i / 5))).toFixed(1),
      isDay: isDayAt(dt),
      cloudCover: Math.round(40 + 40 * Math.sin(i / 4)),
      visibility: 10000 + (i % 5) * 1000,
      pressureMsl: +(1012 + 6 * Math.sin(i / 20)).toFixed(1),
      uvIndex: +uv.toFixed(2),
      dewPoint: +(temp - 6).toFixed(1)
    });
  }

  // ── Open-Meteo daily (today first) ───────────────────────────────
  const omDaily = [];
  for (let d = 0; d < 8; d++) {
    const dayStart = localMidnight(todayMidnight + d * 86400 + 3600 * 12, tz);
    const slots = omHourly.filter(h => h.dt >= dayStart && h.dt < dayStart + 86400);
    const temps = slots.map(s => s.temp);
    omDaily.push({
      dt: dayStart,
      tempMax: +(Math.max(...temps) + 0.6).toFixed(1),
      tempMin: +(Math.min(...temps) - 0.4).toFixed(1),
      weatherCode: slots[12] ? slots[12].weatherCode : 0,
      precipSum: +slots.reduce((s, h) => s + h.precipMM, 0).toFixed(2),
      sunrise: dayStart + 6 * 3600 + 22 * 60,
      sunset: dayStart + 19 * 3600 + 8 * 60,
      uvIndexMax: +Math.max(...slots.map(s => s.uvIndex)).toFixed(2),
      popMax: Math.max(...slots.map(s => s.precipProb)),
      windMax: +Math.max(...slots.map(s => s.windSpeed)).toFixed(1),
      gustMax: +Math.max(...slots.map(s => s.windGust)).toFixed(1),
      snowSumCM: +slots.reduce((s, h) => s + h.snowCM, 0).toFixed(2),
      sunshineSec: Math.round(slots.filter(s => s.isDay && s.weatherCode <= 1).length * 3600 * 0.9)
    });
  }

  // ── Open-Meteo minutely_15 (next 24h) ────────────────────────────
  const omMinutely = [];
  const m0 = Math.floor(nowSec / 900) * 900;
  for (let i = 0; i < 96; i++) {
    const dt = m0 + i * 900;
    const h = omHourly.find(x => x.dt <= dt && dt < x.dt + 3600);
    omMinutely.push({ dt, precipMM: h ? +(h.precipMM / 4).toFixed(3) : 0 });
  }

  // ── OWM current ──────────────────────────────────────────────────
  const curOm = omHourly.find(h => h.dt <= nowSec && nowSec < h.dt + 3600) || omHourly[24];
  const cp = profileAt(kind, 24 + Math.floor((nowSec - todayMidnight) / 3600), rnd, isDayAt(nowSec));
  const currentWeather = {
    coord: { lat, lon },
    weather: [{ id: cp.owmId, main: cp.desc, description: cp.desc, icon: cp.icon }],
    main: {
      temp: curOm.temp, feels_like: curOm.feelsLike,
      temp_min: curOm.temp - 1, temp_max: curOm.temp + 1,
      pressure: Math.round(curOm.pressureMsl), humidity: curOm.humidity
    },
    visibility: 10000,
    wind: { speed: curOm.windSpeed, deg: curOm.windDir, gust: curOm.windGust },
    clouds: { all: curOm.cloudCover },
    dt: nowSec - 300,
    sys: { country: 'XX', sunrise: omDaily[0].sunrise, sunset: omDaily[0].sunset },
    timezone: offsetSec,
    name: name.split(',')[0]
  };

  // ── OWM 3h forecast: 40 slots from the next 3h boundary ─────────
  const first3h = Math.ceil(nowSec / 10800) * 10800;
  const list = [];
  for (let i = 0; i < 40; i++) {
    const dt = first3h + i * 10800;
    const om = omHourly.find(h => h.dt === dt) || omHourly[omHourly.length - 1];
    const p = profileAt(kind, Math.floor((dt - startHour) / 3600), rnd, isDayAt(dt));
    const slot = {
      dt,
      main: { temp: om.temp, feels_like: om.feelsLike, temp_min: om.temp - 0.5, temp_max: om.temp + 0.5, pressure: Math.round(om.pressureMsl), humidity: om.humidity },
      weather: [{ id: p.owmId, main: p.desc, description: p.desc, icon: p.icon }],
      clouds: { all: om.cloudCover },
      wind: { speed: om.windSpeed, deg: om.windDir, gust: om.windGust },
      visibility: om.visibility,
      pop: p.pop,
      dt_txt: new Date(dt * 1000).toISOString().replace('T', ' ').slice(0, 19)
    };
    if (p.rainMM > 0) slot.rain = { '3h': +(p.rainMM * 3).toFixed(2) };
    if (p.snowCM > 0) slot.snow = { '3h': +(p.snowCM * 3 / 0.7).toFixed(2) };
    list.push(slot);
  }
  const forecast = { cod: '200', cnt: 40, list, city: { name: currentWeather.name, coord: { lat, lon }, timezone: offsetSec, sunrise: omDaily[0].sunrise, sunset: omDaily[0].sunset } };

  // ── Marine (Open-Meteo) ──────────────────────────────────────────
  let tides = null, tideCoords = null, tidePredictions = null;
  if (coastal) {
    const time = [], lvl = [], sst = [];
    for (let i = 0; i < HOURS; i++) {
      const dt = startHour + i * 3600;
      time.push(dt);
      lvl.push(+(1.1 * Math.sin(dt / 3600 / 12.42 * 2 * Math.PI) + 0.3 * Math.sin(dt / 3600 / 24.8 * 2 * Math.PI)).toFixed(3));
      sst.push(+(19 + 0.5 * Math.sin(i / 30)).toFixed(2));
    }
    tides = { time, sea_level_height_msl: lvl, sea_surface_temperature: sst };
    tideCoords = { lat: lat + 0.02, lon: lon - 0.03 };
    if (noaa) {
      const extrema = [];
      // ~6.2h alternating high/low
      let t = startHour + 4000;
      let high = true;
      while (t < startHour + HOURS * 3600) {
        extrema.push({ type: high ? 'High' : 'Low', dt: Math.round(t), h: high ? 1.9 : -1.7 });
        high = !high; t += 6.21 * 3600;
      }
      tidePredictions = {
        station: { id: '8518750', name: 'The Battery', lat, lon, km: 3.2 },
        extrema,
        hourly: { time: [...time], sea_level_height_msl: lvl.map(v => +(v * 1.6).toFixed(3)) }
      };
    }
  }

  const payload = {
    currentWeather,
    forecast,
    uv: { current: enrichment ? curOm.uvIndex : null, daily: enrichment ? omDaily.map(d => d.uvIndexMax) : [] },
    omHourly: enrichment ? omHourly : [],
    omDaily: enrichment ? omDaily : [],
    omMinutely: enrichment ? omMinutely : [],
    tzName: enrichment ? (tzNameOverride !== undefined ? tzNameOverride : tz) : null,
    airQuality: { aqi, aqiPollutant: aqi != null ? 'PM2.5' : null, pollen, treePollen: pollen != null ? pollen * 0.5 : null, grassPollen: pollen != null ? pollen * 0.3 : null, weedPollen: pollen != null ? pollen * 0.2 : null },
    alerts,
    tides,
    tideCoords,
    tidePredictions,
    discussion,
    cityName: name
  };
  return { payload, meta: { lat, lon, tz, nowSec, todayMidnight, first3h, offsetSec } };
}

const SAMPLE_ALERT = {
  id: 'urn:oid:1', event: 'Severe Thunderstorm Warning', headline: 'Severe Thunderstorm Warning issued',
  description: 'At 230 PM, a severe thunderstorm was located near the harbor.\n\n* WHAT...60 mph wind gusts.\n* WHERE...The whole county.',
  instruction: 'Move to an interior room.', severity: 'Severe', urgency: 'Immediate', areaDesc: 'New York County',
  sender: 'NWS New York NY', effective: '2026-09-08T18:30:00Z', expires: '2026-09-08T19:30:00Z', url: 'https://alerts.weather.gov/x'
};
const SAMPLE_AFD = {
  office: 'OKX', issued: '2026-09-08T12:10:00Z',
  text: 'FXUS61 KOKX 081210\nAFDOKX\n\n.SYNOPSIS...\nHigh pressure builds in\nthrough the weekend.\n\n&&\n\n.NEAR TERM /THROUGH TONIGHT/...\nClear skies tonight.\n* Lows in the 60s.\n\n&&\n\n$$\nJP'
};

module.exports = { buildFixture, SAMPLE_ALERT, SAMPLE_AFD };

// ── Fake network ─────────────────────────────────────────────────────
// Answers WeatherAPI's real fetch() URLs with RAW upstream JSON rebuilt
// from a fixture payload, so _fetchCityPayload / _refreshCity / the
// weather.js parsers run for real. Anything unknown → 404.
function rawResponsesFor(payload, meta) {
  const cw = payload.currentWeather;
  const om = payload.omHourly, od = payload.omDaily, mm = payload.omMinutely;
  const col = (arr, k) => arr.map(x => x[k]);
  const gmt = (sec) => { const d = new Date(sec * 1000); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
  const aq = payload.airQuality || {};
  return (url) => {
    const u = new URL(url, 'http://localhost/');
    const host = u.hostname, path = u.pathname;
    if (path === '/api/owm/data/2.5/weather') return [200, cw];
    if (path === '/api/owm/data/2.5/forecast') return [200, payload.forecast];
    if (host === 'api.open-meteo.com') {
      return [200, {
        timezone: payload.tzName || meta.tz,
        current: { uv_index: payload.uv ? payload.uv.current : null },
        hourly: {
          time: col(om, 'dt'), temperature_2m: col(om, 'temp'), apparent_temperature: col(om, 'feelsLike'),
          relative_humidity_2m: col(om, 'humidity'), precipitation: col(om, 'precipMM'), snowfall: col(om, 'snowCM'),
          precipitation_probability: col(om, 'precipProb'), weathercode: col(om, 'weatherCode'), windspeed_10m: col(om, 'windSpeed'),
          winddirection_10m: col(om, 'windDir'), windgusts_10m: col(om, 'windGust'), is_day: om.map(h => h.isDay ? 1 : 0),
          cloud_cover: col(om, 'cloudCover'), visibility: col(om, 'visibility'), pressure_msl: col(om, 'pressureMsl'),
          uv_index: col(om, 'uvIndex'), dew_point_2m: col(om, 'dewPoint')
        },
        daily: {
          time: col(od, 'dt'), uv_index_max: col(od, 'uvIndexMax'), temperature_2m_max: col(od, 'tempMax'), temperature_2m_min: col(od, 'tempMin'),
          weathercode: col(od, 'weatherCode'), precipitation_sum: col(od, 'precipSum'), snowfall_sum: col(od, 'snowSumCM'), sunrise: col(od, 'sunrise'),
          sunset: col(od, 'sunset'), precipitation_probability_max: col(od, 'popMax'), windspeed_10m_max: col(od, 'windMax'),
          windgusts_10m_max: col(od, 'gustMax'), sunshine_duration: col(od, 'sunshineSec')
        },
        minutely_15: { time: col(mm, 'dt'), precipitation: col(mm, 'precipMM') }
      }];
    }
    if (host === 'air-quality-api.open-meteo.com') {
      if (aq.aqi == null && aq.pollen == null) return [200, { current: {} }];
      return [200, { current: {
        us_aqi: aq.aqi, us_aqi_pm2_5: aq.aqi, us_aqi_pm10: aq.aqi != null ? aq.aqi - 5 : null,
        birch_pollen: aq.treePollen, grass_pollen: aq.grassPollen, ragweed_pollen: aq.weedPollen
      } }];
    }
    if (host === 'api.weather.gov' && path.startsWith('/alerts/active')) {
      return [200, { features: (payload.alerts || []).map(a => ({ properties: { ...a, senderName: a.sender, web: a.url } })) }];
    }
    if (host === 'api.weather.gov' && path.startsWith('/points/')) {
      return payload.discussion ? [200, { properties: { cwa: payload.discussion.office } }] : [404, {}];
    }
    if (host === 'api.weather.gov' && path.startsWith('/products/types/AFD/')) {
      return [200, { '@graph': [{ '@id': 'https://api.weather.gov/products/afd-1', issuanceTime: payload.discussion.issued }] }];
    }
    if (host === 'api.weather.gov' && path === '/products/afd-1') {
      return [200, { productText: payload.discussion.text, issuanceTime: payload.discussion.issued }];
    }
    if (host === 'marine-api.open-meteo.com') {
      if (!payload.tides) return [400, { error: true, reason: 'no data' }];
      return [200, { latitude: payload.tideCoords.lat, longitude: payload.tideCoords.lon, hourly: payload.tides }];
    }
    if (host === 'api.tidesandcurrents.noaa.gov') {
      const tp = payload.tidePredictions;
      if (!tp) return [404, {}];
      if (u.searchParams.get('interval') === 'hilo') return [200, { predictions: tp.extrema.map(e => ({ t: gmt(e.dt), v: String(e.h), type: e.type === 'High' ? 'H' : 'L' })) }];
      return [200, { predictions: tp.hourly.time.map((t, i) => ({ t: gmt(t), v: String(tp.hourly.sea_level_height_msl[i]) })) }];
    }
    return [404, { error: 'unmocked ' + url }];
  };
}
module.exports.rawResponsesFor = rawResponsesFor;
