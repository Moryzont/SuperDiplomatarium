#!/usr/bin/env node
/**
 * Sync data from SuperDiplomatarium backend to GitHub Pages
 *
 * Reads: ../data/output/all_letters_with_src.json (backend output)
 * Reads: corrections from the curation GUI's SQLite database
 *        (../superdiplomatarium-gui/backend/corrections.db — this is the sole
 *        source of place coordinates; the Python pipeline emits none itself)
 * Writes: data/chunks/*.json (flat per-letter records, 1000 per chunk)
 *         data/metadata.json (sync provenance)
 * Then run: scripts/build-search-v3.mjs (or ./build.sh for the whole chain)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BACKEND_DATA = path.join(__dirname, '../../data/output/all_letters_with_src.json');
const BACKEND_DATA_FALLBACK = path.join(__dirname, '../../data/output/all_letters.json');
const CORRECTIONS_DB = path.join(__dirname, '../../superdiplomatarium-gui/backend/corrections.db');
const CHUNKS_DIR = path.join(__dirname, '../data/chunks');
const CHUNK_SIZE = 1000;

console.log('=== Sync from Backend ===\n');

// Check backend data exists (prefer SRC-enriched version)
let backendPath = BACKEND_DATA;
if (!fs.existsSync(BACKEND_DATA)) {
  if (fs.existsSync(BACKEND_DATA_FALLBACK)) {
    console.warn('Warning: Using fallback data without SRC_ID enrichment');
    backendPath = BACKEND_DATA_FALLBACK;
  } else {
    console.error('ERROR: Backend data not found at:', BACKEND_DATA);
    console.error('Run the backend merge first.');
    process.exit(1);
  }
}

// Load corrections from SQLite database
let corrections = new Map();
let correctionStats = { normalized: 0, uncertain: 0, no_location: 0 };

if (fs.existsSync(CORRECTIONS_DB)) {
  console.log('Loading corrections from database...');
  try {
    // Export corrections using sqlite3 CLI
    const query = `SELECT sd_id, field_name, new_value FROM corrections`;
    const result = execSync(`sqlite3 -json "${CORRECTIONS_DB}" "${query}"`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const rows = JSON.parse(result);

    for (const row of rows) {
      if (!corrections.has(row.sd_id)) {
        corrections.set(row.sd_id, {});
      }
      const corr = corrections.get(row.sd_id);

      if (row.field_name === 'place_normalized') {
        // Format: "PlaceName|lat,lon"
        const parts = row.new_value.split('|');
        corr.normalized_name = parts[0];
        if (parts[1]) {
          const [lat, lon] = parts[1].split(',').map(parseFloat);
          corr.lat = lat;
          corr.lon = lon;
        }
        correctionStats.normalized++;
      } else if (row.field_name === 'place_uncertain') {
        corr.uncertain = true;
        correctionStats.uncertain++;
      } else if (row.field_name === 'place_no_location') {
        corr.no_location = true;
        correctionStats.no_location++;
      }
    }

    console.log(`  Loaded ${corrections.size} letters with corrections`);
    console.log(`  - Normalized places: ${correctionStats.normalized}`);
    console.log(`  - Uncertain locations: ${correctionStats.uncertain}`);
    console.log(`  - No location: ${correctionStats.no_location}\n`);
  } catch (err) {
    console.warn('Warning: Could not load corrections:', err.message);
  }
} else {
  console.log('No corrections database found at:', CORRECTIONS_DB);
}

// Load backend data
console.log('Loading backend data from:', backendPath);
const allLetters = JSON.parse(fs.readFileSync(backendPath, 'utf8'));
console.log(`Loaded ${allLetters.length} letters from backend\n`);

// Ensure chunks directory exists
if (!fs.existsSync(CHUNKS_DIR)) {
  fs.mkdirSync(CHUNKS_DIR, { recursive: true });
}

// Clear old chunks
const oldChunks = fs.readdirSync(CHUNKS_DIR).filter(f => f.endsWith('.json'));
for (const f of oldChunks) {
  fs.unlinkSync(path.join(CHUNKS_DIR, f));
}
console.log(`Cleared ${oldChunks.length} old chunks`);

// Convert backend nested format to GitHub Pages flat format
function convertLetter(letter) {
  const refs = letter.references || {};
  const content = letter.content || {};
  const temporal = letter.temporal || {};
  const spatial = letter.spatial || {};
  const metadata = letter.metadata || {};
  const sources = letter.sources || {};  // Source references (DN_source, DD_source, etc.)
  const externalUrls = letter.external_urls || {};
  const coords = spatial.coordinates || {};

  // Get any corrections for this letter
  const corr = corrections.get(letter.id) || {};

  // Apply corrections: use correction values if available, otherwise use original
  const normalizedName = corr.normalized_name || spatial.normalized || '';
  const lat = corr.lat ?? (coords.lat || '');
  const lon = corr.lon ?? (coords.lon || '');
  const uncertain = corr.uncertain || spatial.uncertain || false;
  const noLocation = corr.no_location || false;

  // Process cross_references - flatten to array of {source, ref} pairs
  const crossRefs = [];
  const cr = letter.cross_references || {};
  for (const [source, refs] of Object.entries(cr)) {
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        crossRefs.push({ source, ref });
      }
    }
  }

  return {
    SD_ID: letter.id || '',
    DN_REF: refs.dn || '',
    RN_REF: refs.rn || '',
    DD_REF: refs.dd || '',
    SDHK_REF: refs.sdhk || '',
    DF_REF: refs.df || '',
    sammendrag: content.summary || '',
    regest: content.regest || '',
    DN_source: sources.dn_source || metadata.dn_source || '',
    RN_source: sources.rn_source || metadata.rn_source || '',
    DD_source: sources.dd_source || metadata.dd_source || '',
    SDHK_source: sources.sdhk_source || metadata.sdhk_source || '',
    DF_source: sources.df_source || metadata.df_source || '',
    DN_dato: temporal.dn_date || '',
    RN_dato: temporal.rn_date || '',
    date_start: temporal.start || '',
    date_end: temporal.end || '',
    original_date: temporal.original || '',
    DN_sted: spatial.dn_place || '',
    RN_sted: spatial.rn_place || '',
    DD_sted: spatial.dd_place || '',
    SDHK_sted: spatial.sdhk_place || '',
    DF_sted: spatial.df_place || '',
    Normalized_name: normalizedName,
    lat: lat,
    lon: lon,
    uncertain_loc: uncertain,
    no_location: noLocation,
    brevtekst: content.body || '',
    fotnoter: content.footnotes || '',
    Tillegg: content.additional_notes || '',
    source: (letter.metadata || {}).source || '',
    cross_references: crossRefs.length > 0 ? crossRefs : null,
    // External URLs
    DF_url: externalUrls.df_url || '',
    // Source document linking (SRC_ID) - check both top level and metadata
    src_id: letter.src_id || metadata.src_id || null,
    related_sd_ids: letter.related_sd_ids || metadata.related_sd_ids || null
  };
}

// Write chunks
const totalChunks = Math.ceil(allLetters.length / CHUNK_SIZE);
console.log(`Writing ${totalChunks} chunks...`);

for (let i = 0; i < totalChunks; i++) {
  const start = i * CHUNK_SIZE;
  const end = Math.min(start + CHUNK_SIZE, allLetters.length);
  const chunk = allLetters.slice(start, end).map(convertLetter);

  const chunkPath = path.join(CHUNKS_DIR, `letters-chunk-${String(i).padStart(2, '0')}.json`);
  fs.writeFileSync(chunkPath, JSON.stringify(chunk));

  if ((i + 1) % 10 === 0 || i === totalChunks - 1) {
    console.log(`  Written chunk ${i + 1}/${totalChunks}`);
  }
}

// Write metadata
const metadata = {
  total_letters: allLetters.length,
  chunks: totalChunks,
  chunk_size: CHUNK_SIZE,
  fields: [
    'SD_ID', 'DN_REF', 'RN_REF', 'DD_REF', 'SDHK_REF', 'DF_REF',
    'sammendrag', 'regest',
    'DN_source', 'RN_source', 'DD_source', 'SDHK_source', 'DF_source',
    'DN_dato', 'RN_dato', 'date_start', 'date_end', 'original_date',
    'DN_sted', 'RN_sted', 'DD_sted', 'SDHK_sted', 'DF_sted',
    'Normalized_name', 'lat', 'lon', 'uncertain_loc',
    'brevtekst', 'fotnoter', 'Tillegg', 'source',
    'src_id', 'related_sd_ids'
  ],
  synced_from: 'backend',
  synced_at: new Date().toISOString()
};

fs.writeFileSync(
  path.join(__dirname, '../data/metadata.json'),
  JSON.stringify(metadata, null, 2)
);

console.log(`\n=== Sync Complete ===`);
console.log(`Total: ${allLetters.length} letters in ${totalChunks} chunks`);
console.log(`\nNow run: node scripts/build-search-v3.mjs`);
