/* global MiniSearch, document, window, fetch */

let searchIndex = null;
let allLetters = [];
let chunksLoaded = 0;
let totalChunks = 0;

document.addEventListener('DOMContentLoaded', async () => {
  await initializeSearch();
  wireListeners();
});

function base() {
  return (window.SITE_BASE || '').replace(/\/+$/, '');
}

function updateStatus(message) {
  const el = document.getElementById('search-status');
  if (el) el.textContent = message;
}

function normalizeLetter(raw) {
  // Handle BOM on SDNID key and case differences
  const sdnId = raw.SDN_ID || raw.SDNID || raw['\ufeffSDNID'] || raw['﻿SDNID'] || null;
  const dnRef = raw.DN_ref || raw.DN_REF || raw.DNREF || null;

  // Normalize common field names used by the UI
  const original_dato = raw.original_dato || raw.dato || null;
  const original_sted = raw.original_sted || raw.sted || null;

  // Keep canonical keys the UI expects
  const doc = {
    id: dnRef || sdnId || `${original_dato || 'udat'}:${original_sted || 'ukjent'}:${Math.random().toString(36).slice(2, 8)}`,
    SDN_ID: sdnId || undefined,
    DN_ref: dnRef || undefined,
    sammendrag: raw.sammendrag || '',
    brevtekst: raw.brevtekst || '',
    original_dato,
    original_sted,
    kilde: raw.kilde || '',
    date_start: raw.date_start || null,
    date_end: raw.date_end || null
  };

  return doc;
}

async function initializeSearch() {
  updateStatus('Laster inn brevsamlingen...');

  try {
    // 1) Load metadata (respect baseurl)
    const metaUrl = `${base()}/data/metadata.json`;
    const metaResponse = await fetch(metaUrl);
    if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status} on ${metaUrl}`);
    const metadata = await metaResponse.json();
    totalChunks = metadata.chunks;

    // 2) Init MiniSearch (explicit idField)
    searchIndex = new MiniSearch({
      idField: 'id',
      fields: ['sammendrag', 'brevtekst', 'original_sted', 'kilde'],
      storeFields: ['SDN_ID', 'DN_ref', 'sammendrag', 'original_dato', 'original_sted', 'date_start', 'date_end'],
      searchOptions: {
        boost: { sammendrag: 3, brevtekst: 2 },
        fuzzy: 0.2,
        prefix: true
      }
    });

    // 3) Load first chunk immediately (so the page becomes usable fast)
    await loadChunk(0);

    // 4) Load remaining chunks in the background (sequential to be gentler on GH Pages)
    loadRemainingChunks();

  } catch (error) {
    console.error('Feil ved initialisering:', error);
    updateStatus('Kunne ikke laste brevsamlingen. Prøv å laste siden på nytt.');
  }
}

async function loadChunk(i) {
  const url = `${base()}/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const rawLetters = await res.json();

  // Normalize irregular keys before indexing
  const docs = rawLetters.map(normalizeLetter);

  allLetters.push(...docs);
  searchIndex.addAll(docs);

  chunksLoaded++;
  updateStatus(`Lastet ${chunksLoaded} av ${totalChunks} deler…`);
}

async function loadRemainingChunks() {
  for (let i = 1; i < totalChunks; i++) {
    try {
      await loadChunk(i);
    } catch (e) {
      console.error(`Feil ved lasting av del ${i}:`, e);
      // keep going; partial index is still useful
    }
  }
  updateStatus(`${allLetters.length} brev lastet og klare for søk!`);
}

function performSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!searchIndex || query.length < 2) {
    updateResults([]);
    return;
  }

  const fields = [];
  if (document.getElementById('search-sammendrag').checked) fields.push('sammendrag');
  if (document.getElementById('search-brevtekst').checked)  fields.push('brevtekst');
  if (document.getElementById('search-sted').checked)       fields.push('original_sted');
  if (document.getElementById('search-kilde').checked)      fields.push('kilde');

  const results = searchIndex.search(query, { fields, limit: 50 });
  updateResults(results);
}

function updateResults(results) {
  const container = document.getElementById('search-results');
  if (!container) return;

  if (!results || results.length === 0) {
    container.innerHTML = '<p>Ingen treff</p>';
    return;
  }

  const html = results.map(r => `
    <div class="search-result">
      <h3>${r.DN_ref || r.SDN_ID || r.id || 'Uten referanse'}</h3>
      <p class="date">${r.original_dato || 'Udatert'} – ${r.original_sted || 'Ukjent sted'}</p>
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
  if (input) input.addEventListener('input', performSearch);
  if (button) button.addEventListener('click', performSearch);

  document.querySelectorAll('.search-filters input').forEach(cb => {
    cb.addEventListener('change', performSearch);
  });
}
