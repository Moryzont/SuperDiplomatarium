/**
 * Shared letter display formatting for SuperDiplomatarium
 *
 * Used by both search-v2.js and map.js to ensure consistent display
 * of letters across the site.
 */

// Source database configuration - muted colors harmonizing with theme palette
const SOURCES = {
  DN: {
    name: 'Diplomatarium Norvegicum',
    short: 'DN',
    color: '#5c6d4a',  // Muted olive-green
    country: 'Norge'
  },
  RN: {
    name: 'Regesta Norvegica',
    short: 'RN',
    color: '#6b8e7a',  // Sage green
    country: 'Norge'
  },
  SDHK: {
    name: 'Svenskt Diplomatariums huvudkartotek',
    short: 'SDHK',
    color: '#8b7355',  // Muted brown/tan
    country: 'Sverige'
  },
  DD: {
    name: 'Diplomatarium Danicum',
    short: 'DD',
    color: '#8b5a5a',  // Muted dusty rose
    country: 'Danmark'
  },
  DF: {
    name: 'Diplomatarium Fennicum',
    short: 'DF',
    color: '#5a7a6b',  // Muted teal-green
    country: 'Finland'
  }
};

/**
 * Get list of sources present in a letter
 * Works with both search format (short keys) and full format
 */
function getLetterSources(letter) {
  const sources = [];

  // Search format uses short keys: d, r, sdhk, dd, df
  if (letter.d) sources.push({ key: 'DN', ref: letter.d });
  if (letter.r) sources.push({ key: 'RN', ref: letter.r });
  if (letter.sdhk) sources.push({ key: 'SDHK', ref: letter.sdhk });
  if (letter.dd) sources.push({ key: 'DD', ref: letter.dd });
  if (letter.df) sources.push({ key: 'DF', ref: letter.df });

  // Full format uses full keys
  if (letter.DN_REF) sources.push({ key: 'DN', ref: letter.DN_REF });
  if (letter.RN_REF) sources.push({ key: 'RN', ref: letter.RN_REF });
  if (letter.SDHK_REF) sources.push({ key: 'SDHK', ref: letter.SDHK_REF });
  if (letter.DD_REF) sources.push({ key: 'DD', ref: letter.DD_REF });
  if (letter.DF_REF) sources.push({ key: 'DF', ref: letter.DF_REF });

  // Also check src/source field for primary source
  const primarySrc = letter.src || letter.source;
  if (primarySrc && !sources.some(s => s.key === primarySrc)) {
    sources.push({ key: primarySrc, ref: null });
  }

  return sources;
}

/**
 * Render source badges HTML
 */
function renderSourceBadges(letter) {
  const sources = getLetterSources(letter);

  if (sources.length === 0) {
    return '<span class="source-badge unknown">Ukjent</span>';
  }

  return sources.map(s => {
    const cfg = SOURCES[s.key] || { short: s.key, color: '#6b7280', name: s.key };
    return `<span class="source-badge" style="background-color: ${cfg.color}" title="${cfg.name}">${cfg.short}</span>`;
  }).join('');
}

/**
 * Format reference for human display
 * DN01100136 -> "DN XI, 136"
 * SDHK_00001 -> "SDHK 1"
 */
function formatReference(ref, sourceKey) {
  if (!ref) return null;

  const refStr = String(ref);

  // DN format: DN01100136 -> DN XI, 136
  if (sourceKey === 'DN') {
    const m = refStr.match(/^DN(\d{3})(\d{5})$/i);
    if (m) {
      const vol = parseInt(m[1], 10);
      const num = parseInt(m[2], 10);
      return `DN ${toRoman(vol)}, ${num}`;
    }
  }

  // RN format: RN00100234 -> RN I, 234
  if (sourceKey === 'RN') {
    const m = refStr.match(/^RN(\d{3})(\d{5})$/i);
    if (m) {
      const vol = parseInt(m[1], 10);
      const num = parseInt(m[2], 10);
      return `RN ${toRoman(vol)}, ${num}`;
    }
  }

  // SDHK format: SDHK_00001 -> SDHK 1
  if (sourceKey === 'SDHK') {
    const m = refStr.match(/^SDHK[_-]?(\d+)$/i);
    if (m) {
      return `SDHK ${parseInt(m[1], 10)}`;
    }
  }

  // DD format: similar to DN
  if (sourceKey === 'DD') {
    const m = refStr.match(/^DD(\d+)[_-]?(\d+)$/i);
    if (m) {
      return `DD ${m[1]}, ${m[2]}`;
    }
    // Fallback
    return refStr.replace(/^DD[_-]?/i, 'DD ');
  }

  // DF format
  if (sourceKey === 'DF') {
    const m = refStr.match(/^DF[_-]?(\d+)$/i);
    if (m) {
      return `DF ${parseInt(m[1], 10)}`;
    }
  }

  // Fallback: return as-is
  return refStr;
}

