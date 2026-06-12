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
 * the global index used by data/optimized/full-XX.json (full_chunk_size = 500).
 *
 * Usage:  node scripts/build-search-v3.mjs            # full build
 *         LIMIT=2000 node scripts/build-search-v3.mjs # smoke test on first N letters
 *         ONLY=core,map node scripts/build-search-v3.mjs  # rebuild a subset of artifacts
 *         (artifact names: main, fulltext, place, core, map)
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
  for (const k of ['DN_REF', 'RN_REF', 'SDHK_REF', 'DD_REF', 'DF_REF']) if (r[k]) score += 5;
  return score;
}

function placeOf(r) {
  const p = r.Normalized_name && r.Normalized_name !== '[No_loc]' ? r.Normalized_name : '';
  return p || r.DN_sted || r.RN_sted || r.DD_sted || r.SDHK_sted || r.DF_sted || '';
}

const trunc = (s, n) => (s && s.length > n ? s.slice(0, n) : s || '');

// Ordinal (YYYYMMDD int) -> ISO string "0822-09-01", as the card renderer expects.
function ordToIso(ord) {
  if (!ord) return '';
  const y = Math.floor(ord / 10000), mo = Math.floor(ord / 100) % 100, d = ord % 100;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function* loadLetters() {
  const files = fs.readdirSync(CHUNKS_DIR).filter(f => /^letters-chunk-\d+\.json$/.test(f)).sort();
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
async function buildIndex(name, recordFn) {
  const { index } = await pagefind.createIndex({ forceLanguage: 'no' });
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
  };
  for (const [mk, rk] of [['d', 'DN_REF'], ['r', 'RN_REF'], ['sdhk', 'SDHK_REF'], ['dd', 'DD_REF'], ['df', 'DF_REF']]) {
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
    return { url: c.url, content: r.brevtekst, language: 'no', meta: c.meta, sort: c.sort, filters: c.filters };
  });

  // 3. Place index: place names only.
  if (wants('place')) await buildIndex('pagefind-place', (i, r) => {
    const places = [...new Set([r.Normalized_name, r.DN_sted, r.RN_sted, r.DD_sted, r.SDHK_sted, r.DF_sted]
      .filter(v => v && v !== '[No_loc]'))];
    if (!places.length) return null;
    const c = common(i, r);
    // Place-index content is just place names, so excerpts make poor previews;
    // carry a short summary in meta for the result card instead.
    const meta = { ...c.meta, s: trunc(r.sammendrag || r.regest || '', 150) };
    return { url: c.url, content: places.join(', '), language: 'no', meta, sort: c.sort, filters: c.filters };
  });

  // 4. Core table: compact arrays, position = global index (matches full-XX.json chunks).
  //    Fields: [SD_ID, DN, RN, SDHK, DD, DF, src, ds, de, rel]
  if (wants('core')) {
    const core = [];
    for (const [, r] of loadLetters()) {
      const [ds, de] = letterDates(r);
      core.push([
        r.SD_ID, r.DN_REF || 0, r.RN_REF || 0, r.SDHK_REF || 0, r.DD_REF || 0, r.DF_REF || 0,
        r.source || 0, ds, de, r.related_sd_ids?.length ? r.related_sd_ids : 0,
      ]);
    }
    const coreOut = {
      version: 3,
      generated: new Date().toISOString(),
      full_chunk_size: 500,
      n: core.length,
      fields: ['id', 'd', 'r', 'sdhk', 'dd', 'df', 'src', 'ds', 'de', 'rel'],
      records: core,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'core.json'), JSON.stringify(coreOut));
    console.log(`[core] done: ${core.length} records, ${(fs.statSync(path.join(OUT_DIR, 'core.json')).size / 1e6).toFixed(1)} MB`);
  }

  // 5. Map table: letters with coordinates, just enough for markers and list cards.
  //    Summaries/fulltext load on demand from full-XX.json (popup open / detail toggle).
  //    Fields: [idx, lat, lon, SD_ID, DN, RN, SDHK, DD, DF, src, ds_iso, de_iso, od, place]
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
      ]);
    }
    const mapOut = {
      version: 3,
      generated: new Date().toISOString(),
      full_chunk_size: 500,
      n: rows.length,
      fields: ['idx', 'la', 'lo', 'id', 'd', 'r', 'sdhk', 'dd', 'df', 'src', 'ds', 'de', 'od', 'p'],
      records: rows,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'map.json'), JSON.stringify(mapOut));
    console.log(`[map] done: ${rows.length} geo-tagged letters, ${(fs.statSync(path.join(OUT_DIR, 'map.json')).size / 1e6).toFixed(1)} MB`);
  }

  await pagefind.close();
  console.log(`Build finished in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch(err => { console.error(err); process.exit(1); });
