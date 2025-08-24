// Globale variabler
let searchIndex = null;
let allLetters = [];
let chunksLoaded = 0;
let totalChunks = 0;

// Initialiser søk ved sideinnlasting
document.addEventListener('DOMContentLoaded', async () => {
  await initializeSearch();
});

async function initializeSearch() {
  updateStatus('Laster inn brevsamlingen...');
  
  try {
    // Last metadata
    const metaResponse = await fetch('/medieval-letters/data/metadata.json');
    const metadata = await metaResponse.json();
    totalChunks = metadata.chunks;
    
    // Initialiser MiniSearch
    searchIndex = new MiniSearch({
      fields: ['sammendrag', 'brevtekst', 'original_sted', 'kilde'],
      storeFields: ['SDN_ID', 'DN_ref', 'sammendrag', 'original_dato', 
                    'original_sted', 'date_start', 'date_end'],
      searchOptions: {
        boost: { sammendrag: 3, brevtekst: 2 },
        fuzzy: 0.2,
        prefix: true
      }
    });
    
    // Last første chunk umiddelbart
    await loadChunk(0);
    
    // Last resten i bakgrunnen
    loadRemainingChunks();
    
  } catch (error) {
    console.error('Feil ved initialisering:', error);
    updateStatus('Kunne ikke laste brevsamlingen. Prøv å laste siden på nytt.');
  }
}

async function loadChunk(chunkNumber) {
  const response = await fetch(`/medieval-letters/data/chunks/letters-chunk-${String(chunkNumber).padStart(2, '0')}.json`);
  const letters = await response.json();
  
  // Legg til i samlingen
  allLetters.push(...letters);
  
  // Indekser for søk
  searchIndex.addAll(letters);
  
  chunksLoaded++;
  updateStatus(`Lastet ${chunksLoaded} av ${totalChunks} deler...`);
}

async function loadRemainingChunks() {
  for (let i = 1; i < totalChunks; i++) {
    await loadChunk(i);
  }
  updateStatus(`${allLetters.length} brev lastet og klare for søk!`);
}

// Søkefunksjon
function performSearch() {
  const query = document.getElementById('search-input').value;
  
  if (query.length < 2) {
    updateResults([]);
    return;
  }
  
  // Finn hvilke felter som skal søkes
  const searchFields = [];
  if (document.getElementById('search-sammendrag').checked) searchFields.push('sammendrag');
  if (document.getElementById('search-brevtekst').checked) searchFields.push('brevtekst');
  if (document.getElementById('search-sted').checked) searchFields.push('original_sted');
  if (document.getElementById('search-kilde').checked) searchFields.push('kilde');
  
  // Utfør søk
  const results = searchIndex.search(query, {
    fields: searchFields,
    limit: 50
  });
  
  updateResults(results);
}

// Oppdater resultater
function updateResults(results) {
  const container = document.getElementById('search-results');
  
  if (results.length === 0) {
    container.innerHTML = '<p>Ingen treff</p>';
    return;
  }
  
  const html = results.map(result => `
    <div class="search-result">
      <h3>${result.DN_ref || result.SDN_ID}</h3>
      <p class="date">${result.original_dato || 'Udatert'} - ${result.original_sted || 'Ukjent sted'}</p>
      <p class="summary">${highlightText(result.sammendrag || 'Ingen sammendrag', 200)}</p>
    </div>
  `).join('');
  
  container.innerHTML = `
    <p class="result-count">Viser ${results.length} treff</p>
    ${html}
  `;
}

// Hjelpefunksjoner
function updateStatus(message) {
  document.getElementById('search-status').textContent = message;
}

function highlightText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

// Event listeners
document.getElementById('search-input').addEventListener('input', performSearch);
document.getElementById('search-btn').addEventListener('click', performSearch);
document.querySelectorAll('.search-filters input').forEach(checkbox => {
  checkbox.addEventListener('change', performSearch);
});