/* ═══════════════════════════════════════════════════════════════
   Asistente Compra Ágil — app.js
   ═══════════════════════════════════════════════════════════════ */

// El session_id identifica la conversación activa. A propósito NO se
// recupera de localStorage al cargar la página -- por defecto siempre se
// arranca en una conversación nueva en blanco (como pide el diseño del
// sidebar: "siempre se muestra el chat vacío para crear uno nuevo"), nunca
// reabriendo automáticamente la última en la que se quedó el usuario. Para
// retomar una conversación anterior hay que elegirla del sidebar (ver
// switchToSession() más abajo), que sí reasigna SESSION_ID sin recargar.
const _SESSION_ID_KEY = 'compra_agil_session_id';
let SESSION_ID = crypto.randomUUID();

function _setSessionId(id) {
  SESSION_ID = id;
  try { localStorage.setItem(_SESSION_ID_KEY, id); } catch (e) { /* modo privado, etc. */ }
}

// ── Atributos ────────────────────────────────────────────────────
const ATTRS = {
  tipo_equipo:                  { label: 'Tipo de equipo',       type: 'enum',    values: ['Laptop','AIO','Desktop','Otro'] },
  procesador_principal:         { label: 'Procesador',           type: 'dict', example: 'Intel Core i7-1355U' },
  linea_procesador:             { label: 'Línea procesador',     type: 'free', example: 'Intel Core i5' },
  nucleos_procesador:           { label: 'Núcleos',              type: 'numeric', readOnly: true },
  hilos_procesador:             { label: 'Hilos',                type: 'numeric', readOnly: true },
  frecuencia_turbo_procesador_mhz: { label: 'Frec. Turbo (MHz)', type: 'numeric', readOnly: true },
  total_ram_gb:                 { label: 'RAM (GB)',              type: 'numeric', example: '16' },
  tecnologia_ram:               { label: 'Tecnología RAM',       type: 'enum',    values: ['DDR5','DDR4','LPDDR5X','LPDDR5','LPDDR4X','LPDDR4','DDR3'] },
  frecuencia_ram_mhz:           { label: 'Frec. RAM (MHz)',      type: 'numeric', readOnly: true },
  total_almacenamiento_gb:      { label: 'Almacenamiento (GB)',  type: 'numeric', example: '512' },
  tecnologia_disco_principal:   { label: 'Tecnología disco',     type: 'enum',    values: ['NVMe SSD','SATA SSD','SSD','HDD','eMMC','mSATA'] },
  tipo_configuracion_discos:    { label: 'Config. discos',       type: 'enum',    values: ['solo SSD','SSD+HDD','solo HDD','otro'] },
  tiene_gpu_dedicada:           { label: 'GPU dedicada',         type: 'boolean' },
  gpu_dedicada_nombre:          { label: 'Nombre GPU',           type: 'dict', example: 'NVIDIA RTX 4050' },
  total_vram_gpu_gb:            { label: 'VRAM (GB)',            type: 'numeric', readOnly: true },
  marca:                        { label: 'Marca',                type: 'dict', example: 'HP, Lenovo, Dell...' },
  pantalla_pulgadas:            { label: 'Pantalla (pulgadas)',  type: 'numeric', example: '15.6' },
  sistema_operativo:            { label: 'Sistema operativo',    type: 'dict', example: 'Windows 11 Pro' },
  wifi_generacion:              { label: 'Wi-Fi',               type: 'enum',    values: ['Wi-Fi 7','Wi-Fi 6E','Wi-Fi 6','Wi-Fi 5','Wi-Fi 4'] },
};

const CORE_ATTRS = [
  'tipo_equipo', 'procesador_principal', 'total_ram_gb', 'tecnologia_ram',
  'total_almacenamiento_gb', 'tecnologia_disco_principal', 'tiene_gpu_dedicada', 'sistema_operativo',
];

// ── Estado ──────────────────────────────────────────────────────
const MAX_COMPARE = 10;

const state = {
  ficha: {},
  priceData: null,
  priceLoading: false,
  cmPriceData: null,
  cmPriceLoading: false,
  activePriceTab: 'cm',
  compareItems: [],   // candidatos marcados para comparar (máx MAX_COMPARE)
  offerPriceFilter: { min: null, max: null },   // filtro de precio -- pestaña Compra Ágil
  cmOfferPriceFilter: { min: null, max: null }, // filtro de precio -- pestaña Convenio Marco
  sending: false,
  isTyping: false,
  streamingBubble: null,
};

// Valores de dropdowns cargados desde /api/dropdowns al iniciar
const dropdowns = {};

// _headers(), apiFetch() y showSessionExpiredModal() viven en shell.js
// (compartido con medicamentos.js y la página de categorías).

// ── Mensajes del servidor ────────────────────────────────────────
// (readSSEStream vive en shell.js, compartido con medicamentos.js)
function handleServerMessage(data) {
  switch (data.type) {
    case 'thinking':
      showTyping();
      clearQuestions();
      showFichaLoading();
      break;

    case 'assistant_chunk':
      hideTyping();
      appendStreamingChunk(data.delta);
      break;

    case 'assistant_done':
      hideTyping();
      state.streamingBubble = null;
      hideFichaLoading();
      fetchUsage();
      _tourNotify('assistant_done');
      break;

    case 'ficha_update':
      data.updates.forEach(applyFichaUpdate);
      updateProgress();
      // Mostrar badge en tab Ficha si el usuario está en el tab Chat (móvil)
      if (document.getElementById('panel-ficha')?.classList.contains('mobile-hidden')) {
        const badge = document.getElementById('ficha-tab-badge');
        if (badge) badge.classList.remove('hidden');
      }
      break;

    case 'questions':
      showQuestions(data.questions);
      break;

    case 'price_update':
      state.priceData = data.data;
      state.priceLoading = false;
      state.offerPriceFilter = { min: null, max: null };
      _offersData = [];
      _offersFetched = false;
      _offersSort = 'fecha_desc';
      _offersGroup = 'none';
      _offersExpanded = new Set();
      _offersGroupKeys = [];
      _methodologyData = null;
      _methodologyFetched = false;
      ensurePriceShell();
      renderPriceEstimate(data.data);
      maybeStopPriceLoadingAnim();
      break;

    case 'price_not_found':
      state.priceData = null;
      state.priceLoading = false;
      ensurePriceShell();
      document.getElementById('price-panel-ca').innerHTML = priceNotFoundHtml();
      maybeStopPriceLoadingAnim();
      break;

    case 'cm_price_update':
      state.cmPriceData = data.data;
      state.cmPriceLoading = false;
      state.cmOfferPriceFilter = { min: null, max: null };
      _cmOffersData = [];
      _cmOffersFetched = false;
      ensurePriceShell();
      renderCMPriceEstimate(data.data);
      maybeStopPriceLoadingAnim();
      break;

    case 'cm_price_not_found':
      state.cmPriceData = null;
      state.cmPriceLoading = false;
      ensurePriceShell();
      document.getElementById('price-panel-cm').innerHTML = cmPriceNotFoundHtml();
      // Sin match en Convenio Marco (la vista por defecto) -> pasa solo a
      // Compra Ágil automáticamente, sin que el usuario tenga que ir a
      // buscarlo -- pero solo si no había elegido la vista a mano todavía.
      if (state.activePriceTab === 'cm') switchPriceTab('ca');
      maybeStopPriceLoadingAnim();
      break;

    case 'blocked':
      // Antes: cartel fijo ámbar de "Consulta fuera del ámbito" que
      // cortaba la conversación. Ahora data.message es una respuesta
      // conversacional real (la escribe el propio clasificador guardrail)
      // -- se muestra como un turno normal del chat, el usuario sigue
      // adelante sin perder nada de lo que ya tenía.
      hideTyping();
      state.streamingBubble = null;
      appendMessage('assistant', data.message);
      break;

    case 'usage_limit_reached':
      hideTyping();
      state.streamingBubble = null;
      appendUsageLimitMessage(data.data);
      renderUsage(data.data);
      break;

    case 'error':
      hideTyping();
      state.streamingBubble = null;
      appendMessage('assistant', `⚠ Error: ${data.message}`);
      break;
  }
}

