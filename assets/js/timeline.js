/**
 * /tidslinje/ — the letters laid out in time: a stacked bar per year (or per
 * decade when zoomed out), coloured by collection, a draggable selection, and
 * the letters of the selected span listed below as the search page's cards.
 * Data: data/v3/timeline.json {years: {y: {src: n}}, byYear: {y: [indices]}},
 * built from the chunks (scripts/build-search-v3.mjs, part timeline).
 */
(function () {
  const B = window.SDBrowse;
  const SOURCES = ['DN', 'RN', 'DD', 'SDHK', 'DF', 'DI'];
  const COLOURS = { DN: '#5c6d4a', RN: '#6b8e7a', DD: '#8b5a5a', SDHK: '#8b7355', DF: '#5a7a6b', DI: '#6a6e8c' };
  const PAGE = 25;
  const NS = 'http://www.w3.org/2000/svg';
  const state = { data: null, y0: 800, y1: 1600, sel: null, queue: [], shown: 0 };

  const chart = document.getElementById('tl-chart');
  const statusEl = document.getElementById('tl-status');
  const lettersEl = document.getElementById('tl-letters');
  const moreEl = document.getElementById('tl-more');
  const fmt = (n) => Number(n).toLocaleString('nb-NO');

  async function init() {
    state.data = await B.fetchJson('timeline.json');
    const years = Object.keys(state.data.years).map(Number);
    state.y0 = Math.max(700, Math.floor(Math.min(...years) / 50) * 50);
    state.y1 = Math.min(1650, Math.ceil((Math.max(...years) + 1) / 50) * 50);
    state.full = [state.y0, state.y1];
    document.getElementById('tl-legend').innerHTML = SOURCES.map(s => `<span><i style="background:${COLOURS[s]}"></i>${s}</span>`).join('');
    if (state.data.undated) document.getElementById('tl-undated').textContent = t('timeline.undated', { n: fmt(state.data.undated) });
    document.getElementById('tl-zoom-in').addEventListener('click', () => zoom(0.5));
    document.getElementById('tl-zoom-out').addEventListener('click', () => zoom(2));
    document.getElementById('tl-reset').addEventListener('click', () => { [state.y0, state.y1] = state.full; draw(); });
    window.addEventListener('resize', draw);
    const params = new URLSearchParams(location.search);
    const fra = parseInt(params.get('fra'), 10), til = parseInt(params.get('til'), 10);
    draw();
    if (fra && til) select(fra, til);
  }

  function zoom(factor) {
    const center = state.sel ? (state.sel[0] + state.sel[1]) / 2 : (state.y0 + state.y1) / 2;
    let span = Math.max(20, Math.min(state.full[1] - state.full[0], (state.y1 - state.y0) * factor));
    let a = Math.round(center - span / 2), b = Math.round(center + span / 2);
    if (a < state.full[0]) { b += state.full[0] - a; a = state.full[0]; }
    if (b > state.full[1]) { a -= b - state.full[1]; b = state.full[1]; a = Math.max(a, state.full[0]); }
    state.y0 = a; state.y1 = b;
    draw();
  }

  function binSize() { const span = state.y1 - state.y0; return span > 300 ? 10 : 1; }

  function draw() {
    const W = chart.clientWidth || 900, H = chart.clientHeight || 300;
    const padL = 10, padR = 10, padT = 10, padB = 26;
    const bin = binSize();
    const bins = [];
    for (let y = Math.floor(state.y0 / bin) * bin; y < state.y1; y += bin) {
      const counts = {};
      let total = 0;
      for (let k = y; k < y + bin; k++) {
        const c = state.data.years[k];
        if (!c) continue;
        for (const s of Object.keys(c)) { counts[s] = (counts[s] || 0) + c[s]; total += c[s]; }
      }
      bins.push({ y, counts, total });
    }
    const max = Math.max(1, ...bins.map(b => b.total));
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const x = (year) => padL + (year - state.y0) / (state.y1 - state.y0) * innerW;
    const bw = Math.max(1, innerW / bins.length - 1);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    for (const b of bins) {
      let yTop = padT + innerH;
      for (const s of SOURCES) {
        const n = b.counts[s] || 0;
        if (!n) continue;
        const h = n / max * innerH;
        yTop -= h;
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x(b.y)); r.setAttribute('y', yTop); r.setAttribute('width', bw); r.setAttribute('height', h);
        r.setAttribute('fill', COLOURS[s] || '#999'); r.setAttribute('class', 'tl-bar'); r.dataset.y = b.y; r.dataset.bin = bin;
        r.dataset.tip = `${b.y}${bin > 1 ? `–${b.y + bin - 1}` : ''}: ${fmt(b.total)} (${s} ${fmt(n)})`;
        svg.appendChild(r);
      }
    }
    // axis
    const axis = document.createElementNS(NS, 'g'); axis.setAttribute('class', 'tl-axis');
    const step = (state.y1 - state.y0) > 400 ? 100 : (state.y1 - state.y0) > 150 ? 50 : (state.y1 - state.y0) > 60 ? 10 : 5;
    for (let y = Math.ceil(state.y0 / step) * step; y <= state.y1; y += step) {
      const l = document.createElementNS(NS, 'line'); l.setAttribute('x1', x(y)); l.setAttribute('x2', x(y)); l.setAttribute('y1', padT + innerH); l.setAttribute('y2', padT + innerH + 5); axis.appendChild(l);
      const tx = document.createElementNS(NS, 'text'); tx.setAttribute('x', x(y)); tx.setAttribute('y', H - 8); tx.setAttribute('text-anchor', 'middle'); tx.textContent = y; axis.appendChild(tx);
    }
    svg.appendChild(axis);
    if (state.sel) {
      const [a, b] = state.sel;
      const s = document.createElementNS(NS, 'rect'); s.setAttribute('class', 'tl-sel');
      s.setAttribute('x', x(Math.max(a, state.y0))); s.setAttribute('y', padT); s.setAttribute('width', Math.max(2, x(Math.min(b + 1, state.y1)) - x(Math.max(a, state.y0)))); s.setAttribute('height', innerH);
      svg.appendChild(s);
    }
    chart.innerHTML = '';
    chart.appendChild(svg);
    const tip = document.createElement('div'); tip.className = 'tl-tip'; chart.appendChild(tip);
    const yearAt = (clientX) => { const rect = chart.getBoundingClientRect(); const px = (clientX - rect.left) * (W / rect.width); return Math.round(state.y0 + (px - padL) / innerW * (state.y1 - state.y0)); };
    let dragFrom = null, moved = false;
    svg.addEventListener('mousedown', (ev) => { dragFrom = yearAt(ev.clientX); moved = false; ev.preventDefault(); });
    svg.addEventListener('mousemove', (ev) => {
      const bar = ev.target.closest('.tl-bar');
      if (bar) { tip.style.display = 'block'; tip.textContent = bar.dataset.tip; const rect = chart.getBoundingClientRect(); tip.style.left = `${Math.min(ev.clientX - rect.left + 12, rect.width - 160)}px`; tip.style.top = `${ev.clientY - rect.top - 28}px`; }
      else tip.style.display = 'none';
      if (dragFrom != null) { const y = yearAt(ev.clientX); if (Math.abs(y - dragFrom) >= 1) { moved = true; previewSel(Math.min(dragFrom, y), Math.max(dragFrom, y), svg, x, padT, innerH); } }
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    const finish = (ev) => {
      if (dragFrom == null) return;
      const y = yearAt(ev.clientX);
      if (moved) select(Math.min(dragFrom, y), Math.max(dragFrom, y));
      else { const bar = ev.target.closest('.tl-bar'); if (bar) select(parseInt(bar.dataset.y, 10), parseInt(bar.dataset.y, 10) + parseInt(bar.dataset.bin, 10) - 1); }
      dragFrom = null;
    };
    svg.addEventListener('mouseup', finish);
    // touch: a tap on a bar selects it
    svg.addEventListener('touchend', (ev) => { const tch = ev.changedTouches[0]; const el = document.elementFromPoint(tch.clientX, tch.clientY); const bar = el && el.closest && el.closest('.tl-bar'); if (bar) select(parseInt(bar.dataset.y, 10), parseInt(bar.dataset.y, 10) + parseInt(bar.dataset.bin, 10) - 1); });
  }

  function previewSel(a, b, svg, x, padT, innerH) {
    let s = svg.querySelector('.tl-sel');
    if (!s) { s = document.createElementNS(NS, 'rect'); s.setAttribute('class', 'tl-sel'); svg.appendChild(s); }
    s.setAttribute('x', x(a)); s.setAttribute('y', padT); s.setAttribute('width', Math.max(2, x(b + 1) - x(a))); s.setAttribute('height', innerH);
  }

  async function select(a, b) {
    a = Math.max(state.full[0], a); b = Math.min(state.full[1], b);
    state.sel = [a, b];
    history.replaceState(null, '', `?fra=${a}&til=${b}`);
    draw();
    const queue = [];
    for (let y = a; y <= b; y++) for (const i of (state.data.byYear[y] || [])) queue.push(i);
    state.queue = queue; state.shown = 0;
    statusEl.textContent = t('timeline.selected', { n: fmt(queue.length), from: a, to: b });
    lettersEl.innerHTML = ''; moreEl.innerHTML = '';
    await more();
  }

  async function more() {
    const slice = state.queue.slice(state.shown, state.shown + PAGE);
    if (!slice.length) return;
    const fulls = await B.loadFull(slice);
    fulls.sort((p, q) => String(p.date_start || '').localeCompare(String(q.date_start || '')));
    B.appendCards(lettersEl, fulls);
    state.shown += slice.length;
    const left = state.queue.length - state.shown;
    moreEl.innerHTML = left > 0 ? `<button type="button" class="btn-secondary" id="tl-more-btn">${t('timeline.showMore', { n: fmt(left) })}</button>` : '';
    const btn = document.getElementById('tl-more-btn');
    if (btn) btn.addEventListener('click', more);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
