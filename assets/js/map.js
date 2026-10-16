/* global L, window, document */
let map, markers, drawnItems, drawControl;
let mentionLayer = null;  // connections from a selected letter to its mentioned places
let lettersData = [];
const fullDataCache = new Map();
const fullChunksLoaded = new Set();
let fullChunkSize = 500;
// Translated text (assets/js/i18n.js); the key itself when i18n is absent.
const MT = (key, params) => (window.i18n ? window.i18n.t(key, params) : key);
let currentSelection = []; // what gets exported
let seq = 0; // internal ids used for list toggles

// Source badge colors
// the same badge colours as the search page (search-v3.js)
const SOURCE_COLORS = {
  DN: '#5c6d4a', RN: '#6b8e7a', SDHK: '#8b7355', DD: '#8b5a5a', DF: '#5a7a6b', DI: '#6a6e8c'
};

// one pin for every letter: a small olive dot in the site's palette (CSS .sd-pin)
const PIN_ICON = () => L.divIcon({ className: 'sd-pin', iconSize: [14, 14], iconAnchor: [7, 7], popupAnchor: [0, -8] });

document.addEventListener('DOMContentLoaded', async () => {
  initializeMap();
  await loadLettersForMap();
  wireButtons();
  wireSelectionList();
  wireExportBar();
  wirePopupActions();
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
    drawControl = new L.Control.Draw({
      draw: {
        polygon: { shapeOptions: { color: '#7a3e0f', weight: 3, fillColor: '#DDA15E', fillOpacity: .15 } },
        rectangle: { shapeOptions: { color: '#7a3e0f', weight: 3, fillColor: '#DDA15E', fillOpacity: .15 } },
        circle: false, circlemarker: false, marker: false, polyline: false
      },
      edit: { featureGroup: drawnItems }
    });
    map.addControl(drawControl);
    map.on('draw:created', handleAreaDrawn);
    map.on('draw:edited', selectByShapes);
    map.on('draw:deleted', selectByShapes);
  } else {
    console.warn('Leaflet.Draw was not loaded; area selection disabled.');
  }
}

window.addEventListener('sd:language', () => {
  const el = document.getElementById('selection-count');
  if (el && lettersData.length && !document.querySelector('#selected-letters h3')) el.textContent = MT('map.withPlace', { n: lettersData.length });
});

