/**
 * Build search-v3 artifacts from data/chunks/letters-chunk-*.json
 *
 * Outputs (all under data/v3/):
 *   pagefind-main/      Pagefind index over summaries/regests (+ place, refs as low-weight)
 *   pagefind-fulltext/  Pagefind index over brevtekst (real fulltext search)
 *   pagefind-place/     Pagefind index over place names only
 *   core.json           Compact per-letter table (ID search, related-source lookups, export)
 *
 * Record order follows the chunk files, so the array position in core.json equals
 * the global index used by data/optimized/full-XX.json (full_chunk_size = 100).
 *
 * Also writes data/optimized/full-XX.json: the on-demand full-record store used
 * by the search detail view and map popups (500 letters per chunk, addressed by
 * global index).
 *
 * Usage:  node scripts/build-search-v3.mjs            # full build
 *         LIMIT=2000 node scripts/build-search-v3.mjs # smoke test on first N letters
 *         ONLY=core,map node scripts/build-search-v3.mjs  # rebuild a subset of artifacts
 *         (artifact names: main, fulltext, place, core, map, full)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pagefind from 'pagefind';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHUNKS_DIR = path.join(ROOT, 'data', 'chunks');
const OUT_DIR = path.join(ROOT, 'data', 'v3');
const LIMIT = parseInt(process.env.LIMIT || '0', 10) || Infinity;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(s => s.trim())) : null;
const wants = name => !ONLY || ONLY.has(name);

// ---------- date parsing ----------
const MIN_YEAR = 700, MAX_YEAR = 1599;

function isoToOrd(s, endSide) {
  if (!s) return 0;
  const m = String(s).trim().match(/^(\d{3,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (!m) return 0;
  const y = parseInt(m[1], 10);
  if (y < MIN_YEAR || y > MAX_YEAR) return 0;
  const mo = m[2] ? parseInt(m[2], 10) : (endSide ? 12 : 1);
  const d = m[3] ? parseInt(m[3], 10) : (endSide ? 28 : 1);
  return y * 10000 + mo * 100 + d;
}

// Extract dates from free text: 8-digit YYYYMMDD tokens (SDHK style) and bare years.
function datesFromText(text) {
  if (!text) return null;
  const ords = [];
  for (const m of text.matchAll(/\b(\d{8})\b/g)) {
    const v = parseInt(m[1], 10);
    const y = Math.floor(v / 10000);
    if (y >= MIN_YEAR && y <= MAX_YEAR) {
      // Guard nonsense month/day (e.g. "00000000" placeholders)
      const mo = Math.floor(v / 100) % 100, d = v % 100;
      ords.push(y * 10000 + Math.min(Math.max(mo, 1), 12) * 100 + Math.min(Math.max(d, 1), 28));
    }
  }
  if (!ords.length) {
    for (const m of text.matchAll(/\b(1[0-5]\d\d|[7-9]\d\d)\b/g)) {
      const y = parseInt(m[1], 10);
      ords.push(y * 10000 + 101, y * 10000 + 1231);
    }
  }
  if (!ords.length) return null;
  return [Math.min(...ords), Math.max(...ords)];
}

// The edition's qualifiers on its dating as one short string for the cards:
// b bracket (supplied by the editor), q question mark, a approximate, < before,
// > after, | alternatives or between, = another edition dates the document
// differently, c curated in the tool. '' when the dating is plain.
function dateQualifiers(r) {
  const q = new Set(r.date_q || []);
  let s = '';
  if (q.has('bracket')) s += 'b';
  if (q.has('question')) s += 'q';
  if (q.has('approx')) s += 'a';
  if (q.has('before')) s += '<';
  if (q.has('after')) s += '>';
  if (q.has('alt') || q.has('between')) s += '|';
  if (Array.isArray(r.date_alt) && r.date_alt.length) s += '=';
  if (r.date_curated) s += 'c';
  return s;
}

function letterDates(r) {
  let ds = isoToOrd(r.date_start, false);
  let de = isoToOrd(r.date_end, true);
  if (!ds && !de) {
    const t = datesFromText(r.original_date || r.DN_dato || r.RN_dato || '');
    if (t) [ds, de] = t;
  }
  if (ds && !de) de = ds;
  if (!ds && de) ds = de;
  return [ds, de];
}

// ---------- helpers ----------
function completeness(r, ds, p) {
  let score = 0;
  if (ds) score += 30;
  if (p) score += 20;
  if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) score += 15;
  const s = r.sammendrag || r.regest || '';
  score += s.length > 50 ? 15 : (s ? 5 : 0);
  for (const k of ['DN_REF', 'RN_REF', 'SDHK_REF', 'DD_REF', 'DF_REF', 'DI_REF']) if (r[k]) score += 5;
  return score;
}

function placeOf(r) {
  const p = r.Normalized_name && r.Normalized_name !== '[No_loc]' ? r.Normalized_name : '';
  return p || r.DN_sted || r.RN_sted || r.DD_sted || r.SDHK_sted || r.DF_sted || r.DI_sted || '';
}

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) : s || '');

// Ordinal (YYYYMMDD int) -> ISO string "0822-09-01", as the card renderer expects.
function ordToIso(ord) {
  if (!ord) return '';
  const y = Math.floor(ord / 10000), mo = Math.floor(ord / 100) % 100, d = ord % 100;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function* loadLetters() {
  // Numeric chunk order — lexicographic sort would put -100 before -11 and
  // misalign the global index against everything else.
  const files = fs.readdirSync(CHUNKS_DIR)
    .filter(f => /^letters-chunk-\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10));
  let i = 0;
  for (const f of files) {
    const chunk = JSON.parse(fs.readFileSync(path.join(CHUNKS_DIR, f), 'utf8'));
    for (const r of chunk) {
      if (i >= LIMIT) return;
      yield [i++, r];
    }
  }
}

// ---------- build ----------
// language: 'no' gives Norwegian stemming, right for the modern regests; the
// letter texts (Latin, Old Norse, Middle Low German) and place names must
// not be stemmed, so those indexes use a code without a stemmer ('la').
async function buildIndex(name, recordFn, language = 'no') {
  const { index } = await pagefind.createIndex({ forceLanguage: language });
  let added = 0, skipped = 0;
  for (const [i, r] of loadLetters()) {
    const rec = recordFn(i, r);
    if (!rec) { skipped++; continue; }
    const res = await index.addCustomRecord(rec);
    if (res.errors?.length) console.error(`[${name}] #${i} ${r.SD_ID}:`, res.errors.join('; '));
    else added++;
    if (added % 10000 === 0) process.stdout.write(`[${name}] ${added} added\r`);
  }
  const outputPath = path.join(OUT_DIR, name);
  fs.rmSync(outputPath, { recursive: true, force: true });
  const { errors } = await index.writeFiles({ outputPath });
  if (errors?.length) throw new Error(`[${name}] write errors: ${errors.join('; ')}`);
  console.log(`[${name}] done: ${added} records indexed, ${skipped} skipped`);
}

function common(i, r) {
  const [ds, de] = letterDates(r);
  const p = placeOf(r);
  const score = completeness(r, ds, p);
  const years = [];
  if (ds) {
    const y0 = Math.floor(ds / 10000), y1 = Math.floor(de / 10000);
    for (let y = y0; y <= Math.min(y1, y0 + 60); y++) years.push(String(y));
  }
  // Keep meta slim: it is duplicated into every fragment file of every index.
  // The result-card preview text comes from Pagefind's match excerpt, not meta.
  const meta = {
    id: r.SD_ID, idx: String(i), src: r.source || '',
    p, od: trunc(r.original_date || r.DN_dato || r.RN_dato || '', 60),
    ds: ordToIso(ds), de: ordToIso(de),
    c: String(score),   // completeness, so fuzzy result merging can keep that sort order
  };
  const dq = dateQualifiers(r);
  if (dq) meta.dq = dq;
  for (const [mk, rk] of [['d', 'DN_REF'], ['r', 'RN_REF'], ['sdhk', 'SDHK_REF'], ['dd', 'DD_REF'], ['df', 'DF_REF'], ['di', 'DI_REF']]) {
    if (r[rk]) meta[mk] = r[rk];
  }
  if (r.related_sd_ids?.length) meta.rel = JSON.stringify(r.related_sd_ids);
  if (Number.isFinite(r.lat)) meta.la = String(r.lat);
  if (Number.isFinite(r.lon)) meta.lo = String(r.lon);
  const sort = {
    dasc: ds ? String(ds).padStart(8, '0') : '99999999',
    ddesc: ds ? String(99999999 - ds).padStart(8, '0') : '99999999',
    comp: String(200 - score).padStart(3, '0'),
  };
  const filters = { source: (r.source || 'ukjent').split('+') };
  if (years.length) filters.year = years;
  return { url: `/sok/?id=${r.SD_ID}`, meta, sort, filters, p };
}

// Bucket name for a word's first letter: a-z as is, anything else (æ ø å ä ö
// þ ð …) as its code point in hex, so the file names stay ASCII.
function vocabLetter(ch) {
  return /^[a-z]$/.test(ch) ? ch : `u${ch.codePointAt(0).toString(16)}`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();

  // 1. Main index: summaries/regests. Every letter gets a record (fallback content)
  //    so that filter-only browsing (date range, source) covers the whole corpus.
  if (wants('main')) await buildIndex('pagefind-main', (i, r) => {
    const c = common(i, r);
    const body = r.sammendrag || r.regest || '';
    const fallback = [c.p, c.meta.od, r.SD_ID].filter(Boolean).join(' ');
    return { url: c.url, content: body || fallback, language: 'no', meta: c.meta, sort: c.sort, filters: c.filters };
  });

  // 2. Fulltext index: brevtekst only (records that actually have body text).
  if (wants('fulltext')) await buildIndex('pagefind-fulltext', (i, r) => {
    if (!r.brevtekst || r.brevtekst.length < 50) return null;
    const c = common(i, r);
    return { url: c.url, content: r.brevtekst, language: 'la', meta: c.meta, sort: c.sort, filters: c.filters };
  }, 'la');

  // 3. Place index: place names only.
  if (wants('place')) await buildIndex('pagefind-place', (i, r) => {
    const places = [...new Set([r.Normalized_name, r.DN_sted, r.RN_sted, r.DD_sted, r.SDHK_sted, r.DF_sted, r.DI_sted]
      .filter(v => v && v !== '[No_loc]'))];
    if (!places.length) return null;
    const c = common(i, r);
    // Place-index content is just place names, so excerpts make poor previews;
    // carry a short summary in meta for the result card instead.
    const meta = { ...c.meta, s: trunc(r.sammendrag || r.regest || '', 150) };
    return { url: c.url, content: places.join(', '), language: 'la', meta, sort: c.sort, filters: c.filters };
  }, 'la');

  // 3b. Register index: the editions' registers on each letter (persons, places,
  //     subject headings), so a headword can be searched and a chip clicked.
  if (wants('register')) await buildIndex('pagefind-register', (i, r) => {
    const names = [...new Set((Array.isArray(r.nevnte) ? r.nevnte : []).map(m => (m.name || m.text || '').trim()).filter(Boolean))];
    if (!names.length) return null;
    const c = common(i, r);
    const meta = { ...c.meta, s: trunc(r.sammendrag || r.regest || '', 150) };
    return { url: c.url, content: names.join('; '), language: 'la', meta, sort: c.sort, filters: c.filters };
  }, 'la');

  // 4. Core table: compact arrays, position = global index (matches full-XX.json chunks).
  //    Fields: [SD_ID, DN, RN, SDHK, DD, DF, src, ds, de, rel, DI]   (DI appended last, 2026-10-15, so older offsets hold)
  if (wants('core')) {
    const core = [];
    for (const [, r] of loadLetters()) {
      const [ds, de] = letterDates(r);
      core.push([
        r.SD_ID, r.DN_REF || 0, r.RN_REF || 0, r.SDHK_REF || 0, r.DD_REF || 0, r.DF_REF || 0,
        r.source || 0, ds, de, r.related_sd_ids?.length ? r.related_sd_ids : 0,
        r.DI_REF || 0, dateQualifiers(r) || 0,
      ]);
    }
    const coreOut = {
      version: 3,
      generated: new Date().toISOString(),
      full_chunk_size: 100,
      n: core.length,
      fields: ['id', 'd', 'r', 'sdhk', 'dd', 'df', 'src', 'ds', 'de', 'rel', 'di', 'dq'],
      records: core,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'core.json'), JSON.stringify(coreOut));
    console.log(`[core] done: ${core.length} records, ${(fs.statSync(path.join(OUT_DIR, 'core.json')).size / 1e6).toFixed(1)} MB`);
  }

  // 5. Map table: letters with coordinates, just enough for markers and list cards.
  //    Summaries/fulltext load on demand from full-XX.json (popup open / detail toggle).
  //    Fields: [idx, lat, lon, SD_ID, DN, RN, SDHK, DD, DF, src, ds_iso, de_iso, od, place, DI]
  if (wants('map')) {
    const rows = [];
    for (const [i, r] of loadLetters()) {
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
      const [ds, de] = letterDates(r);
      rows.push([
        i, Math.round(r.lat * 1e5) / 1e5, Math.round(r.lon * 1e5) / 1e5,
        r.SD_ID, r.DN_REF || 0, r.RN_REF || 0, r.SDHK_REF || 0, r.DD_REF || 0, r.DF_REF || 0,
        r.source || 0, ordToIso(ds) || 0, ordToIso(de) || 0,
        trunc(r.original_date || r.DN_dato || r.RN_dato || '', 60) || 0, placeOf(r) || 0,
        r.DI_REF || 0, dateQualifiers(r) || 0,
      ]);
    }
    const mapOut = {
      version: 3,
      generated: new Date().toISOString(),
      full_chunk_size: 100,
      n: rows.length,
      fields: ['idx', 'la', 'lo', 'id', 'd', 'r', 'sdhk', 'dd', 'df', 'src', 'ds', 'de', 'od', 'p', 'di', 'dq'],
      records: rows,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'map.json'), JSON.stringify(mapOut));
    console.log(`[map] done: ${rows.length} geo-tagged letters, ${(fs.statSync(path.join(OUT_DIR, 'map.json')).size / 1e6).toFixed(1)} MB`);
  }

  // 5b. Collection statistics for the "Om samlingen" page: per collection, how
  //     many records carry each field, so the page can draw what is there and
  //     what is still to do. Counts come from the chunks, nothing is typed in.
  if (wants('stats')) {
    const stats = {};
    const touch = (k) => stats[k] || (stats[k] = { records: 0, summary: 0, body: 0, translation: 0, apparatus: 0, sourceApparatus: 0, footnotes: 0, notes: 0,
      dated: 0, dateUncertain: 0, placeString: 0, placed: 0, placeUncertain: 0, mentions: 0, subjects: 0, crossRefs: 0, linked: 0, yearMin: 9999, yearMax: 0 });
    for (const [, r] of loadLetters()) {
      const st = touch(r.source || 'unknown');
      st.records++;
      if ((r.sammendrag || r.regest || '').trim()) st.summary++;
      if ((r.brevtekst || '').trim()) st.body++;
      if ((r.oversettelse || '').trim()) st.translation++;
      if ((r.tekstapparat || '').trim()) st.apparatus++;
      if ((r[`${r.source}_source`] || '').trim()) st.sourceApparatus++;
      if ((r.fotnoter || '').trim()) st.footnotes++;
      if ((r.noter || '').trim()) st.notes++;
      const [ds, de] = letterDates(r);
      if (ds) { st.dated++; const y0 = Math.floor(ds / 10000), y1 = Math.floor((de || ds) / 10000); if (y0 < st.yearMin) st.yearMin = y0; if (y1 > st.yearMax) st.yearMax = y1; }
      if (Array.isArray(r.date_q) && r.date_q.length) st.dateUncertain++;
      if (placeOf(r)) st.placeString++;
      if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) st.placed++;
      if (r.uncertain_loc) st.placeUncertain++;
      const nev = Array.isArray(r.nevnte) ? r.nevnte : [];
      if (nev.length) st.mentions++;
      if (nev.some(m => m.kind === 'subject')) st.subjects++;
      if (Array.isArray(r.cross_references) && r.cross_references.length) st.crossRefs++;
      if (Array.isArray(r.related_sd_ids) && r.related_sd_ids.length) st.linked++;
    }
    const out = { generated: new Date().toISOString(), collections: stats };
    fs.writeFileSync(path.join(OUT_DIR, 'collections.json'), JSON.stringify(out));
    console.log(`[stats] done: ${Object.keys(stats).length} collections -> data/v3/collections.json`);
  }

  // 6. Full-record store: data/optimized/full-XX.json, 500 letters per chunk.
  //    Runtime contract: letter at global index i lives in full-{floor(i/500)}.json
  //    and carries its index as `i`. (Replaces the retired optimize-data.js.)
  if (wants('full')) {
    const FULL_DIR = path.join(ROOT, 'data', 'optimized');
    fs.mkdirSync(FULL_DIR, { recursive: true });
    for (const f of fs.readdirSync(FULL_DIR)) {
      if (/^full-\d+\.json$/.test(f)) fs.unlinkSync(path.join(FULL_DIR, f));
    }
    const FULL_CHUNK = 100;   // 100 letters per detail file: ~110 KB gzipped per "Vis detaljer" instead of ~550 KB
    let buf = [], chunkNo = 0, total = 0;
    const flush = () => {
      if (!buf.length) return;
      fs.writeFileSync(path.join(FULL_DIR, `full-${String(chunkNo).padStart(2, '0')}.json`), JSON.stringify(buf));
      chunkNo++; buf = [];
    };
    for (const [i, r] of loadLetters()) {
      buf.push({ i, ...r });
      total++;
      if (buf.length === FULL_CHUNK) flush();
    }
    flush();
    console.log(`[full] done: ${total} records in ${chunkNo} chunks`);
  }

  // 6. Vocabulary for fuzzy search: every word (3+ letters) of the summaries,
  //    letter texts and place names with its frequency, bucketed by first
  //    letter and length so the browser fetches only the buckets a query word
  //    can be within edit distance of (assets/js/search-v3.js, fuzzyCandidates).
  //    Files: vocab/<letter>/<len>.json = [[word, count], ...] by count desc;
  //    vocab/index.json = { "<letter>": [lengths...] }.
  if (wants('vocab')) {
    const counts = new Map();
    const re = /\p{L}{3,}/gu;
    for (const [, r] of loadLetters()) {
      for (const field of ['sammendrag', 'regest', 'brevtekst', 'Normalized_name', 'DN_sted', 'RN_sted', 'DD_sted', 'SDHK_sted', 'DF_sted', 'DI_sted']) {
        const t = r[field];
        if (!t || t === '[No_loc]') continue;
        for (const m of t.toLowerCase().matchAll(re)) counts.set(m[0], (counts.get(m[0]) || 0) + 1);
      }
    }
    const VOCAB_DIR = path.join(OUT_DIR, 'vocab');
    fs.rmSync(VOCAB_DIR, { recursive: true, force: true });
    const buckets = new Map();
    for (const [w, n] of counts) {
      const key = `${vocabLetter(w[0])}/${Math.min(w.length, 24)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push([w, n]);
    }
    const index = {};
    for (const [key, words] of buckets) {
      words.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const [letter, len] = key.split('/');
      fs.mkdirSync(path.join(VOCAB_DIR, letter), { recursive: true });
      fs.writeFileSync(path.join(VOCAB_DIR, letter, `${len}.json`), JSON.stringify(words));
      (index[letter] ||= []).push(Number(len));
    }
    for (const k of Object.keys(index)) index[k].sort((a, b) => a - b);
    fs.writeFileSync(path.join(VOCAB_DIR, 'index.json'), JSON.stringify(index));
    console.log(`[vocab] done: ${counts.size} words in ${buckets.size} buckets`);
  }

  await pagefind.close();
  console.log(`Build finished in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
