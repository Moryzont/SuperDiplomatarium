/* global document, window, fetch */

/**
 * SuperDiplomatarium Search v3 - Pagefind-backed static search
 *
 * Data layer (built by scripts/build-search-v3.mjs):
 *   data/v3/pagefind-main/      summaries/regests (every letter)
 *   data/v3/pagefind-fulltext/  brevtekst (letters with body text)
 *   data/v3/pagefind-place/     place names
 *   data/v3/core.json           compact table: ID search, related-source lookups
 *   data/optimized/full-XX.json full records, fetched on demand (unchanged from v2)
 *
 * The browser no longer loads the whole corpus. Initial payload is core.json
 * (~2 MB gzipped); each query fetches only the index shards and result
 * fragments it needs. Source and year filters resolve inside the index;
 * date sorting uses prebuilt sort keys.
 */

// ===================== Configuration =====================
const CONFIG = {
  PAGE_SIZE: 20,
  EXPORT_WARN_AT: 3000,       // confirm before exporting huge result sets
  FRAGMENT_CONCURRENCY: 32    // parallel fragment loads for export
};

const V3 = () => `${BASE()}/data/v3`;

// ===================== State =====================
const STATE = {
  core: null,               // { fields, records: [[id,d,r,sdhk,dd,df,src,ds,de,rel],...] }
  sdIdToIndex: new Map(),   // SD_ID -> global index
  pf: {},                   // lazily imported pagefind modules: main/fulltext/place
  fullDataCache: new Map(),
  fullChunksLoaded: new Set(),
  fullChunkSize: 500,
  currentResults: [],       // unified result handles (see makePfHandle/makeCoreHandle)
  currentQuery: '',
  currentPage: 1,
  activeSearchSeq: 0,
  isLoading: true
};

// Core record column offsets
const C = { id: 0, d: 1, r: 2, sdhk: 3, dd: 4, df: 5, src: 6, ds: 7, de: 8, rel: 9 };

// Test/debug hook
window.__SD_STATE = STATE;

// ===================== Initialization =====================
document.addEventListener('DOMContentLoaded', async () => {
  await initializeSearch();
  wireListeners();
  wireResultsList();
  wireExportBar();
  wirePagination();
  applyUrlParams();
});

function BASE() {
  return (window.SITE_BASE || '').replace(/\/+$/, '');
}

function updateStatus(msg, isError = false) {
  const el = document.getElementById('search-status');
  if (el) {
    el.textContent = msg;
    el.classList.toggle('error', isError);
  }
}

async function initializeSearch() {
  updateStatus('Laster inn...');
  try {
    const res = await fetch(`${V3()}/core.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading core.json`);
    STATE.core = await res.json();
    STATE.fullChunkSize = STATE.core.full_chunk_size || 500;
    const recs = STATE.core.records;
    for (let i = 0; i < recs.length; i++) {
      STATE.sdIdToIndex.set(recs[i][C.id], i);
    }
    STATE.isLoading = false;
    updateStatus(`${recs.length} brev klare for søk.`);
  } catch (err) {
    console.error('Init error:', err);
    updateStatus('Kunne ikke laste data. Prøv å laste siden på nytt.', true);
    STATE.isLoading = false;
  }
}

// Deep links: /sok/?id=SD20011494 or ?q=...&felt=...
function applyUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const q = params.get('q');
  const input = document.getElementById('search-input');
  const fieldSelect = document.getElementById('search-field');
  if (id && input) {
    input.value = id;
    if (fieldSelect) fieldSelect.value = 'id';
    performSearch();
  } else if (q && input) {
    input.value = q;
    if (fieldSelect && params.get('felt')) fieldSelect.value = params.get('felt');
    performSearch();
  }
}

// ===================== Pagefind loading =====================
async function getIndex(name) {
  if (STATE.pf[name]) return STATE.pf[name];
  const mod = await import(`${V3()}/pagefind-${name}/pagefind.js`);
  await mod.options({ excerptLength: 40 });
  await mod.init();
  STATE.pf[name] = mod;
  return mod;
}

// ===================== Core table accessors =====================
function coreLetter(idx) {
  const rec = STATE.core?.records[idx];
  if (!rec) return null;
  return {
    i: idx,
    id: rec[C.id],
    d: rec[C.d] || null,
    r: rec[C.r] || null,
    sdhk: rec[C.sdhk] || null,
    dd: rec[C.dd] || null,
    df: rec[C.df] || null,
    src: rec[C.src] || '',
    ds: rec[C.ds] || 0,   // ordinal int (YYYYMMDD) or 0
    de: rec[C.de] || 0,
    rel: rec[C.rel] || []
  };
}

function ordToIso(ord) {
  if (!ord) return '';
  const y = Math.floor(ord / 10000), mo = Math.floor(ord / 100) % 100, d = ord % 100;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ===================== On-Demand Full Data (same store as v2) =====================
async function loadFullDataForIndices(indices) {
  const chunksNeeded = new Set();
  for (const idx of indices) {
    if (!STATE.fullDataCache.has(idx)) {
      const chunkIdx = Math.floor(idx / STATE.fullChunkSize);
      if (!STATE.fullChunksLoaded.has(chunkIdx)) chunksNeeded.add(chunkIdx);
    }
  }
  await Promise.all([...chunksNeeded].map(async chunkIdx => {
    const url = `${BASE()}/data/optimized/full-${String(chunkIdx).padStart(2, '0')}.json`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const chunk = await res.json();
        for (const letter of chunk) STATE.fullDataCache.set(letter.i, letter);
        STATE.fullChunksLoaded.add(chunkIdx);
      }
    } catch (err) {
      console.error(`Failed to load full chunk ${chunkIdx}:`, err);
    }
  }));
}

