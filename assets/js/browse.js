/**
 * Shared pieces for the browsing pages (/register/, /tidslinje/): the full
 * records are loaded by global index from data/optimized/full-XX.json (the
 * same store the search and the map use), rendered with the search page's
 * card (assets/js/letter-display.js) and expanded in place.
 */
(function () {
  const BASE = (window.SITE_BASE || '').replace(/\/+$/, '');
  const CHUNK = 100;                              // letters per full-XX.json (build-search-v3.mjs)
  const cache = new Map();
  const loaded = new Set();
  const LD = () => window.LetterDisplay;

  async function loadFull(indices) {
    const need = new Set();
    for (const i of indices) if (!cache.has(i)) need.add(Math.floor(i / CHUNK));
    await Promise.all([...need].filter(c => !loaded.has(c)).map(async (c) => {
      try {
        const res = await fetch(`${BASE}/data/optimized/full-${String(c).padStart(2, '0')}.json`);
        if (!res.ok) return;
        for (const r of await res.json()) cache.set(r.i, r);
        loaded.add(c);
      } catch (e) { console.error('full chunk', c, e); }
    }));
    return indices.map(i => cache.get(i)).filter(Boolean);
  }

  function renderCards(container, fulls, opts = {}) {
    container.innerHTML = fulls.map(r => LD().renderSearchResultCard(r, { query: opts.query || '' })).join('');
    container.querySelectorAll('.toggle-details').forEach(btn => btn.addEventListener('click', () => toggle(btn)));
  }

  function appendCards(container, fulls, opts = {}) {
    const tmp = document.createElement('div');
    tmp.innerHTML = fulls.map(r => LD().renderSearchResultCard(r, { query: opts.query || '' })).join('');
    tmp.querySelectorAll('.toggle-details').forEach(btn => btn.addEventListener('click', () => toggle(btn)));
    while (tmp.firstChild) container.appendChild(tmp.firstChild);
  }

  async function toggle(btn) {
    const card = btn.closest('.letter-card');
    const idx = parseInt(btn.dataset.idx, 10);
    const open = btn.getAttribute('aria-expanded') === 'true';
    const contEl = card.querySelector('.letter-continuation');
    const footerEl = card.querySelector('.letter-footer');
    const metaExpEl = card.querySelector('.letter-meta-expanded');
    if (open) {
      btn.setAttribute('aria-expanded', 'false');
      btn.textContent = t('letter.show');
      if (contEl) contEl.style.display = 'none';
      if (footerEl) footerEl.style.display = 'none';
      if (metaExpEl) metaExpEl.style.display = 'none';
      return;
    }
    btn.setAttribute('aria-expanded', 'true');
    btn.textContent = t('letter.hide');
    if (card.dataset.loaded === '1') {
      if (contEl) contEl.style.display = 'inline';
      if (footerEl) footerEl.style.display = 'block';
      if (metaExpEl && metaExpEl.innerHTML) metaExpEl.style.display = 'inline';
      return;
    }
    const [full] = await loadFull([idx]);
    if (!full) return;
    const d = LD().renderLetterDetails(full);
    const placeEl = card.querySelector('.letter-place');
    if (placeEl && d.mapHref && !placeEl.querySelector('.place-link')) {
      const name = LD().getPlaceName(full) || placeEl.textContent;
      placeEl.innerHTML = `<a class="place-link" href="${d.mapHref}" title="${LD().escapeHtml(d.mapTitle)}">${LD().escapeHtml(name)}</a>`;
    }
    if (metaExpEl && d.metaExpanded) { metaExpEl.innerHTML = d.metaExpanded; metaExpEl.style.display = 'inline'; }
    const summaryEl = card.querySelector('.letter-summary');
    if (summaryEl) summaryEl.innerHTML = d.summaryWithFootnotes || LD().escapeHtml(full.sammendrag || full.brevtekst || '');
    if (contEl) { contEl.innerHTML = d.continuation ? ' ' + d.continuation : ''; contEl.style.display = 'inline'; }
    if (footerEl && d.footer) { footerEl.innerHTML = d.footer; footerEl.style.display = 'block'; }
    card.dataset.loaded = '1';
  }

  async function fetchJson(rel) {
    const res = await fetch(`${BASE}/data/v3/${rel}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${rel}`);
    return res.json();
  }

  window.SDBrowse = { BASE, loadFull, renderCards, appendCards, fetchJson };
})();
