/* ═══════════════════════════════════════════════════════════════
   category_wizard.js — motor genérico del wizard de categorías (ver plan
   de implementación: Fase 1 solo Computadores). Generaliza el patrón ya
   probado en medicamentos.js (pantallas completas, una por paso, carrito
   en sessionStorage, vista previa de documento = mismo markup que el PDF)
   para que una categoría nueva solo tenga que declarar su configuración
   (ver computadores_wizard.js), no reescribir este motor.

   Generalizaciones nuevas que medicamentos.js no necesitaba:
   - type "enum_multi": chips de selección múltiple (toggle, con botón
     de confirmación explícito -- un click no basta para saber "ya elegí
     todas las que quería").
   - type "numeric_range": slider nativo sobre los pasos reales de
     catálogo (allowed_steps), no un rango continuo.
   - type "boolean": dos botones sí/no.
   - Precio con Convenio Marco condicional (CONFIG.supportsConvenioMarco,
     que en la práctica es schema.supports_convenio_marco ya resuelto).

   Depende de shell.js (apiFetch, escapeHtml, safeUrl, _headers, readSSEStream)
   y de la configuración de categoría cargada antes que este script
   (ver computadores_wizard.js -- define CONFIG global).
   ═══════════════════════════════════════════════════════════════ */

// let, no const -- resumeSession() lo reasigna al retomar un formulario
// guardado (ver historial más abajo), para que todas las llamadas al
// backend (analizar/manual_update/facets/price/offers) a partir de ahí
// usen el session_id guardado, no uno nuevo.
let SESSION_ID = (crypto.randomUUID ? crypto.randomUUID() : `cat-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// ── Estado (se completa recién al cargar el schema, ver loadSchemaAndInit) ──
// schemaReady se crea más abajo (después de definir loadSchemaAndInit) y
// arranca la carga INMEDIATAMENTE al evaluarse este script -- no espera a
// DOMContentLoaded, para que esté lista lo antes posible. La pantalla de
// texto inicial (ver DOMContentLoaded al final) no depende de esto, así
// que se pinta de inmediato sin esperar nada; solo pasar del primer paso
// en adelante espera schemaReady.
let SCHEMA = null;            // respuesta cruda de /api/categories/{slug}/schema
let CORE_STEPS = [];          // nombres de paso (pueden ser lógicos, ver CONFIG.logicalSteps)
let OPTIONAL_ATTRS = [];      // atributos reales con optional_detail=true
let ATTR_ORDER = [];          // CORE_STEPS resueltos a atributo real + OPTIONAL_ATTRS, para carrito/PDF
let ATTR_LABELS = {};         // attr real -> label
let TOTAL_STEPS = 0;          // CORE_STEPS.length + 1 (paso de detalles opcionales)
let OPTIONAL_STEP_INDEX = 0;

let ficha = {};                 // {attr: {value, source, normalized, score}}
let facetsCache = {};           // {attr: [{value,count}] | [string,...]}
let validValuesCache = {};      // {attr: [str]} -- solo atributos dict/enum_multi, desde /schema
let priceData = null;
let cmPriceData = null;
let showingTextScreen = true;
let currentStepIndex = 0;
const confirmedAttrs = new Set();
const forceChooseAttrs = new Set();
const multiDraft = {};          // {attr: Set} -- selección en progreso de un paso enum_multi
const rangeModeDraft = new Set(); // attrs mostrando el control de rango en vez del slider único (ver numericOptionalControlHtml)
let clarifyNotice = null;       // {message, question} -- la IA no pudo resolver el primer paso core
let offTopicNotice = null;      // string -- se llenó tipo_equipo="Otro" (ver handleOffTopicProduct), el aviso que se muestra al volver a la pantalla de texto
let currentTextoOriginal = '';
let analyzingNow = false;  // mientras analiza el texto no se repinta la pantalla (borraba el formulario y la capa de carga)
let draftCantidad = 1;     // unidades de la compra en construcción (se guarda en el ítem al agregarla)
let editingOptionalAttr = null; // attr de "detalles opcionales" en edición de a uno, o null (ver optionalAttrEditScreenHtml)

// Tope de chips mostrados a la vez sin que el usuario haya escrito nada --
// atributos tipo diccionario (ej. líneas de procesador, modelos) pueden
// tener decenas de valores; en vez de volcarlos todos como una pared de
// chips, se muestran los primeros y se invita a escribir para filtrar
// (ver filterChipsFor/filterMultiChipsFor, que sí buscan sobre la lista
// completa en validValuesCache).
const CHIP_DISPLAY_LIMIT = 10;

// ── Elementos fijos ─────────────────────────────────────────────
const progressWrap     = document.getElementById('wiz-progress-wrap');
const progressSegments = document.getElementById('wiz-progress-segments');
const priceMiniEl      = document.getElementById('wiz-price-mini');
const backBtn          = document.getElementById('wiz-back-btn');
const screenEl         = document.getElementById('wiz-screen');

/* ── Carrito (por formulario, persistido en el servidor) ─────────────────
   Antes vivía en sessionStorage, GLOBAL por slug -- sin relación con
   SESSION_ID. Reportes reales: "cuando presiono nuevo formulario, me
   aparecen cosas... pre cargadas" / "cuando actualizo, también me sale
   como de la última compra" -- el carrito "fantasma" de un formulario
   anterior se colaba en cualquier sesión nueva, incluida la que se crea en
   cada refresh (ver SESSION_ID arriba). Ahora el carrito es parte de la
   ficha guardada de CADA formulario (ver category_session_service.py,
   columna `cart`): "+ Nuevo formulario" arranca con 0 compras de verdad, y
   retomar un formulario del historial (o recargar la página, ver
   CURRENT_SESSION_KEY) trae de vuelta exactamente las compras de ESE
   formulario. */
let cart = [];

function saveCart() {
  apiFetch(`/api/categories/${CONFIG.slug}/sessions/${SESSION_ID}/cart`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ cart }),
  }).catch(() => {});
}

// Qué formulario estaba activo en esta pestaña -- lo único que sigue en
// sessionStorage (no tiene sentido guardarlo server-side, es un detalle de
// "qué estabas mirando en ESTE navegador"). Permite que recargar la página
// retome el mismo formulario en vez de siempre arrancar uno nuevo en
// blanco (ver DOMContentLoaded).
const CURRENT_SESSION_KEY = `cat_${CONFIG.slug}_current_session_v1`;
function rememberCurrentSession(sessionId) {
  try { sessionStorage.setItem(CURRENT_SESSION_KEY, sessionId); } catch (e) {}
}
function getRememberedSession() {
  try { return sessionStorage.getItem(CURRENT_SESSION_KEY); } catch (e) { return null; }
}

/* ── "Revisados" (en memoria, NO sessionStorage) ─────────────────────────
   Reemplaza al comparador completo del chat legacy (selección múltiple +
   modal con matriz comparativa) por algo más simple: marcar transacciones
   de Compra Ágil o productos de Convenio Marco mientras se exploran
   precios, para tenerlos a mano y compararlos a simple vista -- sin
   agregarlos a la cotización (eso sigue siendo "Agregar a la cotización",
   un paso aparte y deliberado).

   A propósito NO se persiste en sessionStorage (a diferencia del carrito):
   bug real reportado -- "hice un nuevo flujo completando desde el inicio,
   y cuando llegué a la pestaña ya tenía cosas seleccionadas para comparar
   de la compra anterior. No se limpió, como debería". Como hoy cada carga
   de página es, en los hechos, una sesión nueva (no existe retomar una
   sesión anterior, ver pendiente de historial), lo correcto es que
   revisados arranque vacío SIEMPRE, no que sobreviva a un refresh. */
let revisados = [];

/* Cada revisado nace en el borrador en curso (itemId == null) y, al agregar
   la compra al requerimiento, queda asociado a ese ítem (itemId = id del
   ítem del carrito) -- así el resumen ejecutivo compara cada producto con
   el mercado de SU ítem. Los del borrador se descartan si el borrador se
   descarta (ver resetWizardState). Sigue sin persistirse. */
function isRevisado(source, key) {
  return revisados.some(r => r.itemId == null && r.source === source && r.key === key);
}
function toggleRevisado(source, key, data) {
  const idx = revisados.findIndex(r => r.itemId == null && r.source === source && r.key === key);
  if (idx >= 0) revisados.splice(idx, 1);
  else revisados.push({ source, key, ...data });
  renderRevisadosPanel();
}

function renderRevisadosPanel() {
  const el = document.getElementById('wiz-revisados-panel');
  if (!el) return;
  if (!revisados.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="bg-white border border-slate-200 rounded-xl p-3.5 mb-4">
      <div class="flex items-center justify-between mb-1.5">
        <p class="text-[10.5px] font-semibold text-slate-500 uppercase tracking-wide">Productos revisados (${revisados.length})</p>
        <button type="button" data-revisados-clear class="text-[10.5px] text-slate-400 hover:text-red-500">Vaciar</button>
      </div>
      <p class="text-[10.5px] text-slate-400 mb-2">Guardados para comparar -- no se agregan a la cotización.</p>
      <div class="space-y-1.5 mb-2.5">
        ${revisados.map(r => `
          <div class="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5" data-revisado-key="${escapeHtml(r.source)}:${escapeHtml(r.key)}" data-revisado-item="${escapeHtml(r.itemId || '')}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0 ${r.source === 'cm' ? 'bg-brand-100 text-brand-700' : 'bg-emerald-100 text-emerald-700'}">${r.source === 'cm' ? 'CM' : 'CA'}</span>
                ${r.url ? `<a href="${escapeHtml(safeUrl(r.url))}" target="_blank" rel="noopener" class="text-[11px] font-medium text-slate-700 hover:text-brand-700 hover:underline truncate">${escapeHtml(r.label)}</a>` : `<p class="text-[11px] font-medium text-slate-700 truncate">${escapeHtml(r.label)}</p>`}
              </div>
              ${r.sub ? `<p class="text-[10px] text-slate-400 truncate mt-0.5">${escapeHtml(r.sub)}</p>` : ''}
            </div>
            <span class="text-[11.5px] font-bold text-slate-700 flex-shrink-0">${formatCLP(revisadoPrecio(r)) || '—'}</span>
            <button type="button" data-revisados-remove class="text-slate-300 hover:text-red-500 flex-shrink-0">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>`).join('')}
      </div>
      <button type="button" data-ver-comparacion class="w-full flex items-center justify-center gap-1.5 py-2 bg-brand-50 hover:bg-brand-100 border border-brand-200 text-brand-700 text-[12.5px] font-semibold rounded-lg transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 17V7m6 10V11m-9 6h12a2 2 0 002-2V7a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
        Ver tabla comparativa
      </button>
    </div>`;
}

// Click dentro del panel de revisados -- vive en "Mi cotización" (ver
// #wiz-revisados-panel en el cart-panel del template), NO adentro de
// screenEl, así que se delega aparte (ver cartPanel.addEventListener en
// DOMContentLoaded) en vez de sumarse a bindGlobalPriceDelegation().
function handleRevisadosClick(e) {
  const revisadosRemove = e.target.closest('[data-revisados-remove]');
  if (revisadosRemove) {
    const row = revisadosRemove.closest('[data-revisado-key]');
    const [source, ...rest] = (row?.dataset.revisadoKey || '').split(':');
    const key = rest.join(':');
    const itemId = row?.dataset.revisadoItem || null;
    const idx = revisados.findIndex(r => (r.itemId || null) === itemId && r.source === source && r.key === key);
    if (idx >= 0) {
      revisados.splice(idx, 1);
      renderRevisadosPanel();
      renderPricePanel(); // refleja el cambio en los botones "revisar" de las tarjetas visibles (si el resumen está pintado)
    }
    return;
  }

  if (e.target.closest('[data-revisados-clear]')) {
    revisados = [];
    renderRevisadosPanel();
    renderPricePanel();
    return;
  }

  if (e.target.closest('[data-ver-comparacion]')) {
    openModal(comparisonModalHtml(), { wide: true });
    return;
  }
}

/* ── Modal genérico (detalle de un producto/transacción, comparación) ────
   Inyectado directo al <body> en vez de vivir en el HTML del template --
   consistente con el resto del motor genérico (nada de categoría-
   específico vive en el template, todo en este archivo). Un solo modal a
   la vez (openModal cierra el anterior si había uno). */
