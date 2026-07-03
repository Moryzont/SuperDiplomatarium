/**
 * End-to-end tests for the v3 map (kart.html on data/v3/map.json).
 * Usage: node tests/test-map-v3.mjs [baseUrl]
 */
import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.argv[2] || 'http://localhost:8731/SuperDiplomatarium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !/favicon/.test(msg.location()?.url || '')) {
      consoleErrors.push(`${msg.text()} [${msg.location()?.url || ''}]`);
    }
  });
  page.on('pageerror', err => consoleErrors.push(String(err)));
  page.on('response', res => {
    if (res.status() >= 400 && !/favicon/.test(res.url())) failedRequests.push(`${res.status()} ${res.url()}`);
  });

  let bytes = 0;
  page.on('response', async res => { try { bytes += (await res.buffer()).length; } catch { /* */ } });

  try {
    console.log(`Testing ${BASE_URL}/kart/`);
    const t0 = Date.now();
    await page.goto(`${BASE_URL}/kart/`, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('\n[load]');
    const countText = await page.waitForFunction(
      () => /\d+ brev/.test(document.getElementById('selection-count')?.textContent || '')
        && document.getElementById('selection-count').textContent,
      { timeout: 30000 }
    ).then(h => h.jsonValue());
    console.log(`  loaded in ${Date.now() - t0} ms, ~${(bytes / 1e6).toFixed(1)} MB transferred (uncompressed)`);
    // Geo count grows with every geocoding session — assert against the
    // build's own map.json instead of a pinned number.
    const mapN = JSON.parse(fs.readFileSync(new URL('../data/v3/map.json', import.meta.url))).n;
    check('all geo letters load', new RegExp(`${mapN} brev`).test(countText), countText);

    const markerCount = await page.evaluate(() => window.__SD_MAP.letters().length);
    check('letters in memory', markerCount === mapN, `${markerCount} vs map.json n=${mapN}`);

    const clusters = await page.$$eval('.marker-cluster', els => els.length);
    check('clusters rendered', clusters > 0, String(clusters));

    console.log('\n[area selection — central Trondheim]');
    await page.evaluate(() => {
      window.__SD_MAP.selectByBounds(L.latLngBounds([[63.40, 10.30], [63.50, 10.50]]));
    });
    await sleep(500);
    const selCount = await page.evaluate(() => window.__SD_MAP.selection().length);
    check('selection finds letters', selCount > 100, String(selCount));
    const items = await page.$$eval('.letter-item', els => els.length);
    check('selection list renders', items === selCount, `${items} vs ${selCount}`);

    console.log('\n[detail expansion loads full record]');
    await page.click('.letter-item .toggle-details');
    await sleep(2500);
    const detail = await page.$eval('.letter-item .detail-summary', el => el.textContent);
    check('summary loaded on demand', detail.length > 20 && !/Laster/.test(detail), detail.slice(0, 60));

    console.log('\n[popup]');
    const popupOk = await page.evaluate(async () => {
      window.__SD_MAP.openPopup(0);
      // zoomToShowLayer animates; poll for popup + async summary fill
      for (let t = 0; t < 40; t++) {
        await new Promise(r => setTimeout(r, 250));
        const popup = document.querySelector('.leaflet-popup-content');
        if (popup && popup.querySelector('.popup-summary')) return popup.textContent.slice(0, 80);
      }
      const popup = document.querySelector('.leaflet-popup-content');
      return popup ? `no-summary: ${popup.textContent.slice(0, 60)}` : 'no-popup';
    });
    check('popup opens and loads summary', typeof popupOk === 'string' && popupOk.length > 20 && !/^no-/.test(popupOk), popupOk);

    console.log('\n[popup -> full letter card]');
    await page.click('.popup-show-letter');
    await sleep(2500);
    const cardCount = await page.$$eval('#selected-letters .letter-item', els => els.length);
    check('letter card shown below map', cardCount === 1, String(cardCount));
    const cardDetail = await page.$eval('#selected-letters .detail-summary', el => el.textContent).catch(() => '');
    check('card details auto-expanded', cardDetail.length > 20 && !/Laster/.test(cardDetail), cardDetail.slice(0, 60));

    console.log('\n[errors]');
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('no failed requests', failedRequests.length === 0, failedRequests.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
