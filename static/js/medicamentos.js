/* ═══════════════════════════════════════════════════════════════
   medicamentos.js — selector guiado de atributos: pantallas completas,
   una por paso, que se van "desbloqueando" (nada de lo que sigue se
   muestra hasta llegar a ello; para volver, solo de a un paso con ←).
   Depende de shell.js (apiFetch, escapeHtml, safeUrl, _headers, readSSEStream).
   ═══════════════════════════════════════════════════════════════ */

// let, no const -- resumeSession() lo reasigna al retomar un formulario guardado
// (historial), para que todas las llamadas al backend usen el session_id guardado.
let SESSION_ID = (crypto.randomUUID ? crypto.randomUUID() : `med-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// Qué formulario estaba activo en esta pestaña (mismo criterio y misma llave
// que Computadores: home.js la usa para abrir un formulario desde el inicio).
const CURRENT_SESSION_KEY = 'cat_medicamentos_current_session_v1';
function rememberCurrentSession(id) {
  try { sessionStorage.setItem(CURRENT_SESSION_KEY, id); } catch (e) {}
}
function getRememberedSession() {
  try { return sessionStorage.getItem(CURRENT_SESSION_KEY); } catch (e) { return null; }
}

// unidad_venta es un paso core (obligatorio, sin "omitir"): el precio de un
// medicamento no es comparable entre unidades (ej. Metformina: mediana $74
// por Comprimido vs $23.205 por Caja, ~314x) -- el backend directamente no
// calcula precio/historial sin unidad_venta (ver medicamento_service.py).
const CORE_STEPS = ["principio_activo", "forma_farmaceutica", "concentracion", "unidad_venta"];
const NO_SKIP_STEPS = new Set(["principio_activo", "unidad_venta"]);
const OPTIONAL_ATTRS = ["laboratorio", "cantidad"];
// Mismo arreglo que category_wizard.js (ver _wizardCallSeq ahí): descarta
// eventos SSE de una llamada analizar()/manualUpdate() que ya no es la más
// reciente, para que una respuesta lenta no pise el estado de una más
// nueva que ya llegó y se renderizó.
let _medCallSeq = 0;
// cantidad_requerida no es un paso ni aparece en "detalles opcionales" --
// se pide directo en el paso de unidad_venta (cuántas de esa unidad), y
// solo se usa para el total estimado (precio unitario × cantidad). Va en
// ATTR_ORDER igual que los demás para que el carrito/PDF/resumen lo
// muestren con el mismo mecanismo genérico (ATTR_LABELS, formatAttrValue).
const EXTRA_DISPLAY_ATTRS = ["cantidad_requerida"];
const OPTIONAL_STEP_INDEX = CORE_STEPS.length; // paso 5 (índice 4)
const TOTAL_STEPS = CORE_STEPS.length + 1;      // 5 segmentos en la barra de progreso
const ATTR_ORDER = [...CORE_STEPS, ...OPTIONAL_ATTRS, ...EXTRA_DISPLAY_ATTRS];
const STEP_LABELS = {
  principio_activo: "Principio activo",
  forma_farmaceutica: "Forma farmacéutica",
  concentracion: "Concentración",
  unidad_venta: "Unidad de compra",
};
const ATTR_LABELS = {
  ...STEP_LABELS,
  laboratorio: "Laboratorio",
  cantidad: "Tamaño del envase",
  cantidad_requerida: "Cantidad a comprar",
};
const DICT_ATTRS = new Set(["principio_activo", "forma_farmaceutica", "laboratorio"]);
const NUMERIC_ATTRS = new Set(["cantidad", "cantidad_requerida"]);

// Mismo logo que usa el header de la app (_header.html) -- se repite acá
// (encabezado del documento, vista previa y PDF real) para que el
// documento se vea como algo de ChileCompra, no un genérico sin marca.
const DOC_LOGO_HTML = '<img src="/imagenes/logo-chilecompra.png" alt="ChileCompra" />';

// ── Estado ──────────────────────────────────────────────────────
let ficha = {};                 // {attr: {value, source, normalized, score}}
let facetsCache = {};           // {attr: [{value,count}]}
let validValuesCache = {};      // {attr: [str]} -- solo atributos dict, desde /schema
let priceData = null;
// Mediana más barata entre las unidades de venta disponibles -- se muestra
// como "desde $X" en la mini-barra de precio ANTES de llegar al paso de
// Unidad de compra (que es cuando priceData por fin es un precio preciso,
// no mezclado). Se recalcula con cada paso core que se confirma, así se va
// afinando (más filtros = comparación más acotada) en vez de aparecer solo
// al final.
let priceHintDesde = null;
let showingTextScreen = true;   // pantalla inicial: solo el texto libre
let currentStepIndex = 0;       // 0..2 = core, 3 = detalles opcionales, 4 = resumen/listo
const confirmedAttrs = new Set();
const forceChooseAttrs = new Set(); // atributos donde el usuario pidió "elegir otro" en vez de confirmar la sugerencia IA
let companionsPending = false;      // true = mostrando la sub-pantalla "¿otro principio activo?"
let companionsCache = [];
let companionsLoaded = false; // distingue "todavía cargando" de "cargó y no hay combinaciones"
let clarifyNotice = null;     // {message, question} -- la IA no pudo resolver principio_activo (ej. "tapsin")
// Texto original del requerimiento que se está armando ahora -- se setea al
// analizar texto libre, o al reabrir un ítem del carrito para editarlo. Se
// necesita persistido acá porque el <textarea> donde se escribió solo
// existe en la primerísima pantalla -- para cuando se llega al resumen (o
// a la vista previa del documento) ya no está en el DOM.
let currentTextoOriginal = '';
let analyzingNow = false;  // mientras analiza el texto no se repinta la pantalla (borraba el formulario y la capa de carga)
// "Unidad" es un código genérico que distintos organismos usan para la
// misma compra que otros etiquetan con la forma específica (Comprimido,
// Cápsula, etc.) -- el backend lo detecta y expande el filtro solo (ver
// unidad_medida_catalogo.equivalente_a_unidad en medicamento_service.py),
// acá no hace falta preguntarle nada al usuario.

// ── Elementos fijos (existen siempre) ──────────────────────────
const progressWrap     = document.getElementById('med-progress-wrap');
const progressSegments = document.getElementById('med-progress-segments');
const priceMiniEl      = document.getElementById('med-price-mini');
const backBtn          = document.getElementById('med-back-btn');
const screenEl         = document.getElementById('med-screen');

/* ── Carrito de requerimientos (por formulario, guardado en el servidor) ──
   Igual que Computadores: cada formulario guardado tiene su propio carrito
   (category_sessions.cart), así retomarlo desde el historial trae de vuelta
   sus compras. */
let cart = [];

function saveCart() {
  apiFetch(`/api/categories/medicamentos/sessions/${SESSION_ID}/cart`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ cart }),
  })
    .then(() => historyUI.renderSidebar())   // refleja el nuevo conteo de compras
    .catch(() => {});
}

function formatCLP(n) {
  return Number.isFinite(n)
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
    : null;
}
function formatAttrValue(value) {
  if (Array.isArray(value)) return value.map(v => escapeHtml(upperText(v))).join(' + ');
  return escapeHtml(upperText(value));
}
function badgeFor(source) {
  const cfg = {
    ai:   { label: 'IA', cls: 'bg-violet-50 text-violet-600 border-violet-200' },
    user: { label: 'Tú', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
  }[source];
  if (!cfg) return '';
  return `<span class="text-[10px] font-medium px-1.5 py-0.5 rounded-md border ${cfg.cls}">${cfg.label}</span>`;
}

/* ── SSE: análisis y edición manual ─────────────────────────────── */

function analizar() {
  const input = document.getElementById('med-texto-input');
  const btn = document.getElementById('med-analizar-btn');
  const icon = document.getElementById('med-analizar-icon');
  const hint = document.getElementById('med-analizar-hint');
  const texto = input.value.trim();
  if (!texto) return;
  currentTextoOriginal = texto;
  textoDraft = '';
  rememberCurrentSession(SESSION_ID);

  btn.disabled = true;
  icon.classList.add('animate-spin');
  hint.textContent = 'Analizando...';
  analyzingNow = true;
  showAnalyzing(btn, [
    'Leyendo tu requerimiento...',
    'Identificando principio activo y presentación...',
    'Preparando los pasos de la ficha...',
  ]);
  clarifyNotice = null;

  const mySeq = ++_medCallSeq;

  apiFetch(`/api/medicamentos/analizar/${SESSION_ID}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ texto }),
  })
    .then(res => res ? readSSEStream(res, (data) => {
      if (mySeq !== _medCallSeq) return; // ver _medCallSeq -- respuesta obsoleta, se ignora
      handleMedEvent(data);
    }) : null)
    .then(() => {
      if (mySeq !== _medCallSeq) return;
      analyzingNow = false;
      showingTextScreen = false;
      renderScreen();
      historyUI.renderSidebar();
    })
    .catch(err => console.error('Error en analizar:', err))
    .finally(() => {
      if (mySeq !== _medCallSeq) return;
      btn.disabled = false;
      icon.classList.remove('animate-spin');
      analyzingNow = false;
      hideAnalyzing(btn);
    });
}