// ── Chat UI ──────────────────────────────────────────────────────
function appendMessage(role, content) {
  const container = document.getElementById('chat-messages');
  const isAi = role === 'assistant';

  const wrap = document.createElement('div');
  wrap.className = `flex gap-3 animate-in ${isAi ? 'justify-start' : 'justify-end'}`;

  const avatarHtml = isAi
    ? `<div class="w-9 h-9 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 mt-1">
         <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
           <path d="M12 2.5l1.8 5.6 5.7 1.4-5.7 1.4-1.8 5.6-1.8-5.6-5.7-1.4 5.7-1.4z"/>
         </svg>
       </div>`
    : `<div class="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0 mt-1 text-slate-500 text-[13px] font-semibold">Tú</div>`;

  const bubbleCls = isAi
    ? 'bg-white text-slate-800 rounded-2xl rounded-tl-sm shadow-sm border border-slate-100'
    : 'bg-brand-600 text-white rounded-2xl rounded-tr-sm';

  wrap.innerHTML = isAi
    ? `${avatarHtml}<div class="max-w-[82%] px-4 py-3 text-[15px] leading-relaxed chat-bubble ${bubbleCls}">${escapeHtml(content)}</div>`
    : `<div class="max-w-[82%] px-4 py-3 text-[15px] leading-relaxed chat-bubble ${bubbleCls}">${escapeHtml(content)}</div>${avatarHtml}`;

  const emptyState = document.getElementById('chat-empty');
  if (emptyState) emptyState.style.display = 'none';

  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

function appendUsageLimitMessage(usage) {
  const container = document.getElementById('chat-messages');
  const wrap = document.createElement('div');
  wrap.className = 'flex gap-3 justify-start animate-in';
  wrap.innerHTML = `
    <div class="w-9 h-9 rounded-full bg-red-100 border border-red-200 flex items-center justify-center flex-shrink-0 mt-1">
      <svg class="w-4 h-4 text-red-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
    </div>
    <div class="max-w-[82%] px-4 py-3 text-[14px] leading-relaxed bg-red-50 border border-red-200 rounded-2xl rounded-tl-sm">
      <p class="font-semibold text-red-800 mb-1">Límite diario alcanzado</p>
      <p class="text-red-700 text-[13px]">Ya usaste tu cuota de tokens de hoy. El chat se reactiva ${formatResetTime(usage && usage.resets_at)}.</p>
    </div>`;
  const emptyState = document.getElementById('chat-empty');
  if (emptyState) emptyState.style.display = 'none';
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

function showTyping() {
  if (state.isTyping) return;
  state.isTyping = true;
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.id = 'typing-indicator';
  el.className = 'flex justify-start';
  el.innerHTML = `<div class="flex items-center gap-1 px-4 py-3 bg-white rounded-2xl rounded-tl-sm shadow-sm border border-slate-100">
    <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
  </div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function hideTyping() {
  state.isTyping = false;
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function appendStreamingChunk(delta) {
  const container = document.getElementById('chat-messages');

  if (!state.streamingBubble) {
    const emptyState = document.getElementById('chat-empty');
    if (emptyState) emptyState.style.display = 'none';

    const wrap = document.createElement('div');
    wrap.className = 'flex gap-3 justify-start animate-in';
    wrap.innerHTML = `<div class="w-9 h-9 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 mt-1">
      <svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2.5l1.8 5.6 5.7 1.4-5.7 1.4-1.8 5.6-1.8-5.6-5.7-1.4 5.7-1.4z"/>
      </svg>
    </div>`;

    const bubble = document.createElement('div');
    bubble.className = 'max-w-[82%] px-4 py-3 text-[15px] leading-relaxed chat-bubble bg-white text-slate-800 rounded-2xl rounded-tl-sm shadow-sm border border-slate-100';
    wrap.appendChild(bubble);
    container.appendChild(wrap);
    state.streamingBubble = bubble;
  }

  state.streamingBubble.appendChild(document.createTextNode(delta));
  container.scrollTop = container.scrollHeight;
}

function showQuestions(_questions) {
  // chips desactivados: el texto repetía la pregunta del asistente sin aportar valor
}

function clearQuestions() {
  const el = document.getElementById('question-chips');
  if (el) el.remove();
}

function setInput(text) {
  document.getElementById('chat-input-field').value = text;
}

// ── Enviar mensaje ────────────────────────────────────────────────
async function sendMessage() {
  const input = document.getElementById('chat-input-field');
  const content = input.value.trim();
  if (!content || state.sending) return;

  _tourNotify('send');
  state.sending = true;
  appendMessage('user', content);
  input.value = '';
  autoResizeTextarea(input);
  showTyping();

  if (state.ficha['tipo_equipo']?.value != null) showPriceLoading();

  try {
    const res = await apiFetch(`/api/chat/${SESSION_ID}`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({ content }),
    });
    if (!res) {
      hideTyping();
      state.streamingBubble = null;
      hidePriceLoading(state.ficha['tipo_equipo']?.value == null);
      return;
    }
    await readSSEStream(res, handleServerMessage);
    refreshSidebarAfterTurn();
  } catch (err) {
    hideTyping();
    state.streamingBubble = null;
    hidePriceLoading(state.ficha['tipo_equipo']?.value == null);
    appendMessage('assistant', '⚠ Error de conexión. Intenta de nuevo.');
  } finally {
    state.sending = false;
  }
}

// ── Ficha: actualizar atributo ────────────────────────────────────
function formatAttrValue(value) {
  if (value === null || value === undefined) return 'sin valor';
  if (value === true  || value === 'true')  return 'Sí';
  if (value === false || value === 'false') return 'No';
  if (Array.isArray(value)) return value.join(' / ');
  if (typeof value === 'object' && ('min' in value || 'max' in value)) {
    const parts = [];
    if (value.min != null && value.min !== '') parts.push(String(value.min));
    if (value.max != null && value.max !== '') parts.push(String(value.max));
    return parts.length ? parts.join(' – ') : 'sin valor';
  }
  return String(value);
}

function applyFichaUpdate(update) {
  const wasEmpty = state.ficha['tipo_equipo']?.value == null;
  state.ficha[update.attribute] = update;

  if (update.attribute === 'tipo_equipo' && update.value != null && wasEmpty) {
    showPriceLoading();
  }

  const row = document.getElementById(`attr-${update.attribute}`);
  if (!row) return;

  const valueSpan = row.querySelector('.attr-value');
  if (valueSpan) {
    const isEmpty = update.value == null;
    valueSpan.textContent = isEmpty ? 'sin valor' : formatAttrValue(update.value);
    valueSpan.className = isEmpty
      ? 'attr-value text-[13px] text-slate-400 italic'
      : 'attr-value text-[13px] font-semibold text-slate-800';
  }

  const badge = row.querySelector('.attr-badge');
  if (badge) {
    if (update.value == null) {
      badge.classList.add('hidden');
    } else if (update.source) {
      const configs = {
        ai:         { label: 'IA',   cls: 'bg-violet-50 text-violet-600 border-violet-200' },
        user:       { label: 'Tú',   cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
        complement: { label: 'Auto', cls: 'bg-amber-50 text-amber-600 border-amber-200' },
      };
      const cfg = configs[update.source];
      if (cfg) {
        badge.textContent = cfg.label;
        badge.className = `attr-badge text-xs font-medium px-2 py-0.5 rounded-md border ${cfg.cls}`;
        badge.classList.remove('hidden');
      }
    }
  }

  const trigger = row.querySelector('.attr-trigger');
  if (update.value == null && trigger) {
    trigger.classList.add('hidden');
  } else if (trigger && update.source === 'complement' && update.triggered_by) {
    trigger.textContent = `← ${update.triggered_by}`;
    trigger.classList.remove('hidden');
  }

  row.classList.remove('field-flash');
  void row.offsetWidth;
  row.classList.add('field-flash');
}

// Restaura TODO lo de una conversación guardada bajo este session_id --
// ficha, mensajes del chat, carrito de comparación y precio estimado
// (Compra Ágil y Convenio Marco) -- vía GET /api/sessions/{id}, que
// recalcula el precio en caliente server-side (ver chat_session_service.py)
// y trae todo junto. Se llama solo al elegir una conversación anterior
// desde el sidebar (switchToSession()) -- la carga inicial de la página
// NUNCA la llama, arranca siempre en blanco a propósito (ver SESSION_ID
// más arriba). Si el session_id es nuevo (conversación nunca guardada), el
// backend devuelve 404 y acá simplemente se deja la UI en blanco -- no es
// un error. El origen (IA/Tú/Auto) de cada valor de ficha no se guarda
// server-side, así que las insignias de origen no se muestran para
// valores restaurados -- applyFichaUpdate ya maneja bien un `source` ausente.
async function loadActiveSession() {
  try {
    const resp = await apiFetch(`/api/sessions/${SESSION_ID}`, { headers: _headers() });
    if (!resp || !resp.ok) return;
    const data = await resp.json();

    Object.entries(data.ficha || {}).forEach(([attribute, value]) => {
      if (value == null) return;
      applyFichaUpdate({ attribute, value });
    });
    updateProgress();

    (data.messages || []).forEach(m => appendMessage(m.role, m.content));

    if (data.ficha && data.ficha.tipo_equipo) {
      handleServerMessage(data.price_data
        ? { type: 'price_update', data: data.price_data }
        : { type: 'price_not_found' });
      handleServerMessage(data.cm_price_data
        ? { type: 'cm_price_update', data: data.cm_price_data }
        : { type: 'cm_price_not_found' });
    }

    if (Array.isArray(data.compare_items) && data.compare_items.length) {
      state.compareItems = data.compare_items;
      renderCompareBar();
    }

    _setActiveSessionTitle(data.title);
  } catch (e) { /* silencioso -- si falla, la conversación simplemente arranca vacía */ }
}

function updateProgress() {
  const filledCore = CORE_ATTRS.filter(a => state.ficha[a]?.value != null).length;
  const missing = CORE_ATTRS.filter(a => state.ficha[a]?.value == null);
  const pct = Math.round((filledCore / CORE_ATTRS.length) * 100);
  const bar = document.getElementById('progress-bar');
  const label = document.getElementById('progress-label');
  const missingEl = document.getElementById('progress-missing');
  if (bar) bar.style.width = `${pct}%`;
  if (label) {
    label.textContent = `${filledCore}/${CORE_ATTRS.length} completados`;
    label.title = missing.length
      ? `Falta: ${missing.map(a => ATTRS[a]?.label ?? a).join(', ')}`
      : 'Ficha completa';
  }
  if (missingEl) {
    if (missing.length) {
      missingEl.textContent = `Falta: ${missing.map(a => ATTRS[a]?.label ?? a).join(', ')}`;
      missingEl.classList.remove('hidden');
    } else {
      missingEl.classList.add('hidden');
    }
  }

  document.querySelectorAll('.ficha-section').forEach(sec => {
    const sId = sec.id.replace('section-', '');
    const rows = sec.querySelectorAll('.attr-row');
    const filledInSection = [...rows].filter(r => state.ficha[r.dataset.attr]?.value != null).length;
    const counter = document.getElementById(`section-count-${sId}`);
    if (counter) counter.textContent = `${filledInSection}/${rows.length}`;
  });

  renderKnownSummary();
}

// ── Resumen "lo que ya sabemos" (visible en el chat, no solo en la ficha) ──
function renderKnownSummary() {
  const wrap = document.getElementById('known-summary');
  const chipsEl = document.getElementById('known-summary-chips');
  if (!wrap || !chipsEl) return;

  const filled = Object.entries(state.ficha).filter(([, v]) => v?.value != null);
  if (!filled.length) {
    wrap.classList.add('hidden');
    return;
  }

  chipsEl.innerHTML = filled.map(([attr, v]) => `
    <span class="inline-flex items-center gap-1 bg-white border border-brand-200 text-[11px] text-slate-600 px-2 py-0.5 rounded-full">
      <span class="text-slate-400">${escapeHtml(ATTRS[attr]?.label ?? attr)}:</span>
      <span class="font-semibold text-slate-700">${escapeHtml(formatAttrValue(v.value))}</span>
    </span>`).join('');
  wrap.classList.remove('hidden');
}

// ── Edición manual de atributo ────────────────────────────────────
function startEdit(attr) {
  const meta = ATTRS[attr];
  if (!meta || meta.readOnly) return;

  const row = document.getElementById(`attr-${attr}`);
  const displayWrap = row.querySelector('.attr-display-wrap');
  const editWrap = row.querySelector('.attr-edit-wrap');

  displayWrap.classList.add('hidden');
  editWrap.classList.remove('hidden');
  editWrap.innerHTML = '';

  const currentVal = state.ficha[attr]?.value ?? '';

  if (meta.type === 'enum' || meta.type === 'boolean') {
    const values = meta.type === 'boolean' ? ['true', 'false'] : meta.values;
    const btnWrap = document.createElement('div');
    btnWrap.className = 'flex flex-wrap gap-1 items-center w-full';

    const currentArr = Array.isArray(currentVal)
      ? currentVal.map(String)
      : (currentVal !== '' && currentVal !== null && currentVal !== undefined ? [String(currentVal)] : []);
    let selected = [...currentArr];

    function updateStyles() {
      btnWrap.querySelectorAll('[data-val]').forEach(btn => {
        const active = selected.includes(btn.dataset.val);
        btn.className = `px-2.5 py-1.5 text-[13px] rounded-lg border transition-colors ${
          active ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-700 border-slate-200 hover:border-brand-400'
        }`;
      });
    }

    values.forEach(v => {
      const btn = document.createElement('button');
      btn.dataset.val = v;
      btn.textContent = v === 'true' ? 'Sí' : v === 'false' ? 'No' : v;
      btn.onclick = () => {
        if (selected.includes(v)) { selected = selected.filter(x => x !== v); }
        else { selected.push(v); }
        updateStyles();
      };
      btnWrap.appendChild(btn);
    });
    updateStyles();

    const okBtn = document.createElement('button');
    okBtn.className = 'px-2.5 py-1 text-[12px] rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors';
    okBtn.textContent = '✓ OK';
    okBtn.onclick = () => {
      if (selected.length === 0) { commitEdit(attr, null); return; }
      commitEdit(attr, selected.length === 1 ? selected[0] : [...selected]);
    };
    btnWrap.appendChild(okBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ml-1 px-2 py-1 text-xs text-slate-400 hover:text-slate-600';
    cancelBtn.textContent = '✕';
    cancelBtn.onclick = () => cancelEdit(attr);
    btnWrap.appendChild(cancelBtn);
    editWrap.appendChild(btnWrap);

  } else {
    const outerWrap = document.createElement('div');
    outerWrap.className = 'flex flex-col gap-1 w-full';

    // Init from current state
    const isRangeInit = typeof currentVal === 'object' && currentVal !== null
      && !Array.isArray(currentVal) && ('min' in currentVal || 'max' in currentVal);
    let selectedValues = [];
    if (Array.isArray(currentVal)) {
      selectedValues = currentVal.map(String);
    } else if (!isRangeInit && currentVal !== '' && currentVal != null) {
      selectedValues = [String(currentVal)];
    }

    // Opciones del autocompletado -- por default la lista global cacheada,
    // pero para Procesador se reemplaza por una lista acotada a la marca
    // del equipo ya elegida (evita ofrecer, ej., procesadores AMD/Intel
    // para un equipo Apple -- bug real reportado). No se muta `dropdowns`
    // global: eso ensuciaría la lista para otras fichas/sesiones.
    let effectiveOptions = dropdowns[attr] || [];
    const marcaActual = state.ficha.marca?.value;
    if (attr === 'procesador_principal' && marcaActual && !Array.isArray(marcaActual)) {
      apiFetch(`/api/dropdowns/filtered?field=${attr}&marca=${encodeURIComponent(marcaActual)}`, { headers: _headers() })
        .then(resp => resp && resp.ok ? resp.json() : null)
        .then(data => {
          if (data && data.values && data.values.length) effectiveOptions = data.values;
        })
        .catch(() => {});
    }

    // ── Pills ─────────────────────────────────────────────────────
    const pillsRow = document.createElement('div');
    pillsRow.className = `flex flex-wrap gap-1 min-h-[4px] ${isRangeInit ? 'hidden' : ''}`;

    function renderPills() {
      pillsRow.innerHTML = '';
      selectedValues.forEach((v, i) => {
        const pill = document.createElement('span');
        pill.className = 'inline-flex items-center gap-0.5 px-2 py-0.5 text-[12px] bg-brand-50 text-brand-700 rounded-full border border-brand-200';
        const lbl = document.createElement('span'); lbl.textContent = v;
        const rm = document.createElement('button');
        rm.innerHTML = '×';
        rm.className = 'ml-0.5 text-brand-400 hover:text-brand-700 font-bold text-[14px] leading-none';
        rm.onclick = e => { e.preventDefault(); e.stopPropagation(); selectedValues.splice(i, 1); renderPills(); };
        pill.appendChild(lbl); pill.appendChild(rm);
        pillsRow.appendChild(pill);
      });
    }
    renderPills();
    outerWrap.appendChild(pillsRow);

    // ── Text input + autocomplete ─────────────────────────────────
    const inputRow = document.createElement('div');
    inputRow.className = `flex items-center gap-1 w-full ${isRangeInit ? 'hidden' : ''}`;
    const inputContainer = document.createElement('div');
    inputContainer.className = 'relative flex-1';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = '';
    input.className = 'w-full text-[13px] px-3 py-1.5 border border-brand-400 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-400';
    input.placeholder = meta.example ? `Ej: ${meta.example}` : `Añadir ${meta.label.toLowerCase()}...`;

    const acList = document.createElement('div');
    acList.className = 'fixed z-[9999] bg-white border border-slate-200 rounded-lg shadow-lg overflow-y-auto hidden';
    acList.style.maxHeight = '220px';
    document.body.appendChild(acList);
    let acItems = [];
    let acIdx = -1;
    let acSourceInput = input;
    let acOnSelect = addValue;

    function positionAc() {
      const rect = acSourceInput.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 4;
      const spaceAbove = rect.top - 4;
      const listH = Math.min(220, acItems.length * 38);
      acList.style.left  = `${rect.left}px`;
      acList.style.width = `${rect.width}px`;
      if (spaceBelow >= listH || spaceBelow >= spaceAbove) {
        acList.style.top = `${rect.bottom + 2}px`; acList.style.bottom = 'auto';
      } else {
        acList.style.bottom = `${window.innerHeight - rect.top + 2}px`; acList.style.top = 'auto';
      }
    }

    function addValue(v) {
      v = v.trim();
      if (!v || selectedValues.includes(v)) { input.value = ''; return; }
      selectedValues.push(v);
      renderPills();
      input.value = '';
      acList.classList.add('hidden');
    }

    function renderAc(query) {
      const q = query.trim().toLowerCase();
      const opts = effectiveOptions;
      acItems = q ? opts.filter(v => v.toLowerCase().includes(q)).slice(0, 10) : opts.slice(0, 10);
      acIdx = -1; acList.innerHTML = '';
      if (!acItems.length) { acList.classList.add('hidden'); return; }
      acItems.forEach(v => {
        const item = document.createElement('div');
        item.className = 'px-3 py-2 text-[13px] text-slate-700 cursor-pointer hover:bg-brand-50 hover:text-brand-700';
        item.textContent = v;
        item.addEventListener('mousedown', e => { e.preventDefault(); acOnSelect(v); });
        acList.appendChild(item);
      });
      positionAc(); acList.classList.remove('hidden');
    }

    function updateHighlight() {
      Array.from(acList.children).forEach((el, i) => {
        el.classList.toggle('bg-brand-50', i === acIdx);
        el.classList.toggle('text-brand-700', i === acIdx);
      });
    }

    function removeAc() {
      acList.classList.add('hidden');
      if (acList.parentNode) acList.parentNode.removeChild(acList);
    }

    if (dropdowns[attr]?.length) {
      input.addEventListener('input', () => { acSourceInput = input; acOnSelect = addValue; renderAc(input.value); });
      input.addEventListener('focus', () => { acSourceInput = input; acOnSelect = addValue; renderAc(input.value); });
      input.addEventListener('blur', () => setTimeout(() => acList.classList.add('hidden'), 150));
    }

    input.addEventListener('keydown', e => {
      const listVisible = !acList.classList.contains('hidden') && acItems.length;
      if (listVisible && e.key === 'ArrowDown') { e.preventDefault(); acIdx = Math.min(acIdx + 1, acItems.length - 1); updateHighlight(); return; }
      if (listVisible && e.key === 'ArrowUp')   { e.preventDefault(); acIdx = Math.max(acIdx - 1, -1); updateHighlight(); return; }
      if (e.key === 'Enter') {
        e.preventDefault(); removeAc();
        addValue(listVisible && acIdx >= 0 ? acItems[acIdx] : input.value);
        return;
      }
      if (e.key === 'Escape') { removeAc(); cancelEdit(attr); }
    });

    inputContainer.appendChild(input);
    inputRow.appendChild(inputContainer);
    outerWrap.appendChild(inputRow);

    // ── Range row (numeric only) ──────────────────────────────────
    let rangeMinInput = null;
    let rangeMaxInput = null;
    const rangeRow = document.createElement('div');
    rangeRow.className = `flex items-center gap-1 w-full ${isRangeInit ? '' : 'hidden'}`;

    if (meta.type === 'numeric') {
      rangeMinInput = document.createElement('input');
      rangeMinInput.type = 'text'; rangeMinInput.placeholder = 'Mín';
      rangeMinInput.className = 'flex-1 text-[13px] px-3 py-1.5 border border-brand-400 rounded-lg focus:outline-none';
      const rangeSep = document.createElement('span');
      rangeSep.className = 'text-slate-400 text-sm'; rangeSep.textContent = '–';
      rangeMaxInput = document.createElement('input');
      rangeMaxInput.type = 'text'; rangeMaxInput.placeholder = 'Máx';
      rangeMaxInput.className = 'flex-1 text-[13px] px-3 py-1.5 border border-brand-400 rounded-lg focus:outline-none';
      if (isRangeInit && currentVal) {
        rangeMinInput.value = currentVal.min ?? '';
        rangeMaxInput.value = currentVal.max ?? '';
      }
      rangeRow.appendChild(rangeMinInput);
      rangeRow.appendChild(rangeSep);
      rangeRow.appendChild(rangeMaxInput);

      if (dropdowns[attr]?.length) {
        [rangeMinInput, rangeMaxInput].forEach(inp => {
          const onSel = v => { inp.value = v; acList.classList.add('hidden'); };
          inp.addEventListener('input', () => { acSourceInput = inp; acOnSelect = onSel; renderAc(inp.value); });
          inp.addEventListener('focus', () => { acSourceInput = inp; acOnSelect = onSel; renderAc(inp.value); });
          inp.addEventListener('blur',  () => setTimeout(() => acList.classList.add('hidden'), 150));
          inp.addEventListener('keydown', e => {
            const listVisible = !acList.classList.contains('hidden') && acItems.length;
            if (listVisible && e.key === 'ArrowDown') { e.preventDefault(); acIdx = Math.min(acIdx + 1, acItems.length - 1); updateHighlight(); return; }
            if (listVisible && e.key === 'ArrowUp')   { e.preventDefault(); acIdx = Math.max(acIdx - 1, -1); updateHighlight(); return; }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (listVisible && acIdx >= 0) { acOnSelect(acItems[acIdx]); removeAc(); return; }
              okBtn.click();
            }
            if (e.key === 'Escape') { removeAc(); cancelEdit(attr); }
          });
        });
      }
    }
    outerWrap.appendChild(rangeRow);

    // ── Action row ────────────────────────────────────────────────
    const actionRow = document.createElement('div');
    actionRow.className = 'flex items-center gap-1 justify-end';

    let rangeMode = isRangeInit;

    if (meta.type === 'numeric') {
      const rangeToggle = document.createElement('button');
      function syncRangeToggle() {
        rangeToggle.className = `px-2 py-1 text-[11px] rounded border transition-colors ${
          rangeMode ? 'bg-brand-100 text-brand-700 border-brand-200' : 'bg-white text-slate-500 border-slate-200 hover:border-brand-300'
        }`;
      }
      rangeToggle.textContent = 'Rango';
      syncRangeToggle();
      rangeToggle.onclick = () => {
        rangeMode = !rangeMode;
        rangeRow.classList.toggle('hidden', !rangeMode);
        inputRow.classList.toggle('hidden', rangeMode);
        pillsRow.classList.toggle('hidden', rangeMode);
        syncRangeToggle();
        setTimeout(() => (rangeMode ? rangeMinInput?.focus() : input.focus()), 0);
      };
      actionRow.appendChild(rangeToggle);
    }

    const okBtn = document.createElement('button');
    // Antes era un ícono chico sin fondo (✓) -- pasaba desapercibido al
    // agregar un valor desde el dropdown (bug real reportado). Mismo estilo
    // de píldora visible que ya se usa para el OK de atributos enum/boolean.
    okBtn.className = 'px-2.5 py-1 text-[12px] font-medium rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors';
    okBtn.innerHTML = '✓ Confirmar';
    okBtn.onclick = () => {
      removeAc();
      let val;
      if (rangeMode && meta.type === 'numeric') {
        const mn = rangeMinInput?.value.trim() ?? '';
        const mx = rangeMaxInput?.value.trim() ?? '';
        if (!mn && !mx) { commitEdit(attr, null); return; }
        val = { min: mn || null, max: mx || null };
      } else {
        if (input.value.trim()) addValue(input.value.trim());
        if (selectedValues.length === 0) { commitEdit(attr, null); return; }
        val = selectedValues.length === 1 ? selectedValues[0] : [...selectedValues];
      }
      commitEdit(attr, val);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'p-1 text-slate-400 hover:text-slate-600';
    cancelBtn.innerHTML = '✕';
    cancelBtn.onclick = () => { removeAc(); cancelEdit(attr); };

    // Enter/Escape for range inputs without dropdowns
    if (meta.type === 'numeric' && !dropdowns[attr]?.length) {
      [rangeMinInput, rangeMaxInput].forEach(inp => {
        if (!inp) return;
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
          if (e.key === 'Escape') { removeAc(); cancelEdit(attr); }
        });
      });
    }

    actionRow.appendChild(okBtn);
    actionRow.appendChild(cancelBtn);
    outerWrap.appendChild(actionRow);

    editWrap.appendChild(outerWrap);
    setTimeout(() => input.focus(), 0);
  }
}

function cancelEdit(attr) {
  const row = document.getElementById(`attr-${attr}`);
  if (!row) return;
  const dw = row.querySelector('.attr-display-wrap');
  if (dw) dw.classList.remove('hidden');
  const ew = row.querySelector('.attr-edit-wrap');
  if (ew) { ew.classList.add('hidden'); ew.innerHTML = ''; }
}

function commitEdit(attr, value) {
  if (value === '' || value === undefined) {
    cancelEdit(attr);
    return;
  }
  cancelEdit(attr);

  // Actualización optimista: mostrar el valor inmediatamente con badge "guardando"
  const row = document.getElementById(`attr-${attr}`);
  if (row) {
    const vs = row.querySelector('.attr-value');
    const badge = row.querySelector('.attr-badge');
    const displayVal = formatAttrValue(value);
    if (vs) { vs.textContent = displayVal; vs.className = 'attr-value text-[13px] font-semibold text-slate-800'; }
    if (badge) {
      badge.textContent = '…';
      badge.className = 'attr-badge text-xs font-medium px-2 py-0.5 rounded-md border text-slate-400 border-slate-200 bg-slate-50';
      badge.classList.remove('hidden');
    }
  }

  if (state.ficha['tipo_equipo']?.value != null || attr === 'tipo_equipo') {
    showPriceLoading();
  }

  apiFetch(`/api/manual_update/${SESSION_ID}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ attribute: attr, value }),
  })
    .then(res => { if (res) return readSSEStream(res, handleServerMessage); hidePriceLoading(true); })
    .then(() => refreshSidebarAfterTurn())
    .catch(err => {
      console.error('Error en manual_update:', err);
      hidePriceLoading(true);
    });
}