function getFullData(idx) {
  return STATE.fullDataCache.get(idx) || null;
}

// ===================== Result handles =====================
// A handle lazily resolves to a "letter object" with the fields the card
// renderer expects: i, id, d, r, sdhk, dd, df, src, rel, ds, de, od, p, s, query.

function excerptToText(excerptHtml) {
  if (!excerptHtml) return '';
  const div = document.createElement('div');
  div.innerHTML = excerptHtml.replace(/<\/?mark>/g, '');
  return div.textContent || '';
}

function makePfHandle(pfResult) {
  let cached = null;
  return {
    kind: 'pf',
    async resolve() {
      if (cached) return cached;
      const data = await pfResult.data();
      const m = data.meta || {};
      const idx = parseInt(m.idx, 10);
      cached = {
        i: idx,
        id: m.id,
        d: m.d || null,
        r: m.r || null,
        sdhk: m.sdhk || null,
        dd: m.dd || null,
        df: m.df || null,
        src: m.src || '',
        rel: m.rel ? JSON.parse(m.rel) : [],
        ds: m.ds || '',
        de: m.de || '',
        od: m.od || '',
        p: m.p || '',
        s: m.s || excerptToText(data.excerpt),
        query: STATE.currentQuery
      };
      return cached;
    }
  };
}

function makeCoreHandle(idx) {
  let cached = null;
  return {
    kind: 'core',
    idx,
    async resolve() {
      if (cached) return cached;
      await loadFullDataForIndices([idx]);
      const cl = coreLetter(idx);
      const full = getFullData(idx) || {};
      cached = {
        ...cl,
        ds: full.date_start || ordToIso(cl.ds),
        de: full.date_end || ordToIso(cl.de),
        od: full.original_date || full.DN_dato || full.RN_dato || '',
        p: full.Normalized_name && full.Normalized_name !== '[No_loc]' ? full.Normalized_name
          : (full.DN_sted || full.RN_sted || full.DD_sted || full.SDHK_sted || full.DF_sted || ''),
        s: (full.sammendrag || full.regest || '').slice(0, 300),
        fotnoter: full.fotnoter || '',
        query: STATE.currentQuery
      };
      return cached;
    }
  };
}

// ===================== UI input parsing =====================
function readUIYearRange() {
  const fv = (document.getElementById('date-from')?.value || '').trim();
  const tv = (document.getElementById('date-to')?.value || '').trim();
  const fy = fv.match(/^\d{3,4}/) ? parseInt(fv, 10) : null;
  const ty = tv.match(/^\d{3,4}/) ? parseInt(tv, 10) : null;
  return { fromYear: fy, toYear: ty };
}

function romanToInt(roman) {
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let result = 0;
  const upper = roman.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const current = values[upper[i]] || 0;
    const next = values[upper[i + 1]] || 0;
    result += current < next ? -current : current;
  }
  return result;
}

// Parse query for ID search (DN XII 251, DN12000251, SD20010001, SDHK 1234, etc.)
function parseIdQuery(query) {
  const q = query.trim();

  const romanMatch = q.match(/^(DN|RN)\s+([IVXLCDM]+)[,\s]+(\d+)$/i);
  if (romanMatch) {
    const source = romanMatch[1].toUpperCase();
    const vol = romanToInt(romanMatch[2]);
    const num = parseInt(romanMatch[3], 10);
    if (source === 'DN') {
      return { type: 'id', source, id: `DN${String(vol).padStart(2, '0')}${String(num).padStart(6, '0')}` };
    }
    return { type: 'id', source, id: `RN${String(vol).padStart(3, '0')}_${String(num).padStart(5, '0')}` };
  }

  const sdhkMatch = q.match(/^SDHK[_\s-]*(\d+)$/i);
  if (sdhkMatch) {
    return { type: 'id', source: 'SDHK', id: `SDHK_${sdhkMatch[1].padStart(5, '0')}` };
  }

  if (/^DN\d{8}$/i.test(q)) return { type: 'id', source: 'DN', id: q.toUpperCase() };
  if (/^RN\d{3}[_-]?\d{5}$/i.test(q)) return { type: 'id', source: 'RN', id: q.toUpperCase().replace('-', '_') };
  if (/^SD\d+$/i.test(q)) return { type: 'id', source: 'SD', id: q.toUpperCase() };
  if (/^DD[_-]?\d+$/i.test(q)) return { type: 'id', source: 'DD', id: q.toUpperCase() };
  if (/^DF[_-]?\d+$/i.test(q)) return { type: 'id', source: 'DF', id: q.toUpperCase() };

  return { type: 'text', query: q };
}

function getSearchField() {
  return document.getElementById('search-field')?.value || 'text';
}

function getSortMode() {
  return document.getElementById('sort-mode')?.value || 'date';
}

function getSelectedDatabases() {
  return {
    DN: document.getElementById('filter-dn')?.checked ?? true,
    RN: document.getElementById('filter-rn')?.checked ?? true,
    DD: document.getElementById('filter-dd')?.checked ?? true,
    SDHK: document.getElementById('filter-sdhk')?.checked ?? true,
    DF: document.getElementById('filter-df')?.checked ?? true
  };
}