function manualUpdate(attr, value) {
  rememberCurrentSession(SESSION_ID);
  const mySeq = ++_medCallSeq;
  apiFetch(`/api/medicamentos/manual_update/${SESSION_ID}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ attribute: attr, value }),
  })
    .then(res => res ? readSSEStream(res, (data) => {
      if (mySeq !== _medCallSeq) return;
      handleMedEvent(data);
    }) : null)
    .catch(err => console.error('Error en manual_update:', err));
}

function handleMedEvent(data) {
  switch (data.type) {
    case 'ficha_update':
      data.updates.forEach(u => { ficha[u.attribute] = u; });
      renderScreen();
      break;
    case 'message':
      // Solo interesa mostrarlo cuando la IA no pudo resolver principio_activo
      // (ver 'questions') -- en el caso exitoso ya se refleja en la tarjeta de
      // confirmación del paso, así que solo se guarda por si llega una pregunta.
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
      renderPriceMini();
      renderPricePanel();
      break;
    case 'price_not_found':
      priceData = null;
      renderPriceMini();
      renderPricePanel();
      break;
    case 'usage_limit_reached': {
      const hint = document.getElementById('med-analizar-hint');
      if (hint) hint.textContent = 'Alcanzaste el límite diario de uso de IA -- puedes seguir eligiendo atributos manualmente.';
      break;
    }
    case 'error':
      console.error('Error del servidor:', data.message);
      break;
  }
}

/* ── Transiciones entre pasos ────────────────────────────────────── */

function onAttrConfirmed(attr) {
  confirmedAttrs.add(attr);
  forceChooseAttrs.delete(attr);
  if (attr === 'principio_activo') {
    clarifyNotice = null;
    companionsPending = true;
    companionsCache = [];
    companionsLoaded = false;
    loadCompanions();
    loadPriceHint();
    renderScreen();
  } else {
    advanceStep();
  }
}

// "desde $X" -- la mediana más barata entre unidades para lo ya elegido
// (excluye unidad_venta del filtro a propósito, ver get_price_by_unidad en
// el backend). Se llama de nuevo con cada paso core confirmado para que se
// vaya afinando, y deja de tener sentido una vez que priceData ya es
// preciso (después de elegir unidad_venta).
function loadPriceHint() {
  if (!ficha.principio_activo?.value) return;
  apiFetch(`/api/medicamentos/precio_por_unidad/${SESSION_ID}`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      const values = (data && data.values) || [];
      const medianas = values.map(v => v.mediana).filter(m => m != null);
      priceHintDesde = medianas.length ? Math.min(...medianas) : null;
      renderPriceMini();
      renderDocPreview();
    })
    .catch(() => {});
}

function advanceStep() {
  currentStepIndex = Math.min(currentStepIndex + 1, TOTAL_STEPS);
  renderScreen();
  if (currentStepIndex < CORE_STEPS.length) {
    refreshFacetsFor([CORE_STEPS[currentStepIndex]]);
    if (CORE_STEPS[currentStepIndex] !== 'unidad_venta') loadPriceHint();
    // OJO: los atributos opcionales (laboratorio/cantidad) NO se prefetchean
    // acá -- si el próximo paso core es unidad_venta, todavía no sabemos
    // qué unidad va a elegir, y precargar con ese filtro incompleto trae un
    // set más amplio que el real (ej. 4 laboratorios en vez de 1). Mejor
    // mostrar el mensaje de carga una vez y pedirlo recién con los filtros
    // completos (ver el `else if` de abajo) que mostrar un resultado
    // equivocado que después "encoge" al reemplazarse solo.
    if (currentStepIndex + 1 < CORE_STEPS.length) {
      prefetchFacets([CORE_STEPS[currentStepIndex + 1]]);
    }
  } else if (currentStepIndex === OPTIONAL_STEP_INDEX) {
    refreshFacetsFor(OPTIONAL_ATTRS.filter(a => !ficha[a]?.value));
  }
}

// Solo retrocede UN paso a la vez (sin saltar directo a uno lejano).
function goBack() {
  if (editingOptionalAttr) {
    editingOptionalAttr = null;
    renderScreen();
    return;
  }
  if (companionsPending) {
    companionsPending = false;
    renderScreen();
    return;
  }
  if (currentStepIndex === 0) {
    showingTextScreen = true;
    renderScreen();
    return;
  }
  currentStepIndex -= 1;
  if (currentStepIndex < CORE_STEPS.length) {
    const attr = CORE_STEPS[currentStepIndex];
    confirmedAttrs.delete(attr);
    forceChooseAttrs.add(attr);
    refreshFacetsFor([attr]);
  }
  renderScreen();
}

function pickValue(attr, value) {
  ficha[attr] = { attribute: attr, value, source: 'user', normalized: true, score: 1 };
  manualUpdate(attr, value);
  if (attr === 'unidad_venta') {
    // No avanza solo -- se queda en la misma pantalla mostrando la unidad
    // elegida + el campo de cantidad, para que el usuario pueda completarlo
    // antes de continuar (ver unidadVentaSelectedHtml).
    confirmedAttrs.add(attr);
    forceChooseAttrs.delete(attr);
    renderScreen();
  } else if (CORE_STEPS.includes(attr)) {
    onAttrConfirmed(attr);
  } else {
    // atributo opcional del paso 4: vuelve a la lista de detalles -- se
    // pueden seguir completando los demás antes de continuar.
    editingOptionalAttr = null;
    renderScreen();
  }
}

function loadCompanions() {
  apiFetch(`/api/medicamentos/companions/${SESSION_ID}`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      companionsCache = (data && data.values) || [];
      companionsLoaded = true;
      if (companionsPending) renderScreen();
    })
    .catch(() => {
      companionsLoaded = true;
      if (companionsPending) renderScreen();
    });
}

function addCompanion(value) {
  if (!value || !value.trim()) return;
  value = value.trim();
  const existing = ficha.principio_activo.value;
  const arr = Array.isArray(existing) ? existing.slice() : [existing];
  if (arr.some(v => v.toLowerCase() === value.toLowerCase())) return;
  arr.push(value);
  setPrincipioActivoList(arr);
}

// index=0 es el principio activo inicial (con el que se confirmó el paso 1) --
// ese no se puede quitar por acá, solo los que se agregaron después.
function removeCompanion(index) {
  const existing = ficha.principio_activo.value;
  const arr = Array.isArray(existing) ? existing.slice() : [existing];
  if (index <= 0 || index >= arr.length) return;
  arr.splice(index, 1);
  setPrincipioActivoList(arr);
}

function setPrincipioActivoList(arr) {
  const value = arr.length === 1 ? arr[0] : arr;
  ficha.principio_activo = { attribute: 'principio_activo', value, source: 'user', normalized: true, score: 1 };
  manualUpdate('principio_activo', value);
  companionsCache = [];
  companionsLoaded = false;
  loadCompanions();
  renderScreen();
}

function editOptionalAttr(attr) {
  editingOptionalAttr = attr;
  renderScreen();
  refreshFacetsFor([attr]);
}

function clearOptionalAttr(attr) {
  ficha[attr] = null;
  manualUpdate(attr, null);
  editingOptionalAttr = null;
  renderScreen();
}

/* ── Barra de progreso + precio mini ────────────────────────────── */

function updateProgressBar() {
  if (showingTextScreen) {
    progressWrap.classList.add('hidden');
    return;
  }
  progressWrap.classList.remove('hidden');

  const segs = [];
  for (let i = 0; i < TOTAL_STEPS; i++) {
    let cls = 'bg-slate-200';
    if (companionsPending && i === 0) cls = 'bg-violet-500';
    else if (i < currentStepIndex) cls = 'bg-brand-800';
    else if (i === currentStepIndex) cls = 'bg-brand-600';
    segs.push(`<div class="h-1 flex-1 rounded-full ${cls} transition-colors"></div>`);
  }
  progressSegments.innerHTML = segs.join('');
}

function renderPriceMini() {
  if (showingTextScreen) {
    priceMiniEl.classList.add('hidden');
  } else if (priceData && priceData.mediana != null) {
    // precio preciso (ya se eligió unidad_venta) -- sin "desde", es el real.
    priceMiniEl.textContent = formatCLP(priceData.mediana);
    priceMiniEl.classList.remove('hidden');
  } else if (priceHintDesde != null) {
    // todavía sin unidad_venta -- solo un indicio (la más barata entre
    // unidades), marcado como "desde" para no aparentar precisión que
    // todavía no hay.
    priceMiniEl.textContent = `desde ${formatCLP(priceHintDesde)}`;
    priceMiniEl.classList.remove('hidden');
  } else {
    priceMiniEl.classList.add('hidden');
  }
}

/* ── Render de la pantalla activa ────────────────────────────────── */

let addedNotice = null;      // { sid, updated, itemId } -- pantalla de siguientes pasos tras agregar una compra
let editingItemId = null;    // compra del carrito en edición (sigue en el carrito hasta guardar)
let inputMode = 'texto';     // pestaña de la pantalla de ingreso: 'texto' | 'manual'
let textoDraft = '';         // lo escrito, para no perderlo al cambiar de pestaña
let editingOptionalAttr = null; // detalle opcional en edición de a uno, o null (ver optionalAttrEditScreenHtml)

function renderScreen() {
  if (analyzingNow) return;
  updateProgressBar();
  renderPriceMini();
  renderDocPreview();

  let html;
  if (showingTextScreen) {
    html = (addedNotice && addedNotice.sid === SESSION_ID && cart.length) ? addedScreenHtml() : textoScreenHtml();
  } else if (companionsPending) {
    html = companionScreenHtml();
  } else if (currentStepIndex < CORE_STEPS.length) {
    html = stepScreenHtml(CORE_STEPS[currentStepIndex], currentStepIndex);
  } else if (currentStepIndex === OPTIONAL_STEP_INDEX) {
    html = editingOptionalAttr ? optionalAttrEditScreenHtml(editingOptionalAttr) : detallesScreenHtml();
  } else {
    html = resumenScreenHtml();
  }

  screenEl.classList.add('med-screen-enter');
  screenEl.innerHTML = html;
  // fuerza reflow para que la transición de salida de la clase se note
  void screenEl.offsetWidth;
  screenEl.classList.remove('med-screen-enter');

  bindScreenEvents();
  if (showingTextScreen) {
    const ti = document.getElementById('med-texto-input');
    if (ti && textoDraft) ti.value = textoDraft;
    bindTextoLibre(ti, document.getElementById('med-texto-count'));
  }

  if (!showingTextScreen && !companionsPending && currentStepIndex < CORE_STEPS.length) {
    const attr = CORE_STEPS[currentStepIndex];
    const showsPicker = !ficha[attr]?.value || ficha[attr]?.source !== 'ai' || confirmedAttrs.has(attr) || forceChooseAttrs.has(attr);
    if (showsPicker) refreshFacetsFor([attr]);
  }
  if (currentStepIndex === TOTAL_STEPS) {
    renderPricePanel();
  }
}

function addedScreenHtml() {
  const last = cart.find(i => i.id === addedNotice.itemId) || cart[cart.length - 1];
  const n = cart.length;
  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm wiz-pop">
      <div class="flex items-center gap-3">
        <span class="w-7 h-7 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </span>
        <h1 class="text-[18px] font-semibold text-slate-900 tracking-tight">${addedNotice.updated ? 'Compra actualizada' : 'Compra agregada a tu requerimiento'}</h1>
      </div>
      <p class="text-[13px] text-slate-500 mt-1.5 ml-10">${escapeHtml(itemTitleMed(last))} · ${n} compra${n === 1 ? '' : 's'} en total</p>

      <div class="mt-5 space-y-3">
        <!-- 1. Agregar otro producto -->
        <div class="flex items-center justify-between gap-4 border border-slate-200 rounded-xl px-5 py-4">
          <div class="min-w-0">
            <p class="text-[14px] font-semibold text-slate-800">Agregar otro producto</p>
            <p class="text-[12.5px] text-slate-500 mt-1 leading-relaxed">Suma otra compra a este mismo requerimiento -- por ejemplo otro medicamento o una presentación distinta.</p>
          </div>
          <button type="button" data-added-more aria-label="Agregar otro producto"
                  class="flex-shrink-0 w-11 h-11 flex items-center justify-center bg-brand-600 hover:bg-brand-700 text-white rounded-full transition-colors shadow-sm">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
          </button>
        </div>

        <!-- 2. PDF -- documento para subir a ChileCompra -->
        <div class="flex items-center justify-between gap-4 border border-slate-200 rounded-xl px-5 py-4">
          <div class="min-w-0 flex items-center gap-3">
            <span class="w-9 h-9 rounded-lg bg-red-50 text-red-600 flex items-center justify-center flex-shrink-0">
              <svg class="w-[18px] h-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            </span>
            <div class="min-w-0">
              <p class="text-[14px] font-semibold text-slate-800">Subir a ChileCompra</p>
              <p class="text-[12.5px] text-slate-500 mt-1 leading-relaxed">Descarga el documento técnico en PDF, listo para publicar como requerimiento -- sin precios ni información interna.</p>
            </div>
          </div>
          <button type="button" data-pdf-action class="flex-shrink-0 inline-flex items-center gap-1.5 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white text-[12.5px] font-semibold rounded-lg transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H8a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            Descargar PDF
          </button>
        </div>

        <!-- 3. Resumen ejecutivo -- destacado con cinta -->
        <div class="relative overflow-hidden flex items-center justify-between gap-4 border-2 border-brand-300 bg-gradient-to-br from-brand-50 to-white rounded-xl pl-5 pr-5 py-4">
          <span class="absolute top-0 right-0 text-[9px] font-bold tracking-wide text-white bg-brand-600 px-3 py-1 rounded-bl-lg">RECOMENDADO</span>
          <div class="min-w-0">
            <p class="text-[14px] font-semibold text-brand-900">Revisar precios y mercado</p>
            <p class="text-[12.5px] text-brand-700/90 mt-1 leading-relaxed">Totales estimados, evolución de precios y laboratorios de todo el requerimiento -- antes de publicar, conviene mirarlo.</p>
          </div>
          <button type="button" data-resumen-action class="flex-shrink-0 px-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[12.5px] font-semibold rounded-lg transition-colors whitespace-nowrap shadow-sm">Ver resumen ejecutivo</button>
        </div>
      </div>

      <button type="button" data-nuevo-requerimiento-completo class="mt-4 text-[11.5px] font-medium text-slate-400 hover:text-slate-700 underline">¿Requerimiento distinto?</button>
    </div>`;
}

// Abandonar el requerimiento actual (queda guardado en el historial) y abrir
// uno nuevo en blanco -- con aviso, igual que en Computadores.
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

function textoScreenHtml() {
  // Con compras ya en el carrito, esta pantalla siempre suma al MISMO requerimiento.
  const continuingBanner = cart.length > 0 ? `
    <div class="mb-4 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-left flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-[12.5px] font-semibold text-emerald-800">Agregando la compra ${cart.length + 1} a este requerimiento</p>
        <p class="text-[11.5px] text-emerald-700 mt-0.5 leading-snug">Ya tienes ${cart.length} compra${cart.length === 1 ? '' : 's'} en tu cotización -- lo que describas acá se suma al mismo requerimiento.</p>
      </div>
      <button type="button" data-nuevo-requerimiento-completo class="flex-shrink-0 text-[11px] font-medium text-emerald-700 hover:text-emerald-900 underline whitespace-nowrap">¿Requerimiento distinto?</button>
    </div>` : '';
  return inputScreenHtml({
    prefix: 'med',
    bannersHtml: continuingBanner,
    title: '¿Qué medicamento necesitas?',
    mode: inputMode,
    helper: 'Nombre comercial o genérico, principio activo, o una descripción con varias especificaciones.',
    placeholder: 'Ej.: paracetamol 500 mg comprimidos…',
    guide: [
      { title: 'Principio activo', text: 'Nombre genérico o comercial' },
      { title: 'Concentración', text: 'Por ejemplo, 500 mg' },
      { title: 'Forma farmacéutica', text: 'Comprimido, jarabe, inyectable…' },
      { title: 'Unidad de compra', text: 'Envase o presentación' },
    ],
    manual: {
      title: 'Elegir el principio activo',
      hint: 'Buscas el principio activo y después te preguntamos concentración, forma y unidad de compra.',
      options: null,
      buttonLabel: 'Elegir el principio activo',
    },
  });
}

function stepScreenHtml(attr, index) {
  const current = ficha[attr];
  const hasAiPending = current && current.value != null && current.source === 'ai' &&
                        !confirmedAttrs.has(attr) && !forceChooseAttrs.has(attr);

  if (hasAiPending) {
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
        <span class="inline-flex items-center text-[10.5px] font-semibold text-brand-700 bg-brand-50 border border-brand-100 rounded-full px-2.5 py-1 mb-3">Sugerido por IA</span>
        <h2 class="text-[22px] font-semibold text-brand-800 tracking-tight mb-4">${STEP_LABELS[attr]}</h2>
        <p class="text-[14px] text-slate-500 mb-1">Vimos que necesitas</p>
        <p class="text-[26px] font-semibold text-slate-900 tracking-tight mb-6">${formatAttrValue(current.value)}</p>
        <div class="flex gap-2">
          <button type="button" data-confirm="${attr}" class="flex-1 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors">Sí, es correcto</button>
          <button type="button" data-choose="${attr}" class="px-4 py-2.5 bg-white border border-slate-200 hover:border-brand-300 text-slate-600 text-[13.5px] font-medium rounded-lg transition-colors">Elegir otro</button>
        </div>
      </div>`;
  }

  // unidad_venta ya tiene un valor elegido (por el usuario, o el de la IA ya
  // confirmado) y no se pidió "elegir otro" -- se muestra fijo + el campo de
  // cantidad + un botón explícito para continuar, en vez de avanzar solo al
  // tocar un chip (no daba tiempo a completar la cantidad).
  if (attr === 'unidad_venta' && current?.value != null && !forceChooseAttrs.has(attr)) {
    return unidadVentaSelectedHtml(current.value);
  }

  const notice = (attr === 'principio_activo' && clarifyNotice) ? `
    <div class="mb-3.5 px-3.5 py-3 bg-amber-50 border border-amber-200 rounded-xl med-pop">
      <p class="text-[13px] font-medium text-amber-800 leading-snug">${escapeHtml(clarifyNotice.message || 'No reconocimos ese medicamento.')}</p>
      ${clarifyNotice.question ? `<p class="text-[12px] text-amber-700 mt-1">${escapeHtml(clarifyNotice.question)}</p>` : ''}
    </div>` : '';
  const cachedChips = facetsCache[attr];

  // Al volver a un paso ya completado, mostrar lo elegido y permitir
  // conservarlo (antes quedaba la lista en blanco, sin rastro de lo anterior).
  const currentBox = (current?.value != null && current.value !== '') ? `
      <div class="flex items-center gap-3 mb-3.5 px-3.5 py-2.5 bg-brand-50 border border-brand-100 rounded-xl">
        <div class="min-w-0 flex-1">
          <p class="text-[10.5px] font-semibold text-brand-700 uppercase tracking-wide">Elegido antes</p>
          <p class="text-[14px] font-semibold text-slate-900 truncate">${formatAttrValue(current.value)}</p>
        </div>
        <button type="button" data-confirm="${attr}" class="flex-shrink-0 px-3.5 py-2 bg-brand-600 hover:bg-brand-700 text-white text-[12.5px] font-semibold rounded-lg transition-colors">Mantener y continuar</button>
      </div>` : '';

  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-7 shadow-sm">
      <div class="flex items-center gap-2.5">
        <span class="step-badge">${index + 1}</span>
        <p class="text-[11px] font-semibold text-brand-600 uppercase tracking-wide">${STEP_LABELS[attr]}</p>
        <span class="ml-auto text-[11px] text-slate-400">Paso ${index + 1} de ${CORE_STEPS.length}</span>
        ${!NO_SKIP_STEPS.has(attr) ? `<button type="button" data-skip="${attr}" class="text-[11px] font-medium text-slate-400 hover:text-brand-700 border-l border-slate-200 pl-2.5">omitir</button>` : ''}
      </div>
      <p class="step-title">${pickerCaption(attr)}</p>
      ${currentBox}
      ${notice}
      <div class="flex flex-wrap gap-2 mb-3 min-h-[30px]" data-chips="${attr}">
        ${cachedChips ? chipsOrPriceListHtml(attr, cachedChips) : chipsLoadingHtml(attr)}
      </div>
      <input type="${NUMERIC_ATTRS.has(attr) ? 'number' : 'text'}" data-input="${attr}" autocomplete="off"
             placeholder="O escribe el valor y presiona Enter..."
             class="w-full text-[13.5px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all ${cachedChips ? '' : 'hidden'}" />
    </div>`;
}

// unidad_venta ya elegida -- fija en pantalla (con opción de cambiarla) +
// campo de cantidad + botón explícito para recién ahí avanzar de paso.
function unidadVentaSelectedHtml(value) {
  const cantidad = ficha.cantidad_requerida?.value;
  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-7 shadow-sm">
      <div class="flex items-center gap-2 mb-1">
        <p class="text-[11px] font-semibold text-brand-600 uppercase tracking-wide flex-1">${STEP_LABELS.unidad_venta}</p>
        <button type="button" data-choose="unidad_venta" class="text-[11px] text-slate-400 hover:text-slate-600">cambiar</button>
      </div>
      <p class="text-[20px] font-bold text-slate-900 mb-4">${formatAttrValue(value)}</p>
      <div class="pt-1">
        <label class="block text-[11px] text-slate-400 mb-1.5">¿Cuántas necesitas? (opcional, para el total estimado)</label>
        <input type="number" min="1" step="1" data-input-cantidad-req autocomplete="off"
               placeholder="Ej: 3" value="${cantidad != null ? escapeHtml(cantidad) : ''}"
               class="w-full text-[13.5px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white transition-all" />
      </div>
      <button type="button" data-confirm-unidad-venta class="w-full mt-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors">Continuar →</button>
    </div>`;
}

function pickerCaption(attr) {
  if (attr === 'principio_activo') return 'Elige el principio activo, o escribe el que necesitas:';
  if (attr === 'unidad_venta') return 'El precio varía mucho según la unidad (no es lo mismo comprar por Caja que por Comprimido) -- elige en qué unidad se compra:';
  const pa = ficha.principio_activo?.value;
  const paLabel = pa ? formatAttrValue(pa) : '';
  return `Opciones más compradas para ${paLabel}:`;
}

function companionScreenHtml() {
  const values = Array.isArray(ficha.principio_activo.value) ? ficha.principio_activo.value : [ficha.principio_activo.value];
  const listHtml = values.map((v, i) => `
    <span class="inline-flex items-center gap-1 text-[11.5px] font-medium bg-brand-50 text-brand-700 border border-brand-200 rounded-full pl-2.5 ${i === 0 ? 'pr-2.5' : 'pr-1.5'} py-1">
      ${escapeHtml(v)}
      ${i === 0
        ? '<span class="text-[9px] text-brand-400 ml-1">(principal)</span>'
        : `<button type="button" data-remove-principio="${i}" aria-label="Quitar" class="ml-0.5 text-brand-400 hover:text-red-500"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>`}
    </span>`).join('');

  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-7 shadow-sm">
      <p class="text-[11px] font-semibold text-violet-700 uppercase tracking-wide mb-3">¿Otro principio activo? (opcional)</p>
      <div class="flex flex-wrap gap-1.5 mb-3">${listHtml}</div>
      <p class="text-[13px] text-slate-400 mb-2">Suelen comprarse junto con ${formatAttrValue(values[0])}:</p>
      <div class="flex flex-wrap gap-2 mb-3 min-h-[30px]" data-companion-chips>
        ${companionsLoaded ? companionChipsHtml(companionsCache) : chipsLoadingHtml('principio_activo_companion')}
      </div>
      ${companionsLoaded ? `<input type="text" data-companion-input autocomplete="off"
             placeholder="O escribe otro principio activo y presiona Enter..."
             class="w-full text-[13.5px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:bg-white transition-all" />` : ''}
      <button type="button" data-continue-companion class="w-full py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors">Continuar →</button>
    </div>`;
}

function companionChipsHtml(values) {
  if (!values.length) return '<span class="text-[11px] text-slate-300 italic">sin combinaciones frecuentes registradas -- puedes escribir una abajo</span>';
  return values.map(v => `
    <button type="button" data-add-companion="${escapeHtml(v.value)}"
            class="text-[11.5px] font-medium border rounded-full px-2.5 py-1 bg-white text-violet-600 border-violet-200 hover:bg-violet-50 transition-colors">
      + ${escapeHtml(v.value)}
    </button>`).join('');
}

const hasAttrValue = (attr) => ficha[attr]?.value != null && ficha[attr].value !== '';

function attrTableRowHtml(attr) {
  const current = ficha[attr];
  const hasValue = hasAttrValue(attr);
  return `
    <div class="flex items-center gap-3 px-3.5 py-2.5 ${hasValue ? '' : 'bg-amber-50/40'}">
      <p class="text-[11px] text-slate-500 min-w-[128px] flex-shrink-0">${ATTR_LABELS[attr]}</p>
      ${hasValue ? `
        <p class="text-[12.5px] font-medium text-slate-700 flex-1 truncate">${formatAttrValue(current.value)} ${badgeFor(current.source)}</p>
        <button type="button" data-edit-optional="${attr}" class="text-[11px] text-brand-600 hover:text-brand-700 flex-shrink-0">cambiar</button>
      ` : `
        <p class="text-[12px] text-slate-400 italic flex-1">sin especificar</p>
        <button type="button" data-edit-optional="${attr}" class="text-[11px] font-medium text-amber-600 hover:text-amber-700 flex-shrink-0">+ definir</button>
      `}
    </div>`;
}

function detallesScreenHtml() {
  const unsetAttrs = OPTIONAL_ATTRS.filter(a => !hasAttrValue(a));
  const unsetNotice = unsetAttrs.length ? `
    <div class="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3 mb-3">
      <svg class="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"/></svg>
      <p class="text-[12px] text-amber-800 leading-snug">Lo que quede sin especificar (resaltado abajo) podría llegarte con distintos valores en la oferta -- distintos laboratorios o tamaños de envase.</p>
    </div>` : '';
  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <p class="text-[11px] font-semibold text-brand-600 uppercase tracking-wide mb-1">Detalles opcionales</p>
      <p class="text-[13px] text-slate-500 mb-3">Puedes omitir cualquiera de estos y continuar.</p>
      ${unsetNotice}
      <div class="border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
        ${OPTIONAL_ATTRS.map(attrTableRowHtml).join('')}
      </div>
      <button type="button" data-finish-optional class="w-full mt-4 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13.5px] font-semibold rounded-lg transition-colors">Continuar</button>
    </div>`;
}

// Editor de un solo detalle opcional, pantalla completa (como en Computadores).
function optionalAttrEditScreenHtml(attr) {
  const cachedChips = facetsCache[attr];
  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <div class="flex items-center gap-2 mb-4">
        <button type="button" data-back-optional aria-label="Volver"
                class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-brand-600 hover:bg-slate-50 transition-colors flex-shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>
        </button>
        <p class="text-[13px] font-semibold text-slate-700 flex-1">${ATTR_LABELS[attr]}</p>
        ${hasAttrValue(attr) ? `<button type="button" data-clear-optional="${attr}" class="text-[11px] text-slate-400 hover:text-red-500 flex-shrink-0">quitar valor</button>` : ''}
      </div>
      <div class="flex flex-wrap gap-1.5 mb-2 min-h-[26px]" data-chips="${attr}">${cachedChips ? chipsHtml(cachedChips) : chipsLoadingHtml(attr)}</div>
      <input type="${NUMERIC_ATTRS.has(attr) ? 'number' : 'text'}" data-input="${attr}" autocomplete="off"
             placeholder="Escribe y presiona Enter..."
             class="w-full text-[13px] bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:bg-white ${cachedChips ? '' : 'hidden'}" />
      ${hasAttrValue(attr) ? `<p class="text-[11.5px] text-slate-500 mt-3">Actual: <b class="text-slate-700">${formatAttrValue(ficha[attr].value)}</b></p>` : ''}
    </div>`;
}

// La unidad de compra define cómo se compara el precio: se destaca aparte
// del resto de los datos, junto con la cantidad a comprar.
function unidadCompraBoxHtml() {
  const u = ficha.unidad_venta?.value;
  if (u == null || u === '') return '';
  const cant = ficha.cantidad_requerida?.value;
  return `
      <div class="flex items-center gap-3 mb-4 px-4 py-3 bg-brand-50 border border-brand-200 rounded-xl">
        <div class="min-w-0 flex-1">
          <p class="text-[10.5px] font-semibold text-brand-700 uppercase tracking-wide">Unidad de compra</p>
          <p class="text-[17px] font-bold text-brand-900 leading-tight">${formatAttrValue(u)}</p>
        </div>
        ${cant ? `<div class="text-right flex-shrink-0">
          <p class="text-[10.5px] font-semibold text-brand-700 uppercase tracking-wide">Cantidad a comprar</p>
          <p class="text-[17px] font-bold text-brand-900 leading-tight">${escapeHtml(Number(cant).toLocaleString('es-CL'))}</p>
        </div>` : ''}
      </div>`;
}

function resumenScreenHtml() {
  const coreChips = CORE_STEPS.filter(a => a !== 'unidad_venta').map(attr => {
    const v = ficha[attr]?.value;
    return (v != null && v !== '')
      ? `<span class="inline-flex items-center gap-1 text-[12px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2.5 py-1">${formatAttrValue(v)}</span>`
      : '';
  }).filter(Boolean).join(' ');
  const optionalChips = OPTIONAL_ATTRS.map(attr => {
    const v = ficha[attr]?.value;
    if (v == null || v === '') return '';
    return `<span class="inline-flex items-center gap-1 text-[11px] font-medium bg-slate-50 text-slate-600 border border-slate-200 rounded-full px-2.5 py-1">${ATTR_LABELS[attr]}: ${formatAttrValue(v)}</span>`;
  }).filter(Boolean).join(' ');

  return `
    <div class="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <p class="text-[11px] font-semibold text-emerald-600 uppercase tracking-wide mb-3">${editingItemId ? `Editando la compra ${cart.findIndex(i => i.id === editingItemId) + 1}` : '✓ Requerimiento listo'}</p>
      <div class="flex flex-wrap gap-1.5 mb-2">${coreChips}</div>
      ${optionalChips ? `<div class="flex flex-wrap gap-1.5 mb-3">${optionalChips}</div>` : '<div class="mb-1"></div>'}
      ${unidadCompraBoxHtml()}

      <div id="med-price-panel-full" class="mb-4"></div>

      <button type="button" data-agregar class="w-full flex items-center justify-center gap-2 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-[13.5px] font-semibold rounded-xl transition-colors mb-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        ${editingItemId ? 'Guardar cambios' : 'Agregar a la cotización'}
      </button>
      <button type="button" data-nuevo-requerimiento class="w-full text-[12px] text-slate-400 hover:text-brand-600 py-1 transition-colors">${editingItemId ? 'Cancelar edición' : 'Empezar otro requerimiento sin guardar este'}</button>

      <div id="med-historial-wrap" class="mt-4 pt-4 border-t border-slate-100">
        <button id="med-historial-toggle" type="button" class="w-full flex items-center justify-between text-[12px] font-medium text-slate-500 hover:text-brand-600 transition-colors">
          <span class="flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            Ver compras anteriores registradas
          </span>
          <svg id="med-historial-chevron" class="w-3.5 h-3.5 transition-transform" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div id="med-historial-body" class="hidden mt-3">
          <div class="flex items-center justify-end mb-2.5">
            <select id="med-historial-sort" class="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-slate-600 focus:outline-none focus:ring-2 focus:ring-brand-500 cursor-pointer">
              <option value="fecha_desc">Más reciente</option>
              <option value="precio_asc">Precio: menor a mayor</option>
              <option value="precio_desc">Precio: mayor a menor</option>
            </select>
          </div>
          <div id="med-historial-results" class="space-y-2"></div>
        </div>
      </div>
    </div>`;
}

// Cada entrada es una función (no una lista fija) para poder armar el
// mensaje con datos reales de la ficha actual (ej. el principio activo ya
// elegido) -- "acorde al input del usuario", no siempre el mismo texto
// genérico.
const LOADING_MESSAGES = {
  principio_activo: () => [
    'Buscando principios activos relacionados...',
    'Revisando principios activos más comprados...',
    'Buscando sugerencias de principio activo...',
  ],
  principio_activo_companion: () => {
    const pa = ficha.principio_activo?.value;
    const label = pa ? formatAttrValue(pa) : null;
    return label ? [
      `Buscando qué suele comprarse junto con ${label}...`,
      `Revisando combinaciones habituales de ${label}...`,
      `Buscando principios activos que acompañan a ${label}...`,
    ] : ['Buscando combinaciones habituales...', 'Revisando qué suele comprarse junto con esto...'];
  },
  forma_farmaceutica: () => {
    const pa = ficha.principio_activo?.value;
    const label = pa ? formatAttrValue(pa) : null;
    return label ? [
      `Buscando formas farmacéuticas de ${label}...`,
      `Revisando presentaciones habituales de ${label}...`,
    ] : ['Buscando formas farmacéuticas posibles...', 'Revisando presentaciones más compradas...'];
  },
  concentracion: () => {
    const pa = ficha.principio_activo?.value;
    const label = pa ? formatAttrValue(pa) : null;
    return label ? [
      `Buscando concentraciones habituales de ${label}...`,
      `Revisando dosis más compradas de ${label}...`,
    ] : ['Buscando concentraciones habituales...', 'Revisando dosis más compradas...'];
  },
  unidad_venta: () => {
    const pa = ficha.principio_activo?.value;
    const label = pa ? formatAttrValue(pa) : null;
    return label ? [
      `Comparando precios por unidad de ${label}...`,
      `Buscando en qué unidades se compra ${label}...`,
    ] : ['Buscando unidades de compra posibles...', 'Comparando precios por unidad...'];
  },
  laboratorio: () => {
    const pa = ficha.principio_activo?.value;
    const label = pa ? formatAttrValue(pa) : null;
    return label ? [`Buscando laboratorios que venden ${label}...`, `Revisando fabricantes habituales de ${label}...`]
      : ['Buscando laboratorios habituales...', 'Revisando fabricantes más comprados...'];
  },
  cantidad: () => [
    'Buscando tamaños de envase habituales...',
    'Revisando envases más comprados...',
  ],
};

function chipsLoadingHtml(attr) {
  const gen = LOADING_MESSAGES[attr];
  const pool = gen ? gen() : ['Buscando sugerencias...'];
  const msg = pool[Math.floor(Math.random() * pool.length)];
  return loadingBlockHtml(msg);
}

function animateIn(el) {
  if (!el) return;
  el.classList.remove('med-pop');
  void el.offsetWidth; // fuerza reflow para que la animación se repita
  el.classList.add('med-pop');
}

function chipsHtml(values) {
  if (!values.length) return `<span class="text-[11px] text-slate-300 italic">sin sugerencias -- escribe el valor</span>`;
  return values.map(v => `
    <button type="button" data-chip="${escapeHtml(v.value)}"
            class="facet-chip text-[11.5px] font-medium border rounded-full px-2.5 py-1 bg-white text-slate-600 border-slate-200 hover:border-brand-300 hover:text-brand-700 transition-colors">
      ${escapeHtml(v.value)}
    </button>`).join('');
}

// unidad_venta se muestra distinto: filas (no pastillas) con el precio
// mediana de esa unidad al lado -- deja comparar de un vistazo (ej.
// "Comprimido $56 c/u" vs "Caja $15.417 c/u") en vez de mostrar un solo
// precio ambiguo antes de elegir. Mismo data-chip que el resto -- el click
// se ata igual (bindChipButtons).
function chipsOrPriceListHtml(attr, values) {
  if (attr !== 'unidad_venta') return chipsHtml(values);
  if (!values.length) return `<span class="text-[11px] text-slate-300 italic">sin sugerencias -- escribe el valor</span>`;
  return `<div class="w-full space-y-1.5">` + values.map(v => `
    <button type="button" data-chip="${escapeHtml(v.value)}"
            class="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50/40 transition-colors text-left">
      <span class="text-[13px] font-medium text-slate-700">${escapeHtml(v.value)}</span>
      ${v.mediana != null
        ? `<span class="text-[12px] font-semibold text-emerald-700 flex-shrink-0">${formatCLP(v.mediana)} <span class="text-slate-400 font-normal">c/u</span></span>`
        : ''}
    </button>`).join('') + `</div>`;
}

/* ── Eventos de la pantalla activa ───────────────────────────────── */

function bindScreenEvents() {
  const addedMore = screenEl.querySelector('[data-added-more]');
  if (addedMore) addedMore.addEventListener('click', () => { addedNotice = null; renderScreen(); });
  const analizarBtn = document.getElementById('med-analizar-btn');
  if (analizarBtn) analizarBtn.addEventListener('click', analizar);
  const textoInput = document.getElementById('med-texto-input');
  if (textoInput) {
    textoInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) analizar();
    });
    textoInput.focus();
  }
  screenEl.querySelectorAll('[data-input-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ti = document.getElementById('med-texto-input');
      if (ti) textoDraft = ti.value;
      inputMode = btn.dataset.inputTab;
      renderScreen();
    });
  });
  const fillExample = screenEl.querySelector('[data-fill-example]');
  if (fillExample) fillExample.addEventListener('click', () => {
    const ti = document.getElementById('med-texto-input');
    if (!ti) return;
    ti.value = 'Paracetamol 500 mg comprimidos';
    ti.dispatchEvent(new Event('input'));
    ti.focus();
  });
  const skipToManual = screenEl.querySelector('[data-skip-to-manual]');
  if (skipToManual) skipToManual.addEventListener('click', () => { showingTextScreen = false; renderScreen(); });

  screenEl.querySelectorAll('[data-edit-optional]').forEach(btn => {
    btn.addEventListener('click', () => editOptionalAttr(btn.dataset.editOptional));
  });
  screenEl.querySelectorAll('[data-back-optional]').forEach(btn => {
    btn.addEventListener('click', () => { editingOptionalAttr = null; renderScreen(); });
  });
  screenEl.querySelectorAll('[data-clear-optional]').forEach(btn => {
    btn.addEventListener('click', () => clearOptionalAttr(btn.dataset.clearOptional));
  });
  const nuevoReqCompleto = screenEl.querySelector('[data-nuevo-requerimiento-completo]');
  if (nuevoReqCompleto) nuevoReqCompleto.addEventListener('click', confirmarNuevoRequerimiento);
  screenEl.querySelectorAll('[data-finish-optional]').forEach(btn => {
    btn.addEventListener('click', () => advanceStep());
  });
  screenEl.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.confirm;
      if (a === 'unidad_venta') {
        // No avanza todavía -- pasa a la pantalla "elegida + cantidad".
        confirmedAttrs.add(a);
        forceChooseAttrs.delete(a);
        renderScreen();
      } else {
        onAttrConfirmed(a);
      }
    });
  });
  const confirmUnidadVentaBtn = screenEl.querySelector('[data-confirm-unidad-venta]');
  if (confirmUnidadVentaBtn) confirmUnidadVentaBtn.addEventListener('click', () => onAttrConfirmed('unidad_venta'));
  screenEl.querySelectorAll('[data-choose]').forEach(btn => {
    btn.addEventListener('click', () => {
      forceChooseAttrs.add(btn.dataset.choose);
      renderScreen();
      refreshFacetsFor([btn.dataset.choose]);
    });
  });
  screenEl.querySelectorAll('[data-skip]').forEach(btn => {
    btn.addEventListener('click', () => advanceStep());
  });
  screenEl.querySelectorAll('[data-continue-companion]').forEach(btn => {
    btn.addEventListener('click', () => { companionsPending = false; advanceStep(); });
  });
  screenEl.querySelectorAll('[data-add-companion]').forEach(btn => {
    btn.addEventListener('click', () => addCompanion(btn.dataset.addCompanion));
  });
  screenEl.querySelectorAll('[data-remove-principio]').forEach(btn => {
    btn.addEventListener('click', () => removeCompanion(Number(btn.dataset.removePrincipio)));
  });
  const companionInput = screenEl.querySelector('[data-companion-input]');
  if (companionInput) {
    companionInput.addEventListener('input', () => filterCompanionChips(companionInput.value));
    companionInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && companionInput.value.trim()) addCompanion(companionInput.value.trim());
    });
  }
  screenEl.querySelectorAll('[data-chip]').forEach(btn => {
    const container = btn.closest('[data-chips]');
    const attr = container ? container.dataset.chips : null;
    if (attr) btn.addEventListener('click', () => pickValue(attr, btn.dataset.chip));
  });
  screenEl.querySelectorAll('[data-input]').forEach(input => {
    const attr = input.dataset.input;
    input.addEventListener('input', () => filterChipsFor(attr, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        pickValue(attr, NUMERIC_ATTRS.has(attr) ? Number(input.value) : input.value.trim());
      }
    });
  });

  const cantidadReqInput = screenEl.querySelector('[data-input-cantidad-req]');
  if (cantidadReqInput) {
    const syncLocal = () => {
      const raw = cantidadReqInput.value.trim();
      const n = raw ? Number(raw) : null;
      ficha.cantidad_requerida = (n != null && !Number.isNaN(n) && n > 0)
        ? { attribute: 'cantidad_requerida', value: n, source: 'user', normalized: true, score: 1 }
        : null;
    };
    cantidadReqInput.addEventListener('input', syncLocal);
    cantidadReqInput.addEventListener('blur', () => {
      if (ficha.cantidad_requerida) manualUpdate('cantidad_requerida', ficha.cantidad_requerida.value);
    });
    cantidadReqInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') cantidadReqInput.blur(); });
  }

  const agregarBtn = screenEl.querySelector('[data-agregar]');
  if (agregarBtn) agregarBtn.addEventListener('click', agregarRequerimiento);
  const nuevoBtn = screenEl.querySelector('[data-nuevo-requerimiento]');
  if (nuevoBtn) nuevoBtn.addEventListener('click', () => empezarNuevoRequerimiento(false));

  const historialToggle = screenEl.querySelector('#med-historial-toggle');
  if (historialToggle) {
    historialToggle.addEventListener('click', () => {
      const body = document.getElementById('med-historial-body');
      const chevron = document.getElementById('med-historial-chevron');
      const opening = body.classList.contains('hidden');
      body.classList.toggle('hidden');
      chevron.classList.toggle('rotate-180', opening);
      if (opening) loadHistorial();
    });
  }
  const historialSort = screenEl.querySelector('#med-historial-sort');
  if (historialSort) historialSort.addEventListener('change', loadHistorial);
}

