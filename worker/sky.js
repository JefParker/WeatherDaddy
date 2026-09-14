// Sky events: meteor-shower peaks and eclipses. Like the full moon
// (worker/moon.js), WHEN to send is arithmetic on a static table — no
// API decides it — and the forecast fetch the tick makes anyway
// supplies the cloud cover, so the feature costs the */30 cron nothing
// on the ~350 nights a year with nothing on.
//
// Meteor showers peak on nearly the same calendar night every year (the
// Earth crosses the same debris stream), so the table carries month/day
// of the peak night: the push goes out before sunset that evening and
// points at the small hours after it. Eclipses are listed through 2030
// with the UTC time of greatest eclipse. A lunar eclipse is visible from
// anywhere the Moon is up, which is checked here against that night's
// sunset/sunrise (a full moon is up when the Sun is down). A solar one
// is visible only from a region, which the table gives as a coarse
// lat/lon box — where at least a partial eclipse can be seen — plus a
// sun-up check; the push goes out about two hours before the peak.
// Extend ECLIPSES as 2030 nears.

import { localClock } from './briefing.js';
import { solarTimes, nextDay, clockTime, skyAt, moonIllumination } from './moon.js';

// ZHR is the textbook zenithal hourly rate under a perfectly dark sky
// with the radiant overhead; nobody sees that many, which the wording
// allows for. Peak night = the evening of month/day into the next morning.
export const METEOR_SHOWERS = [
  { key: 'quadrantids',   name: 'Quadrantids',   month: 1,  day: 3,  zhr: 80  },
  { key: 'lyrids',        name: 'Lyrids',        month: 4,  day: 22, zhr: 18  },
  { key: 'eta-aquariids', name: 'Eta Aquariids', month: 5,  day: 5,  zhr: 50  },
  { key: 'perseids',      name: 'Perseids',      month: 8,  day: 12, zhr: 100 },
  { key: 'orionids',      name: 'Orionids',      month: 10, day: 21, zhr: 20  },
  { key: 'leonids',       name: 'Leonids',       month: 11, day: 17, zhr: 15  },
  { key: 'geminids',      name: 'Geminids',      month: 12, day: 13, zhr: 150 },
];