// ===================== Pagefind query plumbing =====================
function buildPfOptions() {
  const filters = {};
  const dbs = getSelectedDatabases();
  const enabled = Object.keys(dbs).filter(k => dbs[k]);
  if (enabled.length < 5) filters.source = { any: enabled.length ? enabled : ['__none__'] };

  const { fromYear, toYear } = readUIYearRange();
  if (fromYear != null || toYear != null) {
    const y0 = fromYear ?? 700, y1 = toYear ?? 1599;
    const years = [];
    for (let y = y0; y <= y1; y++) years.push(String(y));
    filters.year = { any: years };
  }

  const sortMode = getSortMode();
  const sort = sortMode === 'date-desc' ? { ddesc: 'asc' }
    : sortMode === 'completeness' ? { comp: 'asc' }
      : { dasc: 'asc' };

  const opts = { sort };
  if (Object.keys(filters).length) opts.filters = filters;
  return opts;
}

async function pfSearch(indexName, query, opts) {
  const pf = await getIndex(indexName);
  const res = await pf.search(query, opts);
  return res.results.map(makePfHandle);
}

// ===================== Core-table search (IDs) =====================
function matchesDbFilter(rec, dbs) {
  const src = (rec[C.src] || '').toUpperCase();
  if (!src) return true;
  const parts = src.split('+');
  return parts.some(p => dbs[p] !== false);
}

function matchesYearRange(rec, fromYear, toYear) {
  if (fromYear == null && toYear == null) return true;
  const ds = rec[C.ds], de = rec[C.de];
  if (!ds) return false;
  if (fromYear != null && Math.floor(de / 10000) < fromYear) return false;
  if (toYear != null && Math.floor(ds / 10000) > toYear) return false;
  return true;
}

function coreIdSearch(rawQuery) {
  const parsed = parseIdQuery(rawQuery);
  const dbs = getSelectedDatabases();
  const { fromYear, toYear } = readUIYearRange();
  const q = rawQuery.trim().toUpperCase();
  const recs = STATE.core.records;
  const hits = [];

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!matchesDbFilter(rec, dbs)) continue;
    if (!matchesYearRange(rec, fromYear, toYear)) continue;

    let found = false;
    if (parsed.type === 'id') {
      const sid = parsed.id;
      if (parsed.source === 'SD') found = rec[C.id] === sid;
      else if (parsed.source === 'DN') found = rec[C.d] === sid;
      else if (parsed.source === 'RN') found = (rec[C.r] || '').replace('-', '_') === sid;
      else if (parsed.source === 'SDHK') {
        const have = String(rec[C.sdhk] || '').replace(/^SDHK[_-]?/i, '');
        const want = sid.replace(/^SDHK[_-]?/i, '');
        found = have && (have === want || parseInt(have, 10) === parseInt(want, 10));
      } else if (parsed.source === 'DD') found = String(rec[C.dd] || '').toUpperCase() === sid;
      else if (parsed.source === 'DF') found = String(rec[C.df] || '').toUpperCase() === sid;
    } else {
      // Generic substring over all ID fields
      for (const col of [C.id, C.d, C.r, C.sdhk, C.dd, C.df]) {
        const v = rec[col];
        if (v && String(v).toUpperCase().includes(q)) { found = true; break; }
      }
    }
    if (found) hits.push(i);
  }

  // Sort by date ordinal (undated last), respecting the sort dropdown
  const sortMode = getSortMode();
  hits.sort((a, b) => {
    const da = recs[a][C.ds] || Infinity, db = recs[b][C.ds] || Infinity;
    if (sortMode === 'date-desc') {
      const ra = da === Infinity ? -Infinity : da, rb = db === Infinity ? -Infinity : db;
      return rb - ra;
    }
    return da - db;
  });

  return hits.map(makeCoreHandle);
}

// ===================== Search dispatch =====================
let debounceTimer = null;

async function performSearch() {
  const seq = ++STATE.activeSearchSeq;
  const rawQuery = (document.getElementById('search-input')?.value || '').trim();
  const { fromYear, toYear } = readUIYearRange();
  const hasDateFilter = fromYear != null || toYear != null;
  const searchField = getSearchField();

  STATE.currentQuery = rawQuery;
  STATE.currentResults = [];
  STATE.currentPage = 1;

  if (!rawQuery && !hasDateFilter) {
    await updateResultsView([]);
    renderPagination(0);
    setExportEnabled(false);
    updateStatus('Skriv inn søkeord eller velg datofilter.');
    return;
  }

  if (STATE.isLoading) {
    updateStatus('Laster fortsatt data, prøv igjen straks...');
    return;
  }

  updateStatus('Søker...');
  const startTime = performance.now();

  try {
    let handles = [];

    if (!rawQuery) {
      // Date/source filter only: browse via the main index (covers every letter)
      handles = await pfSearch('main', null, buildPfOptions());
    } else if (searchField === 'id' || (searchField === 'all' && parseIdQuery(rawQuery).type === 'id')) {
      handles = coreIdSearch(rawQuery);
    } else if (searchField === 'text') {
      handles = await pfSearch('main', rawQuery, buildPfOptions());
    } else if (searchField === 'fulltext') {
      handles = await pfSearch('fulltext', rawQuery, buildPfOptions());
    } else if (searchField === 'place') {
      handles = await pfSearch('place', rawQuery, buildPfOptions());
    } else if (searchField === 'all') {
      // Text + place + fulltext + ID substring, deduplicated by index order of priority
      const opts = buildPfOptions();
      const [main, place, fulltext] = await Promise.all([
        pfSearch('main', rawQuery, opts),
        pfSearch('place', rawQuery, opts),
        pfSearch('fulltext', rawQuery, opts)
      ]);
      const idHits = coreIdSearch(rawQuery);
      handles = await dedupeHandles([...main, ...idHits, ...place, ...fulltext]);
    }

    if (seq !== STATE.activeSearchSeq) return;

    STATE.currentResults = handles;
    await renderPage();
    if (seq !== STATE.activeSearchSeq) return;
    const elapsed = (performance.now() - startTime).toFixed(0);
    updateStatus(`${handles.length} treff (${elapsed} ms)`);
    setExportEnabled(handles.length > 0);
  } catch (err) {
    console.error('Search error:', err);
    if (seq === STATE.activeSearchSeq) updateStatus('Søket feilet. Prøv på nytt.', true);
  }
}

