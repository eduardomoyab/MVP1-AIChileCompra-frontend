/* ═══════════════════════════════════════════════════════════════
   history_ui.js — historial de formularios guardados (barra lateral en
   escritorio, modal en móvil) para una categoría. Mismo comportamiento y
   mismo markup que el historial de Computadores (category_wizard.js), con
   el backend compartido /api/categories/<slug>/sessions.
   Depende de shell.js (apiFetch, escapeHtml, _headers).

   createHistoryUI({ slug, getSessionId, onResume, onDeletedActive })
   → { renderSidebar, openModal, closeModal }
   Espera en el DOM: #wiz-history-list (barra lateral) y, opcionalmente,
   [data-abrir-historial] (botón móvil).
   ═══════════════════════════════════════════════════════════════ */

function createHistoryUI({ slug, getSessionId, onResume, onDeletedActive }) {
  const base = `/api/categories/${slug}/sessions`;
  let sessions = [];

  const fechaCorta = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString('es-CL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  };
  const sub = (s) => `${escapeHtml(fechaCorta(s.updated_at))}${s.n_compras ? ` · ${s.n_compras} compra${s.n_compras === 1 ? '' : 's'}` : ''}`;

  const ICON_EDIT = '<path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828z"/>';
  const ICON_DEL = '<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>';

  function sidebarItemsHtml(list) {
    if (!list.length) {
      return '<p class="px-2 py-2 text-[12px] text-slate-400">Tus formularios se guardan solos a medida que los completas.</p>';
    }
    const current = getSessionId();
    return list.map(s => {
      const active = s.session_id === current;
      const id = escapeHtml(s.session_id);
      return `
    <div class="group flex items-center gap-1 rounded-lg px-2 py-2 transition-colors ${active ? 'bg-brand-50' : 'hover:bg-slate-100'}" data-historial-item="${id}">
      <button type="button" data-historial-resume="${id}" class="min-w-0 flex-1 text-left">
        <p class="text-[12.5px] font-medium truncate ${active ? 'text-brand-700' : 'text-slate-600'}">${escapeHtml(s.title)}</p>
        <p class="text-[10.5px] text-slate-400">${sub(s)}</p>
      </button>
      <button type="button" data-historial-rename="${id}" aria-label="Renombrar" class="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-md text-slate-300 opacity-0 group-hover:opacity-100 hover:text-brand-600 hover:bg-brand-100 transition-opacity">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">${ICON_EDIT}</svg>
      </button>
      <button type="button" data-historial-delete="${id}" aria-label="Eliminar" class="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-md text-slate-300 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-100 transition-opacity">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">${ICON_DEL}</svg>
      </button>
    </div>`;
    }).join('');
  }

  function modalItemsHtml(list) {
    if (!list.length) return '<p class="text-[13px] text-slate-400">Todavía no tienes formularios guardados -- se van guardando solos a medida que completas uno.</p>';
    return list.map(s => {
      const id = escapeHtml(s.session_id);
      return `
    <div class="flex items-center gap-2 border border-slate-200 rounded-lg px-3 py-2.5 mb-2 hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-historial-item="${id}">
      <button type="button" data-historial-resume="${id}" class="min-w-0 flex-1 text-left">
        <p class="text-[13px] font-medium text-slate-700 truncate">${escapeHtml(s.title)}</p>
        <p class="text-[11px] text-slate-400">${sub(s)}</p>
      </button>
      <button type="button" data-historial-rename="${id}" aria-label="Renombrar" class="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg text-slate-300 hover:text-brand-600 hover:bg-brand-50">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">${ICON_EDIT}</svg>
      </button>
      <button type="button" data-historial-delete="${id}" aria-label="Eliminar" class="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">${ICON_DEL}</svg>
      </button>
    </div>`;
    }).join('');
  }

  function load() {
    return apiFetch(base, { headers: _headers() })
      .then(r => r && r.ok ? r.json() : null)
      .then(data => { sessions = data?.sessions || []; return sessions; });
  }

  function renderSidebar() {
    const list = document.getElementById('wiz-history-list');
    if (!list) return;
    load()
      .then(items => { list.innerHTML = sidebarItemsHtml(items); })
      .catch(() => { list.innerHTML = '<p class="px-2 py-2 text-[12px] text-red-400">No se pudo cargar el historial.</p>'; });
  }

  /* Modal (móvil) */
  const MODAL_ID = 'hist-modal-overlay';
  const escHandler = (e) => { if (e.key === 'Escape') closeModal(); };

  function closeModal() {
    const el = document.getElementById(MODAL_ID);
    if (el) el.remove();
    document.removeEventListener('keydown', escHandler);
  }

  function setModalList(html) {
    const box = document.querySelector(`#${MODAL_ID} [data-historial-list]`);
    if (box) box.innerHTML = html;
  }

  function openModal() {
    closeModal();
    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6';
    overlay.innerHTML = `
      <div class="absolute inset-0 bg-slate-900/50" data-modal-backdrop></div>
      <div class="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[88vh] overflow-y-auto">
        <button type="button" data-modal-close aria-label="Cerrar" class="sticky top-3 float-right mr-3 w-7 h-7 flex items-center justify-center rounded-lg bg-white/95 backdrop-blur border border-slate-100 text-slate-400 hover:text-slate-700 hover:bg-slate-50 shadow-sm z-10">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <div class="p-6 pt-4">
          <p class="text-[10px] font-semibold text-brand-600 uppercase tracking-wide mb-1">Historial</p>
          <h2 class="text-[16px] font-bold text-slate-800 mb-3">Formularios guardados</h2>
          <div data-historial-list><p class="text-[13px] text-slate-400">Cargando...</p></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-modal-backdrop]').addEventListener('click', closeModal);
    overlay.querySelector('[data-modal-close]').addEventListener('click', closeModal);
    document.addEventListener('keydown', escHandler);
    load()
      .then(items => setModalList(modalItemsHtml(items)))
      .catch(() => setModalList('<p class="text-[13px] text-red-400">No se pudo cargar el historial.</p>'));
  }

  function refreshViews() {
    renderSidebar();
    if (document.getElementById(MODAL_ID)) openModal();
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-abrir-historial]')) { openModal(); return; }

    const resume = e.target.closest('[data-historial-resume]');
    if (resume) { closeModal(); onResume(resume.dataset.historialResume); return; }

    const rename = e.target.closest('[data-historial-rename]');
    if (rename) {
      const sid = rename.dataset.historialRename;
      const actual = (sessions.find(s => s.session_id === sid) || {}).title || '';
      const nuevo = prompt('Nuevo nombre para este formulario:', actual);
      if (nuevo && nuevo.trim()) {
        apiFetch(`${base}/${sid}/rename`, { method: 'POST', headers: _headers(), body: JSON.stringify({ title: nuevo.trim() }) })
          .then(refreshViews).catch(() => {});
      }
      return;
    }

    const del = e.target.closest('[data-historial-delete]');
    if (del) {
      const sid = del.dataset.historialDelete;
      if (confirm('¿Eliminar este formulario guardado? Esta acción no se puede deshacer.')) {
        apiFetch(`${base}/${sid}/delete`, { method: 'POST', headers: _headers() })
          .then(() => { if (sid === getSessionId()) onDeletedActive?.(); refreshViews(); })
          .catch(() => {});
      }
    }
  });

  return { renderSidebar, openModal, closeModal };
}
