/* global MiniSearch, document, window, fetch */

let searchIndex = null;
let allLetters = [];
let chunksLoaded = 0;
let totalChunks = 0;

document.addEventListener('DOMContentLoaded', async () => {
  await initializeSearch();
  wireListeners();
});

function BASE () {
  return (window.SITE_BASE || '').replace(/\/+$/, '');
}

function updateStatus (message) {
  const el = document.getElementById('search-status');
  if (el) el.textContent = message;
}

async function initializeSearch () {
  updateStatus('Laster inn brevsamlingen…');

  try {
    // 1) Metadata
    const metaUrl = `${BASE()}/data/metadata.json`;
    const metaResponse = await fetch(metaUrl);
    if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status} on ${metaUrl}`);
    const metadata = await metaResponse.json();
    totalChunks = metadata.chunks;

    // 2) Index
    searchIndex = new MiniSearch({
      idField: 'id',
      fields: ['sammendrag', 'brevtekst', 'sted_all', 'kilde'], // sted_all = sted + Normalized_name
      storeFields: ['DN_ref', 'SDN_ID', 'sammendrag', 'original_dato', 'original_sted', 'normalized_name', 'date_start', 'date_end'],
      searchOptions: {
        boost: { sted_all: 4, sammendrag: 3, brevtekst: 2 },
        fuzzy: 0.2,
        prefix: true
      }
    });

    // 3) Load the first chunk (page becomes usable fast)
    await loadChunk(0);

    // 4) Load the rest in the background (sequential, resilient)
    loadRemainingChunks();
  } catch (error) {
    console.error('Feil ved initialisering:', error);
    updateStatus('Kunne ikke laste brevsamlingen. Prøv å laste siden på nytt.');
  }
}

async function loadChunk (i) {
  const url = `${BASE()}/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const rawLetters = await res.json();

  // Normalize + guarantee unique IDs by appending chunk/row
  const docs = rawLetters.map((row, k) => normalizeLetter(row, i, k));

  allLetters.push(...docs);
  searchIndex.addAll(docs); // no duplicate-ID errors now

  chunksLoaded++;
  updateStatus(`Lastet ${chunksLoaded} av ${totalChunks} deler…`);
}

async function loadRemainingChunks () {
  for (let i = 1; i < totalChunks; i++) {
    try {
      await loadChunk(i);
    } catch (e) {
      console.error(`Del ${i} feilet:`, e); // keep going even if one chunk is bad
    }
  }
  updateStatus(`${allLetters.length} brev lastet og klare for søk!`);
}

function normalizeLetter (raw, chunkIndex, rowIndex) {
  // Tolerant key access (handles BOM’d keys and case variants)
  const sdn = raw.SDN_ID || raw.SDNID || raw['\ufeffSDNID'] || raw['﻿SDNID'] || null;
  const dn  = raw.DN_ref || raw.DN_REF || raw.DNREF || null;

  const original_dato = raw.original_dato || raw.dato || null;
  const original_sted = raw.original_sted || raw.sted || null;
  const normalized_name = raw.Normalized_name || raw.normalized_name || null;

  // Unique ID: prefer DN/SDN, but suffix with chunk:row to avoid collisions
  const baseId = dn || sdn || 'doc';
  const id = `${baseId}#${chunkIndex}:${rowIndex}`;

  // Combined field for "Sted" checkbox to search both variants
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

function performSearch () {
  const query = document.getElementById('search-input').value.trim();
  if (!searchIndex || query.length < 2) {
    updateResults([]);
    return;
  }

  const fields = [];
  if (document.getElementById('search-sammendrag').checked) fields.push('sammendrag');
  if (document.getElementById('search-brevtekst').checked)  fields.push('brevtekst');
  if (document.getElementById('search-sted').checked)       fields.push('sted_all'); // <- sted + Normalized_name
  if (document.getElementById('search-kilde').checked)      fields.push('kilde');

  const results = searchIndex.search(query, { fields, limit: 50 });
  updateResults(results);
}

function updateResults (results) {
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

function truncate (text, n) {
  if (!text) return '';
  return text.length <= n ? text : text.slice(0, n) + '…';
}

function wireListeners () {
  const input = document.getElementById('search-input');
  const button = document.getElementById('search-btn');
  if (input)  input.addEventListener('input', performSearch);
  if (button) button.addEventListener('click', performSearch);
  document.querySelectorAll('.search-filters input').forEach(cb => {
    cb.addEventListener('change', performSearch);
  });
}
