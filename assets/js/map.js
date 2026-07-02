/* global L, window, document */
let map, markers, drawnItems;
let lettersData = [];
const fullDataCache = new Map();
const fullChunksLoaded = new Set();
let fullChunkSize = 500;
let currentSelection = []; // what gets exported
let seq = 0; // internal ids used for list toggles

// Source badge colors
const SOURCE_COLORS = {
  DN: '#2563eb', RN: '#0891b2', SDHK: '#ca8a04', DD: '#dc2626', DF: '#16a34a'
};

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
        ds: rec[10] || '', de: rec[11] || '', od: rec[12] || '', p: rec[13] || ''
      };
      lettersData.push(letter);

      const marker = L.marker([letter.la, letter.lo]);
      marker.bindPopup(renderMapPopup(letter));
      // Summaries are not in map.json; fetch the full record when a popup opens
      marker.on('popupopen', async (ev) => {
        const full = await loadFullData(letter.i);
        const summary = truncate(full?.sammendrag || full?.regest || '', 150);
        if (summary) ev.popup.setContent(renderMapPopup(letter, summary));
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
    if (el) el.textContent = `${lettersData.length} brev med stedsinformasjon`;
  } catch (error) {
    console.error('Feil ved lasting av kartdata:', error);
    const el = document.getElementById('selected-letters');
    if (el) el.innerHTML = `<p style="color:#b00">Klarte ikke å laste kartdata. Sjekk at <code>/data/v3/map.json</code> finnes.</p>`;
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
  const place = letter.p || 'Ukjent sted';

  return `
    <div class="map-popup">
      <div class="source-badges">${badges}</div>
      ${refs ? `<div class="popup-refs">${refs}</div>` : ''}
      <p class="popup-meta"><strong>${escapeHtml(date)}</strong> - ${escapeHtml(place)}</p>
      ${summary ? `<p class="popup-summary">${escapeHtml(summary)}</p>` : ''}
      <p class="popup-actions">
        <button class="popup-show-letter btn-link" data-letter-id="${letter.__id}">Vis brevet</button>
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

  return refs.filter(Boolean).join(' | ');
}

// Format reference for display
function formatRef(ref, sourceKey) {
  if (!ref) return null;
  const refStr = String(ref);

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
    const m = refStr.match(/^DD[_-]?(\d+)$/i);
    if (m) return `DD ${parseInt(m[1], 10)}`;
  }
  if (sourceKey === 'DF') {
    const m = refStr.match(/^DF[_-]?(\d+)$/i);
    if (m) return `DF ${parseInt(m[1], 10)}`;
  }
  return refStr;
}

// ---------- helpers ----------

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
function handleAreaDrawn(e) {
  const layer = e.layer;
  drawnItems.addLayer(layer);
  selectByBounds(layer.getBounds());
}

function selectByBounds(bounds) {
  const selected = lettersData.filter(l =>
    Number.isFinite(l.la) && Number.isFinite(l.lo) && bounds.contains([l.la, l.lo])
  );
  displaySelectedLetters(selected);
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

function displaySelectedLetters(letters) {
  const container = document.getElementById('selected-letters');
  if (!container) return;

  currentSelection = letters.slice(); // store for export
  const exportBar = document.getElementById('export-bar');
  const enable = currentSelection.length > 0;
  exportBar.style.display = 'flex';
  document.getElementById('export-csv').disabled = !enable;
  document.getElementById('export-txt').disabled = !enable;

  if (!letters.length) {
    container.innerHTML = '<p>Ingen brev i valgt område</p>';
    const sc = document.getElementById('selection-count');
    if (sc) sc.textContent = `${lettersData.length} brev med stedsinformasjon`;
    return;
  }

  const html = `
    <h3>${letters.length} brev i valgt område</h3>
    <div class="letter-list">
      ${letters.map(l => {
        const date = formatDateRange(l.ds, l.de, l.od);
        const place = l.p || 'Ukjent sted';
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
            <span class="letter-date">${escapeHtml(date)}</span>
            <span class="letter-place">${escapeHtml(place)}</span>
          </div>
          <div class="letter-actions">
            <button class="toggle-details btn-link" aria-expanded="false">Vis detaljer</button>
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
        section('Sammendrag', full?.sammendrag || full?.regest, 'sammendrag'),
        section('Brevtekst', full?.brevtekst, 'brevtekst'),
        section('Fotnoter', full?.fotnoter, 'fotnoter')
      ].filter(Boolean).join('') || '<em>Ingen tekst tilgjengelig.</em>';
    }
  });
}

function wireButtons() {
  const clearBtn = document.getElementById('clear-selection');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      drawnItems.clearLayers();
      document.getElementById('selected-letters').innerHTML = '';
      const sc = document.getElementById('selection-count');
      if (sc) sc.textContent = `${lettersData.length} brev med stedsinformasjon`;
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

    const refs = renderReferencesLine(l) || 'Uten referanse';
    const dateLine = formatDateRange(l.ds, l.de, l.od);
    const place = l.p || 'Ukjent sted';

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
    'SD_ID', 'DN_REF', 'RN_REF', 'SDHK_REF', 'DD_REF', 'DF_REF',
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
