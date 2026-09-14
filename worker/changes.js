// Forecast changes: twice a day, a note when the forecast has shifted a
// lot since the last look — "Tomorrow's high 62°, was 78° this morning."
//
// The two looks ride the clock ticks the row already has: the briefing
// hour (`hour`) and the threshold hour (`threshold_hour`), which the
// row carries whether or not those features are on. The morning look
// judges today against last night's forecast; the evening look judges
// tomorrow against this morning's. Each look stores what it saw in
// push_subscriptions.changes_snapshot (JSON, keyed by date) for the
// next to compare with, so nothing is fetched or stored beyond the
// forecast call the tick makes anyway and one column on the row.
// changes_last_slot dedupes the half-hourly cron like last_sent_day.

import { localClock } from './briefing.js';

// A snapshot older than this is only replaced, never compared: the
// change since it is not "since this morning" any more.
const MAX_AGE_S = 36 * 3600;

// What counts as a big change, in the row's own units.
function cutoffs(row) {
  return {
    temp: row.temp_unit === 'C' ? 4 : 8,
    // Precipitation: "unlikely" to "likely" or back, with a gap between
    // so a forecast hovering around 50% doesn't fire every look.
    popLow: 30, popHigh: 60,
    snow: row.precip_unit === 'in' ? 1 : 2,
  };
}

// Which look, if any, is due for this row at this local time. The
// evening look wins when both hours are the same.
export function changesSlot(row, clock) {
  let target;
  if (clock.hour === row.threshold_hour) target = 'tomorrow';
  else if (clock.hour === row.hour) target = 'today';
  else return null;
  return { key: `${clock.dateKey}T${String(clock.hour).padStart(2, '0')}`, target };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// The forecast reduced to what the next look compares: one entry per
// daily date.
export function snapshotOf(forecast, nowSec) {
  const d = forecast.daily || {};
  const days = {};
  const times = Array.isArray(d.time) ? d.time : [];
  for (let i = 0; i < times.length; i++) {
    days[times[i]] = {
      hi:   num(d.temperature_2m_max && d.temperature_2m_max[i]),
      lo:   num(d.temperature_2m_min && d.temperature_2m_min[i]),
      pop:  num(d.precipitation_probability_max && d.precipitation_probability_max[i]),
      snow: num(d.snowfall_sum && d.snowfall_sum[i]),
    };
  }
  return { at: Math.round(nowSec), days };
}

function parseSnapshot(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const s = JSON.parse(text);
    return s && typeof s.at === 'number' && s.days && typeof s.days === 'object' ? s : null;
  } catch (_) { return null; }
}

// "this morning" / "last night" / "yesterday afternoon" for the
// snapshot's time, on the device's clock.
export function sinceWord(atSec, tz, nowSec) {
  const then = localClock(tz, new Date(atSec * 1000));
  const now  = localClock(tz, new Date(nowSec * 1000));
  const period = then.hour < 12 ? 'morning' : then.hour < 17 ? 'afternoon' : 'evening';
  if (then.dateKey === now.dateKey) return `this ${period}`;
  return period === 'evening' ? 'last night' : `yesterday ${period}`;
}

// Compare the look's target day against the stored snapshot. Returns
// the lines to send (empty when nothing moved much, or there is nothing
// to compare with yet), the snapshot to store, and the "since" phrase.
export function evaluateChanges(row, forecast, job, nowSec = Date.now() / 1000) {
  const next = snapshotOf(forecast, nowSec);
  const prev = parseSnapshot(row.changes_snapshot);
  const dates = Object.keys(next.days);
  const date = dates[job.target === 'today' ? 0 : 1];
  const now = date && next.days[date];
  const was = prev && nowSec - prev.at <= MAX_AGE_S ? prev.days[date] : null;
  const out = { items: [], snapshot: JSON.stringify(next), since: was ? sinceWord(prev.at, row.tz, nowSec) : '' };
  if (!was || !now) return out;

  const c = cutoffs(row);
  const day = job.target === 'today' ? "Today's" : "Tomorrow's";
  const deg = (t) => `${Math.round(t)}°`;
  if (was.hi != null && now.hi != null && Math.abs(now.hi - was.hi) >= c.temp) {
    out.items.push(`${day} high ${deg(now.hi)}, was ${deg(was.hi)}`);
  }
  if (was.lo != null && now.lo != null && Math.abs(now.lo - was.lo) >= c.temp) {
    out.items.push(`${day} low ${deg(now.lo)}, was ${deg(was.lo)}`);
  }
  if (was.pop != null && now.pop != null) {
    const what = (now.snow || 0) > 0 || (was.snow || 0) > 0 ? 'snow' : 'rain';
    if ((was.pop <= c.popLow && now.pop >= c.popHigh) || (was.pop >= c.popHigh && now.pop <= c.popLow)) {
      out.items.push(`${what === 'snow' ? 'Snow' : 'Rain'} chance ${Math.round(now.pop)}%, was ${Math.round(was.pop)}%`);
    }
  }
  if (was.snow != null && now.snow != null) {
    const unit = row.precip_unit === 'in' ? 'in' : 'cm';
    const fmt1 = (v) => (Math.round(v * 10) / 10).toString();
    if (was.snow < c.snow && now.snow >= c.snow) out.items.push(`Snow now expected: ${fmt1(now.snow)} ${unit}`);
    else if (was.snow >= c.snow && now.snow < c.snow / 5) out.items.push('Snow no longer expected');
  }
  return out;
}

// The notification, e.g.
//
//   Forecast changed · Denver
//   Tomorrow's high 62°, was 78° this morning.
//   Rain chance 70%, was 10%.
export function composeChanges(row, result, nowMs = Date.now()) {
  const url = new URL('/', 'https://weatherdaddy.app');
  url.searchParams.set('lat', String(row.lat));
  url.searchParams.set('lon', String(row.lon));
  url.searchParams.set('name', row.city_name);
  const lines = result.items.map((t, i) => (i === 0 && result.since ? `${t} ${result.since}.` : `${t}.`));
  return {
    title: `Forecast changed · ${row.city_name}`,
    body: lines.join('\n'),
    url: url.pathname + url.search,
    tag: 'changes',
    timestamp: nowMs,
  };
}
