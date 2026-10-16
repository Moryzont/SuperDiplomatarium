/**
 * SuperDiplomatarium Internationalization (i18n)
 * Supports Norwegian (no) and English (en)
 */

const TRANSLATIONS = {
  no: {
    // Navigation
    'nav.search': 'Søk',
    'nav.map': 'Kart',
    'nav.about': 'Om samlingen',

    // Search page
    'search.title': 'Søk i brevsamlingen',
    'search.field.label': 'Søk i:',
    'search.field.id': 'Referanse / ID',
    'search.field.text': 'Tekst (sammendrag)',
    'search.field.fulltext': 'Fulltekst (brevtekst)',
    'search.field.place': 'Sted',
    'search.field.all': 'Alt',
    'search.placeholder.text': 'Søk i sammendrag...',
    'search.placeholder.id': 'DN XII 251, SD20011494, SDHK 1234...',
    'search.placeholder.fulltext': 'Søk i brevtekst...',
    'search.placeholder.place': 'Søk etter sted...',
    'search.placeholder.all': 'Søk i alle felt...',
    'search.button': 'Søk',

    // Search tips
    'tips.title': 'Søketips',
    'tips.id': 'Referanse/ID:',
    'tips.id.examples': 'DN XII 251, DN12000251, SD20011494, SDHK 1234',

    // Filters
    'filters.date': 'Datoperiode:',
    'filters.from': 'Fra (YYYY)',
    'filters.to': 'Til (YYYY)',
    'filters.sort': 'Sortering:',
    'filters.sort.date': 'Dato (eldst først)',
    'filters.sort.date.desc': 'Dato (nyest først)',
    'filters.sort.completeness': 'Mest komplett',

    // Results
    'results.loading': 'Laster inn...',
    'results.searching': 'Søker...',
    'results.hits': 'treff',
    'results.showing': 'Viser',
    'results.of': 'av',
    'results.none': 'Ingen treff',
    'results.enter': 'Skriv inn søkeord eller velg datofilter.',

    // Letter display
    'letter.date': 'Datering:',
    'letter.place': 'Sted:',
    'letter.summary': 'Sammendrag',
    'letter.regest': 'Regest',
    'letter.source': 'Kilde',
    'letter.additional': 'Tillegg',
    'letter.external': 'Eksterne lenker',
    'letter.view.df': 'Vis i Diplomatarium Fennicum',
    'letter.show': 'Vis detaljer',
    'letter.hide': 'Skjul detaljer',
    'letter.unknown.place': 'Ukjent sted',

    // Export
    'export.csv': 'Eksporter CSV',
    'export.txt': 'Eksporter TXT',

    // Pagination
    'page.first': 'Første',
    'page.prev': 'Forrige',
    'page.next': 'Neste',
    'page.last': 'Siste',

    // Language
    // added 2026-10-14 for the complete English mode
    'tips.ref': "Søk etter referanse:",
    'tips.ref.desc': "Velg «Referanse / ID» og skriv f.eks.",
    'tips.text': "Tekstsøk:",
    'tips.text.desc': "Søk etter ord eller fraser i sammendrag. Eksempel:",
    'tips.place': "Stedsøk:",
    'tips.place.desc': "Velg «Sted» for å søke etter stedsnavn. Eksempel:",
    'tips.date': "Datofilter:",
    'tips.date.desc': "Bruk «Filtre» for å begrense til en tidsperiode, f.eks. 1200–1350",
    'tips.source': "Kildefilter:",
    'tips.source.desc': "Bruk «Filtre» for å begrense søket til bestemte diplomataria",
    'filters.title': "Filtre",
    'filters.sources': "Kilder:",
    'sort.title': "Sortering",
    'fuzzy.title': "Fuzzy",
    'fuzzy.on': "Fuzzy-søk",
    'fuzzy.level': "Fuzzy-nivå:",
    'fuzzy.level.1': "Moderat",
    'fuzzy.level.2': "Vid",
    'fuzzy.level.3': "Svært vid",
    'fuzzy.hint': "Fuzzy-søk finner også ord som er stavet litt annerledes, f.eks. Kaytala for Caytala. Høyere nivå tillater flere avvik, men gir flere irrelevante treff. Gjelder ikke referansesøk.",
    'results.ready': "brev klare for søk.",
    'results.loadError': "Kunne ikke laste data. Prøv å laste siden på nytt.",
    'results.failed': "Søket feilet. Prøv på nytt.",
    'results.stillLoading': "Laster fortsatt data, prøv igjen straks...",
    'results.count': "{n} treff ({ms} ms)",
    'results.showingRange': "Viser {from}-{to} av {total} treff",
    'results.hitsN': "{n} treff",
    'letter.unknown': "Ukjent",
    'letter.body': "Brevtekst:",
    'letter.translation': "Oversettelse:",
    'letter.sources': "Kilder:",
    'letter.footnotes': "Fotnoter:",
    'letter.editorial': "Redaksjonelt (tekstapparat, noter, fotnoter)",
    'letter.footnotesTitle': "Fotnoter",
    'letter.mentions': "Register (personer, steder og emner fra utgavenes registre)",
    'letter.subjects': "Emneord:",
    'letter.mentionFrom': "Fra utgavens register ({src})",
    'letter.mentionCurated': "Lagt til i SuperDiplomatarium",
    'letter.language': "Språk:",
    'letter.related': "Relaterte:",
    'letter.showOnMap': "Vis på kart",
    'letter.uncertainLoc': "(usikker plassering)",
    'letter.notPlaced': "ikke stedfestet ennå",
    'letter.loading': "Laster...",
    'letter.loadFailed': "Kunne ikke laste.",
    'letter.detailsHint': "(Vis detaljer for innhold)",
    'letter.unknown.date': "Ukjent dato",
    'export.confirm': "Dette vil laste ned data for {n} treff og kan ta litt tid. Fortsette?",
    'export.preparing': "Forbereder eksport av {n} treff...",
    'export.progress': "Forbereder eksport... {done}/{total}",
    'export.done': "{n} treff eksportert.",
    'export.title': "Eksportér utvalg:",
    'export.downloadTxt': "Last ned TXT",
    'export.downloadCsv': "Last ned CSV",
    'map.title': "Geografisk utforskning",
    'map.draw': "Tegn område",
    'map.clear': "Fjern valg",
    'map.withPlace': "{n} brev med stedsinformasjon",
    'map.inArea': "{n} brev i valgt område",
    'map.noneInArea': "Ingen brev i valgt område",
    'map.showLetter': "Vis brevet",
    'map.mentioned': "nevnt i brevet",
    'map.loadError': "Klarte ikke å laste kartdata.",
    'letter.moreRelated': '{n} flere relaterte oppføringer',
    'letter.clickToShow': 'klikk for å vise',
    'letter.crossRefs': 'Kryssreferanser:',
    'map.inAreas': '{n} brev i {k} valgte områder',
    'letter.bodyTitle': 'Brevtekst',
    'letter.noText': 'Ingen tekst tilgjengelig.',
    'map.removeArea': 'Fjern dette området',
    'lang.switch': 'English',
  },

  en: {
    // Navigation
    'nav.search': 'Search',
    'nav.map': 'Map',
    'nav.about': 'About',

    // Search page
    'search.title': 'Search the letter collection',
    'search.field.label': 'Search in:',
    'search.field.id': 'Reference / ID',
    'search.field.text': 'Text (summary)',
    'search.field.fulltext': 'Full text (letter body)',
    'search.field.place': 'Place',
    'search.field.all': 'All fields',
    'search.placeholder.text': 'Search in summaries...',
    'search.placeholder.id': 'DN XII 251, SD20011494, SDHK 1234...',
    'search.placeholder.fulltext': 'Search in letter text...',
    'search.placeholder.place': 'Search by place...',
    'search.placeholder.all': 'Search all fields...',
    'search.button': 'Search',

    // Search tips
    'tips.title': 'Search tips',
    'tips.id': 'Reference/ID:',
    'tips.id.examples': 'DN XII 251, DN12000251, SD20011494, SDHK 1234',

    // Filters
    'filters.date': 'Date range:',
    'filters.from': 'From (YYYY)',
    'filters.to': 'To (YYYY)',
    'filters.sort': 'Sort by:',
    'filters.sort.date': 'Date (oldest first)',
    'filters.sort.date.desc': 'Date (newest first)',
    'filters.sort.completeness': 'Most complete',

    // Results
    'results.loading': 'Loading...',
    'results.searching': 'Searching...',
    'results.hits': 'results',
    'results.showing': 'Showing',
    'results.of': 'of',
    'results.none': 'No results',
    'results.enter': 'Enter search terms or select date filter.',

    // Letter display
    'letter.date': 'Date:',
    'letter.place': 'Place:',
    'letter.summary': 'Summary',
    'letter.regest': 'Regest',
    'letter.source': 'Source',
    'letter.additional': 'Additional notes',
    'letter.external': 'External links',
    'letter.view.df': 'View in Diplomatarium Fennicum',
    'letter.show': 'Show details',
    'letter.hide': 'Hide details',
    'letter.unknown.place': 'Unknown place',

    // Export
    'export.csv': 'Export CSV',
    'export.txt': 'Export TXT',

    // Pagination
    'page.first': 'First',
    'page.prev': 'Previous',
    'page.next': 'Next',
    'page.last': 'Last',

    // Language
    // added 2026-10-14 for the complete English mode
    'tips.ref': "Search by reference:",
    'tips.ref.desc': "Choose “Reference / ID” and type e.g.",
    'tips.text': "Text search:",
    'tips.text.desc': "Search for words or phrases in the summaries. Example:",
    'tips.place': "Place search:",
    'tips.place.desc': "Choose “Place” to search by place name. Example:",
    'tips.date': "Date filter:",
    'tips.date.desc': "Use “Filters” to limit the search to a period, e.g. 1200–1350",
    'tips.source': "Source filter:",
    'tips.source.desc': "Use “Filters” to limit the search to particular diplomataria",
    'filters.title': "Filters",
    'filters.sources': "Sources:",
    'sort.title': "Sorting",
    'fuzzy.title': "Fuzzy",
    'fuzzy.on': "Fuzzy search",
    'fuzzy.level': "Fuzzy level:",
    'fuzzy.level.1': "Moderate",
    'fuzzy.level.2': "Wide",
    'fuzzy.level.3': "Very wide",
    'fuzzy.hint': "Fuzzy search also finds words spelled slightly differently, e.g. Kaytala for Caytala. A higher level allows more deviation but gives more irrelevant hits. Does not apply to reference search.",
    'results.ready': "letters ready to search.",
    'results.loadError': "Could not load the data. Please reload the page.",
    'results.failed': "The search failed. Please try again.",
    'results.stillLoading': "Still loading, try again in a moment...",
    'results.count': "{n} hits ({ms} ms)",
    'results.showingRange': "Showing {from}-{to} of {total} hits",
    'results.hitsN': "{n} hits",
    'letter.unknown': "Unknown",
    'letter.body': "Letter text:",
    'letter.translation': "Translation:",
    'letter.sources': "Sources:",
    'letter.footnotes': "Footnotes:",
    'letter.editorial': "Editorial matter (apparatus, notes, footnotes)",
    'letter.footnotesTitle': "Footnotes",
    'letter.mentions': "Index (persons, places and subjects from the editions' registers)",
    'letter.subjects': "Subjects:",
    'letter.mentionFrom': "From the edition's register ({src})",
    'letter.mentionCurated': "Added in SuperDiplomatarium",
    'letter.language': "Language:",
    'letter.related': "Related:",
    'letter.showOnMap': "Show on map",
    'letter.uncertainLoc': "(uncertain location)",
    'letter.notPlaced': "not located yet",
    'letter.loading': "Loading...",
    'letter.loadFailed': "Could not load.",
    'letter.detailsHint': "(Show details for the content)",
    'letter.unknown.date': "Unknown date",
    'export.confirm': "This will download data for {n} hits and may take a while. Continue?",
    'export.preparing': "Preparing export of {n} hits...",
    'export.progress': "Preparing export... {done}/{total}",
    'export.done': "{n} hits exported.",
    'export.title': "Export selection:",
    'export.downloadTxt': "Download TXT",
    'export.downloadCsv': "Download CSV",
    'map.title': "Geographic exploration",
    'map.draw': "Draw area",
    'map.clear': "Clear selection",
    'map.withPlace': "{n} letters with place information",
    'map.inArea': "{n} letters in the selected area",
    'map.noneInArea': "No letters in the selected area",
    'map.showLetter': "Show the letter",
    'map.mentioned': "mentioned in the letter",
    'map.loadError': "Could not load the map data.",
    'letter.moreRelated': '{n} more related entries',
    'letter.clickToShow': 'click to show',
    'letter.crossRefs': 'Cross-references:',
    'map.inAreas': '{n} letters in {k} selected areas',
    'letter.bodyTitle': 'Letter text',
    'letter.noText': 'No text available.',
    'map.removeArea': 'Remove this area',
    'lang.switch': 'Norsk',
  }
};

