/* global MiniSearch, document, window, fetch */

/**
 * SuperDiplomatarium – Søk (expanded dataset)
 * - Sammendrag search also covers "regest"
 * - Sted search covers DN_sted, RN_sted, Normalized_name
 * - Kilde search covers DN_source, RN_source
 * - Date-only searches work (no text needed)
 * - Fra/Til accept YYYY, YYYY-MM, YYYY-MM-DD (Eksakt = one day)
 * - Pagination + export
 */

// =============== Globals ===============
let searchIndex = null;
let allLetters = [];
let DOCS = new Map();
let chunksLoaded = 0;
let totalChunks = 0;
let debounceTimer = null;

let currentResultsAll = [];
let currentResultsShown = [];
let currentPage = 1;
const PAGE_SIZE = 50;

document.addEventListener('DOMContentLoaded', async () => {
  await initializeSearch();
  wireListeners();
  wireResultsList();
  wireExportBar();
  wirePagination();
});

// baseurl helper
function BASE() { return (window.SITE_BASE || '').replace(/\/+$/, ''); }
function updateStatus(msg) { const el = document.getElementById('search-status'); if (el) el.textContent = msg; }

// =============== Init + Loading ===============
async function initializeSearch() {
  updateStatus('Laster inn brevsamlingen…');
  try {
    const metaUrl = `${BASE()}/data/metadata.json`;
    const metaResponse = await fetch(metaUrl);
    if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status} on ${metaUrl}`);
    const metadata = await metaResponse.json();
    totalChunks = metadata.chunks;

    // Index: note that we feed combined fields for sammendrag, sted_all, kilde
    searchIndex = new MiniSearch({
      idField: 'id',
      fields: ['sammendrag', 'brevtekst', 'sted_all', 'kilde'],
      storeFields: [
        'DN_ref','RN_ref','SDN_ID',
        'sammendrag','brevtekst',
        'date_start','date_end',
        'date_text',               // DN_dato/RN_dato textual
        'sted_dn','sted_rn','normalized_name','sted_all',
        'fotnoter','tillegg','kilde'
      ],
      searchOptions: { boost:{ sted_all:4,sammendrag:3,brevtekst:2 }, fuzzy:0.2, prefix:true }
    });

    await loadChunk(0);
    loadRemainingChunks();
  } catch (err) {
    console.error('Feil ved initialisering:', err);
    updateStatus('Kunne ikke laste brevsamlingen. Prøv å laste siden på nytt.');
  }
}

async function loadChunk(i) {
  const url = `${BASE()}/data/chunks/letters-chunk-${String(i).padStart(2, '0')}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  const raw = await res.json();

  const docs = raw.map((row, k) => normalizeLetter(row, i, k));
  allLetters.push(...docs);
  for (const d of docs) DOCS.set(d.id, d);
  searchIndex.addAll(docs);

  chunksLoaded++;
  updateStatus(`Lastet ${chunksLoaded} av ${totalChunks} deler…`);
}

async function loadRemainingChunks() {
  for (let i = 1; i < totalChunks; i++) {
    try { await loadChunk(i); } catch (e) { console.error(`Del ${i} feilet:`, e); }
  }
  updateStatus(`${allLetters.length} brev lastet og klare for søk!`);
}