// ── Precio: loading ───────────────────────────────────────────────
const PRICE_LOADING_MSGS = [
  'Buscando equipos similares en el mercado...',
  'Analizando precios históricos de Compra Ágil...',
  'Calculando rangos de precio de referencia...',
  'Estimando precio en base a tus requerimientos...',
  'Consultando datos de compras anteriores...',
];

let _priceLoadingInterval = null;
let _priceLoadingTimeout = null;
let _priceLoadingMsgIdx = 0;

function showPriceLoading() {
  if (state.priceLoading || state.cmPriceLoading) return;
  state.priceLoading = true;
  state.cmPriceLoading = true;
  _priceShellReady = false;
  _priceLoadingMsgIdx = 0;

  const container = document.getElementById('price-container');
  container.innerHTML = `
    <div class="bg-white border border-slate-200 rounded-xl shadow-sm px-4 py-3 flex items-center gap-4 animate-in">
      <div class="price-spinner"></div>
      <div class="min-w-0">
        <p class="text-[13px] font-medium text-slate-700">Estimando precio de referencia</p>
        <p id="price-loading-msg" class="text-[12px] text-slate-400 mt-0.5 price-loading-text truncate">${PRICE_LOADING_MSGS[0]}</p>
      </div>
    </div>`;

  clearInterval(_priceLoadingInterval);
  _priceLoadingInterval = setInterval(() => {
    _priceLoadingMsgIdx = (_priceLoadingMsgIdx + 1) % PRICE_LOADING_MSGS.length;
    const el = document.getElementById('price-loading-msg');
    if (el) el.textContent = PRICE_LOADING_MSGS[_priceLoadingMsgIdx];
  }, 2800);

  clearTimeout(_priceLoadingTimeout);
  _priceLoadingTimeout = setTimeout(() => {
    if (state.priceLoading || state.cmPriceLoading) hidePriceLoading(true);
  }, 40000);
}

function maybeStopPriceLoadingAnim() {
  if (!state.priceLoading && !state.cmPriceLoading) {
    clearInterval(_priceLoadingInterval);
    clearTimeout(_priceLoadingTimeout);
  }
}

function hidePriceLoading(showEmpty = false) {
  state.priceLoading = false;
  state.cmPriceLoading = false;
  clearInterval(_priceLoadingInterval);
  clearTimeout(_priceLoadingTimeout);
  if (showEmpty) {
    _priceShellReady = false;
    state.priceData = null;
    state.cmPriceData = null;
    document.getElementById('price-container').innerHTML = priceEmptyHtml();
  }
}

// ── Precio: shell de vista única (Convenio Marco / Compra Ágil) ────
// Antes había 2 pestañas siempre visibles y seleccionables a la vez.
// Ahora se muestra un solo panel por vez (empieza en Convenio Marco) y
// un botón contextual para pasar al otro catálogo -- así no hay 2
// títulos compitiendo por atención, solo "dónde estoy" + "a dónde ir".
let _priceShellReady = false;

function ensurePriceShell() {
  if (_priceShellReady && document.getElementById('price-panel-cm')) return;
  _priceShellReady = true;
  const container = document.getElementById('price-container');
  container.innerHTML = `
    <div class="flex items-center justify-between mb-2 animate-in">
      <span id="price-panel-label" class="text-[10px] font-semibold uppercase tracking-wide"></span>
      <button id="price-switch-btn" onclick="switchPriceTab(state.activePriceTab === 'cm' ? 'ca' : 'cm')" class="text-[11px] lg:text-[12px] font-semibold px-2.5 py-1.5 rounded-lg transition-colors"></button>
    </div>
    <div id="price-panel-cm">${pricePanelLoadingHtml()}</div>
    <div id="price-panel-ca" class="hidden">${pricePanelLoadingHtml()}</div>`;
  switchPriceTab(state.activePriceTab || 'cm');
}

function pricePanelLoadingHtml() {
  return `
    <div class="bg-white border border-slate-200 rounded-xl shadow-sm px-4 py-3 flex items-center gap-3 animate-in">
      <div class="price-spinner" style="width:20px;height:20px;"></div>
      <p class="text-[12px] text-slate-400">Buscando…</p>
    </div>`;
}

function switchPriceTab(tab) {
  state.activePriceTab = tab;
  const cmPanel = document.getElementById('price-panel-cm');
  const caPanel = document.getElementById('price-panel-ca');
  const btn = document.getElementById('price-switch-btn');
  const label = document.getElementById('price-panel-label');
  if (!cmPanel || !caPanel || !btn || !label) return;
  cmPanel.classList.toggle('hidden', tab !== 'cm');
  caPanel.classList.toggle('hidden', tab !== 'ca');
  const base = 'text-[11px] lg:text-[12px] font-semibold px-2.5 py-1.5 rounded-lg transition-colors';
  if (tab === 'cm') {
    label.textContent = 'Convenio Marco';
    label.className = 'text-[10px] font-semibold uppercase tracking-wide text-emerald-700';
    btn.textContent = 'Ver en Compra Ágil';
    btn.className = `${base} text-brand-700 bg-blue-100 hover:bg-blue-200`;
  } else {
    label.textContent = 'Compra Ágil';
    label.className = 'text-[10px] font-semibold uppercase tracking-wide text-brand-700';
    btn.textContent = 'Ver en Convenio Marco';
    btn.className = `${base} text-emerald-700 bg-emerald-100 hover:bg-emerald-200`;
  }
}

// ── Filtro de precio (acotar historial/catálogo al presupuesto real) ────
// Se prellena con el rango ya calculado (p25-p75 en Compra Ágil, min-max en
// Convenio Marco) para que el usuario lo "recorte" en vez de partir de cero.
function _priceFilterHtml(source, defaultMin, defaultMax) {
  const filter = source === 'ca' ? state.offerPriceFilter : state.cmOfferPriceFilter;
  const min = filter.min ?? defaultMin;
  const max = filter.max ?? defaultMax;
  const accent = source === 'ca' ? 'brand' : 'emerald';
  return `
    <div class="mt-1.5 bg-white border border-slate-200 rounded-xl px-3 py-2">
      <p class="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Filtrar por presupuesto</p>
      <div class="flex items-center gap-1.5">
        <input type="number" id="${source}-price-min" placeholder="Mín" value="${min ?? ''}"
               class="w-full min-w-0 text-[11.5px] px-2 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-${accent}-400"
               onkeydown="if(event.key==='Enter') applyPriceFilter('${source}')">
        <span class="text-slate-300 text-[11px] flex-shrink-0">–</span>
        <input type="number" id="${source}-price-max" placeholder="Máx" value="${max ?? ''}"
               class="w-full min-w-0 text-[11.5px] px-2 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-${accent}-400"
               onkeydown="if(event.key==='Enter') applyPriceFilter('${source}')">
        <button onclick="applyPriceFilter('${source}')" class="flex-shrink-0 text-[11px] font-semibold text-white bg-${accent}-600 hover:bg-${accent}-700 px-2.5 py-1.5 rounded-lg transition-colors">Aplicar</button>
        <button onclick="resetPriceFilter('${source}')" title="Restablecer al rango esperado" class="flex-shrink-0 w-7 h-7 flex items-center justify-center text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        </button>
      </div>
    </div>`;
}

function applyPriceFilter(source) {
  const minEl = document.getElementById(`${source}-price-min`);
  const maxEl = document.getElementById(`${source}-price-max`);
  const min = minEl && minEl.value !== '' ? Number(minEl.value) : null;
  const max = maxEl && maxEl.value !== '' ? Number(maxEl.value) : null;
  if (source === 'ca') {
    state.offerPriceFilter = { min, max };
    _offersFetched = false;
    const list = document.getElementById('offers-list');
    if (list && !list.classList.contains('hidden')) fetchOffers();
  } else {
    state.cmOfferPriceFilter = { min, max };
    _cmOffersFetched = false;
    const list = document.getElementById('cm-offers-list');
    if (list && !list.classList.contains('hidden')) fetchCMOffers();
  }
}

function resetPriceFilter(source) {
  // Vuelve al rango automático (min/max = null, el backend decide) sin
  // reconstruir todo el panel -- así no se pierde el estado expandido/
  // colapsado del historial o catálogo si ya estaba abierto.
  const minEl = document.getElementById(`${source}-price-min`);
  const maxEl = document.getElementById(`${source}-price-max`);
  if (source === 'ca') {
    state.offerPriceFilter = { min: null, max: null };
    if (minEl) minEl.value = state.priceData?.p25 ?? '';
    if (maxEl) maxEl.value = state.priceData?.p75 ?? '';
    _offersFetched = false;
    const list = document.getElementById('offers-list');
    if (list && !list.classList.contains('hidden')) fetchOffers();
  } else {
    state.cmOfferPriceFilter = { min: null, max: null };
    if (minEl) minEl.value = state.cmPriceData?.min ?? '';
    if (maxEl) maxEl.value = state.cmPriceData?.max ?? '';
    _cmOffersFetched = false;
    const list = document.getElementById('cm-offers-list');
    if (list && !list.classList.contains('hidden')) fetchCMOffers();
  }
}

// ── Precio: resultado (Compra Ágil) ─────────────────────────────────
function renderPriceEstimate(data) {
  const container = document.getElementById('price-panel-ca');
  if (!container) return;

  const fmt = (n) => n != null
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
    : '—';

  const range = (data.max - data.min) || 1;
  const leftPct  = ((data.p25  - data.min) / range) * 100;
  const widthPct = ((data.p75  - data.p25) / range) * 100;
  const meanPct  = ((data.mean - data.min) / range) * 100;

  const broadWarning = data.broad_warning ? `
    <div class="flex items-start gap-2.5 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2.5 mt-2">
      <svg class="w-4 h-4 flex-shrink-0 text-amber-500 mt-0.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
      <div>
        <p class="text-[12px] font-semibold text-amber-700 leading-tight">Búsqueda muy amplia (${data.count.toLocaleString('es-CL')} ofertas)</p>
        <p class="text-[11px] text-amber-600 mt-0.5 leading-snug">La estimación puede no ser precisa. Agrega más atributos (procesador, RAM, almacenamiento) para acotar los resultados.</p>
      </div>
    </div>` : '';

  // Sin match exacto con TODAS las specs -- se amplió la búsqueda soltando
  // algunas (ver relajación en price_service.estimate()). Mismo patrón
  // visual que ya existe para Convenio Marco (evita el mensaje contradictorio
  // reportado: "sin precio" cuando en realidad sí hay evidencia, solo que
  // con un match más amplio).
  const relaxedWarningCA = (data.relaxed && data.relaxed_attrs && data.relaxed_attrs.length) ? `
    <div class="flex items-start gap-2.5 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 mt-2">
      <svg class="w-4 h-4 flex-shrink-0 text-blue-500 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
      <div>
        <p class="text-[12px] font-semibold text-blue-700 leading-tight">Búsqueda ampliada</p>
        <p class="text-[11px] text-blue-600 mt-0.5 leading-snug">No hubo transacciones con todas las specs exactas, así que se amplió el criterio soltando algunas de las menos determinantes para el precio.</p>
      </div>
    </div>` : '';

  container.innerHTML = `
    <div class="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden animate-in">
      <div class="flex items-center justify-between px-3 py-1.5 lg:px-4 lg:py-2 bg-gradient-to-r from-brand-700 to-brand-600">
        <div class="flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-white opacity-80" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
          </svg>
          <span class="text-[12px] lg:text-[13px] font-semibold text-white">Estimación · Compra Ágil</span>
        </div>
        <span class="text-[11px] lg:text-[12px] text-blue-200 opacity-80">${data.count.toLocaleString('es-CL')} ofertas</span>
      </div>
      <div class="px-3 pt-1.5 lg:px-4 bg-amber-50 border-b border-amber-100">
        <p class="text-[10px] lg:text-[11px] text-amber-700 py-1 leading-snug">Referencial — compras anteriores, el precio puede variar</p>
      </div>
      <div class="px-3 py-2 lg:px-4 lg:py-3">
        <div class="flex items-center justify-between gap-2 mb-1.5 lg:mb-2.5">
          <div>
            <p class="text-lg lg:text-3xl font-bold text-brand-700 leading-none">${fmt(data.mean)}</p>
            <p class="text-[11px] lg:text-[13px] text-slate-400 mt-0.5">estimación sin IVA &nbsp;·&nbsp; <span class="font-semibold text-slate-600">${fmt(data.mean_iva)}</span> c/IVA</p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[10px] lg:text-[12px] text-slate-400 mb-0.5">
              Rango esperado
              <button onclick="toggleEl('ca-methodology-note')" title="¿Cómo se calcula?" class="ml-0.5 w-3.5 h-3.5 inline-flex items-center justify-center rounded-full border border-slate-300 text-slate-400 hover:border-brand-400 hover:text-brand-500 text-[9px] font-bold align-middle cursor-pointer">?</button>
            </p>
            <p class="text-[12px] lg:text-[13px] font-medium text-slate-600">${fmt(data.p25)} – ${fmt(data.p75)}</p>
            <p class="text-[11px] text-slate-400 mt-0.5">${fmt(data.p25_iva)} – ${fmt(data.p75_iva)} c/IVA</p>
          </div>
        </div>
        <div class="relative h-1.5 lg:h-2 bg-slate-100 rounded-full mb-1.5 lg:mb-2">
          <div class="absolute top-0 h-full bg-brand-100 rounded-full"
               style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></div>
          <div class="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 lg:w-3 lg:h-3 bg-brand-600 rounded-full border-2 border-white shadow"
               style="left:calc(${meanPct.toFixed(1)}% - 5px)"></div>
        </div>
        <div id="ca-methodology-note" class="hidden mb-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-2 text-[10.5px] text-slate-500 leading-snug">
          <strong class="text-slate-600">¿Cómo se calcula?</strong> Se toman las transacciones de Compra Ágil con especificaciones iguales o equivalentes a tu ficha. El <strong>rango esperado</strong> es el tramo entre el percentil 25 (p25) y el percentil 75 (p75): el 50% central de esos precios cae ahí (la mitad es más barata, la mitad más cara). La <strong>estimación</strong> es el promedio de ese mismo conjunto. Haz clic en "Ver historial de transacciones" abajo para ver cuántas son, de qué período y qué tipo de organismos compraron.
        </div>
        <div class="text-center text-[10px] text-slate-300 border-t border-slate-100 pt-1.5">
          ${data.match_description}
        </div>
        ${broadWarning}
        ${relaxedWarningCA}
      </div>
    </div>
    ${_priceFilterHtml('ca', data.p25, data.p75)}
    <div class="mt-2">
      <button onclick="toggleOffers()" class="w-full flex items-center justify-between px-3 py-2.5 bg-brand-50 border border-brand-200 rounded-xl text-[12px] font-semibold text-brand-700 hover:bg-brand-100 hover:border-brand-300 transition-colors group">
        <span class="flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-brand-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          Ver historial de transacciones
          <span class="text-[10px] font-normal text-brand-500 bg-brand-100 border border-brand-200 px-1.5 py-0.5 rounded-full group-hover:bg-brand-200">Presiona para expandir</span>
        </span>
        <svg id="offers-chevron" class="w-4 h-4 text-brand-400 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div id="offers-list" class="hidden mt-1.5">
        <div class="text-center py-4 text-[12px] text-slate-400">Cargando transacciones...</div>
      </div>
    </div>`;
}

