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
    for (const id of ['filter-dn', 'filter-rn', 'filter-dd', 'filter-sdhk', 'filter-df', 'filter-di']) {
      document.getElementById(id).checked = true;
    }
  });
  if (field) await page.select('#search-field', field);
  if (sort) await page.select('#sort-mode', sort);
  if (from) await page.evaluate(v => { document.getElementById('date-from').value = v; }, from);
  if (to) await page.evaluate(v => { document.getElementById('date-to').value = v; }, to);
  if (sources) {
    await page.evaluate(srcs => {
      for (const id of ['filter-dn', 'filter-rn', 'filter-dd', 'filter-sdhk', 'filter-df', 'filter-di']) {
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
    // 107,680 = 106,986 (23,894 DSL TEI DD documents + the other four digital
    // collections) + 694 DI letters (Diplomatarium Islandicum vols. 1–2, from scans, 2026-10-15)
    check('core loads', /107680 brev klare/.test(initStatus), `got: ${initStatus}`);

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
      const handles = await window.__SD_STATE.currentResults.get(0, 20);
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

    console.log('\n[DI: Diplomatarium Islandicum (tier 3, from scans)]');
    r = await runSearch(page, { query: 'DI II nr. 154', field: 'id' });
    check('DI II nr. 154 found once', r.count === 1, `count=${r.count}`);
    check('DI II nr. 154 is SD80000000', r.cards[0]?.id === 'SD80000000', r.cards[0]?.id);
    check('DI badge on the card', r.cards[0]?.badges.some(b => /^DI$/.test(b.trim())), JSON.stringify(r.cards[0]?.badges));
    r = await runSearch(page, { query: 'DI I Viðbætir nr. 3', field: 'id' });
    check('DI I Viðbætir nr. 3 found once', r.count === 1 && r.cards[0]?.id === 'SD80000691', `count=${r.count} id=${r.cards[0]?.id}`);
    r = await runSearch(page, { query: 'DI02_00001', field: 'id' });
    check('raw DI id found', r.count === 1, `count=${r.count}`);
    r = await runSearch(page, { query: 'biskup', field: 'text', sources: ['DI'] });
    const allDi = r.cards.every(c => c.badges.some(b => /^DI$/.test(b.trim())));
    check('DI-only filter respected', r.count > 0 && allDi, `count=${r.count}`);
    await page.click('.letter-card .toggle-details');
    await sleep(2500);
    // the source paragraph: in the footer when short, in the editorial fold when long (DI's editor introductions)
    const diSrc = await page.$eval('.letter-card', el => (el.querySelector('.letter-footer')?.textContent || '') + (el.querySelector('details.editorial')?.textContent || '')).catch(() => '');
    check('DI detail shows the source apparatus', /DI:/.test(diSrc), diSrc.slice(0, 80));
    const diCont = await page.$eval('.letter-card .letter-continuation', el => el.textContent).catch(() => '');
    const diRefs = await page.$eval('.letter-card .letter-refs', el => el.textContent).catch(() => '');
    check('DI card reference line shows the edition number', /DI [IVX]+ (Viðbætir )?nr\. \d+/.test(diRefs), diRefs);
    check('DI detail shows the register fold', /Register \(|Index \(/.test(diCont), diCont.slice(0, 80));
    const regClosed = await page.$eval('.letter-card details.register', el => !el.open).catch(() => null);
    check('register folded by default', regClosed === true, String(regClosed));
    await page.$eval('.letter-card details.register', el => { el.open = true; });
    const diChips = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('.letter-card details.register .nevnt-chip')];
      return { kinds: chips.map(c => c.className.match(/nevnt-(person|place|subject)/)?.[1]), titles: chips.slice(0, 2).map(c => c.title) };
    });
    const order = diChips.kinds.filter(Boolean);
    const sortedOk = order.every((k, i) => i === 0 || ({person: 0, place: 1, subject: 2}[order[i - 1]] <= {person: 0, place: 1, subject: 2}[k]));
    check('DI mentions sorted persons, places, subjects', order.length > 0 && sortedOk, order.slice(0, 8).join(','));
    check('DI mention chips name their register', diChips.titles.every(t => /register/i.test(t)), JSON.stringify(diChips.titles));

    console.log('\n[DD letter: text, translation and editorial matter kept apart]');
    r = await runSearch(page, { query: 'SD50007362', field: 'id' });
    check('DD 3. rk. I nr. 1 found', r.count === 1, `count=${r.count}`);
    await page.click('.letter-card .toggle-details');
    await sleep(2500);
    const ddState = await page.evaluate(() => {
      const card = document.querySelector('.letter-card');
      const blocks = [...card.querySelectorAll('.text-block-label')].map(e => e.textContent.trim());
      const body = card.querySelector('.text-block-body')?.textContent || '';
      return { blocks, bodyTail: body.trim().slice(-60), fold: !!card.querySelector('details.editorial'),
               foldOpen: card.querySelector('details.editorial')?.open ?? null,
               apparatusInFold: !!card.querySelector('details.editorial')?.textContent.includes('attingeritis') };
    });
    check('letter text and translation are separate blocks', ddState.blocks.length === 2, JSON.stringify(ddState.blocks));
    check('apparatus no longer glued to the letter text', !/attigeritis/.test(ddState.bodyTail), ddState.bodyTail);
    check('editorial matter folded by default', ddState.fold && ddState.foldOpen === false, JSON.stringify(ddState));
    check('apparatus inside the fold', ddState.apparatusInFold, '');

    console.log('\n[Dates: one form, marks, the editions\' words]');
    const dateOf = async () => page.$eval('.letter-card .letter-date', el => ({
      text: [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(),
      q: !!el.querySelector('.date-mark-q'), alt: !!el.querySelector('.date-mark-alt'),
    })).catch(() => ({ text: '', q: false, alt: false }));
    r = await runSearch(page, { query: 'SD20000318', field: 'id' });
    let dt = await dateOf();
    check('DN 7 August 1349 shows as 7. august 1349', dt.text === '7. august 1349', dt.text);
    check('≠ mark when RN dates the document differently', dt.alt, JSON.stringify(dt));
    await page.click('.letter-card .toggle-details');
    await sleep(2500);
    const edDating = await page.$eval('.letter-card details.editorial', el => el.textContent).catch(() => '');
    check('editorial fold lists the editions\' datings', /Datering i utgavene|Dating in the editions/.test(edDating) && /1350 aug 6/.test(edDating), edDating.slice(0, 120));
    r = await runSearch(page, { query: 'SD07015640', field: 'id' });
    dt = await dateOf();
    check('[før 1389 nov 26] is the window 1. januar – 25. november 1389', dt.text === '1. januar – 25. november 1389', dt.text);
    check('? mark on a bounded dating', dt.q, JSON.stringify(dt));
    r = await runSearch(page, { query: 'SD50006941', field: 'id' });
    dt = await dateOf();
    check('DD bare year 1334 shows as 1334', dt.text === '1334', dt.text);
    r = await runSearch(page, { query: 'biskop', field: 'text' });
    const rawDates = await page.$$eval('.letter-card .letter-date', els => els.map(e => e.textContent).filter(t => /[\[\]]/.test(t)));
    check('no card prints an edition string with brackets', rawDates.length === 0, rawDates.slice(0, 3).join(' | '));

    console.log('\n[Om samlingen: the collections and their coverage]');
    await page.goto(`${BASE_URL}/om/`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelector('.coll-card[data-key="DN"] .coll-count')?.textContent.includes('brev'), { timeout: 20000 }).catch(() => {});
    const om = await page.evaluate(() => ({
      cards: document.querySelectorAll('.coll-card').length,
      dnCount: document.querySelector('.coll-card[data-key="DN"] .coll-count')?.textContent || '',
      dnBody: document.querySelector('.coll-card[data-key="DN"] .cov-row[data-stat="body"] .cov-fill')?.style.width || '',
      diTodo: document.querySelector('.coll-card[data-key="DI"] .coll-todo li')?.textContent || '',
    }));
    check('six collection cards', om.cards === 6, String(om.cards));
    check('DN card shows its record count and span', /\d.*brev.*\d{3,4}–\d{3,4}/.test(om.dnCount), om.dnCount);
    check('coverage bars are filled from collections.json', parseFloat(om.dnBody) > 90, om.dnBody);
    check('to-do list rendered from _data/collections.yml', om.diTodo.length > 10, om.diTodo.slice(0, 60));
    await page.goto(`${BASE_URL}/sok/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#search-btn', { timeout: 30000 });
    await sleep(1500);

    console.log('\n[Register search, chips as links, Arabic volume numbers, highlight after expand]');
    r = await runSearch(page, { query: 'Magnus Eriksson, konge', field: 'register' });
    check('register search finds the letters carrying the headword', r.count >= 500, `count=${r.count}`);
    r = await runSearch(page, { query: 'Erik Plovpenning', field: 'register' });
    check('register search finds a DD headword', r.count >= 1 && r.cards.some(c => c.id === 'SD50019237'), `count=${r.count}`);
    r = await runSearch(page, { query: 'SD50019237', field: 'id' });
    await page.click('.letter-card .toggle-details');
    await sleep(2500);
    await page.$eval('.letter-card details.register', el => { el.open = true; });
    const chipHref = await page.$eval('.letter-card details.register a.nevnt-chip', a => a.getAttribute('href')).catch(() => '');
    check('register chips link to the register search', /\/sok\/\?felt=register&q=/.test(chipHref), chipHref);
    r = await runSearch(page, { query: 'DN 5 145', field: 'id' });
    check('DN 5 145 (Arabic volume) finds DN V 145', r.count === 1 && r.cards[0]?.id === 'SD20004762', `count=${r.count} id=${r.cards[0]?.id}`);
    r = await runSearch(page, { query: 'RN 9 344', field: 'id' });
    check('RN 9 344 (Arabic volume) found', r.count === 1, `count=${r.count}`);
    r = await runSearch(page, { query: 'DI 2 154', field: 'id' });
    check('DI 2 154 (Arabic volume) finds DI II nr. 154', r.count === 1 && r.cards[0]?.id === 'SD80000000', `count=${r.count}`);
    r = await runSearch(page, { query: 'DN 5 145', field: 'all' });
    check('Alt accepts the Arabic reference too', r.count >= 1 && r.cards[0]?.id === 'SD20004762', `count=${r.count}`);
    r = await runSearch(page, { query: 'biskop', field: 'text', sources: ['DN'] });
    await page.click('.letter-card .toggle-details');
    await sleep(2500);
    const marks = await page.$$eval('.letter-card .letter-content mark', els => els.length);
    check('search word marked in the expanded details', marks >= 1, `marks=${marks}`);

    console.log('\n[RN register mentions]');
    r = await runSearch(page, { query: 'SD01007880', field: 'id' });
    check('RN 788 found', r.count === 1, `count=${r.count}`);
    await page.click('.letter-card .toggle-details');
    await sleep(2500);
    const rnCont = await page.$eval('.letter-card .letter-continuation', el => el.textContent).catch(() => '');
    check('RN detail shows the register fold', /Register \(|Index \(/.test(rnCont), rnCont.slice(0, 80));

    console.log('\n[detail expansion]');
    r = await runSearch(page, { query: 'jordegods', field: 'text' });
    await page.click('.letter-card .toggle-details');
    await sleep(2500);
    const footerVisible = await page.$eval('.letter-card .letter-footer',
      el => el.style.display !== 'none' && el.innerHTML.trim().length > 0).catch(() => false);
    const contentLoaded = await page.$eval('.letter-card .letter-continuation',
      el => !/Laster|Kunne ikke/.test(el.textContent)).catch(() => false);
    check('details expand with full record', footerVisible || contentLoaded, '');

    console.log('\n[text normalization: DD mojibake repaired]');
    r = await runSearch(page, { query: 'SD50007869', field: 'id' });
    const ddText = await page.evaluate(async () => {
      const l = await (await window.__SD_STATE.currentResults.get(0, 1))[0].resolve();
      const full = window.__SD_STATE.fullDataCache.get(l.i);
      return (full?.sammendrag || '') + (full?.brevtekst || '');
    });
    check('no mojibake in DD letter', ddText.length > 50 && !/Ã¦|â€/.test(ddText), ddText.slice(0, 60));
    check('mojibake decoded to æ/ø', /[æø]/.test(ddText), '');

    console.log('\n[footnotes: DN bracket format parses and renders]');
    r = await runSearch(page, { query: 'SD20011535', field: 'id' });
    check('DN footnote letter found', r.count === 1, `count=${r.count}`);
    await page.click('.toggle-details');
    await sleep(2500);
    const fnState = await page.evaluate(() => {
      const card = document.querySelector('.letter-card');
      return {
        items: card.querySelectorAll('.footnote-item').length,
        footer: card.querySelector('.letter-footer')?.textContent?.slice(0, 200) || ''
      };
    });
    check('footnote definitions render', fnState.items >= 3 || /tilskrevet/.test(fnState.footer),
      JSON.stringify(fnState));

    console.log('\n[matching: parallel mandates must not merge (SD20000039 case)]');
    // DN I 39 (mandate to bishop of Oslo) pairs with its RN regest RN I 788.
    // RN I 789 is a parallel mandate to the bishop of HAMAR issued the same
    // day — distinct RN number, distinct document. They share a citation to
    // the 1622 registratur note DN XVII 867, which must not merge them.
    const grp = await page.evaluate(() => {
      const recs = window.__SD_STATE.core.records;
      const byId = {};
      for (const r2 of recs) byId[r2[0]] = r2[9] || [];
      return {
        dn39: byId['SD20000039'], rn788: byId['SD01007880'],
        rn789: byId['SD01007890'], note1622: byId['SD20014949']
      };
    });
    check('DN I 39 paired with RN 788 only',
      JSON.stringify(grp.dn39) === '["SD01007880"]', JSON.stringify(grp.dn39));
    check('RN 789 (Hamar mandate) standalone',
      !grp.rn789 || grp.rn789.length === 0, JSON.stringify(grp.rn789));

    console.log('\n[related sources: toggle row capped]');
    const maxToggles = await page.evaluate(async () => {
      const recs = window.__SD_STATE.core.records;
      let best = 0, bestId = null;
      for (const rec of recs) {
        const n = rec[9] ? rec[9].length : 0;
        if (n > best) { best = n; bestId = rec[0]; }
      }
      document.getElementById('search-input').value = bestId;
      document.getElementById('search-btn').click();
      await new Promise(r2 => setTimeout(r2, 2500));
      return {
        biggestGroup: best + 1,
        toggles: document.querySelectorAll('.source-toggle').length,
        overflow: document.querySelectorAll('.source-overflow').length
      };
    });
    check('largest group is sane (<=50)', maxToggles.biggestGroup <= 50, JSON.stringify(maxToggles));
    check('toggle row capped at 8', maxToggles.toggles <= 8, JSON.stringify(maxToggles));

    console.log('\n[full-record alignment: detail must belong to the same letter]');
    // High global index (SDHK lives past idx 55,000) — catches chunk-order bugs
    r = await runSearch(page, { query: 'SDHK 30000', field: 'id' });
    check('SDHK 30000 found', r.count === 1, `count=${r.count}`);
    const alignment = await page.evaluate(async () => {
      const h = (await window.__SD_STATE.currentResults.get(0, 1))[0];
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
      const letters = await Promise.all((await window.__SD_STATE.currentResults.get(0, 20)).map(h => h.resolve()));
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
