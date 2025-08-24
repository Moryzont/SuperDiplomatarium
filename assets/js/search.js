/* global MiniSearch, document, window, fetch */

// =============== Globals ===============
let searchIndex = null;
let allLetters = [];
let DOCS = new Map();          // id -> doc (authoritative store, includes _raw)
let chunksLoaded = 0;
let totalChunks = 0;
let debounceTimer = null;

let currentResultsAll = [];    // full set of matches (for export)
let currentResultsShown = [];  // top N rendered

document.addEventListener('DOMContentLoaded', async () => {
  await initializeSearch();
  wireListeners();
  wireResultsList();
  wireExportBar();
});

// baseurl helper
function BASE() { return (window.SITE_BASE || '').replace(/\/+$/, ''); }

function updateStatus(msg) {
  const el = document.getElementById('search-status');
  if (el) el.textContent = msg;
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

    // index
    searchIndex = new MiniSearch({
      idField: 'id',
      fields: ['sammendrag', 'brevtekst', 'sted_all', 'kilde'],
      storeFields: [
        'DN_ref', 'SDN_ID',
        'sammendrag', 'brevtekst',
        'original_dato', 'original_sted', 'normalized_name',
        'date_start', 'date_end', 'sted_all',
        'fotnoter', 'tillegg', 'kilde'
      ],
      searchOptions: {
        boost: { sted_all: 4, sammendrag: 3, brevtekst: 2 },
        fuzzy: 0.2,
        prefix: true
      }
    });

    await loadChunk(0);   // usable immediately
    loadRemainingChunks(); // background
  } catch (err) {
    console.error('Feil ved initialisering:', err);
    updateStatus('Kunne ikke laste brevsamlingen. Prøv å laste siden på nytt.');
  }
}

async function loadChunk(i) {
  const url = `${BASE()}/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const raw = await res.json();

  const docs = raw.map((row, k) => normalizeLetter(row, i, k));
  allLetters.push(...docs);
  for (const d of docs) DOCS.set(d.id, d);     // -> fast, reliable lookups
  searchIndex.addAll(docs);

  chunksLoaded++;
  updateStatus(`Lastet ${chunksLoaded} av ${totalChunks} deler…`);
}

async function loadRemainingChunks() {
  for (let i = 1; i < totalChunks; i++) {
    try { await loadChunk(i); }
    catch (e) { console.error(`Del ${i} feilet:`, e); }
  }
  updateStatus(`${allLetters.length} brev lastet og klare for søk!`);
}

function normalizeLetter(raw, chunkIndex, rowIndex) {
  const sdn = raw.SDN_ID || raw.SDNID || raw['\ufeffSDNID'] || raw['﻿SDNID'] || null;
  const dn  = raw.DN_ref || raw.DN_REF || raw.DNREF || null;

  const original_dato = raw.original_dato || raw.dato || null;
  const original_sted = raw.original_sted || raw.sted || null;
  const normalized_name = raw.Normalized_name || raw.normalized_name || null;

  const fotnoter = raw.fotnoter || raw.Fotnoter || '';
  const tillegg  = raw.tillegg  || raw.Tillegg  || '';
  const kilde    = raw.kilde    || raw.Kilde    || '';

  const id = `${(dn || sdn || 'doc')}#${chunkIndex}:${rowIndex}`; // unique
  const sted_all = [original_sted, normalized_name].filter(Boolean).join(' | ');

  return {
    id,
    // normalized for searching + UI
    DN_ref: dn || undefined,
    SDN_ID: sdn || undefined,
    sammendrag: raw.sammendrag || '',
    brevtekst: raw.brevtekst || '',
    original_dato,
    original_sted,
    normalized_name,
    sted_all,
    kilde,
    fotnoter,
    tillegg,
    date_start: raw.date_start || null,
    date_end: raw.date_end || null,
    // preserve original row for CSV export
    _raw: raw
  };
}

// =============== Query parsing & helpers ===============

function parseQuery(q) {
  const orGroups = [];
  const groups = splitByOr(q);
  for (const g of groups) {
    const group = { must: [], not: [], filters: {} };
    const parts = tokenize(g);
    for (const part of parts) {
      if (/^year:\d{3,4}\.\.\d{3,4}$/i.test(part)) {
        const [from, to] = part.split(':')[1].split('..').map(Number);
        group.filters.yearFrom = from; group.filters.yearTo = to; continue;
      }
      if (/^before:\d{3,4}$/i.test(part)) { group.filters.yearTo = Number(part.split(':')[1]); continue; }
      if (/^after:\d{3,4}$/i.test(part))  { group.filters.yearFrom = Number(part.split(':')[1]); continue; }

      const m = part.match(/^([a-z_]+):(.*)$/i);
      let field = null, term = part, isPhrase = false, neg = false;
      if (m) { field = m[1].toLowerCase(); term = m[2]; }
      if (/^NOT\s+/i.test(term)) { neg = true; term = term.replace(/^NOT\s+/i, ''); }
      if (term.startsWith('-')) { neg = true; term = term.slice(1); }
      const quoted = term.match(/^"(.*)"$/);
      if (quoted) { isPhrase = true; term = quoted[1]; }
      const node = { field, term, isPhrase };
      if (neg) group.not.push(node); else group.must.push(node);
    }
    orGroups.push(group);
  }
  return orGroups;
}