function openModal(innerHtml, { wide = false } = {}) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.id = 'wiz-modal-overlay';
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6';
  overlay.innerHTML = `
    <div class="absolute inset-0 bg-slate-900/50" data-modal-backdrop></div>
    <div class="relative bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} max-h-[88vh] overflow-y-auto">
      <button type="button" data-modal-close aria-label="Cerrar" class="sticky top-3 float-right mr-3 w-7 h-7 flex items-center justify-center rounded-lg bg-white/95 backdrop-blur border border-slate-100 text-slate-400 hover:text-slate-700 hover:bg-slate-50 shadow-sm z-10">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
      <div class="p-6 pt-4" data-modal-body>${innerHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-modal-backdrop]').addEventListener('click', closeModal);
  overlay.querySelector('[data-modal-close]').addEventListener('click', closeModal);
  document.addEventListener('keydown', _modalEscHandler);

  // Delegación para contenido DENTRO del modal (ej. las pestañas de la
  // comparación) -- atada una sola vez al overlay, que sí sobrevive a
  // updateModalBody() (solo reemplaza [data-modal-body], no el overlay).
  overlay.addEventListener('click', (e) => {
    const filterBtn = e.target.closest('[data-comparison-filter]');
    if (filterBtn) {
      comparisonFilter = filterBtn.dataset.comparisonFilter;
      updateModalBody(comparisonModalHtml());
      return;
    }

    handleHistorialClick(e);
  });
}

// Click de resumir/renombrar/borrar un formulario guardado -- compartido
// entre el modal (mobile) y la barra lateral (desktop), para no duplicar
// esta lógica en dos listeners distintos. Devuelve true si el click era
// de historial (y ya se manejó), false si no tenía nada que ver.
function handleHistorialClick(e) {
  const historialResume = e.target.closest('[data-historial-resume]');
  if (historialResume) {
    resumeSession(historialResume.dataset.historialResume);
    return true;
  }
  const historialRename = e.target.closest('[data-historial-rename]');
  if (historialRename) {
    const sid = historialRename.dataset.historialRename;
    const actual = (_historialSessions.find(s => s.session_id === sid) || {}).title || '';
    const nuevo = prompt('Nuevo nombre para este formulario:', actual);
    if (nuevo && nuevo.trim()) {
      apiFetch(`/api/categories/${CONFIG.slug}/sessions/${sid}/rename`, {
        method: 'POST', headers: _headers(), body: JSON.stringify({ title: nuevo.trim() }),
      }).then(refreshHistorialViews).catch(() => {});
    }
    return true;
  }
  const historialDelete = e.target.closest('[data-historial-delete]');
  if (historialDelete) {
    const sid = historialDelete.dataset.historialDelete;
    if (confirm('¿Eliminar este formulario guardado? Esta acción no se puede deshacer.')) {
      apiFetch(`/api/categories/${CONFIG.slug}/sessions/${sid}/delete`, { method: 'POST', headers: _headers() })
        .then(refreshHistorialViews).catch(() => {});
    }
    return true;
  }
  return false;
}

// Refresca ambas superficies de historial tras renombrar/borrar -- la
// sidebar (siempre, si existe en el DOM) y el modal (solo si está abierto,
// mobile) -- así no quedan desincronizadas entre sí.
function refreshHistorialViews() {
  renderHistorySidebar();
  if (document.getElementById('wiz-modal-overlay')) openHistorial();
}
function updateModalBody(innerHtml) {
  const body = document.querySelector('#wiz-modal-overlay [data-modal-body]');
  if (body) body.innerHTML = innerHtml;
}
function closeModal() {
  const el = document.getElementById('wiz-modal-overlay');
  if (el) el.remove();
  document.removeEventListener('keydown', _modalEscHandler);
}
function _modalEscHandler(e) { if (e.key === 'Escape') closeModal(); }

// Campos con especificaciones estructuradas, compartidos entre transacciones
// de Compra Ágil (price_service.get_offer_rows) y productos de Convenio
// Marco (cm_service -- misma nomenclatura de atributos en ambas fuentes,
// ver pg_get_viewdef('"PrecioCM"')) -- por eso una sola lista sirve para el
// detalle de cualquiera de las dos Y para la tabla comparativa (revisados
// puede mezclar ítems de ambas fuentes en la misma comparación).
const OFFER_DETAIL_FIELDS = [
  ['tipo_equipo', 'Tipo de equipo'], ['marca', 'Marca'], ['nombre_modelo', 'Modelo'],
  ['procesador_principal', 'Procesador'], ['linea_procesador', 'Línea de procesador'],
  ['generacion_procesador', 'Generación'], ['hilos_procesador', 'Hilos'],
  ['frecuencia_turbo_procesador_mhz', 'Frecuencia turbo (MHz)'], ['puntaje_passmark_cpu', 'PassMark CPU'],
  ['total_ram_gb', 'RAM (GB)'], ['tecnologia_ram', 'Tecnología RAM'], ['frecuencia_ram_mhz', 'Frecuencia RAM (MHz)'],
  ['total_almacenamiento_gb', 'Almacenamiento (GB)'], ['tecnologia_disco_principal', 'Tecnología de disco'],
  ['tipo_configuracion_discos', 'Configuración de discos'],
  ['tiene_gpu_dedicada', '¿GPU dedicada?'], ['gpu_dedicada_nombre', 'GPU dedicada'],
  ['total_vram_gpu_gb', 'VRAM (GB)'], ['tecnologia_gpu_principal', 'Tecnología GPU'],
  ['pantalla_pulgadas', 'Pantalla (")'], ['sistema_operativo', 'Sistema operativo'],
  ['wifi_generacion', 'Wi-Fi'], ['part_number', 'Part number'],
  ['monitor_si_no', 'Incluye monitor'], ['peso_equipo', 'Peso'], ['uso', 'Uso recomendado'],
];

// "No especificado" (y variantes) es, en la práctica, lo mismo que NULL en
// estas tablas -- se oculta igual que un valor vacío en vez de mostrar el
// texto literal (reporte real: "en lugar de poner no especificado,
// simplemente los ocultamos").
function isUnspecified(val) {
  if (val == null || val === '') return true;
  if (typeof val === 'string') return /^no\s*especificad[oa]$/i.test(val.trim());
  return false;
}

function specRowsHtml(item) {
  const rows = OFFER_DETAIL_FIELDS.filter(([key]) => !isUnspecified(item[key]));
  if (!rows.length) return '<p class="text-[12px] text-slate-400">Sin especificaciones adicionales registradas.</p>';
  // Grilla de dos columnas -- con un solo listado vertical, el popup quedaba
  // angosto y muy alargado para lo poco que mostraba por fila (reporte real).
  return `<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-5">
    ${rows.map(([key, label]) => {
      const val = typeof item[key] === 'boolean' ? (item[key] ? 'Sí' : 'No') : item[key];
      return `<div class="flex justify-between gap-3 py-1.5 border-b border-slate-100"><span class="text-[12px] text-slate-400">${escapeHtml(label)}</span><span class="text-[12.5px] text-slate-700 font-medium text-right">${escapeHtml(val)}</span></div>`;
    }).join('')}
  </div>`;
}

function offerDetailModalHtml(o) {
  return `
    <p class="text-[10px] font-semibold text-emerald-600 uppercase tracking-wide mb-1">Resumen ejecutivo · Compra Ágil</p>
    <h2 class="text-[16px] font-bold text-slate-800 leading-snug mb-1">${escapeHtml(o.razon_social || 'Proveedor no informado')}</h2>
    <p class="text-[20px] font-bold text-emerald-700 mb-2">${formatCLP(o.precio_unitario_iva) || '—'}</p>
    ${o.descripcion ? `<p class="text-[12px] text-slate-600 bg-slate-50 border-l-2 border-emerald-300 px-3 py-2 mb-2 leading-relaxed">${escapeHtml(o.descripcion)}</p>` : ''}
    <p class="text-[11px] text-slate-400 mb-3">${escapeHtml(o.codigo_requerimiento || '')}${o.fecha_modificacion ? ' · ' + escapeHtml(o.fecha_modificacion) : ''}${o.ca_available ? ` · <a href="${escapeHtml(safeUrl(o.ca_url))}" target="_blank" rel="noopener" class="text-brand-600 hover:underline">Ver en Compra Ágil ↗</a>` : ''}</p>
    <div class="pt-2 border-t border-slate-100">${specRowsHtml(o)}</div>`;
}

function cmDetailModalHtml(p) {
  const priceLabel = p.precio_min_clp != null
    ? (p.precio_max_clp != null && p.precio_max_clp !== p.precio_min_clp
        ? `${formatCLP(conIva(p.precio_min_clp))} – ${formatCLP(conIva(p.precio_max_clp))}` : formatCLP(conIva(p.precio_min_clp)))
    : 'Precio no informado';
  return `
    <p class="text-[10px] font-semibold text-brand-600 uppercase tracking-wide mb-1">Resumen ejecutivo · Convenio Marco</p>
    <h2 class="text-[16px] font-bold text-slate-800 leading-snug mb-1">${escapeHtml(p.nombre || p.modelo || p.marca || 'Producto Convenio Marco')}</h2>
    <p class="text-[20px] font-bold text-brand-700 mb-2">${priceLabel}</p>
    <p class="text-[11px] text-slate-400 mb-3">${escapeHtml(p.marca || '')}${p.url ? ` · <a href="${escapeHtml(safeUrl(p.url))}" target="_blank" rel="noopener" class="text-brand-600 hover:underline">Ver en Convenio Marco ↗</a>` : ''}</p>
    <div class="pt-2 border-t border-slate-100">${specRowsHtml(p)}</div>`;
}

let comparisonFilter = 'all'; // 'all' | 'ca' | 'cm' -- ver tabs en comparisonModalHtml

function comparisonModalHtml() {
  if (!revisados.length) {
    return `<p class="text-[13px] text-slate-500">No hay productos revisados para comparar todavía.</p>`;
  }
  const filtered = revisados.filter(r => comparisonFilter === 'all' || r.source === comparisonFilter);
  const tabs = [['all', 'Todos'], ['ca', 'Solo Compra Ágil'], ['cm', 'Solo Convenio Marco']];
  const tabsHtml = `
    <div class="flex items-center gap-1.5 mb-3">
      ${tabs.map(([v, l]) => `
        <button type="button" data-comparison-filter="${v}" class="text-[11.5px] font-medium px-2.5 py-1 rounded-full border transition-colors ${comparisonFilter === v ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'}">${l}</button>`).join('')}
    </div>`;
  const header = `
    <p class="text-[10px] font-semibold text-brand-600 uppercase tracking-wide mb-1">Comparación</p>
    <h2 class="text-[16px] font-bold text-slate-800 mb-3">${revisados.length} producto${revisados.length === 1 ? '' : 's'} revisados</h2>
    ${tabsHtml}`;

  if (!filtered.length) {
    return header + `<p class="text-[13px] text-slate-500">No hay productos de este tipo entre los revisados.</p>`;
  }

  const fieldRows = OFFER_DETAIL_FIELDS.filter(([key]) => filtered.some(r => r.raw && !isUnspecified(r.raw[key])));
  return header + `
    <div class="overflow-x-auto -mx-6 px-6">
      <table class="w-full text-[11.5px] border-collapse">
        <thead>
          <tr>
            <th class="text-left text-slate-400 font-medium py-1.5 pr-3 sticky left-0 bg-white">Atributo</th>
            ${filtered.map(r => `
              <th class="text-left py-1.5 px-3 min-w-[160px] align-bottom">
                <span class="inline-block text-[9px] font-bold uppercase px-1.5 py-0.5 rounded mb-1 ${r.source === 'cm' ? 'bg-brand-100 text-brand-700' : 'bg-emerald-100 text-emerald-700'}">${r.source === 'cm' ? 'CM' : 'CA'}</span>
                <div class="text-slate-700 font-semibold truncate max-w-[180px]" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</div>
              </th>`).join('')}
          </tr>
        </thead>
        <tbody>
          <tr class="border-t border-slate-100">
            <td class="text-slate-400 py-1.5 pr-3 sticky left-0 bg-white">Precio</td>
            ${filtered.map(r => `<td class="py-1.5 px-3 font-bold text-emerald-700">${formatCLP(revisadoPrecio(r)) || '—'}</td>`).join('')}
          </tr>
          ${fieldRows.map(([key, label]) => `
          <tr class="border-t border-slate-100">
            <td class="text-slate-400 py-1.5 pr-3 sticky left-0 bg-white">${escapeHtml(label)}</td>
            ${filtered.map(r => {
              const v = r.raw ? r.raw[key] : null;
              const disp = isUnspecified(v) ? '—' : (typeof v === 'boolean' ? (v ? 'Sí' : 'No') : v);
              return `<td class="py-1.5 px-3 text-slate-700">${escapeHtml(disp)}</td>`;
            }).join('')}
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

/* ── Historial de formularios ──────────────────────────────────────────
   Pendiente real reportado: "ya no tengo el historial de formularios que
   he rellenado... antes tenía como un historial de conversaciones, ahora
   nada". El guardado incremental corre en el backend (ver
   category_session_service.py, llamado desde /analizar y /manual_update
   en main.py cada vez que se completa un atributo) -- acá solo se lista y
   se retoma/renombra/borra. */

function formatFechaCorta(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('es-CL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

function historialModalHtml() {
  return `
    <p class="text-[10px] font-semibold text-brand-600 uppercase tracking-wide mb-1">Historial</p>
    <h2 class="text-[16px] font-bold text-slate-800 mb-3">Formularios guardados</h2>
    <div data-historial-list><p class="text-[13px] text-slate-400">Cargando...</p></div>`;
}

function historialListHtml(sessions) {
  if (!sessions.length) return `<p class="text-[13px] text-slate-400">Todavía no tienes formularios guardados -- se van guardando solos a medida que completas uno.</p>`;
  return sessions.map(s => `
    <div class="flex items-center gap-2 border border-slate-200 rounded-lg px-3 py-2.5 mb-2 hover:border-brand-300 hover:bg-brand-50/30 transition-colors" data-historial-item="${escapeHtml(s.session_id)}">
      <button type="button" data-historial-resume="${escapeHtml(s.session_id)}" class="min-w-0 flex-1 text-left">
        <p class="text-[13px] font-medium text-slate-700 truncate">${escapeHtml(s.title)}</p>
        <p class="text-[11px] text-slate-400">${escapeHtml(formatFechaCorta(s.updated_at))}${s.n_compras ? ` · ${s.n_compras} compra${s.n_compras === 1 ? '' : 's'}` : ''}</p>
      </button>
      <button type="button" data-historial-rename="${escapeHtml(s.session_id)}" aria-label="Renombrar" class="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg text-slate-300 hover:text-brand-600 hover:bg-brand-50">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828z"/></svg>
      </button>
      <button type="button" data-historial-delete="${escapeHtml(s.session_id)}" aria-label="Eliminar" class="w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
    </div>`).join('');
}

let _historialSessions = [];

function openHistorial() {
  openModal(historialModalHtml());
  apiFetch(`/api/categories/${CONFIG.slug}/sessions`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      _historialSessions = data?.sessions || [];
      updateModalBody(historialModalHtml().replace(
        '<div data-historial-list><p class="text-[13px] text-slate-400">Cargando...</p></div>',
        `<div data-historial-list>${historialListHtml(_historialSessions)}</div>`
      ));
    })
    .catch(() => {
      updateModalBody(historialModalHtml().replace(
        '<div data-historial-list><p class="text-[13px] text-slate-400">Cargando...</p></div>',
        `<div data-historial-list><p class="text-[13px] text-red-400">No se pudo cargar el historial.</p></div>`
      ));
    });
}

// opts.onFail: lo usa el auto-retomado al cargar la página (ver
// DOMContentLoaded) -- si el session_id guardado en este navegador ya no
// existe (se borró, cambió de dueño, etc.), hay que caer a un formulario
// nuevo en blanco en vez de dejar la pantalla de "Retomando..." colgada.
function resumeSession(sessionId, opts = {}) {
  return schemaReady.then(() => apiFetch(`/api/categories/${CONFIG.slug}/sessions/${sessionId}/resume`, { method: 'POST', headers: _headers() }))
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      if (!data) { opts.onFail?.(); return; }
      SESSION_ID = sessionId;
      rememberCurrentSession(sessionId);
      resetWizardState();
      revisados = [];
      Object.entries(data.ficha || {}).forEach(([attr, value]) => {
        if (value == null) return;
        ficha[attr] = { attribute: attr, value, source: 'user', normalized: true, score: 1 };
      });
      currentTextoOriginal = data.texto_original || '';
      cart = data.cart || [];
      showingTextScreen = false;
      // Saltar al primer paso core que falte -- si ya están todos, al
      // resumen directo. No se guarda "en qué paso se quedó" explícitamente
      // (más simple, y se auto-corrige si core_order cambia entre sesiones).
      const firstUnfilled = CORE_STEPS.findIndex(step => {
        const attr = stepPrimaryAttr(step);
        const v = ficha[attr]?.value;
        return v == null || v === '';
      });
      currentStepIndex = firstUnfilled === -1 ? TOTAL_STEPS : firstUnfilled;
      closeModal();
      renderCartBar();
      renderScreen();
      renderHistorySidebar();
    })
    .catch(() => opts.onFail?.());
}

// "+ Nuevo formulario" (barra lateral, desktop) -- mismo criterio que
// "New chat" en ChatGPT: no borra ni resetea el formulario anterior (ya
// quedó guardado solo, ver save_ficha en main.py), simplemente arranca uno
// en blanco con un SESSION_ID nuevo. Carrito también arranca vacío --es un
// formulario distinto, con sus propias compras (ver nota del carrito).
function nuevoFormulario() {
  SESSION_ID = (crypto.randomUUID ? crypto.randomUUID() : `cat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  rememberCurrentSession(SESSION_ID);
  cart = [];
  resetWizardState();
  revisados = [];
  renderCartBar();
  renderScreen();
  renderHistorySidebar();
}

// Barra lateral de historial (desktop, ver <aside id="wiz-history-sidebar">
// en el template) -- misma data que el modal (openHistorial, mobile), pero
// renderizada como lista compacta siempre visible, con el formulario activo
// resaltado (comparando contra SESSION_ID).
function historialSidebarItemsHtml(sessions) {
  if (!sessions.length) {
    return `<p class="px-2 py-2 text-[12px] text-slate-400">Tus formularios se guardan solos a medida que los completas.</p>`;
  }
  return sessions.map(s => {
    const active = s.session_id === SESSION_ID;
    return `
    <div class="group flex items-center gap-1 rounded-lg px-2 py-2 transition-colors ${active ? 'bg-brand-50' : 'hover:bg-slate-100'}" data-historial-item="${escapeHtml(s.session_id)}">
      <button type="button" data-historial-resume="${escapeHtml(s.session_id)}" class="min-w-0 flex-1 text-left">
        <p class="text-[12.5px] font-medium truncate ${active ? 'text-brand-700' : 'text-slate-600'}">${escapeHtml(s.title)}</p>
        <p class="text-[10.5px] text-slate-400">${escapeHtml(formatFechaCorta(s.updated_at))}${s.n_compras ? ` · ${s.n_compras} compra${s.n_compras === 1 ? '' : 's'}` : ''}</p>
      </button>
      <button type="button" data-historial-rename="${escapeHtml(s.session_id)}" aria-label="Renombrar" class="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-md text-slate-300 opacity-0 group-hover:opacity-100 hover:text-brand-600 hover:bg-brand-100 transition-opacity">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828z"/></svg>
      </button>
      <button type="button" data-historial-delete="${escapeHtml(s.session_id)}" aria-label="Eliminar" class="w-6 h-6 flex-shrink-0 flex items-center justify-center rounded-md text-slate-300 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-100 transition-opacity">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
      </button>
    </div>`;
  }).join('');
}

function renderHistorySidebar() {
  const list = document.getElementById('wiz-history-list');
  if (!list) return; // siempre existe en el DOM (solo se oculta por CSS bajo lg), esto es defensivo
  apiFetch(`/api/categories/${CONFIG.slug}/sessions`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      _historialSessions = data?.sessions || [];
      list.innerHTML = historialSidebarItemsHtml(_historialSessions);
    })
    .catch(() => {
      list.innerHTML = `<p class="px-2 py-2 text-[12px] text-red-400">No se pudo cargar el historial.</p>`;
    });
}

// Estadísticos de precio con IVA cuando existen (price_data trae median/p25/p75
// NETOS y median_iva/p25_iva/p75_iva con IVA). Los paneles rotulan "IVA
// incluido" y las transacciones vienen con IVA: mezclar neto con bruto
// descuadraba todo (la mediana quedaba 19 % bajo las compras que resume).
// Precio de un producto revisado tal como se muestra (con IVA en ambos orígenes)
function revisadoPrecio(r) { return r.source === 'cm' ? conIva(r.price) : r.price; }

function priceStat(p, key) {
  if (!p) return null;
  const v = p[key + '_iva'];
  return v != null ? v : (p[key] ?? null);
}

function formatCLP(n) {
  return Number.isFinite(n)
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
    : null;
}
function formatAttrValue(value) {
  if (Array.isArray(value)) return value.map(escapeHtml).join(' + ');
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  return escapeHtml(value);
}
function badgeFor(source) {
  const cfg = {
    ai:   { label: 'IA', cls: 'bg-violet-50 text-violet-600 border-violet-200' },
    user: { label: 'Tú', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
    complement: { label: 'Auto', cls: 'bg-amber-50 text-amber-600 border-amber-200' },
  }[source];
  if (!cfg) return '';
  return `<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md border ${cfg.cls}">${cfg.label}</span>`;
}

/* ── Resolución de pasos lógicos ──────────────────────────────────
   Un "paso" del wizard (core_order) puede no ser un atributo real --
   ver CONFIG.logicalSteps (ej. "linea_procesador_o_procesador" resuelve
   a "linea_procesador" por defecto, con "procesador_principal" como
   alternativa de modelo exacto). Esto permite que un mismo paso visual
   cubra dos atributos relacionados sin que el motor genérico tenga que
   saber nada de computadores en particular. */
function stepPrimaryAttr(step) {
  const logical = (CONFIG.logicalSteps || {})[step];
  return logical ? logical.attr : step;
}
function stepMeta(step) {
  return SCHEMA.attributes[stepPrimaryAttr(step)];
}
function stepLabel(step) {
  return stepMeta(step)?.label || step;
}

/* ── SSE: análisis y edición manual ──────────────────────────────── */

function analizar() {
  const input = document.getElementById('wiz-texto-input');
  const btn = document.getElementById('wiz-analizar-btn');
  const icon = document.getElementById('wiz-analizar-icon');
  const hint = document.getElementById('wiz-analizar-hint');
  const texto = input.value.trim();
  if (!texto) return;
  currentTextoOriginal = texto;

  btn.disabled = true;
  icon.classList.add('animate-spin');
  hint.textContent = 'Analizando...';
  analyzingNow = true;
  showAnalyzing(btn, [
    'Leyendo tu requerimiento...',
    'Identificando tipo de equipo y especificaciones...',
    'Preparando los pasos de la ficha...',
  ]);
  clarifyNotice = null;
  offTopicNotice = null;

  // Espera a que el schema ya esté cargado antes de mandar el texto --
  // así cuando lleguen los eventos SSE (ficha_update dispara renderScreen())
  // CORE_STEPS/SCHEMA ya existen. En la práctica el schema (una llamada
  // local) siempre termina mucho antes que el usuario alcance a escribir
  // y apretar "Analizar", así que esto casi nunca espera de verdad.
  schemaReady
    .then(() => apiFetch(`/api/categories/${CONFIG.slug}/analizar/${SESSION_ID}`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({ texto }),
    }))
    .then(res => res ? readSSEStream(res, handleWizardEvent) : null)
    .then(() => {
      // Si el stream ya cortó el flujo por tipo_equipo="Otro" (ver
      // handleOffTopicProduct, disparado dentro de handleWizardEvent),
      // showingTextScreen ya quedó en true con el aviso puesto -- no pisarlo
      // forzando el avance normal acá.
      analyzingNow = false;
      if (offTopicNotice) { renderScreen(); renderHistorySidebar(); return; }
      showingTextScreen = false;
      rememberCurrentSession(SESSION_ID); // ya hay algo guardado server-side -- recién ahora tiene sentido retomarla en un refresh
      renderScreen();
      renderHistorySidebar(); // primer guardado de esta sesión -- recién ahora aparece en la lista
    })
    .catch(err => console.error('Error en analizar:', err))
    .finally(() => {
      btn.disabled = false;
      icon.classList.remove('animate-spin');
      analyzingNow = false;
      hideAnalyzing(btn);
    });
}

