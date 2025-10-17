/* global MiniSearch, document, window, fetch */

/**
 * SuperDiplomatarium — OPTIMIZED Enhanced Search
 * Performance improvements:
 * - Pre-computed trigram/bigram indexes for O(1) candidate lookup
 * - Memoized distance calculations
 * - Smart candidate filtering
 * - Progressive search with early termination
 */

// =============== Globals ===============
let searchIndex = null;
let allLetters = [];
let DOCS = new Map();
let chunksLoaded = 0;
let totalChunks = 0;
let debounceTimer = null;

// NEW: Optimized search indexes
let SEARCH_INDEX = null;
let DISTANCE_CACHE = new Map();
const MAX_CACHE_SIZE = 10000;

let currentResultsAll = [];
let currentResultsShown = [];
let currentPage = 1;
const PAGE_SIZE = 50;

let searchMode = 'fuzzy';
let fuzzyDistance = 1;

document.addEventListener('DOMContentLoaded', async () => {
  await initializeSearch();
  wireListeners();
  wireResultsList();
  wireExportBar();
  wirePagination();
});

function BASE() { return (window.SITE_BASE || '').replace(/\/+$/, ''); }
function updateStatus(msg) { const el = document.getElementById('search-status'); if (el) el.textContent = msg; }

// =============== Optimized Fuzzy Matching ===============
function normalizeForScoring(s) { 
  return (s || '').toLowerCase().replace(/-\s*/g, ''); 
}

function tokenizeCanonical(s) { 
  const joined = normalizeForScoring(s); 
  return joined.match(/[a-zæøåäöáéíóúýþðœçàèìòùâêîôûãõüß]+/gi) || []; 
}

function generateTrigrams(text) {
  const normalized = normalizeForScoring(text).replace(/\s/g, '');
  if (normalized.length < 3) return new Set();
  const trigrams = new Set();
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.add(normalized.slice(i, i + 3));
  }
  return trigrams;
}

function generateBigrams(text) {
  const normalized = normalizeForScoring(text).replace(/\s/g, '');
  if (normalized.length < 2) return new Set();
  const bigrams = new Set();
  for (let i = 0; i <= normalized.length - 2; i++) {
    bigrams.add(normalized.slice(i, i + 2));
  }
  return bigrams;
}

// Memoized distance calculation
function getCachedDistance(a, b) {
  const key = `${a}|${b}`;
  if (DISTANCE_CACHE.has(key)) {
    return DISTANCE_CACHE.get(key);
  }
  
  const dist = tokenDistance(a, b);
  
  // Limit cache size
  if (DISTANCE_CACHE.size > MAX_CACHE_SIZE) {
    const firstKey = DISTANCE_CACHE.keys().next().value;
    DISTANCE_CACHE.delete(firstKey);
  }
  
  DISTANCE_CACHE.set(key, dist);
  return dist;
}

const CONFUSION_GROUPS = [['d','t'], ['v','u','w'], ['i','j','y'], ['c','k','q']];

function inSameGroup(a, b) {
  if (a === b) return true;
  for (const g of CONFUSION_GROUPS) 
    if (g.includes(a) && g.includes(b)) return true;
  return false;
}

function subCost(a, b) { 
  return a === b ? 0 : (inSameGroup(a, b) ? 0.35 : 1); 
}

function weightedEdit(a, b, maxCostHint) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  
  // Early termination: if length difference is too large
  if (maxCostHint && Math.abs(m - n) > maxCostHint * 2) {
    return maxCostHint * 2;
  }
  
  const band = Math.max(2, Math.abs(m - n) + 1);
  let prev = new Array(n + 1), curr = new Array(n + 1);
  
  for (let j = 0; j <= n; j++) prev[j] = j;
  
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const jStart = Math.max(1, i - band), jEnd = Math.min(n, i + band);
    
    for (let j = 1; j < jStart; j++) curr[j] = Number.POSITIVE_INFINITY;
    
    for (let j = jStart; j <= jEnd; j++) {
      const costSub = prev[j - 1] + subCost(a[i - 1], b[j - 1]);
      const costIns = curr[j - 1] + 1, costDel = prev[j] + 1;
      let val = Math.min(costSub, costIns, costDel);
      
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prev[j - 2] + subCost(a[i - 2], b[j - 2]));
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    
    for (let j = jEnd + 1; j <= n; j++) curr[j] = Number.POSITIVE_INFINITY;
    
    // Early termination if row minimum exceeds threshold
    if (maxCostHint && rowMin > maxCostHint * 1.6) return rowMin;
    
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