function tokenize(s) {
  const out = []; let buf = ''; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { buf += ch; inQ = !inQ; continue; }
    if (!inQ && /\s/.test(ch)) { if (buf.trim()) out.push(buf.trim()); buf = ''; }
    else { buf += ch; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function splitByOr(s) {
  const out = []; let buf = ''; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inQ = !inQ; buf += ch; continue; }
    if (!inQ && s.slice(i, i + 2).toUpperCase() === 'OR' &&
        /\s/.test(s[i - 1] || ' ') && /\s/.test(s[i + 2] || ' ')) {
      out.push(buf.trim()); buf = ''; i += 1;
    } else buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function norm(s) {
  return (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function fieldListForCheckboxes() {
  const fields = [];
  if (document.getElementById('search-sammendrag').checked) fields.push('sammendrag');
  if (document.getElementById('search-brevtekst').checked)  fields.push('brevtekst');
  if (document.getElementById('search-sted').checked)       fields.push('sted_all');
  if (document.getElementById('search-kilde').checked)      fields.push('kilde');
  return fields.length ? fields : ['sammendrag','brevtekst','sted_all','kilde'];
}

function mapScopedField(f) {
  if (!f) return null;
  const m = {
    'sammendrag': 'sammendrag',
    'brevtekst': 'brevtekst',
    'sted': 'sted_all',
    'kilde': 'kilde',
    'dn': 'DN_ref',
    'sdn': 'SDN_ID'
  };
  return m[f] || null;
}

// =============== Execution ===============
function performSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!searchIndex || q.length < 2) {
    currentResultsAll = [];
    updateResults([]);
    setExportEnabled(false);
    return;
  }

  const orGroups = parseQuery(q);
  const selectedFields = fieldListForCheckboxes();

  // union over OR groups; each group is ANDed
  let unionMap = new Map(); // id -> score
  for (const group of orGroups) {
    const set = runAndGroup(group, selectedFields);
    for (const [id, score] of set) unionMap.set(id, Math.max(unionMap.get(id) || 0, score));
  }

  // to array & sort (do not slice yet; we keep all for export)
  currentResultsAll = Array.from(unionMap.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .map(r => Object.assign({}, DOCS.get(r.id) || {}, { score: r.score }));

  // Show only top N for UI
  currentResultsShown = currentResultsAll.slice(0, 50);
  updateResults(currentResultsShown);

  setExportEnabled(currentResultsAll.length > 0);
}

// AND a single group: intersect required terms, apply NOTs and year filters
function runAndGroup(group, selectedFields) {
  const mustSets = [];
  for (const term of group.must) {
    const fields = mapScopedField(term.field) ? [mapScopedField(term.field)] : selectedFields;
    mustSets.push(searchForNode(term, fields));
  }

  // if no positive terms, start from all docs (rare)
  let acc = mustSets.length ? mustSets[0] : allDocsAsSet();
  for (let i = 1; i < mustSets.length; i++) acc = intersectScoreMaps(acc, mustSets[i]);

  // apply NOTs
  for (const n of group.not) {
    const fields = mapScopedField(n.field) ? [mapScopedField(n.field)] : selectedFields;
    const exclude = searchForNode(n, fields);
    for (const id of exclude.keys()) acc.delete(id);
  }

  // year filters (overlap test on date_start/date_end)
  const from = group.filters.yearFrom ?? -Infinity;
  const to   = group.filters.yearTo   ?? +Infinity;
  for (const id of Array.from(acc.keys())) {
    const doc = DOCS.get(id);
    const s = parseYear(doc?.date_start);
    const e = parseYear(doc?.date_end) ?? s;
    const overlaps = (s ?? e ?? -Infinity) <= to && (e ?? s ?? +Infinity) >= from;
    if (!overlaps) acc.delete(id);
  }

  return acc;
}

function parseYear(s) { const m = String(s || '').match(/^(\d{4})/); return m ? Number(m[1]) : null; }

function allDocsAsSet() {
  const m = new Map();
  for (const id of DOCS.keys()) m.set(id, 1);
  return m;
}

// Single node search → Map(id -> score)
function searchForNode(node, fields) {
  // exact ID lookups (dn:, sdn:)
  if (fields.length === 1 && (fields[0] === 'DN_ref' || fields[0] === 'SDN_ID')) {
    const needle = norm(node.term);
    const m = new Map();
    for (const d of DOCS.values()) {
      const val = norm(d[fields[0]]);
      if (val && val === needle) m.set(d.id, 100); // high score
    }
    return m;
  }

  if (node.isPhrase) return phraseSearch(node.term, fields);

  const res = searchIndex.search(node.term, { fields, limit: 100000, combineWith: 'AND' });
  const m = new Map();
  for (const r of res) m.set(r.id, Math.max(m.get(r.id) || 0, r.score || 1));
  return m;
}

// Exact phrase: narrow by token search, then do normalized substring on DOCS
function phraseSearch(phrase, fields) {
  const words = phrase.split(/\s+/).filter(Boolean);
  let candidateMap = null;

  for (const w of words) {
    const res = searchIndex.search(w, { fields, limit: 100000, combineWith: 'AND' });
    const m = new Map();
    for (const r of res) m.set(r.id, Math.max(m.get(r.id) || 0, r.score || 1));
    candidateMap = candidateMap ? intersectScoreMaps(candidateMap, m) : m;
    if (!candidateMap.size) break;
  }
  if (!candidateMap || !candidateMap.size) return new Map();

  const needle = norm(phrase);
  const out = new Map();

  for (const id of candidateMap.keys()) {
    const doc = DOCS.get(id);
    for (const f of fields) {
      const hay = norm(doc?.[f] || '');
      if (hay.includes(needle)) {
        out.set(id, Math.max(out.get(id) || 0, (candidateMap.get(id) || 1) + 5));
        break;
      }
    }
  }
  return out;
}

function intersectScoreMaps(a, b) {
  const out = new Map();
  for (const [id, sa] of a.entries()) if (b.has(id)) out.set(id, sa + (b.get(id) || 0));
  return out;
}

// =============== Rendering & wiring ===============
function updateResults(results) {
  const container = document.getElementById('search-results');
  if (!container) return;

  if (!results || !results.length) {
    container.innerHTML = '<p>Ingen treff</p>';
    return;
  }

  const html = `
    <p class="result-count">Viser ${results.length} av ${currentResultsAll.length} treff</p>
    <div class="result-list">
      ${results.map(r => {
        const humanDate = formatDateRange(r.date_start, r.date_end, r.original_dato);
        const archaic = dnToArchaic(r.DN_ref);
        return `
        <div class="search-result" data-id="${r.id}">
          <div class="idline">
            <span class="dn-code">${escapeHtml(r.DN_ref || 'Uten referanse')}</span>
            <span class="dn-archaic">${escapeHtml(archaic)}</span>
          </div>
          <h3>
            <button class="toggle-details" aria-expanded="false">Vis fulltekst</button>
          </h3>
          <p class="meta">${escapeHtml(humanDate)} – ${escapeHtml(r.normalized_name || r.original_sted || 'Ukjent sted')}</p>

          <div class="details" style="display:none;">
            <p><strong>date_start:</strong> ${escapeHtml(r.date_start || '')}
               &nbsp;&nbsp;<strong>date_end:</strong> ${escapeHtml(r.date_end || '')}
               &nbsp;&nbsp;<strong>Sted:</strong> ${escapeHtml(r.original_sted || 'Ukjent')}
               &nbsp;&nbsp;<strong>Normalisert:</strong> ${escapeHtml(r.normalized_name || '—')}
            </p>

            ${section('Sammendrag', r.sammendrag, 'sammendrag')}
            ${section('Brevtekst',   r.brevtekst,  'brevtekst')}
            ${section('Fotnoter',    r.fotnoter,   'fotnoter')}
            ${section('Tillegg',     r.tillegg,    'tillegg')}
          </div>
        </div>`;
      }).join('')}
    </div>
  `;

  container.innerHTML = html;
}

function section(label, content, cls) {
  if (!content || !String(content).trim()) return '';
  return `<span class="section-label">${escapeHtml(label)}</span>
          <div class="${cls}">${escapeHtml(String(content))}</div>`;
}

function truncate(text, n) { return !text ? '' : (text.length <= n ? text : text.slice(0, n) + '…'); }

function wireListeners() {
  const input = document.getElementById('search-input');
  const button = document.getElementById('search-btn');
  const debounced = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(performSearch, 200); };
  if (input)  input.addEventListener('input', debounced);
  if (button) button.addEventListener('click', performSearch);
  document.querySelectorAll('.search-filters input').forEach(cb => cb.addEventListener('change', performSearch));
}

function wireResultsList() {
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

// =============== Export (CSV/TXT) ===============
function wireExportBar() {
  const bar = document.getElementById('export-bar');
  if (!bar) return;
  document.getElementById('export-csv').addEventListener('click', () => {
    if (!currentResultsAll.length) return;
    const csv = toCSV_fromRaw(currentResultsAll);
    downloadText(csv, 'sok-treff.csv', { addBOM: true });
  });
  document.getElementById('export-txt').addEventListener('click', () => {
    if (!currentResultsAll.length) return;
    const txt = toTXT_likeDetails(currentResultsAll);
    downloadText(txt, 'sok-treff.txt');
  });
}

function setExportEnabled(on) {
  const bar = document.getElementById('export-bar');
  if (!bar) return;
  bar.style.display = 'flex';
  document.getElementById('export-csv').disabled = !on;
  document.getElementById('export-txt').disabled = !on;
}

// TXT: mirror the details box; include BOTH original sted and Normalized_name
function toTXT_likeDetails(rows) {
  const parts = [];
  for (const r of rows) {
    const headerLeft  = r.DN_ref || 'Uten referanse';
    const headerRight = dnToArchaic(r.DN_ref) || '';
    const dateLine = formatDateRange(r.date_start, r.date_end, r.original_dato);
    const placeOrig = r.original_sted || 'Ukjent';
    const placeNorm = r.normalized_name || '—';

    const bits = [];
    bits.push(`${headerLeft}    ${headerRight}`);
    bits.push(`${dateLine} — Sted: ${placeOrig} | Normalisert: ${placeNorm}`);
    bits.push(`date_start: ${r.date_start || ''}    date_end: ${r.date_end || ''}`);

    if (r.sammendrag && String(r.sammendrag).trim()) { bits.push('', 'SAMMENDRAG:', r.sammendrag); }
    if (r.brevtekst  && String(r.brevtekst ).trim()) { bits.push('', 'BREVTEKST:',  r.brevtekst ); }
    if (r.fotnoter   && String(r.fotnoter  ).trim()) { bits.push('', 'FOTNOTER:',   r.fotnoter  ); }
    if (r.tillegg    && String(r.tillegg   ).trim()) { bits.push('', 'TILLEGG:',    r.tillegg   ); }

    parts.push(bits.join('\n'));
  }
  return parts.join('\n\n---\n\n');
}

// CSV: union of keys from original JSON rows (_raw), preserving names
function toCSV_fromRaw(rows) {
  const keySet = new Set();
  for (const r of rows) {
    const raw = r._raw || {};
    for (const k of Object.keys(raw)) keySet.add(k);
  }

  // Optional preferred order first (only if present), then the rest alpha
  const preferred = [
    '\ufeffSDNID','SDNID','SDN_ID','DN_REF','DN_ref','DNREF',
    'sammendrag','kilde','nummer','dato','sted','brevtekst','fotnoter','tillegg','sidetall_bind',
    'date_start','date_end','Normalized_name','normalized_name',
    'lat','lon','LAT','LON','Region','Problem'
  ];
  const presentPreferred = preferred.filter(k => keySet.has(k));
  const remaining = Array.from(keySet).filter(k => !presentPreferred.includes(k)).sort();
  const headers = [...presentPreferred, ...remaining];

  const esc = (v) => {
    const s = String(v ?? '').replace(/\r?\n/g, '\n').replace(/"/g, '""');
    return `"${s}"`;
    };
  const lines = [headers.join(',')];

  for (const r of rows) {
    const raw = r._raw || {};
    const line = headers.map(h => esc(raw[h])).join(',');
    lines.push(line);
  }
  return lines.join('\r\n');
}

// =============== Small utils used above ===============
function formatDateRange(start, end, original) {
  if (original && String(original).trim()) return String(original);
  const ys = parseYear(start);
  const ye = parseYear(end) ?? ys;
  if (ys && ye) return ys === ye ? String(ys) : `${ys}–${ye}`;
  if (ys) return String(ys);
  if (ye) return String(ye);
  return 'Ukjent';
}
function parseYear(s) { const m = String(s || '').match(/^(\d{4})/); return m ? Number(m[1]) : null; }
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function dnToArchaic(dn) {
  if (!dn) return '';
  const m = String(dn).match(/^DN(\d{3})(\d{5})$/i);
  if (!m) return '';
  const vol = parseInt(m[1], 10);
  const num = parseInt(m[2], 10);
  return `Diplomatarium Norvegicum ${toRoman(vol)}, ${num}`;
}
function toRoman(num) {
  if (!Number.isFinite(num) || num <= 0) return '';
  const map = [
    [1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],
    [100,'C'],[90,'XC'],[50,'L'],[40,'XL'],
    [10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']
  ];
  let out = '';
  for (const [v, s] of map) { while (num >= v) { out += s; num -= v; } }
  return out;
}
function downloadText(text, filename, opts = {}) {
  const blobParts = [];
  if (opts.addBOM) blobParts.push('\uFEFF'); // helps Excel open UTF-8 CSVs
  blobParts.push(text);
  const blob = new Blob(blobParts, { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}