function manualUpdate(attr, value) {
  apiFetch(`/api/categories/${CONFIG.slug}/manual_update/${SESSION_ID}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ attribute: attr, value }),
  })
    .then(res => res ? readSSEStream(res, handleWizardEvent) : null)
    .then(() => {
      rememberCurrentSession(SESSION_ID); // idem analizar() -- por si este fue el primer dato guardado (flujo "completa los datos directamente")
      renderHistorySidebar();
    })
    .catch(err => console.error('Error en manual_update:', err));
}

function handleWizardEvent(data) {
  switch (data.type) {
    case 'ficha_update':
      data.updates.forEach(u => { ficha[u.attribute] = u; });
      // "Otro" es un valor real del esquema (tipo_equipo admite Laptop/AIO/
      // Desktop/Otro) que el extractor de IA usa cuando lo descrito no es
      // ninguno de los tres -- ej. pidieron una impresora o un monitor.
      // Reporte real: "si se solicita un producto que no corresponde
      // aparece Otros, no debería dejar continuar". Se corta ACÁ (cubre
      // tanto el análisis de texto libre como cualquier manual_update que
      // termine fijando este valor, ambos pasan por este mismo evento) en
      // vez de dejar avanzar el wizard con una categoría que price_service/
      // cm_service igual excluyen más adelante (cm_service.py ya filtra
      // `tipo_equipo <> 'Otro'` al armar el catálogo).
      if (ficha.tipo_equipo?.value === 'Otro') {
        handleOffTopicProduct();
        break;
      }
      renderScreen();
      break;
    case 'message':
      if (data.text) {
        clarifyNotice = { ...(clarifyNotice || {}), message: data.text };
        renderScreen();
      }
      break;
    case 'questions':
      if (data.questions && data.questions.length) {
        clarifyNotice = { ...(clarifyNotice || {}), question: data.questions[0] };
        renderScreen();
      }
      break;
    case 'price_update':
      priceData = data.data;
      renderPricePanel();
      break;
    case 'price_not_found':
      priceData = null;
      renderPricePanel();
      break;
    case 'cm_price_update':
      cmPriceData = data.data;
      cmState.page = 1; // catálogo nuevo (ficha cambió) -- no mantener la página de la búsqueda anterior
      renderPricePanel();
      break;
    case 'cm_price_not_found':
      cmPriceData = null;
      renderPricePanel();
      break;
    case 'usage_limit_reached': {
      const hint = document.getElementById('wiz-analizar-hint');
      if (hint) hint.textContent = 'Alcanzaste el límite diario de uso de IA -- puedes seguir eligiendo atributos manualmente.';
      break;
    }
    case 'error':
      console.error('Error del servidor:', data.message);
      break;
  }
}

/* ── Transiciones entre pasos ─────────────────────────────────────── */

function onAttrConfirmed(step) {
  confirmedAttrs.add(step);
  forceChooseAttrs.delete(step);
  advanceStep();
}

function advanceStep() {
  currentStepIndex = Math.min(currentStepIndex + 1, TOTAL_STEPS);
  renderScreen();
  if (currentStepIndex < CORE_STEPS.length) {
    refreshFacetsFor([CORE_STEPS[currentStepIndex]]);
  }
  // "Detalles opcionales" NO precarga sus facets acá -- varios de estos
  // atributos consultan la base real (marca/procesador/SO pueden tardar
  // varios segundos) y disparar todos a la vez apenas se entra a la
  // pantalla se siente lento y desordenado (una pared de spinners). Cada
  // campo carga sus propias sugerencias recién al enfocarlo (ver
  // ensureFacetsLoaded, enganchado en el listener 'focus' de [data-input]).
}

function goBack() {
  if (currentStepIndex === 0) {
    showingTextScreen = true;
    renderScreen();
    return;
  }
  currentStepIndex -= 1;
  if (currentStepIndex < CORE_STEPS.length) {
    const step = CORE_STEPS[currentStepIndex];
    confirmedAttrs.delete(step);
    forceChooseAttrs.add(step);
    refreshFacetsFor([step]);
  }
  renderScreen();
}

function pickValue(attr, value) {
  ficha[attr] = { attribute: attr, value, source: 'user', normalized: true, score: 1 };
  manualUpdate(attr, value);
  const step = CORE_STEPS.find(s => stepPrimaryAttr(s) === attr) ?? (currentStepIndex < CORE_STEPS.length ? CORE_STEPS[currentStepIndex] : null);
  if (step && CORE_STEPS.includes(step)) {
    onAttrConfirmed(step);
  } else if (editingOptionalAttr === attr) {
    // se definió desde el editor de un detalle opcional -- guardar y volver
    // a la lista (ver optionalAttrEditScreenHtml / detallesScreenHtml).
    editingOptionalAttr = null;
    renderScreen();
  } else {
    // atributo opcional: se completa sin avanzar de paso.
    renderScreen();
  }
}

function clearOptionalAttr(attr) {
  ficha[attr] = null;
  manualUpdate(attr, null);
  editingOptionalAttr = null;
  renderScreen();
}

/* ── Barra de progreso + precio mini ───────────────────────────────── */

function updateProgressBar() {
  if (showingTextScreen) {
    progressWrap.classList.add('hidden');
    return;
  }
  progressWrap.classList.remove('hidden');
  const segs = [];
  for (let i = 0; i < TOTAL_STEPS; i++) {
    let cls = 'bg-slate-200';
    if (i < currentStepIndex) cls = 'bg-brand-800';
    else if (i === currentStepIndex) cls = 'bg-brand-600';
    segs.push(`<div class="h-1 flex-1 rounded-full ${cls} transition-colors"></div>`);
  }
  progressSegments.innerHTML = segs.join('');
}

function renderPriceMini() {
  if (showingTextScreen || !priceData || priceStat(priceData, 'median') == null) {
    priceMiniEl.classList.add('hidden');
  } else {
    priceMiniEl.textContent = formatCLP(priceStat(priceData, 'median'));
    priceMiniEl.classList.remove('hidden');
  }
}

/* ── Render de la pantalla activa ──────────────────────────────────── */

function renderScreen() {
  if (analyzingNow) return;
  updateProgressBar();
  renderPriceMini();
  renderDocPreview();

  let html;
  if (showingTextScreen) {
    html = textoScreenHtml();
  } else if (currentStepIndex < CORE_STEPS.length) {
    html = stepScreenHtml(CORE_STEPS[currentStepIndex]);
  } else if (currentStepIndex === OPTIONAL_STEP_INDEX) {
    html = editingOptionalAttr ? optionalAttrEditScreenHtml(editingOptionalAttr) : detallesScreenHtml();
  } else {
    html = resumenScreenHtml();
  }

  screenEl.classList.add('wiz-screen-enter');
  screenEl.innerHTML = html;
  void screenEl.offsetWidth;
  screenEl.classList.remove('wiz-screen-enter');

  bindScreenEvents();
  if (showingTextScreen) bindTextoLibre(document.getElementById('wiz-texto-input'), document.getElementById('wiz-texto-count'));

  if (!showingTextScreen && currentStepIndex < CORE_STEPS.length) {
    const step = CORE_STEPS[currentStepIndex];
    const attr = stepPrimaryAttr(step);
    const showsPicker = !ficha[attr]?.value || ficha[attr]?.source !== 'ai' || confirmedAttrs.has(step) || forceChooseAttrs.has(step);
    if (showsPicker) refreshFacetsFor([step]);
  }
  // TOTAL_STEPS es 0 hasta que carga el schema -- el "!showingTextScreen"
  // evita que esto dispare en la pantalla de texto inicial, donde
  // currentStepIndex(0) === TOTAL_STEPS(0) sería falsamente "ya llegué al resumen".
  if (!showingTextScreen && currentStepIndex === TOTAL_STEPS) {
    loadPrice();
    renderRevisadosPanel();
  }
}

// Pantalla mínima mientras se retoma el formulario de esta pestaña al
// cargar la página (ver DOMContentLoaded/CURRENT_SESSION_KEY) -- reporte
// real de que faltaban indicadores de carga en varios lados; acá en
// particular, antes el usuario veía la pantalla de texto en blanco por un
// instante antes de que el formulario retomado la pisara, lo cual se
// sentía como un parpadeo raro más que como "se está cargando algo".
function loadingScreenHtml(text) {
  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm flex items-center justify-center gap-3">
      <svg class="w-5 h-5 text-brand-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
        <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
      </svg>
      <span class="text-[13.5px] text-slate-500">${escapeHtml(text)}</span>
    </div>`;
}

function textoScreenHtml() {
  const offTopicBanner = offTopicNotice ? `
    <div class="mb-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-left wiz-pop">
      <p class="text-[13px] font-medium text-amber-800 leading-snug">${escapeHtml(offTopicNotice)}</p>
    </div>` : '';
  // Reporte real: "no sé si estoy añadiendo una nueva compra al mismo
  // requerimiento o si estoy añadiendo un nuevo requerimiento" -- cart no
  // se vacía al volver acá después de "Agregar esta compra al requerimiento"
  // (ver agregarRequerimiento), así que si ya hay algo en el carrito, esta
  // pantalla en blanco es SIEMPRE para sumar la siguiente compra al MISMO
  // requerimiento. Dejarlo explícito, y separar aparte (con confirmación,
  // ver confirmarNuevoRequerimiento) la acción real de abandonar todo.
  const continuingBanner = (cart.length > 0 && !offTopicNotice) ? `
    <div class="mb-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-left flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-[12.5px] font-semibold text-emerald-800">Agregando la compra ${cart.length + 1} a este requerimiento</p>
        <p class="text-[11.5px] text-emerald-600 mt-0.5 leading-snug">Ya tienes ${cart.length} compra${cart.length === 1 ? '' : 's'} en tu cotización -- lo que describas acá se suma al mismo requerimiento.</p>
      </div>
      <button type="button" data-nuevo-requerimiento-completo class="flex-shrink-0 text-[11px] font-medium text-emerald-700 hover:text-emerald-900 underline whitespace-nowrap">¿Requerimiento distinto?</button>
    </div>` : '';
  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <h1 class="text-[22px] font-semibold text-slate-900 tracking-tight mb-1.5">${CONFIG.introTitle}</h1>
      <p class="text-[14px] text-slate-500 leading-relaxed mb-6">${CONFIG.introSubtitle}</p>
      ${offTopicBanner}
      ${continuingBanner}
      <textarea id="wiz-texto-input" rows="3" placeholder="Escribe acá..."
                class="w-full resize-none bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5 text-[14px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 focus:bg-white transition-all text-left"></textarea>
      <div class="flex items-start justify-between gap-3 mt-2">
        <p id="wiz-analizar-hint" class="flex-1 min-w-0 text-[11.5px] text-slate-400 text-left min-h-[16px]"></p>
        <span id="wiz-texto-count" class="flex-shrink-0 text-[11.5px] text-slate-400 tabular-nums" aria-live="polite">0 / 1.000</span>
      </div>
      <button id="wiz-analizar-btn" type="button"
              class="w-full mt-3 flex items-center justify-center gap-1.5 px-4 py-3 bg-brand-600 hover:bg-brand-700 text-white text-[14px] font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
        <span id="wiz-analizar-icon" class="hidden"></span>
        Analizar
      </button>
      <div class="flex items-center gap-3 mt-4 mb-1"><div class="flex-1 h-px bg-slate-200"></div><span class="text-[10.5px] uppercase tracking-[0.14em] text-slate-400">o</span><div class="flex-1 h-px bg-slate-200"></div></div>
      <button type="button" data-skip-to-manual class="w-full mt-2 py-2.5 text-[13px] font-medium text-brand-700 hover:bg-brand-50 border border-transparent hover:border-brand-100 rounded-lg transition-colors">Completar los datos directamente →</button>
      <button type="button" data-abrir-historial class="lg:hidden w-full mt-3 pt-3 border-t border-slate-100 flex items-center justify-center gap-1.5 text-[11.5px] font-medium text-slate-400 hover:text-brand-600 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        Ver formularios guardados
      </button>
    </div>`;
}

function stepScreenHtml(step) {
  const attr = stepPrimaryAttr(step);
  const meta = stepMeta(step);
  const current = ficha[attr];
  const hasAiPending = current && current.value != null && current.source === 'ai' &&
                        !confirmedAttrs.has(step) && !forceChooseAttrs.has(step);

  if (hasAiPending) {
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <span class="inline-flex items-center text-[10.5px] font-semibold text-brand-700 bg-brand-50 border border-brand-100 rounded-full px-2.5 py-1 mb-3">Sugerido por IA</span>
        <h2 class="text-[22px] font-semibold text-brand-800 tracking-tight mb-4">${stepLabel(step)}</h2>
        <p class="text-[14px] text-slate-500 mb-1">Vimos que necesitas</p>
        <p class="text-[26px] font-semibold text-slate-900 tracking-tight mb-6">${escapeHtml(attrValueText(attr, current.value))}</p>
        <div class="flex gap-2">
          <button type="button" data-confirm="${step}" class="flex-1 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors">Sí, es correcto</button>
          <button type="button" data-choose="${step}" class="px-4 py-2.5 bg-white border border-slate-200 hover:border-brand-300 text-slate-600 text-[13.5px] font-medium rounded-lg transition-colors">Elegir otro</button>
        </div>
      </div>`;
  }

  const notice = (CORE_STEPS.indexOf(step) === 0 && clarifyNotice) ? `
    <div class="mb-3.5 px-3.5 py-3 bg-amber-50 border border-amber-200 rounded-xl wiz-pop">
      <p class="text-[13px] font-medium text-amber-800 leading-snug">${escapeHtml(clarifyNotice.message || 'No pudimos determinar algunos datos del texto.')}</p>
      ${clarifyNotice.question ? `<p class="text-[12px] text-amber-700 mt-1">${escapeHtml(clarifyNotice.question)}</p>` : ''}
    </div>` : '';

  const logical = (CONFIG.logicalSteps || {})[step];
  const secondaryHtml = logical ? secondaryAttrInputHtml(logical) : '';

  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-7 shadow-sm">
      <div class="flex items-center gap-2.5">
        <span class="step-badge">${CORE_STEPS.indexOf(step) + 1}</span>
        <p class="text-[11px] font-semibold text-brand-600 uppercase tracking-wide">${stepLabel(step)}</p>
        <span class="ml-auto text-[11px] text-slate-400">Paso ${CORE_STEPS.indexOf(step) + 1} de ${CORE_STEPS.length}</span>
      </div>
      <p class="step-title">${pickerCaption(step, meta)}</p>
      ${notice}
      ${controlHtml(step, attr, meta)}
      ${secondaryHtml}
    </div>`;
}

function secondaryAttrInputHtml(logical) {
  const secAttr = logical.secondaryAttr;
  const current = ficha[secAttr]?.value;
  return `
    <div class="mt-4 pt-4 border-t border-slate-100">
      <label class="block text-[11px] text-slate-400 mb-1.5">${escapeHtml(logical.secondaryLabel)}</label>
      <input type="text" data-input="${secAttr}" autocomplete="off"
             placeholder="${escapeHtml(logical.secondaryPlaceholder || '')}"
             value="${current ? escapeHtml(current) : ''}"
             class="w-full text-[13.5px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all" />
      <div class="flex flex-wrap gap-1.5 mt-2 min-h-[22px]" data-chips="${secAttr}"></div>
    </div>`;
}

function pickerCaption(step, meta) {
  if (CORE_STEPS.indexOf(step) === 0) return 'Elige una opción, o escribe la que necesitas:';
  return `Opciones para ${stepLabel(step).toLowerCase()}:`;
}

/* ── Control por tipo de atributo ──────────────────────────────────── */

function controlHtml(step, attr, meta) {
  switch (meta.type) {
    case 'numeric_range':
      return sliderHtml(step, attr, meta);
    case 'enum_multi':
      return multiChipsControlHtml(step, attr, meta);
    case 'boolean':
      return booleanControlHtml(step, attr);
    default: { // enum | dict | free
      const cachedChips = facetsCache[attr];
      return `
        <div class="flex flex-wrap gap-2 mb-3 min-h-[30px]" data-chips="${attr}">
          ${cachedChips ? chipsHtml(cachedChips) : chipsLoadingHtml()}
        </div>
        <input type="text" data-input="${attr}" autocomplete="off"
               placeholder="O escribe el valor y presiona Enter..."
               class="w-full text-[13.5px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all ${cachedChips ? '' : 'hidden'}" />`;
    }
  }
}

function chipsLoadingHtml() {
  return loadingBlockHtml('Buscando sugerencias...');
}

function animateIn(el) {
  if (!el) return;
  el.classList.remove('wiz-pop');
  void el.offsetWidth;
  el.classList.add('wiz-pop');
}

// dropdown=true: lista de filas tipo autocompletar (usada por los
// atributos de diccionario grandes -- procesador exacto, marca, SO, GPU --
// reporte real: "sería mejor una lista donde vaya escribiendo y
// apareciendo coincidencias, tipo dropdown" en vez de una pared de chips
// siempre visible). dropdown=false (default) mantiene el estilo de chips
// en burbuja que ya se usa en los pasos core y los enum fijos chicos.
function chipsHtml(values, { dropdown = false } = {}) {
  if (!values.length) {
    return dropdown ? '' : `<span class="text-[11px] text-slate-300 italic">sin sugerencias -- escribe el valor</span>`;
  }
  const shown = values.slice(0, CHIP_DISPLAY_LIMIT);
  const hidden = values.length - shown.length;
  if (dropdown) {
    const rows = shown.map(v => `
      <button type="button" data-chip="${escapeHtml(v.value)}"
              class="block w-full text-left px-2.5 py-1.5 text-[13px] text-slate-700 hover:bg-brand-50 hover:text-brand-700 rounded-md transition-colors">
        ${escapeHtml(v.value)}
      </button>`).join('');
    const hint = hidden > 0 ? `<p class="text-[10.5px] text-slate-400 italic px-2.5 py-1">+${hidden} más -- sigue escribiendo para acotar</p>` : '';
    return rows + hint;
  }
  const hint = hidden > 0
    ? `<span class="text-[11px] text-slate-400 italic px-1 py-1">+${hidden} más -- escribe para buscar</span>`
    : '';
  return shown.map(v => `
    <button type="button" data-chip="${escapeHtml(v.value)}"
            class="facet-chip text-[11.5px] font-medium border rounded-full px-2.5 py-1 bg-white text-slate-600 border-slate-200 hover:border-brand-300 hover:text-brand-700 transition-colors">
      ${escapeHtml(v.value)}
    </button>`).join('') + hint;
}

// ── enum_multi: chips toggle + botón de confirmación explícito ──────
function multiChipsControlHtml(step, attr, meta) {
  const cachedChips = facetsCache[attr];
  if (!multiDraft[attr]) {
    const existing = ficha[attr]?.value;
    multiDraft[attr] = new Set(Array.isArray(existing) ? existing : (existing ? [existing] : []));
  }
  return `
    <div class="flex flex-wrap gap-2 mb-3 min-h-[30px]" data-multi-chips="${attr}">
      ${cachedChips ? multiChipsHtml(attr, cachedChips) : chipsLoadingHtml()}
    </div>
    <input type="text" data-multi-input="${attr}" autocomplete="off"
           placeholder="O escribe un valor y presiona Enter para agregarlo..."
           class="w-full text-[13.5px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all ${cachedChips ? '' : 'hidden'}" />
    <button type="button" data-confirm-multi="${step}" class="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed" ${multiDraft[attr].size ? '' : 'disabled'}>Confirmar selección →</button>`;
}

function multiChipsHtml(attr, values) {
  const selected = multiDraft[attr] || new Set();
  if (!values.length) return '<span class="text-[11px] text-slate-300 italic">sin sugerencias -- escribe el valor</span>';
  // Las ya seleccionadas siempre se muestran, aunque el tope las fuera a
  // dejar afuera -- nunca debe "desaparecer" un chip que el usuario ya marcó.
  const selectedFirst = [...values.filter(v => selected.has(v.value)), ...values.filter(v => !selected.has(v.value))];
  const shown = selectedFirst.slice(0, CHIP_DISPLAY_LIMIT);
  const hidden = values.length - shown.length;
  const hint = hidden > 0
    ? `<span class="text-[11px] text-slate-400 italic px-1 py-1">+${hidden} más -- escribe para buscar</span>`
    : '';
  return shown.map(v => {
    const isSel = selected.has(v.value);
    return `
    <button type="button" data-multi-chip="${escapeHtml(v.value)}"
            class="text-[11.5px] font-medium border rounded-full px-2.5 py-1 transition-colors ${isSel ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300 hover:text-brand-700'}">
      ${isSel ? '✓ ' : ''}${escapeHtml(v.value)}
    </button>`;
  }).join('') + hint;
}

// ── numeric_range: slider nativo sobre índices de allowed_steps ─────
function sliderHtml(step, attr, meta) {
  const steps = meta.allowed_steps || [];
  const current = ficha[attr]?.value;
  let idx = steps.indexOf(Array.isArray(current) ? current[0] : current);
  if (idx < 0) idx = Math.floor(steps.length / 2);
  const unit = meta.unit || '';
  return `
    <div class="py-2">
      <p class="text-center text-[26px] font-bold text-brand-700 mb-3" data-slider-output="${attr}">${steps[idx]} ${escapeHtml(unit)}</p>
      <input type="range" min="0" max="${steps.length - 1}" step="1" value="${idx}"
             data-slider="${attr}" data-steps='${JSON.stringify(steps)}'
             class="w-full accent-brand-600" />
      <div class="flex justify-between text-[10.5px] text-slate-400 mt-1">
        <span>${steps[0]} ${escapeHtml(unit)}</span>
        <span>${steps[steps.length - 1]} ${escapeHtml(unit)}</span>
      </div>
    </div>
    <button type="button" data-confirm-slider="${step}" class="w-full mt-2 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors">Confirmar →</button>`;
}

// ── boolean: dos botones ─────────────────────────────────────────────
function booleanControlHtml(step, attr) {
  return `
    <div class="flex gap-2">
      <button type="button" data-bool="${attr}" data-bool-value="true" class="flex-1 py-2.5 bg-white border border-slate-200 hover:border-brand-300 text-slate-700 text-[13.5px] font-medium rounded-lg transition-colors">Sí</button>
      <button type="button" data-bool="${attr}" data-bool-value="false" class="flex-1 py-2.5 bg-white border border-slate-200 hover:border-brand-300 text-slate-700 text-[13.5px] font-medium rounded-lg transition-colors">No</button>
    </div>`;
}

/* ── Detalles opcionales ──────────────────────────────────────────────
   Dos vistas: la lista (resumen compacto de lo ya definido + un aviso con
   lo que falta) y el editor de a uno (editingOptionalAttr, pantalla
   completa, ver más abajo). Antes esto mostraba los ~10 atributos
   opcionales expandidos todos a la vez (una pared de chips hacia abajo,
   varios con consultas reales a la base) -- ahora cada uno se edita en su
   propia pantalla, recién al pedirlo. ────────────────────────────────── */

function hasAttrValue(attr) {
  const v = ficha[attr]?.value;
  return v != null && v !== '';
}

// Una sola tabla, un atributo por fila -- no "una pared de chips" como
// antes (ni tampoco dos secciones separadas, lo definido arriba y lo
// faltante abajo): todo en el mismo lugar, orden consistente con
// core_order/schema, para que escale solo a categorías futuras sin
// necesitar una taxonomía de "grupos de atributos" por categoría que hoy
// el schema no tiene.
function attrTableRowHtml(attr) {
  const current = ficha[attr];
  const hasValue = hasAttrValue(attr);
  return `
    <div class="flex items-center gap-3 px-3.5 py-2.5 ${hasValue ? '' : 'bg-amber-50/40'}">
      <p class="text-[11px] text-slate-500 min-w-[128px] flex-shrink-0">${ATTR_LABELS[attr]}</p>
      ${hasValue ? `
        <p class="text-[12.5px] font-medium text-slate-700 flex-1 truncate">${escapeHtml(attrValueText(attr, current.value))} ${badgeFor(current.source)}</p>
        <button type="button" data-edit-optional="${attr}" class="text-[11px] text-brand-600 hover:text-brand-700 flex-shrink-0">cambiar</button>
      ` : `
        <p class="text-[12px] text-slate-300 italic flex-1">sin especificar</p>
        <button type="button" data-edit-optional="${attr}" class="text-[11px] font-medium text-amber-600 hover:text-amber-700 flex-shrink-0">+ definir</button>
      `}
    </div>`;
}

function detallesScreenHtml() {
  const unsetAttrs = OPTIONAL_ATTRS.filter(a => !hasAttrValue(a));

  const unsetNotice = unsetAttrs.length ? `
    <div class="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
      <svg class="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>
      <p class="text-[12px] text-amber-800 leading-snug">Lo que quede sin especificar (resaltado abajo) podría llegarte con distintos valores u opciones en la oferta -- distintas marcas, sistemas operativos, etc.</p>
    </div>` : '';

  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <p class="text-[11px] font-semibold text-brand-600 uppercase tracking-wide mb-1">Detalles opcionales</p>
      <p class="text-[13px] text-slate-400 mb-3">Puedes omitir cualquiera de estos y continuar.</p>
      ${unsetNotice}
      <div class="border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
        ${OPTIONAL_ATTRS.map(attrTableRowHtml).join('')}
      </div>
      <button type="button" data-finish-optional class="w-full mt-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors">Continuar</button>
    </div>`;
}