backBtn.addEventListener('click', goBack);

// Vuelve a atar SOLO los botones de chips dentro de un contenedor puntual
// (no toda la pantalla) -- a diferencia de bindScreenEvents(), que re-ata
// TODO de nuevo cada vez que se llama, incluido el <input> de texto libre
// que sigue siendo el mismo nodo del DOM: llamar bindScreenEvents() en
// cada tecleo apilaba un listener 'input' nuevo encima de los anteriores
// sin sacar los viejos, duplicando la cantidad de llamadas en cada letra
// (crecimiento exponencial) hasta trabar el navegador con textos largos.
function bindChipButtons(container) {
  if (!container) return;
  container.querySelectorAll('[data-chip]').forEach(btn => {
    const c = btn.closest('[data-chips]');
    const attr = c ? c.dataset.chips : null;
    if (attr) btn.addEventListener('click', () => pickValue(attr, btn.dataset.chip));
  });
}

function bindCompanionButtons(container) {
  if (!container) return;
  container.querySelectorAll('[data-add-companion]').forEach(btn => {
    btn.addEventListener('click', () => addCompanion(btn.dataset.addCompanion));
  });
}

// unidad_venta usa un endpoint distinto (precio por unidad, no solo
// valor+conteo) -- ahí es donde tiene sentido comparar precios (Comprimido
// $56 c/u vs Caja $15.417 c/u), a diferencia de estimate_price() que recién
// calcula un número una vez que ya se eligió una unidad concreta.
function facetEndpointFor(attr) {
  return attr === 'unidad_venta'
    ? `/api/medicamentos/precio_por_unidad/${SESSION_ID}`
    : `/api/medicamentos/facets/${SESSION_ID}?attr=${encodeURIComponent(attr)}`;
}

