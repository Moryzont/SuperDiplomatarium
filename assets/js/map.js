/* global L, window, document */
let map, markers, drawnItems;
let lettersData = [];

document.addEventListener('DOMContentLoaded', async () => {
  initializeMap();
  await loadLettersForMap();
  wireButtons();
});

function initializeMap() {
  map = L.map('map').setView([62.0, 10.0], 5);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  markers = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 });

  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  const hasDraw = L && L.Control && typeof L.Control.Draw === 'function';
  if (hasDraw) {
    const drawControl = new L.Control.Draw({
      draw: { polygon: true, rectangle: true, circle: false, marker: false, polyline: false },
      edit: { featureGroup: drawnItems }
    });
    map.addControl(drawControl);
    map.on('draw:created', handleAreaDrawn);
  } else {
    console.warn('Leaflet.Draw was not loaded; area selection disabled.');
  }
}

async function loadLettersForMap() {
  const BASE = (window.SITE_BASE || '').replace(/\/+$/, ''); // '/SuperDiplomatarium' i prod
  try {
    // 1) Metadata
    const metaUrl = `${BASE}/data/metadata.json`;
    const metaResponse = await fetch(metaUrl);
    if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status} on ${metaUrl}`);
    const metadata = await metaResponse.json();

    // 2) Alle chunks
    for (let i = 0; i < metadata.chunks; i++) {
      const url = `${BASE}/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      const raw = await res.json();

      for (let k = 0; k < raw.length; k++) {
        const n = normalizeLetter(raw[k]);
        if (!Number.isFinite(n.LAT) || !Number.isFinite(n.LON)) continue;

        // lagre til utvalg/filtrering
        lettersData.push(n);

        // marker + popup
        const marker = L.marker([n.LAT, n.LON]).bindPopup(`
          <h4>${escapeHtml(n.DN_ref || n.SDN_ID || 'Uten referanse')}</h4>
          ${n.DN_ref && n.SDN_ID ? `<p><strong>SDN:</strong> ${escapeHtml(n.SDN_ID)}</p>` : ''}
          <p><strong>Dato:</strong> ${escapeHtml(formatDateRange(n.date_start, n.date_end, n.original_dato))}</p>
          <p><strong>Sted:</strong> ${escapeHtml(n.normalized_name || n.original_sted || 'Ukjent')}</p>
          <p>${escapeHtml(truncate(n.sammendrag, 150))}</p>
        `);
        markers.addLayer(marker);
      }
    }

    map.addLayer(markers);

    const el = document.getElementById('selection-count');
    if (el) el.textContent = `${lettersData.length} brev med stedsinformasjon`;
  } catch (error) {
    console.error('Feil ved lasting av kartdata:', error);
    const el = document.getElementById('selected-letters');
    if (el) el.innerHTML = `<p style="color:#b00">Klarte ikke å laste kartdata. Sjekk at <code>/data</code> finnes under prosjektet.</p>`;
  }
}

// ————— Normalisering & formatering —————
function normalizeLetter(l) {
  // ID-varianter (tåler BOM og ulike keys)
  const SDN_ID = l.SDN_ID || l.SDNID || l['\ufeffSDNID'] || l['﻿SDNID'] || null;
  const DN_ref = l.DN_ref || l.DN_REF || l.DNREF || null;

  // Dato/sted-varianter
  const original_dato = l.original_dato || l.dato || null;
  const original_sted = l.original_sted || l.sted || null;
  const normalized_name = l.Normalized_name || l.normalized_name || null;

  // Koordinater (store/liten)
  const LAT = parseFloat(l.LAT ?? l.lat);
  const LON = parseFloat(l.LON ?? l.lon);

  return {
    DN_ref,
    SDN_ID,
    original_dato,
    original_sted,
    normalized_name,
    date_start: l.date_start || null,
    date_end: l.date_end || null,
    LAT, LON,
    sammendrag: l.sammendrag || ''
  };
}

// foretrekk original_dato; ellers år fra start/slutt (f.eks. "1450–1470" eller "1450")
function formatDateRange(start, end, original) {
  if (original && String(original).trim()) return String(original);
  const ys = parseYear(start);
  const ye = parseYear(end) ?? ys;
  if (ys && ye) return ys === ye ? String(ys) : `${ys}–${ye}`;
  if (ys) return String(ys);
  if (ye) return String(ye);
  return 'Ukjent';
}
function parseYear(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}
function truncate(text, n) {
  if (!text) return '';
  return text.length <= n ? text : text.slice(0, n) + '…';
}
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ————— Utvalg —————
function handleAreaDrawn(e) {
  const layer = e.layer;
  drawnItems.addLayer(layer);

  const bounds = layer.getBounds();
  const selected = lettersData.filter(l =>
    Number.isFinite(l.LAT) && Number.isFinite(l.LON) && bounds.contains([l.LAT, l.LON])
  );

  displaySelectedLetters(selected);
}

function displaySelectedLetters(letters) {
  const container = document.getElementById('selected-letters');
  if (!container) return;

  if (!letters.length) {
    container.innerHTML = '<p>Ingen brev i valgt område</p>';
    const sc = document.getElementById('selection-count');
    if (sc) sc.textContent = `${lettersData.length} brev med stedsinformasjon`;
    return;
  }

  container.innerHTML = `
    <h3>${letters.length} brev i valgt område</h3>
    <div class="letter-list">
      ${letters.map(l => `
        <div class="letter-item">
          <h4>${escapeHtml(l.DN_ref || l.SDN_ID || 'Uten referanse')}</h4>
          <p>${escapeHtml(formatDateRange(l.date_start, l.date_end, l.original_dato))} – ${escapeHtml(l.normalized_name || l.original_sted || 'Ukjent')}</p>
          <p class="summary">${escapeHtml(truncate(l.sammendrag, 100))}</p>
        </div>
      `).join('')}
    </div>
  `;

  const sc = document.getElementById('selection-count');
  if (sc) sc.textContent = `${letters.length} brev valgt`;
}

function wireButtons() {
  const clearBtn = document.getElementById('clear-selection');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      drawnItems.clearLayers();
      document.getElementById('selected-letters').innerHTML = '';
      const sc = document.getElementById('selection-count');
      if (sc) sc.textContent = `${lettersData.length} brev med stedsinformasjon`;
    });
  }
}
