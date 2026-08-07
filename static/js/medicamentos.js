/* ═══════════════════════════════════════════════════════════════
   medicamentos.js — buscador de medicamentos (sin ficha, sin chat).
   Depende de shell.js (apiFetch, escapeHtml, _headers).
   ═══════════════════════════════════════════════════════════════ */

const searchInput   = document.getElementById('med-search-input');
const filterLab     = document.getElementById('med-filter-laboratorio');
const filterForma   = document.getElementById('med-filter-forma');
const resultsEl     = document.getElementById('med-results');
const resultsMetaEl = document.getElementById('med-results-meta');

let _searchDebounce = null;
let _searchSeq = 0; // descarta respuestas que llegan fuera de orden (fetch lento + usuario sigue escribiendo)

function emptyStateHtml() {
  return `
    <div class="text-center py-16 text-slate-400">
      <svg class="w-10 h-10 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <p class="text-[13px]">Empieza a escribir para buscar</p>
    </div>`;
}

function noResultsHtml() {
  return `
    <div class="text-center py-16 text-slate-400">
      <svg class="w-10 h-10 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      <p class="text-[13px]">No encontramos medicamentos con esos términos</p>
      <p class="text-[12px] text-slate-400 mt-1">Prueba con menos palabras, o solo el principio activo</p>
    </div>`;
}

function loadingHtml() {
  return `
    <div class="text-center py-16 text-slate-400">
      <svg class="w-6 h-6 mx-auto mb-2 text-brand-500 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>
      <p class="text-[12.5px]">Buscando...</p>
    </div>`;
}

function renderCard(m) {
  const metaParts = [
    m.laboratorio ? escapeHtml(m.laboratorio) : null,
    [m.principio_activo_1, m.principio_activo_2].filter(Boolean).map(escapeHtml).join(' + ') || null,
    m.forma_farmaceutica ? escapeHtml(m.forma_farmaceutica) : null,
    [m.concentracion_1, m.concentracion_2].filter(Boolean).map(escapeHtml).join(' + ') || null,
  ].filter(Boolean);

  const cantidad = (m.cantidad && m.unidad_cantidad)
    ? `${escapeHtml(m.cantidad)} ${escapeHtml(m.unidad_cantidad)}`
    : null;

  return `
    <div class="bg-white border border-slate-200 rounded-xl px-4 py-3.5 hover:border-brand-300 hover:shadow-sm transition-all">
      <div class="flex items-start justify-between gap-3">
        <p class="text-[13.5px] font-semibold text-slate-800 leading-snug flex-1 min-w-0">${escapeHtml(m.nombre_producto || 'Sin nombre')}</p>
        <span class="flex-shrink-0 text-[10.5px] font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded-full px-2 py-0.5 whitespace-nowrap">
          comprado ${escapeHtml(m.n_compras)} ${m.n_compras == 1 ? 'vez' : 'veces'}
        </span>
      </div>
      ${metaParts.length ? `<p class="text-[11.5px] text-slate-500 mt-1.5 leading-relaxed">${metaParts.join(' &nbsp;·&nbsp; ')}</p>` : ''}
      ${cantidad ? `<p class="text-[11px] text-slate-400 mt-1">Presentación: ${cantidad}</p>` : ''}
    </div>`;
}

function renderResults(data) {
  const results = data.results || [];
  if (!results.length) {
    resultsEl.innerHTML = noResultsHtml();
    resultsMetaEl.classList.add('hidden');
    return;
  }
  resultsEl.innerHTML = results.map(renderCard).join('');
  resultsMetaEl.textContent = `${results.length} resultado${results.length === 1 ? '' : 's'}`;
  resultsMetaEl.classList.remove('hidden');
}

function doSearch() {
  const q = searchInput.value.trim();
  const laboratorio = filterLab.value;
  const forma = filterForma.value;

  if (!q && !laboratorio && !forma) {
    resultsEl.innerHTML = emptyStateHtml();
    resultsMetaEl.classList.add('hidden');
    return;
  }

  resultsEl.innerHTML = loadingHtml();
  const mySeq = ++_searchSeq;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (laboratorio) params.set('laboratorio', laboratorio);
  if (forma) params.set('forma_farmaceutica', forma);

  apiFetch(`/api/medicamentos/search?${params.toString()}`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      if (!data || mySeq !== _searchSeq) return; // sesión vencida, o llegó una respuesta vieja
      renderResults(data);
    })
    .catch(() => {
      if (mySeq !== _searchSeq) return;
      resultsEl.innerHTML = `<div class="text-center py-10 text-[12.5px] text-red-400">No se pudo conectar con el servidor.</div>`;
    });
}

function onSearchInput() {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(doSearch, 300);
}

function loadFilterOptions() {
  apiFetch('/api/medicamentos/dropdowns')
    .then(r => r && r.ok ? r.json() : {})
    .then(data => {
      if (!data) return;
      const fill = (select, values) => {
        (values || []).forEach(v => {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          select.appendChild(opt);
        });
      };
      fill(filterLab, data.laboratorio);
      fill(filterForma, data.forma_farmaceutica);
    })
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  loadFilterOptions();
  searchInput.addEventListener('input', onSearchInput);
  filterLab.addEventListener('change', doSearch);
  filterForma.addEventListener('change', doSearch);
  searchInput.focus();
});