// `max` is greatest eclipse, UTC. Penumbral lunar eclipses are left
// out: nothing to see. For solar eclipses `where` is the path of the
// total/annular phase, `partial` the wider region that sees a partial
// one, and `box` [latMin, latMax, lonMin, lonMax] bounds that region.
export const ECLIPSES = [
  { key: 'lunar-2026-03-03', kind: 'lunar', type: 'total',   max: '2026-03-03T11:34Z' },
  { key: 'lunar-2026-08-28', kind: 'lunar', type: 'partial', max: '2026-08-28T04:13Z' },
  { key: 'lunar-2028-01-12', kind: 'lunar', type: 'partial', max: '2028-01-12T04:13Z' },
  { key: 'lunar-2028-07-06', kind: 'lunar', type: 'partial', max: '2028-07-06T18:20Z' },
  { key: 'lunar-2028-12-31', kind: 'lunar', type: 'total',   max: '2028-12-31T16:52Z' },
  { key: 'lunar-2029-06-26', kind: 'lunar', type: 'total',   max: '2029-06-26T03:22Z' },
  { key: 'lunar-2029-12-20', kind: 'lunar', type: 'total',   max: '2029-12-20T22:42Z' },
  { key: 'lunar-2030-06-15', kind: 'lunar', type: 'partial', max: '2030-06-15T18:33Z' },

  { key: 'solar-2026-08-12', kind: 'solar', type: 'total',   max: '2026-08-12T17:46Z',
    where: 'Greenland, Iceland and northern Spain', partial: 'northern North America, Europe and North Africa', box: [25, 90, -170, 60] },
  { key: 'solar-2027-02-06', kind: 'solar', type: 'annular', max: '2027-02-06T15:59Z',
    where: 'Chile, Argentina and West Africa', partial: 'South America and Africa', box: [-60, 15, -90, 30] },
  { key: 'solar-2027-08-02', kind: 'solar', type: 'total',   max: '2027-08-02T10:07Z',
    where: 'southern Spain, Egypt and the Arabian Peninsula', partial: 'Europe, Africa, the Middle East and India', box: [-35, 70, -30, 90] },
  { key: 'solar-2028-01-26', kind: 'solar', type: 'annular', max: '2028-01-26T15:08Z',
    where: 'Ecuador, Brazil and Spain', partial: 'the Americas, Europe and West Africa', box: [-60, 60, -120, 30] },
  { key: 'solar-2028-07-22', kind: 'solar', type: 'total',   max: '2028-07-22T02:56Z',
    where: 'Australia and New Zealand', partial: 'Australia, New Zealand and Southeast Asia', box: [-60, 10, 90, 180] },
  { key: 'solar-2029-01-14', kind: 'solar', type: 'partial', max: '2029-01-14T17:13Z',
    partial: 'North America', box: [10, 75, -170, -50] },
  { key: 'solar-2029-06-12', kind: 'solar', type: 'partial', max: '2029-06-12T04:06Z',
    partial: 'Alaska, northern Canada and Scandinavia', box: [50, 90, -180, 60] },
  { key: 'solar-2029-07-11', kind: 'solar', type: 'partial', max: '2029-07-11T15:36Z',
    partial: 'southern South America', box: [-60, -15, -90, -40] },
  { key: 'solar-2030-06-01', kind: 'solar', type: 'annular', max: '2030-06-01T06:29Z',
    where: 'North Africa, Greece, Turkey, Russia and Japan', partial: 'Europe, North Africa and Asia', box: [0, 90, -30, 180] },
  { key: 'solar-2030-11-25', kind: 'solar', type: 'total',   max: '2030-11-25T06:51Z',
    where: 'southern Africa and Australia', partial: 'southern Africa, the Indian Ocean and Australia', box: [-60, 10, 0, 180] },
];

// Night-time events send between 75 and 15 minutes before sunset, like
// the full moon: the */30 cron lands in a 60-minute window at least
// once. A solar eclipse sends 150 to 90 minutes before greatest eclipse.
const EVENING_BEFORE_S = 75 * 60;
const EVENING_UNTIL_S  = 15 * 60;
const SOLAR_BEFORE_S   = 150 * 60;
const SOLAR_UNTIL_S    = 90 * 60;
// How far either side of greatest eclipse the Moon must be up for a
// lunar eclipse to count as visible here.
const LUNAR_SLACK_S    = 30 * 60;

const inWindow = (now, at, before, until) => now >= at - before && now <= at - until;
const inBox = (row, [latMin, latMax, lonMin, lonMax]) =>
  row.lat >= latMin && row.lat <= latMax && row.lon >= lonMin && row.lon <= lonMax;
const dayOf = (key) => key.split('-').map(Number);
const prevDay = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d) - 86400000);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};

// Sunset of the local date and sunrise of the morning after: the night
// that starts on that date. null in polar day/night.
function nightOf(y, m, d, row) {
  const tz = row.tz;
  const today = solarTimes(y, m, d, row.lat, row.lon, tz);
  if (!today.sunset) return null;
  const next = solarTimes(...nextDay(y, m, d), row.lat, row.lon, tz);
  return { sunset: today.sunset, sunrise: next.sunrise || today.sunset + 12 * 3600 };
}

