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
 * The browser no longer loads the whole corpus. core.json (~1 MB gzipped)
 * loads in the background and is awaited only by ID searches and the
 * related-source toggles; each query fetches only the index shards and
 * result fragments it needs. Source and year filters resolve inside the
 * index; date sorting uses prebuilt sort keys.
 */

// ===================== Configuration =====================
const CONFIG = {
  PAGE_SIZE: 20,
  EXPORT_WARN_AT: 3000,       // confirm before exporting huge result sets
  FRAGMENT_CONCURRENCY: 32    // parallel fragment loads for export
};

const V3 = () => `${BASE()}/data/v3`;

// Translated text (assets/js/i18n.js); the key itself when i18n is absent.
const TR = (key, params) => (window.i18n ? window.i18n.t(key, params) : key);

// ===================== State =====================
const STATE = {
  core: null,               // { fields, records: [[id,d,r,sdhk,dd,df,src,ds,de,rel],...] }
  sdIdToIndex: new Map(),   // SD_ID -> global index
  pf: {},                   // lazily imported pagefind modules: main/fulltext/place
  fullDataCache: new Map(),
  fullChunksLoaded: new Set(),
  fullChunkSize: 500,
  currentResults: null,     // a result list: { length, get(a, b), all() } of handles (see arrayResults/mergedResults)
  currentQuery: '',
  currentPage: 1,
  activeSearchSeq: 0,
  isLoading: true
};

// Core record column offsets
const C = { id: 0, d: 1, r: 2, sdhk: 3, dd: 4, df: 5, src: 6, ds: 7, de: 8, rel: 9, di: 10, dq: 11 };

// Test/debug hook
window.__SD_STATE = STATE;