// ── Precio: resultado (Convenio Marco) ──────────────────────────────
function renderCMPriceEstimate(data) {
  const container = document.getElementById('price-panel-cm');
  if (!container) return;

  const fmt = (n) => n != null
    ? `CLP $${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(n)}`
    : '—';
  const fmtUsd = (n) => n != null
    ? `USD $${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`
    : '—';

  const fxNoteBox = `
    <div class="flex items-start gap-2.5 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 mt-2">
      <svg class="w-4 h-4 flex-shrink-0 text-blue-500 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
      <p class="text-[12px] text-blue-700 leading-snug">
        ${data.fx_fallback
          ? '⚠ Conversión con valor de referencia — no se pudo consultar el tipo de cambio del día'
          : `Convertido según <strong>${data.fx_source || 'Banco Central de Chile (vía mindicador.cl)'}</strong> · <strong>$${Math.round(data.fx_rate).toLocaleString('es-CL')} CLP/USD</strong>${data.fx_date ? ` · ${data.fx_date}` : ''}`}
      </p>
    </div>`;

  const broadWarning = data.broad_warning ? `
    <div class="flex items-start gap-2.5 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2.5 mt-2">
      <svg class="w-4 h-4 flex-shrink-0 text-amber-500 mt-0.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
      <div>
        <p class="text-[12px] font-semibold text-amber-700 leading-tight">Búsqueda muy amplia (${data.count.toLocaleString('es-CL')} productos)</p>
        <p class="text-[11px] text-amber-600 mt-0.5 leading-snug">Solo se filtró por tipo de equipo. Agrega RAM, almacenamiento, marca o procesador para acotar los resultados.</p>
      </div>
    </div>` : '';

  const relaxedWarning = data.processor_relaxed ? (
    data.processor_match === 'gama' ? `
    <div class="flex items-start gap-2.5 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2.5 mt-2">
      <svg class="w-4 h-4 flex-shrink-0 text-blue-500 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
      <div>
        <p class="text-[12px] font-semibold text-blue-700 leading-tight">Procesadores de rendimiento equivalente</p>
        <p class="text-[11px] text-blue-600 mt-0.5 leading-snug">No hay match exacto de línea, pero se muestran equipos de la misma gama de rendimiento de cualquier marca (Intel, AMD, etc.).</p>
      </div>
    </div>` : `
    <div class="flex items-start gap-2.5 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2.5 mt-2">
      <svg class="w-4 h-4 flex-shrink-0 text-amber-500 mt-0.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
      <div>
        <p class="text-[12px] font-semibold text-amber-700 leading-tight">Sin coincidencia exacta de procesador</p>
        <p class="text-[11px] text-amber-600 mt-0.5 leading-snug">Se muestran productos del catálogo con el resto de las características solicitadas (tipo, RAM, almacenamiento).</p>
      </div>
    </div>`
  ) : '';

  const unverifiedNote = (data.unverified_attrs && data.unverified_attrs.length) ? `
    <div class="flex items-start gap-2.5 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 mt-2">
      <svg class="w-4 h-4 flex-shrink-0 text-slate-400 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.09 9a3 3 0 015.83 1c0 2-3 2-3 4"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div>
        <p class="text-[12px] font-semibold text-slate-600 leading-tight">No se pudo verificar en Convenio Marco</p>
        <p class="text-[11px] text-slate-500 mt-0.5 leading-snug">${data.unverified_attrs.join(', ')} — el catálogo no registra este dato para los productos listados.</p>
      </div>
    </div>` : '';

  container.innerHTML = `
    <div class="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden animate-in">
      <div class="flex items-center justify-between px-3 py-1.5 lg:px-4 lg:py-2 bg-gradient-to-r from-emerald-700 to-emerald-600">
        <div class="flex items-center gap-2">
          <span class="relative flex h-2 w-2">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-200 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-2 w-2 bg-emerald-200"></span>
          </span>
          <span class="text-[12px] lg:text-[13px] font-semibold text-white">Convenio Marco · Catálogo</span>
        </div>
        <span class="text-[11px] lg:text-[12px] text-emerald-100 opacity-90">${data.count.toLocaleString('es-CL')} productos</span>
      </div>
      <div class="px-3 py-2 lg:px-4 lg:py-3">
        <div class="flex items-center justify-between gap-2 mb-1.5 lg:mb-2.5">
          <div>
            <p class="text-lg lg:text-3xl font-bold text-emerald-700 leading-none">${fmt(data.median ?? data.min)}</p>
            <p class="text-[11px] lg:text-[13px] text-slate-400 mt-0.5">precio mediano</p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[10px] lg:text-[12px] text-slate-400 mb-0.5">Rango de precios</p>
            <p class="text-[12px] lg:text-[13px] font-medium text-slate-600">${fmt(data.min)} – ${fmt(data.max)}</p>
            <p class="text-[11px] text-slate-400 mt-0.5">${fmtUsd(data.min_usd)} – ${fmtUsd(data.max_usd)}</p>
          </div>
        </div>
        <div class="text-center text-[10px] text-slate-300 border-t border-slate-100 pt-1.5">
          ${data.match_description}
        </div>
        ${fxNoteBox}
        ${broadWarning}
        ${relaxedWarning}
        ${unverifiedNote}
      </div>
    </div>
    ${_priceFilterHtml('cm', data.min, data.max)}
    <div class="mt-2">
      <button onclick="toggleCMOffers()" class="w-full flex items-center justify-between px-3 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-[12px] font-semibold text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 transition-colors group">
        <span class="flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          Ver productos del catálogo
          <span class="text-[10px] font-normal text-emerald-600 bg-emerald-100 border border-emerald-200 px-1.5 py-0.5 rounded-full group-hover:bg-emerald-200">Presiona para expandir</span>
        </span>
        <svg id="cm-offers-chevron" class="w-4 h-4 text-emerald-400 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      <div id="cm-offers-list" class="hidden mt-1.5">
        <div class="text-center py-4 text-[12px] text-slate-400">Cargando productos...</div>
      </div>
    </div>`;
}

// ── Sin precio encontrado (Convenio Marco) ──────────────────────────
function cmPriceNotFoundHtml() {
  return `
    <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
      <svg class="w-4 h-4 flex-shrink-0 text-amber-400 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <div>
        <p class="text-[13px] font-semibold text-amber-700">Sin productos en el catálogo vigente</p>
        <p class="text-[12px] text-amber-600 mt-0.5 leading-snug">No encontramos equipos similares en Convenio Marco. Te mostramos la referencia de Compra Ágil.</p>
      </div>
    </div>`;
}

let _cmOffersData = [];
let _cmOffersFetched = false;

function toggleCMOffers() {
  const list = document.getElementById('cm-offers-list');
  const chevron = document.getElementById('cm-offers-chevron');
  if (!list) return;
  const isHidden = list.classList.contains('hidden');
  list.classList.toggle('hidden');
  if (chevron) chevron.style.transform = isHidden ? 'rotate(180deg)' : '';
  if (isHidden && !_cmOffersFetched) fetchCMOffers();
}

function _priceQuery(filter) {
  const params = new URLSearchParams();
  if (filter.min != null) params.set('price_min', filter.min);
  if (filter.max != null) params.set('price_max', filter.max);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function fetchCMOffers() {
  const list = document.getElementById('cm-offers-list');
  try {
    const resp = await apiFetch(`/api/cm_offers/${SESSION_ID}${_priceQuery(state.cmOfferPriceFilter)}`, { headers: _headers() });
    if (!resp) return;
    if (!resp.ok) throw new Error('offers fetch failed');
    const { offers } = await resp.json();
    _cmOffersData = offers || [];
    _cmOffersFetched = true;
    renderCMOffers();
  } catch (e) {
    if (list) list.innerHTML = `<div class="text-center py-4 text-[12px] text-red-400">No se pudieron cargar los productos</div>`;
  }
}

function renderCMOffers() {
  const list = document.getElementById('cm-offers-list');
  if (!list) return;

  if (!_cmOffersData.length) {
    list.innerHTML = `<div class="text-center py-4 text-[12px] text-slate-400">Sin productos para mostrar</div>`;
    return;
  }

  const fmt = (n) => n != null
    ? `CLP $${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(n)}`
    : '—';

  const fmtUsd = (n) => n != null
    ? `USD $${new Intl.NumberFormat('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`
    : '—';

  const cards = _cmOffersData.map(o => {
    const extras = [
      o.sistema_operativo ? escapeHtml(o.sistema_operativo) : null,
      o.wifi_generacion ? `Wi-Fi ${escapeHtml(o.wifi_generacion)}` : null,
      o.puntaje_passmark_cpu ? `PassMark ${escapeHtml(o.puntaje_passmark_cpu)}` : null,
      o.peso_equipo ? escapeHtml(o.peso_equipo) : null,
      o.monitor_si_no ? `Monitor: ${escapeHtml(o.monitor_si_no)}` : null,
    ].filter(Boolean).join(' · ');
    const safeHref = safeUrl(o.url);
    const key = `cm:${o.id_producto}`;
    _compareCandidates[key] = _candidateFromCM(o);

    return `
    <div class="bg-white border border-slate-200 rounded-lg px-3 py-2.5 mb-1.5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="text-[12.5px] font-semibold text-slate-700 truncate">${escapeHtml(o.marca ?? '')} ${escapeHtml(o.modelo ?? o.nombre ?? '')}</p>
          <p class="text-[11px] text-slate-400 mt-0.5 truncate">${escapeHtml(o.procesador_principal ?? '—')} &nbsp;·&nbsp; ${escapeHtml(o.total_ram_gb ?? '—')} &nbsp;·&nbsp; ${escapeHtml(o.total_almacenamiento_gb ?? '—')}</p>
          ${extras ? `<p class="text-[10.5px] text-slate-400 mt-1 truncate">${extras}</p>` : ''}
        </div>
        <div class="text-right flex-shrink-0">
          <p class="text-[13px] font-semibold text-slate-700">${fmt(o.precio_min_clp)}${o.precio_max_clp && o.precio_max_clp !== o.precio_min_clp ? ` – ${fmt(o.precio_max_clp)}` : ''}</p>
          <p class="text-[10.5px] text-slate-400 mt-0.5">${fmtUsd(o.precio_min_usd)}${o.precio_max_usd && o.precio_max_usd !== o.precio_min_usd ? ` – ${fmtUsd(o.precio_max_usd)}` : ''}</p>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-1.5 mt-2">
        ${_compareToggleBtn(key)}
        ${safeHref ? `
        <a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold rounded-md transition-colors">
          Ver en Convenio Marco
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
          </svg>
        </a>` : ''}
      </div>
    </div>`;
  }).join('');

  list.innerHTML = `<div class="max-h-80 overflow-y-auto pr-0.5">${cards}</div>`;
}

// ── Comparador de candidatos ─────────────────────────────────────
// Cualquier oferta real (Compra Ágil o Convenio Marco) se puede marcar
// como "candidato" para comparar hasta MAX_COMPARE lado a lado antes de
// cerrar la ficha -- mismo patrón visual del carrito de Medicamentos
// (barra flotante + panel), pero comparando alternativas para UNA misma
// necesidad, no acumulando requerimientos distintos.
const _compareCandidates = {}; // key -> candidato normalizado, fuente de verdad para el modal

function _fmtSpec(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (v === true || v === 'true') return 'Sí';
  if (v === false || v === 'false') return 'No';
  return String(v);
}

function _fmtGB(v) {
  if (v === null || v === undefined || v === '') return '—';
  const s = String(v);
  return /gb/i.test(s) ? s : `${s} GB`;
}

function _compareFmtClp(n) {
  return n != null
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
    : '—';
}

// Normaliza una oferta de Compra Ágil (price_service.get_offer_rows) al shape común del comparador.
function _candidateFromCA(o) {
  return {
    key: `ca:${o.id_oferta_aquiles}`,
    source: 'Compra Ágil',
    sourceColor: 'brand',
    label: o.razon_social || o.marca || 'Oferta Compra Ágil',
    marca: _fmtSpec(o.marca),
    procesador_principal: _fmtSpec(o.procesador_principal),
    total_ram_gb: _fmtGB(o.total_ram_gb),
    tecnologia_ram: _fmtSpec(o.tecnologia_ram),
    total_almacenamiento_gb: _fmtGB(o.total_almacenamiento_gb),
    tecnologia_disco_principal: _fmtSpec(o.tecnologia_disco_principal),
    tiene_gpu_dedicada: _fmtSpec(o.tiene_gpu_dedicada),
    sistema_operativo: _fmtSpec(o.sistema_operativo),
    precio: _compareFmtClp(o.precio_unitario_iva ?? o.precio_unitario),
    precioNota: 'con IVA',
    link: o.ca_available ? o.ca_url : (o.oc_urls && o.oc_urls[0]) || null,
  };
}

// Normaliza un producto del catálogo Convenio Marco (cm_service.get_offer_rows).
function _candidateFromCM(o) {
  const precio = o.precio_max_clp && o.precio_max_clp !== o.precio_min_clp
    ? `${_compareFmtClp(o.precio_min_clp)} – ${_compareFmtClp(o.precio_max_clp)}`
    : _compareFmtClp(o.precio_min_clp);
  return {
    key: `cm:${o.id_producto}`,
    source: 'Convenio Marco',
    sourceColor: 'emerald',
    label: [o.marca, o.modelo || o.nombre].filter(Boolean).join(' ') || 'Producto Convenio Marco',
    marca: _fmtSpec(o.marca),
    procesador_principal: _fmtSpec(o.procesador_principal),
    total_ram_gb: _fmtGB(o.total_ram_gb),
    tecnologia_ram: _fmtSpec(o.tecnologia_ram),
    total_almacenamiento_gb: _fmtGB(o.total_almacenamiento_gb),
    tecnologia_disco_principal: _fmtSpec(o.tecnologia_disco_principal),
    tiene_gpu_dedicada: _fmtSpec(o.tiene_gpu_dedicada),
    sistema_operativo: _fmtSpec(o.sistema_operativo),
    precio,
    precioNota: 'catálogo',
    link: o.url || null,
  };
}

function toggleEl(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden');
}

function isInCompare(key) {
  return state.compareItems.some(c => c.key === key);
}

// ── Persistencia de la selección (por conversación) ──────────────────────
// El carrito de comparación es parte de la conversación activa, no del
// usuario a secas -- así cada conversación tiene el suyo propio, sin
// mezclarse (ver chat_session_service.py). Se manda tal cual (ya trae
// label/specs/precio/link), sin depender de que las tarjetas originales
// estén renderizadas. La carga inicial ocurre junto con el resto de la
// conversación en loadActiveSession(), no acá.
let _saveCompareTimer = null;
function saveCompareSelection() {
  clearTimeout(_saveCompareTimer);
  _saveCompareTimer = setTimeout(() => {
    apiFetch(`/api/compare/${SESSION_ID}`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({ items: state.compareItems }),
    }).catch(() => {});
  }, 400);
}

