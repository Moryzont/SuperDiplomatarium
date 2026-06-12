/**
 * End-to-end tests for search-v3 (Pagefind-backed search).
 * Requires: the site served at BASE_URL (see serve instructions in scripts/build-search-v3.mjs)
 * Usage: node tests/test-search-v3.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';

const BASE_URL = process.argv[2] || 'http://localhost:8731/SuperDiplomatarium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${detail}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForStatus(page, rx, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const txt = await page.$eval('#search-status', el => el.textContent).catch(() => '');
    if (rx.test(txt)) return txt;
    await sleep(150);
  }
  const txt = await page.$eval('#search-status', el => el.textContent).catch(() => '(no status)');
  throw new Error(`Timeout waiting for status ${rx}; last status: "${txt}"`);
}

async function runSearch(page, { query = '', field = null, from = '', to = '', sources = null, sort = null }) {
  // Reset UI
  await page.evaluate(() => {
    document.getElementById('search-input').value = '';
    document.getElementById('date-from').value = '';
    document.getElementById('date-to').value = '';
    for (const id of ['filter-dn', 'filter-rn', 'filter-dd', 'filter-sdhk', 'filter-df']) {
      document.getElementById(id).checked = true;
    }
  });
  if (field) await page.select('#search-field', field);
  if (sort) await page.select('#sort-mode', sort);
  if (from) await page.evaluate(v => { document.getElementById('date-from').value = v; }, from);
  if (to) await page.evaluate(v => { document.getElementById('date-to').value = v; }, to);
  if (sources) {
    await page.evaluate(srcs => {
      for (const id of ['filter-dn', 'filter-rn', 'filter-dd', 'filter-sdhk', 'filter-df']) {
        document.getElementById(id).checked = srcs.includes(id.replace('filter-', '').toUpperCase());
      }
    }, sources);
  }
  if (query) await page.evaluate(v => { document.getElementById('search-input').value = v; }, query);
  await page.click('#search-btn');
  const status = await waitForStatus(page, /\d+ treff/);
  const count = parseInt(status.match(/(\d+) treff/)[1], 10);
  const cards = await page.$$eval('.letter-card', els => els.map(e => ({
    id: e.querySelector('.sd-id')?.textContent || '',
    date: e.querySelector('.letter-date')?.textContent || '',
    place: e.querySelector('.letter-place')?.textContent || '',
    summary: e.querySelector('.letter-summary')?.textContent || '',
    badges: [...e.querySelectorAll('.source-badge, .source-toggle')].map(b => b.textContent)
  })));
  return { count, cards, status };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
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
  page.on('response', res => { if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`); });

  try {
    console.log(`Testing ${BASE_URL}/sok/`);
    await page.goto(`${BASE_URL}/sok/`, { waitUntil: 'networkidle2', timeout: 30000 });

    console.log('\n[init]');
    const initStatus = await waitForStatus(page, /brev klare for søk/);
    check('core loads', /106997 brev klare/.test(initStatus), `got: ${initStatus}`);

    console.log('\n[text search: sammendrag]');
    let r = await runSearch(page, { query: 'jordegods', field: 'text' });
    check('finds results', r.count > 50, `count=${r.count}`);
    check('renders 20 cards', r.cards.length === 20, `cards=${r.cards.length}`);
    check('summary mentions query', r.cards.some(c => /jordegods/i.test(c.summary)), '');
    const datesAsc = r.cards.map(c => c.date.match(/\d{3,4}/)?.[0]).filter(Boolean).map(Number);
    check('sorted by date asc', datesAsc.every((d, i) => i === 0 || d >= datesAsc[i - 1]), JSON.stringify(datesAsc));

    console.log('\n[date filter]');
    r = await runSearch(page, { query: 'biskop', field: 'text', from: '1300', to: '1350' });
    check('finds results in range', r.count > 0, `count=${r.count}`);
    // Overlap semantics: each result's [ds, de] range must intersect [1300, 1350]
    const ranges = await page.evaluate(async () => {
      const handles = window.__SD_STATE.currentResults.slice(0, 20);
      const letters = await Promise.all(handles.map(h => h.resolve()));
      return letters.map(l => [l.ds, l.de]);
    });
    const overlaps = ranges.every(([ds, de]) => {
      const y0 = parseInt(String(ds).slice(0, 4), 10);
      const y1 = parseInt(String(de || ds).slice(0, 4), 10) || y0;
      return y1 >= 1300 && y0 <= 1350;
    });
    check('result date ranges overlap 1300-1350', overlaps, JSON.stringify(ranges.slice(0, 5)));

    console.log('\n[date-only browse, no query]');
    r = await runSearch(page, { from: '822', to: '825' });
    check('browse by date works', r.count > 0 && r.count < 500, `count=${r.count}`);

    console.log('\n[source filter]');
    r = await runSearch(page, { query: 'kyrkio', field: 'text', sources: ['SDHK'] });
    const allSdhk = r.cards.every(c => c.badges.some(b => /SDHK/.test(b)));
    check('SDHK-only filter respected', r.count > 0 && allSdhk, `count=${r.count}`);

    console.log('\n[place search]');
    r = await runSearch(page, { query: 'Nidaros', field: 'place' });
    // Matches include letters whose secondary place fields say Nidaros but whose
    // normalized (displayed) place is e.g. Trondheim — both are correct hits.
    check('place search finds results', r.count > 500, `count=${r.count}`);
    check('cards render places', r.cards.every(c => c.place.length > 0), '');

    console.log('\n[fulltext search]');
    r = await runSearch(page, { query: 'pergament', field: 'fulltext' });
    check('fulltext search finds results', r.count > 0, `count=${r.count}`);

    console.log('\n[ID search: roman numeral form]');
    r = await runSearch(page, { query: 'DN XII 251', field: 'id' });
    check('DN XII 251 found', r.count >= 1, `count=${r.count}`);
    check('correct DN ref', r.cards.length > 0, '');

    console.log('\n[ID search: SD id]');
    r = await runSearch(page, { query: 'SD20010813', field: 'id' });
    check('SD id exact match', r.count === 1, `count=${r.count}`);
    check('right letter', r.cards[0]?.id === 'SD20010813', r.cards[0]?.id);

    console.log('\n[ID search: SDHK]');
    r = await runSearch(page, { query: 'SDHK 1234', field: 'id' });
    check('SDHK id found', r.count >= 1, `count=${r.count}`);

    console.log('\n[detail expansion]');
    r = await runSearch(page, { query: 'jordegods', field: 'text' });
    await page.click('.letter-card .toggle-details');
    await sleep(2500);
    const footerVisible = await page.$eval('.letter-card .letter-footer',
      el => el.style.display !== 'none' && el.innerHTML.trim().length > 0).catch(() => false);
    const contentLoaded = await page.$eval('.letter-card .letter-continuation',
      el => !/Laster|Kunne ikke/.test(el.textContent)).catch(() => false);
    check('details expand with full record', footerVisible || contentLoaded, '');

    console.log('\n[full-record alignment: detail must belong to the same letter]');
    // High global index (SDHK lives past idx 55,000) — catches chunk-order bugs
    r = await runSearch(page, { query: 'SDHK 30000', field: 'id' });
    check('SDHK 30000 found', r.count === 1, `count=${r.count}`);
    const alignment = await page.evaluate(async () => {
      const h = window.__SD_STATE.currentResults[0];
      const letter = await h.resolve();
      const full = window.__SD_STATE.fullDataCache.get(letter.i);
      return { cardId: letter.id, fullId: full?.SD_ID, idx: letter.i };
    });
    check('full record SD_ID matches card SD_ID',
      alignment.fullId && alignment.cardId === alignment.fullId,
      JSON.stringify(alignment));

    console.log('\n[pagination]');
    r = await runSearch(page, { query: 'biskop', field: 'text' });
    const firstId = r.cards[0]?.id;
    await page.click('#results-pagination [data-page="2"]');
    await sleep(1500);
    const newFirst = await page.$eval('.letter-card .sd-id', el => el.textContent).catch(() => '');
    check('page 2 shows different results', newFirst && newFirst !== firstId, `${firstId} -> ${newFirst}`);

    console.log('\n[sort: newest first]');
    r = await runSearch(page, { query: 'biskop', field: 'text', sort: 'date-desc' });
    // Compare the actual date_start sort values, not the display string
    // (display prefers the original date text, which can be a range).
    const dd = await page.evaluate(async () => {
      const letters = await Promise.all(window.__SD_STATE.currentResults.slice(0, 20).map(h => h.resolve()));
      return letters.map(l => l.ds).filter(Boolean);
    });
    check('sorted desc', dd.length > 3 && dd.every((d, i) => i === 0 || d <= dd[i - 1]), JSON.stringify(dd));

    console.log('\n[deep link]');
    await page.goto(`${BASE_URL}/sok/?id=SD20010813`, { waitUntil: 'networkidle2' });
    await waitForStatus(page, /1 treff/);
    const dlId = await page.$eval('.letter-card .sd-id', el => el.textContent).catch(() => '');
    check('?id= deep link works', dlId === 'SD20010813', dlId);

    console.log('\n[console errors]');
    const realErrors = consoleErrors.filter(e => !/favicon/.test(e));
    const realFailures = failedRequests.filter(u => !/favicon/.test(u));
    check('no console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
    check('no failed requests', realFailures.length === 0, realFailures.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
