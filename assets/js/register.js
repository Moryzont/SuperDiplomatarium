/**
 * /register/ — the editions' registers as one browsable index.
 *
 * data/v3/register/index.json lists the initial letters; each letter's file
 * holds its headwords {n name, k kind, s sources, c count, i global indices}
 * (scripts/build-search-v3.mjs, part register-pages). Opening an entry loads
 * the letters' full records and shows them as the search page's cards.
 */
(function () {
  const B = window.SDBrowse;
  const LD = () => window.LetterDisplay;
  const esc = (s) => LD().escapeHtml(s);
  const PAGE = 20;
  const ICON = { person: '●', place: '⌖', subject: '◆' };
  const COLOURS = { DN: '#5c6d4a', RN: '#6b8e7a', SDHK: '#8b7355', DD: '#8b5a5a', DF: '#5a7a6b', DI: '#6a6e8c' };
  const state = { index: null, letter: null, entries: [], kind: 'all', filter: '' };

  const lettersEl = document.getElementById('register-letters');
  const entriesEl = document.getElementById('register-entries');
  const statusEl = document.getElementById('register-status');
  const filterEl = document.getElementById('register-filter');

  function fmt(n) { return Number(n).toLocaleString('nb-NO'); }

  async function init() {
    state.index = await B.fetchJson('register/index.json');
    lettersEl.innerHTML = state.index.letters.map(l =>
      `<a href="#${encodeURIComponent(l.letter)}" data-letter="${esc(l.letter)}" data-file="${esc(l.file)}">${esc(l.letter)}<small>${fmt(l.entries)}</small></a>`).join('');
    lettersEl.addEventListener('click', (ev) => {
      const a = ev.target.closest('a[data-letter]');
      if (!a) return;
      ev.preventDefault();
      openLetter(a.dataset.letter, a.dataset.file);
      history.replaceState(null, '', `#${encodeURIComponent(a.dataset.letter)}`);
    });
    document.getElementById('register-kinds').addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-kind]');
      if (!b) return;
      state.kind = b.dataset.kind;
      document.querySelectorAll('#register-kinds button').forEach(x => x.classList.toggle('active', x === b));
      renderEntries();
    });
    filterEl.addEventListener('input', () => { state.filter = filterEl.value.trim().toLowerCase(); renderEntries(); });
    const params = new URLSearchParams(location.search);
    const wanted = decodeURIComponent((location.hash || '').slice(1)) || params.get('bokstav') || 'A';
    const target = state.index.letters.find(l => l.letter === wanted) || state.index.letters.find(l => l.letter === 'A') || state.index.letters[0];
    if (target) await openLetter(target.letter, target.file);
    const q = params.get('q');
    if (q) { filterEl.value = q; state.filter = q.toLowerCase(); renderEntries(); }
  }

  async function openLetter(letter, file) {
    state.letter = letter;
    lettersEl.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.letter === letter));
    statusEl.textContent = t('register.loading');
    entriesEl.innerHTML = '';                       // the previous letter's entries go while this one loads
    entriesEl.dataset.letter = '';
    const data = await B.fetchJson(`register/${file}`);
    if (state.letter !== letter) return;            // the reader moved on meanwhile
    entriesEl.dataset.letter = letter;
    state.entries = data.entries;
    renderEntries();
  }

  function visibleEntries() {
    return state.entries.filter(e => (state.kind === 'all' || e.k === state.kind) && (!state.filter || e.n.toLowerCase().includes(state.filter)));
  }

  function renderEntries() {
    const list = visibleEntries();
    statusEl.textContent = t('register.entries', { n: fmt(list.length) });
    if (!list.length) { entriesEl.innerHTML = `<p>${t('register.none')}</p>`; return; }
    entriesEl.innerHTML = list.map((e, idx) => `
      <div class="reg-entry" data-n="${idx}">
        <span class="reg-head" role="button" tabindex="0">
          <span class="reg-icon">${ICON[e.k] || ''}</span><span class="reg-name">${esc(e.n)}</span><span class="reg-count">${fmt(e.c)}</span>
          ${e.s.map(s => `<span class="reg-src" style="background:${COLOURS[s] || '#777'}">${esc(s)}</span>`).join('')}
        </span>
      </div>`).join('');
    entriesEl.querySelectorAll('.reg-head').forEach(h => {
      h.addEventListener('click', () => toggleEntry(h.closest('.reg-entry'), list));
      h.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleEntry(h.closest('.reg-entry'), list); } });
    });
  }

  /*
   * An open entry spans both columns. Left in the column flow (column-span), it
   * would rebalance everything before it into two new columns, and an entry from
   * the right column would land far down the page. So the two columns are split
   * at the entry's row instead: the rows above stay where they are, the entry and
   * its letters follow at full width, the rest goes on in two columns below.
   * Closing the entry joins the columns again. One column (phones): no split.
   */
  const ONE_COLUMN = window.matchMedia('(max-width: 760px)');

  function makeRows(left, right) {
    const rows = document.createElement('div');
    rows.className = 'reg-rows';
    [left, right].forEach(items => {
      const col = document.createElement('div');
      col.className = 'reg-col';
      col.append(...items);
      rows.appendChild(col);
    });
    return rows;
  }

  function splitAt(el) {
    const scope = el.closest('.reg-rows') || entriesEl;
    const items = [...scope.querySelectorAll('.reg-entry')].filter(x => x !== el && !x.classList.contains('open'));
    const mid = scope.getBoundingClientRect().left + scope.getBoundingClientRect().width / 2;
    const colOf = (x) => scope === entriesEl ? (x.getBoundingClientRect().left < mid ? 0 : 1)
      : [...scope.children].indexOf(x.parentElement);
    const top = el.getBoundingClientRect().top;
    const parts = [[], [], [], []];                 // above left, above right, below left, below right
    items.forEach(x => { parts[(x.getBoundingClientRect().top < top - 1 ? 0 : 2) + colOf(x)].push(x); });
    el.dataset.col = colOf(el);
    const above = makeRows(parts[0], parts[1]);
    const below = makeRows(parts[2], parts[3]);
    if (scope === entriesEl) {
      entriesEl.classList.add('split');
      entriesEl.replaceChildren(above, el, below);
    } else {
      scope.replaceWith(above, el, below);
    }
  }

  function joinAt(el) {
    const above = el.previousElementSibling, below = el.nextElementSibling;
    if (!above?.classList.contains('reg-rows') || !below?.classList.contains('reg-rows')) return;
    const col = (rows, k) => [...rows.children[k].children];
    const c = parseInt(el.dataset.col, 10);
    const joined = makeRows(
      [...col(above, 0), ...(c === 0 ? [el] : []), ...col(below, 0)],
      [...col(above, 1), ...(c === 1 ? [el] : []), ...col(below, 1)]);
    above.replaceWith(joined);                      // the entry itself has moved into the joined columns
    below.remove();
    if (entriesEl.children.length === 1) {          // nothing open: back to the plain column flow
      const all = [...joined.querySelectorAll('.reg-entry')].sort((a, b) => a.dataset.n - b.dataset.n);
      entriesEl.classList.remove('split');
      entriesEl.replaceChildren(...all);
    }
  }

  // crossing to one column and back: the split goes, the open entries close
  ONE_COLUMN.addEventListener('change', () => { if (entriesEl.classList.contains('split')) renderEntries(); });

  async function toggleEntry(el, list) {
    const e = list[parseInt(el.dataset.n, 10)];
    let box = el.querySelector('.reg-letters');
    const head = el.querySelector('.reg-head');
    if (box) {
      box.remove(); el.classList.remove('open');
      if (el.dataset.col !== undefined) { joinAt(el); delete el.dataset.col; head.focus({ preventScroll: true }); }
      return;
    }
    if (!ONE_COLUMN.matches) { splitAt(el); head.focus({ preventScroll: true }); }
    el.classList.add('open');
    box = document.createElement('div');
    box.className = 'reg-letters';
    box.innerHTML = `<p>${t('register.count', { n: fmt(e.c) })} <a class="reg-open-search" href="${B.BASE}/sok/?felt=register&q=${encodeURIComponent(e.n)}">${t('register.openSearch')} ›</a></p><div class="reg-cards result-list"></div>`;
    el.appendChild(box);
    const cards = box.querySelector('.reg-cards');
    let shown = 0;
    const more = async () => {
      const slice = e.i.slice(shown, shown + PAGE);
      const fulls = await B.loadFull(slice);
      B.appendCards(cards, fulls);
      shown += slice.length;
      const left = e.i.length - shown;
      let btn = box.querySelector('.reg-more');
      if (left > 0) {
        if (!btn) { btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn-secondary reg-more'; btn.addEventListener('click', more); box.appendChild(btn); }
        btn.textContent = t('register.showMore', { n: fmt(left) });
      } else if (btn) btn.remove();
    };
    await more();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