function refreshFacetsFor(attrs) {
  attrs.forEach(attr => {
    apiFetch(facetEndpointFor(attr), { headers: _headers() })
      .then(r => r && r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        facetsCache[attr] = data.values || [];
        const container = screenEl.querySelector(`[data-chips="${attr}"]`);
        if (container) {
          container.innerHTML = chipsOrPriceListHtml(attr, facetsCache[attr]);
          animateIn(container);
          bindChipButtons(container);
          // El input de búsqueda manual arranca oculto (data-input, hermano
          // del contenedor de chips) hasta que las sugerencias terminan de
          // cargar -- recién ahí se muestra, para no dejarlo ahí sin
          // sentido mientras se ve el mensaje de carga.
          const input = container.parentElement && container.parentElement.querySelector(`[data-input="${attr}"]`);
          if (input) input.classList.remove('hidden');
        }
      })
      .catch(() => {});
  });
}

// Precarga en segundo plano los facets del/los siguiente(s) paso(s), sin
// tocar el DOM -- para cuando el usuario llegue ya estén en facetsCache y
// stepScreenHtml/optionalAttrHtml los muestren de inmediato (sin skeleton).
function prefetchFacets(attrs) {
  attrs.forEach(attr => {
    if (facetsCache[attr]) return; // ya está en caché, no repetir
    apiFetch(facetEndpointFor(attr), { headers: _headers() })
      .then(r => r && r.ok ? r.json() : null)
      .then(data => { if (data) facetsCache[attr] = data.values || []; })
      .catch(() => {});
  });
}