/**
 * Get all formatted references for a letter
 */
function getFormattedReferences(letter) {
  const sources = getLetterSources(letter);
  return sources
    .map(s => formatReference(s.ref, s.key))
    .filter(Boolean);
}

/**
 * Render references line
 */
function renderReferencesLine(letter) {
  const refs = getFormattedReferences(letter);
  if (refs.length === 0) return '';
  return `<span class="references">${escapeHtml(refs.join(' | '))}</span>`;
}

/**
 * Get the SD_ID for display
 */
function getLetterID(letter) {
  return letter.id || letter.SD_ID || letter.sd_id || null;
}

/**
 * Format date range for display
 */
function formatDateRange(start, end, original) {
  // If original date string exists, use it
  if (original && String(original).trim()) {
    // Clean up common patterns
    let cleaned = String(original).trim();
    // Remove leading zeros/placeholders
    cleaned = cleaned.replace(/^0{4,}[;,]?\s*/g, '');
    if (cleaned) return cleaned;
  }

  const ys = parseYear(start);
  const ye = parseYear(end) || ys;

  if (ys && ye) {
    return ys === ye ? String(ys) : `${ys}-${ye}`;
  }
  if (ys) return String(ys);
  if (ye) return String(ye);

  return 'Ukjent dato';
}