// Deduplicate handles across indexes. Pagefind handles must be resolved to know
// their letter index; resolution only fetches small fragment files.
async function dedupeHandles(handles) {
  const seen = new Set();
  const out = [];
  const resolved = await resolveAll(handles);
  for (let k = 0; k < handles.length; k++) {
    const letter = resolved[k];
    if (!letter || seen.has(letter.i)) continue;
    seen.add(letter.i);
    out.push(handles[k]);
  }
  return out;
}

async function resolveAll(handles, onProgress) {
  const out = new Array(handles.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < handles.length) {
      const k = next++;
      try {
        out[k] = await handles[k].resolve();
      } catch (err) {
        console.error('Resolve failed:', err);
        out[k] = null;
      }
      done++;
      if (onProgress && done % 200 === 0) onProgress(done, handles.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONFIG.FRAGMENT_CONCURRENCY, handles.length) }, worker));
  return out;
}

// ===================== Pagination & rendering =====================
async function renderPage() {
  const total = STATE.currentResults.length;
  const totalPages = Math.max(1, Math.ceil(total / CONFIG.PAGE_SIZE));
  if (STATE.currentPage > totalPages) STATE.currentPage = totalPages;

  const start = (STATE.currentPage - 1) * CONFIG.PAGE_SIZE;
  const end = Math.min(start + CONFIG.PAGE_SIZE, total);
  const pageHandles = STATE.currentResults.slice(start, end);
  const letters = (await resolveAll(pageHandles)).filter(Boolean);

  await updateResultsView(letters, start + 1, end, total);
  renderPagination(total);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightQuery(text, query) {
  if (!query || !text) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(rx, '<mark>$&</mark>');
}

function formatDateRange(start, end, original) {
  if (original && String(original).trim()) {
    const cleaned = String(original).trim().replace(/^0{4,}[;,]?\s*/g, '');
    if (cleaned) return cleaned;
  }
  const ys = String(start || '').match(/^(\d{4})/)?.[1];
  const ye = String(end || '').match(/^(\d{4})/)?.[1] || ys;
  if (ys && ye) return ys === ye ? ys : `${ys}-${ye}`;
  return ys || ye || 'Ukjent';
}

function toRoman(num) {
  if (!Number.isFinite(num) || num <= 0) return String(num);
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  let n = num;
  for (const [v, s] of map) { while (n >= v) { out += s; n -= v; } }
  return out;
}

function formatRef(ref, sourceKey) {
  if (!ref) return null;
  const refStr = String(ref);
  if (sourceKey === 'DN') {
    const m = refStr.match(/^DN(\d{2})(\d{6})$/i);
    if (m) return `DN ${toRoman(parseInt(m[1], 10))}, ${parseInt(m[2], 10)}`;
  }
  if (sourceKey === 'RN') {
    const m = refStr.match(/^RN(\d{3})[_-]?(\d{5})$/i);
    if (m) return `RN ${toRoman(parseInt(m[1], 10))}, ${parseInt(m[2], 10)}`;
  }
  if (sourceKey === 'SDHK') {
    const m = refStr.match(/^SDHK[_-]?(\d+)$/i);
    if (m) return `SDHK ${parseInt(m[1], 10)}`;
  }
  if (sourceKey === 'DD') {
    const m = refStr.match(/^DD[_-]?(\d+)$/i);
    if (m) return `DD ${parseInt(m[1], 10)}`;
  }
  if (sourceKey === 'DF') {
    const m = refStr.match(/^DF[_-]?(\d+)$/i);
    if (m) return `DF ${parseInt(m[1], 10)}`;
  }
  return refStr;
}

function renderReferencesLine(letter) {
  const refs = [];
  if (letter.d) refs.push(formatRef(letter.d, 'DN'));
  if (letter.r) refs.push(formatRef(letter.r, 'RN'));
  if (letter.sdhk) refs.push(formatRef(letter.sdhk, 'SDHK'));
  if (letter.dd) refs.push(formatRef(letter.dd, 'DD'));
  if (letter.df) refs.push(formatRef(letter.df, 'DF'));
  if (!refs.length) return '';
  return `<span class="references">${escapeHtml(refs.filter(Boolean).join(' | '))}</span>`;
}

const SOURCE_COLORS = {
  DN: '#5c6d4a', RN: '#6b8e7a', SDHK: '#8b7355', DD: '#8b5a5a', DF: '#5a7a6b'
};

function renderSourceBadges(letter) {
  const relatedIds = letter.rel || [];

  if (relatedIds.length > 0) {
    const allSources = [{ idx: letter.i, source: letter.src || 'Ukjent', sdId: letter.id, isActive: true }];
    for (const sdId of relatedIds) {
      const relIdx = STATE.sdIdToIndex.get(sdId);
      if (relIdx !== undefined) {
        const rel = coreLetter(relIdx);
        allSources.push({ idx: relIdx, source: rel.src || 'Ukjent', sdId, isActive: false });
      }
    }
    // Defensive cap: a card should never render an unbounded toggle row
    const MAX_TOGGLES = 8;
    const overflow = allSources.length - MAX_TOGGLES;
    const shown = overflow > 0 ? allSources.slice(0, MAX_TOGGLES) : allSources;
    const overflowHtml = overflow > 0
      ? `<span class="source-overflow" title="${overflow} flere relaterte oppføringer">+${overflow}</span>`
      : '';
    return shown.map(s => {
      const color = SOURCE_COLORS[s.source] || '#6b7280';
      if (s.isActive) {
        return `<button class="source-toggle active" data-source-idx="${s.idx}" data-card-idx="${letter.i}"
                        style="background-color: ${color}; color: white; border: 2px solid ${color};"
                        title="${s.sdId}">${s.source}</button>`;
      }
      return `<button class="source-toggle" data-source-idx="${s.idx}" data-card-idx="${letter.i}"
                      style="background-color: transparent; color: ${color}; border: 2px solid ${color};"
                      title="${s.sdId} - klikk for å vise">${s.source}</button>`;
    }).join('') + overflowHtml;
  }

  const sources = [];
  if (letter.d) sources.push('DN');
  if (letter.r) sources.push('RN');
  if (letter.sdhk) sources.push('SDHK');
  if (letter.dd) sources.push('DD');
  if (letter.df) sources.push('DF');
  if (!sources.length && letter.src) {
    for (const part of letter.src.split('+')) if (!sources.includes(part)) sources.push(part);
  }
  if (!sources.length) return '<span class="source-badge unknown">Ukjent</span>';
  return sources.map(key => {
    const color = SOURCE_COLORS[key] || '#6b7280';
    return `<span class="source-badge" style="background-color: ${color}" title="${key}">${key}</span>`;
  }).join('');
}

function renderCard(letter, query) {
  const date = formatDateRange(letter.ds, letter.de, letter.od);
  const place = letter.p || 'Ukjent sted';
  const preview = letter.s ? highlightQuery(letter.s, query) : '';
  return `
    <div class="search-result letter-card" data-idx="${letter.i}">
      <div class="letter-header">
        <div class="source-badges">${renderSourceBadges(letter)}</div>
        ${letter.id ? `<span class="sd-id">${escapeHtml(letter.id)}</span>` : ''}
      </div>
      <div class="letter-refs">${renderReferencesLine(letter)}</div>
      <div class="letter-meta" data-idx="${letter.i}">
        <span class="letter-date">${escapeHtml(date)}</span>
        <span class="letter-place">${escapeHtml(place)}</span>
        <span class="letter-meta-expanded" style="display:none;"></span>
      </div>
      <div class="letter-content" data-idx="${letter.i}">
        ${preview ? `<span class="letter-summary">${preview}</span>` : '<span class="letter-summary"><em class="text-muted">(Vis detaljer for innhold)</em></span>'}
        <span class="letter-continuation" style="display:none;"></span>
      </div>
      <div class="letter-footer" data-idx="${letter.i}" style="display:none;"></div>
      <div class="letter-actions">
        <button class="toggle-details btn-link" aria-expanded="false" data-idx="${letter.i}">Vis detaljer</button>
      </div>
    </div>`;
}

async function updateResultsView(letters, from = 0, to = 0, total = 0) {
  const container = document.getElementById('search-results');
  if (!container) return;
  if (!letters?.length) {
    container.innerHTML = total === 0 && from === 0 ? '' : '<p>Ingen treff</p>';
    return;
  }
  const query = STATE.currentQuery;
  container.innerHTML = `
    <p class="result-count">Viser ${from}-${to} av ${total} treff</p>
    <div class="result-list">${letters.map(l => renderCard(l, query)).join('')}</div>`;
}

function renderPagination(total) {
  const bar = document.getElementById('results-pagination');
  if (!bar) return;
  if (!total) { bar.style.display = 'none'; return; }

  const totalPages = Math.max(1, Math.ceil(total / CONFIG.PAGE_SIZE));
  const cur = STATE.currentPage;
  const pages = [1];
  for (let i = cur - 2; i <= cur + 2; i++) {
    if (i > 1 && i < totalPages && !pages.includes(i)) pages.push(i);
  }
  if (totalPages > 1 && !pages.includes(totalPages)) pages.push(totalPages);

  let html = `<button data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>&laquo;</button>`;
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) html += '<span class="page-ellipsis">…</span>';
    html += `<button data-page="${p}" class="${p === cur ? 'active' : ''}">${p}</button>`;
    prev = p;
  }
  html += `<button data-page="${cur + 1}" ${cur >= totalPages ? 'disabled' : ''}>&raquo;</button>`;
  bar.innerHTML = html;
  bar.style.display = 'flex';
}