// Botón explícito (no checkbox) para marcar un candidato como "a comparar" --
// más visible/intuitivo que un checkbox chico incrustado en el texto de la
// tarjeta (feedback de revisión: "solo presionar el cuadrado es poco
// intuitivo"). Mismo mecanismo de estado (toggleCompare), solo cambia el
// control visual y cómo se refresca (por data-key, no por .checked).
function _compareToggleBtn(key) {
  const active = isInCompare(key);
  return `<button type="button" class="compare-toggle-btn inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10.5px] font-semibold border transition-colors flex-shrink-0 ${active ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white border-slate-300 text-slate-500 hover:border-brand-400 hover:text-brand-600'}" data-key="${escapeHtml(key)}" aria-pressed="${active}" onclick="event.stopPropagation();toggleCompare('${key}')">
    <svg class="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
    ${active ? 'Comparando' : 'Comparar'}
  </button>`;
}

function toggleCompare(key) {
  _tourNotify('compare-click');
  if (isInCompare(key)) {
    state.compareItems = state.compareItems.filter(c => c.key !== key);
  } else {
    if (state.compareItems.length >= MAX_COMPARE) {
      alert(`Puedes comparar hasta ${MAX_COMPARE} equipos a la vez. Quita uno para agregar otro.`);
      return;
    }
    const cand = _compareCandidates[key];
    if (!cand) return;
    state.compareItems.push(cand);
  }
  const active = isInCompare(key);
  document.querySelectorAll(`.compare-toggle-btn[data-key="${CSS.escape(key)}"]`).forEach(btn => {
    btn.setAttribute('aria-pressed', active);
    btn.classList.toggle('bg-brand-600', active);
    btn.classList.toggle('border-brand-600', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('bg-white', !active);
    btn.classList.toggle('border-slate-300', !active);
    btn.classList.toggle('text-slate-500', !active);
    const label = btn.querySelector('svg').nextSibling;
    if (label) label.textContent = active ? ' Comparando' : ' Comparar';
  });
  renderCompareBar();
  if (!document.getElementById('compare-panel')?.classList.contains('hidden')) {
    renderCompareModalBody();
  }
  saveCompareSelection();
}

function renderCompareBar() {
  const btn = document.getElementById('compare-bar-btn');
  const badge = document.getElementById('compare-count-badge');
  const count = document.getElementById('compare-count');
  if (!btn || !badge || !count) return;
  const n = state.compareItems.length;
  count.textContent = n;
  btn.title = `Comparar equipos marcados (${n}/${MAX_COMPARE})`;
  const hasItems = n > 0;
  badge.classList.toggle('hidden', !hasItems);
  badge.classList.toggle('flex', hasItems);
  btn.classList.toggle('bg-brand-700', hasItems);
  btn.classList.toggle('hover:bg-brand-800', hasItems);
  btn.classList.toggle('shadow-brand-900/20', hasItems);
  btn.classList.toggle('bg-slate-400', !hasItems);
  btn.classList.toggle('hover:bg-slate-500', !hasItems);
  btn.classList.toggle('shadow-slate-900/10', !hasItems);
}

// _compareView: qué vista está activa dentro del panel -- 'selection'
// (drawer angosto, candidatos agrupados por mecanismo, sin tabla) o
// 'matrix' (panel expandido casi a pantalla completa, tabla invertida por
// mecanismo, ver _renderCompareMatrixView()). Se resetea a 'selection'
// cada vez que se abre el panel (openCompareModal()).
let _compareView = 'selection';
// Pestaña activa dentro de la vista Comparativa -- se recalcula sola en
// cada render si la fuente activa se quedó sin candidatos (ver abajo).
let _compareMatrixSource = null;

function openCompareModal() {
  if (!state.compareItems.length) return;
  _tourNotify('compare-click');
  _compareView = 'selection';
  renderCompareModalBody();
  document.getElementById('compare-panel')?.classList.remove('hidden');
}

function closeCompareModal() {
  document.getElementById('compare-panel')?.classList.add('hidden');
}

function removeCompareItem(key) {
  state.compareItems = state.compareItems.filter(c => c.key !== key);
  document.querySelectorAll(`.compare-toggle-btn[data-key="${CSS.escape(key)}"]`).forEach(btn => {
    btn.setAttribute('aria-pressed', 'false');
    btn.classList.remove('bg-brand-600', 'border-brand-600', 'text-white');
    btn.classList.add('bg-white', 'border-slate-300', 'text-slate-500');
    const label = btn.querySelector('svg').nextSibling;
    if (label) label.textContent = ' Comparar';
  });
  renderCompareBar();
  saveCompareSelection();
  if (!state.compareItems.length) { closeCompareModal(); return; }
  renderCompareModalBody();
}

const COMPARE_ROWS = [
  ['marca', 'Marca'],
  ['procesador_principal', 'Procesador'],
  ['total_ram_gb', 'RAM'],
  ['tecnologia_ram', 'Tecnología RAM'],
  ['total_almacenamiento_gb', 'Almacenamiento'],
  ['tecnologia_disco_principal', 'Tecnología disco'],
  ['tiene_gpu_dedicada', 'GPU dedicada'],
  ['sistema_operativo', 'Sistema operativo'],
];

// Agrupa state.compareItems por mecanismo de compra -- siempre devuelve
// las 2 claves (arrays vacíos si no hay candidatos de esa fuente), para
// que el resto del código no tenga que chequear undefined.
function _compareGroups() {
  const groups = { 'Convenio Marco': [], 'Compra Ágil': [] };
  state.compareItems.forEach(c => { if (groups[c.source]) groups[c.source].push(c); });
  return groups;
}

// Dispatcher: dibuja el segmentado "Selección/Comparativa" del header, el
// ancho del panel según la vista activa, y delega el cuerpo a la vista
// correspondiente. Antes esto era una sola función que armaba una tabla
// mezclando Convenio Marco y Compra Ágil -- ahora hay 2 vistas separadas
// (ver _renderCompareSelectionView()/_renderCompareMatrixView() abajo).
function renderCompareModalBody() {
  const body = document.getElementById('compare-modal-body');
  const sheet = document.getElementById('compare-panel-sheet');
  const tabsEl = document.getElementById('compare-view-tabs');
  if (!body || !sheet || !tabsEl) return;

  const n = state.compareItems.length;
  const tabCls = (active) => `flex-1 text-[11.5px] font-semibold py-1.5 rounded-md transition-colors ${active ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`;
  tabsEl.innerHTML = `
    <button type="button" onclick="_setCompareView('selection')" class="${tabCls(_compareView === 'selection')}">Selección (${n})</button>
    <button type="button" onclick="_setCompareView('matrix')" class="${tabCls(_compareView === 'matrix')}">Comparativa</button>`;

  sheet.classList.toggle('max-w-md', _compareView === 'selection');
  sheet.classList.toggle('max-w-[96vw]', _compareView === 'matrix');
  sheet.classList.toggle('lg:max-w-[92vw]', _compareView === 'matrix');

  if (_compareView === 'matrix') _renderCompareMatrixView(body);
  else _renderCompareSelectionView(body);
}

function _setCompareView(view) {
  _compareView = view;
  renderCompareModalBody();
}

// Vista inicial al abrir el panel: candidatos "a secas", agrupados por
// mecanismo de compra, cada uno como tarjeta (specs clave + precio + link)
// -- mismo patrón visual que las tarjetas de _renderOfferCards()/
// renderCMOffers(), sin armar todavía la tabla comparativa.
function _renderCompareSelectionView(body) {
  const groups = _compareGroups();

  const cardHtml = (c) => `
    <div class="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2.5 mb-2">
      <div class="flex items-start justify-between gap-2">
        <p class="text-[12.5px] font-semibold text-slate-800 leading-tight truncate min-w-0 flex-1">${escapeHtml(c.label)}</p>
        <button onclick="removeCompareItem('${c.key}')" class="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50" aria-label="Quitar de la comparación">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <p class="text-[11px] text-slate-400 mt-0.5 truncate">${escapeHtml(c.procesador_principal)} · ${escapeHtml(c.total_ram_gb)} · ${escapeHtml(c.total_almacenamiento_gb)} · ${escapeHtml(c.sistema_operativo)}</p>
      <div class="flex items-center justify-between mt-2">
        <p class="text-[13.5px] font-bold text-brand-700">${escapeHtml(c.precio)} <span class="text-[10px] font-normal text-slate-400">${escapeHtml(c.precioNota || '')}</span></p>
        ${c.link ? `<a href="${escapeHtml(safeUrl(c.link))}" target="_blank" rel="noopener" class="text-[11px] font-semibold text-brand-600 hover:text-brand-700 hover:underline">Ver origen →</a>` : ''}
      </div>
    </div>`;

  const sectionHtml = (label, colorClass, items) => {
    if (!items.length) return '';
    return `
      <div class="mb-4">
        <p class="text-[10.5px] font-semibold uppercase tracking-wide ${colorClass} mb-2">${label} <span class="text-slate-400 font-normal normal-case">(${items.length})</span></p>
        ${items.map(cardHtml).join('')}
      </div>`;
  };

  body.innerHTML = `
    ${sectionHtml('Convenio Marco', 'text-emerald-600', groups['Convenio Marco'])}
    ${sectionHtml('Compra Ágil', 'text-brand-600', groups['Compra Ágil'])}
    <button type="button" onclick="_setCompareView('matrix')" class="w-full mt-1 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[13px] font-semibold rounded-lg transition-colors">Ver comparativa →</button>`;
}

// Vista "Comparativa": tabla invertida respecto al diseño anterior --
// antes atributos en fila y equipos en columna (no escalaba bien más allá
// de 3-4 candidatos ni se leía bien en el PDF); ahora un candidato por
// fila y los atributos de COMPARE_ROWS en columna. Separada en pestañas
// por mecanismo de compra para no mezclar Convenio Marco con Compra Ágil
// en la misma tabla -- la pestaña sin candidatos queda deshabilitada, y si
// la fuente activa se queda sin candidatos (se quitó el último), el
// render siguiente cae solo a la primera fuente que sí tenga.
function _renderCompareMatrixView(body) {
  const groups = _compareGroups();
  const sources = ['Convenio Marco', 'Compra Ágil'].filter(s => groups[s].length);
  if (!sources.length) { body.innerHTML = ''; return; }
  if (!_compareMatrixSource || !groups[_compareMatrixSource].length) {
    _compareMatrixSource = sources[0];
  }

  const tabBtn = (source, activeColorClass) => {
    const count = groups[source].length;
    const disabled = count === 0;
    const active = _compareMatrixSource === source;
    const cls = disabled
      ? 'text-slate-300 cursor-not-allowed'
      : active ? `${activeColorClass} text-white shadow-sm`
      : 'text-slate-500 bg-slate-100 hover:bg-slate-200';
    return `<button type="button" ${disabled ? 'disabled' : `onclick="_setCompareMatrixSource('${source}')"`} class="px-3 py-1.5 rounded-md text-[11.5px] font-semibold transition-colors ${cls}">${source} (${count})</button>`;
  };

  const items = groups[_compareMatrixSource];
  const headerCells = COMPARE_ROWS.map(([, label]) => `<th class="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">${label}</th>`).join('');
  const rows = items.map(c => `
    <tr class="border-t border-slate-100">
      <td class="px-3 py-2.5 align-top min-w-[170px]">
        <button onclick="removeCompareItem('${c.key}')" class="float-right w-5 h-5 flex items-center justify-center rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 ml-1" aria-label="Quitar de la comparación">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
        <p class="text-[12.5px] font-semibold text-slate-800 leading-tight">${escapeHtml(c.label)}</p>
      </td>
      ${COMPARE_ROWS.map(([attr]) => `<td class="px-3 py-2.5 text-[12px] text-slate-700 font-medium whitespace-nowrap">${escapeHtml(c[attr])}</td>`).join('')}
      <td class="px-3 py-2.5 whitespace-nowrap">
        <p class="text-[13px] font-bold text-brand-700">${escapeHtml(c.precio)}</p>
        <p class="text-[10px] text-slate-400">${escapeHtml(c.precioNota || '')}</p>
      </td>
      <td class="px-3 py-2.5">${c.link
        ? `<a href="${escapeHtml(safeUrl(c.link))}" target="_blank" rel="noopener" class="text-[11px] font-semibold text-brand-600 hover:text-brand-700 hover:underline">Ver origen →</a>`
        : `<span class="text-[11px] text-slate-300">—</span>`}</td>
    </tr>`).join('');

  body.innerHTML = `
    <div class="flex items-center gap-1 mb-3 bg-slate-100 rounded-lg p-1 w-fit">
      ${tabBtn('Convenio Marco', 'bg-emerald-600')}
      ${tabBtn('Compra Ágil', 'bg-brand-600')}
    </div>
    <div class="overflow-x-auto">
      <table class="w-full border-collapse">
        <thead><tr>
          <th class="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Equipo</th>
          ${headerCells}
          <th class="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Precio</th>
          <th class="px-3 py-2.5"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function _setCompareMatrixSource(source) {
  _compareMatrixSource = source;
  renderCompareModalBody();
}

let _offersData = [];
let _offersSort = 'fecha_desc';
let _offersGroup = 'none'; // 'none' | 'proveedor' | 'anio'
let _offersExpanded = new Set(); // claves de grupos expandidos (default: todos colapsados)
let _offersGroupKeys = [];       // orden de grupos del render actual, para onclick por índice
let _offersFetched = false;

function toggleOffers() {
  const list = document.getElementById('offers-list');
  const chevron = document.getElementById('offers-chevron');
  if (!list) return;
  const isHidden = list.classList.contains('hidden');
  list.classList.toggle('hidden');
  if (chevron) chevron.style.transform = isHidden ? 'rotate(180deg)' : '';
  if (isHidden && (!_offersFetched || !_methodologyFetched)) fetchOffersAndMethodology();
}

// Trae la lista de transacciones y la metodología en paralelo (2 requests
// independientes, cada una a su propia consulta SQL) pero espera a que
// ambas terminen antes de pintar cualquiera de las dos -- antes cada fetch
// se renderizaba apenas llegaba la suya, así que la más lenta (casi
// siempre la metodología, que hace un JOIN extra) aparecía "de golpe" un
// instante después de las transacciones, en vez de mostrarse juntas.
async function fetchOffersAndMethodology() {
  await Promise.all([
    _offersFetched ? Promise.resolve() : fetchOffers({ render: false }),
    _methodologyFetched ? Promise.resolve() : fetchMethodology({ render: false }),
  ]);
  renderOffers();
}

// ── Metodología de la estimación (trazabilidad) ──────────────────────
// Cantidad de transacciones, período y tipo de organismo, calculado sobre
// TODO el universo que calza con la ficha (no solo la página de 30 filas
// del historial) -- para poder justificar la cifra ante control interno.
let _methodologyData = null;
let _methodologyFetched = false;

async function fetchMethodology({ render = true } = {}) {
  try {
    const resp = await apiFetch(`/api/price_methodology/${SESSION_ID}`, { headers: _headers() });
    if (!resp || !resp.ok) return;
    const { methodology } = await resp.json();
    _methodologyData = methodology;
    _methodologyFetched = true;
    if (render) renderMethodology();
  } catch (e) {
    // Silencioso -- si falla, el historial de todas formas se ve sin este bloque.
  }
}

function renderMethodology() {
  const el = document.getElementById('offers-methodology');
  if (!el) return;
  if (!_methodologyData) { el.innerHTML = ''; return; }
  const m = _methodologyData;
  const total = m.organismos.reduce((s, o) => s + o.count, 0) || 1;
  const orgChips = m.organismos.map(o => {
    const pct = Math.round((o.count / total) * 100);
    return `<span class="inline-flex items-center gap-1 bg-white border border-slate-200 rounded-full px-2 py-0.5 text-[10px] text-slate-600 whitespace-nowrap">${escapeHtml(o.tipo)} <span class="text-slate-400 font-semibold">${pct}%</span></span>`;
  }).join('');
  el.innerHTML = `
    <div class="bg-brand-50/70 border border-brand-100 rounded-lg px-3 py-2 mb-2">
      <p class="text-[10px] font-semibold text-brand-600 uppercase tracking-wide mb-1">Metodología de esta estimación</p>
      <p class="text-[11.5px] text-slate-600 mb-1.5"><strong>${m.count.toLocaleString('es-CL')}</strong> transacciones consideradas · período <strong>${escapeHtml(m.fecha_min || '—')}</strong> a <strong>${escapeHtml(m.fecha_max || '—')}</strong></p>
      <p class="text-[10px] text-slate-400 mb-1">Desagregado por tipo de organismo comprador:</p>
      <div class="flex flex-wrap gap-1">${orgChips}</div>
    </div>`;
}

async function fetchOffers({ render = true } = {}) {
  const list = document.getElementById('offers-list');
  if (!list) return;
  try {
    const resp = await apiFetch(`/api/offers/${SESSION_ID}${_priceQuery(state.offerPriceFilter)}`, { headers: _headers() });
    if (!resp) return;
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { offers } = await resp.json();
    _offersData = offers || [];
    _offersFetched = true;
    if (render) renderOffers();
  } catch (e) {
    if (render && list) list.innerHTML = `<div class="text-center py-3 text-[12px] text-red-400">Error al cargar transacciones</div>`;
  }
}

function setOffersSort(key) {
  if (_offersSort.startsWith(key)) {
    _offersSort = _offersSort.endsWith('_desc') ? key + '_asc' : key + '_desc';
  } else {
    _offersSort = key + '_desc';
  }
  _updateOfferControls();
  _renderOfferCards();
}

function setOffersGroup(key) {
  _offersGroup = _offersGroup === key ? 'none' : key;
  _offersExpanded = new Set();
  _offersGroupKeys = [];
  _updateOfferControls();
  _renderOfferCards();
}

function toggleOfferGroup(idx) {
  const key = _offersGroupKeys[idx];
  if (key === undefined) return;
  if (_offersExpanded.has(key)) {
    _offersExpanded.delete(key);
  } else {
    _offersExpanded.add(key);
  }
  _renderOfferCards();
}

function _updateOfferControls() {
  ['fecha', 'precio'].forEach(key => {
    const btn = document.getElementById(`offers-sort-${key}`);
    if (!btn) return;
    const active = _offersSort.startsWith(key);
    const asc = _offersSort === key + '_asc';
    btn.className = `inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
      active ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
    }`;
    btn.innerHTML = (key === 'fecha' ? 'Fecha' : 'Precio') + (active ? (asc ? ' ↑' : ' ↓') : ' ↓');
  });
  ['proveedor', 'anio'].forEach(key => {
    const btn = document.getElementById(`offers-group-${key}`);
    if (!btn) return;
    const active = _offersGroup === key;
    btn.className = `inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
      active ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
    }`;
  });
}

// Detalle expandible por tarjeta -- qué atributos mostrar y con qué
// etiqueta, agrupados igual que PDF_SECTIONS para que se sienta consistente
// con el resto de la app. Reusa las etiquetas de ATTRS donde ya existen;
// agrega las pocas columnas reales de PrecioCA que no forman parte de la
// ficha (línea de producto, modelo, generación de procesador, etc.) pero sí
// sirven para ver el equipo completo, no solo lo que el usuario pidió.
// Fuera de esta lista a propósito: columnas administrativas (es_accesorio,
// ROWNUM, unidad_venta) y resolucion_pantalla_pixeles (viene como total de
// píxeles sin ancho×alto -- no es legible para una persona).
const _OFFER_DETAIL_SECTIONS = [
  { label: 'General',        fields: ['tipo_equipo', 'marca', 'linea_producto', 'nombre_modelo'] },
  { label: 'Procesador',     fields: ['procesador_principal', 'linea_procesador', 'generacion_procesador', 'nucleos_procesador', 'hilos_procesador', 'frecuencia_turbo_procesador_mhz'] },
  { label: 'Memoria RAM',    fields: ['total_ram_gb', 'tecnologia_ram', 'frecuencia_ram_mhz'] },
  { label: 'Almacenamiento', fields: ['total_almacenamiento_gb', 'tecnologia_disco_principal', 'tipo_configuracion_discos'] },
  { label: 'Gráficos',       fields: ['tiene_gpu_dedicada', 'gpu_dedicada_nombre', 'total_vram_gpu_gb', 'tecnologia_gpu_principal'] },
  { label: 'Otros',          fields: ['pantalla_pulgadas', 'sistema_operativo', 'wifi_generacion', 'part_number'] },
];
const _OFFER_DETAIL_LABELS = {
  generacion_procesador:     'Generación procesador',
  tecnologia_gpu_principal:  'Tecnología GPU',
  linea_producto:            'Línea de producto',
  nombre_modelo:             'Modelo',
  part_number:               'N° de parte',
};

// "No especificado" (y variantes de espacio/casing) es un placeholder real
// que deja la carga de datos de PrecioCA, no un valor -- se trata como
// ausente, igual que null/'' , para no llenar el detalle de ruido.
function _fmtDetailVal(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^no especificado$/i.test(s)) return null;
  if (s === 'true') return 'Sí';
  if (s === 'false') return 'No';
  return s;
}

function _offerDetailHtml(o) {
  const sections = _OFFER_DETAIL_SECTIONS
    .map(sec => {
      const rows = sec.fields
        .map(f => ({ label: _OFFER_DETAIL_LABELS[f] || (ATTRS[f] && ATTRS[f].label) || f, val: _fmtDetailVal(o[f]) }))
        .filter(r => r.val !== null);
      if (!rows.length) return '';
      return `
        <div>
          <p class="text-[9.5px] font-semibold text-slate-400 uppercase tracking-wide mb-1">${escapeHtml(sec.label)}</p>
          <div class="grid grid-cols-2 gap-x-3 gap-y-0.5">
            ${rows.map(r => `<div class="flex justify-between gap-2 text-[11px]"><span class="text-slate-400">${escapeHtml(r.label)}</span><span class="text-slate-700 font-medium text-right">${escapeHtml(r.val)}</span></div>`).join('')}
          </div>
        </div>`;
    })
    .filter(Boolean)
    .join('');
  return sections || `<p class="text-[11px] text-slate-400">Sin más atributos disponibles para este equipo.</p>`;
}

let _offerDetailsOpen = new Set();
function toggleOfferDetail(key) {
  if (_offerDetailsOpen.has(key)) _offerDetailsOpen.delete(key);
  else _offerDetailsOpen.add(key);
  _renderOfferCards();
}

function _renderOfferCards() {
  const cards = document.getElementById('offers-cards');
  if (!cards) return;

  const fmt = (n) => n != null
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
    : '—';

  const sorted = [..._offersData].sort((a, b) => {
    if (_offersSort === 'fecha_desc')  return (b.fecha_modificacion || '').localeCompare(a.fecha_modificacion || '');
    if (_offersSort === 'fecha_asc')   return (a.fecha_modificacion || '').localeCompare(b.fecha_modificacion || '');
    if (_offersSort === 'precio_desc') return (b.precio_unitario || 0) - (a.precio_unitario || 0);
    if (_offersSort === 'precio_asc')  return (a.precio_unitario || 0) - (b.precio_unitario || 0);
    return 0;
  });

  const _iconExternal = `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>`;
  const _iconDoc      = `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>`;
  const _iconList     = `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h7"/></svg>`;
  const _btnOk  = (href, icon, label) => `<a href="${escapeHtml(safeUrl(href))}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${icon === _iconDoc ? 'bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-100 hover:border-teal-400' : 'bg-brand-50 text-brand-700 border-brand-200 hover:bg-brand-100 hover:border-brand-400'}">${icon}${label}</a>`;
  const _btnOff = (icon, label) => `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium border bg-slate-50 text-slate-400 border-slate-200">${icon}${label}</span>`;

  const renderCard = (o, hideProvider = false) => {
    const ocUrls = o.oc_urls || [];
    const ocBtns = ocUrls.map((url, i) =>
      _btnOk(url, _iconExternal, ocUrls.length === 1 ? 'Ver OC' : `OC ${i + 1}`)
    );
    const ocSection = ocBtns.length ? ocBtns.join('') : _btnOff(_iconExternal, 'OC no disponible');
    const caSection = o.ca_available
      ? _btnOk(o.ca_url, _iconDoc, 'Detalle Compra Ágil')
      : _btnOff(_iconDoc, 'Ficha no disponible');

    const key = `ca:${o.id_oferta_aquiles ?? o.codigo_requerimiento}`;
    _compareCandidates[key] = _candidateFromCA(o);

    const detailOpen = _offerDetailsOpen.has(key);
    const detailBtn = `<button type="button" onclick="event.stopPropagation();toggleOfferDetail('${key}')" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${detailOpen ? 'bg-slate-700 border-slate-700 text-white' : 'bg-white border-slate-300 text-slate-500 hover:border-slate-400 hover:text-slate-700'}">${_iconList}${detailOpen ? 'Ocultar detalle' : 'Ver detalle del producto'}</button>`;

    return `
      <div class="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            ${!hideProvider && o.razon_social ? `<p class="text-[12px] font-semibold text-slate-800 leading-tight mb-0.5">${escapeHtml(o.razon_social)}</p>` : ''}
            ${o.descripcion ? `<p class="text-[11px] text-slate-500 leading-snug mb-1">${escapeHtml(o.descripcion)}</p>` : ''}
            <p class="text-[10px] text-slate-400">${escapeHtml(o.codigo_requerimiento || '')} ${o.fecha_modificacion ? '· ' + escapeHtml(o.fecha_modificacion) : ''}</p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[14px] font-semibold text-slate-700">${fmt(o.precio_unitario)}</p>
            <p class="text-[12px] text-slate-400">${fmt(o.precio_unitario_iva)} c/IVA</p>
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5 mt-1.5">${detailBtn}${_compareToggleBtn(key)}${ocSection}${caSection}</div>
        ${detailOpen ? `<div class="mt-2 pt-2 border-t border-slate-200 space-y-2">${_offerDetailHtml(o)}</div>` : ''}
      </div>`;
  };

  if (_offersGroup === 'none') {
    cards.innerHTML = sorted.map(o => renderCard(o)).join('');
    return;
  }

  const getGroupKey = (o) => {
    if (_offersGroup === 'proveedor') return o.razon_social || 'Proveedor no Identificado';
    if (_offersGroup === 'anio')      return o.fecha_modificacion ? o.fecha_modificacion.slice(0, 4) : '(Sin fecha)';
    return '';
  };

  const grouped = new Map();
  for (const o of sorted) {
    const key = getGroupKey(o);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(o);
  }

  const groupKeys = [...grouped.keys()].sort((a, b) =>
    _offersGroup === 'anio' ? b.localeCompare(a) : a.localeCompare(b, 'es')
  );
  _offersGroupKeys = groupKeys;

  const hideProvider = _offersGroup === 'proveedor';
  const _chevronDown  = `<svg class="w-3 h-3 flex-shrink-0 text-slate-400 transition-transform" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>`;
  const _chevronRight = `<svg class="w-3 h-3 flex-shrink-0 text-slate-400 transition-transform" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>`;

  cards.innerHTML = groupKeys.map((key, idx) => {
    const items = grouped.get(key);
    const expanded = _offersExpanded.has(key);
    return `
      <div class="mb-1">
        <button onclick="toggleOfferGroup(${idx})"
          class="w-full flex items-center gap-2 px-1 py-1.5 rounded-md hover:bg-slate-100 transition-colors cursor-pointer">
          ${expanded ? _chevronDown : _chevronRight}
          <span class="text-[10px] font-semibold text-slate-600 uppercase tracking-wide truncate text-left">${escapeHtml(key)}</span>
          <span class="text-[10px] text-slate-400 flex-shrink-0 bg-slate-100 px-1.5 py-0.5 rounded-full">${items.length}</span>
          <div class="flex-1 h-px bg-slate-200"></div>
        </button>
        ${expanded ? `<div class="space-y-1.5 mt-1">${items.map(o => renderCard(o, hideProvider)).join('')}</div>` : ''}
      </div>`;
  }).join('');
}