// ===================== Initialization =====================
// The panel names (Søketips, Filtre, Fuzzy, Sortering) must stay on one row;
// a <details> grows to its content's width, so each panel's content is moved
// into a container below the row and shown while its <details> is open.
function liftPanels() {
  const row = document.querySelector('.search-options-row');
  if (!row || row.dataset.lifted) return;
  row.dataset.lifted = '1';
  const panels = document.createElement('div');
  panels.className = 'search-options-panels';
  row.after(panels);
  for (const d of row.querySelectorAll(':scope > details')) {
    const box = document.createElement('div');
    box.className = 'search-options-panel';
    box.hidden = !d.open;
    for (const child of [...d.children]) if (child.tagName !== 'SUMMARY') box.appendChild(child);
    panels.appendChild(box);
    d.addEventListener('toggle', () => { box.hidden = !d.open; });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  liftPanels();
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

// Status text is kept as a thunk so it can be re-rendered in the other language.
function status(thunk, isError = false) {
  STATE.statusThunk = thunk;
  STATE.statusError = isError;
  updateStatus(thunk(), isError);
}

function updateStatus(msg, isError = false) {
  const el = document.getElementById('search-status');
  if (el) {
    el.textContent = msg;
    el.classList.toggle('error', isError);
  }
}

// core.json (~1 MB gzipped) is only needed for ID searches and for the
// related-source toggles on result cards, so it loads in the background and
// the page is usable as soon as the script runs; text searches go straight
// to Pagefind. ensureCore() awaits it where it is really needed.
async function initializeSearch() {
  status(() => TR('results.loading'));
  STATE.currentResults = arrayResults([]);
  STATE.corePromise = (async () => {
    const res = await fetch(`${V3()}/core.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading core.json`);
    const core = await res.json();
    for (let i = 0; i < core.records.length; i++) STATE.sdIdToIndex.set(core.records[i][C.id], i);
    STATE.fullChunkSize = core.full_chunk_size || 500;
    STATE.core = core;
    return core;
  })();
  STATE.corePromise.catch(err => {
    console.error('Init error:', err);
    status(() => TR('results.loadError'), true);
  });
  STATE.isLoading = false;
  warmIndexes(getSearchField());
  try {
    const res = await fetch(`${BASE()}/data/metadata.json`);
    const meta = res.ok ? await res.json() : null;
    if (meta?.total_letters) {
      status(() => `${meta.total_letters} ${TR('results.ready')}`);
      return;
    }
  } catch (err) { /* fall through: the count comes with the core table */ }
  try {
    const core = await STATE.corePromise;
    status(() => `${core.records.length} ${TR('results.ready')}`);
  } catch (err) { /* already reported */ }
}

async function ensureCore() {
  return STATE.core || STATE.corePromise;
}

// Which Pagefind indexes a search field uses.
function indexesFor(field) {
  return field === 'text' ? ['main'] : field === 'fulltext' ? ['fulltext'] : field === 'place' ? ['place']
    : field === 'register' ? ['register']
    : field === 'all' ? ['main', 'place', 'register', 'fulltext'] : [];
}

// The first search on an index pays for its worker, wasm and a ~1.5 MB
// metadata file; fetching those as soon as the field is known (page load,
// field change) takes that wait out of the first search.
function warmIndexes(field) {
  for (const name of indexesFor(field)) getIndex(name).catch(() => {});
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
  // the regest index is stemmed Norwegian; letter texts and place names are
  // indexed without stemming under the code 'la' (see scripts/build-search-v3.mjs)
  await mod.options({ excerptLength: 40, language: name === 'main' ? 'no' : 'la' });
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
    di: rec[C.di] || null,
    dq: rec[C.dq] || '',
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
  await ensureCore();   // the chunk size comes with the core table
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
        di: m.di || null,
        dq: m.dq || '',
        src: m.src || '',
        rel: m.rel ? JSON.parse(m.rel) : [],
        ds: m.ds || '',
        de: m.de || '',
        c: m.c ? parseInt(m.c, 10) : 0,
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
      await ensureCore();
      await loadFullDataForIndices([idx]);
      const cl = coreLetter(idx);
      const full = getFullData(idx) || {};
      cached = {
        ...cl,
        ds: full.date_start || ordToIso(cl.ds),
        de: full.date_end || ordToIso(cl.de),
        od: full.original_date || full.DN_dato || full.RN_dato || '',
        p: full.Normalized_name && full.Normalized_name !== '[No_loc]' ? full.Normalized_name
          : (full.DN_sted || full.RN_sted || full.DD_sted || full.SDHK_sted || full.DF_sted || full.DI_sted || ''),
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

  // "DN XII 251", "DN 12 251", "DN XII, 251", "RN IX nr. 344", "RN 9 344": the
  // volume in Roman or Arabic numerals, the number after a comma, a space or "nr."
  const volNum = (v) => /^\d+$/.test(v) ? parseInt(v, 10) : romanToInt(v);
  const romanMatch = q.match(/^(DN|RN)\s+([IVXLCDM]+|\d{1,2})[,.]?\s*(?:nr\.?\s*)?(\d+)$/i);
  if (romanMatch) {
    const source = romanMatch[1].toUpperCase();
    const vol = volNum(romanMatch[2]);
    const num = parseInt(romanMatch[3], 10);
    if (source === 'DN') {
      return { type: 'id', source, id: `DN${String(vol).padStart(2, '0')}${String(num).padStart(6, '0')}` };
    }
    return { type: 'id', source, id: `RN${String(vol).padStart(3, '0')}_${String(num).padStart(5, '0')}` };
  }

  // DI II nr. 154 / DI II 154 / DI I Viðbætir nr. 3 / DI02_00154
  const diMatch = q.match(/^DI\s+([IVXLCDM]+|\d{1,2})[,.]?\s+(Viðb\S*\s+)?(?:nr\.?\s*)?(\d+)$/i);
  if (diMatch) {
    const vol = volNum(diMatch[1]);
    const num = parseInt(diMatch[3], 10) + (diMatch[2] ? 1000 : 0);
    return { type: 'id', source: 'DI', id: `DI${String(vol).padStart(2, '0')}_${String(num).padStart(5, '0')}` };
  }
  if (/^DI\d{2}_\d{5}$/i.test(q)) return { type: 'id', source: 'DI', id: q.toUpperCase() };

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
    DF: document.getElementById('filter-df')?.checked ?? true,
    DI: document.getElementById('filter-di')?.checked ?? true
  };
}

// ===================== Pagefind query plumbing =====================
function buildPfOptions() {
  const filters = {};
  const dbs = getSelectedDatabases();
  const enabled = Object.keys(dbs).filter(k => dbs[k]);
  if (enabled.length < Object.keys(dbs).length) filters.source = { any: enabled.length ? enabled : ['__none__'] };

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

async function pfSearchRaw(indexName, query, opts) {
  const pf = await getIndex(indexName);
  const res = await pf.search(query, opts);
  return res.results;
}

async function pfSearch(indexName, query, opts) {
  return (await pfSearchRaw(indexName, query, opts)).map(makePfHandle);
}

// ===================== Result lists =====================
// A result list hides whether the results are a plain array or a lazy merge
// of several Pagefind result sets (fuzzy search): { length, get(a, b), all() }.
function arrayResults(handles) {
  return {
    length: handles.length,
    queues: handles.length ? [handles] : [],
    async get(a, b) { return handles.slice(a, b); },
    async all() { return handles; }
  };
}

// Pagefind result arrays -> queues of handles. `keep`: a Set of result ids
// (null = all); a result id occurring in several arrays is taken once.
function pfQueues(lists, keep) {
  const seen = new Set();
  const queues = [];
  for (const list of lists) {
    const q = [];
    for (const r of list) {
      if ((keep && !keep.has(r.id)) || seen.has(r.id)) continue;
      seen.add(r.id);
      q.push(makePfHandle(r));
    }
    if (q.length) queues.push(q);
  }
  return queues;
}

// Merge several queues of handles that are each in the chosen sort order,
// keeping that order. Pagefind does not expose sort keys, so the merge
// resolves only the heads of the queues (small fragment files) and takes
// the smallest; a page of 20 results costs ~20 + k fragment fetches. A
// letter reached through several queues (the "Alt" field searches three
// indexes) is shown once; the length is an upper bound until the merge has
// run through everything, then it is exact.
function mergedResults(queues, sortMode) {
  queues = queues.filter(q => q.length);
  const heads = queues.map(() => 0);
  const out = [];
  const shown = new Set();
  const before = sortMode === 'date-desc'
    ? (x, y) => (x.ds || '\u0000') > (y.ds || '\u0000')          // newest first, undated last
    : sortMode === 'completeness'
      ? (x, y) => (x.c || 0) > (y.c || 0)
      : (x, y) => (x.ds || '￿') < (y.ds || '￿');       // oldest first, undated last
  const PREFETCH = 4;

  async function fill(n) {
    while (out.length < n) {
      const live = [];
      for (let j = 0; j < queues.length; j++) if (heads[j] < queues[j].length) live.push(j);
      if (!live.length) break;
      const headLetters = await Promise.all(live.map(j => {
        for (let k = 1; k <= PREFETCH && heads[j] + k < queues[j].length; k++) queues[j][heads[j] + k].resolve().catch(() => null);
        return queues[j][heads[j]].resolve().catch(() => null);
      }));
      let best = 0;
      for (let k = 1; k < live.length; k++) {
        if (!headLetters[best]) { best = k; continue; }
        if (headLetters[k] && before(headLetters[k], headLetters[best])) best = k;
      }
      const j = live[best];
      const h = queues[j][heads[j]++];
      const letter = headLetters[best];
      if (letter && !shown.has(letter.i)) { shown.add(letter.i); out.push(h); }
    }
    if (queues.every((q, j) => heads[j] >= q.length)) list.length = out.length;
  }
  const list = {
    length: queues.reduce((n, q) => n + q.length, 0),
    queues,
    async get(a, b) { await fill(b); return out.slice(a, b); },
    async all() { await fill(Infinity); return out; }
  };
  return list;
}

// ===================== Fuzzy search =====================
// Fuzzy = each query word is expanded to the spellings in the corpus within a
// small edit distance (vocabulary buckets built by scripts/build-search-v3.mjs),
// every candidate is searched as its own Pagefind query, and the result sets
// are merged in the chosen sort order. Multi-word queries keep Pagefind's
// AND semantics: a letter must match some candidate of every word.
const FUZZY = {
  index: null,            // vocab/index.json: letter -> [lengths]
  buckets: new Map(),     // "letter/len" -> Promise<[word, count][]>
  maxCandidates: { 1: 5, 2: 8, 3: 12 },
  expandBelow: 3000,      // no variant searches for a word with this many exact hits
  // first letters that are often interchangeable in the sources; a query word's
  // first letter is also looked up in these buckets
  firstLetterGroups: [['c', 'k', 'q'], ['v', 'w', 'u', 'f'], ['i', 'j', 'y'], ['æ', 'e', 'ä'], ['ø', 'o', 'ö'], ['å', 'a'], ['t', 'þ', 'd'], ['s', 'z'], ['b', 'p'], ['g', 'k']]
};

// 0 = off, 1 = moderat, 2 = vid, 3 = svært vid (the Fuzzy-nivå slider)
function fuzzyLevel() {
  const on = document.getElementById('fuzzy-on');
  if (on && !on.checked) return 0;
  return parseInt(document.getElementById('fuzzy-distance')?.value || '1', 10) || 1;
}

const fuzzyLevelName = level => TR('fuzzy.level.' + level);

function fuzzyMaxDistance(len, level) {
  if (level >= 3) return len >= 9 ? 3 : len >= 5 ? 2 : len >= 3 ? 1 : 0;
  if (level === 2) return len >= 11 ? 3 : len >= 6 ? 2 : len >= 3 ? 1 : 0;
  return len >= 9 ? 2 : len >= 5 ? 1 : 0;
}

function vocabLetter(ch) {
  return /^[a-z]$/.test(ch) ? ch : `u${ch.codePointAt(0).toString(16)}`;
}

async function vocabIndex() {
  if (!FUZZY.index) {
    FUZZY.index = fetch(`${V3()}/vocab/index.json`).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  }
  return FUZZY.index;
}

function vocabBucket(letter, len) {
  const key = `${letter}/${len}`;
  if (!FUZZY.buckets.has(key)) {
    FUZZY.buckets.set(key, fetch(`${V3()}/vocab/${letter}/${len}.json`).then(r => r.ok ? r.json() : []).catch(() => []));
  }
  return FUZZY.buckets.get(key);
}

// Optimal string alignment distance (Levenshtein + adjacent transposition),
// returning Infinity as soon as the distance exceeds `max`.
function editDistance(a, b, max) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > max) return Infinity;
  let prev2 = null, prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return Infinity;
    [prev2, prev, cur] = [prev, cur, prev2 || new Array(m + 1)];
  }
  return prev[m];
}