function normalizeLetter(raw, chunkIndex, rowIndex) {
  // IDs
  const sdn = raw.SDN_ID || raw.SDNID || raw['\ufeffSDNID'] || raw['﻿SDNID'] || null;
  const dn  = raw.DN_ref || raw.DN_REF || raw.DNREF || null;
  const rn  = raw.RN_ref || raw.RN_REF || null;

  // Text fields
  const regest = raw.regest || '';
  const sammendragCombined = [raw.sammendrag, regest].filter(Boolean).join(' | ');
  const brevtekst = raw.brevtekst || '';

  // Sources (kilde)
  const kildeCombined = [raw.DN_source, raw.RN_source].filter(Boolean).join(' | ');

  // Dates (machine + human-readable)
  const date_start = raw.date_start || null;
  const date_end   = raw.date_end || null;
  const date_text  = raw.DN_dato || raw.RN_dato || ''; // display text if present
  const ORD_START  = dateStrToOrd(date_start, false);
  const ORD_END    = dateStrToOrd(date_end, true) ?? ORD_START;

  // Places
  const sted_dn = raw.DN_sted || '';
  const sted_rn = raw.RN_sted || '';
  const normalized_name = raw.Normalized_name || raw.normalized_name || '';
  const sted_all = [sted_dn, sted_rn, normalized_name].filter(Boolean).join(' | ');

  // Notes / extras
  const fotnoterCombined = [raw.fotnoter_DN, raw.fotnoter_N].filter(Boolean).join('\n');
  const tillegg = raw.Tillegg || raw.tillegg || '';

  const id = `${(dn || sdn || rn || 'doc')}#${chunkIndex}:${rowIndex}`;

  return {
    id,
    DN_ref: dn || undefined,
    RN_ref: rn || undefined,
    SDN_ID: sdn || undefined,

    sammendrag: sammendragCombined,
    brevtekst,

    date_start, date_end, date_text,
    ORD_START: ORD_START ?? null,
    ORD_END: ORD_END ?? ORD_START ?? null,

    sted_dn, sted_rn, normalized_name, sted_all,

    kilde: kildeCombined,
    fotnoter: fotnoterCombined,
    tillegg,

    _raw: raw
  };
}

// =============== Query parsing & helpers ===============
function parseQuery(q) {
  const orGroups = [];
  const groups = splitByOr(q);
  for (const g of groups) {
    const group = { must: [], not: [], filters: {} };
    const parts = tokenize(g);
    for (const part of parts) {
      // year:1200..1250
      if (/^year:\d{3,4}\.\.\d{3,4}$/i.test(part)) {
        const [y1,y2] = part.split(':')[1].split('..').map(Number);
        group.filters.fromOrd = dateStrToOrd(String(y1), false);
        group.filters.toOrd   = dateStrToOrd(String(y2), true);
        continue;
      }
      // before:/after:/on:
      if (/^before:\d{3,4}([\-\.]\d{1,2}([\-\.]\d{1,2})?)?$/i.test(part)) { group.filters.toOrd = dateStrToOrd(part.split(':')[1].replace(/\./g,'-'), true);  continue; }
      if (/^after:\d{3,4}([\-\.]\d{1,2}([\-\.]\d{1,2})?)?$/i.test(part))  { group.filters.fromOrd = dateStrToOrd(part.split(':')[1].replace(/\./g,'-'), false); continue; }
      if (/^on:\d{3,4}([\-\.]\d{1,2}([\-\.]\d{1,2})?)?$/i.test(part))    { const ds=part.split(':')[1].replace(/\./g,'-'); group.filters.fromOrd=dateStrToOrd(ds,false); group.filters.toOrd=dateStrToOrd(ds,true); continue; }
      // date:FROM..TO or date:SINGLE
      if (/^date:\S+\.\.\S+$/i.test(part)) { const [a,b]=part.split(':')[1].split('..'); group.filters.fromOrd=dateStrToOrd(a.replace(/\./g,'-'),false); group.filters.toOrd=dateStrToOrd(b.replace(/\./g,'-'),true); continue; }
      if (/^date:\d{3,4}([\-\.]\d{1,2}([\-\.]\d{1,2})?)?$/i.test(part)) { const ds=part.split(':')[1].replace(/\./g,'-'); group.filters.fromOrd=dateStrToOrd(ds,false); group.filters.toOrd=dateStrToOrd(ds,true); continue; }

      // generic term
      const m = part.match(/^([a-z_]+):(.*)$/i);
      let field = null, term = part, isPhrase = false, neg = false;
      if (m) { field = m[1].toLowerCase(); term = m[2]; }
      if (/^NOT\s+/i.test(term)) { neg = true; term = term.replace(/^NOT\s+/i, ''); }
      if (term.startsWith('-')) { neg = true; term = term.slice(1); }
      const quoted = term.match(/^"(.*)"$/);
      if (quoted) { isPhrase = true; term = quoted[1]; }
      const node = { field, term, isPhrase };
      if (neg) group.not.push(node); else group.must.push(node);
    }
    orGroups.push(group);
  }
  return orGroups;
}