function renderOffers() {
  const list = document.getElementById('offers-list');
  if (!list) return;
  if (!_offersData.length) {
    list.innerHTML = `<div class="text-center py-3 text-[12px] text-slate-400">No se encontraron transacciones recientes</div>`;
    return;
  }
  list.innerHTML = `
    <div id="offers-methodology"></div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 px-0.5">
      <div class="flex items-center gap-1">
        <span class="text-[10px] text-slate-400">Ordenar:</span>
        <button id="offers-sort-fecha"  onclick="setOffersSort('fecha')"  class=""></button>
        <button id="offers-sort-precio" onclick="setOffersSort('precio')" class=""></button>
      </div>
      <div class="w-px h-3 bg-slate-200"></div>
      <div class="flex items-center gap-1">
        <span class="text-[10px] text-slate-400">Agrupar:</span>
        <button id="offers-group-proveedor" onclick="setOffersGroup('proveedor')" class="">Proveedor</button>
        <button id="offers-group-anio"      onclick="setOffersGroup('anio')"      class="">Año</button>
      </div>
    </div>
    <div id="offers-cards" class="max-h-80 overflow-y-auto pr-0.5"></div>`;
  _updateOfferControls();
  _renderOfferCards();
  renderMethodology();
}

// ── Sin precio encontrado ─────────────────────────────────────────
function priceNotFoundHtml() {
  return `
    <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
      <svg class="w-4 h-4 flex-shrink-0 text-amber-400 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <div>
        <p class="text-[13px] font-semibold text-amber-700">Sin precio de referencia disponible</p>
        <p class="text-[12px] text-amber-600 mt-0.5 leading-snug">No encontramos ofertas similares en Compra Ágil, ni ampliando la búsqueda — probablemente el tipo de equipo, la RAM o el almacenamiento pedidos son muy específicos. Cuéntale al asistente qué podrías ajustar y te va a sugerir cómo seguir.</p>
      </div>
    </div>`;
}

// ── Estado vacío del precio ───────────────────────────────────────
function priceEmptyHtml() {
  return `
    <div class="bg-white border border-dashed border-slate-200 rounded-xl px-4 py-3 flex items-center gap-3 text-slate-400">
      <svg class="w-4 h-4 flex-shrink-0 text-slate-300" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
      </svg>
      <p class="text-[13px] leading-snug">La estimación de precio aparecerá cuando la ficha tenga suficientes datos</p>
    </div>`;
}

// ── Precio mercado externo (LightGBM) ────────────────────────────
// ── Ficha: indicador de carga ─────────────────────────────────────
function showFichaLoading() {
  const el = document.getElementById('ficha-loading-bar');
  if (el) { el.classList.remove('hidden'); el.classList.add('flex'); }
}

function hideFichaLoading() {
  const el = document.getElementById('ficha-loading-bar');
  if (el) { el.classList.remove('flex'); el.classList.add('hidden'); }
}

// ── Descarga PDF ──────────────────────────────────────────────────
const PDF_SECTIONS = [
  { label: 'General',           attrs: ['tipo_equipo'] },
  { label: 'Procesador',        attrs: ['procesador_principal','linea_procesador','nucleos_procesador','hilos_procesador','frecuencia_turbo_procesador_mhz'] },
  { label: 'Memoria RAM',       attrs: ['total_ram_gb','tecnologia_ram','frecuencia_ram_mhz'] },
  { label: 'Almacenamiento',    attrs: ['total_almacenamiento_gb','tecnologia_disco_principal','tipo_configuracion_discos'] },
  { label: 'Gráficos',          attrs: ['tiene_gpu_dedicada','gpu_dedicada_nombre','total_vram_gpu_gb'] },
  { label: 'Otros (opcional)',  attrs: ['marca','pantalla_pulgadas','sistema_operativo','wifi_generacion'] },
];

