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
    'tips.text': 'Tekst:',
    'tips.text.desc': 'Søk i sammendrag og regest',
    'tips.place': 'Sted:',
    'tips.place.desc': 'Søk etter stedsnavn',

    // Filters
    'filters.title': 'Filtre og sortering',
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
    'results.ready': 'brev klare for søk!',
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
    'letter.body': 'Brevtekst',
    'letter.source': 'Kilde',
    'letter.footnotes': 'Fotnoter',
    'letter.additional': 'Tillegg',
    'letter.related': 'Relaterte dokumenter',
    'letter.external': 'Eksterne lenker',
    'letter.view.df': 'Vis i Diplomatarium Fennicum',
    'letter.show': 'Vis detaljer',
    'letter.hide': 'Skjul detaljer',
    'letter.unknown.date': 'Ukjent',
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
    'tips.text': 'Text:',
    'tips.text.desc': 'Search in summaries and regests',
    'tips.place': 'Place:',
    'tips.place.desc': 'Search by place name',

    // Filters
    'filters.title': 'Filters and sorting',
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
    'results.ready': 'letters ready to search!',
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
    'letter.body': 'Letter text',
    'letter.source': 'Source',
    'letter.footnotes': 'Footnotes',
    'letter.additional': 'Additional notes',
    'letter.related': 'Related documents',
    'letter.external': 'External links',
    'letter.view.df': 'View in Diplomatarium Fennicum',
    'letter.show': 'Show details',
    'letter.hide': 'Hide details',
    'letter.unknown.date': 'Unknown',
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
    'lang.switch': 'Norsk',
  }
};

// Current language (default to stored preference or Norwegian)
let currentLang = localStorage.getItem('sd-lang') || 'no';

/**
 * Get translation for a key
 */
function t(key) {
  return TRANSLATIONS[currentLang]?.[key] || TRANSLATIONS['no'][key] || key;
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