function tokenize(s) { const out=[]; let buf=''; let inQ=false; for (let i=0;i<s.length;i++){ const ch=s[i]; if(ch==='\"'){ buf+=ch; inQ=!inQ; continue;} if(!inQ && /\s/.test(ch)){ if(buf.trim()) out.push(buf.trim()); buf=''; } else { buf+=ch; } } if(buf.trim()) out.push(buf.trim()); return out; }
function splitByOr(s){ const out=[]; let buf=''; let inQ=false; for(let i=0;i<s.length;i++){ const ch=s[i]; if(ch==='\"'){ inQ=!inQ; buf+=ch; continue;} if(!inQ && s.slice(i,i+2).toUpperCase()==='OR' && /\s/.test(s[i-1]||' ') && /\s/.test(s[i+2]||' ')){ out.push(buf.trim()); buf=''; i+=1; } else buf+=ch; } if(buf.trim()) out.push(buf.trim()); return out; }
function norm(s){ return (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }

function fieldListForCheckboxes() {
  const fields = [];
  if (document.getElementById('search-sammendrag').checked) fields.push('sammendrag');
  if (document.getElementById('search-brevtekst').checked)  fields.push('brevtekst');
  if (document.getElementById('search-sted').checked)       fields.push('sted_all');
  if (document.getElementById('search-kilde').checked)      fields.push('kilde');
  return fields.length ? fields : ['sammendrag','brevtekst','sted_all','kilde'];
}
function mapScopedField(f){ if(!f) return null; const m={'sammendrag':'sammendrag','brevtekst':'brevtekst','sted':'sted_all','kilde':'kilde','dn':'DN_ref','sdn':'SDN_ID'}; return m[f]||null; }

// =============== Date helpers ===============
function dateStrToOrd(s, endSide){
  if(!s) return null; const str=String(s).trim();
  let m=str.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/);
  if(m){ const y=clampYear(+m[1]); const mo=clampMonth(+m[2]); const d=clampDay(y,mo,+m[3]); return y*10000+mo*100+d; }
  m=str.match(/^(\d{3,4})-(\d{1,2})$/);
  if(m){ const y=clampYear(+m[1]); const mo=clampMonth(+m[2]); const d=endSide?daysInMonth(y,mo):1; return y*10000+mo*100+d; }
  m=str.match(/^(\d{3,4})$/);
  if(m){ const y=clampYear(+m[1]); const mo=endSide?12:1; const d=endSide?31:1; return y*10000+mo*100+d; }
  const alt=str.replace(/\./g,'-'); if(alt!==str) return dateStrToOrd(alt,endSide);
  return null;
}
function daysInMonth(y,m){ if(m===2) return (y%4===0 && (y%100!==0 || y%400===0))?29:28; return [4,6,9,11].includes(m)?30:31; }
function clampYear(y){ return Math.min(Math.max(y,1),9999); }
function clampMonth(m){ return Math.min(Math.max(m,1),12); }
function clampDay(y,m,d){ return Math.min(Math.max(d,1),daysInMonth(y,m)); }

function readUIRangeOrd(){
  const fromEl=document.getElementById('date-from');
  const toEl=document.getElementById('date-to');
  const exact=document.getElementById('date-exact')?.checked;

  const fv=(fromEl?.value||'').trim();
  const tv=(toEl?.value||'').trim();

  if(exact){
    if(!fv) return { fromOrd:null, toOrd:null };
    return { fromOrd: dateStrToOrd(fv,false), toOrd: dateStrToOrd(fv,true) };
  }
  const fromOrd = fv ? dateStrToOrd(fv,false) : null;
  const toOrd   = tv ? dateStrToOrd(tv,true)  : null;
  return { fromOrd, toOrd };
}

