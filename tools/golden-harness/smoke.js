// Headless-Chrome smoke test against `wrangler pages dev` on :8788.
const puppeteer = require('puppeteer');
const path = require('path');
const OUT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const boxOf = async (page, sel) => {
  await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), sel);
  await sleep(300);
  return (await page.$(sel)).boundingBox();
};

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const problems = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', r => problems.push('requestfailed: ' + r.url() + ' ' + (r.failure() && r.failure().errorText)));
  page.on('response', r => { if (r.status() >= 400) problems.push(`http ${r.status()} ${r.url()}`); });

  await page.evaluateOnNewDocument(() => {
    if (!localStorage.getItem('__seeded')) {
      localStorage.setItem('weather_loc', JSON.stringify({ lat: 40.7128, lon: -74.006, name: 'New York, New York' }));
      localStorage.setItem('weather_list', JSON.stringify([
        { lat: 40.7128, lon: -74.006, name: 'New York, New York' },
        { lat: 34.0522, lon: -118.2437, name: 'Los Angeles, California' },
        { lat: 51.5074, lon: -0.1278, name: 'London, GB' }
      ]));
      localStorage.setItem('weather_seeded', 'true');
      localStorage.setItem('weather_units', JSON.stringify({ temp: 'F', wind: 'mph', pressure: 'inhg', precip: 'in', dist: 'mi', time: '12h' }));
      localStorage.setItem('__seeded', '1');
    }
  });

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:8788/', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.hero-section', { timeout: 60000 });
  await sleep(1500);

  const summary = await page.evaluate(() => ({
    city: document.getElementById('location-name').textContent,
    heroWhen: document.querySelector('.hero-when').textContent,
    heroTemp: document.querySelector('.hero-temp-large').textContent,
    desc: document.querySelector('.hero-desc').textContent,
    stats: [...document.querySelectorAll('#stats-pager .stat-label')].map(e => e.textContent.trim()).filter(Boolean),
    pages: UI._statsPages.length,
    tiles: document.querySelectorAll('.hourly-tile').length,
    rows: document.querySelectorAll('.daily-item').length,
    graph: !!document.querySelector('#graph-container svg.graph-svg'),
    graphCycle: UI._graphCycle,
    fx: document.getElementById('weather-fx').className,
    alertHidden: document.getElementById('alert-bar').hidden,
    discHidden: document.getElementById('discussion-bar').hidden,
    tz: App.state.tzName,
    build: App.BUILD,
    files: [...document.scripts].map(s => s.src.split('/').pop()).filter(Boolean)
  }));
  console.log('LOADED', JSON.stringify(summary, null, 1));
  await page.screenshot({ path: path.join(OUT, 'smoke-portrait.png') });

  // Daily row tap → cube → new day
  await page.click('.daily-item[data-index="3"]');
  await sleep(1100);
  const afterRow = await page.evaluate(() => ({ day: App.state.selectedDayIndex, when: document.querySelector('.hero-when').textContent, cubeLeft: !!document.querySelector('.cube-perspective'), ghosts: document.querySelectorAll('.day-slide-ghost').length, graph: !!document.querySelector('#graph-container svg') }));
  console.log('ROW3', JSON.stringify(afterRow));

  // Hourly tile tap → pinned hour
  await page.click('.hourly-tile[data-dt]');
  await sleep(700);
  const afterTile = await page.evaluate(() => ({ day: App.state.selectedDayIndex, hour: App.state.selectedHourDt, when: document.querySelector('.hero-when').textContent, marker: !!document.querySelector('.graph-position-line.pinned') }));
  console.log('TILE', JSON.stringify(afterTile));

  // Now tile → back to right now
  await page.click('.hourly-tile[data-now]');
  await sleep(700);
  console.log('NOW', JSON.stringify(await page.evaluate(() => ({ day: App.state.selectedDayIndex, hour: App.state.selectedHourDt, when: document.querySelector('.hero-when').textContent }))));

  // Stats paging via arrow + swipe
  const pagedArrow = await page.evaluate(async () => {
    const b = document.querySelector('.stats-page-arrow.next'); if (!b) return 'no arrows';
    const before = UI._statsPageIdx; b.click(); await new Promise(r => setTimeout(r, 1000)); return { before, after: UI._statsPageIdx };
  });
  console.log('STATS ARROW', JSON.stringify(pagedArrow));
  const pager = await page.$('.stats-pager');
  if (pager) {
    const box = await boxOf(page, '.stats-pager');
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await sleep(1000);
    console.log('STATS SWIPE', JSON.stringify(await page.evaluate(() => UI._statsPageIdx)));
  }

  // Graph mode toggle via dblclick on the graph
  const gb = await boxOf(page, '#graph-container');
  await page.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2, { clickCount: 2 });
  await sleep(1000);
  console.log('GRAPH MODE', JSON.stringify(await page.evaluate(() => ({ mode: UI._graphMode, stored: localStorage.getItem('graph_mode'), label: document.querySelector('.graph-series-label') && document.querySelector('.graph-series-label').textContent }))));
  await page.mouse.click(gb.x + gb.width / 2, gb.y + gb.height / 2, { clickCount: 2 });
  await sleep(1000);

  // Graph swipe → next day
  const gb2 = await boxOf(page, '#graph-container');
  await page.mouse.move(gb2.x + gb2.width * 0.8, gb2.y + gb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb2.x + gb2.width * 0.2, gb2.y + gb2.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(1100);
  console.log('GRAPH SWIPE', JSON.stringify(await page.evaluate(() => ({ day: App.state.selectedDayIndex, when: document.querySelector('.hero-when').textContent }))));

  // City swipe on the hero → cube → next city
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
  const hb = await (await page.$('.hero-section')).boundingBox();
  await page.mouse.move(hb.x + hb.width * 0.8, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width * 0.2, hb.y + hb.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(400);
  const midCube = await page.evaluate(() => ({ cube: !!document.querySelector('#weather-view .cube-perspective'), animating: UI._cubeAnimating }));
  await sleep(2500);
  console.log('CITY SWIPE', JSON.stringify({ midCube, after: await page.evaluate(() => ({ city: document.getElementById('location-name').textContent, cube: !!document.querySelector('.cube-perspective'), views: document.querySelectorAll('#weather-view > .dashboard-left').length, animating: UI._cubeAnimating })) }));
  await page.waitForFunction(() => !document.querySelector('.loader'), { timeout: 30000 }).catch(() => {});
  await sleep(500);

  // Menu → Locations → back (overlay cube)
  await page.click('#menu-btn'); await sleep(300);
  await page.click('#goto-locations-btn'); await sleep(300);
  const locs = await page.evaluate(() => ({ open: document.getElementById('locations-screen').classList.contains('open'), cards: document.querySelectorAll('.location-card').length }));
  await page.click('#locations-back-btn'); await sleep(1000);
  console.log('LOCATIONS', JSON.stringify({ ...locs, closed: await page.evaluate(() => !document.getElementById('locations-screen').classList.contains('open') && !document.querySelector('.cube-perspective')) }));

  // About → build readout
  await page.click('#menu-btn'); await sleep(300);
  await page.click('#goto-about-btn'); await sleep(1200);
  console.log('ABOUT', JSON.stringify(await page.evaluate(() => ({ chip: document.querySelector('.about-version').textContent, build: document.getElementById('about-build').textContent, sw: !!navigator.serviceWorker.controller }))));
  await page.click('#about-back-btn'); await sleep(1000);

  // Landscape
  await page.setViewport({ width: 900, height: 480, deviceScaleFactor: 1 });
  await sleep(800);
  console.log('LANDSCAPE', JSON.stringify(await page.evaluate(() => ({ grid: getComputedStyle(document.getElementById('weather-view')).display, graph: !!document.querySelector('#graph-container svg') }))));
  await page.screenshot({ path: path.join(OUT, 'smoke-landscape.png') });
  // landscape city swipe → dual cube
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(300);
  const hb2 = await (await page.$('.hero-section')).boundingBox();
  await page.mouse.move(hb2.x + hb2.width * 0.8, hb2.y + hb2.height / 2); await page.mouse.down();
  await page.mouse.move(hb2.x + hb2.width * 0.2, hb2.y + hb2.height / 2, { steps: 8 }); await page.mouse.up();
  await sleep(400);
  const dual = await page.evaluate(() => document.querySelectorAll('#weather-view .cube-perspective').length);
  await sleep(2500);
  console.log('LANDSCAPE SWIPE', JSON.stringify({ cubesMidSpin: dual, after: await page.evaluate(() => ({ city: document.getElementById('location-name').textContent, cols: document.querySelectorAll('#weather-view > .dashboard-left, #weather-view > .dashboard-right').length, cube: !!document.querySelector('.cube-perspective') })) }));

  console.log('PROBLEMS', JSON.stringify(problems.filter(p => !/favicon|Download the React DevTools|beforeinstallprompt/.test(p)), null, 1));
  await browser.close();
})().catch(e => { console.error('SMOKE FAILED', e); process.exit(1); });