// ── Editor de un solo atributo opcional, pantalla completa ──────────────
// procesador_principal es el único atributo de diccionario que de verdad
// debe quedar como UN modelo exacto -- el resto (marca, SO, GPU...) sí
// admite más de un valor en la ficha, igual que ya acepta el extractor de
// IA (ver MULTI_VALUE_RULE_TEXT en agents/computadores_rules.py: "Atributos
// que admiten lista de opciones"). El editor manual no lo permitía --
// reporte real: "en todos estos atributos no me deja seleccionar más de
// uno para la búsqueda".
const SINGLE_VALUE_ONLY_DICT_ATTRS = new Set(['procesador_principal']);

// "Otro" es un valor real y necesario en el esquema (el extractor de IA lo
// usa para clasificar texto que no describe ningún computador -- ver
// handleOffTopicProduct), pero nunca debe ofrecerse como opción elegible a
// mano: no tiene sentido que la persona elija a propósito "no es un
// computador" desde los chips del paso. Si igual llega a fijarse (por acá
// o por la IA), el wizard corta el flujo apenas se detecta.
const HIDDEN_PICKER_VALUES = { tipo_equipo: new Set(['Otro']) };

// Reutiliza los mismos controles por tipo que ya usan los pasos core
// (booleanControlHtml/sliderHtml/multiChipsControlHtml son genéricos por
// atributo, no por "paso" -- el parámetro step que piden se resuelve con
// stepPrimaryAttr, que no hace nada si no es una key de CONFIG.logicalSteps,
// así que pasar el propio attr como "step" es seguro).
function optionalAttrEditControlHtml(attr, meta) {
  if (meta.type === 'boolean') return booleanControlHtml(attr, attr);
  if (meta.type === 'numeric_range') return numericOptionalControlHtml(attr, meta);
  if (meta.type === 'enum_multi') return multiChipsControlHtml(attr, attr, meta);
  if (meta.values) {
    // Fijo (enum chico, ej. tecnología RAM): ya viene completo en el
    // schema, sin red ni espera -- admite varios valores igual que
    // linea_procesador, solo que la lista completa es chica así que no
    // hace falta buscar escribiendo (reutiliza multiChipsControlHtml tal
    // cual, no inspecciona meta.type).
    facetsCache[attr] = facetsCache[attr] || meta.values.map(v => ({ value: v, count: null }));
    return multiChipsControlHtml(attr, attr, meta);
  }
  if (meta.type === 'dict' && !SINGLE_VALUE_ONLY_DICT_ATTRS.has(attr)) {
    // Diccionario grande y multi-valor (marca, SO, GPU): dropdown de a uno
    // que se van agregando a una selección, ver multiDropdownControlHtml.
    return multiDropdownControlHtml(attr, meta);
  }
  // Diccionario de valor único (procesador exacto) o texto libre: dropdown
  // flotante mientras se escribe (reporte real: "sería mejor una lista
  // donde vaya escribiendo y apareciendo coincidencias, tipo dropdown" en
  // vez de la pared de chips que había antes).
  const current = ficha[attr]?.value;
  return `
    <div class="relative">
      <input type="text" data-input="${attr}" autocomplete="off"
             placeholder="Escribe para buscar..."
             value="${current && !Array.isArray(current) ? escapeHtml(current) : ''}"
             class="w-full text-[14px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all" />
      <div class="hidden absolute z-20 left-0 right-0 mt-1.5 bg-white border border-slate-200 rounded-lg shadow-lg max-h-[210px] overflow-y-auto p-1.5" data-chips="${attr}" data-dropdown></div>
    </div>`;
}

// ── Dropdown con selección múltiple (marca, SO, GPU en el editor manual) ──
// Chips ya seleccionados arriba (removibles), input+dropdown abajo para
// agregar más, botón de confirmación explícito -- mismo espíritu que
// multiChipsControlHtml, pero con las opciones disponibles en un dropdown
// flotante (catálogos grandes) en vez de una pared siempre visible.
function multiDropdownControlHtml(attr, meta) {
  if (!multiDraft[attr]) {
    const existing = ficha[attr]?.value;
    multiDraft[attr] = new Set(Array.isArray(existing) ? existing : (existing ? [existing] : []));
  }
  return `
    <div class="flex flex-wrap gap-1.5 mb-2.5 min-h-[28px]" data-multi-dropdown-selected="${attr}">
      ${multiDropdownSelectedHtml(attr)}
    </div>
    <div class="relative">
      <input type="text" data-multi-dropdown-input="${attr}" autocomplete="off"
             placeholder="Escribe para buscar y agregar..."
             class="w-full text-[13.5px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all" />
      <div class="hidden absolute z-20 left-0 right-0 mt-1.5 bg-white border border-slate-200 rounded-lg shadow-lg max-h-[200px] overflow-y-auto p-1.5" data-multi-dropdown-list="${attr}"></div>
    </div>
    <button type="button" data-multi-dropdown-confirm="${attr}" class="w-full mt-2.5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed" ${multiDraft[attr].size ? '' : 'disabled'}>Confirmar selección →</button>`;
}

function multiDropdownSelectedHtml(attr) {
  const selected = [...(multiDraft[attr] || [])];
  if (!selected.length) return '<span class="text-[11px] text-slate-300 italic">sin selección todavía</span>';
  return selected.map(v => `
    <span class="inline-flex items-center gap-1 text-[11.5px] font-medium bg-brand-50 text-brand-700 border border-brand-200 rounded-full pl-2.5 pr-1.5 py-1">
      ${escapeHtml(v)}
      <button type="button" data-multi-dropdown-remove="${escapeHtml(v)}" data-multi-dropdown-attr="${attr}" class="hover:text-brand-900">
        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </span>`).join('');
}

function filterMultiDropdown(attr, query) {
  const list = screenEl.querySelector(`[data-multi-dropdown-list="${attr}"]`);
  if (!list) return;
  const q = query.trim().toLowerCase();
  const selected = multiDraft[attr] || new Set();
  const pool = validValuesCache[attr] || (facetsCache[attr] || []).map(v => v.value);
  const filtered = q
    ? pool.filter(v => v.toLowerCase().includes(q) && !selected.has(v)).slice(0, CHIP_DISPLAY_LIMIT)
    : [];
  if (!filtered.length) { list.classList.add('hidden'); list.innerHTML = ''; return; }
  list.innerHTML = filtered.map(v => `
    <button type="button" data-multi-dropdown-add="${escapeHtml(v)}" data-multi-dropdown-add-attr="${attr}"
            class="block w-full text-left px-2.5 py-1.5 text-[13px] text-slate-700 hover:bg-brand-50 hover:text-brand-700 rounded-md transition-colors">
      ${escapeHtml(v)}
    </button>`).join('');
  list.classList.remove('hidden');
}

function refreshMultiDropdownSelected(attr) {
  const selEl = screenEl.querySelector(`[data-multi-dropdown-selected="${attr}"]`);
  if (selEl) selEl.innerHTML = multiDropdownSelectedHtml(attr);
  const confirmBtn = screenEl.querySelector(`[data-multi-dropdown-confirm="${attr}"]`);
  if (confirmBtn) confirmBtn.disabled = (multiDraft[attr] || new Set()).size === 0;
}

