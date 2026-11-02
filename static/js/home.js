/* Panel de inicio: historial de requerimientos guardados.
   Solo lista las categorías que persisten formularios (hoy, Computadores);
   Medicamentos no guarda historial, así que no aparece acá. */
(function () {
  const root = document.getElementById('home-history');
  if (!root) return;

  const PAGE = 5;
  let cats = [];
  try { cats = JSON.parse(root.dataset.cats || '[]'); } catch (e) { cats = []; }
  if (!cats.length) return;

  const listEl = document.getElementById('home-hist-list');
  const tabsEl = document.getElementById('home-hist-tabs');
  const pagerEl = document.getElementById('home-hist-pager');
  const searchEl = document.getElementById('home-hist-search');
  const gridCols = 'grid-template-columns:minmax(0,1fr) 150px 90px 130px';

  let rows = [];
  let tab = 'all';
  let query = '';
  let page = 1;

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  function filtered() {
    const q = norm(query.trim());
    return rows.filter(r => (tab === 'all' || r.slug === tab) && (!q || norm(r.title).includes(q)));
  }

  function renderTabs() {
    if (cats.length < 2) { tabsEl.innerHTML = ''; return; }
    const count = (slug) => rows.filter(r => slug === 'all' || r.slug === slug).length;
    const tabBtn = (slug, label) => {
      const on = tab === slug;
      return `<button type="button" data-tab="${escapeHtml(slug)}" class="pb-3 -mb-px text-[13.5px] border-b-2 transition-colors ${on ? 'border-brand-700 text-brand-800 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}">${escapeHtml(label)} <span class="font-normal text-slate-400">${count(slug)}</span></button>`;
    };
    tabsEl.innerHTML = tabBtn('all', 'Todos') + cats.map(c => tabBtn(c.slug, c.label)).join('');
  }

  const skeletonHtml = () => '<div role="status" aria-label="Cargando requerimientos">'
    + '<div class="home-sk-row"><i></i><i></i><i></i><i></i></div>'.repeat(PAGE) + '</div>';

  function renderList(animate) {
    const all = filtered();
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    if (page > pages) page = pages;
    const slice = all.slice((page - 1) * PAGE, page * PAGE);

    if (!slice.length) {
      listEl.innerHTML = `<div class="px-6 py-10 text-center text-[13.5px] text-slate-500">${
        rows.length ? 'Ningún requerimiento coincide con la búsqueda.' : 'Aún no tienes requerimientos guardados. Se guardan solos al empezar uno nuevo.'}</div>`;
    } else {
      listEl.innerHTML = slice.map((r, i) => `
        <a href="${escapeHtml(r.href)}" data-resume="${escapeHtml(r.session_id)}" data-slug="${escapeHtml(r.slug)}"
           class="${animate ? 'home-row-in ' : ''}grid items-center gap-4 px-6 py-3.5 border-b border-slate-100 last:border-b-0 hover:bg-slate-50 transition-colors text-[13.5px]" style="${gridCols};--i:${i}">
          <span class="font-medium text-slate-900 truncate">${escapeHtml(r.title || 'Sin título')}</span>
          <span class="text-slate-600">${escapeHtml(r.label)}</span>
          <span class="text-slate-600">${Number(r.n_compras) || 0}</span>
          <span class="text-slate-500">${escapeHtml(fmtDate(r.updated_at))}</span>
        </a>`).join('');
    }

    if (all.length > PAGE) {
      const from = (page - 1) * PAGE + 1;
      const to = Math.min(page * PAGE, all.length);
      const btn = (dir, label, disabled) => `<button type="button" data-page="${dir}" ${disabled ? 'disabled' : ''} class="px-3 py-1.5 rounded-md border border-slate-200 text-[12.5px] ${disabled ? 'text-slate-400 bg-slate-50 cursor-default' : 'text-slate-700 hover:bg-slate-50'}">${label}</button>`;
      pagerEl.innerHTML = `
        <span class="text-[12.5px] text-slate-500">Mostrando ${from} a ${to} de ${all.length}</span>
        <div class="flex gap-2">${btn(-1, 'Anterior', page <= 1)}${btn(1, 'Siguiente', page >= pages)}</div>`;
      pagerEl.classList.remove('hidden');
    } else {
      pagerEl.innerHTML = '';
      pagerEl.classList.add('hidden');
    }
  }

  function render(animate) { renderTabs(); renderList(animate); }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab; page = 1; render(true);
  });
  pagerEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (!b || b.disabled) return;
    page += Number(b.dataset.page); renderList(true);
  });
  searchEl.addEventListener('input', () => { query = searchEl.value; page = 1; renderList(false); });

  // Al abrir un requerimiento: el asistente retoma solo el formulario que
  // esté guardado en CURRENT_SESSION_KEY (ver category_wizard.js).
  listEl.addEventListener('click', (e) => {
    const a = e.target.closest('[data-resume]');
    if (!a) return;
    try { sessionStorage.setItem(`cat_${a.dataset.slug}_current_session_v1`, a.dataset.resume); } catch (err) {}
  });

  listEl.innerHTML = skeletonHtml();
  const t0 = Date.now();

  Promise.all(cats.map(c =>
    apiFetch(`/api/categories/${encodeURIComponent(c.slug)}/sessions`, { headers: _headers() })
      .then(r => (r && r.ok ? r.json() : { sessions: [] }))
      .then(d => (d.sessions || []).map(s => ({ ...s, slug: c.slug, label: c.label, href: c.href })))
      .catch(() => [])
  )).then(parts => {
    rows = [].concat(...parts).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    // Mínimo 350 ms de esqueleto: si la respuesta llega al instante, el
    // parpadeo se ve peor que una espera corta.
    setTimeout(() => render(true), Math.max(0, 350 - (Date.now() - t0)));
  });
})();