async function loadLettersForMap() {
  const BASE = (window.SITE_BASE || '').replace(/\/+$/, '');
  try {
    // Compact geo table built by scripts/build-search-v3.mjs:
    // [idx, la, lo, id, d, r, sdhk, dd, df, src, ds, de, od, p] per letter
    const url = `${BASE}/data/v3/map.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    const data = await res.json();
    fullChunkSize = data.full_chunk_size || 500;

    const markerList = [];
    for (const rec of data.records) {
      const letter = {
        __id: seq++,
        i: rec[0], la: rec[1], lo: rec[2], id: rec[3],
        d: rec[4] || null, r: rec[5] || null, sdhk: rec[6] || null,
        dd: rec[7] || null, df: rec[8] || null, src: rec[9] || '',
        ds: rec[10] || '', de: rec[11] || '', od: rec[12] || '', p: rec[13] || '',
        di: rec[14] || null, dq: rec[15] || ''
      };
      lettersData.push(letter);

      const marker = L.marker([letter.la, letter.lo], { icon: PIN_ICON() });
      // popup HTML is built when the popup opens, not for all 63k markers up front
      marker.bindPopup(() => renderMapPopup(letter));
      // Summaries are not in map.json; fetch the full record when a popup opens
      marker.on('popupopen', async (ev) => {
        const full = await loadFullData(letter.i);
        const summary = truncate(full?.sammendrag || full?.regest || '', 150);
        if (summary) ev.popup.setContent(renderMapPopup(letter, summary));
        // Draw connections to the places mentioned in this letter
        if (mentionLayer) { map.removeLayer(mentionLayer); mentionLayer = null; }
        const mentions = (full?.nevnte || []).filter((m) => m.lat != null && m.lon != null);
        if (mentions.length > 0) {
          mentionLayer = L.layerGroup();
          for (const m of mentions) {
            L.polyline([[letter.la, letter.lo], [m.lat, m.lon]],
              { color: '#8c2f1b', weight: 1.5, opacity: .65, dashArray: '4,4' }).addTo(mentionLayer);
            L.circleMarker([m.lat, m.lon], { radius: 6, color: '#8c2f1b', weight: 2, fillOpacity: .15 })
              .bindTooltip(`${m.region ? '▦' : '📍'} ${m.name || m.text} — ${MT('map.mentioned')}`).addTo(mentionLayer);
          }
          mentionLayer.addTo(map);
        }
      });
      marker.on('popupclose', () => {
        if (mentionLayer) { map.removeLayer(mentionLayer); mentionLayer = null; }
      });
      letter.__marker = marker;
      markerList.push(marker);
    }
    markers.addLayers(markerList);

    map.addLayer(markers);

    // Deep link from a letter card: /kart/?sd=SDxxxxxxxx centers the map on
    // that letter's pin and opens its popup.
    const focusSd = new URLSearchParams(window.location.search).get('sd');
    if (focusSd) {
      const target = lettersData.find(l => l.id === focusSd);
      if (target && target.__marker) {
        map.setView([target.la, target.lo], 12);
        markers.zoomToShowLayer(target.__marker, () => target.__marker.openPopup());
      }
    }

    const el = document.getElementById('selection-count');
    if (el) el.textContent = MT('map.withPlace', { n: lettersData.length });
  } catch (error) {
    console.error('Feil ved lasting av kartdata:', error);
    const el = document.getElementById('selected-letters');
    if (el) el.innerHTML = `<p style="color:#b00">${MT('map.loadError')} <code>/data/v3/map.json</code></p>`;
  }
}

// ---------- on-demand full records (same store as search) ----------
async function loadFullDataForIndices(indices) {
  const BASE = (window.SITE_BASE || '').replace(/\/+$/, '');
  const chunksNeeded = new Set();
  for (const idx of indices) {
    if (!fullDataCache.has(idx)) {
      const chunkIdx = Math.floor(idx / fullChunkSize);
      if (!fullChunksLoaded.has(chunkIdx)) chunksNeeded.add(chunkIdx);
    }
  }
  await Promise.all([...chunksNeeded].map(async chunkIdx => {
    const url = `${BASE}/data/optimized/full-${String(chunkIdx).padStart(2, '0')}.json`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const chunk = await res.json();
        for (const letter of chunk) fullDataCache.set(letter.i, letter);
        fullChunksLoaded.add(chunkIdx);
      }
    } catch (err) {
      console.error(`Failed to load full chunk ${chunkIdx}:`, err);
    }
  }));
}

async function loadFullData(idx) {
  if (!fullDataCache.has(idx)) await loadFullDataForIndices([idx]);
  return fullDataCache.get(idx) || null;
}

// Render popup with source badges; summary arrives async after popupopen
function renderMapPopup(letter, summary = '') {
  const badges = renderSourceBadges(letter);
  const refs = renderReferencesLine(letter);
  const date = formatDateRange(letter.ds, letter.de, letter.od);
  const place = letter.p || MT('letter.unknown.place');

  return `
    <div class="map-popup">
      <div class="source-badges">${badges}</div>
      ${refs ? `<div class="popup-refs">${refs}</div>` : ''}
      <p class="popup-meta"><strong>${escapeHtml(date)}${sdDateMarks(letter.dq)}</strong> - ${escapeHtml(place)}</p>
      ${summary ? `<p class="popup-summary">${escapeHtml(summary)}</p>` : ''}
      <p class="popup-actions">
        <button class="popup-show-letter btn-link" data-letter-id="${letter.__id}">${MT('map.showLetter')}</button>
      </p>
    </div>
  `;
}

// Popup "Vis brevet": render the letter as a card below the map (same view as
// the area-selection tool) with its details pre-expanded.
function wirePopupActions() {
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.popup-show-letter');
    if (!btn) return;
    ev.preventDefault();
    const letter = lettersData[parseInt(btn.dataset.letterId, 10)];
    if (!letter) return;

    displaySelectedLetters([letter]);
    const sc = document.getElementById('selection-count');
    if (sc) sc.textContent = '1 brev valgt fra kartet';

    const item = document.querySelector('#selected-letters .letter-item');
    if (item) {
      item.scrollIntoView({ behavior: 'smooth', block: 'start' });
      item.querySelector('.toggle-details')?.click();
    }
  });
}

// Render source badges
function renderSourceBadges(letter) {
  const sources = [];
  if (letter.d) sources.push('DN');
  if (letter.r) sources.push('RN');
  if (letter.sdhk) sources.push('SDHK');
  if (letter.dd) sources.push('DD');
  if (letter.df) sources.push('DF');
  if (letter.di) sources.push('DI');
  if (letter.src && !sources.includes(letter.src)) sources.push(letter.src);

  if (sources.length === 0) {
    return '<span class="source-badge" style="background:#6b7280">?</span>';
  }

  return sources.map(s => {
    const color = SOURCE_COLORS[s] || '#6b7280';
    return `<span class="source-badge" style="background-color:${color}">${s}</span>`;
  }).join('');
}

// Render references line
function renderReferencesLine(letter) {
  const refs = [];
  if (letter.d) refs.push(formatRef(letter.d, 'DN'));
  if (letter.r) refs.push(formatRef(letter.r, 'RN'));
  if (letter.sdhk) refs.push(formatRef(letter.sdhk, 'SDHK'));
  if (letter.dd) refs.push(formatRef(letter.dd, 'DD'));
  if (letter.df) refs.push(formatRef(letter.df, 'DF'));
  if (letter.di) refs.push(formatRef(letter.di, 'DI'));

  return refs.filter(Boolean).join(' | ');
}

// Format reference for display
function formatRef(ref, sourceKey) {
  if (!ref) return null;
  const refStr = String(ref);

  if (sourceKey === 'DI') {
    const m = refStr.match(/^DI(\d{2})_(\d{5})$/i);
    if (m) {
      const vol = toRoman(parseInt(m[1], 10)), n = parseInt(m[2], 10);
      return n >= 1000 ? `DI ${vol} Viðbætir nr. ${n - 1000}` : `DI ${vol} nr. ${n}`;
    }
  }
  if (sourceKey === 'DN') {
    // Format: DN + 2-digit vol + 6-digit num (e.g., DN12000328 = DN XII, 328)
    const m = refStr.match(/^DN(\d{2})(\d{6})$/i);
    if (m) return `DN ${toRoman(parseInt(m[1], 10))}, ${parseInt(m[2], 10)}`;
  }
  if (sourceKey === 'RN') {
    // Format: RN + 3-digit vol + _ + 5-digit num (e.g., RN001_00001 = RN I, 1)
    const m = refStr.match(/^RN(\d{3})[_-]?(\d{5})$/i);
    if (m) return `RN ${toRoman(parseInt(m[1], 10))}, ${parseInt(m[2], 10)}`;
  }
  if (sourceKey === 'SDHK') {
    const m = refStr.match(/^SDHK[_-]?(\d+)$/i);
    if (m) return `SDHK ${parseInt(m[1], 10)}`;
  }
  if (sourceKey === 'DD') {
    let d = refStr.match(/^DD_(\d{2})_R(\d)_(\d{5})$/i);
    if (d) return `DD ${d[2]}. rk. ${toRoman(parseInt(d[1], 10))} nr. ${parseInt(d[3], 10)}`;
    d = refStr.match(/^DD(\d{4})(\d{2})(\d{2})(\d{3})$/i);
    if (d) {
      const date = d[2] === '99' ? d[1] : d[3] === '99' ? `${d[1]}-${d[2]}` : `${d[1]}-${d[2]}-${d[3]}`;
      return `DD ${date} nr. ${parseInt(d[4], 10)}`;
    }
  }
  if (sourceKey === 'DF') {
    const m = refStr.match(/^DF[_-]?(\d+)$/i);
    if (m) return `DF ${parseInt(m[1], 10)}`;
  }
  return refStr;
}

// ---------- helpers ----------

function formatDateRange(start, end, original) {
  // one normalised form (assets/js/i18n.js); the edition's words only when there is no window
  return sdFormatDate(start, end, original);
}
function parseYear(s) { const m = String(s || '').match(/^(\d{4})/); return m ? Number(m[1]) : null; }
function truncate(t, n) { return !t ? '' : (t.length <= n ? t : t.slice(0, n) + '…'); }
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Convert "DN11000136" -> "Diplomatarium Norvegicum XI, 136"
function dnToArchaic(dn) {
  if (!dn) return '';
  const m = String(dn).match(/^DN(\d{2})(\d{6})$/i);
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

// ---------- utvalg ----------
// Every drawn shape stays on the map; the selection is the union of the
// letters inside any of them (a letter counts once). Polygons are tested
// properly (ray casting), rectangles by their bounds.
function handleAreaDrawn(e) {
  drawnItems.addLayer(e.layer);
  attachRemoveButton(e.layer);
  selectByShapes();
}

// Click a drawn shape: a small popup with a button that removes just that shape.
function attachRemoveButton(layer) {
  layer.bindPopup(() => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = MT('map.removeArea');
    btn.addEventListener('click', () => {
      map.closePopup();
      drawnItems.removeLayer(layer);
      selectByShapes();
    });
    return btn;
  }, { closeButton: false, className: 'shape-popup' });
}

function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lng, yj = ring[j].lat, xj = ring[j].lng;
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function shapeContains(layer, lat, lon) {
  if (!layer.getBounds().contains([lat, lon])) return false;
  if (layer instanceof L.Rectangle || !(layer instanceof L.Polygon)) return true;
  const rings = layer.getLatLngs();
  const outer = Array.isArray(rings[0]) ? rings[0] : rings;   // first ring of a simple polygon
  return pointInRing(lat, lon, outer);
}

function selectByShapes() {
  const shapes = drawnItems.getLayers();
  if (!shapes.length) { displaySelectedLetters([], 0); return; }
  const selected = lettersData.filter(l =>
    Number.isFinite(l.la) && Number.isFinite(l.lo) && shapes.some(sh => shapeContains(sh, l.la, l.lo))
  );
  displaySelectedLetters(selected, shapes.length);
}

function selectByBounds(bounds) {   // test hook
  displaySelectedLetters(lettersData.filter(l =>
    Number.isFinite(l.la) && Number.isFinite(l.lo) && bounds.contains([l.la, l.lo])), 1);
}

// Test/debug hook
window.__SD_MAP = {
  letters: () => lettersData,
  selectByBounds,
  selection: () => currentSelection,
  openPopup: (k = 0) => {
    const l = lettersData[k];
    markers.zoomToShowLayer(l.__marker, () => l.__marker.openPopup());
  }
};

function displaySelectedLetters(letters, shapeCount = 1) {
  const container = document.getElementById('selected-letters');
  if (!container) return;

  currentSelection = letters.slice(); // store for export
  const exportBar = document.getElementById('export-bar');
  const enable = currentSelection.length > 0;
  exportBar.style.display = 'flex';
  document.getElementById('export-csv').disabled = !enable;
  document.getElementById('export-txt').disabled = !enable;

  if (!letters.length) {
    container.innerHTML = `<p>${MT('map.noneInArea')}</p>`;
    const sc = document.getElementById('selection-count');
    if (sc) sc.textContent = MT('map.withPlace', { n: lettersData.length });
    return;
  }

  const html = `
    <h3>${shapeCount > 1 ? MT('map.inAreas', { n: letters.length, k: shapeCount }) : MT('map.inArea', { n: letters.length })}</h3>
    <div class="letter-list">
      ${letters.map(l => {
        const date = formatDateRange(l.ds, l.de, l.od);
        const place = l.p || MT('letter.unknown.place');
        const refs = renderReferencesLine(l);
        const badges = renderSourceBadges(l);

        return `
        <div class="letter-item letter-card" data-id="${l.__id}">
          <div class="letter-header">
            <div class="source-badges">${badges}</div>
            ${l.id ? `<span class="sd-id">${escapeHtml(l.id)}</span>` : ''}
          </div>
          ${refs ? `<div class="letter-refs"><span class="references">${escapeHtml(refs)}</span></div>` : ''}
          <div class="letter-meta">
            <span class="letter-date">${escapeHtml(date)}${sdDateMarks(l.dq)}</span>
            <span class="letter-place">${escapeHtml(place)}</span>
          </div>
          <div class="letter-actions">
            <button class="toggle-details btn-link" aria-expanded="false">${MT('letter.show')}</button>
          </div>

          <div class="details" style="display:none;" data-idx="${l.i}">
            <div class="letter-details-full">
              <div class="detail-summary"><em>Laster...</em></div>
              <p class="detail-places"><strong>Sted:</strong> ${escapeHtml(place)}</p>
              <p class="detail-dates"><strong>Dato:</strong> ${escapeHtml(date)}</p>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;

  container.innerHTML = html;

  const sc = document.getElementById('selection-count');
  if (sc) sc.textContent = `${letters.length} brev valgt`;
}

// Render a section only if there is content
function section(label, content, cls) {
  if (!content || !String(content).trim()) return '';
  return `
    <span class="section-label">${escapeHtml(label)}</span>
    <div class="${cls}">${escapeHtml(String(content))}</div>
  `;
}

function wireSelectionList() {
  const container = document.getElementById('selected-letters');
  if (!container) return;

  container.addEventListener('click', async (ev) => {
    const toggle = ev.target.closest('.toggle-details');
    if (!toggle) return;
    const item = ev.target.closest('.letter-item');
    const details = item.querySelector('.details');
    const show = details.style.display === 'none' || !details.style.display;
    details.style.display = show ? 'block' : 'none';
    toggle.textContent = show ? 'Skjul fulltekst' : 'Vis fulltekst';
    toggle.setAttribute('aria-expanded', String(show));
    ev.preventDefault();

    // Fill summary/fulltext from the full record on first expansion
    const summaryEl = details.querySelector('.detail-summary');
    if (show && summaryEl && !summaryEl.dataset.loaded) {
      const full = await loadFullData(parseInt(details.dataset.idx, 10));
      summaryEl.dataset.loaded = '1';
      summaryEl.innerHTML = [
        section(MT('letter.summary'), full?.sammendrag || full?.regest, 'sammendrag'),
        section(MT('letter.bodyTitle'), full?.brevtekst, 'brevtekst'),
        section(MT('letter.footnotesTitle'), full?.fotnoter, 'fotnoter')
      ].filter(Boolean).join('') || `<em>${MT('letter.noText')}</em>`;
    }
  });
}

function wireButtons() {
  // "Tegn område" starts the rectangle tool (the toolbar on the map offers polygons too)
  const drawBtn = document.getElementById('draw-area');
  if (drawBtn) {
    drawBtn.addEventListener('click', () => {
      if (!drawControl || !L.Draw?.Rectangle) return;
      new L.Draw.Rectangle(map, drawControl.options.draw.rectangle).enable();
    });
  }
  const clearBtn = document.getElementById('clear-selection');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      drawnItems.clearLayers();
      document.getElementById('selected-letters').innerHTML = '';
      const sc = document.getElementById('selection-count');
      if (sc) sc.textContent = MT('map.withPlace', { n: lettersData.length });
      currentSelection = [];
      document.getElementById('export-csv').disabled = true;
      document.getElementById('export-txt').disabled = true;
    });
  }
}

// ---------- eksport ----------
function wireExportBar() {
  const bar = document.getElementById('export-bar');
  if (!bar) return;

  document.getElementById('export-csv').addEventListener('click', async () => {
    if (!currentSelection.length) return;
    await loadFullDataForIndices(currentSelection.map(l => l.i));
    const csv = toCSV_fromRaw(currentSelection);
    downloadText(csv, 'brev-utvalg.csv', { addBOM: true });
  });

  document.getElementById('export-txt').addEventListener('click', async () => {
    if (!currentSelection.length) return;
    await loadFullDataForIndices(currentSelection.map(l => l.i));
    const txt = toTXT_likeDetails(currentSelection);
    downloadText(txt, 'brev-utvalg.txt');
  });
}

// TXT: export letter details
function toTXT_likeDetails(rows) {
  const parts = [];
  for (const l of rows) {
    // Get sources and references
    const sources = [];
    if (l.d) sources.push(`DN: ${l.d}`);
    if (l.r) sources.push(`RN: ${l.r}`);
    if (l.sdhk) sources.push(`SDHK: ${l.sdhk}`);
    if (l.dd) sources.push(`DD: ${l.dd}`);
    if (l.df) sources.push(`DF: ${l.df}`);
    if (l.di) sources.push(`DI: ${l.di}`);

    const refs = renderReferencesLine(l) || 'Uten referanse';
    const dateLine = formatDateRange(l.ds, l.de, l.od);
    const place = l.p || MT('letter.unknown.place');

    const bits = [];
    bits.push(`ID: ${l.id || 'Ukjent'}`);
    bits.push(`Kilder: ${sources.join(', ') || 'Ukjent'}`);
    bits.push(`Referanser: ${refs}`);
    bits.push(`Dato: ${dateLine}`);
    bits.push(`Sted: ${place}`);

    const full = fullDataCache.get(l.i) || {};
    if (full.sammendrag || full.regest) {
      bits.push('');
      bits.push('SAMMENDRAG:');
      bits.push(full.sammendrag || full.regest);
    }
    if (full.brevtekst) {
      bits.push('');
      bits.push('BREVTEKST:');
      bits.push(full.brevtekst);
    }

    parts.push(bits.join('\n'));
  }
  return parts.join('\n\n---\n\n');
}

// CSV: export with new format
function toCSV_fromRaw(rows) {
  // Define headers based on search data format
  const headers = [
    'SD_ID', 'DN_REF', 'RN_REF', 'SDHK_REF', 'DD_REF', 'DF_REF', 'DI_REF',
    'source', 'date', 'date_start', 'date_end', 'original_date',
    'place', 'lat', 'lon', 'summary'
  ];

  const esc = (v) => {
    const s = String(v ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [headers.join(',')];

  for (const l of rows) {
    const line = [
      esc(l.id),
      esc(l.d),
      esc(l.r),
      esc(l.sdhk),
      esc(l.dd),
      esc(l.df),
      esc(l.di),
      esc(l.src),
      esc(formatDateRange(l.ds, l.de, l.od)),
      esc(l.ds),
      esc(l.de),
      esc(l.od),
      esc(l.p),
      esc(l.la),
      esc(l.lo),
      esc((fullDataCache.get(l.i) || {}).sammendrag || (fullDataCache.get(l.i) || {}).regest)
    ].join(',');
    lines.push(line);
  }
  return lines.join('\r\n');
}

function downloadText(text, filename, opts = {}) {
  const blobParts = [];
  if (opts.addBOM) blobParts.push('\uFEFF'); // helps Excel open UTF-8 CSVs
  blobParts.push(text);
  const blob = new Blob(blobParts, { type: 'text/plain;charset=utf-8' });
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