// The corpus spellings within reach of one query word, best first.
async function fuzzyCandidates(word, level) {
  const d = fuzzyMaxDistance(word.length, level);
  if (!d) return [word];
  const index = await vocabIndex();
  const letters = new Set([word[0]]);
  for (const g of FUZZY.firstLetterGroups) if (g.includes(word[0])) g.forEach(l => letters.add(l));
  if (word.length > 1) letters.add(word[1]);          // first letter missing in the query
  const wanted = [];
  for (const l of letters) {
    const key = vocabLetter(l);
    for (const len of index[key] || []) {
      if (Math.abs(len - Math.min(word.length, 24)) <= d) wanted.push([key, len]);
    }
  }
  const buckets = await Promise.all(wanted.map(([k, len]) => vocabBucket(k, len)));
  const scored = [];
  for (const bucket of buckets) {
    for (const [w, n] of bucket) {
      // a strict prefix of the query would only re-find the query's own prefix
      // matches (plus more noise) at the full cost of a large search
      if (w === word || word.startsWith(w)) continue;
      const dist = editDistance(word, w, d);
      if (dist <= d) scored.push([w, n / (1 + 2 * dist), dist]);
    }
  }
  scored.sort((x, y) => y[1] - x[1]);
  return [word, ...scored.slice(0, FUZZY.maxCandidates[level] || 6).map(x => x[0])];
}