// =============== Execution ===============
function performSearch() {
  const q = (document.getElementById('search-input')?.value || '').trim();
  const qUsable = q.length >= 2;

  const { fromOrd: uiFrom, toOrd: uiTo } = readUIRangeOrd();
  const hasDateFilter = (uiFrom != null || uiTo != null);
  const selectedFields = fieldListForCheckboxes();

  let unionMap = new Map(); // id -> score

  if (!qUsable && hasDateFilter) {
    // Date-only search
    const dummyGroup = { must: [], not: [], filters: { fromOrd: uiFrom, toOrd: uiTo } };
    unionMap = runAndGroup(dummyGroup, selectedFields, uiFrom, uiTo);
  } else if (qUsable) {
    // Parse query and union OR-groups
    const orGroups = parseQuery(q);
    for (const group of orGroups) {
      const set = runAndGroup(group, selectedFields, uiFrom, uiTo);
      for (const [id, score] of set) unionMap.set(id, Math.max(unionMap.get(id) || 0, score));
    }
  } else {
    currentResultsAll = [];
    currentPage = 1;
    updateResults([]);
    renderPagination(0);
    setExportEnabled(false);
    return;
  }

  currentResultsAll = Array.from(unionMap.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a,b) => b.score - a.score)
    .map(r => Object.assign({}, DOCS.get(r.id) || {}, { score: r.score }));

  currentPage = 1;
  renderPage();
  setExportEnabled(currentResultsAll.length > 0);
}

function renderPage(){
  const total=currentResultsAll.length;
  const totalPages=Math.max(1,Math.ceil(total/PAGE_SIZE));
  if(currentPage>totalPages) currentPage=totalPages;
  const start=(currentPage-1)*PAGE_SIZE;
  const end=Math.min(start+PAGE_SIZE,total);
  currentResultsShown=currentResultsAll.slice(start,end);
  updateResults(currentResultsShown,start+1,end,total);
  renderPagination(total);
}

// AND a single group: terms ∩ …, then NOT, then date intersection (with UI)
function runAndGroup(group, selectedFields, uiFromOrd=null, uiToOrd=null){
  const mustSets=[];
  for(const term of group.must){
    const fields = mapScopedField(term.field)?[mapScopedField(term.field)]:selectedFields;
    mustSets.push(searchForNode(term, fields));
  }
  let acc = mustSets.length ? mustSets[0] : allDocsAsSet();
  for(let i=1;i<mustSets.length;i++) acc = intersectScoreMaps(acc, mustSets[i]);

  for(const n of group.not){
    const fields = mapScopedField(n.field)?[mapScopedField(n.field)]:selectedFields;
    const exclude = searchForNode(n, fields);
    for(const id of exclude.keys()) acc.delete(id);
  }

  const f1=group.filters.fromOrd ?? null;
  const t1=group.filters.toOrd   ?? null;
  const from = (f1!=null && uiFromOrd!=null)? Math.max(f1,uiFromOrd) : (f1!=null?f1:uiFromOrd);
  const to   = (t1!=null && uiToOrd  !=null)? Math.min(t1,uiToOrd)   : (t1!=null?t1:uiToOrd);

  if(from!=null || to!=null){
    const F = from ?? -Infinity, T = to ?? +Infinity;
    for(const id of Array.from(acc.keys())){
      const d = DOCS.get(id);
      const S = d?.ORD_START ?? -Infinity;
      const E = (d?.ORD_END ?? d?.ORD_START) ?? +Infinity;
      const overlaps = S <= T && E >= F;
      if(!overlaps) acc.delete(id);
    }
  }
  return acc;
}

function allDocsAsSet(){ const m=new Map(); for(const id of DOCS.keys()) m.set(id,1); return m; }

function searchForNode(node, fields){
  if(fields.length===1 && (fields[0]==='DN_ref' || fields[0]==='SDN_ID')){
    const needle=norm(node.term); const m=new Map();
    for(const d of DOCS.values()){ const val=norm(d[fields[0]]); if(val && val===needle) m.set(d.id,100); }
    return m;
  }
  if(node.isPhrase) return phraseSearch(node.term, fields);
  const res = searchIndex.search(node.term, { fields, limit:100000, combineWith:'AND' });
  const m=new Map(); for(const r of res) m.set(r.id, Math.max(m.get(r.id)||0, r.score||1)); return m;
}