// ── numeric_range en el editor manual: valor único (slider, como siempre)
// o un rango -- reporte real: "rangos en numéricos" no estaba disponible
// acá, aunque el extractor de IA ya puede guardar {min,max} para estos
// atributos (ver MULTI_VALUE_RULE_TEXT). Un botón alterna entre ambos.
function numericOptionalControlHtml(attr, meta) {
  const current = ficha[attr]?.value;
  const isRange = current && typeof current === 'object' && !Array.isArray(current);
  if (!isRange) {
    return sliderHtml(attr, attr, meta) + `
      <button type="button" data-use-range="${attr}" class="w-full mt-2 text-[11.5px] text-slate-400 hover:text-brand-600 transition-colors">+ usar un rango en vez de un valor único</button>`;
  }
  const steps = meta.allowed_steps || [];
  const unit = meta.unit || '';
  const minIdx = Math.max(0, steps.indexOf(current.min) >= 0 ? steps.indexOf(current.min) : 0);
  const maxIdx = Math.max(0, steps.indexOf(current.max) >= 0 ? steps.indexOf(current.max) : steps.length - 1);
  const optList = (selectedIdx) => steps.map((s, i) => `<option value="${i}" ${i === selectedIdx ? 'selected' : ''}>${s} ${escapeHtml(unit)}</option>`).join('');
  return `
    <div class="flex items-center gap-2.5 py-1">
      <div class="flex-1">
        <label class="block text-[10.5px] text-slate-400 mb-1">Desde</label>
        <div class="relative">
          <select data-range-min="${attr}" data-range-steps='${JSON.stringify(steps)}' class="appearance-none w-full text-[13px] font-medium bg-slate-50 border border-slate-200 rounded-lg pl-2.5 pr-7 py-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500">${optList(minIdx)}</select>
          <svg class="w-3 h-3 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
        </div>
      </div>
      <span class="text-slate-300 mt-4">–</span>
      <div class="flex-1">
        <label class="block text-[10.5px] text-slate-400 mb-1">Hasta</label>
        <div class="relative">
          <select data-range-max="${attr}" data-range-steps='${JSON.stringify(steps)}' class="appearance-none w-full text-[13px] font-medium bg-slate-50 border border-slate-200 rounded-lg pl-2.5 pr-7 py-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-500">${optList(maxIdx)}</select>
          <svg class="w-3 h-3 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
        </div>
      </div>
    </div>
    <button type="button" data-confirm-range="${attr}" class="w-full mt-2.5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors">Confirmar rango →</button>
    <button type="button" data-use-range="${attr}" data-use-single class="w-full mt-1.5 text-[11.5px] text-slate-400 hover:text-brand-600 transition-colors">usar un valor único en vez de un rango</button>`;
}

function optionalAttrEditScreenHtml(attr) {
  const meta = SCHEMA.attributes[attr];
  const hasValue = hasAttrValue(attr);
  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <div class="flex items-center gap-2 mb-4">
        <button type="button" data-back-optional aria-label="Volver"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-brand-600 hover:bg-slate-50 transition-colors flex-shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <p class="text-[13px] font-semibold text-slate-700 flex-1">${ATTR_LABELS[attr]}</p>
        ${hasValue ? `<button type="button" data-clear-optional="${attr}" class="text-[11px] text-slate-400 hover:text-red-500 flex-shrink-0">quitar valor</button>` : ''}
      </div>
      ${optionalAttrEditControlHtml(attr, meta)}
    </div>`;
}

/* ── Resumen ────────────────────────────────────────────────────────── */

function resumenScreenHtml() {
  const coreChips = CORE_STEPS.map(step => {
    const attr = stepPrimaryAttr(step);
    const v = ficha[attr]?.value;
    return (v != null && v !== '')
      ? `<span class="inline-flex items-center gap-1 text-[12px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2.5 py-1">${escapeHtml(attrValueText(attr, v))}</span>`
      : '';
  }).filter(Boolean).join(' ');
  const optionalChips = OPTIONAL_ATTRS.map(attr => {
    const v = ficha[attr]?.value;
    if (v == null || v === '') return '';
    return `<span class="inline-flex items-center gap-1 text-[11px] font-medium bg-slate-50 text-slate-600 border border-slate-200 rounded-full px-2.5 py-1">${ATTR_LABELS[attr]}: ${escapeHtml(attrValueText(attr, v))}</span>`;
  }).filter(Boolean).join(' ');

  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <p class="text-[11px] font-semibold text-emerald-600 uppercase tracking-wide mb-3">✓ Compra lista para agregar</p>
      <div class="flex flex-wrap gap-1.5 mb-2">${coreChips}</div>
      ${optionalChips ? `<div class="flex flex-wrap gap-1.5 mb-4">${optionalChips}</div>` : ''}

      <div class="flex items-center justify-between gap-4 border border-slate-200 rounded-xl px-4 py-3 mb-4 bg-slate-50/60">
        <div class="min-w-0">
          <p class="text-[13px] font-semibold text-slate-800">Cantidad requerida</p>
          <p class="text-[11.5px] text-slate-500 leading-snug">Unidades de esta compra. Aparece en el documento y en el total estimado.</p>
        </div>
        <input type="number" min="1" step="1" inputmode="numeric" value="${draftCantidad}" data-cantidad-input aria-label="Cantidad requerida"
               class="w-24 flex-shrink-0 text-right font-semibold" />
      </div>

      <div id="wiz-price-panel-full" class="mb-4"></div>

      <button type="button" data-agregar class="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-[13.5px] font-semibold rounded-xl transition-colors mb-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        Agregar esta compra al requerimiento
      </button>
      <button type="button" data-nuevo-requerimiento class="w-full text-[12px] text-slate-400 hover:text-brand-600 py-1 transition-colors">Descartar esta compra y empezar de nuevo</button>
    </div>`;
}

/* ── Eventos de la pantalla activa ────────────────────────────────────── */

function bindScreenEvents() {
  const analizarBtn = document.getElementById('wiz-analizar-btn');
  if (analizarBtn) analizarBtn.addEventListener('click', analizar);
  const textoInput = document.getElementById('wiz-texto-input');
  if (textoInput) {
    textoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analizar();
    });
    textoInput.focus();
  }
  const skipToManual = screenEl.querySelector('[data-skip-to-manual]');
  if (skipToManual) skipToManual.addEventListener('click', () => {
    schemaReady.then(() => { showingTextScreen = false; renderScreen(); });
  });
  const nuevoRequerimientoCompleto = screenEl.querySelector('[data-nuevo-requerimiento-completo]');
  if (nuevoRequerimientoCompleto) nuevoRequerimientoCompleto.addEventListener('click', confirmarNuevoRequerimiento);

  screenEl.querySelectorAll('[data-edit-optional]').forEach(btn => {
    btn.addEventListener('click', () => { editingOptionalAttr = btn.dataset.editOptional; renderScreen(); });
  });
  screenEl.querySelectorAll('[data-back-optional]').forEach(btn => {
    btn.addEventListener('click', () => { editingOptionalAttr = null; renderScreen(); });
  });
  screenEl.querySelectorAll('[data-clear-optional]').forEach(btn => {
    btn.addEventListener('click', () => clearOptionalAttr(btn.dataset.clearOptional));
  });
  screenEl.querySelectorAll('[data-finish-optional]').forEach(btn => {
    btn.addEventListener('click', () => advanceStep());
  });
  screenEl.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', () => onAttrConfirmed(btn.dataset.confirm));
  });
  screenEl.querySelectorAll('[data-choose]').forEach(btn => {
    btn.addEventListener('click', () => {
      forceChooseAttrs.add(btn.dataset.choose);
      renderScreen();
      refreshFacetsFor([btn.dataset.choose]);
    });
  });
  screenEl.querySelectorAll('[data-chip]').forEach(btn => {
    const container = btn.closest('[data-chips]');
    const attr = container ? container.dataset.chips : null;
    if (attr) btn.addEventListener('click', () => pickValue(attr, btn.dataset.chip));
  });
  screenEl.querySelectorAll('[data-input]').forEach(input => {
    const attr = input.dataset.input;
    input.addEventListener('focus', () => ensureFacetsLoaded(attr), { once: true });
    input.addEventListener('input', () => filterChipsFor(attr, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) pickValue(attr, input.value.trim());
    });

    // Modo dropdown (ver chipsHtml/filterChipsFor): el contenedor de
    // sugerencias solo se muestra mientras el campo tiene foco Y hay algo
    // escrito -- se esconde al desenfocar (con un pequeño delay para que
    // un click en una sugerencia alcance a registrarse antes del blur).
    const chipsContainer = screenEl.querySelector(`[data-chips="${attr}"]`);
    if (chipsContainer && chipsContainer.hasAttribute('data-dropdown')) {
      input.addEventListener('focus', () => {
        if (input.value.trim()) filterChipsFor(attr, input.value);
      });
      input.addEventListener('blur', () => {
        setTimeout(() => chipsContainer.classList.add('hidden'), 150);
      });
    }
  });

  // enum_multi
  screenEl.querySelectorAll('[data-multi-chip]').forEach(btn => {
    const container = btn.closest('[data-multi-chips]');
    const attr = container ? container.dataset.multiChips : null;
    if (!attr) return;
    btn.addEventListener('click', () => {
      const val = btn.dataset.multiChip;
      const set = multiDraft[attr];
      set.has(val) ? set.delete(val) : set.add(val);
      container.innerHTML = multiChipsHtml(attr, facetsCache[attr] || []);
      bindMultiChipButtons(container);
      const confirmBtn = screenEl.querySelector(`[data-confirm-multi]`);
      if (confirmBtn) confirmBtn.disabled = set.size === 0;
    });
  });
  screenEl.querySelectorAll('[data-multi-input]').forEach(input => {
    const attr = input.dataset.multiInput;
    input.addEventListener('input', () => filterMultiChipsFor(attr, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        multiDraft[attr].add(input.value.trim());
        input.value = '';
        const container = screenEl.querySelector(`[data-multi-chips="${attr}"]`);
        if (container) { container.innerHTML = multiChipsHtml(attr, facetsCache[attr] || []); bindMultiChipButtons(container); }
        const confirmBtn = screenEl.querySelector(`[data-confirm-multi]`);
        if (confirmBtn) confirmBtn.disabled = false;
      }
    });
  });
  screenEl.querySelectorAll('[data-confirm-multi]').forEach(btn => {
    btn.addEventListener('click', () => {
      const step = btn.dataset.confirmMulti;
      const attr = stepPrimaryAttr(step);
      const arr = Array.from(multiDraft[attr] || []);
      if (!arr.length) return;
      pickValue(attr, arr.length === 1 ? arr[0] : arr);
    });
  });

  // numeric_range
  screenEl.querySelectorAll('[data-slider]').forEach(slider => {
    const attr = slider.dataset.slider;
    const steps = JSON.parse(slider.dataset.steps);
    const output = screenEl.querySelector(`[data-slider-output="${attr}"]`);
    const meta = SCHEMA.attributes[attr];
    slider.addEventListener('input', () => {
      if (output) output.textContent = `${steps[Number(slider.value)]} ${meta.unit || ''}`.trim();
    });
  });
  screenEl.querySelectorAll('[data-confirm-slider]').forEach(btn => {
    btn.addEventListener('click', () => {
      const step = btn.dataset.confirmSlider;
      const attr = stepPrimaryAttr(step);
      const slider = screenEl.querySelector(`[data-slider="${attr}"]`);
      const steps = JSON.parse(slider.dataset.steps);
      pickValue(attr, steps[Number(slider.value)]);
    });
  });

  // numeric_range opcional: alternar valor único / rango (ver
  // numericOptionalControlHtml) -- re-pintar la pantalla entera es seguro
  // acá (editor de un solo atributo, sin nada async compitiendo).
  screenEl.querySelectorAll('[data-use-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      const attr = btn.dataset.useRange;
      if (btn.hasAttribute('data-use-single')) rangeModeDraft.delete(attr);
      else rangeModeDraft.add(attr);
      renderScreen();
    });
  });
  screenEl.querySelectorAll('[data-confirm-range]').forEach(btn => {
    btn.addEventListener('click', () => {
      const attr = btn.dataset.confirmRange;
      const minSel = screenEl.querySelector(`[data-range-min="${attr}"]`);
      const maxSel = screenEl.querySelector(`[data-range-max="${attr}"]`);
      if (!minSel || !maxSel) return;
      const steps = JSON.parse(minSel.dataset.rangeSteps);
      const a = steps[Number(minSel.value)];
      const b = steps[Number(maxSel.value)];
      rangeModeDraft.delete(attr);
      pickValue(attr, a <= b ? { min: a, max: b } : { min: b, max: a });
    });
  });

  // Dropdown con selección múltiple (marca, SO, GPU en el editor manual --
  // ver multiDropdownControlHtml). Agregar/quitar un ítem se maneja por
  // delegación persistente en bindGlobalPriceDelegation (la lista de
  // sugerencias y los chips seleccionados se re-pintan fuera de este ciclo
  // de bindeo, igual que las transacciones).
  screenEl.querySelectorAll('[data-multi-dropdown-input]').forEach(input => {
    const attr = input.dataset.multiDropdownInput;
    input.addEventListener('focus', () => {
      ensureFacetsLoaded(attr);
      if (input.value.trim()) filterMultiDropdown(attr, input.value);
    });
    input.addEventListener('input', () => filterMultiDropdown(attr, input.value));
    input.addEventListener('blur', () => {
      const list = screenEl.querySelector(`[data-multi-dropdown-list="${attr}"]`);
      setTimeout(() => { if (list) list.classList.add('hidden'); }, 150);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        multiDraft[attr].add(input.value.trim());
        input.value = '';
        refreshMultiDropdownSelected(attr);
        filterMultiDropdown(attr, '');
      }
    });
  });
  screenEl.querySelectorAll('[data-multi-dropdown-confirm]').forEach(btn => {
    btn.addEventListener('click', () => {
      const attr = btn.dataset.multiDropdownConfirm;
      const arr = Array.from(multiDraft[attr] || []);
      if (!arr.length) return;
      pickValue(attr, arr.length === 1 ? arr[0] : arr);
    });
  });

  // boolean (paso core)
  // boolean -- genérico por atributo (paso core o editor de detalle
  // opcional, pickValue ya distingue el caso, ver su doc).
  screenEl.querySelectorAll('[data-bool]').forEach(btn => {
    btn.addEventListener('click', () => pickValue(btn.dataset.bool, btn.dataset.boolValue === 'true'));
  });

  const agregarBtn = screenEl.querySelector('[data-agregar]');
  if (agregarBtn) agregarBtn.addEventListener('click', agregarRequerimiento);
  const nuevoBtn = screenEl.querySelector('[data-nuevo-requerimiento]');
  if (nuevoBtn) nuevoBtn.addEventListener('click', () => empezarNuevoRequerimiento());
}

function bindMultiChipButtons(container) {
  if (!container) return;
  const attr = container.dataset.multiChips;
  container.querySelectorAll('[data-multi-chip]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.multiChip;
      const set = multiDraft[attr];
      set.has(val) ? set.delete(val) : set.add(val);
      container.innerHTML = multiChipsHtml(attr, facetsCache[attr] || []);
      bindMultiChipButtons(container);
      const confirmBtn = screenEl.querySelector(`[data-confirm-multi]`);
      if (confirmBtn) confirmBtn.disabled = set.size === 0;
    });
  });
}

function bindChipButtons(container) {
  if (!container) return;
  container.querySelectorAll('[data-chip]').forEach(btn => {
    const c = btn.closest('[data-chips]');
    const attr = c ? c.dataset.chips : null;
    if (attr) btn.addEventListener('click', () => pickValue(attr, btn.dataset.chip));
  });
}

function refreshFacetsFor(steps) {
  steps.forEach(step => {
    const attr = stepPrimaryAttr(step);
    const meta = SCHEMA.attributes[attr];
    if (meta.type === 'boolean' || meta.type === 'free') return; // sin chips que buscar
    apiFetch(`/api/categories/${CONFIG.slug}/facets/${SESSION_ID}?attr=${encodeURIComponent(attr)}`, { headers: _headers() })
      .then(r => r && r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const raw = data.values || [];
        const hidden = HIDDEN_PICKER_VALUES[attr];
        facetsCache[attr] = raw
          .map(v => (typeof v === 'string' ? { value: v, count: null } : v))
          .filter(v => !hidden || !hidden.has(v.value));
        if (meta.type === 'enum_multi') {
          const container = screenEl.querySelector(`[data-multi-chips="${attr}"]`);
          if (container) {
            container.innerHTML = multiChipsHtml(attr, facetsCache[attr]);
            animateIn(container);
            bindMultiChipButtons(container);
            const input = screenEl.querySelector(`[data-multi-input="${attr}"]`);
            if (input) input.classList.remove('hidden');
          }
        } else {
          const container = screenEl.querySelector(`[data-chips="${attr}"]`);
          if (container) {
            container.innerHTML = chipsHtml(facetsCache[attr]);
            animateIn(container);
            bindChipButtons(container);
            const input = container.parentElement && container.parentElement.querySelector(`[data-input="${attr}"]`);
            if (input) input.classList.remove('hidden');
          }
        }
      })
      .catch(() => {});
  });
}

// Carga perezosa de facets para un solo atributo (detalles opcionales,
// secondaryAttr) -- a diferencia de refreshFacetsFor (varios atributos a
// la vez, usado en los pasos core que sí bloquean el avance), esto se
// dispara recién al enfocar un campo puntual, para no pagar el costo de
// varias consultas lentas en paralelo con solo entrar a la pantalla.
const _facetsLoading = new Set();
function ensureFacetsLoaded(attr) {
  if (facetsCache[attr] !== undefined || _facetsLoading.has(attr)) return;
  const meta = SCHEMA.attributes[attr];
  if (!meta || meta.type === 'boolean' || meta.type === 'free') return;
  _facetsLoading.add(attr);
  apiFetch(`/api/categories/${CONFIG.slug}/facets/${SESSION_ID}?attr=${encodeURIComponent(attr)}`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      const raw = data.values || [];
      facetsCache[attr] = raw.map(v => (typeof v === 'string' ? { value: v, count: null } : v));
      const container = screenEl.querySelector(`[data-chips="${attr}"]`);
      if (container) {
        container.innerHTML = chipsHtml(facetsCache[attr]);
        animateIn(container);
        bindChipButtons(container);
      }
    })
    .catch(() => {})
    .finally(() => _facetsLoading.delete(attr));
}