// Current language (default to stored preference or Norwegian)
let currentLang = localStorage.getItem('sd-lang') || 'no';

/**
 * Get translation for a key
 */
function t(key, params) {
  let text = TRANSLATIONS[currentLang]?.[key] || TRANSLATIONS['no'][key] || key;
  if (params) for (const [k, v] of Object.entries(params)) text = text.split('{' + k + '}').join(String(v));
  return text;
}

/**
 * Set current language and update all translated elements
 */
function setLanguage(lang) {
  if (!TRANSLATIONS[lang]) {
    console.warn('Unknown language:', lang);
    return;
  }

  currentLang = lang;
  localStorage.setItem('sd-lang', lang);

  // Update html lang attribute
  document.documentElement.lang = lang;

  // Update all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });

  // Update placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    el.placeholder = t(key);
  });

  // Update option text in selects
  document.querySelectorAll('[data-i18n-options]').forEach(select => {
    select.querySelectorAll('option[data-i18n]').forEach(opt => {
      opt.textContent = t(opt.dataset.i18n);
    });
  });

  // Update language toggle button
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.textContent = t('lang.switch');
  }

  window.dispatchEvent(new CustomEvent('sd:language', { detail: lang }));
}

/**
 * Toggle between languages
 */
function toggleLanguage() {
  setLanguage(currentLang === 'no' ? 'en' : 'no');
}

/**
 * Get current language
 */
function getLang() {
  return currentLang;
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  // Wire up language toggle button
  const langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.addEventListener('click', toggleLanguage);
    langBtn.textContent = t('lang.switch');
  }

  // Apply stored language preference
  if (localStorage.getItem('sd-lang')) {
    setLanguage(currentLang);
  }
});

// Export for use in other scripts
window.i18n = { t, setLanguage, toggleLanguage, getLang };
