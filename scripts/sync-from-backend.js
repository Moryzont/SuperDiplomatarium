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
    const query = `SELECT id, sd_id, field_name, new_value FROM corrections ORDER BY id`;
    const result = execSync(`sqlite3 -json "${CORRECTIONS_DB}" "${query}"`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const rows = JSON.parse(result);

    for (const row of rows) {
      if (!corrections.has(row.sd_id)) {
        corrections.set(row.sd_id, {});
      }
      const corr = corrections.get(row.sd_id);

      if (row.field_name === 'place_normalized') {
        // Format: "PlaceName|lat,lon" or "PlaceName|lat,lon|region";
        // '__REJECTED__' undoes the placement (latest row wins)
        if (row.new_value === '__REJECTED__') {
          delete corr.normalized_name; delete corr.lat; delete corr.lon; delete corr.is_region;
        } else {
          const parts = row.new_value.split('|');
          corr.normalized_name = parts[0];
          if (parts[1]) {
            const [lat, lon] = parts[1].split(',').map(parseFloat);
            corr.lat = lat;
            corr.lon = lon;
          }
          corr.is_region = parts[2] === 'region';
          correctionStats.normalized++;
        }
      } else if (row.field_name === 'mention_person' || row.field_name === 'mention_place') {
        // People and places MENTIONED in the letter (Merking) — resolved
        // place mentions carry coordinates via mention_resolved rows
        corr.mentions = corr.mentions || [];
        try {
          const m = JSON.parse(row.new_value);
          corr.mentions.push({ _cid: row.id, kind: row.field_name.replace('mention_', ''),
            text: m.text, name: m.name, region: !!m.region, lat: m.lat, lon: m.lon });
        } catch (e) { /* skip malformed */ }
      } else if (row.field_name === 'mention_resolved') {
        try {
          const r = JSON.parse(row.new_value);
          corr.mention_resolutions = corr.mention_resolutions || {};
          corr.mention_resolutions[r.mention_correction_id] = r.place;
        } catch (e) { /* skip */ }
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

// ---------- text normalization ----------
// The raw scrapes carry encoding damage that the parsers don't yet repair:
//  - DD: whole fields are UTF-8 double-decoded as cp1252 ("nÃ¦rvÃ¦rende", "â\x99¦")
//  - SDHK/DN: stray cp1252 punctuation bytes (\x92 ' \x94 " \x96 –)
//  - DN: a few literal HTML entities (&amp;)
// NOTE: angle-bracket marks like ips<a>s are EDITORIAL notation in diplomatic
// transcription, not HTML — never strip them.
const CP1252 = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: "‘",
  0x92: "’", 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ'
};
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
// Reverse cp1252 map: the mojibake sometimes went through a cp1252 display
// step, so byte 0x93 appears as the CHARACTER '“' — map such chars back to
// their byte value when reconstructing the original UTF-8 byte stream.
const CP1252_REV = Object.fromEntries(
  Object.entries(CP1252).map(([byte, ch]) => [ch, Number(byte)])
);

function fixEncoding(s) {
  if (!s || typeof s !== 'string') return s;

  // 1. Repair UTF-8-decoded-as-Latin1/cp1252 mojibake. Only attempted when the
  //    signature is present, and only applied if the WHOLE string round-trips
  //    as valid UTF-8 (strict decoder) — otherwise the text is left untouched.
  if (/Ã[\x80-\xBF¦¸¥¤¶©¨«]|â[\x80-\x9F€‚„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/.test(s)) {
    try {
      const bytes = new Uint8Array([...s].map(c => {
        const cp = c.codePointAt(0);
        if (cp <= 0xff) return cp;
        const b = CP1252_REV[c];
        if (b === undefined) throw new Error('not byte-mapped');
        return b;
      }));
      s = utf8Strict.decode(bytes);
    } catch {
      // Mixed content: fall back to the common sequences only (both the
      // raw-byte and the cp1252-character renderings of each)
      s = s.replace(/Ã¦/g, 'æ').replace(/Ã¸/g, 'ø').replace(/Ã¥/g, 'å')
        .replace(/Ã¤/g, 'ä').replace(/Ã¶/g, 'ö').replace(/Ã©/g, 'é')
        .replace(/Ã¨/g, 'è').replace(/Ã¼/g, 'ü').replace(/Ã\x85/g, 'Å')
        .replace(/Ã\x96/g, 'Ö').replace(/Ã\x84/g, 'Ä')
        .replace(/â[\x80\u20ac][\x93\u201c]/g, '\u2013').replace(/â[\x80\u20ac][\x94\u201d]/g, '\u2014')
        .replace(/â[\x80\u20ac][\x99\u2122]/g, '\u2019').replace(/â[\x80\u20ac][\x9c\u0153]/g, '\u201c')
        .replace(/â[\x80\u20ac]\x9d/g, '\u201d').replace(/â[\x80\u20ac]¦/g, '\u2026')
        .replace(/â[\x80\u20ac][\xa0 ]/g, '\u2020').replace(/â[\x99\u2122]¦/g, '\u2666')
        // Orphaned "â€" (third byte lost upstream): in DF/DD prose these are
        // almost always closing right quotes
        .replace(/â[\x80\u20ac]/g, '\u201d');
    }
  }

  // 2. Residual cp1252 punctuation bytes -> proper Unicode
  s = s.replace(/[\x80-\x9f]/g, c => CP1252[c.charCodeAt(0)] || '');

  // 3. Literal HTML entities
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

  // 4. Remaining C0 control chars (keep \n and \t)
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');

  return s;
}

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

  const t = fixEncoding;
  return {
    SD_ID: letter.id || '',
    DN_REF: refs.dn || '',
    RN_REF: refs.rn || '',
    DD_REF: refs.dd || '',
    SDHK_REF: refs.sdhk || '',
    DF_REF: refs.df || '',
    sammendrag: t(content.summary || ''),
    regest: t(content.regest || ''),
    DN_source: t(sources.dn_source || metadata.dn_source || ''),
    RN_source: t(sources.rn_source || metadata.rn_source || ''),
    DD_source: t(sources.dd_source || metadata.dd_source || ''),
    SDHK_source: t(sources.sdhk_source || metadata.sdhk_source || ''),
    DF_source: t(sources.df_source || metadata.df_source || ''),
    DN_dato: temporal.dn_date || '',
    RN_dato: temporal.rn_date || '',
    date_start: temporal.start || '',
    date_end: temporal.end || '',
    original_date: t(temporal.original || ''),
    DN_sted: t(spatial.dn_place || ''),
    RN_sted: t(spatial.rn_place || ''),
    DD_sted: t(spatial.dd_place || ''),
    SDHK_sted: t(spatial.sdhk_place || ''),
    DF_sted: t(spatial.df_place || ''),
    Normalized_name: normalizedName,
    lat: lat,
    lon: lon,
    uncertain_loc: uncertain,
    no_location: noLocation,
    brevtekst: t(content.body || ''),
    oversettelse: t(content.translation || ''),
    tekstapparat: t(content.apparatus || ''),
    noter: t(content.editorial_notes || ''),
    fotnoter: t(content.footnotes || ''),
    Tillegg: t(content.additional_notes || ''),
    nevnte: (() => {
      const c = corrections.get(letter.id);
      if (!c || !c.mentions || c.mentions.length === 0) return null;
      return c.mentions.map((m) => {
        const res = c.mention_resolutions && c.mention_resolutions[m._cid];
        if (res) {
          const parts = res.split('|');
          m = { ...m, name: parts[0], region: parts[2] === 'region' };
          if (parts[1]) { const [la, lo] = parts[1].split(',').map(parseFloat); m.lat = la; m.lon = lo; }
        }
        const { _cid, ...out } = m;
        return out;
      });
    })(),
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
    'brevtekst', 'oversettelse', 'tekstapparat', 'noter', 'fotnoter', 'Tillegg', 'nevnte', 'source',
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
