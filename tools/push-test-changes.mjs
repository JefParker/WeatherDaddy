// Sends a one-off "forecast changed" push to every remote subscriber
// with the feature on, built the way the cron builds it: the live
// forecast for the row's city diffed against a made-up "this morning"
// snapshot that was 12° warmer and called for rain, so every line fires.
// Needs VAPID_PRIVATE_KEY in .dev.vars and a wrangler login with D1 access.
//
//     node tools/push-test-changes.mjs

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fetchForecast, forecastKey } from '../worker/briefing.js';
import { evaluateChanges, composeChanges } from '../worker/changes.js';
import { sendPush } from '../worker/webpush.js';

const root = new URL('..', import.meta.url).pathname;
const vars = Object.fromEntries(readFileSync(`${root}.dev.vars`, 'utf8').split('\n').filter(l => l.includes('='))
  .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
const cfg = JSON.parse(readFileSync(`${root}wrangler.jsonc`, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const vapid = { publicKey: cfg.vars.VAPID_PUBLIC_KEY, privateKey: vars.VAPID_PRIVATE_KEY, subject: cfg.vars.VAPID_SUBJECT };

const out = execFileSync('npx', ['wrangler', 'd1', 'execute', cfg.d1_databases[0].database_name, '--remote', '--json',
  '--command', 'SELECT * FROM push_subscriptions WHERE changes = 1'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const rows = JSON.parse(out.slice(out.indexOf('[')))[0].results;
console.log(`${rows.length} subscriber(s) with forecast changes on`);

const nowSec = Date.now() / 1000;
for (const row of rows) {
  const units = { temp: row.temp_unit, wind: row.wind_unit, precip: row.precip_unit };
  const f = await fetchForecast(row.lat, row.lon, units);
  const tomorrow = f.daily.time[1];
  const real = { hi: f.daily.temperature_2m_max[1], lo: f.daily.temperature_2m_min[1] };
  // Stamped like a real snapshot (worker/changes.js), or the look would
  // treat it as one taken for another place and store rather than compare.
  const test = { ...row, changes_snapshot: JSON.stringify({ at: nowSec - 6 * 3600, key: forecastKey(row.lat, row.lon, units), days: { [tomorrow]: { hi: real.hi + 12, lo: real.lo + 9, pop: 75, snow: 0 } } }) };
  const result = evaluateChanges(test, f, { key: 'test', target: 'tomorrow' }, nowSec);
  const payload = composeChanges(row, result);
  payload.title = `TEST · ${payload.title}`;
  const r = await sendPush(row, payload, vapid, { ttl: 300, urgency: 'high', topic: 'changes-test' });
  console.log(`${row.city_name} (${row.endpoint.slice(-8)}): ${r.ok ? 'sent' : `failed ${r.status} ${r.error || ''}`}`);
  console.log('  ' + payload.title + '\n  ' + payload.body.replace(/\n/g, '\n  '));
}