// ===================== Detail expansion =====================
async function loadAndShowDetails(idx, showingSourceIdx = null) {
  const card = document.querySelector(`.letter-card[data-idx="${idx}"]`);
  if (!card) return;

  const metaExpEl = card.querySelector('.letter-meta-expanded');
  const contEl = card.querySelector('.letter-continuation');
  const footerEl = card.querySelector('.letter-footer');

  if (contEl) {
    contEl.innerHTML = ' <em style="color:#606C38;">Laster...</em>';
    contEl.style.display = 'inline';
  }

  // Only fetch the displayed letter's full record; related letters load
  // on demand when their toggle is clicked (groups can have many members).
  const displayIdx = showingSourceIdx !== null ? showingSourceIdx : idx;
  await loadFullDataForIndices([displayIdx]);
  const full = getFullData(displayIdx);
  if (!full) {
    if (contEl) contEl.innerHTML = ' <em style="color:#BC6C25;">Kunne ikke laste.</em>';
    return;
  }

  const LD = window.LetterDisplay;
  if (LD && LD.renderLetterDetails) {
    const details = LD.renderLetterDetails(full);

    if (showingSourceIdx !== null && showingSourceIdx !== idx) {
      const sdIdEl = card.querySelector('.sd-id');
      if (sdIdEl) sdIdEl.textContent = full.SD_ID || full.sd_id || '';
      const refsEl = card.querySelector('.letter-refs');
      if (refsEl && LD.renderReferencesLine) refsEl.innerHTML = LD.renderReferencesLine(full);
      const dateEl = card.querySelector('.letter-date');
      if (dateEl && LD.formatDateRange) {
        dateEl.textContent = LD.formatDateRange(full.date_start, full.date_end, full.original_date || full.DN_dato || full.RN_dato);
      }
      const placeEl = card.querySelector('.letter-place');
      if (placeEl && LD.getPlaceName) placeEl.textContent = LD.getPlaceName(full) || 'Ukjent sted';
    }

    if (metaExpEl && details.metaExpanded) {
      metaExpEl.innerHTML = details.metaExpanded;
      metaExpEl.style.display = 'inline';
    }
    const summaryEl = card.querySelector('.letter-summary');
    if (summaryEl) {
      summaryEl.innerHTML = details.summaryWithFootnotes || escapeHtml(full.sammendrag || full.brevtekst || '');
    }
    if (contEl) {
      contEl.innerHTML = details.continuation ? ' ' + details.continuation : '';
      contEl.style.display = 'inline';
    }
    if (footerEl && details.footer) {
      footerEl.innerHTML = details.footer;
      footerEl.style.display = 'block';
    }
    return;
  }

  // Fallback without LetterDisplay: show summary continuation + sources
  const fullSammendrag = full.sammendrag?.trim() || '';
  if (contEl) {
    const rest = fullSammendrag.length > 300 ? fullSammendrag.slice(300).trim() : '';
    contEl.innerHTML = rest ? ' ' + escapeHtml(rest) : '';
    contEl.style.display = 'inline';
  }
  const sources = [full.RN_source, full.DN_source, full.DD_source, full.SDHK_source, full.DF_source].filter(Boolean);
  if (footerEl && sources.length) {
    footerEl.innerHTML = `<span class="letter-kilde"><em>Kilde:</em> ${escapeHtml(sources.join(' | '))}</span>`;
    footerEl.style.display = 'block';
  }
}