function filterCompanionChips(query) {
  const container = screenEl.querySelector('[data-companion-chips]');
  if (!container) return;
  const q = query.trim().toLowerCase();
  const currentVals = (Array.isArray(ficha.principio_activo.value) ? ficha.principio_activo.value : [ficha.principio_activo.value])
    .map(v => v.toLowerCase());

  let base;
  if (q) {
    base = (validValuesCache.principio_activo || [])
      .filter(v => v.toLowerCase().includes(q) && !currentVals.includes(v.toLowerCase()))
      .slice(0, 12)
      .map(v => ({ value: v, count: null }));
  } else {
    base = companionsCache;
  }
  container.innerHTML = base.length
    ? companionChipsHtml(base)
    : '<span class="text-[11px] text-slate-300 italic">sin coincidencias -- puedes escribirlo igual y presionar Enter</span>';
  animateIn(container);
  bindCompanionButtons(container);
}

function filterChipsFor(attr, query) {
  const container = screenEl.querySelector(`[data-chips="${attr}"]`);
  if (!container) return;
  const q = query.trim().toLowerCase();

  let base = facetsCache[attr] || [];
  if (DICT_ATTRS.has(attr) && validValuesCache[attr] && q) {
    base = validValuesCache[attr]
      .filter(v => v.toLowerCase().includes(q))
      .slice(0, 12)
      .map(v => ({ value: v, count: null }));
  } else if (q) {
    base = base.filter(v => v.value.toLowerCase().includes(q));
  }
  container.innerHTML = chipsOrPriceListHtml(attr, base);
  animateIn(container);
  bindChipButtons(container);
}

