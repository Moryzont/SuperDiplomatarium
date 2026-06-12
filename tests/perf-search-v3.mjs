/**
 * Performance measurement for search-v3: initial payload + query latency.
 * Usage: node tests/perf-search-v3.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';

const BASE_URL = process.argv[2] || 'http://localhost:8731/SuperDiplomatarium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForStatus(page, rx, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const txt = await page.$eval('#search-status', el => el.textContent).catch(() => '');
    if (rx.test(txt)) return txt;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${rx}`);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox']
  });
  const page = await browser.newPage();

  let bytes = 0, requests = 0;
  page.on('response', async res => {
    requests++;
    try { bytes += (await res.buffer()).length; } catch { /* aborted */ }
  });

  const t0 = Date.now();
  await page.goto(`${BASE_URL}/sok/`, { waitUntil: 'networkidle2' });
  await waitForStatus(page, /brev klare/);
  console.log(`INIT  ready in ${Date.now() - t0} ms, ${requests} requests, ${(bytes / 1e6).toFixed(2)} MB (uncompressed; ~5x less with gzip on Pages)`);

  const queries = [
    ['text', 'jordegods'], ['text', 'kong Håkon'], ['text', 'biskop'],
    ['place', 'Bergen'], ['fulltext', 'pergament'], ['id', 'DN XII 251']
  ];
  for (const [field, q] of queries) {
    const b0 = bytes;
    await page.select('#search-field', field);
    await page.evaluate(v => { document.getElementById('search-input').value = v; }, q);
    const s0 = Date.now();
    await page.click('#search-btn');
    const status = await waitForStatus(page, /\d+ treff \(\d+ ms\)/);
    const wall = Date.now() - s0;
    console.log(`QUERY ${field.padEnd(8)} "${q}": ${status.trim()}, wall ${wall} ms, fetched ${((bytes - b0) / 1024).toFixed(0)} KB`);
  }

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