// Switch a result card to show a related document (other source)
async function updateCardWithSource(originalIdx, newSourceIdx) {
  const card = document.querySelector(`.search-result[data-idx="${originalIdx}"]`);
  if (!card) return;

  const original = coreLetter(originalIdx);
  const newCore = coreLetter(newSourceIdx);
  if (!original || !newCore) return;

  // Rebuild toggle buttons with the new active state
  const badgesContainer = card.querySelector('.source-badges');
  if (badgesContainer) {
    const allSources = [{ idx: originalIdx, source: original.src || 'Ukjent', sdId: original.id, isActive: newSourceIdx === originalIdx }];
    for (const sdId of (original.rel || [])) {
      const relIdx = STATE.sdIdToIndex.get(sdId);
      if (relIdx !== undefined) {
        const rel = coreLetter(relIdx);
        allSources.push({ idx: relIdx, source: rel.src || 'Ukjent', sdId, isActive: newSourceIdx === relIdx });
      }
    }
    badgesContainer.innerHTML = allSources.map(s => {
      const color = SOURCE_COLORS[s.source] || '#6b7280';
      if (s.isActive) {
        return `<button class="source-toggle active" data-source-idx="${s.idx}" data-card-idx="${originalIdx}"
                        style="background-color: ${color}; color: white; border: 2px solid ${color};"
                        title="${s.sdId}">${s.source}</button>`;
      }
      return `<button class="source-toggle" data-source-idx="${s.idx}" data-card-idx="${originalIdx}"
                      style="background-color: transparent; color: ${color}; border: 2px solid ${color};"
                      title="${s.sdId} - klikk for å vise">${s.source}</button>`;
    }).join('');
  }

  // Load the new source's full record for display fields
  await loadFullDataForIndices([newSourceIdx]);
  const full = getFullData(newSourceIdx) || {};

  const sdIdEl = card.querySelector('.sd-id');
  if (sdIdEl && newCore.id) sdIdEl.textContent = newCore.id;
  const refsEl = card.querySelector('.letter-refs');
  if (refsEl) refsEl.innerHTML = renderReferencesLine(newCore);
  const dateEl = card.querySelector('.letter-date');
  if (dateEl) dateEl.textContent = formatDateRange(full.date_start || ordToIso(newCore.ds), full.date_end || ordToIso(newCore.de), full.original_date || full.DN_dato || full.RN_dato);
  const placeEl = card.querySelector('.letter-place');
  if (placeEl) {
    placeEl.textContent = (full.Normalized_name && full.Normalized_name !== '[No_loc]' ? full.Normalized_name
      : (full.DN_sted || full.RN_sted || full.DD_sted || full.SDHK_sted || full.DF_sted)) || 'Ukjent sted';
  }
  const summaryEl = card.querySelector('.letter-summary');
  if (summaryEl) {
    const s = (full.sammendrag || full.regest || '').slice(0, 300);
    summaryEl.innerHTML = s ? escapeHtml(s) : '<em class="text-muted">(Vis detaljer for innhold)</em>';
  }

  // If details are expanded, refresh them for the new source
  const footerEl = card.querySelector('.letter-footer');
  const isExpanded = footerEl && footerEl.style.display !== 'none' && footerEl.innerHTML.trim();
  if (isExpanded || !full.sammendrag) {
    await loadAndShowDetails(originalIdx, newSourceIdx);
    const toggle = card.querySelector('.toggle-details');
    if (toggle) {
      toggle.textContent = 'Skjul detaljer';
      toggle.setAttribute('aria-expanded', 'true');
    }
    const contEl = card.querySelector('.letter-continuation');
    const metaExpEl = card.querySelector('.letter-meta-expanded');
    if (contEl) contEl.style.display = 'inline';
    if (footerEl) footerEl.style.display = 'block';
    if (metaExpEl) metaExpEl.style.display = 'inline';
  }
}