function filterChipsFor(attr, query) {
  const container = screenEl.querySelector(`[data-chips="${attr}"]`);
  if (!container) return;
  const isDropdown = container.hasAttribute('data-dropdown');
  const q = query.trim().toLowerCase();
  let base = facetsCache[attr] || [];
  if (validValuesCache[attr] && q) {
    base = validValuesCache[attr]
      .filter(v => v.toLowerCase().includes(q))
      .slice(0, CHIP_DISPLAY_LIMIT)
      .map(v => ({ value: v, count: null }));
  } else if (q) {
    base = base.filter(v => v.value.toLowerCase().includes(q));
  }
  container.innerHTML = chipsHtml(base, { dropdown: isDropdown });
  if (isDropdown) container.classList.toggle('hidden', !q || base.length === 0);
  animateIn(container);
  bindChipButtons(container);
}

// ── Igual que filterChipsFor pero para el control enum_multi (los chips
// de "línea de procesador" etc.) -- buscar sobre la lista completa
// (validValuesCache) en vez de dejar siempre la pared fija de facets. ──
function filterMultiChipsFor(attr, query) {
  const container = screenEl.querySelector(`[data-multi-chips="${attr}"]`);
  if (!container) return;
  const q = query.trim().toLowerCase();
  let base = facetsCache[attr] || [];
  if (validValuesCache[attr] && q) {
    base = validValuesCache[attr]
      .filter(v => v.toLowerCase().includes(q))
      .slice(0, CHIP_DISPLAY_LIMIT)
      .map(v => ({ value: v, count: null }));
  } else if (q) {
    base = base.filter(v => v.value.toLowerCase().includes(q));
  }
  container.innerHTML = multiChipsHtml(attr, base);
  animateIn(container);
  bindMultiChipButtons(container);
}

/* ── Precio (resumen) ──────────────────────────────────────────────── */

function setAgregarEnabled(enabled) {
  const btn = screenEl.querySelector('[data-agregar]');
  if (!btn) return;
  btn.disabled = !enabled;
  btn.classList.toggle('opacity-50', !enabled);
  btn.classList.toggle('cursor-not-allowed', !enabled);
}

function loadPrice() {
  // El primer cálculo de precio del proceso puede demorar bastante (carga en
  // frío de catálogos/tablas) -- sin este estado el panel se ve simplemente
  // vacío mientras tanto, como si no hubiera pasado nada. Mientras tanto,
  // "Agregar a la cotización" queda deshabilitado -- si el usuario agregara
  // el requerimiento antes de que llegue el precio, el carrito guardaría ese
  // ítem con precio null para siempre (nunca se vuelve a recalcular).
  setAgregarEnabled(false);
  const panel = document.getElementById('wiz-price-panel-full');
  if (panel) {
    panel.innerHTML = priceSkeletonHtml('Calculando precio estimado...');
  }
  apiFetch(`/api/categories/${CONFIG.slug}/price/${SESSION_ID}`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      priceData = data?.price_data || null;
      cmPriceData = data?.cm_price_data || null;
      cmState.page = 1;
      renderPricePanel();
    })
    .catch(() => {})
    .finally(() => setAgregarEnabled(true));
}

// ── Panel de precio: Convenio Marco (si existe) es la opción destacada --
// es el canal de compra preferente cuando hay catálogo vigente que calce.
// Compra Ágil (histórico) queda como respaldo secundario, con su propio
// listado de transacciones reales detrás (ver bindGlobalPriceDelegation). Si la
// categoría no soporta CM, o CM no tiene match para esta especificación
// exacta, Compra Ágil vuelve a ser la opción principal -- nunca se oculta
// en silencio (ver cmNotFoundHtml). ──────────────────────────────────────
function renderPricePanel() {
  const panel = document.getElementById('wiz-price-panel-full');
  if (!panel) return;

  const hasCm = CONFIG.supportsConvenioMarco && !!cmPriceData;

  if (!priceData && !hasCm) {
    panel.innerHTML = `
      <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
        <p class="text-[12.5px] text-slate-400">No hay compras registradas para esta combinación de atributos todavía.</p>
      </div>`;
    return;
  }

  let html = '';
  if (hasCm) html += cmBlockHtml(cmPriceData);
  if (priceData) {
    html += caBlockHtml(priceData, !hasCm);
  } else if (hasCm) {
    html += `<p class="text-[11px] text-slate-400 mt-2">Sin compras históricas de Compra Ágil registradas para esta combinación.</p>`;
  }
  if (CONFIG.supportsConvenioMarco && !cmPriceData) {
    html += cmNotFoundHtml();
  }

  panel.innerHTML = html;
}

// Página fija de productos (no "+N más" ni scroll) -- mismo criterio que
// transaccionesPagerHtml, reporte real: "en convenio marco" también debería
// paginarse en vez de cortar el catálogo con un texto "+N productos más".
function cmPagerHtml(allProducts) {
  const totalPages = Math.max(1, Math.ceil(allProducts.length / cmState.pageSize));
  if (totalPages <= 1) return '';
  return `
    <div class="flex items-center justify-between mt-2.5 pt-2.5 border-t border-brand-100">
      <button type="button" data-cm-page-prev ${cmState.page <= 1 ? 'disabled' : ''} class="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-brand-200 bg-white text-brand-700 hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">← Anterior</button>
      <span class="text-[11px] text-brand-500">Página ${cmState.page} de ${totalPages} · ${allProducts.length} productos</span>
      <button type="button" data-cm-page-next ${cmState.page >= totalPages ? 'disabled' : ''} class="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-brand-200 bg-white text-brand-700 hover:bg-brand-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Siguiente →</button>
    </div>`;
}