/* ── Panel de precio (solo existe en la pantalla de resumen) ────── */

function renderPricePanel() {
  const panel = document.getElementById('med-price-panel-full');
  if (!panel) return; // no estamos en la pantalla de resumen

  if (!priceData) {
    panel.innerHTML = `
      <div class="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
        <p class="text-[12.5px] text-slate-400">No hay compras registradas para esta combinación de atributos todavía.</p>
      </div>`;
    return;
  }

  const { p25, mediana, p75, count } = priceData;
  const min = p25, max = p75;
  const range = Math.max(max - min, 1);
  const midPct = Math.min(100, Math.max(0, ((mediana - min) / range) * 100));

  const cantidadReq = ficha.cantidad_requerida?.value;
  const unidadLabel = ficha.unidad_venta?.value ? formatAttrValue(ficha.unidad_venta.value) : 'unidad';
  const totalHtml = cantidadReq ? `
    <div class="mt-3 pt-3 border-t border-slate-200">
      <p class="text-[10.5px] font-semibold text-slate-500 uppercase tracking-wide mb-1">Total estimado (${escapeHtml(cantidadReq)} × ${unidadLabel})</p>
      <p class="text-[19px] font-bold text-emerald-800 leading-none mb-0.5">${formatCLP(mediana * cantidadReq)}</p>
      <p class="text-[11px] text-slate-400">rango ${formatCLP(min * cantidadReq)} – ${formatCLP(max * cantidadReq)}</p>
    </div>` : '';

  panel.innerHTML = `
    <div class="bg-slate-50 border border-slate-200 rounded-xl p-4">
      <div class="flex items-center justify-between mb-2.5">
        <p class="text-[10.5px] font-semibold text-slate-500 uppercase tracking-wide">Estimación (histórico Compra Ágil)</p>
        <span class="text-[11px] text-slate-400">${escapeHtml(count)} compra${count === 1 ? '' : 's'}</span>
      </div>
      <p class="text-[22px] font-bold text-emerald-700 leading-none mb-1">${formatCLP(mediana)}</p>
      <p class="text-[11.5px] text-slate-400 mb-3">precio unitario (mediana), IVA incluido</p>
      <div class="relative h-2 bg-slate-100 rounded-full mb-1.5">
        <div class="absolute h-2 bg-emerald-200 rounded-full" style="left:0%;width:100%"></div>
        <div class="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-emerald-600 rounded-full border-2 border-white shadow" style="left:calc(${midPct}% - 5px)"></div>
      </div>
      <div class="flex items-center justify-between text-[11px] text-slate-400">
        <span>${formatCLP(min)}</span>
        <span>${formatCLP(max)}</span>
      </div>
      ${totalHtml}
    </div>`;
}

/* ── Historial (dentro de la pantalla de resumen) ───────────────── */

let historialResults = [];
let historialPage = 0;
const HISTORIAL_PAGE = 5;

function renderHistorialPage() {
  const el = document.getElementById('med-historial-results');
  if (!el) return;
  const pages = Math.max(1, Math.ceil(historialResults.length / HISTORIAL_PAGE));
  historialPage = Math.max(0, Math.min(historialPage, pages - 1));
  const slice = historialResults.slice(historialPage * HISTORIAL_PAGE, (historialPage + 1) * HISTORIAL_PAGE);
  el.innerHTML = slice.map(historialCardHtml).join('') + (pages > 1 ? `
    <div class="flex items-center justify-between pt-2.5 mt-1 border-t border-slate-100">
      <button type="button" data-historial-page="-1" ${historialPage <= 0 ? 'disabled' : ''} class="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">← Anterior</button>
      <span class="text-[11px] text-slate-400">Página ${historialPage + 1} de ${pages} · ${historialResults.length} productos</span>
      <button type="button" data-historial-page="1" ${historialPage >= pages - 1 ? 'disabled' : ''} class="text-[11px] font-medium px-2.5 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:border-brand-300 hover:text-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Siguiente →</button>
    </div>` : '');
}

function loadHistorial() {
  const sortEl = document.getElementById('med-historial-sort');
  const resultsEl = document.getElementById('med-historial-results');
  if (!sortEl || !resultsEl) return;
  const sort = sortEl.value;
  resultsEl.innerHTML = `<p class="text-[12px] text-slate-400 text-center py-6">Cargando...</p>`;
  resultsEl.onclick = (e) => {
    const btn = e.target.closest('[data-historial-page]');
    if (!btn || btn.disabled) return;
    historialPage += Number(btn.dataset.historialPage);
    renderHistorialPage();
  };
  apiFetch(`/api/medicamentos/historial/${SESSION_ID}?sort=${encodeURIComponent(sort)}`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      historialResults = data.results || [];
      historialPage = 0;
      if (!historialResults.length) {
        resultsEl.innerHTML = `<p class="text-[12px] text-slate-400 text-center py-6">No hay compras registradas para esta combinación.</p>`;
        return;
      }
      renderHistorialPage();
    })
    .catch(() => {
      resultsEl.innerHTML = `<p class="text-[12px] text-red-400 text-center py-6">No se pudo cargar el historial.</p>`;
    });
}