// ===================== Event Wiring =====================
function wireListeners() {
  const input = document.getElementById('search-input');
  const button = document.getElementById('search-btn');

  const debounced = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(performSearch, 250);
  };

  if (input) {
    input.addEventListener('input', debounced);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') performSearch(); });
  }
  if (button) button.addEventListener('click', performSearch);

  const fieldSelect = document.getElementById('search-field');
  if (fieldSelect) {
    fieldSelect.addEventListener('change', () => {
      if (input) {
        const placeholders = {
          id: 'DN XII 251, SD20011494, SDHK 1234...',
          text: 'Søk i sammendrag...',
          fulltext: 'Søk i brevtekst...',
          place: 'Søk etter sted...',
          all: 'Søk i alle felt...'
        };
        input.placeholder = placeholders[fieldSelect.value] || 'Søk...';
      }
      performSearch();
    });
  }

  // Sorting is index-side, so a sort change re-runs the query
  document.getElementById('sort-mode')?.addEventListener('change', performSearch);

  const df = document.getElementById('date-from');
  const dt = document.getElementById('date-to');
  const rs = document.getElementById('date-reset');
  const debounceDates = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(performSearch, 350);
  };
  if (df) df.addEventListener('input', debounceDates);
  if (dt) dt.addEventListener('input', debounceDates);
  if (rs) rs.addEventListener('click', () => {
    if (df) df.value = '';
    if (dt) dt.value = '';
    performSearch();
  });

  for (const filterId of ['filter-dn', 'filter-rn', 'filter-dd', 'filter-sdhk', 'filter-df']) {
    document.getElementById(filterId)?.addEventListener('change', debounced);
  }
}