function cmBlockHtml(cm) {
  const allProducts = cm.products || [];
  const totalPages = Math.max(1, Math.ceil(allProducts.length / cmState.pageSize));
  if (cmState.page > totalPages) cmState.page = totalPages; // ej. el catálogo se achicó al relajar/ajustar un filtro
  const start = (cmState.page - 1) * cmState.pageSize;
  const products = allProducts.slice(start, start + cmState.pageSize);
  const productsHtml = products.map(p => {
    // Siempre se muestra algo acá, aunque el catálogo no traiga precio para
    // este producto puntual -- dejar el span vacío hacía que la tarjeta se
    // viera "cortada" (marca sola, sin precio, como si faltara terminar de
    // cargar) en vez de un dato real pero ausente.
    const priceLabel = p.precio_min_clp != null
      ? (p.precio_max_clp != null && p.precio_max_clp !== p.precio_min_clp
          ? `${formatCLP(conIva(p.precio_min_clp))} – ${formatCLP(conIva(p.precio_max_clp))}`
          : formatCLP(conIva(p.precio_min_clp)))
      : null;
    const key = String(p.id_producto ?? p.url ?? p.nombre ?? Math.random());
    const revisado = isRevisado('cm', key);
    // La tarjeta entera YA NO es un <a> -- antes, tocar cualquier parte
    // (incluso sin querer seleccionar) navegaba de inmediato a Convenio
    // Marco (bug real reportado: "presioné la compra completa pensando que
    // así lo seleccionaba y se abrió la compra"). Ahora: click en la
    // tarjeta = marcar/desmarcar para revisar (palomita visible a la
    // izquierda), y "Ver detalle"/"Ver en Convenio Marco" son acciones
    // aparte, explícitas, que no togglean la selección.
    return `
      <div class="flex items-start gap-2.5 bg-white border ${revisado ? 'border-brand-400 ring-1 ring-brand-200' : 'border-brand-100'} rounded-lg px-3 py-2 hover:border-brand-300 hover:shadow-sm transition-all cursor-pointer" data-cm-card-toggle="${escapeHtml(key)}">
        <div class="mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors ${revisado ? 'bg-brand-600 border-brand-600' : 'border-slate-300'}">
          ${revisado ? '<svg class="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' : ''}
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-[12px] font-medium text-slate-700 leading-snug">${escapeHtml(p.nombre || p.modelo || p.marca || 'Producto Convenio Marco')}</p>
          <div class="flex items-center justify-between mt-1 gap-2">
            <span class="text-[10.5px] text-slate-400 truncate">${escapeHtml(p.marca || '')}</span>
            <span class="text-[12.5px] font-bold ${priceLabel ? 'text-brand-700' : 'text-slate-300 italic font-normal'} flex-shrink-0">${priceLabel || 'Precio no informado'}</span>
          </div>
          <div class="flex items-center gap-1.5 mt-1.5">
            <button type="button" data-cm-detail="${escapeHtml(key)}" class="relative z-10 text-[10.5px] font-medium px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors">Ver detalle →</button>
            ${p.url ? `<a href="${escapeHtml(safeUrl(p.url))}" target="_blank" rel="noopener" class="relative z-10 text-[10.5px] font-medium px-2 py-1 rounded-md border border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100 transition-colors">Ver en Convenio Marco ↗</a>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="rounded-xl border-2 border-brand-200 bg-brand-50/60 p-4 mb-3">
      <div class="flex items-center justify-between mb-1">
        <p class="text-[10.5px] font-bold text-brand-700 uppercase tracking-wide">Convenio Marco vigente</p>
        <span class="text-[10px] font-semibold text-brand-600 bg-white border border-brand-200 rounded-full px-2 py-0.5">Opción recomendada</span>
      </div>
      <p class="text-[24px] font-bold text-brand-800 leading-none mt-1.5 mb-0.5">${formatCLP(conIva(cm.median))}</p>
      <p class="text-[11.5px] text-brand-600 mb-3">rango ${formatCLP(conIva(cm.min))} – ${formatCLP(conIva(cm.max))} · ${escapeHtml(cm.count)} producto${cm.count === 1 ? '' : 's'} disponible${cm.count === 1 ? '' : 's'} · con IVA (catálogo neto + 19 %)</p>
      ${productsHtml ? `<div class="space-y-1.5">${productsHtml}</div>` : ''}
      ${cmPagerHtml(allProducts)}
    </div>`;
}

function cmNotFoundHtml() {
  return `
    <div class="bg-white border border-slate-200 rounded-xl p-3 mt-2">
      <p class="text-[10.5px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Convenio Marco vigente</p>
      <p class="text-[11.5px] text-slate-400">No encontramos un producto de Convenio Marco para esta especificación exacta.</p>
    </div>`;
}

function caBlockHtml(price, isPrimary) {
  const p25 = priceStat(price, 'p25'), median = priceStat(price, 'median'), p75 = priceStat(price, 'p75'), count = price.count;
  const min = p25, max = p75;
  const range = Math.max(max - min, 1);
  const midPct = Math.min(100, Math.max(0, ((median - min) / range) * 100));

  const body = `
    <p class="text-[22px] font-bold ${isPrimary ? 'text-emerald-700' : 'text-slate-700'} leading-none mb-1">${formatCLP(median)}</p>
    <p class="text-[11.5px] text-slate-400 mb-3">precio unitario (mediana), IVA incluido · ${escapeHtml(count)} compra${count === 1 ? '' : 's'}</p>
    <div class="relative h-2 bg-slate-100 rounded-full mb-1.5">
      <div class="absolute h-2 bg-emerald-200 rounded-full" style="left:0%;width:100%"></div>
      <div class="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-emerald-600 rounded-full border-2 border-white shadow" style="left:calc(${midPct}% - 5px)"></div>
    </div>
    <div class="flex items-center justify-between text-[11px] text-slate-400 mb-2.5">
      <span>${formatCLP(min)}</span>
      <span>${formatCLP(max)}</span>
    </div>
    <button type="button" data-ver-transacciones class="w-full flex items-center justify-center gap-1.5 py-2 bg-white hover:bg-brand-50 border border-slate-200 hover:border-brand-300 text-slate-600 hover:text-brand-700 text-[12px] font-semibold rounded-lg transition-colors">${transaccionesState.expanded ? 'Ocultar transacciones ↑' : 'Ver transacciones anteriores →'}</button>
    <div data-transacciones-list class="${transaccionesState.expanded ? '' : 'hidden'} mt-2 space-y-1.5">${transaccionesContentHtml()}</div>`;

  if (isPrimary) {
    return `
      <div class="bg-slate-50 border border-slate-200 rounded-xl p-4">
        <p class="text-[10.5px] font-semibold text-slate-500 uppercase tracking-wide mb-2.5">Estimación (histórico Compra Ágil)</p>
        ${body}
      </div>`;
  }
  return `
    <div class="bg-white border border-slate-200 rounded-xl p-3.5">
      <p class="text-[10.5px] font-semibold text-slate-400 uppercase tracking-wide mb-2">También disponible vía Compra Ágil (histórico)</p>
      ${body}
    </div>`;
}

// Estado del bloque de transacciones GUARDADO FUERA DEL DOM -- renderPricePanel()
// reconstruye el panel completo (innerHTML) cada vez que llega un price_update/
// cm_price_update por SSE (puede pasar justo después de que el usuario ya
// expandió la lista y la cargó), y antes eso la dejaba colapsada otra vez de
// la nada (bug real reportado: "cargó y volvió a aparecer sin mostrar nada").
// Guardando expanded/offers/orden/agrupación/detalle acá, caBlockHtml() los
// lee en cada render y la lista sobrevive al re-render en vez de resetearse.
const transaccionesState = {
  expanded: false, offers: null, loading: false, loadError: false,
  sortBy: 'fecha_desc',    // 'fecha_desc' | 'fecha_asc' | 'precio_desc' | 'precio_asc'
  groupBy: 'none',         // 'none' | 'proveedor' | 'anio'
  page: 1, pageSize: 5, total: 0,
};

// Paginado del catálogo de Convenio Marco (client-side -- category_service.
// estimate_price ya pide el catálogo completo con top_n=200, así que no
// hace falta volver a pedirle nada al backend para pasar de página).
const cmState = { page: 1, pageSize: 5 };

function transaccionKey(o) {
  return String(o.id_oferta_aquiles ?? o.codigo_requerimiento ?? `${o.fecha_modificacion}-${o.precio_unitario_iva}`);
}

// "Proveedor no informado" siempre al final, sin importar el orden elegido
// -- antes aparecían primero porque la API los devuelve ordenados por fecha
// y las compras más recientes son justo las que a veces aún no tienen el
// cruce con la tabla de proveedores hecho (mismo hallazgo de antes).
function sortedOffers(offers) {
  const cmp = {
    fecha_desc:  (a, b) => (b.fecha_modificacion || '').localeCompare(a.fecha_modificacion || ''),
    fecha_asc:   (a, b) => (a.fecha_modificacion || '').localeCompare(b.fecha_modificacion || ''),
    precio_desc: (a, b) => (b.precio_unitario_iva || 0) - (a.precio_unitario_iva || 0),
    precio_asc:  (a, b) => (a.precio_unitario_iva || 0) - (b.precio_unitario_iva || 0),
  }[transaccionesState.sortBy] || (() => 0);
  const conProveedor = offers.filter(o => o.razon_social).sort(cmp);
  const sinProveedor = offers.filter(o => !o.razon_social).sort(cmp);
  return [...conProveedor, ...sinProveedor];
}

// Select nativo pero con mejor terminación visual (flecha propia, borde y
// padding consistentes con el resto del wizard) -- el <select> por defecto
// se veía "poco estilizado" (reporte real), no hacía falta un componente
// custom completo para arreglarlo.
function styledSelectHtml(dataAttr, options, selected) {
  return `
    <div class="relative inline-block">
      <select ${dataAttr} class="appearance-none text-[11px] font-medium bg-white border border-slate-200 rounded-lg pl-2.5 pr-7 py-1.5 text-slate-600 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-colors cursor-pointer">
        ${options.map(([v, l]) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <svg class="w-3 h-3 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
    </div>`;
}

function transaccionesControlsHtml() {
  const sortOptions = [
    ['fecha_desc', 'Más recientes primero'],
    ['fecha_asc', 'Más antiguas primero'],
    ['precio_desc', 'Mayor precio primero'],
    ['precio_asc', 'Menor precio primero'],
  ];
  const groupOptions = [
    ['none', 'Sin agrupar'],
    ['proveedor', 'Agrupar por proveedor'],
    ['anio', 'Agrupar por año'],
  ];
  return `
    <div class="flex items-center flex-wrap gap-2 mb-2.5 pb-2.5 border-b border-slate-100">
      ${styledSelectHtml('data-transacciones-sort', sortOptions, transaccionesState.sortBy)}
      ${styledSelectHtml('data-transacciones-group', groupOptions, transaccionesState.groupBy)}
    </div>`;
}

// Página fija por consulta al servidor (ver loadTransacciones) en vez de
// scroll interno -- con búsquedas de specs comunes el total real puede ser
// miles de filas (reporte real: "al ser muchas, se comprime y queda un
// scroll"), así que la lista siempre muestra como mucho pageSize filas y el
// resto se navega con Anterior/Siguiente.
function transaccionesPagerHtml() {
  const { page, pageSize, total } = transaccionesState;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return '';
  return `
    <div class="flex items-center justify-between mt-3 pt-2.5 border-t border-slate-100">
      <button type="button" data-transacciones-page-prev ${page <= 1 ? 'disabled' : ''} class="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">← Anterior</button>
      <span class="text-[11px] text-slate-400">Página ${page} de ${totalPages} · ${total} transacciones</span>
      <button type="button" data-transacciones-page-next ${page >= totalPages ? 'disabled' : ''} class="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Siguiente →</button>
    </div>`;
}

function transaccionesListInnerHtml(offers) {
  if (!offers.length) return `<p class="text-[11px] text-slate-400 py-1">Sin transacciones detalladas disponibles.</p>`;
  const sorted = sortedOffers(offers);
  const controls = transaccionesControlsHtml();

  if (transaccionesState.groupBy === 'none') {
    return controls + sorted.map(offerRowHtml).join('') + transaccionesPagerHtml();
  }

  const groupKeyFn = transaccionesState.groupBy === 'anio'
    ? (o => o.fecha_modificacion ? o.fecha_modificacion.slice(0, 4) : '__sin_dato__')
    : (o => o.razon_social || '__sin_dato__');
  const sinDatoLabel = transaccionesState.groupBy === 'anio' ? 'Sin fecha' : 'Proveedor no informado';

  const groups = new Map();
  for (const o of sorted) {
    const key = groupKeyFn(o);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  // Años: más reciente primero. Proveedores: alfabético. "Sin dato" siempre al final.
  const keys = [...groups.keys()].filter(k => k !== '__sin_dato__')
    .sort((a, b) => transaccionesState.groupBy === 'anio' ? b.localeCompare(a) : a.localeCompare(b));
  if (groups.has('__sin_dato__')) keys.push('__sin_dato__');

  return controls + keys.map(key => {
    const label = key === '__sin_dato__' ? sinDatoLabel : key;
    const rows = groups.get(key);
    return `
      <div class="mt-2.5 first:mt-0">
        <p class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">${escapeHtml(label)} <span class="font-normal normal-case">(${rows.length})</span></p>
        ${rows.map(offerRowHtml).join('')}
      </div>`;
  }).join('') + transaccionesPagerHtml();
}

// El contenido de [data-transacciones-list] según el estado actual -- lo usa
// tanto caBlockHtml() (primer pintado) como loadTransacciones() (una vez que
// la respuesta llega), para que ambos coincidan exactamente.
function transaccionesContentHtml() {
  if (transaccionesState.offers) return transaccionesListInnerHtml(transaccionesState.offers);
  if (transaccionesState.loading) return `<p class="text-[11px] text-slate-400 py-1">Cargando...</p>`;
  return '';
}

function refreshTransaccionesList() {
  const list = document.querySelector('[data-transacciones-list]');
  if (list) list.innerHTML = transaccionesContentHtml();
}

function loadTransacciones() {
  transaccionesState.loading = true;
  const { page, pageSize } = transaccionesState;
  apiFetch(`/api/categories/${CONFIG.slug}/offers/${SESSION_ID}?page=${page}&page_size=${pageSize}`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => { transaccionesState.offers = data?.offers || []; transaccionesState.total = data?.total || 0; })
    .catch(() => { transaccionesState.offers = []; transaccionesState.total = 0; transaccionesState.loadError = true; })
    .finally(() => {
      transaccionesState.loading = false;
      // Re-consultar el DOM acá (no reusar una referencia capturada antes)
      // -- el panel puede haberse reconstruido entero mientras el fetch
      // estaba en vuelo (ej. llegó un price_update por SSE), y esa
      // referencia vieja ya no sería el nodo visible en pantalla (bug real
      // reportado: "dice que las muestra pero no se ve nada" -- la
      // respuesta llegaba, pero escribía sobre un nodo fantasma).
      const freshList = document.querySelector('[data-transacciones-list]');
      if (freshList) {
        freshList.innerHTML = transaccionesState.loadError
          ? `<p class="text-[11px] text-red-400 py-1">No se pudo cargar el historial.</p>`
          : transaccionesContentHtml();
      }
    });
}

function offerRowHtml(o) {
  // "razon_social" (no "razon_social_ganador") -- price_service.get_offer_rows()
  // ya renombra esa columna al armar la fila (ver services/price_service.py);
  // leer el nombre viejo de columna acá hacía que SIEMPRE saliera vacío,
  // aunque el dato sí viniera. descripcion es la ficha técnica completa del
  // producto -- es el dato más informativo de cada transacción, igual que en
  // el chat legacy (app.js::_renderOfferCards). "Ver detalle" abre el modal
  // (ver OFFER_DETAIL_FIELDS/offerDetailModalHtml) en vez de expandir hacia
  // abajo -- adentro de una lista con scroll quedaba sin espacio (reporte real).
  const key = transaccionKey(o);
  const revisado = isRevisado('ca', key);
  // Igual patrón que la tarjeta de Convenio Marco (cmBlockHtml): clickear
  // la fila marca/desmarca para revisar (palomita visible), "Ver detalle"
  // y "Ver en Compra Ágil" son botones de verdad, aparte, que no togglean
  // la selección (reporte real: los links de solo texto "se ven poco
  // visibles" / poco intuitivos).
  return `
    <div class="flex items-start gap-2.5 border-b border-slate-100 last:border-0 py-2 px-1.5 -mx-1.5 hover:bg-slate-50 rounded-lg cursor-pointer transition-colors" data-offer-key="${escapeHtml(key)}" data-offer-row-toggle>
      <div class="mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors ${revisado ? 'bg-brand-600 border-brand-600' : 'border-slate-300'}">
        ${revisado ? '<svg class="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>' : ''}
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-2">
          <p class="text-[11.5px] font-medium text-slate-700 truncate">${escapeHtml(o.razon_social || 'Proveedor no informado')}</p>
          <span class="text-[12px] font-bold text-emerald-700 flex-shrink-0">${formatCLP(o.precio_unitario_iva)}</span>
        </div>
        <p class="tx-desc text-[11px] text-slate-500 leading-snug mt-0.5">${escapeHtml(o.descripcion || '')}</p>
        <p class="text-[10.5px] text-slate-400 mt-0.5">${escapeHtml(o.codigo_requerimiento || '')}${o.fecha_modificacion ? ' · ' + escapeHtml(o.fecha_modificacion) : ''}</p>
        <div class="flex items-center gap-1.5 mt-1.5">
          <button type="button" data-offer-detail class="relative z-10 text-[10.5px] font-medium px-2 py-1 rounded-md border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-colors">Ver detalle →</button>
          ${o.ca_available ? `<a href="${escapeHtml(safeUrl(o.ca_url))}" target="_blank" rel="noopener" class="relative z-10 text-[10.5px] font-medium px-2 py-1 rounded-md border border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100 transition-colors">Ver en Compra Ágil ↗</a>` : ''}
        </div>
      </div>
    </div>`;
}

/* ── Carrito ───────────────────────────────────────────────────────── */

const cartBar        = document.getElementById('cart-bar');
const cartCountEl    = document.getElementById('cart-count');
const cartPluralEl   = document.getElementById('cart-plural');
const cartPanel       = document.getElementById('cart-panel');
const cartPanelCount  = document.getElementById('cart-panel-count');
const cartItemsEl    = document.getElementById('cart-items');
const cartPdfBtn      = document.getElementById('cart-pdf-btn');
const cartPdfIcon     = document.getElementById('cart-pdf-icon');

function renderCartBar() {
  const n = cart.length;
  cartCountEl.textContent = String(n);
  cartPluralEl.textContent = n === 1 ? '' : 's';
  cartBar.classList.toggle('hidden', n === 0);
  cartPanelCount.textContent = String(n);
  renderDocPreview();
}

function renderDocPreview() {
  const wrap = document.getElementById('wiz-doc-preview');
  if (!wrap) return;

  const draftAttrs = {};
  ATTR_ORDER.forEach(a => { if (ficha[a]?.value != null && ficha[a]?.value !== '') draftAttrs[a] = ficha[a].value; });
  const hasDraft = !showingTextScreen && Object.keys(draftAttrs).length > 0;

  if (!cart.length && !hasDraft) {
    wrap.innerHTML = `
      <div class="pdf-wrap">
        <div class="doc-logo">${CONFIG.docLogoHtml}</div>
        <h1>${escapeHtml(CONFIG.docTitle)}</h1>
        <p class="doc-empty">A medida que vayas agregando compras a este requerimiento, acá vas a ver el documento tomando forma.</p>
      </div>`;
    return;
  }

  const fecha = new Date().toLocaleDateString('es-CL', { year: 'numeric', month: 'long', day: 'numeric' });
  const referencia = 'REQ-' + (String(SESSION_ID).replace(/-/g, '').slice(0, 6).toUpperCase() || '000000');
  const nItems = cart.length + (hasDraft ? 1 : 0);
  const sections = cart.map((item, i) => reqBlockHtml(item, i + 1)).join('');
  const draftHtml = hasDraft ? `
    <div class="req-draft">
      <p class="req-draft-tag">En construcción</p>
      ${reqBlockHtml({ nombre: null, atributos: draftAttrs, descripcion: null, cantidad: draftCantidad }, cart.length + 1)}
    </div>` : '';

  wrap.innerHTML = `
    <div class="pdf-wrap">
      <div class="doc-logo">${CONFIG.docLogoHtml}</div>
      <h1>${escapeHtml(CONFIG.docTitle)}</h1>
      <div class="doc-meta">
        <div><span>Fecha de emisión</span><b>${escapeHtml(fecha)}</b></div>
        <div><span>Referencia</span><b>${escapeHtml(referencia)}</b></div>
        <div><span>Categoría</span><b>${escapeHtml(SCHEMA?.label || '')}</b></div>
        <div><span>Compras</span><b>${nItems}</b></div>
      </div>
      ${sections}
      ${draftHtml}
      <div class="ftr">Documento generado por el Asistente IA · Compras Públicas</div>
    </div>`;
}

function resetWizardState() {
  ficha = {};
  facetsCache = {};
  priceData = null;
  cmPriceData = null;
  showingTextScreen = true;
  currentStepIndex = 0;
  confirmedAttrs.clear();
  forceChooseAttrs.clear();
  Object.keys(multiDraft).forEach(k => delete multiDraft[k]);
  clarifyNotice = null;
  currentTextoOriginal = '';
  draftCantidad = 1;
  revisados = revisados.filter(r => r.itemId != null); // los del borrador descartado se van
  transaccionesState.expanded = false;
  transaccionesState.offers = null;
  transaccionesState.loading = false;
  transaccionesState.loadError = false;
  transaccionesState.page = 1;
  transaccionesState.total = 0;
  cmState.page = 1;
  offTopicNotice = null;
}

function empezarNuevoRequerimiento() {
  apiFetch(`/api/categories/${CONFIG.slug}/reset/${SESSION_ID}`, { method: 'POST', headers: _headers() }).catch(() => {});
  resetWizardState();
  renderScreen();
}

// A diferencia de empezarNuevoRequerimiento() (que solo descarta el
// borrador en curso dentro del MISMO formulario -- ver botón "Descartar
// esta compra..." en el resumen), esto es la acción real de pasar a un
// REQUERIMIENTO distinto: mismo efecto que "+ Nuevo formulario" (nada se
// borra, el carrito actual queda guardado en su propio formulario y se
// puede retomar después desde "Formularios guardados"), con un aviso antes
// para que no sea sorpresa salir de donde estabas. Reporte real: "si
// quiero ir a un nuevo requerimiento, debería aparecer una alerta... de
// que se está abandonando el requerimiento".
function confirmarNuevoRequerimiento() {
  if (cart.length) {
    const n = cart.length;
    const ok = confirm(
      `Vas a salir de este requerimiento (tiene ${n} compra${n === 1 ? '' : 's'}) y abrir uno nuevo en blanco. ` +
      `Este queda guardado y lo puedes retomar luego desde "Formularios guardados". ¿Continuar?`
    );
    if (!ok) return;
  }
  nuevoFormulario();
}

// Corta el flujo apenas tipo_equipo="Otro" (ver case 'ficha_update' en
// handleWizardEvent) -- vuelve a la pantalla de texto inicial con un aviso
// amistoso, en vez de dejar avanzar el wizard con un producto que esta
// herramienta no cubre. Se resetea también la sesión en el backend (igual
// que empezarNuevoRequerimiento) para no arrastrar tipo_equipo="Otro" ni el
// resto de la ficha a medio llenar si la persona vuelve a intentar con una
// descripción real en la misma sesión.
function handleOffTopicProduct() {
  apiFetch(`/api/categories/${CONFIG.slug}/reset/${SESSION_ID}`, { method: 'POST', headers: _headers() }).catch(() => {});
  resetWizardState();
  offTopicNotice = CONFIG.offTopicMessage ||
    'Este asistente está diseñado específicamente para especificar computadores (laptops, equipos todo-en-uno o de escritorio). ' +
    'Lo que describiste no corresponde a ese tipo de equipo -- contanos qué computador necesitás (uso, procesador, RAM, almacenamiento, etc.) y seguimos.';
  renderScreen();
}

function describeItem(item) {
  return apiFetch(`/api/categories/${CONFIG.slug}/describe`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ items: [{ texto_original: item.texto_original, atributos: item.atributos }] }),
  })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => data ? {
      descripcion: (data.descripciones && data.descripciones[0]) || null,
      nombre: (data.nombres && data.nombres[0]) || null,
    } : null)
    .catch(() => null);
}

function agregarRequerimiento() {
  const atributos = {};
  ATTR_ORDER.forEach(a => {
    if (ficha[a]?.value != null && ficha[a]?.value !== '') atributos[a] = ficha[a].value;
  });
  const item = {
    id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    texto_original: currentTextoOriginal,
    atributos,
    price: priceData,
    cmPrice: cmPriceData,
    cantidad: draftCantidad > 0 ? draftCantidad : 1,
  };
  revisados.forEach(r => { if (r.itemId == null) r.itemId = item.id; });
  cart.push(item);
  saveCart();
  renderCartBar();
  renderHistorySidebar(); // refleja el nuevo conteo de compras de este formulario
  empezarNuevoRequerimiento();

  describeItem(item).then(res => {
    if (!res) return;
    if (res.descripcion) item.descripcion = res.descripcion;
    if (res.nombre) item.nombre = res.nombre;
    saveCart();
    renderDocPreview();
    renderCartPanel();
  });
}

function cartItemAttrsHtml(atributos) {
  return ATTR_ORDER
    .filter(a => atributos[a] != null && atributos[a] !== '')
    .map(a => `<span class="text-[11px] text-slate-500">${ATTR_LABELS[a]}: <strong class="text-slate-700">${escapeHtml(attrValueText(a, atributos[a]))}</strong></span>`)
    .join(' &nbsp;·&nbsp; ');
}

// Valor de un atributo tal como va en el documento (unidades, "o" entre opciones).
function attrValueText(attr, v) {
  const unit = SCHEMA?.attributes?.[attr]?.unit;
  const one = (x) => {
    if (typeof x === 'boolean') return x ? 'Sí' : 'No';
    if (typeof x === 'number') {
      if (unit === 'GB') return (x >= 1000 && x % 1000 === 0) ? `${x / 1000} TB` : `${x} GB`;
      if (unit === '"') return `${String(x).replace('.', ',')} pulgadas`;
      return String(x).replace('.', ',') + (unit ? ` ${unit}` : '');
    }
    return String(x);
  };
  return Array.isArray(v) ? v.map(one).join(' o ') : one(v);
}

// Título del ítem: el nombre corto generado por el modelo; mientras no
// llega (o si falla), tipo de equipo + características principales.
function itemTitle(item) {
  if (item.nombre) return item.nombre;
  const a = item.atributos || {};
  const parts = [];
  (CONFIG.titleAttrs || []).forEach(spec => {
    const key = [].concat(spec).find(k => a[k] != null && a[k] !== '');
    if (!key) return;
    parts.push(attrValueText(key, a[key]) + ((CONFIG.titleSuffix || {})[key] || ''));
  });
  return parts.join(' · ') || 'Producto requerido';
}

// Atributos que el comprador dejó abiertos (el proveedor puede ofrecer cualquiera).
function freeAttrLabels(atributos) {
  const a = atributos || {};
  const sinGpu = a.tiene_gpu_dedicada === false;
  return Object.keys(SCHEMA?.attributes || {})
    .filter(k => (a[k] == null || a[k] === '' || (Array.isArray(a[k]) && !a[k].length)) && !(k === 'gpu_dedicada_nombre' && sinGpu))
    .map(k => {
      const label = String(ATTR_LABELS[k] || k).replace(/[¿?]/g, '').trim();
      return (label.length > 1 && (label[1] === label[1].toUpperCase() && /[A-Z]/.test(label[1]) || label.startsWith('Wi-')))
        ? label : label.charAt(0).toLowerCase() + label.slice(1);
    });
}

function joinEs(list) {
  return list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' y ' + list[list.length - 1];
}

function reqBlockHtml(item, index) {
  const a = item.atributos || {};
  const rows = ATTR_ORDER
    .filter(k => a[k] != null && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length))
    .map(k => `<tr><td class="lbl">${escapeHtml(ATTR_LABELS[k] || k)}</td><td class="val">${escapeHtml(attrValueText(k, a[k]))}</td></tr>`)
    .join('');
  const free = freeAttrLabels(a);
  const qty = Number(item.cantidad) > 0 ? Number(item.cantidad) : 1;
  return `
    <div class="req">
      <div class="req-head">
        <span class="req-num">${String(index).padStart(2, '0')}</span>
        <span class="req-name">${escapeHtml(itemTitle(item))}</span>
        <span class="req-qty">Cantidad <b>${qty.toLocaleString('es-CL')}</b></span>
      </div>
      ${item.descripcion ? `<div class="req-descbox"><p class="req-lbl req-lbl-blue">Descripción del producto requerido</p><p>${escapeHtml(item.descripcion)}</p></div>` : ''}
      <p class="req-lbl">Características técnicas requeridas</p>
      <table class="req-table">${rows}</table>
      ${free.length && rows ? `<p class="req-free"><b>Sin exigencia:</b> ${escapeHtml(joinEs(free))}.</p>` : ''}
    </div>`;
}

function cartItemCardHtml(item, index) {
  const price = item.price
    ? `<p class="text-[13px] font-semibold text-emerald-700 mt-1.5">${formatCLP(priceStat(item.price, 'median'))} <span class="text-[10.5px] font-normal text-slate-400">mediana estimada</span></p>`
    : `<p class="text-[11px] text-slate-400 mt-1.5">Sin estimación de precio disponible</p>`;
  return `
    <div class="border border-slate-200 rounded-xl px-3.5 py-3">
      <div class="flex items-start justify-between gap-2">
        <div class="flex-1 min-w-0">
          <p class="text-[9.5px] font-bold text-emerald-600 uppercase tracking-wide">Compra ${index}</p>
          <p class="text-[12.5px] font-semibold text-slate-800 leading-snug">${escapeHtml(item.texto_original || 'Sin descripción')}</p>
        </div>
        <button data-cart-remove="${item.id}" aria-label="Eliminar" class="text-slate-300 hover:text-red-500 transition-colors flex-shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <p class="text-[11px] text-slate-500 mt-1 leading-relaxed">${cartItemAttrsHtml(item.atributos)}</p>
      <div class="flex items-center justify-between gap-3 mt-2.5">
        <label class="text-[11.5px] font-medium text-slate-600" for="qty-${item.id}">Cantidad</label>
        <input id="qty-${item.id}" type="number" min="1" step="1" inputmode="numeric" data-cart-qty="${item.id}" value="${Number(item.cantidad) > 0 ? Number(item.cantidad) : 1}" class="w-24 text-right font-semibold" />
      </div>
      ${price}
    </div>`;
}

function renderCartPanel() {
  if (!cart.length) {
    cartItemsEl.innerHTML = `<div class="text-center py-16 text-slate-400"><p class="text-[13px]">Aún no has agregado compras a este requerimiento.</p></div>`;
    return;
  }
  cartItemsEl.innerHTML = cart.map((item, i) => cartItemCardHtml(item, i + 1)).join('');
  cartItemsEl.querySelectorAll('[data-cart-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      cart = cart.filter(i => i.id !== btn.dataset.cartRemove);
      revisados = revisados.filter(r => r.itemId !== btn.dataset.cartRemove);
      renderRevisadosPanel();
      saveCart();
      renderCartBar();
      renderCartPanel();
      renderHistorySidebar();
    });
  });
  cartItemsEl.querySelectorAll('[data-cart-qty]').forEach(inp => {
    inp.addEventListener('change', () => {
      const n = Math.max(1, parseInt(inp.value, 10) || 1);
      inp.value = n;
      const it = cart.find(i => i.id === inp.dataset.cartQty);
      if (!it) return;
      it.cantidad = n;
      saveCart();
      renderDocPreview();
    });
  });
}

function openCartPanel() { renderCartPanel(); renderRevisadosPanel(); cartPanel.classList.remove('hidden'); }
function closeCartPanel() { cartPanel.classList.add('hidden'); }

/* ── Exportar PDF (backend, ReportLab) ──────────────────────────────────
   El PDF solo lleva lo técnico (qué se compra, cuánto, con qué
   características) para adjuntarlo al requerimiento en ChileCompra. Los
   precios y las comparaciones viven en el resumen ejecutivo. */

function downloadRequerimientosPDF() {
  if (!cart.length) return;
  cartPdfBtn.disabled = true;
  cartPdfIcon.classList.add('animate-spin');

  // Nombre y descripción los genera el modelo; normalmente ya vienen del
  // carrito (se piden al agregar la compra). Solo se piden los que falten.
  const pendientes = cart.filter(i => !i.descripcion || !i.nombre);
  const ensure = pendientes.length
    ? apiFetch(`/api/categories/${CONFIG.slug}/describe`, {
        method: 'POST',
        headers: _headers(),
        body: JSON.stringify({ items: pendientes.map(i => ({ texto_original: i.texto_original, atributos: i.atributos })) }),
      })
        .then(r => r && r.ok ? r.json() : { descripciones: [], nombres: [] })
        .then(data => {
          pendientes.forEach((i, j) => {
            if (!i.descripcion && data.descripciones?.[j]) i.descripcion = data.descripciones[j];
            if (!i.nombre && data.nombres?.[j]) i.nombre = data.nombres[j];
          });
          saveCart();
          renderDocPreview();
        })
        .catch(() => {})
    : Promise.resolve();

  ensure
    .then(() => apiFetch(`/api/categories/${CONFIG.slug}/pdf`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({
        session_id: SESSION_ID,
        items: cart.map(i => ({
          nombre: i.nombre || null,
          texto_original: i.texto_original,
          atributos: i.atributos,
          descripcion: i.descripcion || null,
          cantidad: Number(i.cantidad) > 0 ? Number(i.cantidad) : 1,
        })),
      }),
    }))
    .then(r => {
      if (!r) return null;           // sesión vencida: apiFetch ya mostró el aviso
      if (!r.ok) throw new Error(`PDF ${r.status}`);
      return r.blob();
    })
    .then(blob => {
      if (!blob) return;
      downloadBlob(blob, `${CONFIG.pdfFilenamePrefix}-${SESSION_ID.slice(0, 6).toLowerCase()}.pdf`);
      fetch(`/api/track/${SESSION_ID}`, {
        method: 'POST', headers: _headers(), body: JSON.stringify({ tipo: `${CONFIG.slug}_pdf_download` }),
      }).catch(() => {});
    })
    .catch(err => {
      console.error('Error generando el PDF:', err);
      alert('No pudimos generar el PDF. Intenta de nuevo en unos segundos.');
    })
    .finally(() => {
      cartPdfBtn.disabled = false;
      cartPdfIcon.classList.remove('animate-spin');
    });
}

/* ── Arranque: carga el schema y recién ahí resuelve CORE_STEPS/etc ──── */

function resolveCoreOrderToAttr(step) {
  return stepPrimaryAttr(step);
}

function loadSchemaAndInit() {
  return apiFetch(`/api/categories/${CONFIG.slug}/schema`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      if (!data) throw new Error('schema vacío o inalcanzable');
      SCHEMA = data;
      CORE_STEPS = data.core_order || [];
      OPTIONAL_ATTRS = Object.entries(data.attributes).filter(([, m]) => m.optional_detail).map(([k]) => k);
      TOTAL_STEPS = CORE_STEPS.length + 1;
      OPTIONAL_STEP_INDEX = CORE_STEPS.length;
      ATTR_ORDER = [...CORE_STEPS.map(resolveCoreOrderToAttr), ...OPTIONAL_ATTRS];
      ATTR_LABELS = {};
      Object.entries(data.attributes).forEach(([k, m]) => { ATTR_LABELS[k] = m.label; });
      CORE_STEPS.forEach(step => {
        const logical = (CONFIG.logicalSteps || {})[step];
        if (logical && !ATTR_LABELS[step]) ATTR_LABELS[step] = stepLabel(step);
      });
      Object.entries(data.attributes).forEach(([k, m]) => { if (m.valid_values) validValuesCache[k] = m.valid_values; });
      // No se llama renderScreen() acá: si el usuario sigue en la pantalla
      // de texto inicial (el caso normal) no hay nada que repintar; si ya
      // avanzó, fue porque analizar()/skip-to-manual esperaron schemaReady
      // antes de hacerlo, así que tampoco hace falta.
    })
    .catch(err => { console.error('Error cargando schema de categoría:', err); throw err; });
}

// Arranca la carga del schema apenas se evalúa este script (no espera
// DOMContentLoaded) -- ver comentario junto a "let SCHEMA = null" arriba.
const schemaReady = loadSchemaAndInit();

// Delegación de eventos del panel de precio / transacciones / revisados --
// atada a screenEl UNA sola vez (screenEl mismo nunca se reemplaza, solo su
// innerHTML), así sobrevive a cualquier reconstrucción del panel de precio
// (ej. por un price_update tardío de SSE) sin necesidad de re-bindear nada
// cada vez que algo se vuelve a pintar.
function bindGlobalPriceDelegation() {
  screenEl.addEventListener('click', (e) => {
    if (e.target.closest('[data-abrir-historial]')) {
      openHistorial();
      return;
    }

    const verTransacciones = e.target.closest('[data-ver-transacciones]');
    if (verTransacciones) {
      const list = document.querySelector('[data-transacciones-list]');
      if (!list) return;
      if (transaccionesState.expanded) {
        transaccionesState.expanded = false;
        list.classList.add('hidden');
        verTransacciones.textContent = 'Ver transacciones anteriores →';
        return;
      }
      transaccionesState.expanded = true;
      list.classList.remove('hidden');
      verTransacciones.textContent = 'Ocultar transacciones ↑';
      // Siempre se recarga la página 1 al expandir -- la ficha puede haber
      // cambiado desde la última vez que se abrió (atributo nuevo, precio
      // recalculado) y reusar offers/total cacheados mostraría resultados
      // desactualizados.
      transaccionesState.page = 1;
      list.innerHTML = `<p class="text-[11px] text-slate-400 py-1">Cargando...</p>`;
      loadTransacciones();
      return;
    }

    const transaccionesPagePrev = e.target.closest('[data-transacciones-page-prev]');
    if (transaccionesPagePrev) {
      if (transaccionesState.page > 1) {
        transaccionesState.page -= 1;
        const list = document.querySelector('[data-transacciones-list]');
        if (list) list.innerHTML = `<p class="text-[11px] text-slate-400 py-1">Cargando...</p>`;
        loadTransacciones();
      }
      return;
    }
    const transaccionesPageNext = e.target.closest('[data-transacciones-page-next]');
    if (transaccionesPageNext) {
      const totalPages = Math.max(1, Math.ceil(transaccionesState.total / transaccionesState.pageSize));
      if (transaccionesState.page < totalPages) {
        transaccionesState.page += 1;
        const list = document.querySelector('[data-transacciones-list]');
        if (list) list.innerHTML = `<p class="text-[11px] text-slate-400 py-1">Cargando...</p>`;
        loadTransacciones();
      }
      return;
    }

    const cmPagePrev = e.target.closest('[data-cm-page-prev]');
    if (cmPagePrev) {
      if (cmState.page > 1) { cmState.page -= 1; renderPricePanel(); }
      return;
    }
    const cmPageNext = e.target.closest('[data-cm-page-next]');
    if (cmPageNext) {
      const totalPages = Math.max(1, Math.ceil((cmPriceData?.products || []).length / cmState.pageSize));
      if (cmState.page < totalPages) { cmState.page += 1; renderPricePanel(); }
      return;
    }

    // "Ver detalle" de una transacción de Compra Ágil -- modal, no expande
    // hacia abajo (ver nota en offerRowHtml).
    const offerDetail = e.target.closest('[data-offer-detail]');
    if (offerDetail) {
      const key = offerDetail.closest('[data-offer-key]')?.dataset.offerKey;
      const o = (transaccionesState.offers || []).find(x => transaccionKey(x) === key);
      if (o) openModal(offerDetailModalHtml(o));
      return;
    }
    // Cualquier link dentro del panel (Ver en Compra Ágil, Ver en Convenio
    // Marco, el nombre de un ítem revisado) navega normal -- nunca togglea
    // selección ni abre nada más, se corta acá para toda la pantalla.
    if (e.target.closest('a[href]')) return;

    // Igual que Convenio Marco: clickear la fila (afuera de los botones de
    // arriba) marca/desmarca para revisar (ver offerRowHtml).
    const offerRow = e.target.closest('[data-offer-row-toggle]');
    if (offerRow) {
      const key = offerRow.dataset.offerKey;
      const o = (transaccionesState.offers || []).find(x => transaccionKey(x) === key);
      if (key && o) {
        toggleRevisado('ca', key, {
          label: o.razon_social || 'Proveedor no informado',
          price: o.precio_unitario_iva,
          sub: o.descripcion || '',
          url: o.ca_available ? o.ca_url : null,
          raw: o,
        });
        refreshTransaccionesList();
      }
      return;
    }

    // Tarjeta de Convenio Marco: "Ver detalle" y el link externo son
    // acciones explícitas que NO togglean la selección (se chequean primero
    // y cortan acá) -- clickear cualquier otra parte de la tarjeta sí
    // marca/desmarca para revisar (ver cmBlockHtml).
    const cmDetail = e.target.closest('[data-cm-detail]');
    if (cmDetail) {
      const key = cmDetail.dataset.cmDetail;
      const p = (cmPriceData?.products || []).find(x => String(x.id_producto ?? x.url ?? x.nombre) === key);
      if (p) openModal(cmDetailModalHtml(p));
      return;
    }
    // "Ver en Convenio Marco ↗" ya se dejó navegar normal más arriba (el
    // chequeo genérico de a[href] cubre cualquier link dentro de screenEl).

    const cmCard = e.target.closest('[data-cm-card-toggle]');
    if (cmCard) {
      const key = cmCard.dataset.cmCardToggle;
      const p = (cmPriceData?.products || []).find(x => String(x.id_producto ?? x.url ?? x.nombre) === key);
      if (key && p) {
        toggleRevisado('cm', key, {
          label: p.nombre || p.modelo || p.marca || 'Producto Convenio Marco',
          price: p.precio_min_clp,
          sub: p.marca || '',
          url: p.url || null,
          raw: p,
        });
        renderPricePanel();
      }
      return;
    }

    // Dropdown con selección múltiple del editor de detalles opcionales
    // (ver multiDropdownControlHtml) -- delegado acá porque la lista de
    // sugerencias y los chips seleccionados se repintan fuera del ciclo
    // normal de bindScreenEvents (mismo criterio que las transacciones).
    const multiAdd = e.target.closest('[data-multi-dropdown-add]');
    if (multiAdd) {
      const attr = multiAdd.dataset.multiDropdownAddAttr;
      const val = multiAdd.dataset.multiDropdownAdd;
      if (attr && val && multiDraft[attr]) {
        multiDraft[attr].add(val);
        const input = screenEl.querySelector(`[data-multi-dropdown-input="${attr}"]`);
        if (input) input.value = '';
        refreshMultiDropdownSelected(attr);
        filterMultiDropdown(attr, '');
      }
      return;
    }
    const multiRemove = e.target.closest('[data-multi-dropdown-remove]');
    if (multiRemove) {
      const attr = multiRemove.dataset.multiDropdownAttr;
      const val = multiRemove.dataset.multiDropdownRemove;
      if (attr && val && multiDraft[attr]) {
        multiDraft[attr].delete(val);
        refreshMultiDropdownSelected(attr);
      }
      return;
    }
  });

  screenEl.addEventListener('change', (e) => {
    if (e.target.matches('[data-transacciones-sort]')) {
      transaccionesState.sortBy = e.target.value;
      refreshTransaccionesList();
    } else if (e.target.matches('[data-transacciones-group]')) {
      transaccionesState.groupBy = e.target.value;
      refreshTransaccionesList();
    }
  });
}

// La cantidad del borrador se actualiza mientras se escribe (no se repinta la
// pantalla: se perdería el foco del campo).
function bindCantidadInput() {
  screenEl.addEventListener('input', (e) => {
    if (!e.target.matches('[data-cantidad-input]')) return;
    const n = parseInt(e.target.value, 10);
    draftCantidad = n > 0 ? n : 1;
    renderDocPreview();
  });
  screenEl.addEventListener('change', (e) => {
    if (!e.target.matches('[data-cantidad-input]')) return;
    e.target.value = draftCantidad;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindCantidadInput();
  // revisados NO se carga de ningún lado -- arranca vacío siempre (ver nota junto a "let revisados = []").
  bindGlobalPriceDelegation();
  backBtn.addEventListener('click', goBack);
  const historialTopBtn = document.querySelector('#wiz-progress-wrap [data-abrir-historial]');
  if (historialTopBtn) historialTopBtn.addEventListener('click', openHistorial);
  const historySidebar = document.getElementById('wiz-history-sidebar');
  if (historySidebar) historySidebar.addEventListener('click', handleHistorialClick);
  const nuevoFormularioBtn = document.querySelector('[data-nuevo-formulario]');
  if (nuevoFormularioBtn) nuevoFormularioBtn.addEventListener('click', nuevoFormulario);
  renderHistorySidebar();
  document.getElementById('cart-bar-btn').addEventListener('click', openCartPanel);
  document.getElementById('cart-close').addEventListener('click', closeCartPanel);
  document.getElementById('cart-backdrop').addEventListener('click', closeCartPanel);
  cartPanel.addEventListener('click', handleRevisadosClick);
  document.getElementById('cart-empty-btn').addEventListener('click', () => {
    if (!cart.length) return;
    const n = cart.length;
    if (!confirm(`Esto elimina las ${n} compra${n === 1 ? '' : 's'} agregadas a este requerimiento. ¿Seguro que quieres vaciar la cotización?`)) return;
    cart = [];
    saveCart();
    renderCartBar();
    renderCartPanel();
    renderHistorySidebar();
  });
  cartPdfBtn.addEventListener('click', downloadRequerimientosPDF);

  // Retomar automáticamente el formulario en el que se estaba trabajando en
  // esta pestaña (ver CURRENT_SESSION_KEY), en vez de arrancar siempre un
  // SESSION_ID nuevo en cada carga de página -- eso era justo lo que
  // generaba el reporte "cuando actualizo me sale como de la última
  // compra" (el carrito global viejo colándose en una sesión nueva que no
  // tenía nada que ver). Si no hay nada guardado (primera visita, u otra
  // pestaña/dispositivo), arranca en blanco como siempre.
  const rememberedId = getRememberedSession();
  if (rememberedId) {
    screenEl.innerHTML = loadingScreenHtml('Retomando tu formulario...');
    resumeSession(rememberedId, {
      onFail: () => {
        try { sessionStorage.removeItem(CURRENT_SESSION_KEY); } catch (e) {}
        renderCartBar();
        renderScreen();
      },
    });
  } else {
    renderCartBar();
    renderScreen(); // pantalla de texto inicial -- no depende del schema, se pinta de inmediato
  }
});