// Is there a sky-event push due for this row right now? Returns the
// job (key, what, event, times) or null. Keys are the event's, plus
// the year for a shower, so each fires once per row.
export function skyDue(row, nowSec) {
  const tz = row.tz;
  const [y, m, d] = dayOf(localClock(tz, new Date(nowSec * 1000)).dateKey);

  for (const s of METEOR_SHOWERS) {
    if (s.month !== m || s.day !== d) continue;
    const key = `${s.key}-${y}`;
    if (row.sky_last_key === key) continue;
    const night = nightOf(y, m, d, row);
    if (!night || !inWindow(nowSec, night.sunset, EVENING_BEFORE_S, EVENING_UNTIL_S)) continue;
    // The radiant is highest in the small hours: look two hours before dawn.
    return { key, what: 'meteor', event: s, ...night, best: night.sunrise - 2 * 3600 };
  }

  for (const e of ECLIPSES) {
    if (row.sky_last_key === e.key) continue;
    const max = Date.parse(e.max) / 1000;
    if (Math.abs(max - nowSec) > 36 * 3600) continue;
    if (e.kind === 'solar') {
      if (!inBox(row, e.box)) continue;
      if (!inWindow(nowSec, max, SOLAR_BEFORE_S, SOLAR_UNTIL_S)) continue;
      const [ey, em, ed] = dayOf(localClock(tz, new Date(max * 1000)).dateKey);
      const sun = solarTimes(ey, em, ed, row.lat, row.lon, tz);
      if (!sun.sunrise || !sun.sunset || max < sun.sunrise - LUNAR_SLACK_S || max > sun.sunset + LUNAR_SLACK_S) continue;
      return { key: e.key, what: 'solar', event: e, max };
    }
    // Lunar: the night (this local date's, or the one before) whose
    // dark hours contain greatest eclipse; send before that sunset.
    const [ey, em, ed] = dayOf(localClock(tz, new Date(max * 1000)).dateKey);
    for (const day of [[ey, em, ed], prevDay(ey, em, ed)]) {
      const night = nightOf(...day, row);
      if (!night || max < night.sunset - LUNAR_SLACK_S || max > night.sunrise + LUNAR_SLACK_S) continue;
      if (!inWindow(nowSec, night.sunset, EVENING_BEFORE_S, EVENING_UNTIL_S)) break;
      return { key: e.key, what: 'lunar', event: e, ...night, max, best: max };
    }
  }
  return null;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The notification, e.g.
//
//   Perseids peak tonight
//   Denver · up to 100 meteors an hour under a dark sky
//   Best after midnight, away from city lights. Clear skies expected. Moon 4% lit.
//
//   Total lunar eclipse tonight
//   Denver · greatest at 4:34 AM
//   The Moon turns red for about an hour around then. Partly cloudy.
//
//   Total solar eclipse today
//   Denver · peak around 11:46 AM
//   Total over Greenland, Iceland and northern Spain, partial across northern
//   North America, Europe and North Africa. Eclipse glasses only. Clear skies expected.
export function composeSky(row, job, forecast, nowMs = Date.now()) {
  const tz = (forecast && forecast.timezone) || row.tz;
  const url = new URL('/', 'https://weatherdaddy.app');
  url.searchParams.set('lat', String(row.lat));
  url.searchParams.set('lon', String(row.lon));
  url.searchParams.set('name', row.city_name);
  const e = job.event;
  let title, line1, line2;
  if (job.what === 'meteor') {
    title = `${e.name} peak tonight`;
    line1 = `${row.city_name} · up to ${e.zhr} meteors an hour under a dark sky`;
    line2 = ['Best after midnight, away from city lights.', skyAt(forecast, job.best), `Moon ${Math.round(moonIllumination(job.best) * 100)}% lit.`];
  } else if (job.what === 'lunar') {
    title = `${cap(e.type)} lunar eclipse tonight`;
    line1 = `${row.city_name} · greatest at ${clockTime(job.max, tz, row.time_fmt)}`;
    line2 = [e.type === 'total' ? 'The Moon turns red for about an hour around then.' : "Earth's shadow takes a bite out of the Moon around then.", skyAt(forecast, job.max)];
  } else {
    title = `${cap(e.type)} solar eclipse today`;
    line1 = `${row.city_name} · peak around ${clockTime(job.max, tz, row.time_fmt)}`;
    const extent = e.type === 'partial' ? `Partial across ${e.partial}.` : `${cap(e.type)} over ${e.where}, partial across ${e.partial}.`;
    line2 = [extent, 'Eclipse glasses only.', skyAt(forecast, job.max)];
  }
  return {
    title,
    body: `${line1}\n${line2.filter(Boolean).join(' ')}`,
    url: url.pathname + url.search,
    tag: 'sky',
    timestamp: nowMs,
  };
}