function wireResultsList() {
  const container = document.getElementById('search-results');
  if (!container) return;

  container.addEventListener('click', async (ev) => {
    const toggle = ev.target.closest('.toggle-details');
    if (toggle) {
      const idx = parseInt(toggle.dataset.idx, 10);
      const item = ev.target.closest('.search-result');
      const contEl = item.querySelector('.letter-continuation');
      const footerEl = item.querySelector('.letter-footer');
      const metaExpEl = item.querySelector('.letter-meta-expanded');
      const isExpanded = contEl && contEl.style.display !== 'none';

      if (!isExpanded) {
        await loadAndShowDetails(idx);
        toggle.textContent = 'Skjul detaljer';
      } else {
        if (contEl) contEl.style.display = 'none';
        if (footerEl) footerEl.style.display = 'none';
        if (metaExpEl) metaExpEl.style.display = 'none';
        toggle.textContent = 'Vis detaljer';
      }
      toggle.setAttribute('aria-expanded', String(!isExpanded));
      ev.preventDefault();
      return;
    }

    const sourceToggle = ev.target.closest('.source-toggle');
    if (sourceToggle) {
      if (!sourceToggle.classList.contains('active')) {
        await updateCardWithSource(
          parseInt(sourceToggle.dataset.cardIdx, 10),
          parseInt(sourceToggle.dataset.sourceIdx, 10)
        );
      }
      ev.preventDefault();
      return;
    }

    const sourceTab = ev.target.closest('.source-tab');
    if (sourceTab) {
      await loadAndShowDetails(
        parseInt(sourceTab.dataset.parentIdx, 10),
        parseInt(sourceTab.dataset.sourceIdx, 10)
      );
      ev.preventDefault();
      return;
    }

    const crossRefLink = ev.target.closest('.cross-ref-link');
    if (crossRefLink) {
      ev.preventDefault();
      const normalizedRef = normalizeCrossRef(crossRefLink.dataset.ref, crossRefLink.dataset.source);
      const searchInput = document.getElementById('search-input');
      const fieldSelect = document.getElementById('search-field');
      if (searchInput) {
        searchInput.value = normalizedRef;
        if (fieldSelect) fieldSelect.value = 'id';
        performSearch();
        document.querySelector('.search-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });
}

function normalizeCrossRef(ref, source) {
  if (!ref) return ref;
  if (source === 'DN' || ref.startsWith('DN')) {
    const m = ref.match(/^DN[_-]?(\d+)[_-](\d+)$/i);
    if (m) return `DN${String(parseInt(m[1], 10)).padStart(2, '0')}${String(parseInt(m[2], 10)).padStart(6, '0')}`;
    if (/^DN\d{8}$/i.test(ref)) return ref.toUpperCase();
  }
  if (source === 'RN' || ref.startsWith('RN')) {
    const m = ref.match(/^RN[_-]?(\d+)[_-](\d+)$/i);
    if (m) return `RN${String(parseInt(m[1], 10)).padStart(3, '0')}_${String(parseInt(m[2], 10)).padStart(5, '0')}`;
    if (/^RN\d{3}[_-]?\d{5}$/i.test(ref)) return ref.toUpperCase().replace('-', '_');
  }
  if (source === 'SDHK' || ref.startsWith('SDHK')) {
    const m = ref.match(/^SDHK[_-]?(\d+)$/i);
    if (m) return `SDHK_${String(parseInt(m[1], 10)).padStart(5, '0')}`;
  }
  if (source === 'DD' || ref.startsWith('DD')) {
    const m = ref.match(/^DD[_-]?(\d+)$/i);
    if (m) return `DD_${parseInt(m[1], 10)}`;
  }
  if (source === 'DF' || ref.startsWith('DF')) {
    const m = ref.match(/^DF[_-]?(\d+)$/i);
    if (m) return `DF_${parseInt(m[1], 10)}`;
  }
  return ref;
}

function wirePagination() {
  const bar = document.getElementById('results-pagination');
  if (!bar) return;
  bar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-page]');
    if (!btn || btn.disabled) return;
    const page = Number(btn.dataset.page);
    if (!Number.isFinite(page) || page < 1) return;
    STATE.currentPage = page;
    renderPage();
    document.querySelector('.search-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ===================== Export =====================
function wireExportBar() {
  document.getElementById('export-csv')?.addEventListener('click', () => {
    if (STATE.currentResults.length) downloadExport('csv');
  });
  document.getElementById('export-txt')?.addEventListener('click', () => {
    if (STATE.currentResults.length) downloadExport('txt');
  });
}

function setExportEnabled(on) {
  const bar = document.getElementById('export-bar');
  if (bar) bar.style.display = 'flex';
  const csvBtn = document.getElementById('export-csv');
  const txtBtn = document.getElementById('export-txt');
  if (csvBtn) csvBtn.disabled = !on;
  if (txtBtn) txtBtn.disabled = !on;
  const count = document.querySelector('.export-count');
  if (count) count.textContent = on ? `${STATE.currentResults.length} treff` : '';
}

async function downloadExport(format) {
  const n = STATE.currentResults.length;
  if (n > CONFIG.EXPORT_WARN_AT &&
      !window.confirm(`Dette vil laste ned data for ${n} treff og kan ta litt tid. Fortsette?`)) {
    return;
  }

  updateStatus(`Forbereder eksport av ${n} treff...`);
  const letters = (await resolveAll(STATE.currentResults, (done, total) =>
    updateStatus(`Forbereder eksport... ${done}/${total}`))).filter(Boolean);
  await loadFullDataForIndices(letters.map(l => l.i));

  if (format === 'csv') {
    const headers = ['SD_ID', 'DN_REF', 'RN_REF', 'SDHK_REF', 'DD_REF', 'DF_REF', 'date_start', 'date_end', 'place', 'sammendrag', 'regest'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const l of letters) {
      const full = getFullData(l.i) || {};
      lines.push([l.id, l.d, l.r, l.sdhk, l.dd, l.df, l.ds, l.de, l.p, full.sammendrag, full.regest].map(esc).join(','));
    }
    downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'sok-treff.csv');
  } else {
    const parts = [];
    for (const l of letters) {
      const full = getFullData(l.i) || {};
      parts.push([
        `${l.d || l.r || l.sdhk || l.dd || l.df || l.id || 'Uten referanse'}`,
        `Dato: ${formatDateRange(l.ds, l.de, l.od)} | Sted: ${l.p || 'Ukjent'}`,
        '',
        full.sammendrag ? `SAMMENDRAG:\n${full.sammendrag}` : '',
        full.brevtekst ? `\nBREVTEKST:\n${full.brevtekst}` : ''
      ].filter(Boolean).join('\n'));
    }
    downloadBlob(new Blob([parts.join('\n\n---\n\n')], { type: 'text/plain;charset=utf-8' }), 'sok-treff.txt');
  }
  updateStatus(`${n} treff eksportert.`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}