function phraseSearch(phrase, fields){
  const words=phrase.split(/\s+/).filter(Boolean);
  let cand=null;
  for(const w of words){
    const res=searchIndex.search(w,{ fields, limit:100000, combineWith:'AND' });
    const m=new Map(); for(const r of res) m.set(r.id, Math.max(m.get(r.id)||0, r.score||1));
    cand=cand?intersectScoreMaps(cand,m):m; if(!cand.size) break;
  }
  if(!cand||!cand.size) return new Map();
  const needle=norm(phrase); const out=new Map();
  for(const id of cand.keys()){
    const doc=DOCS.get(id);
    for(const f of fields){ const hay=norm(doc?.[f]||''); if(hay.includes(needle)){ out.set(id, Math.max(out.get(id)||0, (cand.get(id)||1)+5)); break; } }
  }
  return out;
}

function intersectScoreMaps(a,b){ const out=new Map(); for(const [id,sa] of a.entries()) if(b.has(id)) out.set(id, sa + (b.get(id)||0)); return out; }

// =============== Rendering & pagination ===============
function updateResults(results, from=0, to=0, total=0){
  const container=document.getElementById('search-results');
  if(!container) return;
  if(!results || !results.length){ container.innerHTML='<p>Ingen treff</p>'; return; }

  const html = `
    <p class="result-count">Viser ${from}–${to} av ${total} treff</p>
    <div class="result-list">
      ${results.map(r=>{
        const humanDate = r.date_text?.trim() ? r.date_text : formatDateRange(r.date_start, r.date_end);
        const archaic = dnToArchaic(r.DN_ref);
        const stedBest = r.normalized_name || r.sted_dn || r.sted_rn || 'Ukjent sted';
        return `
        <div class="search-result" data-id="${r.id}">
          <div class="idline">
            <span class="dn-code">${escapeHtml(r.DN_ref || r.RN_ref || 'Uten referanse')}</span>
            <span class="dn-archaic">${escapeHtml(archaic)}</span>
          </div>
          <h3><button class="toggle-details" aria-expanded="false">Vis fulltekst</button></h3>
          <p class="meta">${escapeHtml(humanDate)} – ${escapeHtml(stedBest)}</p>
          <div class="details" style="display:none;">
            <p><strong>date_start:</strong> ${escapeHtml(r.date_start || '')}
               &nbsp;&nbsp;<strong>date_end:</strong> ${escapeHtml(r.date_end || '')}
               &nbsp;&nbsp;<strong>DN_sted:</strong> ${escapeHtml(r.sted_dn || '—')}
               &nbsp;&nbsp;<strong>RN_sted:</strong> ${escapeHtml(r.sted_rn || '—')}
               &nbsp;&nbsp;<strong>Normalisert:</strong> ${escapeHtml(r.normalized_name || '—')}
            </p>
            ${section('Sammendrag / Regest', r.sammendrag, 'sammendrag')}
            ${section('Brevtekst',   r.brevtekst,  'brevtekst')}
            ${section('Kilde (DN/RN)', r.kilde,    'kilde')}
            ${section('Fotnoter',    r.fotnoter,   'fotnoter')}
            ${section('Tillegg',     r.tillegg,    'tillegg')}
          </div>
        </div>`;
      }).join('')}
    </div>`;
  container.innerHTML = html;
}

function renderPagination(total){
  const bar=document.getElementById('results-pagination'); if(!bar) return;
  if(!total){ bar.style.display='none'; bar.innerHTML=''; return; }
  const totalPages=Math.max(1,Math.ceil(total/PAGE_SIZE)); bar.style.display='flex';
  const nums=paginationWindow(currentPage,totalPages,2);
  const btn=(label,page,disabled=false,cls='')=>`<button class="page-btn ${cls}" data-page="${page}"${disabled?' disabled':''}>${label}</button>`;
  const numsHtml = nums.map(n => (n==='…') ? `<span class="ellipsis">…</span>` :
    `<button class="page-num${n===currentPage?' active':''}" data-page="${n}">${n}</button>`).join('');
  bar.innerHTML = [
    btn('« Første',1,currentPage===1,'first'),
    btn('‹ Forrige',Math.max(1,currentPage-1),currentPage===1,'prev'),
    numsHtml,
    btn('Neste ›',Math.min(totalPages,currentPage+1),currentPage===totalPages,'next'),
    btn('Siste »',totalPages,currentPage===totalPages,'last')
  ].join('');
}

