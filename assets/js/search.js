/* global MiniSearch, document, window, fetch */

// =============== Globals ===============
let searchIndex = null;
let allLetters = [];
let chunksLoaded = 0;
let totalChunks = 0;

document.addEventListener('DOMContentLoaded', async () => {
  await initializeSearch();
  wireListeners();
});

// baseurl helper
function BASE() {
  return (window.SITE_BASE || '').replace(/\/+$/, '');
}

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
        'date_start', 'date_end', 'sted_all'
      ],
      searchOptions: {
        boost: { sted_all: 4, sammendrag: 3, brevtekst: 2 },
        fuzzy: 0.2,
        prefix: true
      }
    });

    await loadChunk(0);
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

  const id = `${(dn || sdn || 'doc')}#${chunkIndex}:${rowIndex}`;
  const sted_all = [original_sted, normalized_name].filter(Boolean).join(' | ');

  return {
    id,
    DN_ref: dn || undefined,
    SDN_ID: sdn || undefined,
    sammendrag: raw.sammendrag || '',
    brevtekst: raw.brevtekst || '',
    original_dato,
    original_sted,
    normalized_name,
    sted_all,
    kilde: raw.kilde || '',
    date_start: raw.date_start || null,
    date_end: raw.date_end || null
  };
}

// =============== Query parsing & helpers ===============

// very small grammar:
//  - phrases: "exact words here"
//  - field scoping: field:term (fields: sammendrag, brevtekst, sted, kilde, dn, sdn)
//  - NOT: -term or NOT term
//  - OR between groups: foo OR bar
//  - year filters: year:1450..1470, before:1500, after:1400
function parseQuery(q) {
  const tokens = [];
  const orGroups = [];
  let i = 0;

  // split by OR (case-insensitive) but honor quotes
  const groups = splitByOr(q);

  for (const g of groups) {
    const group = { must: [], not: [], filters: {} };
    const parts = tokenize(g);

    for (const part of parts) {
      // YEAR filters
      if (/^year:\d{3,4}\.\.\d{3,4}$/i.test(part)) {
        const [from, to] = part.split(':')[1].split('..').map(Number);
        group.filters.yearFrom = from; group.filters.yearTo = to; continue;
      }
      if (/^before:\d{3,4}$/i.test(part)) { group.filters.yearTo = Number(part.split(':')[1]); continue; }
      if (/^after:\d{3,4}$/i.test(part))  { group.filters.yearFrom = Number(part.split(':')[1]); continue; }

      // field scoping (allow quoted rhs)
      const m = part.match(/^([a-z_]+):(.*)$/i);
      let field = null, term = part, isPhrase = false, neg = false;

      if (m) {
        field = m[1].toLowerCase();
        term  = m[2];
      }

      if (/^NOT\s+/i.test(term)) { neg = true; term = term.replace(/^NOT\s+/i, ''); }
      if (term.startsWith('-')) { neg = true; term = term.slice(1); }

      // quoted phrase?
      const quoted = term.match(/^"(.*)"$/);
      if (quoted) { isPhrase = true; term = quoted[1]; }

      const node = { field, term, isPhrase };
      if (neg) group.not.push(node); else group.must.push(node);
    }

    orGroups.push(group);
  }
  return orGroups;
}

