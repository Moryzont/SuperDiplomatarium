// assets/js/map.js
/* global L, window, document */
let map;
let markers;
let drawnItems;
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

  const drawControl = new L.Control.Draw({
    draw: { polygon: true, rectangle: true, circle: false, marker: false, polyline: false },
    edit: { featureGroup: drawnItems }
  });
  map.addControl(drawControl);

  map.on('draw:created', handleAreaDrawn);
}

async function loadLettersForMap() {
  const BASE = (window.SITE_BASE || '').replace(/\/+$/, ''); // '/SuperDiplomatarium'
  try {
    // 1) Load metadata
    const metaUrl = `${BASE}/medieval-letters/data/metadata.json`;
    const metaResponse = await fetch(metaUrl);
    if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status} on ${metaUrl}`);
    const metadata = await metaResponse.json();

    // 2) Stream chunks
    for (let i = 0; i < metadata.chunks; i++) {
      const chunkPath = `${BASE}/medieval-letters/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`;
      const response = await fetch(chunkPath);
      if (!response.ok) throw new Error(`HTTP ${response.status} on ${chunkPath}`);
      const letters = await response.json();

      const geoLetters = letters.filter(l => l.LAT && l.LON);
      lettersData.push(...geoLetters);

      for (const letter of geoLetters) {
        const lat = parseFloat(letter.LAT);
        const lon = parseFloat(letter.LON);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        const marker = L.marker([lat, lon]);
        marker.bindPopup(`
          <h4>${letter.DN_ref || letter.SDN_ID || 'Uten referanse'}</h4>
          <p><strong>Dato:</strong> ${letter.original_dato || 'Ukjent'}</p>
          <p><strong>Sted:</strong> ${letter.original_sted || 'Ukjent'}</p>
          <p>${(letter.sammendrag || '').slice(0, 150)}${(letter.sammendrag || '').length > 150 ? '…' : ''}</p>
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
    if (el) el.innerHTML = `<p style="color:#b00">Klarte ikke å laste kartdata. Sjekk at <code>/medieval-letters/data</code> ligger under prosjektet og at URL-ene inkluderer <code>{{ site.baseurl }}</code>.</p>`;
  }
}

function handleAreaDrawn(e) {
  const layer = e.layer;
  drawnItems.addLayer(layer);

  // NB: getBounds() er et bounding box-søk (raskt). For polygon-innehold, bruk pointInPolygon senere.
  const bounds = layer.getBounds();
  const selected = lettersData.filter(l => {
    const lat = parseFloat(l.LAT), lon = parseFloat(l.LON);
    return Number.isFinite(lat) && Number.isFinite(lon) && bounds.contains([lat, lon]);
  });

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
          <h4>${l.DN_ref || l.SDN_ID || 'Uten referanse'}</h4>
          <p>${l.original_dato || 'Ukjent'} – ${l.original_sted || 'Ukjent'}</p>
          <p class="summary">${(l.sammendrag || '').slice(0, 100)}${(l.sammendrag || '').length > 100 ? '…' : ''}</p>
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
