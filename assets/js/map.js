/* global L, window, document */
let map, markers, drawnItems;
let lettersData = [];
let currentSelection = []; // what gets exported
let seq = 0; // internal ids used for list toggles

document.addEventListener('DOMContentLoaded', async () => {
  initializeMap();
  await loadLettersForMap();
  wireButtons();
  wireSelectionList();
  wireExportBar();
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
    const metaUrl = `${BASE}/data/metadata.json`;
    const metaResponse = await fetch(metaUrl);
    if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status} on ${metaUrl}`);
    const metadata = await metaResponse.json();

    for (let i = 0; i < metadata.chunks; i++) {
      const url = `${BASE}/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
      const raw = await res.json();

      for (let k = 0; k < raw.length; k++) {
        const n = normalizeLetter(raw[k]);  // n._raw holds original row
        if (!Number.isFinite(n.LAT) || !Number.isFinite(n.LON)) continue;

        n.__id = seq++;
        lettersData.push(n);

        const marker = L.marker([n.LAT, n.LON]).bindPopup(`
          <h4>${escapeHtml(n.DN_ref || 'Uten referanse')}</h4>
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

// ---------- normalisering & helpers ----------
function normalizeLetter(l) {
  const DN_ref = l.DN_ref || l.DN_REF || l.DNREF || null;

  const original_dato = l.original_dato || l.dato || null;
  const original_sted = l.original_sted || l.sted || null;
  const normalized_name = l.Normalized_name || l.normalized_name || null;

  const LAT = parseFloat(l.LAT ?? l.lat);
  const LON = parseFloat(l.LON ?? l.lon);

  const fotnoter = l.fotnoter || l.Fotnoter || '';
  const tillegg  = l.tillegg  || l.Tillegg  || '';
  const kilde    = l.kilde    || l.Kilde    || '';

  return {
    // normalized fields for UI
    DN_ref,
    original_dato, original_sted, normalized_name,
    date_start: l.date_start || null,
    date_end: l.date_end || null,
    LAT, LON,
    sammendrag: l.sammendrag || '',
    brevtekst: l.brevtekst || '',
    fotnoter, tillegg, kilde,
    // keep the original row exactly as-is for CSV export
    _raw: l
  };
}

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

// Convert "DN01100136" -> "Diplomatarium Norvegicum XI, 136"
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

// ---------- utvalg ----------
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
        const humanDate = formatDateRange(l.date_start, l.date_end, l.original_dato);
        const archaic = dnToArchaic(l.DN_ref);
        return `
        <div class="letter-item" data-id="${l.__id}">
          <div class="idline">
            <span class="dn-code">${escapeHtml(l.DN_ref || 'Uten referanse')}</span>
            <span class="dn-archaic">${escapeHtml(archaic)}</span>
          </div>
          <h4>
            <button class="toggle-details" aria-expanded="false">Vis fulltekst</button>
          </h4>
          <p class="meta">${escapeHtml(humanDate)} – ${escapeHtml(l.normalized_name || l.original_sted || 'Ukjent')}</p>

          <div class="details" style="display:none;">
            <p><strong>date_start:</strong> ${escapeHtml(l.date_start || '')}
               &nbsp;&nbsp;<strong>date_end:</strong> ${escapeHtml(l.date_end || '')}
               &nbsp;&nbsp;<strong>Sted:</strong> ${escapeHtml(l.original_sted || 'Ukjent')}
               &nbsp;&nbsp;<strong>Normalisert:</strong> ${escapeHtml(l.normalized_name || '—')}
            </p>

            ${section('Sammendrag', l.sammendrag, 'sammendrag')}
            ${section('Brevtekst',   l.brevtekst,  'brevtekst')}
            ${section('Fotnoter',    l.fotnoter,   'fotnoter')}
            ${section('Tillegg',     l.tillegg,    'tillegg')}
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

  container.addEventListener('click', (ev) => {
    const toggle = ev.target.closest('.toggle-details');
    if (!toggle) return;
    const item = ev.target.closest('.letter-item');
    const details = item.querySelector('.details');
    const show = details.style.display === 'none' || !details.style.display;
    details.style.display = show ? 'block' : 'none';
    toggle.textContent = show ? 'Skjul fulltekst' : 'Vis fulltekst';
    toggle.setAttribute('aria-expanded', String(show));
    ev.preventDefault();
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

  document.getElementById('export-csv').addEventListener('click', () => {
    if (!currentSelection.length) return;
    const csv = toCSV_fromRaw(currentSelection);
    downloadText(csv, 'brev-utvalg.csv', { addBOM: true });
  });

  document.getElementById('export-txt').addEventListener('click', () => {
    if (!currentSelection.length) return;
    const txt = toTXT_likeDetails(currentSelection);
    downloadText(txt, 'brev-utvalg.txt');
  });
}

// TXT: mirror the “Vis fulltekst” box and include BOTH sted + Normalized_name
function toTXT_likeDetails(rows) {
  const parts = [];
  for (const l of rows) {
    const headerLeft  = l.DN_ref || 'Uten referanse';
    const headerRight = dnToArchaic(l.DN_ref) || '';
    const dateLine = formatDateRange(l.date_start, l.date_end, l.original_dato);
    const placeOrig = l.original_sted || 'Ukjent';
    const placeNorm = l.normalized_name || '—';

    const bits = [];
    bits.push(`${headerLeft}    ${headerRight}`);
    bits.push(`${dateLine} — Sted: ${placeOrig} | Normalisert: ${placeNorm}`);
    bits.push(`date_start: ${l.date_start || ''}    date_end: ${l.date_end || ''}`);

    if (l.sammendrag && String(l.sammendrag).trim()) {
      bits.push('');
      bits.push('SAMMENDRAG:');
      bits.push(l.sammendrag);
    }
    if (l.brevtekst && String(l.brevtekst).trim()) {
      bits.push('');
      bits.push('BREVTEKST:');
      bits.push(l.brevtekst);
    }
    if (l.fotnoter && String(l.fotnoter).trim()) {
      bits.push('');
      bits.push('FOTNOTER:');
      bits.push(l.fotnoter);
    }
    if (l.tillegg && String(l.tillegg).trim()) {
      bits.push('');
      bits.push('TILLEGG:');
      bits.push(l.tillegg);
    }

    parts.push(bits.join('\n'));
  }
  return parts.join('\n\n---\n\n');
}

// CSV: include exactly the columns as in the original JSON rows (union of keys)
function toCSV_fromRaw(rows) {
  const keySet = new Set();
  for (const l of rows) {
    const raw = l._raw || {};
    for (const k of Object.keys(raw)) keySet.add(k);
  }

  // Preferred ordering first (if present), then the rest alphabetically.
  const preferred = [
    '\ufeffSDNID','SDNID','DN_REF','DN_ref','DNREF',
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

  for (const l of rows) {
    const raw = l._raw || {};
    const line = headers.map(h => esc(raw[h])).join(',');
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