function paginationWindow(curr,total,spread=2){
  const out=[]; const add=x=>{ if(!out.includes(x)) out.push(x); };
  add(1); for(let i=curr-spread;i<=curr+spread;i++) if(i>1 && i<total) add(i); if(total>1) add(total);
  out.sort((a,b)=>a-b);
  const withDots=[]; for(let i=0;i<out.length;i++){ withDots.push(out[i]); if(i<out.length-1 && out[i+1]-out[i]>1) withDots.push('…'); }
  return withDots;
}

// =============== Event wiring ===============
function section(label,content,cls){ if(!content || !String(content).trim()) return ''; return `<span class="section-label">${escapeHtml(label)}</span><div class="${cls}">${escapeHtml(String(content))}</div>`; }

function wireListeners(){
  const input=document.getElementById('search-input');
  const button=document.getElementById('search-btn');
  const debounced=()=>{ clearTimeout(debounceTimer); debounceTimer=setTimeout(performSearch,200); };
  if(input){ input.addEventListener('input',debounced); input.addEventListener('keydown',e=>{ if(e.key==='Enter') performSearch(); }); }
  if(button) button.addEventListener('click', performSearch);
  document.querySelectorAll('.search-filters input').forEach(cb=>cb.addEventListener('change', performSearch));

  // Date fields
  const df=document.getElementById('date-from');
  const dt=document.getElementById('date-to');
  const ex=document.getElementById('date-exact');
  const rs=document.getElementById('date-reset');

  const debounceDates=()=>{ clearTimeout(debounceTimer); debounceTimer=setTimeout(performSearch,150); };

  if(df) df.addEventListener('input', debounceDates);
  if(dt) dt.addEventListener('input', debounceDates);
  if(ex) ex.addEventListener('change', () => {
    if(ex.checked){ if(dt){ dt.value=''; dt.disabled=true; } }
    else { if(dt){ dt.disabled=false; } }
    performSearch();
  });
  if(rs) rs.addEventListener('click', () => {
    if(df) df.value=''; if(dt){ dt.value=''; dt.disabled=false; } if(ex) ex.checked=false; performSearch();
  });
}

function wireResultsList(){
  const container=document.getElementById('search-results');
  if(!container) return;
  container.addEventListener('click',(ev)=>{
    const toggle=ev.target.closest('.toggle-details'); if(!toggle) return;
    const item=ev.target.closest('.search-result'); const details=item.querySelector('.details');
    const show = details.style.display==='none' || !details.style.display;
    details.style.display = show ? 'block':'none';
    toggle.textContent = show ? 'Skjul fulltekst' : 'Vis fulltekst';
    toggle.setAttribute('aria-expanded', String(show));
    ev.preventDefault();
  });
}

function wirePagination(){
  const bar=document.getElementById('results-pagination'); if(!bar) return;
  bar.addEventListener('click',(ev)=>{
    const btn=ev.target.closest('[data-page]'); if(!btn) return;
    const page=Number(btn.getAttribute('data-page')); if(!Number.isFinite(page)) return;
    currentPage=page; renderPage();
    document.querySelector('.search-container')?.scrollIntoView({ behavior:'smooth', block:'start' });
  });
}

// =============== Export (CSV/TXT) ===============
function wireExportBar(){
  const bar=document.getElementById('export-bar'); if(!bar) return;
  document.getElementById('export-csv').addEventListener('click',()=>{ if(!currentResultsAll.length) return; const csv=toCSV_fromRaw(currentResultsAll); downloadText(csv,'sok-treff.csv',{addBOM:true}); });
  document.getElementById('export-txt').addEventListener('click',()=>{ if(!currentResultsAll.length) return; const txt=toTXT_likeDetails(currentResultsAll); downloadText(txt,'sok-treff.txt'); });
}
function setExportEnabled(on){ const bar=document.getElementById('export-bar'); if(!bar) return; bar.style.display='flex'; document.getElementById('export-csv').disabled=!on; document.getElementById('export-txt').disabled=!on; }