function bigramsOf(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function diceCoeff(a, b) {
  if (!a.length || !b.length) return 0;
  const m = new Map();
  for (const x of a) m.set(x, (m.get(x) || 0) + 1);
  let inter = 0;
  for (const y of b) {
    const k = m.get(y) || 0;
    if (k > 0) { inter++; m.set(y, k - 1); }
  }
  return (2 * inter) / (a.length + b.length);
}

function tokenDistance(qRaw, wRaw) {
  const q = qRaw.toLowerCase(), w = wRaw.toLowerCase();
  if (!q || !w) return 1e9;
  
  // Quick exact match
  if (q === w) return 0;
  
  // Quick prefix match
  if (w.startsWith(q) || q.startsWith(w)) return 0.1;
  
  const maxPrefix = Math.min(2, Math.min(q.length, w.length));
  let p = 0;
  for (let i = 0; i < maxPrefix; i++) 
    if (q[i] !== w[i]) p += 0.35;
  
  const maxLen = Math.max(q.length, w.length);
  const we = weightedEdit(q, w, Math.ceil(maxLen * 0.5)) / maxLen;
  const dice = 1 - diceCoeff(bigramsOf(q), bigramsOf(w));
  
  return 0.7 * (we + p) + 0.3 * dice;
}

function thresholdFor(dist) {
  const d = Math.max(0, Math.min(3, parseInt(dist || '1', 10)));
  return [0.28, 0.34, 0.42, 0.50][d];
}

// NEW: Fast candidate filtering using pre-computed indexes
function getCandidatesFromIndexes(query, maxCandidates = 3000) {
  if (!SEARCH_INDEX) return new Set();
  
  const candidates = new Set();
  const queryTokens = tokenizeCanonical(query);
  
  // Try exact token matches first (fastest)
  for (const token of queryTokens) {
    const tokenLower = token.toLowerCase();
    if (SEARCH_INDEX.tokens[tokenLower]) {
      SEARCH_INDEX.tokens[tokenLower].forEach(id => candidates.add(id));
    }
    
    // Try prefixes
    for (let i = Math.min(token.length, 5); i >= 3; i--) {
      const prefix = tokenLower.slice(0, i);
      if (SEARCH_INDEX.tokens[prefix]) {
        SEARCH_INDEX.tokens[prefix].forEach(id => candidates.add(id));
      }
    }
    
    if (candidates.size > maxCandidates) break;
  }
  
  // If we have enough candidates, return early
  if (candidates.size >= 100) {
    return candidates;
  }
  
  // Use trigrams for fuzzy matching
  const queryTrigrams = generateTrigrams(query);
  const trigramCandidates = new Map(); // doc_id -> match_count
  
  queryTrigrams.forEach(tri => {
    if (SEARCH_INDEX.trigrams[tri]) {
      SEARCH_INDEX.trigrams[tri].forEach(id => {
        trigramCandidates.set(id, (trigramCandidates.get(id) || 0) + 1);
      });
    }
  });
  
  // Add documents with highest trigram overlap
  const sorted = Array.from(trigramCandidates.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates);
  
  sorted.forEach(([id]) => candidates.add(id));
  
  return candidates;
}

// Check if document matches fuzzy search (now with candidate pre-filtering)
function docMatchesFuzzy(doc, queryTokens, fields, threshold, candidates = null) {
  if (queryTokens.length === 0) return true;
  
  // If we have candidates and this doc isn't in them, skip early
  if (candidates && !candidates.has(doc.id)) return false;
  
  for (const field of fields) {
    const text = normalizeForScoring(doc[field] || '');
    const docTokens = tokenizeCanonical(text);
    
    let allMatch = true;
    for (const qToken of queryTokens) {
      let foundMatch = false;
      
      // Check hyphenated combinations
      for (let i = 0; i < docTokens.length - 1; i++) {
        const combined = docTokens[i] + docTokens[i + 1];
        if (getCachedDistance(qToken, combined) <= threshold) {
          foundMatch = true;
          break;
        }
      }
      
      if (!foundMatch) {
        // Check individual tokens with early termination
        for (const dToken of docTokens) {
          // Quick length check before expensive distance calculation
          const lenDiff = Math.abs(qToken.length - dToken.length);
          if (lenDiff > qToken.length * 0.5) continue;
          
          if (getCachedDistance(qToken, dToken) <= threshold) {
            foundMatch = true;
            break;
          }
        }
      }
      
      if (!foundMatch) {
        allMatch = false;
        break;
      }
    }
    
    if (allMatch) return true;
  }
  
  return false;
}

// =============== Init + Loading ===============
async function initializeSearch() {
  updateStatus('Laster inn brevsamlingen…');
  try {
    const metaUrl = `${BASE()}/data/metadata.json`;
    const metaResponse = await fetch(metaUrl);
    if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status} on ${metaUrl}`);
    const metadata = await metaResponse.json();
    totalChunks = metadata.chunks;

    // Load the optimized search index first (now chunked)
    if (metadata.has_search_index && metadata.index_metadata) {
      updateStatus('Laster søkeindeks…');
      try {
        await loadChunkedIndexes(metadata.index_metadata);
        console.log('✓ Loaded optimized search index:', {
          trigrams: Object.keys(SEARCH_INDEX.trigrams).length,
          tokens: Object.keys(SEARCH_INDEX.tokens).length,
          docs: SEARCH_INDEX.total_docs
        });
      } catch (err) {
        console.warn('Could not load search index, falling back to standard search:', err);
      }
    }

    searchIndex = new MiniSearch({
      idField: 'id',
      fields: ['sammendrag', 'brevtekst', 'sted_all', 'kilde'],
      storeFields: [
        'DN_ref','RN_ref','SDN_ID',
        'regest','sammendrag_raw','brevtekst',
        'date_start','date_end','date_rn_text','date_dn_text',
        'sted_dn','sted_rn','normalized_name','sted_all',
        'kilde','fotnoter','tillegg'
      ],
      searchOptions: { 
        boost:{ sted_all:4, sammendrag:3, brevtekst:2 }, 
        fuzzy: false,
        prefix: true 
      }
    });

    await loadChunk(0);
    loadRemainingChunks();
  } catch (err) {
    console.error('Feil ved initialisering:', err);
    updateStatus('Kunne ikke laste brevsamlingen. Prøv å laste siden på nytt.');
  }
}

async function loadChunkedIndexes(indexMetadata) {
  SEARCH_INDEX = {
    trigrams: {},
    bigrams: {},
    tokens: {},
    total_docs: indexMetadata.total_docs
  };
  
  // Load all trigram chunks
  for (let i = 0; i < indexMetadata.trigram_chunks; i++) {
    const url = `${BASE()}/data/indexes/trigrams-${String(i).padStart(2, '0')}.json`;
    const res = await fetch(url);
    if (res.ok) {
      const chunk = await res.json();
      Object.assign(SEARCH_INDEX.trigrams, chunk);
    }
  }
  
  // Load all token chunks
  for (let i = 0; i < indexMetadata.token_chunks; i++) {
    const url = `${BASE()}/data/indexes/tokens-${String(i).padStart(2, '0')}.json`;
    const res = await fetch(url);
    if (res.ok) {
      const chunk = await res.json();
      Object.assign(SEARCH_INDEX.tokens, chunk);
    }
  }
  
  // Load bigram chunks
  for (let i = 0; i < indexMetadata.bigram_chunks; i++) {
    const url = `${BASE()}/data/indexes/bigrams-${String(i).padStart(2, '0')}.json`;
    const res = await fetch(url);
    if (res.ok) {
      const chunk = await res.json();
      Object.assign(SEARCH_INDEX.bigrams, chunk);
    }
  }
}

async function loadChunk(i) {
  const url = `${BASE()}/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const raw = await res.json();

  const docs = raw.map((row, k) => normalizeLetter(row, i, k));
  allLetters.push(...docs);
  for (const d of docs) DOCS.set(d.id, d);
  searchIndex.addAll(docs);

  chunksLoaded++;
  updateStatus(`Lastet ${chunksLoaded} av ${totalChunks} deler…`);
}

async function loadRemainingChunks() {
  for (let i = 1; i < totalChunks; i++) {
    try { await loadChunk(i); } catch (e) { console.error(`Del ${i} feilet:`, e); }
  }
  updateStatus(`${allLetters.length} brev lastet og klare for søk!`);
}

function normalizeLetter(raw, chunkIndex, rowIndex) {
  const sdn = raw.SDN_ID || raw.SDNID || raw['\ufeffSDNID'] || raw['ï»¿SDNID'] || null;
  const dn  = raw.DN_REF || raw.DN_ref || raw.DNREF || null;
  const rn  = raw.RN_REF || raw.RN_ref || null;

  const regest           = raw.regest || '';
  const sammendrag_raw   = raw.sammendrag || '';
  const sammendrag_index = [sammendrag_raw, regest].filter(Boolean).join(' | ');
  const brevtekst        = raw.brevtekst || '';

  const kildeCombined = [raw.DN_source, raw.RN_source].filter(Boolean).join(' | ');

  const date_start  = raw.date_start || null;
  const date_end    = raw.date_end   || null;
  const date_rn_txt = raw.RN_dato    || '';
  const date_dn_txt = raw.DN_dato    || '';
  const ORD_START   = dateStrToOrd(date_start, false);
  const ORD_END     = dateStrToOrd(date_end, true) ?? ORD_START;

  const sted_dn = raw.DN_sted || '';
  const sted_rn = raw.RN_sted || '';
  const normalized_name = raw.Normalized_name || raw.normalized_name || '';
  const sted_all = [sted_dn, sted_rn, normalized_name].filter(Boolean).join(' | ');

  const fotnoterCombined = [raw.fotnoter_DN, raw.fotnoter_N].filter(Boolean).join('\n');
  const tillegg = raw.Tillegg || raw.tillegg || '';

  const id = `${(dn || sdn || rn || 'doc')}#${chunkIndex}:${rowIndex}`;

  return {
    id,
    DN_ref: dn || undefined,
    RN_ref: rn || undefined,
    SDN_ID: sdn || undefined,
    sammendrag: sammendrag_index,
    sammendrag_raw,
    regest,
    brevtekst,
    date_start, date_end,
    date_rn_text: date_rn_txt,
    date_dn_text: date_dn_txt,
    ORD_START: ORD_START ?? null,
    ORD_END: ORD_END ?? ORD_START ?? null,
    sted_dn, sted_rn, normalized_name, sted_all,
    kilde: kildeCombined,
    fotnoter: fotnoterCombined,
    tillegg,
    _raw: raw
  };
}

// =============== Date helpers ===============
function dateStrToOrd(s, endSide){
  if (!s) return null;
  const str = String(s).trim();
  
  let m = str.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { 
    const y = clampYear(parseInt(m[1], 10)); 
    const mo = clampMonth(parseInt(m[2], 10)); 
    const d = clampDay(y, mo, parseInt(m[3], 10)); 
    return y * 10000 + mo * 100 + d; 
  }
  
  m = str.match(/^(\d{3,4})-(\d{1,2})$/);
  if (m) { 
    const y = clampYear(parseInt(m[1], 10)); 
    const mo = clampMonth(parseInt(m[2], 10)); 
    const d = endSide ? daysInMonth(y, mo) : 1; 
    return y * 10000 + mo * 100 + d; 
  }
  
  m = str.match(/^(\d{3,4})$/);
  if (m) { 
    const y = clampYear(parseInt(m[1], 10)); 
    const mo = endSide ? 12 : 1; 
    const d = endSide ? 31 : 1; 
    return y * 10000 + mo * 100 + d; 
  }
  
  const alt = str.replace(/\./g, '-'); 
  if (alt !== str) return dateStrToOrd(alt, endSide);
  
  return null;
}

function daysInMonth(y, m){ 
  if(m === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28; 
  return [4, 6, 9, 11].includes(m) ? 30 : 31; 
}

function clampYear(y){ return Math.min(Math.max(y, 1), 9999); }
function clampMonth(m){ return Math.min(Math.max(m, 1), 12); }
function clampDay(y, m, d){ return Math.min(Math.max(d, 1), daysInMonth(y, m)); }

function readUIRangeOrd(){
  const fromEl = document.getElementById('date-from');
  const toEl = document.getElementById('date-to');
  const exact = document.getElementById('date-exact')?.checked;

  const fv = (fromEl?.value || '').trim();
  const tv = (toEl?.value || '').trim();

  if(exact){
    if(!fv) return { fromOrd: null, toOrd: null };
    return { fromOrd: dateStrToOrd(fv, false), toOrd: dateStrToOrd(fv, true) };
  }
  const fromOrd = fv ? dateStrToOrd(fv, false) : null;
  const toOrd   = tv ? dateStrToOrd(tv, true)  : null;
  return { fromOrd, toOrd };
}

function fieldListForCheckboxes() {
  const fields = [];
  if (document.getElementById('search-sammendrag')?.checked) fields.push('sammendrag');
  if (document.getElementById('search-brevtekst')?.checked)  fields.push('brevtekst');
  if (document.getElementById('search-sted')?.checked)       fields.push('sted_all');
  if (document.getElementById('search-kilde')?.checked)      fields.push('kilde');
  return fields.length ? fields : ['sammendrag', 'brevtekst', 'sted_all', 'kilde'];
}

// =============== OPTIMIZED Search Execution ===============
function performSearch() {
  const q = (document.getElementById('search-input')?.value || '').trim();
  const { fromOrd: uiFrom, toOrd: uiTo } = readUIRangeOrd();
  const hasDateFilter = (uiFrom != null || uiTo != null);
  const selectedFields = fieldListForCheckboxes();

  const modeEl = document.getElementById('search-mode');
  if (modeEl) searchMode = modeEl.value;
  
  const fuzzyEl = document.getElementById('fuzzy-distance');
  if (fuzzyEl) fuzzyDistance = parseInt(fuzzyEl.value, 10);

  let results = [];
  const startTime = performance.now();

  if (!q && !hasDateFilter) {
    currentResultsAll = [];
    currentPage = 1;
    updateResults([]);
    renderPagination(0);
    setExportEnabled(false);
    return;
  }

  if (!q && hasDateFilter) {
    results = allLetters.filter(doc => dateMatches(doc, uiFrom, uiTo));
    console.log(`Date-only: ${results.length} results in ${(performance.now() - startTime).toFixed(1)}ms`);
  } else if (searchMode === 'exact') {
    const miniResults = searchIndex.search(q, { 
      fields: selectedFields, 
      combineWith: 'AND',
      fuzzy: false,
      prefix: false
    });
    
    const resultIds = new Set(miniResults.map(r => r.id));
    results = allLetters.filter(doc => {
      if (!resultIds.has(doc.id)) return false;
      if (hasDateFilter && !dateMatches(doc, uiFrom, uiTo)) return false;
      return true;
    });
    console.log(`Exact: ${results.length} results in ${(performance.now() - startTime).toFixed(1)}ms`);
  } else {
    // OPTIMIZED FUZZY SEARCH
    const queryTokens = tokenizeCanonical(q);
    const threshold = thresholdFor(fuzzyDistance);
    
    // Use pre-computed indexes to get candidates
    const candidates = SEARCH_INDEX ? getCandidatesFromIndexes(q, 3000) : null;
    
    if (candidates) {
      console.log(`Index returned ${candidates.size} candidates`);
    }
    
    // Filter candidates (or all docs if no index)
    const docsToCheck = candidates ? 
      allLetters.filter(d => candidates.has(parseInt(d.id.split('#')[1].split(':')[0]) * 1000 + parseInt(d.id.split(':')[1]))) :
      allLetters;
    
    results = docsToCheck.filter(doc => {
      if (!docMatchesFuzzy(doc, queryTokens, selectedFields, threshold, candidates)) return false;
      if (hasDateFilter && !dateMatches(doc, uiFrom, uiTo)) return false;
      return true;
    });
    
    const elapsed = (performance.now() - startTime).toFixed(1);
    console.log(`Fuzzy (level ${fuzzyDistance}): ${results.length} results in ${elapsed}ms${candidates ? ` (from ${candidates.size} candidates)` : ''}`);
  }

  currentResultsAll = results.map(r => Object.assign({}, r, { query: q }));
  currentPage = 1;
  renderPage();
  setExportEnabled(currentResultsAll.length > 0);
  
  // Clear cache periodically to prevent memory bloat
  if (DISTANCE_CACHE.size > MAX_CACHE_SIZE * 2) {
    DISTANCE_CACHE.clear();
  }
}

function dateMatches(doc, fromOrd, toOrd) {
  if (fromOrd == null && toOrd == null) return true;
  
  const docStart = doc.ORD_START;
  const docEnd = doc.ORD_END || doc.ORD_START;
  
  if (docStart == null) return false;
  
  const filterStart = fromOrd ?? -Infinity;
  const filterEnd = toOrd ?? Infinity;
  
  return docStart <= filterEnd && (docEnd || docStart) >= filterStart;
}

function renderPage(){
  const total = currentResultsAll.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if(currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, total);
  currentResultsShown = currentResultsAll.slice(start, end);
  updateResults(currentResultsShown, start + 1, end, total);
  renderPagination(total);
}

// =============== Highlighting (unchanged) ===============
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function highlightExact(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const rx = new RegExp(escapeRegex(query), 'gi');
  return escaped.replace(rx, '<mark>$&</mark>');
}

function markHyphenPairs(text, shouldMarkCombined) {
  const rx = /([A-Za-zæøåäöáéíóúýþðœçàèìòùâêîôûãõüß]+)-(\s+)([A-Za-zæøåäöáéíóúýþðœçàèìòùâêîôûãõüß]+)/gi;
  return (text || '').replace(rx, (m, a, ws, b) => 
    shouldMarkCombined((a + b).toLowerCase()) ? '<mark>' + a + '-' + ws + b + '</mark>' : m
  );
}

function highlightOutsideMarks(html, highlighterFn) {
  const parts = html.split(/(<mark>.*?<\/mark>)/gis);
  return parts.map(seg => (seg.toLowerCase().startsWith('<mark>') ? seg : highlighterFn(seg))).join('');
}

function highlightFuzzy(text, queryTokens, fuzzyDistSetting) {
  if (queryTokens.length === 0) return escapeHtml(text);
  const th = thresholdFor(fuzzyDistSetting);
  
  const withPairs = markHyphenPairs(text, (joined) => {
    for (const q of queryTokens) 
      if (getCachedDistance(q, joined) <= th) return true;
    return false;
  });
  
  const tokenRx = /[a-zæøåäöáéíóúýþðœçàèìòùâêîôûãõüß\-]+/gi;
  return highlightOutsideMarks(escapeHtml(withPairs), (frag) => {
    return frag.replace(tokenRx, (m) => {
      let best = Infinity;
      for (const q of queryTokens) {
        const d = getCachedDistance(q, m.toLowerCase());
        if (d < best) best = d;
        if (best === 0) break;
      }
      return best <= th ? '<mark>' + m + '</mark>' : m;
    });
  });
}

// =============== Rendering (unchanged) ===============
function updateResults(results, from = 0, to = 0, total = 0){
  const container = document.getElementById('search-results');
  if (!container) return;
  if (!results || !results.length) { 
    container.innerHTML = '<p>Ingen treff</p>'; 
    return; 
  }

  const query = results[0]?.query || '';
  const queryTokens = tokenizeCanonical(query);

  const html = `
    <p class="result-count">Viser ${from}–${to} av ${total} treff</p>
    <div class="result-list">
      ${results.map(r => {
        const bestDate = r.date_rn_text?.trim() || r.date_dn_text?.trim() || formatDateRange(r.date_start, r.date_end);
        const archaic = dnToArchaic(r.DN_ref);
        const stedBest = r.normalized_name || r.sted_dn || r.sted_rn || 'Ukjent sted';
        
        const regestPreview = r.regest?.trim() ? 
          snippet(searchMode === 'fuzzy' ? highlightFuzzy(r.regest, queryTokens, fuzzyDistance) : highlightExact(r.regest, query), 220, true) : 
          (r.sammendrag_raw ? 
            snippet(searchMode === 'fuzzy' ? highlightFuzzy(r.sammendrag_raw, queryTokens, fuzzyDistance) : highlightExact(r.sammendrag_raw, query), 220, true) : '');
        
        return `
        <div class="search-result" data-id="${r.id}">
          <div class="idline">
            <span class="dn-code">${escapeHtml(r.DN_ref || r.RN_ref || 'Uten referanse')}</span>
            <span class="dn-archaic">${escapeHtml(archaic)}</span>
          </div>
          <h3><button class="toggle-details" aria-expanded="false">Vis fulltekst</button></h3>
          <p class="meta">${escapeHtml(bestDate)} – ${escapeHtml(stedBest)}</p>
          ${regestPreview ? `<p class="summary"><em>${regestPreview}</em></p>` : ''}
          <div class="details" style="display:none;">
            <p>
              <strong>Regest dato:</strong> ${escapeHtml(r.date_rn_text || '–')}
              &nbsp;&nbsp;<strong>Diplomatarium dato:</strong> ${escapeHtml(r.date_dn_text || '–')}
            </p>
            <p>
              <strong>RN_sted:</strong> ${escapeHtml(r.sted_rn || '–')}
              &nbsp;&nbsp;<strong>DN_sted:</strong> ${escapeHtml(r.sted_dn || '–')}
              &nbsp;&nbsp;<strong>Normalisert:</strong> ${escapeHtml(r.normalized_name || '–')}
            </p>
            ${section('Regest', r.regest, queryTokens, query)}
            ${section('Sammendrag', r.sammendrag_raw, queryTokens, query)}
            ${section('Brevtekst', r.brevtekst, queryTokens, query)}
            ${section('Kilde (DN/RN)', r.kilde, queryTokens, query)}
            ${section('Fotnoter', r.fotnoter, queryTokens, query)}
            ${section('Tillegg', r.tillegg, queryTokens, query)}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  container.innerHTML = html;
}

function section(label, content, queryTokens, query) {
  if (!content || !String(content).trim()) return '';
  const highlighted = searchMode === 'fuzzy' ? 
    highlightFuzzy(String(content), queryTokens, fuzzyDistance) : 
    highlightExact(String(content), query);
  return `<span class="section-label">${escapeHtml(label)}</span><div class="${label.toLowerCase().replace(/[^a-z]/g, '')}">${highlighted}</div>`;
}

function renderPagination(total){
  const bar = document.getElementById('results-pagination'); 
  if (!bar) return;
  if (!total) { 
    bar.style.display = 'none'; 
    bar.innerHTML = ''; 
    return; 
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE)); 
  bar.style.display = 'flex';
  const nums = paginationWindow(currentPage, totalPages, 2);
  const btn = (label, page, disabled = false, cls = '') => `<button class="page-btn ${cls}" data-page="${page}"${disabled ? ' disabled' : ''}>${label}</button>`;
  const numsHtml = nums.map(n => (n === '…') ? `<span class="ellipsis">…</span>` :
    `<button class="page-num${n === currentPage ? ' active' : ''}" data-page="${n}">${n}</button>`).join('');
  bar.innerHTML = [
    btn('« Første', 1, currentPage === 1, 'first'),
    btn('‹ Forrige', Math.max(1, currentPage - 1), currentPage === 1, 'prev'),
    numsHtml,
    btn('Neste ›', Math.min(totalPages, currentPage + 1), currentPage === totalPages, 'next'),
    btn('Siste »', totalPages, currentPage === totalPages, 'last')
  ].join('');
}

function paginationWindow(curr, total, spread = 2){
  const out = []; 
  const add = x => { if (!out.includes(x)) out.push(x); };
  add(1); 
  for (let i = curr - spread; i <= curr + spread; i++) if (i > 1 && i < total) add(i); 
  if (total > 1) add(total);
  out.sort((a, b) => a - b);
  const withDots = []; 
  for (let i = 0; i < out.length; i++) { 
    withDots.push(out[i]); 
    if (i < out.length - 1 && out[i + 1] - out[i] > 1) withDots.push('…'); 
  }
  return withDots;
}

// =============== Event wiring ===============
function wireListeners(){
  const input = document.getElementById('search-input');
  const button = document.getElementById('search-btn');
  const debounced = () => { 
    clearTimeout(debounceTimer); 
    debounceTimer = setTimeout(performSearch, 200); 
  };
  
  if (input) { 
    input.addEventListener('input', debounced); 
    input.addEventListener('keydown', e => { if (e.key === 'Enter') performSearch(); }); 
  }
  if (button) button.addEventListener('click', performSearch);
  
  document.querySelectorAll('.search-filters input').forEach(cb => cb.addEventListener('change', performSearch));

  const modeSelect = document.getElementById('search-mode');
  const fuzzyBlock = document.getElementById('fuzzy-controls');
  const fuzzySlider = document.getElementById('fuzzy-distance');
  
  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      searchMode = modeSelect.value;
      if (fuzzyBlock) fuzzyBlock.style.display = searchMode === 'fuzzy' ? 'flex' : 'none';
      performSearch();
    });
  }
  
  if (fuzzySlider) {
    fuzzySlider.addEventListener('input', () => {
      fuzzyDistance = parseInt(fuzzySlider.value, 10);
      const label = document.getElementById('fuzzy-label');
      if (label) {
        const labels = ['Streng', 'Moderat', 'Avslappet', 'Veldig avslappet'];
        label.textContent = labels[fuzzyDistance] || 'Moderat';
      }
      performSearch();
    });
  }

  const df = document.getElementById('date-from');
  const dt = document.getElementById('date-to');
  const ex = document.getElementById('date-exact');
  const rs = document.getElementById('date-reset');

  const debounceDates = () => { 
    clearTimeout(debounceTimer); 
    debounceTimer = setTimeout(performSearch, 100); 
  };

  if (df) {
    df.addEventListener('input', debounceDates);
    df.addEventListener('input', () => {
      df.style.borderColor = 'var(--c-sand)';
      setTimeout(() => { df.style.borderColor = 'var(--c-olive)'; }, 300);
    });
  }
  
  if (dt) {
    dt.addEventListener('input', debounceDates);
    dt.addEventListener('input', () => {
      dt.style.borderColor = 'var(--c-sand)';
      setTimeout(() => { dt.style.borderColor = 'var(--c-olive)'; }, 300);
    });
  }
  
  if (ex) {
    ex.addEventListener('change', () => {
      if (ex.checked) { 
        if (dt) { 
          dt.value = ''; 
          dt.disabled = true;
          dt.style.opacity = '0.5';
        } 
      } else { 
        if (dt) {
          dt.disabled = false;
          dt.style.opacity = '1';
        }
      }
      performSearch();
    });
  }
  
  if (rs) {
    rs.addEventListener('click', () => {
      if (df) df.value = ''; 
      if (dt) { 
        dt.value = ''; 
        dt.disabled = false;
        dt.style.opacity = '1';
      } 
      if (ex) ex.checked = false;
      performSearch();
    });
  }
}