function queryWords(rawQuery) {
  return (rawQuery.toLowerCase().match(/\p{L}+/gu) || []).filter(w => w.length >= 2);
}

// A fuzzy search over one index -> result list. Exact mode = plain Pagefind.
async function searchIndex(indexName, rawQuery, opts) {
  const level = fuzzyLevel();
  const words = queryWords(rawQuery);
  if (!level || !words.length || words.length > 6) {
    return arrayResults(await pfSearch(indexName, rawQuery, opts));
  }
  const lists = [];
  let keep = null;
  for (let j = 0; j < words.length; j++) {
    // Pagefind's cost grows with the result count (~0.1 ms per result), so a
    // word that already matches thousands of letters is not expanded: its
    // variants would add little but noise at several times the cost.
    const exact = await pfSearchRaw(indexName, words[j], opts);
    let results = [exact];
    if (exact.length < FUZZY.expandBelow) {
      const candidates = (await fuzzyCandidates(words[j], level)).slice(1);
      results = results.concat(await Promise.all(candidates.map(c => pfSearchRaw(indexName, c, opts))));
    }
    if (words.length > 1) {
      const ids = new Set();
      for (const rs of results) for (const r of rs) ids.add(r.id);
      keep = keep ? new Set([...keep].filter(id => ids.has(id))) : ids;
    }
    lists.push(...results);
  }
  return mergedResults(pfQueues(lists, keep), getSortMode());
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

async function coreIdSearch(rawQuery) {
  await ensureCore();
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
      else if (parsed.source === 'DI') found = String(rec[C.di] || '').toUpperCase() === sid;
    } else {
      // Generic substring over all ID fields
      for (const col of [C.id, C.d, C.r, C.sdhk, C.dd, C.df, C.di]) {
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
  STATE.currentResults = arrayResults([]);
  STATE.currentPage = 1;

  if (!rawQuery && !hasDateFilter) {
    await updateResultsView([]);
    renderPagination(0);
    setExportEnabled(false);
    status(() => TR('results.enter'));
    return;
  }

  if (STATE.isLoading) {
    status(() => TR('results.stillLoading'));
    return;
  }

  status(() => TR('results.searching'));
  const startTime = performance.now();

  try {
    let results = arrayResults([]);

    if (!rawQuery) {
      // Date/source filter only: browse via the main index (covers every letter)
      results = arrayResults(await pfSearch('main', null, buildPfOptions()));
    } else if (searchField === 'id' || (searchField === 'all' && parseIdQuery(rawQuery).type === 'id')) {
      results = arrayResults(await coreIdSearch(rawQuery));
    } else if (searchField === 'text') {
      results = await searchIndex('main', rawQuery, buildPfOptions());
    } else if (searchField === 'fulltext') {
      results = await searchIndex('fulltext', rawQuery, buildPfOptions());
    } else if (searchField === 'place') {
      results = await searchIndex('place', rawQuery, buildPfOptions());
    } else if (searchField === 'register') {
      results = await searchIndex('register', rawQuery, buildPfOptions());
    } else if (searchField === 'all') {
      // Text + place + fulltext + ID substring, merged in sort order; a letter
      // found in several indexes is shown once (dedupe happens as pages are
      // resolved, so the count can shrink on the last page)
      const opts = buildPfOptions();
      const [main, place, register, fulltext, idHits] = await Promise.all([
        searchIndex('main', rawQuery, opts),
        searchIndex('place', rawQuery, opts),
        searchIndex('register', rawQuery, opts),
        searchIndex('fulltext', rawQuery, opts),
        coreIdSearch(rawQuery)
      ]);
      results = mergedResults([...main.queues, idHits, ...place.queues, ...register.queues, ...fulltext.queues], getSortMode());
    }

    if (seq !== STATE.activeSearchSeq) return;

    STATE.currentResults = results;
    await renderPage();
    if (seq !== STATE.activeSearchSeq) return;
    const elapsed = (performance.now() - startTime).toFixed(0);
    status(() => TR('results.count', { n: STATE.currentResults.length, ms: elapsed }));
    setExportEnabled(results.length > 0);
  } catch (err) {
    console.error('Search error:', err);
    if (seq === STATE.activeSearchSeq) status(() => TR('results.failed'), true);
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
  const pageHandles = await STATE.currentResults.get(start, end);
  const letters = (await resolveAll(pageHandles)).filter(Boolean);
  // the related-source toggles on a card need the core table
  if (letters.some(l => l.rel && l.rel.length)) await ensureCore();

  // a merged list learns its exact length when it has run through everything
  const exactTotal = STATE.currentResults.length;
  await updateResultsView(letters, start + 1, Math.min(end, exactTotal), exactTotal);
  renderPagination(exactTotal);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Mark the query's words in the text nodes under `root` (after "Vis detaljer"
// the full text, the editorial fold and the footer are new DOM; the card
// preview was marked by highlightQuery as HTML). Word-start matches, as
// Pagefind searches; the fuzzy variants are not expanded here.
function highlightTerms(root, query) {
  if (!root || !query) return;
  const words = [...new Set(String(query).toLowerCase().split(/[\s,;:.()"«»]+/).filter(w => w.length >= 2))];
  if (!words.length) return;
  const rx = new RegExp(`(^|[^\\p{L}\\p{N}])(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest('mark, script, style, summary, .nevnt-chip, .date-mark')) return NodeFilter.FILTER_REJECT;
      return rx.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = n.nodeValue;
    rx.lastIndex = 0;
    for (const m of text.matchAll(rx)) {
      const start = m.index + m[1].length;
      frag.appendChild(document.createTextNode(text.slice(last, start)));
      const mark = document.createElement('mark');
      mark.textContent = m[2];
      frag.appendChild(mark);
      last = start + m[2].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    n.parentNode.replaceChild(frag, n);
  }
}

function highlightQuery(text, query) {
  if (!query || !text) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(rx, '<mark>$&</mark>');
}

function formatDateRange(start, end, original) {
  // one normalised form (assets/js/i18n.js); the edition's words only when there is no window
  return sdFormatDate(start, end, original);
}

function toRoman(num) {
  if (!Number.isFinite(num) || num <= 0) return String(num);
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  let n = num;
  for (const [v, s] of map) { while (n >= v) { out += s; n -= v; } }
  return out;
}

// DD ids come in two forms: the printed volumes' DD_<bind>_R<række>_<nr>
// (e.g. DD_03_R1_00177 = 1. række, bind III, nr. 177) and the online
// edition's date ids DD<yyyy><mm><dd><nnn> (99 = unknown month/day).
function formatDdRef(refStr) {
  let m = refStr.match(/^DD_(\d{2})_R(\d)_(\d{5})$/i);
  if (m) return `DD ${m[2]}. rk. ${toRoman(parseInt(m[1], 10))} nr. ${parseInt(m[3], 10)}`;
  m = refStr.match(/^DD(\d{4})(\d{2})(\d{2})(\d{3})$/i);
  if (m) {
    const date = m[2] === '99' ? m[1] : m[3] === '99' ? `${m[1]}-${m[2]}` : `${m[1]}-${m[2]}-${m[3]}`;
    return `DD ${date} nr. ${parseInt(m[4], 10)}`;
  }
  return refStr;
}


// DI ids: DI<vol 2 digits>_<nr 5 digits> (collections/di); the supplement of a
// volume is numbered 1001, 1002, … -> "DI I Viðbætir nr. 1".
function formatDiRef(refStr) {
  const m = refStr.match(/^DI(\d{2})_(\d{5})$/i);
  if (!m) return refStr;
  const vol = toRoman(parseInt(m[1], 10)), n = parseInt(m[2], 10);
  return n >= 1000 ? `DI ${vol} Viðbætir nr. ${n - 1000}` : `DI ${vol} nr. ${n}`;
}

function formatRef(ref, sourceKey) {
  if (!ref) return null;
  const refStr = String(ref);
  if (sourceKey === 'DI') return formatDiRef(refStr);
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
  if (sourceKey === 'DD') return formatDdRef(refStr);
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
  if (letter.di) refs.push(formatRef(letter.di, 'DI'));
  if (!refs.length) return '';
  return `<span class="references">${escapeHtml(refs.filter(Boolean).join(' | '))}</span>`;
}

const SOURCE_COLORS = {
  DN: '#5c6d4a', RN: '#6b8e7a', SDHK: '#8b7355', DD: '#8b5a5a', DF: '#5a7a6b', DI: '#6a6e8c'
};

function renderSourceBadges(letter) {
  const relatedIds = letter.rel || [];

  if (relatedIds.length > 0) {
    const allSources = [{ idx: letter.i, source: letter.src || TR('letter.unknown'), sdId: letter.id, isActive: true }];
    for (const sdId of relatedIds) {
      const relIdx = STATE.sdIdToIndex.get(sdId);
      if (relIdx !== undefined) {
        const rel = coreLetter(relIdx);
        allSources.push({ idx: relIdx, source: rel.src || TR('letter.unknown'), sdId, isActive: false });
      }
    }
    // Defensive cap: a card should never render an unbounded toggle row
    const MAX_TOGGLES = 8;
    const overflow = allSources.length - MAX_TOGGLES;
    const shown = overflow > 0 ? allSources.slice(0, MAX_TOGGLES) : allSources;
    const overflowHtml = overflow > 0
      ? `<span class="source-overflow" title="${TR('letter.moreRelated', { n: overflow })}">+${overflow}</span>`
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
                      title="${s.sdId} - ${TR('letter.clickToShow')}">${s.source}</button>`;
    }).join('') + overflowHtml;
  }

  const sources = [];
  if (letter.d) sources.push('DN');
  if (letter.r) sources.push('RN');
  if (letter.sdhk) sources.push('SDHK');
  if (letter.dd) sources.push('DD');
  if (letter.df) sources.push('DF');
  if (letter.di) sources.push('DI');
  if (!sources.length && letter.src) {
    for (const part of letter.src.split('+')) if (!sources.includes(part)) sources.push(part);
  }
  if (!sources.length) return `<span class="source-badge unknown">${TR('letter.unknown')}</span>`;
  return sources.map(key => {
    const color = SOURCE_COLORS[key] || '#6b7280';
    return `<span class="source-badge" style="background-color: ${color}" title="${key}">${key}</span>`;
  }).join('');
}

function renderCard(letter, query) {
  const date = formatDateRange(letter.ds, letter.de, letter.od);
  const place = letter.p || TR('letter.unknown.place');
  const preview = letter.s ? highlightQuery(letter.s, query) : '';
  return `
    <div class="search-result letter-card" data-idx="${letter.i}">
      <div class="letter-header">
        <div class="source-badges">${renderSourceBadges(letter)}</div>
        ${letter.id ? `<span class="sd-id">${escapeHtml(letter.id)}</span>` : ''}
      </div>
      <div class="letter-refs">${renderReferencesLine(letter)}</div>
      <div class="letter-meta" data-idx="${letter.i}">
        <span class="letter-date">${escapeHtml(date)}${sdDateMarks(letter.dq)}</span>
        <span class="letter-place">${escapeHtml(place)}</span>
        <span class="letter-meta-expanded" style="display:none;"></span>
      </div>
      <div class="letter-content" data-idx="${letter.i}">
        ${preview ? `<span class="letter-summary">${preview}</span>` : `<span class="letter-summary"><em class="text-muted">${TR('letter.detailsHint')}</em></span>`}
        <span class="letter-continuation" style="display:none;"></span>
      </div>
      <div class="letter-footer" data-idx="${letter.i}" style="display:none;"></div>
      <div class="letter-actions">
        <button class="toggle-details btn-link" aria-expanded="false" data-idx="${letter.i}">${TR('letter.show')}</button>
      </div>
    </div>`;
}

async function updateResultsView(letters, from = 0, to = 0, total = 0) {
  const container = document.getElementById('search-results');
  if (!container) return;
  if (!letters?.length) {
    container.innerHTML = total === 0 && from === 0 ? '' : `<p>${TR('results.none')}</p>`;
    return;
  }
  const query = STATE.currentQuery;
  container.innerHTML = `
    <p class="result-count">${TR('results.showingRange', { from, to, total })}</p>
    <div class="result-list">${letters.map(l => renderCard(l, query)).join('')}</div>`;
}

function renderPagination(total) {
  const bar = document.getElementById('results-pagination');
  if (!bar) return;
  if (!total) { bar.style.display = 'none'; return; }

  const totalPages = Math.max(1, Math.ceil(total / CONFIG.PAGE_SIZE));
  const cur = STATE.currentPage;
  const pages = [1];
  const span = window.innerWidth <= 640 ? 1 : 2;   // phones: one neighbour each side, so the row fits
  for (let i = cur - span; i <= cur + span; i++) {
    if (i > 1 && i < totalPages && !pages.includes(i)) pages.push(i);
  }
  if (totalPages > 1 && !pages.includes(totalPages)) pages.push(totalPages);

  // the same secondary button style as the rest of the site; the current page is filled
  let html = `<button type="button" class="page-btn btn-secondary" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''} aria-label="${TR('page.prev')}" title="${TR('page.prev')}">&laquo;</button>`;
  let prev = 0;
  for (const p of pages) {
    if (p - prev > 1) html += '<span class="page-ellipsis">…</span>';
    html += `<button type="button" class="page-num btn-secondary${p === cur ? ' active' : ''}" data-page="${p}" ${p === cur ? 'aria-current="page"' : ''}>${p}</button>`;
    prev = p;
  }
  html += `<button type="button" class="page-btn btn-secondary" data-page="${cur + 1}" ${cur >= totalPages ? 'disabled' : ''} aria-label="${TR('page.next')}" title="${TR('page.next')}">&raquo;</button>`;
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
    contEl.innerHTML = ` <em style="color:#606C38;">${TR('letter.loading')}</em>`;
    contEl.style.display = 'inline';
  }

  // Only fetch the displayed letter's full record; related letters load
  // on demand when their toggle is clicked (groups can have many members).
  const displayIdx = showingSourceIdx !== null ? showingSourceIdx : idx;
  await loadFullDataForIndices([displayIdx]);
  const full = getFullData(displayIdx);
  if (!full) {
    if (contEl) contEl.innerHTML = ` <em style="color:#BC6C25;">${TR('letter.loadFailed')}</em>`;
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
      if (dateEl) {
        dateEl.innerHTML = escapeHtml(formatDateRange(full.date_start, full.date_end, full.original_date || full.DN_dato || full.RN_dato)) + sdDateMarks(full);
      }
      const placeEl = card.querySelector('.letter-place');
      if (placeEl && LD.getPlaceName) placeEl.textContent = LD.getPlaceName(full) || TR('letter.unknown.place');
    }

    // Georeferenced letters: the place name links to the map pin (applies
    // on every expansion, not just when switching to a related letter)
    const placeLinkEl = card.querySelector('.letter-place');
    if (placeLinkEl && details.mapHref && !placeLinkEl.querySelector('.place-link')) {
      const placeName = (LD.getPlaceName ? LD.getPlaceName(full) : '') || placeLinkEl.textContent || TR('letter.unknown.place');
      placeLinkEl.innerHTML = `<a class="place-link" href="${details.mapHref}" title="${escapeHtml(details.mapTitle)}">${escapeHtml(placeName)}</a>`;
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
    // the search words stay marked in the full text, the fold and the footer
    if (getSearchField() !== 'id') highlightTerms(card.querySelector('.letter-content') || card, STATE.currentQuery);
    return;
  }

  // Fallback without LetterDisplay: show summary continuation + sources
  const fullSammendrag = full.sammendrag?.trim() || '';
  if (contEl) {
    const rest = fullSammendrag.length > 300 ? fullSammendrag.slice(300).trim() : '';
    contEl.innerHTML = rest ? ' ' + escapeHtml(rest) : '';
    contEl.style.display = 'inline';
  }
  const sources = [full.RN_source, full.DN_source, full.DD_source, full.SDHK_source, full.DF_source, full.DI_source].filter(Boolean);
  if (footerEl && sources.length) {
    footerEl.innerHTML = `<span class="letter-kilde"><em>Kilde:</em> ${escapeHtml(sources.join(' | '))}</span>`;
    footerEl.style.display = 'block';
  }
}

// Switch a result card to show a related document (other source)
async function updateCardWithSource(originalIdx, newSourceIdx) {
  const card = document.querySelector(`.search-result[data-idx="${originalIdx}"]`);
  if (!card) return;

  await ensureCore();
  const original = coreLetter(originalIdx);
  const newCore = coreLetter(newSourceIdx);
  if (!original || !newCore) return;

  // Rebuild toggle buttons with the new active state
  const badgesContainer = card.querySelector('.source-badges');
  if (badgesContainer) {
    const allSources = [{ idx: originalIdx, source: original.src || TR('letter.unknown'), sdId: original.id, isActive: newSourceIdx === originalIdx }];
    for (const sdId of (original.rel || [])) {
      const relIdx = STATE.sdIdToIndex.get(sdId);
      if (relIdx !== undefined) {
        const rel = coreLetter(relIdx);
        allSources.push({ idx: relIdx, source: rel.src || TR('letter.unknown'), sdId, isActive: newSourceIdx === relIdx });
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
                      title="${s.sdId} - ${TR('letter.clickToShow')}">${s.source}</button>`;
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
  if (dateEl) dateEl.innerHTML = escapeHtml(formatDateRange(full.date_start || ordToIso(newCore.ds), full.date_end || ordToIso(newCore.de), full.original_date || full.DN_dato || full.RN_dato)) + sdDateMarks(full.date_q ? full : newCore.dq);
  const placeEl = card.querySelector('.letter-place');
  if (placeEl) {
    placeEl.textContent = (full.Normalized_name && full.Normalized_name !== '[No_loc]' ? full.Normalized_name
      : (full.DN_sted || full.RN_sted || full.DD_sted || full.SDHK_sted || full.DF_sted)) || TR('letter.unknown.place');
  }
  const summaryEl = card.querySelector('.letter-summary');
  if (summaryEl) {
    const s = (full.sammendrag || full.regest || '').slice(0, 300);
    summaryEl.innerHTML = s ? escapeHtml(s) : `<em class="text-muted">${TR('letter.detailsHint')}</em>`;
  }

  // If details are expanded, refresh them for the new source
  const footerEl = card.querySelector('.letter-footer');
  const isExpanded = footerEl && footerEl.style.display !== 'none' && footerEl.innerHTML.trim();
  if (isExpanded || !full.sammendrag) {
    await loadAndShowDetails(originalIdx, newSourceIdx);
    const toggle = card.querySelector('.toggle-details');
    if (toggle) {
      toggle.textContent = TR('letter.hide');
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

  // While the user types, Pagefind only *preloads* the index chunks for the
  // prefix typed so far; the search itself runs after a pause and from three
  // letters on (every prefix used to be searched: "bis" alone costs seconds
  // of ranking for 16,000 hits, and the searches queued up behind each other).
  const debounced = () => {
    clearTimeout(debounceTimer);
    const q = (input?.value || '').trim();
    const field = getSearchField();
    if (q && field !== 'id') {
      for (const name of indexesFor(field)) getIndex(name).then(pf => pf.preload(q)).catch(() => {});
    }
    if (q.length > 0 && q.length < 3) return;
    debounceTimer = setTimeout(performSearch, 400);
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
        input.placeholder = TR('search.placeholder.' + fieldSelect.value);
        input.dataset.i18nPlaceholder = 'search.placeholder.' + fieldSelect.value;
      }
      warmIndexes(fieldSelect.value);
      performSearch();
    });
  }

  // Sorting is index-side, so a sort change re-runs the query
  document.getElementById('sort-mode')?.addEventListener('change', performSearch);
  const fuzzyOn = document.getElementById('fuzzy-on');
  const fuzzySlider = document.getElementById('fuzzy-distance');
  const fuzzyLabel = document.getElementById('fuzzy-label');
  const syncFuzzyControls = () => {
    document.getElementById('fuzzy-controls')?.classList.toggle('is-off', !!fuzzyOn && !fuzzyOn.checked);
    if (fuzzyLabel && fuzzySlider) fuzzyLabel.textContent = fuzzyLevelName(fuzzySlider.value);
  };
  syncFuzzyControls();
  fuzzyOn?.addEventListener('change', () => { syncFuzzyControls(); performSearch(); });
  fuzzySlider?.addEventListener('input', () => { syncFuzzyControls(); debounced(); });
  window.addEventListener('sd:language', () => {
    syncFuzzyControls();
    if (STATE.statusThunk) updateStatus(STATE.statusThunk(), STATE.statusError);
    if (STATE.currentResults?.length) renderPage();
  });

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

  for (const filterId of ['filter-dn', 'filter-rn', 'filter-dd', 'filter-sdhk', 'filter-df', 'filter-di']) {
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
        toggle.textContent = TR('letter.hide');
      } else {
        if (contEl) contEl.style.display = 'none';
        if (footerEl) footerEl.style.display = 'none';
        if (metaExpEl) metaExpEl.style.display = 'none';
        toggle.textContent = TR('letter.show');
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
  if (source === 'DI' || ref.startsWith('DI')) {
    const m = ref.match(/^DI[_-]?(\d+)[_-](\d+)$/i);
    if (m) return `DI${String(parseInt(m[1], 10)).padStart(2, '0')}_${String(parseInt(m[2], 10)).padStart(5, '0')}`;
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
  if (count) count.textContent = on ? TR('results.hitsN', { n: STATE.currentResults.length }) : '';
}

async function downloadExport(format) {
  const n = STATE.currentResults.length;
  if (n > CONFIG.EXPORT_WARN_AT &&
      !window.confirm(TR('export.confirm', { n }))) {
    return;
  }

  status(() => TR('export.preparing', { n }));
  const letters = (await resolveAll(await STATE.currentResults.all(), (done, total) =>
    updateStatus(TR('export.progress', { done, total })))).filter(Boolean);
  await loadFullDataForIndices(letters.map(l => l.i));

  if (format === 'csv') {
    const headers = ['SD_ID', 'DN_REF', 'RN_REF', 'SDHK_REF', 'DD_REF', 'DF_REF', 'DI_REF', 'date_start', 'date_end', 'place', 'sammendrag', 'regest'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.join(',')];
    for (const l of letters) {
      const full = getFullData(l.i) || {};
      lines.push([l.id, l.d, l.r, l.sdhk, l.dd, l.df, l.di, l.ds, l.de, l.p, full.sammendrag, full.regest].map(esc).join(','));
    }
    downloadBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), 'sok-treff.csv');
  } else {
    const parts = [];
    for (const l of letters) {
      const full = getFullData(l.i) || {};
      parts.push([
        `${l.d || l.r || l.sdhk || l.dd || l.df || l.di || l.id || 'Uten referanse'}`,
        `Dato: ${formatDateRange(l.ds, l.de, l.od)} | Sted: ${l.p || TR('letter.unknown')}`,
        '',
        full.sammendrag ? `SAMMENDRAG:\n${full.sammendrag}` : '',
        full.brevtekst ? `\nBREVTEKST:\n${full.brevtekst}` : ''
      ].filter(Boolean).join('\n'));
    }
    downloadBlob(new Blob([parts.join('\n\n---\n\n')], { type: 'text/plain;charset=utf-8' }), 'sok-treff.txt');
  }
  status(() => TR('export.done', { n }));
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

// Test hooks (tests/*.mjs): the pieces of fuzzy search, for timing them apart.
window.__sdGetIndex = getIndex;
window.__sdFuzzyCandidates = fuzzyCandidates;
window.__sdSearchIndex = async (name, q, opts) => { window.__sdLast = await searchIndex(name, q, opts); return window.__sdLast; };