async function downloadFichaPDF() {
  _tourNotify('pdf-click');
  const anyFilled = Object.values(state.ficha).some(f => f?.value != null);
  if (!anyFilled) {
    alert('La ficha aún no tiene datos. Completa al menos un atributo antes de descargar.');
    return;
  }

  // Deja constancia de la metodología en el PDF aunque el usuario nunca
  // haya expandido "Ver historial de transacciones" -- se trae acá si
  // todavía no se pidió, en vez de omitir el bloque en el PDF final.
  if (state.priceData && !_methodologyFetched) {
    await fetchMethodology();
  }

  const origin = window.location.origin;
  const now = new Date().toLocaleDateString('es-CL', { year: 'numeric', month: 'long', day: 'numeric' });
  const fmt = (n) => n != null
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
    : '—';

  let sectionsHtml = '';
  for (const sec of PDF_SECTIONS) {
    const rows = sec.attrs
      .filter(a => state.ficha[a]?.value != null)
      .map(a => {
        const v = state.ficha[a].value;
        const display = escapeHtml(formatAttrValue(v));
        return `<tr><td class="lbl">${escapeHtml(ATTRS[a]?.label ?? a)}</td><td class="val">${display}</td></tr>`;
      })
      .join('');
    if (!rows) continue;
    sectionsHtml += `<div class="sec"><div class="sec-title">${sec.label}</div><table><tbody>${rows}</tbody></table></div>`;
  }

  // Página de precios: page break + diseño en dos columnas
  const ca = state.priceData;
  const cm = state.cmPriceData;
  const _stat = (lbl, val, border = '#dbeafe') =>
    `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid ${border};">
       <span style="font-size:10px;color:#64748b;">${lbl}</span>
       <span style="font-size:10.5px;font-weight:700;color:#1e293b;">${val}</span>
     </div>`;

  let cmCard = '';
  if (cm) {
    cmCard = `
      <div style="flex:1;border:1.5px solid #a7e5c8;border-radius:10px;overflow:hidden;">
        <div style="background:#0f7a4f;padding:20px 22px;">
          <div style="font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:rgba(255,255,255,.7);margin-bottom:8px;">Convenio Marco · Catálogo</div>
          <div style="font-size:32px;font-weight:900;color:#fff;line-height:1;">${fmt(cm.median ?? cm.min)}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.75);margin-top:5px;">precio mediano</div>
        </div>
        <div style="background:#f0faf4;padding:16px 22px;">
          ${_stat('Rango de precios', `${fmt(cm.min)} – ${fmt(cm.max)}`, '#d1f0dd')}
          <div style="font-size:9px;color:#94a3b8;margin-top:10px;font-style:italic;">Basado en ${cm.count.toLocaleString('es-CL')} productos · ${cm.match_description}</div>
        </div>
      </div>`;
  }

  let caCard = '';
  if (ca) {
    caCard = `
      <div style="flex:1;border:1.5px solid #c5d8f5;border-radius:10px;overflow:hidden;">
        <div style="background:#154f96;padding:20px 22px;">
          <div style="font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:rgba(255,255,255,.6);margin-bottom:8px;">Estimación · Compra Ágil (referencial)</div>
          <div style="font-size:32px;font-weight:900;color:#fff;line-height:1;">${fmt(ca.mean)}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.7);margin-top:5px;">estimación sin IVA</div>
          <div style="font-size:13px;font-weight:600;color:rgba(255,255,255,.9);margin-top:4px;">${fmt(ca.mean_iva)} <span style="font-weight:400;font-size:10px;">con IVA</span></div>
        </div>
        <div style="background:#f0f7ff;padding:16px 22px;">
          ${_stat('Rango esperado (sin IVA)', `${fmt(ca.p25)} – ${fmt(ca.p75)}`)}
          ${_stat('Rango esperado (con IVA)', `${fmt(ca.p25_iva)} – ${fmt(ca.p75_iva)}`, 'transparent')}
          <div style="font-size:9px;color:#94a3b8;margin-top:10px;font-style:italic;">Basado en ${ca.count.toLocaleString('es-CL')} ofertas · ${ca.match_description}</div>
        </div>
      </div>`;
  }

  // Metodología de la estimación de Compra Ágil -- solo si el usuario ya
  // expandió "Ver historial de transacciones" en algún momento de la
  // sesión (si no, no se tiene el dato y se omite el bloque en vez de
  // mostrar algo a medias). Deja constancia de cómo se llegó a la cifra,
  // para justificarla ante control interno.
  let methodologyBox = '';
  if (ca && _methodologyData) {
    const m = _methodologyData;
    const totalOrg = m.organismos.reduce((s, o) => s + o.count, 0) || 1;
    const orgLine = m.organismos
      .map(o => `${o.tipo} (${Math.round((o.count / totalOrg) * 100)}%)`)
      .join(' · ');
    methodologyBox = `
      <div style="margin-top:14px;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;background:#fafbfc;">
        <div style="font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;font-weight:700;margin-bottom:6px;">Metodología de la estimación (Compra Ágil)</div>
        <div style="font-size:10px;color:#475569;line-height:1.6;">
          Calculada sobre <strong>${m.count.toLocaleString('es-CL')} transacciones</strong> de Compra Ágil con especificaciones iguales o equivalentes a esta ficha, del período <strong>${m.fecha_min || '—'}</strong> a <strong>${m.fecha_max || '—'}</strong>.
          El rango esperado corresponde al percentil 25 – percentil 75 (el 50% central de esos precios); la estimación es el promedio del mismo conjunto.<br>
          Organismos compradores: ${escapeHtml(orgLine)}.
        </div>
      </div>`;
  }

  const pricePageHtml = (ca || cm) ? `
    <div style="page-break-before:always;padding-top:32px;">
      <div style="background:#0f3d78;color:white;padding:22px 28px;border-radius:10px;margin-bottom:22px;">
        <div style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:6px;">Compra Ágil · Asistente IA</div>
        <div style="font-size:22px;font-weight:800;">Estimación de Precios</div>
        <div style="font-size:10.5px;color:rgba(255,255,255,.65);margin-top:4px;">Generado el ${now}</div>
      </div>
      <div style="display:flex;gap:18px;">
        ${cmCard}${caCard}
      </div>
      ${methodologyBox}
    </div>` : '';

  // Página(s) de comparación de candidatos (opcional, solo si el usuario
  // marcó alguno). Misma orientación invertida que la vista "Comparativa"
  // en pantalla (un candidato por fila, atributos en columna, ver
  // _renderCompareMatrixView() en app.js) y separada en 2 secciones
  // independientes por mecanismo de compra -- antes era una sola tabla
  // mezclando Convenio Marco y Compra Ágil, paginada por grupos de
  // columnas de candidato; ahora el número de columnas es fijo (8
  // atributos de COMPARE_ROWS + precio, sin importar cuántos candidatos
  // haya), así que ya no hace falta esa lógica de "chunking" por ancho --
  // el ancho de cada columna se calcula una sola vez sobre los 692px
  // reales y confirmados de .pdf-wrap (ver nota histórica del punto 1.3,
  // 2ª/4ª actualización, en la bitácora: max-width:780px con
  // box-sizing:border-box + padding:36px 44px da 780-44*2=692px de
  // contenido útil real, y los márgenes negativos no son confiables con
  // html2canvas).
  const cmp = state.compareItems;
  const CONTENT_W = 692;
  const LABEL_W = 100;  // columna "Equipo"
  const PRICE_W = 78;   // columna "Precio"
  const attrColW = Math.floor((CONTENT_W - LABEL_W - PRICE_W) / COMPARE_ROWS.length);
  const tableW = LABEL_W + attrColW * COMPARE_ROWS.length + PRICE_W; // <= CONTENT_W siempre

  const compareSectionHtml = (title, accent, items) => {
    if (!items.length) return '';
    const headHtml = COMPARE_ROWS.map(([, label]) => `
      <th style="text-align:left;padding:6px 5px;border-left:1px solid #dbeafe;width:${attrColW}px;font-size:8px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#64748b;">${label}</th>`).join('');
    const rowsHtml = items.map(c => `
      <tr>
        <td style="font-size:9.5px;font-weight:700;color:#1e293b;padding:6px 5px;border-bottom:1px solid #eef2f7;width:${LABEL_W}px;word-break:break-word;">${escapeHtml(c.label)}</td>
        ${COMPARE_ROWS.map(([attr]) => `<td style="font-size:9px;color:#334155;padding:6px 5px;border-bottom:1px solid #eef2f7;border-left:1px solid #eef2f7;width:${attrColW}px;word-break:break-word;">${escapeHtml(c[attr])}</td>`).join('')}
        <td style="font-size:9.5px;font-weight:800;color:#154f96;padding:6px 5px;border-bottom:1px solid #eef2f7;border-left:1px solid #eef2f7;width:${PRICE_W}px;word-break:break-word;">${escapeHtml(c.precio)}<br><span style="font-size:7.5px;font-weight:400;color:#94a3b8;">${escapeHtml(c.precioNota || '')}</span></td>
      </tr>`).join('');

    return `
    <div style="page-break-before:always;padding-top:32px;">
      <div style="background:${accent};color:white;padding:22px 28px;border-radius:10px;margin-bottom:22px;">
        <div style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:6px;">Compra Ágil · Asistente IA</div>
        <div style="font-size:22px;font-weight:800;">Comparación · ${title}</div>
        <div style="font-size:10.5px;color:rgba(255,255,255,.65);margin-top:4px;">Generado el ${now} · ${items.length} equipo(s) comparado(s)</div>
      </div>
      <table style="width:${tableW}px;max-width:${CONTENT_W}px;table-layout:fixed;border-collapse:collapse;border:1px solid #eef2f7;border-radius:8px;overflow:hidden;">
        <thead><tr>
          <th style="padding:6px 5px;width:${LABEL_W}px;font-size:8px;font-weight:700;text-transform:uppercase;color:#64748b;text-align:left;">Equipo</th>
          ${headHtml}
          <th style="padding:6px 5px;width:${PRICE_W}px;font-size:8px;font-weight:700;text-transform:uppercase;color:#64748b;text-align:left;">Precio</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
  };

  const comparePageHtml = cmp.length
    ? compareSectionHtml('Convenio Marco', '#0f7a4f', cmp.filter(c => c.source === 'Convenio Marco'))
      + compareSectionHtml('Compra Ágil', '#154f96', cmp.filter(c => c.source === 'Compra Ágil'))
    : '';

  const css = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;background:#fff}
    .pdf-wrap{padding:36px 44px;max-width:780px;margin:0 auto}
    .hdr{display:flex;align-items:center;justify-content:space-between;padding-bottom:18px;border-bottom:2.5px solid #0f3d78;margin-bottom:20px}
    .hdr-logos{display:flex;align-items:center;gap:16px}
    .hdr-center{text-align:center}
    .hdr-center h1{font-size:17px;font-weight:700;color:#0f3d78;letter-spacing:-.01em}
    .hdr-center p{font-size:10.5px;color:#64748b;margin-top:3px}
    .logo{height:36px;object-fit:contain}
    .logo-sm{height:30px;object-fit:contain}
    .meta{display:flex;justify-content:space-between;background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;padding:9px 14px;margin-bottom:22px}
    .meta p{font-size:10.5px;color:#64748b}
    .meta strong{color:#334155}
    .sec{margin-bottom:18px;break-inside:avoid;page-break-inside:avoid}
    .sec-title{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#0f3d78;background:#e8f0fb;padding:5px 11px;border-radius:5px;margin-bottom:7px}
    table{width:100%;border-collapse:collapse}
    tr{border-bottom:1px solid #f1f5f9}
    tr:last-child{border-bottom:none}
    .lbl{font-size:10.5px;color:#64748b;padding:5.5px 10px 5.5px 0;width:44%}
    .val{font-size:11px;font-weight:600;color:#1e293b;padding:5.5px 0}
    .ftr{margin-top:28px;padding-top:14px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center}
    .ftr p{font-size:9.5px;color:#94a3b8}
    .badge{background:#0f3d78;color:#fff;font-size:8.5px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:.03em}
  `;

  const contentHtml = `
    <div class="hdr">
      <div class="hdr-logos">
        <img src="${origin}/imagenes/logo-chilecompra.png" class="logo" alt="ChileCompra">
        <img src="${origin}/imagenes/logo-OCP.png" class="logo-sm" alt="OCP">
      </div>
      <div class="hdr-center">
        <h1>Ficha Técnica · Compra Ágil</h1>
        <p>Especificación técnica generada con Asistente IA</p>
      </div>
      <div class="hdr-logos">
        <img src="${origin}/imagenes/logo-UCBerkeley.png" class="logo-sm" alt="UC Berkeley">
        <img src="${origin}/imagenes/logo-uch2.png" class="logo" alt="Universidad de Chile">
      </div>
    </div>
    <div class="meta">
      <p>Generado el <strong>${now}</strong></p>
      <p>Sesión <strong>${SESSION_ID.slice(0,8).toUpperCase()}</strong></p>
    </div>
    ${sectionsHtml}
    ${pricePageHtml}
    ${comparePageHtml}
    <div class="ftr">
      <p>Asistente IA · Compra Ágil · Universidad de Chile</p>
      <span class="badge">COMPRA ÁGIL</span>
    </div>`;

  // Contenedor temporal fuera de pantalla
  const tmpEl = document.createElement('div');
  tmpEl.style.cssText = 'position:fixed;top:0;left:-9999px;width:794px;background:white;z-index:-1;';
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  const wrapEl = document.createElement('div');
  wrapEl.className = 'pdf-wrap';
  wrapEl.innerHTML = contentHtml;
  tmpEl.appendChild(styleEl);
  tmpEl.appendChild(wrapEl);
  document.body.appendChild(tmpEl);

  const filename = `ficha-tecnica-compra-agil-${SESSION_ID.slice(0,6).toLowerCase()}.pdf`;

  fetch(`/api/track/${SESSION_ID}`, { method: 'POST', headers: { ..._headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: 'pdf_download' }) }).catch(() => {});

  html2pdf().set({
    margin: [8, 8, 8, 8],
    filename,
    image:      { type: 'jpeg', quality: 0.97 },
    html2canvas: { scale: 2, useCORS: true, logging: false },
    jsPDF:      { unit: 'mm', format: 'a4', orientation: 'portrait' },
    // Modo 'legacy' (altura fija) corta secciones a la mitad si caen justo
    // en el borde de una página -- 'css' respeta break-inside:avoid (.sec)
    // y evita ese corte a costa de dejar algo más de espacio en blanco.
    pagebreak: { mode: ['css', 'legacy'], avoid: '.sec' },
  }).from(wrapEl).save().finally(() => {
    document.body.removeChild(tmpEl);
  });
}

// ── Reset ─────────────────────────────────────────────────────────
function resetUI() {
  state.ficha = {};
  state.priceData = null;
  state.cmPriceData = null;
  state.activePriceTab = 'cm';
  state.isTyping = false;
  state.streamingBubble = null;
  switchTab('chat');
  hidePriceLoading();
  hideFichaLoading();
  _priceShellReady = false;
  _cmOffersData = [];
  _cmOffersFetched = false;
  state.compareItems = [];
  closeCompareModal();
  renderCompareBar();
  state.offerPriceFilter = { min: null, max: null };
  state.cmOfferPriceFilter = { min: null, max: null };
  _methodologyData = null;
  _methodologyFetched = false;
  _offerDetailsOpen.clear();

  const chatContainer = document.getElementById('chat-messages');
  Array.from(chatContainer.children).forEach(child => {
    if (child.id !== 'chat-empty') child.remove();
  });
  const emptyState = document.getElementById('chat-empty');
  if (emptyState) emptyState.style.display = '';

  Object.keys(ATTRS).forEach(attr => {
    const row = document.getElementById(`attr-${attr}`);
    if (!row) return;
    const vs = row.querySelector('.attr-value');
    const badge = row.querySelector('.attr-badge');
    const trigger = row.querySelector('.attr-trigger');
    if (vs) { vs.textContent = 'sin valor'; vs.className = 'attr-value text-[13px] text-slate-300 italic'; }
    if (badge) { badge.className = 'attr-badge hidden'; badge.textContent = ''; }
    if (trigger) { trigger.classList.add('hidden'); trigger.textContent = ''; }
    cancelEdit(attr);
  });

  document.getElementById('price-container').innerHTML = priceEmptyHtml();
  updateProgress();
}

// ── Conversaciones (sidebar) ─────────────────────────────────────────────
// Reemplaza el viejo "Nueva sesión" (que reescribía la ÚNICA conversación
// existente, perdiendo la anterior) -- cada usuario ahora acumula varias
// conversaciones guardadas (ficha, mensajes, carrito), listadas acá, y
// puede crear, renombrar o eliminar sin perder las demás.

function startNewConversation() {
  resetUI();
  _setSessionId(crypto.randomUUID());
  _setActiveSessionTitle(null);
  _sidebarDeleteConfirmId = null;
  _renderSessionsList();
  closeSidebarMobile();
}

function _setActiveSessionTitle(title) {
  const el = document.getElementById('active-session-title');
  if (el) el.textContent = title || 'Nueva conversación';
}

let _sidebarSessions = [];
let _sidebarDeleteConfirmId = null;

async function loadSessionsList() {
  try {
    const resp = await apiFetch('/api/sessions', { headers: _headers() });
    if (!resp || !resp.ok) return;
    const { sessions } = await resp.json();
    _sidebarSessions = Array.isArray(sessions) ? sessions : [];
    _renderSessionsList();
  } catch (e) { /* silencioso -- el sidebar simplemente arranca vacío */ }
}

// Refresco de fondo tras cada turno completado (chat o edición manual) --
// para que la conversación activa aparezca/suba al tope de la lista sin
// que el usuario tenga que hacer nada. No bloquea ninguna acción visible.
function refreshSidebarAfterTurn() {
  loadSessionsList();
}