function historialCardHtml(m) {
  const meta = [
    m.laboratorio && m.laboratorio !== 'No especificado' ? escapeHtml(m.laboratorio) : null,
    m.anio ? String(m.anio) : null,
  ].filter(Boolean).join(' · ');
  const url = (m.ca_urls || [])[0];
  return `
    <div class="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2.5">
      <p class="tx-desc text-[12.5px] font-medium text-slate-700 leading-snug">${escapeHtml(m.nombre_producto || 'Sin nombre')}</p>
      <div class="flex items-center justify-between mt-1">
        <p class="text-[11px] text-slate-400">${meta}</p>
        <p class="text-[12.5px] font-semibold text-slate-600">${m.precio_mediana != null ? formatCLP(m.precio_mediana) : '—'}</p>
      </div>
      ${url ? `<a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 mt-1.5 text-[10.5px] font-semibold text-brand-700 hover:text-brand-800">Ver en Mercado Público</a>` : ''}
    </div>`;
}

/* ── Carrito de requerimientos ──────────────────────────────────── */

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
  cartPanelCount.textContent = cartSummaryText();
  const docActions = document.getElementById('doc-actions');
  if (docActions) docActions.classList.toggle('hidden', n === 0);
  renderDocPreview();
}

// Vista previa en vivo del documento de requerimientos (panel a la derecha,
// solo en pantallas grandes) -- muestra cada requerimiento ya en el
// carrito, más el que se está armando ahora mismo como "en construcción".
// No incluye las descripciones IA para licitación (esas son lazy, solo se
// generan al descargar el PDF -- generarlas acá en vivo gastaría tokens
// por cada tecleo sin necesidad).
function renderDocPreview() {
  const wrap = document.getElementById('med-doc-preview');
  if (!wrap) return;

  const draftAttrs = {};
  ATTR_ORDER.forEach(a => { if (ficha[a]?.value != null && ficha[a]?.value !== '') draftAttrs[a] = ficha[a].value; });
  const hasDraft = !showingTextScreen && Object.keys(draftAttrs).length > 0;

  if (!cart.length && !hasDraft) {
    wrap.innerHTML = `
      <div class="pdf-wrap">
        <div class="doc-logo">${DOC_LOGO_HTML}</div>
        <h1>Especificaciones técnicas</h1>
        <p class="doc-empty">A medida que vayas armando requerimientos, acá vas a ver el documento tomando forma.</p>
      </div>`;
    return;
  }

  const fecha = new Date().toLocaleDateString('es-CL', { year: 'numeric', month: 'long', day: 'numeric' });
  const referencia = 'REQ-' + (String(SESSION_ID).replace(/-/g, '').slice(0, 6).toUpperCase() || '000000');
  const editIdx = cart.findIndex(i => i.id === editingItemId);
  const replacing = hasDraft && editIdx >= 0;
  const draftBlock = (tag, idx) => `
    <div class="req-draft">
      <p class="req-draft-tag">${tag}</p>
      ${reqBlockHtml({ nombre: null, atributos: draftAttrs, descripcion: null }, idx)}
    </div>`;
  const nItems = cart.length + (hasDraft && !replacing ? 1 : 0);
  const sections = cart.map((item, i) => (replacing && i === editIdx) ? draftBlock('En edición', i + 1) : reqBlockHtml(item, i + 1)).join('');
  const draftHtml = (hasDraft && !replacing) ? `
    <div class="req-draft">
      <p class="req-draft-tag">En construcción</p>
      ${reqBlockHtml({ nombre: null, atributos: draftAttrs, descripcion: null }, cart.length + 1)}
    </div>` : '';

  wrap.innerHTML = `
    <div class="pdf-wrap">
      <div class="doc-logo">${DOC_LOGO_HTML}</div>
      <h1>Especificaciones técnicas</h1>
      <div class="doc-meta">
        <div><span>Fecha de emisión</span><b>${escapeHtml(fecha)}</b></div>
        <div><span>Referencia</span><b>${escapeHtml(referencia)}</b></div>
        <div><span>Categoría</span><b>Medicamentos</b></div>
        <div><span>Compras</span><b>${nItems}</b></div>
      </div>
      ${sections}
      ${draftHtml}
      <div class="ftr">Documento generado por el Asistente IA · Compras Públicas</div>
    </div>`;
}

function resetWizardState() {
  editingItemId = null;
  editingOptionalAttr = null;
  inputMode = 'texto';
  textoDraft = '';
  ficha = {};
  facetsCache = {};
  priceData = null;
  priceHintDesde = null;
  showingTextScreen = true;
  currentStepIndex = 0;
  confirmedAttrs.clear();
  forceChooseAttrs.clear();
  companionsPending = false;
  companionsCache = [];
  companionsLoaded = false;
  clarifyNotice = null;
  currentTextoOriginal = '';
}

function empezarNuevoRequerimiento() {
  apiFetch(`/api/medicamentos/reset/${SESSION_ID}`, { method: 'POST', headers: _headers() }).catch(() => {});
  resetWizardState();
  renderScreen();
}

// Descripción IA de un solo requerimiento (no del carrito completo) --
// UNA llamada al LLM, se usa al aceptar un requerimiento (ver
// agregarRequerimiento) para que la vista previa ya la muestre sin
// esperar a la descarga del PDF, y sin gastar tokens en cada tecleo del
// borrador (solo se llama una vez, cuando el requerimiento ya quedó fijo).
function describeItem(item) {
  return apiFetch('/api/medicamentos/describe', {
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
  if (!confirmedAttrs.has('principio_activo')) return;
  const atributos = {};
  ATTR_ORDER.forEach(a => {
    if (ficha[a]?.value != null && ficha[a]?.value !== '') atributos[a] = ficha[a].value;
  });
  const texto_original = currentTextoOriginal;
  const prev = editingItemId ? cart.find(i => i.id === editingItemId) : null;
  const item = {
    id: prev ? prev.id : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    texto_original,
    atributos,
    price: priceData,
    cantidad: Number(atributos.cantidad_requerida) > 0 ? Number(atributos.cantidad_requerida) : 1,
  };
  if (prev) cart[cart.indexOf(prev)] = item; else cart.push(item);
  saveCart();
  renderCartBar();
  addedNotice = { sid: SESSION_ID, updated: !!prev, itemId: item.id };
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
    .map(a => `<span class="text-[11px] text-slate-500">${ATTR_LABELS[a]}: <strong class="text-slate-700">${formatAttrValue(atributos[a])}</strong></span>`)
    .join(' &nbsp;·&nbsp; ');
}

/* ── Bloque "documento" de un requerimiento -- MISMO markup para el PDF
   real (buildAndSavePDF) y la vista previa en vivo (renderDocPreview), así
   nunca se desincronizan. Usa las clases .req/.req-title/.req-texto/
   .req-desc/.req-table definidas en medicamentos.html. La vista previa
   nunca pasa descripcion (esa la genera la IA solo al descargar el PDF de
   verdad -- generarla en vivo gastaría tokens en cada tecleo). ──────── */

// Título del ítem: el nombre corto generado por el modelo; mientras no llega
// (o si falla), principio activo + forma + concentración.
function itemTitleMed(item) {
  if (item.nombre) return item.nombre;
  const a = item.atributos || {};
  const parts = ['principio_activo', 'forma_farmaceutica', 'concentracion']
    .filter(k => a[k] != null && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length))
    .map(k => attrTextMed(k, a[k]));
  return parts.join(' · ') || 'Medicamento requerido';
}

// Varios principios activos son un producto combinado ("+"), no alternativas.
function attrTextMed(k, v) {
  return Array.isArray(v) ? v.map(upperText).join(k === 'principio_activo' ? ' + ' : ' o ') : upperText(v);
}

function joinEsMed(list) {
  return list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' y ' + list[list.length - 1];
}

function reqBlockHtml(item, index) {
  const a = item.atributos || {};
  const specs = ATTR_ORDER.filter(k => k !== 'cantidad_requerida' && a[k] != null && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length));
  const rows = specs
    .map(k => `<tr><td class="lbl">${escapeHtml(ATTR_LABELS[k] || k)}</td><td class="val">${escapeHtml(attrTextMed(k, a[k]))}</td></tr>`)
    .join('');
  const free = ATTR_ORDER
    .filter(k => k !== 'cantidad_requerida' && !specs.includes(k))
    .map(k => String(ATTR_LABELS[k] || k).charAt(0).toLowerCase() + String(ATTR_LABELS[k] || k).slice(1));
  const qty = Number(item.cantidad) > 0 ? Number(item.cantidad) : (Number(a.cantidad_requerida) > 0 ? Number(a.cantidad_requerida) : 1);
  return `
    <div class="req">
      <div class="req-head">
        <span class="req-num">${String(index).padStart(2, '0')}</span>
        <span class="req-name">${escapeHtml(itemTitleMed(item))}</span>
        <span class="req-qty">Cantidad <b>${qty.toLocaleString('es-CL')}</b></span>
      </div>
      ${item.descripcion ? `<div class="req-descbox"><p class="req-lbl req-lbl-blue">Descripción del producto requerido</p><p>${escapeHtml(item.descripcion)}</p></div>` : ''}
      <p class="req-lbl">Características técnicas requeridas</p>
      <table class="req-table">${rows}</table>
      ${free.length && rows ? `<p class="req-free"><b>Sin exigencia:</b> ${escapeHtml(joinEsMed(free))}.</p>` : ''}
    </div>`;
}

// "2 compras · 5 unidades" bajo el título del panel.
function cartSummaryText() {
  const n = cart.length;
  const u = cart.reduce((t, i) => t + (Number(i.cantidad) > 0 ? Number(i.cantidad) : 1), 0);
  return `${n} compra${n === 1 ? '' : 's'} · ${u.toLocaleString('es-CL')} unidad${u === 1 ? '' : 'es'}`;
}

function cartItemCardHtml(item, i) {
  const a = item.atributos || {};
  const qty = Number(item.cantidad) > 0 ? Number(item.cantidad) : (Number(a.cantidad_requerida) > 0 ? Number(a.cantidad_requerida) : 1);
  const specs = ATTR_ORDER
    .filter(k => k !== 'cantidad_requerida' && a[k] != null && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length))
    .map(k => attrTextMed(k, a[k]))
    .join(' · ');
  return `
    <div class="flex gap-4 py-4 border-b border-slate-100 last:border-b-0">
      <span class="w-5 flex-shrink-0 pt-0.5 text-[13px] font-semibold text-brand-600">${String(i + 1).padStart(2, '0')}</span>
      <div class="flex-1 min-w-0">
        <p class="text-[14.5px] font-semibold text-slate-900 leading-snug">${escapeHtml(itemTitleMed(item))}</p>
        <p class="text-[12.5px] text-slate-500 mt-1 leading-relaxed line-clamp-2">${escapeHtml(item.nombre ? specs : (item.texto_original || specs))}</p>
        <div class="flex items-center justify-between gap-3 mt-3">
          <div class="qty-stepper">
            <button type="button" data-cart-step="-1" data-cart-id="${item.id}" aria-label="Disminuir cantidad">&minus;</button>
            <input id="qty-${item.id}" type="number" min="1" step="1" inputmode="numeric" data-cart-qty="${item.id}" value="${qty}" aria-label="Cantidad" />
            <button type="button" data-cart-step="1" data-cart-id="${item.id}" aria-label="Aumentar cantidad">+</button>
          </div>
          <div class="flex items-center gap-4">
            <button type="button" data-cart-edit="${item.id}" class="text-[12.5px] text-slate-500 hover:text-brand-700 transition-colors">Editar</button>
            <button type="button" data-cart-remove="${item.id}" class="text-[12.5px] text-slate-500 hover:text-red-600 transition-colors">Quitar</button>
          </div>
        </div>
      </div>
    </div>`;
}

function renderCartPanel() {
  if (!cart.length) {
    cartItemsEl.innerHTML = `<div class="text-center py-16 text-slate-400"><p class="text-[13px]">Aún no has agregado compras a tu cotización.</p></div>`;
    return;
  }
  cartItemsEl.innerHTML = cart.map((item, i) => cartItemCardHtml(item, i)).join('');
  cartItemsEl.querySelectorAll('[data-cart-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      cart = cart.filter(i => i.id !== btn.dataset.cartRemove);
      saveCart();
      renderCartBar();
      renderCartPanel();
    });
  });
  cartItemsEl.querySelectorAll('[data-cart-step]').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById('qty-' + btn.dataset.cartId);
      if (!inp) return;
      inp.value = Math.max(1, (parseInt(inp.value, 10) || 1) + Number(btn.dataset.cartStep));
      inp.dispatchEvent(new Event('change'));
    });
  });
  cartItemsEl.querySelectorAll('[data-cart-qty]').forEach(inp => {
    inp.addEventListener('change', () => {
      const n = Math.max(1, parseInt(inp.value, 10) || 1);
      inp.value = n;
      const it = cart.find(i => i.id === inp.dataset.cartQty);
      if (!it) return;
      it.cantidad = n;
      if (it.atributos) it.atributos.cantidad_requerida = n;
      saveCart();
      renderDocPreview();
      cartPanelCount.textContent = cartSummaryText();
    });
  });
  cartItemsEl.querySelectorAll('[data-cart-edit]').forEach(btn => {
    btn.addEventListener('click', () => editCartItem(btn.dataset.cartEdit));
  });
}

// Reabre un requerimiento ya guardado en el carrito, directo en la pantalla
// de resumen con todos sus atributos precargados (como si se acabara de
// terminar el wizard). La compra sigue en el carrito mientras se edita:
// "Guardar cambios" la reemplaza en su lugar y, si la persona abandona,
// queda intacta.
function editCartItem(id) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  closeCartPanel();

  resetWizardState();
  apiFetch(`/api/medicamentos/reset/${SESSION_ID}`, { method: 'POST', headers: _headers() }).catch(() => {});
  Object.entries(item.atributos || {}).forEach(([attr, value]) => {
    ficha[attr] = { attribute: attr, value, source: 'user', normalized: true, score: 1 };
    manualUpdate(attr, value); // re-sincroniza la sesión del backend (historial/describe la usan)
  });
  CORE_STEPS.forEach(attr => { if (ficha[attr]?.value != null) confirmedAttrs.add(attr); });
  priceData = item.price || null;
  currentTextoOriginal = item.texto_original || '';

  editingItemId = id;
  addedNotice = null;
  showingTextScreen = false;
  currentStepIndex = TOTAL_STEPS;
  renderScreen();
}

function openCartPanel() { renderCartPanel(); cartPanel.classList.remove('hidden'); }
function closeCartPanel() { cartPanel.classList.add('hidden'); }

document.getElementById('cart-bar-btn').addEventListener('click', openCartPanel);
document.getElementById('cart-close').addEventListener('click', closeCartPanel);
document.getElementById('cart-backdrop').addEventListener('click', closeCartPanel);
document.getElementById('cart-empty-btn').addEventListener('click', () => {
  if (!cart.length) return;
  const n = cart.length;
  if (!confirm(`Esto elimina las ${n} compra${n === 1 ? '' : 's'} agregadas a este requerimiento. ¿Seguro que quieres vaciar la cotización?`)) return;
  cart = [];
  saveCart();
  renderCartBar();
  renderCartPanel();
});

/* ── Exportar PDF (backend, ReportLab) ──────────────────────────────────
   Solo lleva lo técnico (qué se compra, cuánto, con qué características)
   para adjuntarlo al requerimiento en ChileCompra. Los precios y las
   comparaciones viven en el resumen ejecutivo. */

function downloadRequerimientosPDF() {
  if (!cart.length) return;
  cartPdfBtn.disabled = true;
  document.querySelectorAll('[data-pdf-action]').forEach(b => { b.disabled = true; });
  cartPdfIcon.classList.add('animate-spin');

  // Nombre y descripción los genera el modelo; normalmente ya vienen del
  // carrito (se piden al agregar el ítem). Solo se piden los que falten.
  const pendientes = cart.filter(i => !i.descripcion || !i.nombre);
  const ensure = pendientes.length
    ? apiFetch('/api/medicamentos/describe', {
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
    .then(() => apiFetch('/api/medicamentos/pdf', {
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
      downloadBlob(blob, `especificaciones-tecnicas-medicamentos-${SESSION_ID.slice(0, 6).toLowerCase()}.pdf`);
      fetch(`/api/track/${SESSION_ID}`, {
        method: 'POST', headers: _headers(), body: JSON.stringify({ tipo: 'medicamento_pdf_download' }),
      }).catch(() => {});
    })
    .catch(err => {
      console.error('Error generando el PDF:', err);
      alert('No pudimos generar el PDF. Intenta de nuevo en unos segundos.');
    })
    .finally(() => {
      cartPdfBtn.disabled = false;
      document.querySelectorAll('[data-pdf-action]').forEach(b => { b.disabled = false; });
      cartPdfIcon.classList.remove('animate-spin');
    });
}

/* ── Resumen ejecutivo (static/js/resumen.js lee esta configuración) ── */
window.SUMMARY_CFG = {
  label: () => 'Medicamentos',
  logoHtml: () => DOC_LOGO_HTML,
  marketPath: '/api/medicamentos/market',
  hasCm: false,            // no hay Convenio Marco de medicamentos en la plataforma
  hasRevisados: false,     // Medicamentos no tiene "productos revisados"
  prov: ['laboratorio', 'laboratorios'],   // la base no trae el proveedor adjudicado: el equivalente es el laboratorio
  sessionId: () => SESSION_ID,
  qty: (it) => (it.cantidad != null ? it.cantidad : (it.atributos && it.atributos.cantidad_requerida)),
  itemTitle: (it) => itemTitleMed(it),
  price: (it) => (it.price ? { median: it.price.mediana, p25: it.price.p25, p75: it.price.p75, count: it.price.count } : null),
  relaxed: () => [],
  revisados: () => [],
  closeCart: () => closeCartPanel(),
  downloadPdf: () => downloadRequerimientosPDF(),
};

/* ── Wiring general ──────────────────────────────────────────────── */

function loadSchema() {
  apiFetch('/api/medicamentos/schema', { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      Object.entries(data.attributes || {}).forEach(([attr, meta]) => {
        if (meta.valid_values) validValuesCache[attr] = meta.valid_values;
      });
    })
    .catch(() => {});
}

/* ── Historial de formularios (compartido con Computadores, ver history_ui.js) ── */

const historyUI = createHistoryUI({
  slug: 'medicamentos',
  getSessionId: () => SESSION_ID,
  onResume: (sid) => resumeSession(sid),
  onDeletedActive: () => nuevoFormulario(),
});

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

// opts.onFail: lo usa el auto-retomado al cargar la página -- si el
// session_id guardado en este navegador ya no existe, cae a un formulario
// nuevo en blanco en vez de dejar la pantalla de "Retomando..." colgada.
function resumeSession(sessionId, opts = {}) {
  return apiFetch(`/api/categories/medicamentos/sessions/${sessionId}/resume`, { method: 'POST', headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => {
      if (!data) { opts.onFail?.(); return; }
      SESSION_ID = sessionId;
      rememberCurrentSession(sessionId);
      resetWizardState();
      Object.entries(data.ficha || {}).forEach(([attr, value]) => {
        if (value == null || value === '') return;
        ficha[attr] = { attribute: attr, value, source: 'user', normalized: true, score: 1 };
      });
      currentTextoOriginal = data.texto_original || '';
      cart = data.cart || [];
      addedNotice = null;
      CORE_STEPS.forEach(attr => { if (ficha[attr]?.value != null) confirmedAttrs.add(attr); });

      if (Object.keys(ficha).length) {
        // Salta al primer paso core que falte; si ya están todos, al resumen.
        const firstUnfilled = CORE_STEPS.findIndex(attr => ficha[attr]?.value == null);
        showingTextScreen = false;
        currentStepIndex = firstUnfilled === -1 ? TOTAL_STEPS : firstUnfilled;
        // El precio no se guarda: se recalcula re-aplicando el último atributo
        // (idempotente) y, si ya hay principio activo, el "desde $X".
        if (ficha.unidad_venta?.value != null) manualUpdate('unidad_venta', ficha.unidad_venta.value);
        else if (ficha.principio_activo?.value != null) loadPriceHint();
      }
      renderCartBar();
      renderScreen();
      historyUI.renderSidebar();
    })
    .catch(() => opts.onFail?.());
}

// "+ Nuevo formulario": no borra el anterior (ya quedó guardado solo),
// simplemente arranca uno en blanco con un SESSION_ID nuevo y su propio carrito.
function nuevoFormulario() {
  SESSION_ID = (crypto.randomUUID ? crypto.randomUUID() : `med-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  rememberCurrentSession(SESSION_ID);
  cart = [];
  resetWizardState();
  addedNotice = null;
  renderCartBar();
  renderScreen();
  historyUI.renderSidebar();
}

document.addEventListener('DOMContentLoaded', () => {
  loadSchema();

  const nuevoBtn = document.querySelector('[data-nuevo-formulario]');
  if (nuevoBtn) nuevoBtn.addEventListener('click', nuevoFormulario);
  historyUI.renderSidebar();

  cartPdfBtn.addEventListener('click', downloadRequerimientosPDF);

  // Acciones del documento (cabecera de la vista previa y pantalla "Compra agregada").
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-resumen-action]')) { openResumen(); return; }
    if (e.target.closest('[data-pdf-action]')) downloadRequerimientosPDF();
  });

  // Retomar automáticamente el formulario en el que se estaba trabajando en
  // esta pestaña (o el que se abrió desde el historial del inicio).
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
    renderScreen();
  }
});
