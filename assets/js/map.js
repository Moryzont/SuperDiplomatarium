// Initialiser kart
let map;
let markers;
let drawnItems;
let lettersData = [];

document.addEventListener('DOMContentLoaded', async () => {
  initializeMap();
  await loadLettersForMap();
});

function initializeMap() {
  // Sentrer kartet på Norge
  map = L.map('map').setView([62.0, 10.0], 5);
  
  // Legg til bakgrunnskart
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
  
  // Opprett marker cluster gruppe
  markers = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 50
  });
  
  // Opprett lag for tegnede områder
  drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);
  
  // Legg til tegne-kontroller
  const drawControl = new L.Control.Draw({
    draw: {
      polygon: true,
      rectangle: true,
      circle: false,
      marker: false,
      polyline: false
    },
    edit: {
      featureGroup: drawnItems
    }
  });
  map.addControl(drawControl);
  
  // Håndter tegne-events
  map.on('draw:created', handleAreaDrawn);
}

async function loadLettersForMap() {
  try {
    // Last metadata først
    const metaResponse = await fetch('/medieval-letters/data/metadata.json');
    const metadata = await metaResponse.json();
    
    // Last alle chunks
    for (let i = 0; i < metadata.chunks; i++) {
      const response = await fetch(`/medieval-letters/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`);
      const letters = await response.json();
      
      // Filtrer brev med koordinater
      const geoLetters = letters.filter(l => l.LAT && l.LON);
      lettersData.push(...geoLetters);
      
      // Legg til markører
      geoLetters.forEach(letter => {
        if (letter.LAT && letter.LON) {
          const marker = L.marker([parseFloat(letter.LAT), parseFloat(letter.LON)]);
          
          // Popup med brevinfo
          marker.bindPopup(`
            <h4>${letter.DN_ref || letter.SDN_ID}</h4>
            <p><strong>Dato:</strong> ${letter.original_dato || 'Ukjent'}</p>
            <p><strong>Sted:</strong> ${letter.original_sted || 'Ukjent'}</p>
            <p>${(letter.sammendrag || '').substring(0, 150)}...</p>
          `);
          
          markers.addLayer(marker);
        }
      });
    }
    
    // Legg til alle markører til kartet
    map.addLayer(markers);
    
    document.getElementById('selection-count').textContent = 
      `${lettersData.length} brev med stedsinformasjon`;
    
  } catch (error) {
    console.error('Feil ved lasting av kartdata:', error);
  }
}

function handleAreaDrawn(e) {
  const layer = e.layer;
  drawnItems.addLayer(layer);
  
  // Finn brev innenfor området
  const bounds = layer.getBounds();
  const selectedLetters = lettersData.filter(letter => {
    const lat = parseFloat(letter.LAT);
    const lon = parseFloat(letter.LON);
    return bounds.contains([lat, lon]);
  });
  
  displaySelectedLetters(selectedLetters);
}

function displaySelectedLetters(letters) {
  const container = document.getElementById('selected-letters');
  
  if (letters.length === 0) {
    container.innerHTML = '<p>Ingen brev i valgt område</p>';
    return;
  }
  
  const html = `
    <h3>${letters.length} brev i valgt område</h3>
    <div class="letter-list">
      ${letters.map(letter => `
        <div class="letter-item">
          <h4>${letter.DN_ref || letter.SDN_ID}</h4>
          <p>${letter.original_dato} - ${letter.original_sted}</p>
          <p class="summary">${(letter.sammendrag || '').substring(0, 100)}...</p>
        </div>
      `).join('')}
    </div>
  `;
  
  container.innerHTML = html;
  document.getElementById('selection-count').textContent = 
    `${letters.length} brev valgt`;
}

// Event listeners
document.getElementById('clear-selection').addEventListener('click', () => {
  drawnItems.clearLayers();
  document.getElementById('selected-letters').innerHTML = '';
  document.getElementById('selection-count').textContent = 
    `${lettersData.length} brev med stedsinformasjon`;
});