function wireResultsList(){
  const container = document.getElementById('search-results');
  if (!container) return;
  container.addEventListener('click', (ev) => {
    const toggle = ev.target.closest('.toggle-details'); 
    if (!toggle) return;
    const item = ev.target.closest('.search-result'); 
    const details = item.querySelector('.details');
    const show = details.style.display === 'none' || !details.style.display;
    details.style.display = show ? 'block' : 'none';
    toggle.textContent = show ? 'Skjul fulltekst' : 'Vis fulltekst';
    toggle.setAttribute('aria-expanded', String(show));
    ev.preventDefault();
  });
}

function wirePagination(){
  const bar = document.getElementById('results-pagination'); 
  if (!bar) return;
  bar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-page]'); 
    if (!btn) return;
    const page = Number(btn.getAttribute('data-page')); 
    if (!Number.isFinite(page)) return;
    currentPage = page; 
    renderPage();
    document.querySelector('.search-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// =============== Export ===============
function wireExportBar(){
  const bar = document.getElementById('export-bar'); 
  if (!bar) return;
  document.getElementById('export-csv')?.addEventListener('click', () => { 
    if (!currentResultsAll.length) return; 
    const csv = toCSV_fromRaw(currentResultsAll); 
    downloadText(csv, 'sok-treff.csv', {addBOM: true}); 
  });
  document.getElementById('export-txt')?.addEventListener('click', () => { 
    if (!currentResultsAll.length) return; 
    const txt = toTXT_likeDetails(currentResultsAll); 
    downloadText(txt, 'sok-treff.txt'); 
  });
}

function setExportEnabled(on){ 
  const bar = document.getElementById('export-bar'); 
  if (!bar) return; 
  bar.style.display = 'flex'; 
  const csvBtn = document.getElementById('export-csv');
  const txtBtn = document.getElementById('export-txt');
  if (csvBtn) csvBtn.disabled = !on; 
  if (txtBtn) txtBtn.disabled = !on; 
}

function toTXT_likeDetails(rows){
  const parts = []; 
  for (const r of rows) {
    const headL = r.DN_ref || r.RN_ref || 'Uten referanse'; 
    const headR = dnToArchaic(r.DN_ref) || '';
    const dateLine = (r.date_rn_text?.trim() || r.date_dn_text?.trim() || formatDateRange(r.date_start, r.date_end));
    const placeBits = [
      r.sted_rn ? `RN_sted: ${r.sted_rn}` : null,
      r.sted_dn ? `DN_sted: ${r.sted_dn}` : null,
      r.normalized_name ? `Normalisert: ${r.normalized_name}` : null
    ].filter(Boolean).join(' | ');
    const bits = [
      `${headL}    ${headR}`,
      `${dateLine}${placeBits ? ' – ' + placeBits : ''}`,
      `Regest dato: ${r.date_rn_text || '–'}    Diplomatarium dato: ${r.date_dn_text || '–'}`,
      `date_start: ${r.date_start || ''}    date_end: ${r.date_end || ''}`
    ];
    if (r.regest?.trim()) bits.push('', 'REGEST:', r.regest);
    if (r.sammendrag_raw?.trim()) bits.push('', 'SAMMENDRAG:', r.sammendrag_raw);
    if (r.brevtekst?.trim()) bits.push('', 'BREVTEKST:', r.brevtekst);
    if (r.kilde?.trim()) bits.push('', 'KILDE (DN/RN):', r.kilde);
    if (r.fotnoter?.trim()) bits.push('', 'FOTNOTER:', r.fotnoter);
    if (r.tillegg?.trim()) bits.push('', 'TILLEGG:', r.tillegg);
    parts.push(bits.join('\n'));
  } 
  return parts.join('\n\n---\n\n');
}

function toCSV_fromRaw(rows){
  const keySet = new Set(); 
  for (const r of rows) { 
    const raw = r._raw || {}; 
    for (const k of Object.keys(raw)) keySet.add(k); 
  }
  const preferred = [
    '\ufeffSDNID', 'SDNID', 'SDN_ID',
    'DN_REF', 'DN_ref', 'RN_REF', 'RN_ref',
    'sammendrag', 'regest',
    'DN_source', 'RN_source',
    'DN_dato', 'RN_dato',
    'DN_sted', 'RN_sted', 'Normalized_name',
    'brevtekst', 'fotnoter_DN', 'fotnoter_N', 'Tillegg',
    'date_start', 'date_end', 'lat', 'lon', 'uncertain_loc'
  ];
  const presentPreferred = preferred.filter(k => keySet.has(k));
  const remaining = Array.from(keySet).filter(k => !presentPreferred.includes(k)).sort();
  const headers = [...presentPreferred, ...remaining];
  const esc = v => `"${String(v ?? '').replace(/\r?\n/g, '\n').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')];
  for (const r of rows) { 
    const raw = r._raw || {}; 
    lines.push(headers.map(h => esc(raw[h])).join(',')); 
  }
  return lines.join('\r\n');
}

// =============== Utilities ===============
function formatDateRange(start, end){
  const ys = parseYear(start); 
  const ye = (parseYear(end) ?? ys);
  if (ys && ye) return ys === ye ? String(ys) : `${ys}–${ye}`; 
  if (ys) return String(ys); 
  if (ye) return String(ye); 
  return 'Ukjent';
}

function parseYear(s){ 
  const m = String(s || '').match(/^(\d{4})/); 
  return m ? Number(m[1]) : null; 
}

function escapeHtml(s){ 
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); 
}

function dnToArchaic(dn){ 
  if (!dn) return ''; 
  const m = String(dn).match(/^DN(\d{3})(\d{5})$/i); 
  if (!m) return ''; 
  const vol = parseInt(m[1], 10), num = parseInt(m[2], 10); 
  return `Diplomatarium Norvegicum ${toRoman(vol)}, ${num}`; 
}

function toRoman(num){ 
  if (!Number.isFinite(num) || num <= 0) return ''; 
  const map = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; 
  let out = ''; 
  for (const [v, s] of map) { 
    while (num >= v) { 
      out += s; 
      num -= v; 
    } 
  } 
  return out; 
}

function downloadText(text, filename, opts = {}){ 
  const parts = []; 
  if (opts.addBOM) parts.push('\uFEFF'); 
  parts.push(text); 
  const blob = new Blob(parts, {type: 'text/plain;charset=utf-8'}); 
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

function snippet(t, n, isHtml = false){ 
  if (isHtml) {
    const temp = document.createElement('div');
    temp.innerHTML = t;
    const text = temp.textContent || temp.innerText || '';
    if (text.length <= n) return t;
    let charCount = 0;
    const parts = t.split(/(<[^>]+>)/);
    let result = '';
    for (const part of parts) {
      if (part.startsWith('<')) {
        result += part;
      } else {
        if (charCount + part.length <= n) {
          result += part;
          charCount += part.length;
        } else {
          const remaining = n - charCount;
          result += part.slice(0, remaining).replace(/\s+\S*$/, '');
          break;
        }
      }
    }
    return result + '…';
  }
  const s = String(t || '').trim(); 
  if (!s) return ''; 
  return s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…'; 
}