function toTXT_likeDetails(rows){
  const parts=[]; for(const r of rows){
    const headL=r.DN_ref||r.RN_ref||'Uten referanse'; const headR=dnToArchaic(r.DN_ref)||'';
    const dateLine = r.date_text?.trim() ? r.date_text : formatDateRange(r.date_start,r.date_end);
    const placeBits = [
      r.sted_dn ? `DN_sted: ${r.sted_dn}` : null,
      r.sted_rn ? `RN_sted: ${r.sted_rn}` : null,
      r.normalized_name ? `Normalisert: ${r.normalized_name}` : null
    ].filter(Boolean).join(' | ');
    const bits=[ `${headL}    ${headR}`, `${dateLine}${placeBits ? ' — ' + placeBits : ''}`, `date_start: ${r.date_start||''}    date_end: ${r.date_end||''}` ];
    if(r.sammendrag?.trim()) bits.push('','SAMMENDRAG/REGEST:', r.sammendrag);
    if(r.brevtekst ?.trim()) bits.push('','BREVTEKST:',  r.brevtekst );
    if(r.kilde    ?.trim()) bits.push('','KILDE (DN/RN):', r.kilde );
    if(r.fotnoter  ?.trim()) bits.push('','FOTNOTER:',   r.fotnoter  );
    if(r.tillegg   ?.trim()) bits.push('','TILLEGG:',    r.tillegg   );
    parts.push(bits.join('\n'));
  } return parts.join('\n\n---\n\n');
}

function toCSV_fromRaw(rows){
  const keySet=new Set(); for(const r of rows){ const raw=r._raw||{}; for(const k of Object.keys(raw)) keySet.add(k); }
  const preferred=['\ufeffSDNID','SDNID','SDN_ID','DN_REF','DN_ref','RN_REF','RN_ref','sammendrag','regest','DN_source','RN_source','DN_dato','RN_dato','DN_sted','RN_sted','Normalized_name','brevtekst','fotnoter_DN','fotnoter_N','Tillegg','date_start','date_end','lat','lon','uncertain_loc'];
  const presentPreferred=preferred.filter(k=>keySet.has(k));
  const remaining=Array.from(keySet).filter(k=>!presentPreferred.includes(k)).sort();
  const headers=[...presentPreferred,...remaining];
  const esc=v=>`"${String(v??'').replace(/\r?\n/g,'\n').replace(/"/g,'""')}"`;
  const lines=[headers.join(',')];
  for(const r of rows){ const raw=r._raw||{}; lines.push(headers.map(h=>esc(raw[h])).join(',')); }
  return lines.join('\r\n');
}

// =============== Utilities ===============
function formatDateRange(start,end){
  const ys=parseYear(start); const ye=(parseYear(end) ?? ys);
  if(ys && ye) return ys===ye?String(ys):`${ys}–${ye}`; if(ys) return String(ys); if(ye) return String(ye); return 'Ukjent';
}
function parseYear(s){ const m=String(s||'').match(/^(\d{4})/); return m?Number(m[1]):null; }
function escapeHtml(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function dnToArchaic(dn){ if(!dn) return ''; const m=String(dn).match(/^DN(\d{3})(\d{5})$/i); if(!m) return ''; const vol=parseInt(m[1],10), num=parseInt(m[2],10); return `Diplomatarium Norvegicum ${toRoman(vol)}, ${num}`; }
function toRoman(num){ if(!Number.isFinite(num)||num<=0) return ''; const map=[[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']]; let out=''; for(const [v,s] of map){ while(num>=v){ out+=s; num-=v; } } return out; }
function downloadText(text,filename,opts={}){ const parts=[]; if(opts.addBOM) parts.push('\uFEFF'); parts.push(text); const blob=new Blob(parts,{type:'text/plain;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); },0); }