function _relativeTime(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `hace ${hr} h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `hace ${day} d`;
  return new Date(iso).toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
}

function _renderSessionsList() {
  const container = document.getElementById('sessions-list');
  if (!container) return;

  if (!_sidebarSessions.length) {
    container.innerHTML = `<p class="px-2 py-4 text-[12px] text-slate-400 text-center">Aún no tienes conversaciones guardadas.</p>`;
    return;
  }

  container.innerHTML = _sidebarSessions.map(s => {
    if (_sidebarDeleteConfirmId === s.session_id) {
      return `
        <div class="rounded-lg px-2 py-2 bg-rose-50 border border-rose-200">
          <p class="text-[12px] text-rose-700 mb-1.5">¿Eliminar esta conversación?</p>
          <div class="flex gap-1.5">
            <button class="flex-1 px-2 py-1 text-[11.5px] font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-md cursor-pointer" onclick="_deleteSessionConfirm('${s.session_id}')">Sí, eliminar</button>
            <button class="flex-1 px-2 py-1 text-[11.5px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-md cursor-pointer" onclick="_deleteSessionCancel()">No</button>
          </div>
        </div>`;
    }
    const active = s.session_id === SESSION_ID;
    return `
      <div class="group relative rounded-lg px-2 py-2 cursor-pointer transition-colors ${active ? 'bg-brand-50' : 'hover:bg-slate-50'}" onclick="switchToSession('${s.session_id}')" data-session-id="${s.session_id}">
        <div class="flex items-center gap-1">
          <p class="session-title flex-1 min-w-0 truncate text-[13px] ${active ? 'font-semibold text-brand-700' : 'text-slate-700'}">${escapeHtml(s.title)}</p>
          <button class="opacity-0 group-hover:opacity-100 w-6 h-6 flex-shrink-0 flex items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700 cursor-pointer" title="Renombrar" onclick="event.stopPropagation();_renameSessionStart('${s.session_id}')">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
          </button>
          <button class="opacity-0 group-hover:opacity-100 w-6 h-6 flex-shrink-0 flex items-center justify-center rounded text-slate-400 hover:bg-rose-100 hover:text-rose-600 cursor-pointer" title="Eliminar" onclick="event.stopPropagation();_deleteSessionStart('${s.session_id}')">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>
        <p class="text-[10.5px] text-slate-400 mt-0.5">${_relativeTime(s.updated_at)}</p>
      </div>`;
  }).join('');
}

async function switchToSession(id) {
  if (id === SESSION_ID) { closeSidebarMobile(); return; }
  _sidebarDeleteConfirmId = null;
  resetUI();
  _setSessionId(id);
  _renderSessionsList();
  closeSidebarMobile();
  _setSwitchOverlay(true);
  try {
    await loadActiveSession();
  } finally {
    _setSwitchOverlay(false);
  }
}

// GET /api/sessions/{id} puede tardar unos segundos (recalcula el precio
// en caliente) -- sin este overlay, el panel se queda en blanco mientras
// tanto y se ve como si no hubiera pasado nada al elegir una conversación
// (bug reportado). Cubre chat y ficha (los 2 paneles que rehidrata
// loadActiveSession()); try/finally asegura que se oculte también si la
// carga falla.
function _setSwitchOverlay(show) {
  ['chat-switch-overlay', 'ficha-switch-overlay'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('hidden', !show);
    el.classList.toggle('flex', show);
  });
}

// Renombrar: edición inline y optimista -- el texto cambia al instante en
// pantalla, la escritura real al backend va de fondo con debounce (mismo
// patrón que saveCompareSelection). Pedido explícito: que no se sienta con
// la latencia que tuvieron acciones parecidas antes en esta sesión.
let _renameTimer = null;
function _renameSessionStart(id) {
  const row = document.querySelector(`[data-session-id="${id}"]`);
  const titleEl = row?.querySelector('.session-title');
  if (!row || !titleEl) return;
  const current = titleEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'flex-1 min-w-0 text-[13px] px-1 py-0.5 rounded border border-brand-300 focus:outline-none focus:ring-1 focus:ring-brand-400';
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  };
  input.onblur = () => _renameSessionCommit(id, input.value);
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function _renameSessionCommit(id, newTitle) {
  newTitle = (newTitle || '').trim();
  if (!newTitle) { _renderSessionsList(); return; }
  const s = _sidebarSessions.find(x => x.session_id === id);
  if (s) s.title = newTitle;
  if (id === SESSION_ID) _setActiveSessionTitle(newTitle);
  _renderSessionsList();
  clearTimeout(_renameTimer);
  _renameTimer = setTimeout(() => {
    apiFetch(`/api/sessions/${id}/rename`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({ title: newTitle }),
    }).catch(() => {});
  }, 400);
}

// Eliminar: sin confirm() nativo (lento/brusco) -- el propio ítem se
// convierte en una fila "¿Eliminar? Sí/No" in-place. Al confirmar, sale de
// la lista al instante (optimista) y el borrado real va de fondo.
function _deleteSessionStart(id) {
  _sidebarDeleteConfirmId = id;
  _renderSessionsList();
}

function _deleteSessionCancel() {
  _sidebarDeleteConfirmId = null;
  _renderSessionsList();
}

function _deleteSessionConfirm(id) {
  _sidebarDeleteConfirmId = null;
  _sidebarSessions = _sidebarSessions.filter(s => s.session_id !== id);
  _renderSessionsList();
  apiFetch(`/api/sessions/${id}/delete`, { method: 'POST', headers: _headers() }).catch(() => {});
  if (id === SESSION_ID) startNewConversation();
}

// ── Sidebar: abrir/cerrar (mobile) y colapsar (desktop) ──────────────────
function openSidebarMobile() {
  document.getElementById('sessions-overlay')?.classList.remove('hidden');
}
function closeSidebarMobile() {
  document.getElementById('sessions-overlay')?.classList.add('hidden');
}
function toggleSidebarCollapse() {
  document.getElementById('sessions-sidebar')?.classList.toggle('sidebar-collapsed');
}

// ── Tutorial interactivo (product tour) ──────────────────────────────
// A pedido explícito: no alcanza con un modal que solo explica -- tiene que
// hacer escribir/presionar en la app real. Cada paso resalta (spotlight) el
// elemento real correspondiente y, cuando corresponde, ESPERA a que el
// usuario haga la acción real (escribir+enviar, tocar una fila, marcar
// comparar, descargar el PDF) antes de avanzar solo -- no es "Siguiente"
// en cada paso. _tourNotify() la llaman a mano los puntos reales del código
// donde ocurre cada acción (sendMessage, el evento 'assistant_done', el
// click-to-edit de una fila, toggleCompare, downloadFichaPDF).
const TOUR_SEEN_KEY = 'compra_agil_tutorial_seen';

const TOUR_STEPS = [
  {
    target: '#chat-input-field',
    tab: 'chat',
    title: 'Escribe tu necesidad',
    body: 'Describe qué equipo necesitas -- por ejemplo "laptop para trabajo de oficina" -- y presiona el botón de enviar (o Enter).',
    waitFor: 'send',
  },
  {
    target: '#chat-messages',
    tab: 'chat',
    title: 'El asistente responde',
    body: 'Espera la respuesta: va a completar la ficha técnica de la derecha automáticamente, sin que tengas que llenar nada a mano.',
    waitFor: 'assistant_done',
  },
  {
    target: '.attr-row[data-attr]:not([data-readonly])',
    tab: 'ficha',
    title: 'Revisa la ficha técnica',
    body: 'Aquí se completan los atributos solos. Haz clic en cualquier fila para editarla -- prueba con una ahora.',
    waitFor: 'attr-edit',
  },
  {
    target: '#price-container',
    tab: 'ficha',
    title: 'Precio de referencia',
    body: 'Cuando la ficha tenga suficientes datos, aquí aparece un precio estimado usando compras reales anteriores de Convenio Marco y Compra Ágil.',
    waitFor: null,
  },
  {
    target: '#compare-bar',
    tab: 'ficha',
    title: 'Comparar alternativas',
    body: 'Marca "Comparar" en las ofertas que veas para agregarlas, y luego haz clic aquí para verlas lado a lado.',
    missingBody: 'Este botón siempre está aquí abajo, aunque ahora esté vacío -- el botón "Comparar" aparece junto a cada equipo del historial o catálogo, una vez que hay precio de referencia. Márcalo ahí y esta barra se activa sola. Puedes continuar por ahora.',
    waitFor: 'compare-click',
    // El elemento #compare-bar SIEMPRE existe en el DOM (se dejó de ocultar
    // cuando está vacío -- ver fix del comentario), así que la
    // disponibilidad real del paso depende del ESTADO (¿ya hay algo
    // marcado?), no de si el elemento aparece o no.
    unavailable: () => state.compareItems.length === 0,
  },
  {
    target: '#btn-download-pdf',
    tab: 'ficha',
    title: 'Descarga la ficha',
    body: 'Cuando esté lista, descárgala en PDF con este botón para adjuntarla a tu proceso de compra.',
    waitFor: 'pdf-click',
  },
];

let _tourStep = 0;
let _tourActive = false;

function _tourClearSpotlight() {
  document.querySelectorAll('.tour-spotlight').forEach(el => {
    el.classList.remove('tour-spotlight');
    el.style.position = '';
    el.style.zIndex = '';
    el.style.boxShadow = '';
  });
}

function _tourPositionTooltip(target) {
  const tooltip = document.getElementById('tour-tooltip');
  if (!target) {
    tooltip.style.position = 'fixed';
    tooltip.style.top = '50%';
    tooltip.style.left = '50%';
    tooltip.style.transform = 'translate(-50%, -50%)';
    return;
  }
  tooltip.style.transform = '';
  const rect = target.getBoundingClientRect();
  const tw = tooltip.offsetWidth || 290;
  const th = tooltip.offsetHeight || 150;
  const margin = 14;
  let top = rect.bottom + margin;
  if (top + th > window.innerHeight - 10) top = Math.max(10, rect.top - th - margin);
  let left = rect.left;
  if (left + tw > window.innerWidth - 10) left = window.innerWidth - tw - 10;
  if (left < 10) left = 10;
  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function renderTourStep() {
  const step = TOUR_STEPS[_tourStep];
  _tourClearSpotlight();
  if (step.tab) switchTab(step.tab);

  // requestAnimationFrame: deja que switchTab reacomode el layout antes de
  // medir posiciones -- si se mide en el mismo tick, el panel recién
  // mostrado puede seguir midiendo 0 (todavía con la clase mobile-hidden).
  requestAnimationFrame(() => {
    const target = document.querySelector(step.target);
    const tooltip = document.getElementById('tour-tooltip');
    document.getElementById('tour-step-label').textContent = `Paso ${_tourStep + 1} de ${TOUR_STEPS.length}`;
    document.getElementById('tour-title').textContent = step.title;

    // Un paso puede quedar "no disponible" por dos razones distintas: el
    // elemento todavía no existe en el DOM (ej. ninguna fila renderizada
    // -- no debería pasar en la práctica, pero es el fallback genérico), o
    // el elemento SÍ existe pero el estado real de la app todavía no lo
    // hace útil (ej. #compare-bar siempre está en el DOM, pero marcar algo
    // recién tiene sentido si hay ofertas visibles -- ahí el paso define
    // su propio unavailable() en vez de depender de si el nodo existe).
    const isUnavailable = step.unavailable ? step.unavailable() : !target;
    const waitFor = isUnavailable ? null : step.waitFor;
    document.getElementById('tour-body').textContent = isUnavailable ? (step.missingBody || step.body) : step.body;

    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('tour-spotlight');
      target.style.position = 'relative';
      target.style.zIndex = '1000';
      target.style.boxShadow = '0 0 0 4px #fff, 0 0 0 6px #154f96, 0 0 0 9999px rgba(15,23,42,.6)';
      setTimeout(() => _tourPositionTooltip(target), 340);
    } else {
      _tourPositionTooltip(null);
    }

    const nextBtn = document.getElementById('tour-next');
    nextBtn.textContent = waitFor
      ? 'Saltar este paso →'
      : (_tourStep === TOUR_STEPS.length - 1 ? 'Listo' : 'Siguiente →');

    tooltip.classList.remove('hidden');
  });
}

function tourAdvance() {
  if (!_tourActive) return;
  if (_tourStep >= TOUR_STEPS.length - 1) { closeTutorial(); return; }
  _tourStep++;
  renderTourStep();
}

function tourManualAdvance() {
  tourAdvance();
}

// Los puntos reales del código (sendMessage, assistant_done, click-to-edit
// de fila, toggleCompare, downloadFichaPDF) llaman esto -- si el tour está
// activo y el paso actual está esperando justo ese evento, avanza solo.
function _tourNotify(eventName) {
  if (!_tourActive) return;
  const step = TOUR_STEPS[_tourStep];
  if (step && step.waitFor === eventName) {
    setTimeout(tourAdvance, 450); // deja que la acción se vea en pantalla antes de saltar
  }
}

function _tourReposition() {
  if (!_tourActive) return;
  const step = TOUR_STEPS[_tourStep];
  const target = step && step.target ? document.querySelector(step.target) : null;
  _tourPositionTooltip(target);
}
window.addEventListener('scroll', _tourReposition, true); // capture: reposiciona aunque el scroll sea dentro de un panel interno, no solo la ventana
window.addEventListener('resize', _tourReposition);

function openTutorial() {
  _tourStep = 0;
  _tourActive = true;
  renderTourStep();
  const badge = document.getElementById('tutorial-badge');
  if (badge) badge.classList.add('hidden');
  try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch (e) {}
}

function closeTutorial() {
  _tourActive = false;
  _tourClearSpotlight();
  document.getElementById('tour-tooltip')?.classList.add('hidden');
}

function skipTutorial() {
  closeTutorial();
  try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch (e) {}
}

function maybeAutoLaunchTutorial() {
  let seen = false;
  try { seen = !!localStorage.getItem(TOUR_SEEN_KEY); } catch (e) { return; }
  if (seen) {
    document.getElementById('tutorial-badge')?.classList.add('hidden');
    return;
  }
  setTimeout(openTutorial, 700);
}

// ── Tabs móvil ────────────────────────────────────────────────────
function switchTab(tab) {
  const chatPanel  = document.getElementById('panel-chat');
  const fichaPanel = document.getElementById('panel-ficha');
  const tabChat    = document.getElementById('tab-btn-chat');
  const tabFicha   = document.getElementById('tab-btn-ficha');
  const badge      = document.getElementById('ficha-tab-badge');
  if (!chatPanel || !fichaPanel) return;

  if (tab === 'chat') {
    chatPanel.classList.remove('mobile-hidden');
    fichaPanel.classList.add('mobile-hidden');
    if (tabChat)  { tabChat.classList.add('text-brand-700','font-semibold','border-brand-600','bg-brand-50'); tabChat.classList.remove('text-slate-500','font-medium','border-transparent','bg-white'); }
    if (tabFicha) { tabFicha.classList.remove('text-brand-700','font-semibold','border-brand-600','bg-brand-50'); tabFicha.classList.add('text-slate-500','font-medium','border-transparent','bg-white'); }
  } else {
    chatPanel.classList.add('mobile-hidden');
    fichaPanel.classList.remove('mobile-hidden');
    if (tabFicha) { tabFicha.classList.add('text-brand-700','font-semibold','border-brand-600','bg-brand-50'); tabFicha.classList.remove('text-slate-500','font-medium','border-transparent','bg-white'); }
    if (tabChat)  { tabChat.classList.remove('text-brand-700','font-semibold','border-brand-600','bg-brand-50'); tabChat.classList.add('text-slate-500','font-medium','border-transparent','bg-white'); }
    if (badge) badge.classList.add('hidden');
  }
}

// ── Secciones colapsables ─────────────────────────────────────────
function toggleSection(id) {
  const body = document.getElementById(`section-body-${id}`);
  const chevron = document.getElementById(`section-chevron-${id}`);
  if (!body) return;
  const isHidden = body.classList.contains('hidden');
  body.classList.toggle('hidden', !isHidden);
  if (chevron) chevron.classList.toggle('open', isHidden);
}

// ── Utils ─────────────────────────────────────────────────────────
// escapeHtml() y safeUrl() viven en shell.js (compartidas con medicamentos.js).

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function useSuggestion(text) {
  setInput(text);
  document.getElementById('chat-input-field').focus();
}

// toggleAccountPanel(), fetchUsage() y renderUsage() viven en shell.js.

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  const inputField = document.getElementById('chat-input-field');
  inputField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputField.addEventListener('input', () => autoResizeTextarea(inputField));

  updateProgress();

  // Fila completa clickeable para editar, no solo el ícono de lápiz (antes
  // pasaba desapercibido que se podía editar -- bug real reportado).
  document.querySelectorAll('.attr-row[data-attr]').forEach(row => {
    if (row.dataset.readonly) return;
    row.classList.add('cursor-pointer');
    row.addEventListener('click', (e) => {
      if (e.target.closest('.attr-edit-wrap') || e.target.closest('.attr-edit-btn')) return;
      startEdit(row.dataset.attr);
      _tourNotify('attr-edit');
    });
  });

  // Cargar valores de dropdowns para autocompletado
  apiFetch('/api/dropdowns')
    .then(r => r && r.ok ? r.json() : {})
    .then(data => { Object.assign(dropdowns, data); })
    .catch(() => {});

  // La conversación activa arranca siempre en blanco (ver SESSION_ID más
  // arriba) -- solo hay que traer la lista de conversaciones guardadas
  // para el sidebar, no restaurar ninguna en particular.
  loadSessionsList();

  // Tutorial automático (saltable) para quien abre esta pestaña por primera vez
  maybeAutoLaunchTutorial();
});