function parseYear(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Get place name for display
 */
function getPlaceName(letter) {
  // Search format
  if (letter.p) return letter.p;

  // Geocoding placeholders ('[No_loc]', '[Unclear]') are workflow markers,
  // not display names — fall through to the source spellings instead.
  const normalized = /^\[(No_loc|Unclear)\]$/i.test(letter.Normalized_name || '')
    ? '' : letter.Normalized_name;

  // Full format - prefer normalized name
  const place = normalized ||
         letter.normalized_name ||
         letter.DN_sted ||
         letter.RN_sted ||
         letter.SDHK_sted ||
         letter.DD_sted ||
         letter.DF_sted ||
         null;
  // Editorial uncertainty: dashed convention is a trailing '?'
  if (place && letter.uncertain_loc && !String(place).trim().endsWith('?')) {
    return `${place}?`;
  }
  return place;
}

/**
 * Get summary/preview text
 * For DD letters with empty sammendrag, use first part of brevtekst
 * Also check DD_source for reference information
 */
function getSummaryText(letter, maxLen = 300) {
  // Primary: use sammendrag/regest
  let text = letter.s || letter.sammendrag || letter.regest || '';

  // If no summary but has brevtekst, use that as preview
  if (!text && letter.brevtekst) {
    text = letter.brevtekst;
  }

  // For DD letters without text content, show DD_source as preview
  if (!text && letter.DD_source) {
    text = letter.DD_source;
  }

  return truncateText(text, maxLen);
}

function truncateText(text, maxLen) {
  if (!text || text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.7 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/**
 * Escape HTML entities
 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Highlight query in text
 */
function highlightQuery(text, query) {
  if (!query || !text) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return escaped.replace(rx, '<mark>$&</mark>');
}

/**
 * Convert number to Roman numerals
 */
function toRoman(num) {
  if (!Number.isFinite(num) || num <= 0) return String(num);
  const map = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
  ];
  let out = '';
  for (const [v, s] of map) {
    while (num >= v) { out += s; num -= v; }
  }
  return out;
}

/**
 * Render a complete search result card
 * The card expands seamlessly - preview elements get enhanced, not replaced
 */
function renderSearchResultCard(letter, options = {}) {
  const { query = '', showFulltextButton = true } = options;

  const idx = letter.i ?? letter.__id ?? 0;
  const sdId = getLetterID(letter);
  const date = formatDateRange(letter.ds || letter.date_start, letter.de || letter.date_end, letter.od || letter.original_date);
  const place = getPlaceName(letter) || 'Ukjent sted';

  // Get summary text and process footnotes if available
  const summaryText = getSummaryText(letter);
  const footnotesStr = letter.fotnoter || letter._full?.fotnoter;
  let preview;

  if (footnotesStr) {
    // Parse footnotes and render with hover capability
    const footnoteMap = parseFootnotes(footnotesStr);
    const processed = renderTextWithFootnotes(summaryText, footnoteMap);
    preview = query ? processed.replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<mark>$&</mark>') : processed;
  } else {
    preview = query ? highlightQuery(summaryText, query) : escapeHtml(summaryText);
  }

  return `
    <div class="search-result letter-card" data-idx="${idx}">
      <div class="letter-header">
        <div class="source-badges">${renderSourceBadges(letter)}</div>
        ${sdId ? `<span class="sd-id">${escapeHtml(sdId)}</span>` : ''}
      </div>
      <div class="letter-refs">${renderReferencesLine(letter)}</div>
      <div class="letter-meta" data-idx="${idx}">
        <span class="letter-date">${escapeHtml(date)}</span>
        <span class="letter-place">${escapeHtml(place)}</span>
        <span class="letter-meta-expanded" style="display:none;"></span>
      </div>
      <div class="letter-content" data-idx="${idx}">
        ${preview ? `<span class="letter-summary">${preview}</span>` : ''}
        <span class="letter-continuation" style="display:none;"></span>
      </div>
      ${showFulltextButton ? `
        <div class="letter-footer" data-idx="${idx}" style="display:none;"></div>
        <div class="letter-actions">
          <button class="toggle-details btn-link" aria-expanded="false" data-idx="${idx}">Vis detaljer</button>
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Render a map popup
 */
function renderMapPopup(letter) {
  const date = formatDateRange(letter.ds || letter.date_start, letter.de || letter.date_end, letter.od || letter.original_date);
  const place = getPlaceName(letter) || 'Ukjent sted';
  const summary = getSummaryText(letter, 150);

  return `
    <div class="map-popup">
      <div class="source-badges">${renderSourceBadges(letter)}</div>
      <div class="popup-refs">${renderReferencesLine(letter)}</div>
      <p class="popup-meta"><strong>${escapeHtml(date)}</strong> - ${escapeHtml(place)}</p>
      ${summary ? `<p class="popup-summary">${escapeHtml(summary)}</p>` : ''}
    </div>
  `;
}

/**
 * Parse footnote definitions. Two formats exist in the corpus:
 *   RN: "[^1] text; [^2] text"      DN: "[1] text; [2] text"
 * Definition text may itself contain stray "[" characters
 * ("Fra [ tilskrevet...") and bracketed years, so a definition boundary is
 * only a marker at the start of the string or right after ";" / newline.
 * Returns a map of footnote number to text.
 */
function parseFootnotes(footnotesStr) {
  if (!footnotesStr) return new Map();

  const footnoteMap = new Map();
  const marker = /\[\^?0*(\d+)\]\s*/g;
  const boundaries = [];
  let m;
  while ((m = marker.exec(footnotesStr)) !== null) {
    const before = footnotesStr.slice(0, m.index);
    if (m.index === 0 || /[;\n]\s*$/.test(before)) {
      boundaries.push({ num: parseInt(m[1], 10), contentStart: m.index + m[0].length, markerStart: m.index });
    }
  }
  for (let k = 0; k < boundaries.length; k++) {
    const end = k + 1 < boundaries.length ? boundaries[k + 1].markerStart : footnotesStr.length;
    const text = footnotesStr.slice(boundaries[k].contentStart, end).replace(/[;\s]+$/, '').trim();
    if (text && !footnoteMap.has(boundaries[k].num)) {
      footnoteMap.set(boundaries[k].num, text);
    }
  }

  return footnoteMap;
}

/**
 * Render text with footnote markers as hoverable tooltips
 * Converts [1], [2] etc. into hoverable superscript numbers
 */
function renderTextWithFootnotes(text, footnoteMap) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Replace [N] markers with hoverable superscript footnote numbers (no brackets)
  html = html.replace(/\[\^?(\d+)\]/g, (match, num) => {
    const footnoteNum = parseInt(num, 10);
    const footnoteText = footnoteMap.get(footnoteNum);

    if (footnoteText) {
      return `<sup class="footnote-ref" data-footnote="${footnoteNum}" title="${escapeHtml(footnoteText)}">${num}</sup>`;
    }
    return match; // Keep as-is if no footnote found (could be Roman numeral like [II])
  });

  return html;
}

/**
 * Render footnotes section at the bottom
 */
function renderFootnotesSection(footnoteMap) {
  if (!footnoteMap || footnoteMap.size === 0) return '';

  const items = [];
  for (const [num, text] of footnoteMap) {
    items.push(`<div class="footnote-item" id="fn-${num}"><span class="footnote-num">${num}.</span> ${escapeHtml(text)}</div>`);
  }

  return `<div class="footnotes-section"><div class="footnotes-header">Fotnoter</div>${items.join('')}</div>`;
}

/**
 * Render full letter details for SEAMLESS expansion
 * Shows ALL available fields for the letter.
 * Returns an object with parts that slot into specific card areas:
 * - metaExpanded: additional date/place info (appends to .letter-meta)
 * - continuation: rest of sammendrag text (appends to .letter-content)
 * - footer: all metadata, sources, references (appears in .letter-footer)
 */
function renderLetterDetails(full) {
  // Parse footnotes for hover functionality
  const footnoteMap = parseFootnotes(full.fotnoter);

  // Format text content with footnotes
  const formatTextWithFootnotes = (text) => {
    if (!text) return '';
    return renderTextWithFootnotes(text, footnoteMap).replace(/\n/g, '<br>');
  };

  // Get main text - use sammendrag first, then fall back through alternatives
  let fullSammendrag = full.sammendrag?.trim() || '';
  const regest = full.regest?.trim() || '';
  const brevtekst = full.brevtekst?.trim() || '';

  // Source-specific text fields (these contain reference info but may be primary for some sources)
  const ddSource = full.DD_source?.trim() || '';
  const sdhkSource = full.SDHK_source?.trim() || '';
  const dfSource = full.DF_source?.trim() || '';

  // Determine what to use as main text
  let usedFallback = null;

  // Fall back through: brevtekst -> source-specific fields
  if (!fullSammendrag && brevtekst) {
    fullSammendrag = brevtekst;
    usedFallback = 'brevtekst';
  } else if (!fullSammendrag && ddSource) {
    fullSammendrag = ddSource;
    usedFallback = 'DD_source';
  } else if (!fullSammendrag && sdhkSource) {
    fullSammendrag = sdhkSource;
    usedFallback = 'SDHK_source';
  } else if (!fullSammendrag && dfSource) {
    fullSammendrag = dfSource;
    usedFallback = 'DF_source';
  }

  // === META EXPANSION (only show if there's additional info beyond main display) ===
  // Collect all source-specific dates (only DN and RN have separate date fields)
  const sourceDates = [];
  if (full.DN_dato) sourceDates.push({ src: 'DN', val: full.DN_dato });
  if (full.RN_dato) sourceDates.push({ src: 'RN', val: full.RN_dato });

  const sourcePlaces = [];
  if (full.DN_sted) sourcePlaces.push({ src: 'DN', val: full.DN_sted });
  if (full.RN_sted) sourcePlaces.push({ src: 'RN', val: full.RN_sted });
  if (full.DD_sted) sourcePlaces.push({ src: 'DD', val: full.DD_sted });
  if (full.SDHK_sted) sourcePlaces.push({ src: 'SDHK', val: full.SDHK_sted });
  if (full.DF_sted) sourcePlaces.push({ src: 'DF', val: full.DF_sted });

  // One clean header line. The place itself becomes the map link (the
  // caller applies mapHref to the existing place element — no extra text);
  // per-source variants sit behind ONE disclosure, only when the sources
  // genuinely disagree.
  let metaExpanded = '';
  let mapHref = null;
  let mapTitle = '';
  const sdIdForMap = full.SD_ID || full.sd_id;
  if (full.lat && full.lon && sdIdForMap) {
    const BASE = (window.SITE_BASE || '').replace(/\/+$/, '');
    mapHref = `${BASE}/kart/?sd=${encodeURIComponent(sdIdForMap)}`;
    mapTitle = `Vis på kart · ${full.lat}, ${full.lon}${full.uncertain_loc ? ' (usikker plassering)' : ''}`;
  }

  const uniqueDateVals = new Set(sourceDates.map(d => d.val.trim()));
  const uniquePlaceVals = new Set(sourcePlaces.map(sp => sp.val.replace(/[.\s]+$/, '').toLowerCase()));
  const metaRows = [];
  if (sourceDates.length > 1 && uniqueDateVals.size > 1) {
    for (const d of sourceDates) metaRows.push([`Datering ${d.src}`, d.val]);
  }
  if (sourcePlaces.length > 1 && uniquePlaceVals.size > 1) {
    for (const sp of sourcePlaces) metaRows.push([`Sted ${sp.src}`, sp.val]);
  }
  if (metaRows.length > 0) {
    metaExpanded = `<details class="meta-details"><summary>datering og sted i kildene</summary><table class="meta-table"><tbody>` +
      metaRows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') +
      `</tbody></table></details>`;
  }

  // === TEXT CONTINUATION ===
  const previewLength = 300;
  const wasTruncated = fullSammendrag.length > previewLength;
  let continuation = '';
  let summaryWithFootnotes = '';

  // Calculate cutpoint for preview/continuation split
  let cutPoint = previewLength;
  if (wasTruncated) {
    const lastSpace = fullSammendrag.lastIndexOf(' ', previewLength);
    if (lastSpace > previewLength * 0.7) cutPoint = lastSpace;
  } else {
    cutPoint = fullSammendrag.length;
  }

  // Process preview portion with footnotes
  const previewText = fullSammendrag.slice(0, cutPoint);
  summaryWithFootnotes = formatTextWithFootnotes(previewText);

  // Process continuation if truncated
  if (wasTruncated) {
    const rest = fullSammendrag.slice(cutPoint).trim();
    if (rest) {
      continuation = formatTextWithFootnotes(rest);
    }
  }

  // Add regest if different from main text
  const hasRegest = regest && regest !== fullSammendrag;
  if (hasRegest) {
    continuation += `<div class="detail-section"><em>Regest:</em> ${formatTextWithFootnotes(regest)}</div>`;
  }

  // Add brevtekst if not used as main and exists
  const showBrevtekstSeparate = usedFallback !== 'brevtekst' && brevtekst && brevtekst !== fullSammendrag;
  if (showBrevtekstSeparate) {
    continuation += `<div class="detail-section"><em>Brevtekst:</em> ${formatTextWithFootnotes(brevtekst)}</div>`;
  }

  // Modern translation (DD: tran_text), separate from the original text
  if (full.oversettelse?.trim()) {
    continuation += `<div class="detail-section"><em>Oversettelse:</em> ${formatTextWithFootnotes(full.oversettelse)}</div>`;
  }

  // Critical apparatus (DD: variant readings per witness)
  if (full.tekstapparat?.trim()) {
    continuation += `<div class="detail-section"><em>Tekstapparat:</em> ${escapeHtml(full.tekstapparat)}</div>`;
  }

  // Editorial notes (DD: nts)
  if (full.noter?.trim()) {
    continuation += `<div class="detail-section"><em>Noter:</em> ${escapeHtml(full.noter)}</div>`;
  }

  // People and places mentioned in the letter (tagged in the curation tool)
  if (Array.isArray(full.nevnte) && full.nevnte.length > 0) {
    const chips = full.nevnte.map((m) => {
      const icon = m.kind === 'person' ? '●' : m.region ? '▦' : '⌖';
      const label = escapeHtml(m.name || m.text);
      return (m.lat != null && m.lon != null)
        ? `<span class="nevnt-chip" title="${m.lat}, ${m.lon}">${icon} ${label}</span>`
        : `<span class="nevnt-chip nevnt-uplassert" title="ikke stedfestet ennå">${icon} ${label}</span>`;
    }).join(' ');
    continuation += `<div class="detail-section"><em>Nevnte:</em> ${chips}</div>`;
  }

  // Add tillegg if present
  if (full.Tillegg?.trim()) {
    continuation += `<div class="detail-section"><em>Tillegg:</em> ${escapeHtml(full.Tillegg)}</div>`;
  }

  // Language (curator tag, or the source's own statement)
  if (full.language?.trim()) {
    continuation += `<div class="detail-section"><em>Språk:</em> ${escapeHtml(full.language)}</div>`;
  }

  // === FOOTER (Source data + Kilder + More section) ===
  let footer = '';

  // Sources/References (bibliographic) - this is the primary metadata
  // Skip sources that were already used as main text
  const sources = [];
  if (full.DN_source) sources.push(`<div class="source-item"><span class="source-label">DN:</span> ${escapeHtml(full.DN_source)}</div>`);
  if (full.RN_source) sources.push(`<div class="source-item"><span class="source-label">RN:</span> ${escapeHtml(full.RN_source)}</div>`);
  if (ddSource && usedFallback !== 'DD_source') sources.push(`<div class="source-item"><span class="source-label">DD:</span> ${escapeHtml(ddSource)}</div>`);
  if (sdhkSource && usedFallback !== 'SDHK_source') sources.push(`<div class="source-item"><span class="source-label">SDHK:</span> ${escapeHtml(sdhkSource)}</div>`);
  if (dfSource && usedFallback !== 'DF_source') sources.push(`<div class="source-item"><span class="source-label">DF:</span> ${escapeHtml(dfSource)}</div>`);

  if (sources.length > 0) {
    footer += `<div class="detail-section"><em>Kilder:</em><div class="source-list">${sources.join('')}</div></div>`;
  }

  // Footnotes
  if (footnoteMap.size > 0) {
    const fnItems = [];
    for (const [num, text] of footnoteMap) {
      fnItems.push(`<div class="footnote-item"><span class="footnote-num">${num}.</span> ${escapeHtml(text)}</div>`);
    }
    footer += `<div class="detail-section"><em>Fotnoter:</em><div class="footnotes-list">${fnItems.join('')}</div></div>`;
  }

  // External links
  if (full.DF_url) {
    footer += `<div class="detail-section"><a href="${escapeHtml(full.DF_url)}" target="_blank" rel="noopener noreferrer" class="external-link-btn">Se i Diplomatarium Fennicum →</a></div>`;
  }

  // === MORE SECTION (synthetic/computed data) ===
  const moreItems = [];

  // Place/coordinates/dates live in the header + meta disclosure now;
  // this blob keeps only identifiers.
  // IDs
  const sdId = full.SD_ID || full.sd_id;
  const srcId = full.src_id;
  const relatedIds = full.related_sd_ids;

  if (sdId) moreItems.push(`<strong>SD_ID:</strong> ${escapeHtml(sdId)}`);
  if (srcId) moreItems.push(`<strong>SRC_ID:</strong> ${escapeHtml(srcId)}`);
  if (relatedIds && relatedIds.length > 0) {
    moreItems.push(`<strong>Relaterte:</strong> ${escapeHtml(relatedIds.join(', '))}`);
  }

  if (moreItems.length > 0) {
    footer += `<div class="more-section">${moreItems.join(' · ')}</div>`;
  }

  // Cross-references (at bottom, just show the ref IDs without redundant source prefix)
  if (full.cross_references && Array.isArray(full.cross_references) && full.cross_references.length > 0) {
    const crossRefs = full.cross_references
      .filter(cr => cr.ref)
      .map(cr => cr.ref)
      // extractor garbage: collapsed archive signums and volume-zero refs
      .filter(r => !/^(?:RA|NRA|DRA|Est)_\d+$|^DN_00_/.test(r));

    if (crossRefs.length > 0) {
      footer += `<div class="detail-section"><em>Kryssreferanser:</em> ${escapeHtml(crossRefs.join(' | '))}</div>`;
    }
  }

  // Return structured object for seamless insertion
  return {
    metaExpanded,
    mapHref,
    mapTitle,
    summaryWithFootnotes,  // Preview text with footnote hovers
    continuation,
    footer
  };
}

/**
 * Render related documents badge for letters with multiple sources
 */
function renderRelatedBadge(letter) {
  const relatedIds = letter.rel || letter.related_sd_ids;
  if (!relatedIds || relatedIds.length === 0) return '';

  const count = relatedIds.length + 1;  // +1 for the current letter
  return `<span class="multi-source-badge" title="This document appears in ${count} sources">${count} sources</span>`;
}

/**
 * Check if letter has related source documents
 */
function hasRelatedDocuments(letter) {
  const relatedIds = letter.rel || letter.related_sd_ids;
  return relatedIds && relatedIds.length > 0;
}

/**
 * Get related document IDs
 */
function getRelatedIds(letter) {
  return letter.rel || letter.related_sd_ids || [];
}

/**
 * Get source document ID (SRC_ID)
 */
function getSourceDocumentId(letter) {
  return letter.srcid || letter.src_id || null;
}

/**
 * Render source tabs for multi-source documents
 * @param {Object} currentLetter - The currently displayed letter
 * @param {Array} allMembers - Array of all related letters (including current)
 */
function renderSourceTabs(currentLetter, allMembers) {
  if (!allMembers || allMembers.length <= 1) return '';

  const tabs = allMembers.map((letter, idx) => {
    const sources = getLetterSources(letter);
    const sdId = getLetterID(letter);
    const currentSdId = getLetterID(currentLetter);
    const isActive = sdId === currentSdId;

    // Get formatted reference for tab label
    const refs = getFormattedReferences(letter);
    const label = refs.length > 0 ? refs[0] : (sources[0]?.key || 'Unknown');

    return `
      <button class="source-tab ${isActive ? 'active' : ''}"
              data-sd-id="${escapeHtml(sdId)}"
              data-idx="${idx}"
              title="View ${escapeHtml(label)}">
        ${escapeHtml(label)}
      </button>
    `;
  }).join('');

  return `
    <div class="source-tabs-container">
      <span class="tabs-label">Sources:</span>
      <div class="source-tabs">${tabs}</div>
    </div>
  `;
}

/**
 * Render a comparison view of summaries from multiple sources
 */
function renderSummaryComparison(letters) {
  if (!letters || letters.length <= 1) return '';

  const summaries = letters.map(letter => {
    const sources = getLetterSources(letter);
    const sourceLabel = sources.length > 0 ? sources[0].key : 'Unknown';
    const text = letter.s || letter.sammendrag || letter.regest || '';

    if (!text) return null;

    return `
      <div class="comparison-source">
        <span class="comparison-label">${escapeHtml(sourceLabel)}</span>
        <p class="comparison-text">${escapeHtml(text)}</p>
      </div>
    `;
  }).filter(Boolean);

  if (summaries.length <= 1) return '';

  return `
    <div class="summary-comparison">
      <h4>Summary Comparison</h4>
      ${summaries.join('')}
    </div>
  `;
}

// Export for use in other modules
if (typeof window !== 'undefined') {
  window.LetterDisplay = {
    SOURCES,
    getLetterSources,
    renderSourceBadges,
    formatReference,
    getFormattedReferences,
    renderReferencesLine,
    getLetterID,
    formatDateRange,
    getPlaceName,
    getSummaryText,
    escapeHtml,
    highlightQuery,
    toRoman,
    renderSearchResultCard,
    renderMapPopup,
    renderLetterDetails,
    // Footnote functions
    parseFootnotes,
    renderTextWithFootnotes,
    renderFootnotesSection,
    // SRC_ID related functions
    renderRelatedBadge,
    hasRelatedDocuments,
    getRelatedIds,
    getSourceDocumentId,
    renderSourceTabs,
    renderSummaryComparison
  };
}