// tokenization that respects quotes
function tokenize(s) {
  const out = [];
  let buf = '';
  let inQ = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { buf += ch; inQ = !inQ; continue; }
    if (!inQ && /\s/.test(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function splitByOr(s) {
  const out = [];
  let buf = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inQ = !inQ; buf += ch; continue; }
    if (!inQ && /\bOR\b/i.test(s.slice(i, i + 2)) && s.slice(i, i + 2).toUpperCase() === 'OR'
        && /\s/.test(s[i - 1] || ' ') && /\s/.test(s[i + 2] || ' ')) {
      out.push(buf.trim()); buf = ''; i += 1; // skip 'OR'
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// normalize (lowercase + remove diacritics) for robust exact-phrase check
function norm(s) {
  return (s || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
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
    'sted': 'sted_all',       // covers original_sted + Normalized_name
    'kilde': 'kilde',
    'dn': 'DN_ref',
    'sdn': 'SDN_ID'
  };
  return m[f] || null;
}

// =============== Execution ===============
function performSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!searchIndex || q.length < 2) { updateResults([]); return; }

  const orGroups = parseQuery(q);
  const selectedFields = fieldListForCheckboxes();

  // compute union over OR groups; each group is ANDed
  let unionMap = new Map(); // id -> score
  for (const group of orGroups) {
    const set = runAndGroup(group, selectedFields);
    for (const [id, score] of set) {
      unionMap.set(id, Math.max(unionMap.get(id) || 0, score));
    }
  }

  // convert to array of docs and sort by score desc
  let results = Array.from(unionMap.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 200); // generous before rendering

  // hydrate with stored fields
  results = results.map(r => {
    const doc = searchIndex.documentStore.getDoc(r.id) || {};
    return Object.assign({}, doc, { score: r.score });
  });

  updateResults(results.slice(0, 50));
}

// AND a single group: intersect required terms, apply NOTs and year filters
function runAndGroup(group, selectedFields) {
  // resolve fields per term (scoped or from checkboxes)
  const mustSets = [];
  for (const term of group.must) {
    const fields = mapScopedField(term.field) ? [mapScopedField(term.field)] : selectedFields;
    mustSets.push(searchForNode(term, fields));
  }

  // start from first set then intersect
  let acc = mustSets.length ? mustSets[0] : allDocsAsSet(selectedFields);
  for (let i = 1; i < mustSets.length; i++) {
    acc = intersectScoreMaps(acc, mustSets[i]);
  }

  // apply NOT terms
  for (const n of group.not) {
    const fields = mapScopedField(n.field) ? [mapScopedField(n.field)] : selectedFields;
    const exclude = searchForNode(n, fields);
    for (const id of exclude.keys()) acc.delete(id);
  }

  // year filters
  const from = group.filters.yearFrom ?? -Infinity;
  const to   = group.filters.yearTo   ?? +Infinity;
  for (const id of Array.from(acc.keys())) {
    const doc = searchIndex.documentStore.getDoc(id);
    const s = parseYear(doc?.date_start);
    const e = parseYear(doc?.date_end) ?? s;
    const overlaps = (s ?? e ?? -Infinity) <= to && (e ?? s ?? +Infinity) >= from;
    if (!overlaps) acc.delete(id);
  }

  return acc;
}

function parseYear(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function allDocsAsSet(fields) {
  // broad candidate set: search for a very common token in selected fields,
  // then fall back to every indexed doc if needed
  let m = new Map();
  const res = searchIndex.search('e', { fields, combineWith: 'OR', limit: 100000 });
  if (res.length) {
    for (const r of res) m.set(r.id, Math.max(m.get(r.id) || 0, r.score || 1));
  } else {
    // ultra-fallback: include every doc we stored (score 1)
    for (const doc of allLetters) m.set(doc.id, 1);
  }
  return m;
}

// search a single node (term or phrase) within given fields → Map(id -> score)
function searchForNode(node, fields) {
  // fielded ID lookups (dn:, sdn:) – exact match
  if (fields.length === 1 && (fields[0] === 'DN_ref' || fields[0] === 'SDN_ID')) {
    const needle = norm(node.term);
    const m = new Map();
    for (const d of allLetters) {
      const val = norm(d[fields[0]]);
      if (val && val === needle) m.set(d.id, 100); // very high score
    }
    return m;
  }

  if (node.isPhrase) {
    return phraseSearch(node.term, fields);
  } else {
    // normal minisearch lookup
    const res = searchIndex.search(node.term, {
      fields, limit: 100000, combineWith: 'AND'
    });
    const m = new Map();
    for (const r of res) m.set(r.id, Math.max(m.get(r.id) || 0, r.score || 1));
    return m;
  }
}

// exact phrase search: use MiniSearch to narrow candidates (tokens ANDed), then substring check
function phraseSearch(phrase, fields) {
  const words = phrase.split(/\s+/).filter(Boolean);
  let candidateMap = null;

  // intersect token searches to keep candidate set small
  for (const w of words) {
    const res = searchIndex.search(w, { fields, limit: 100000, combineWith: 'AND' });
    const m = new Map();
    for (const r of res) m.set(r.id, Math.max(m.get(r.id) || 0, r.score || 1));
    candidateMap = candidateMap ? intersectScoreMaps(candidateMap, m) : m;
    if (candidateMap.size === 0) break; // early exit
  }

  if (!candidateMap || candidateMap.size === 0) return new Map();

  const needle = norm(phrase);
  const out = new Map();

  for (const id of candidateMap.keys()) {
    const doc = searchIndex.documentStore.getDoc(id);
    // check exact substring on any of the selected fields
    for (const f of fields) {
      const hay = norm(doc[f] || '');
      if (hay.includes(needle)) {
        // boost phrases slightly above token matches
        out.set(id, Math.max(out.get(id) || 0, (candidateMap.get(id) || 1) + 5));
        break;
      }
    }
  }
  return out;
}

// intersect two maps of scores (id -> score) by id, summing scores
function intersectScoreMaps(a, b) {
  const out = new Map();
  for (const [id, sa] of a.entries()) {
    if (b.has(id)) out.set(id, sa + (b.get(id) || 0));
  }
  return out;
}

// =============== Rendering & wiring ===============
function updateResults(results) {
  const container = document.getElementById('search-results');
  if (!container) return;

  if (!results || results.length === 0) {
    container.innerHTML = '<p>Ingen treff</p>';
    return;
  }

  const html = results.map(r => `
    <div class="search-result">
      <h3>${r.DN_ref || r.SDN_ID || 'Uten referanse'}</h3>
      <p class="date">${r.original_dato || 'Udatert'} – ${r.normalized_name || r.original_sted || 'Ukjent sted'}</p>
      <p class="summary">${truncate(r.sammendrag || 'Ingen sammendrag', 200)}</p>
    </div>
  `).join('');

  container.innerHTML = `
    <p class="result-count">Viser ${results.length} treff</p>
    ${html}
  `;
}

function truncate(text, n) {
  if (!text) return '';
  return text.length <= n ? text : text.slice(0, n) + '…';
}

function wireListeners() {
  const input = document.getElementById('search-input');
  const button = document.getElementById('search-btn');
  if (input)  input.addEventListener('input', performSearch);
  if (button) button.addEventListener('click', performSearch);
  document.querySelectorAll('.search-filters input').forEach(cb => {
    cb.addEventListener('change', performSearch);
  });
}
