/* ═══════════════════════════════════════════════════════════════
   Asistente Compra Ágil — app.js
   ═══════════════════════════════════════════════════════════════ */

const SESSION_ID = crypto.randomUUID();

// ── Atributos ────────────────────────────────────────────────────
const ATTRS = {
  tipo_equipo:                  { label: 'Tipo de equipo',       type: 'enum',    values: ['Laptop','AIO','Desktop','Otro'] },
  marca:                        { label: 'Marca',                type: 'dict' },
  linea_producto:               { label: 'Línea de producto',    type: 'dict' },
  nombre_modelo:                { label: 'Modelo',               type: 'free' },
  procesador_principal:         { label: 'Procesador',           type: 'dict' },
  nucleos_procesador:           { label: 'Núcleos',              type: 'numeric', readOnly: true },
  hilos_procesador:             { label: 'Hilos',                type: 'numeric', readOnly: true },
  frecuencia_turbo_procesador_mhz: { label: 'Frec. Turbo (MHz)', type: 'numeric', readOnly: true },
  total_ram_gb:                 { label: 'RAM (GB)',              type: 'numeric' },
  tecnologia_ram:               { label: 'Tecnología RAM',       type: 'enum',    values: ['DDR5','DDR4','LPDDR5X','LPDDR5','LPDDR4X','LPDDR4','DDR3'] },
  frecuencia_ram_mhz:           { label: 'Frec. RAM (MHz)',      type: 'numeric', readOnly: true },
  total_almacenamiento_gb:      { label: 'Almacenamiento (GB)',  type: 'numeric' },
  tecnologia_disco_principal:   { label: 'Tecnología disco',     type: 'enum',    values: ['NVMe SSD','SATA SSD','SSD','HDD','eMMC','mSATA'] },
  tipo_configuracion_discos:    { label: 'Config. discos',       type: 'enum',    values: ['solo SSD','SSD+HDD','solo HDD','otro'] },
  tiene_gpu_dedicada:           { label: 'GPU dedicada',         type: 'boolean' },
  gpu_dedicada_nombre:          { label: 'Nombre GPU',           type: 'dict' },
  total_vram_gpu_gb:            { label: 'VRAM (GB)',            type: 'numeric', readOnly: true },
  pantalla_pulgadas:            { label: 'Pantalla (pulgadas)',  type: 'numeric' },
  sistema_operativo:            { label: 'Sistema operativo',    type: 'dict' },
  wifi_generacion:              { label: 'Wi-Fi',               type: 'enum',    values: ['Wi-Fi 7','Wi-Fi 6E','Wi-Fi 6','Wi-Fi 5','Wi-Fi 4'] },
  part_number:                  { label: 'Part number',          type: 'free' },
};

const CORE_ATTRS = [
  'tipo_equipo', 'procesador_principal', 'total_ram_gb', 'tecnologia_ram',
  'total_almacenamiento_gb', 'tecnologia_disco_principal', 'tiene_gpu_dedicada', 'sistema_operativo',
];

// ── Estado ──────────────────────────────────────────────────────
const state = {
  ficha: {},
  priceData: null,
  priceLoading: false,
  sending: false,
  isTyping: false,
  streamingBubble: null,
};

// ── HTTP helpers ─────────────────────────────────────────────────
const _headers = () => ({ 'Content-Type': 'application/json', 'x-api-key': API_KEY });

// ── SSE helpers ──────────────────────────────────────────────────
async function readSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // guarda línea incompleta
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try { handleServerMessage(JSON.parse(raw)); } catch (e) {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Mensajes del servidor ────────────────────────────────────────
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
      break;

    case 'ficha_update':
      data.updates.forEach(applyFichaUpdate);
      updateProgress();
      break;

    case 'questions':
      showQuestions(data.questions);
      break;

    case 'price_update':
      state.priceData = data.data;
      hidePriceLoading();
      renderPriceEstimate(data.data);
      break;

    case 'price_not_found':
      hidePriceLoading();
      document.getElementById('price-container').innerHTML = priceNotFoundHtml();
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
    ? `<div class="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 mt-1">
         <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
           <path d="M12 2.5l1.8 5.6 5.7 1.4-5.7 1.4-1.8 5.6-1.8-5.6-5.7-1.4 5.7-1.4z"/>
         </svg>
       </div>`
    : `<div class="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0 mt-1 text-slate-500 text-xs font-semibold">Tú</div>`;

  const bubbleCls = isAi
    ? 'bg-white text-slate-800 rounded-2xl rounded-tl-sm shadow-sm border border-slate-100'
    : 'bg-brand-600 text-white rounded-2xl rounded-tr-sm';

  wrap.innerHTML = isAi
    ? `${avatarHtml}<div class="max-w-[82%] px-4 py-3 text-sm leading-relaxed chat-bubble ${bubbleCls}">${escapeHtml(content)}</div>`
    : `<div class="max-w-[82%] px-4 py-3 text-sm leading-relaxed chat-bubble ${bubbleCls}">${escapeHtml(content)}</div>${avatarHtml}`;

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
    wrap.innerHTML = `<div class="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center flex-shrink-0 mt-1">
      <svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2.5l1.8 5.6 5.7 1.4-5.7 1.4-1.8 5.6-1.8-5.6-5.7-1.4 5.7-1.4z"/>
      </svg>
    </div>`;

    const bubble = document.createElement('div');
    bubble.className = 'max-w-[82%] px-4 py-3 text-sm leading-relaxed chat-bubble bg-white text-slate-800 rounded-2xl rounded-tl-sm shadow-sm border border-slate-100';
    wrap.appendChild(bubble);
    container.appendChild(wrap);
    state.streamingBubble = bubble;
  }

  state.streamingBubble.appendChild(document.createTextNode(delta));
  container.scrollTop = container.scrollHeight;
}

function showQuestions(questions) {
  clearQuestions();
  if (!questions || !questions.length) return;
  const container = document.getElementById('chat-messages');
  const wrap = document.createElement('div');
  wrap.id = 'question-chips';
  wrap.className = 'flex flex-wrap gap-2 animate-in';
  questions.forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'px-3 py-1.5 text-xs bg-brand-50 border border-brand-200 text-brand-700 rounded-full hover:bg-brand-100 transition-colors';
    btn.textContent = q;
    btn.onclick = () => { setInput(q); document.getElementById('chat-input-field').focus(); };
    wrap.appendChild(btn);
  });
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
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

  state.sending = true;
  appendMessage('user', content);
  input.value = '';
  autoResizeTextarea(input);
  showTyping();

  if (state.ficha['tipo_equipo']?.value != null) showPriceLoading();

  try {
    const res = await fetch(`${API_URL}/api/chat/${SESSION_ID}`, {
      method: 'POST',
      headers: _headers(),
      body: JSON.stringify({ content }),
    });
    await readSSEStream(res);
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
    const displayVal = update.value === true ? 'Sí' : update.value === false ? 'No' : String(update.value);
    valueSpan.textContent = displayVal;
    valueSpan.className = 'attr-value text-xs font-semibold text-slate-800';
  }

  const badge = row.querySelector('.attr-badge');
  if (badge && update.source) {
    const configs = {
      ai:         { label: 'IA',   cls: 'bg-violet-50 text-violet-600 border-violet-200' },
      user:       { label: 'Tú',   cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
      complement: { label: 'Auto', cls: 'bg-amber-50 text-amber-600 border-amber-200' },
    };
    const cfg = configs[update.source];
    if (cfg) {
      badge.textContent = cfg.label;
      badge.className = `attr-badge text-[10px] font-medium px-1.5 py-0.5 rounded-md border ${cfg.cls}`;
      badge.classList.remove('hidden');
    }
  }

  const trigger = row.querySelector('.attr-trigger');
  if (trigger && update.source === 'complement' && update.triggered_by) {
    trigger.textContent = `← ${update.triggered_by}`;
    trigger.classList.remove('hidden');
  }

  row.classList.remove('field-flash');
  void row.offsetWidth;
  row.classList.add('field-flash');
}

function updateProgress() {
  const filledCore = CORE_ATTRS.filter(a => state.ficha[a]?.value != null).length;
  const pct = Math.round((filledCore / CORE_ATTRS.length) * 100);
  const bar = document.getElementById('progress-bar');
  const label = document.getElementById('progress-label');
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = `${filledCore}/${CORE_ATTRS.length} completados`;

  document.querySelectorAll('.ficha-section').forEach(sec => {
    const sId = sec.id.replace('section-', '');
    const rows = sec.querySelectorAll('.attr-row');
    const filledInSection = [...rows].filter(r => state.ficha[r.dataset.attr]?.value != null).length;
    const counter = document.getElementById(`section-count-${sId}`);
    if (counter) counter.textContent = `${filledInSection}/${rows.length}`;
  });
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

    values.forEach(v => {
      const btn = document.createElement('button');
      const isActive = String(currentVal) === String(v);
      btn.className = `px-2 py-1 text-xs rounded-lg border transition-colors ${
        isActive
          ? 'bg-brand-600 text-white border-brand-600'
          : 'bg-white text-slate-700 border-slate-200 hover:border-brand-400'
      }`;
      btn.textContent = v === 'true' ? 'Sí' : v === 'false' ? 'No' : v;
      btn.onclick = () => commitEdit(attr, v);
      btnWrap.appendChild(btn);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ml-1 px-2 py-1 text-xs text-slate-400 hover:text-slate-600';
    cancelBtn.textContent = '✕';
    cancelBtn.onclick = () => cancelEdit(attr);
    btnWrap.appendChild(cancelBtn);
    editWrap.appendChild(btnWrap);

  } else {
    const inputWrap = document.createElement('div');
    inputWrap.className = 'flex items-center gap-1 w-full';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = String(currentVal);
    input.className = 'flex-1 text-xs px-2 py-1 border border-brand-400 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-400';
    input.placeholder = `Ingresar ${meta.label.toLowerCase()}...`;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitEdit(attr, input.value.trim());
      if (e.key === 'Escape') cancelEdit(attr);
    });

    const okBtn = document.createElement('button');
    okBtn.className = 'p-1 text-emerald-600 hover:text-emerald-700';
    okBtn.innerHTML = '✓';
    okBtn.onclick = () => commitEdit(attr, input.value.trim());

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'p-1 text-slate-400 hover:text-slate-600';
    cancelBtn.innerHTML = '✕';
    cancelBtn.onclick = () => cancelEdit(attr);

    inputWrap.appendChild(input);
    inputWrap.appendChild(okBtn);
    inputWrap.appendChild(cancelBtn);
    editWrap.appendChild(inputWrap);
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
  if (value === '' || value === null || value === undefined) {
    cancelEdit(attr);
    return;
  }
  cancelEdit(attr);

  if (state.ficha['tipo_equipo']?.value != null || attr === 'tipo_equipo') {
    showPriceLoading();
  }

  fetch(`${API_URL}/api/manual_update/${SESSION_ID}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ attribute: attr, value }),
  })
    .then(res => readSSEStream(res))
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
  if (state.priceLoading) return;
  state.priceLoading = true;
  _priceLoadingMsgIdx = 0;

  const container = document.getElementById('price-container');
  container.innerHTML = `
    <div class="bg-white border border-slate-200 rounded-xl shadow-sm px-4 py-3 flex items-center gap-4 animate-in">
      <div class="price-spinner"></div>
      <div class="min-w-0">
        <p class="text-xs font-medium text-slate-700">Estimando precio de referencia</p>
        <p id="price-loading-msg" class="text-[11px] text-slate-400 mt-0.5 price-loading-text truncate">${PRICE_LOADING_MSGS[0]}</p>
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
    if (state.priceLoading) hidePriceLoading(true);
  }, 40000);
}

function hidePriceLoading(showEmpty = false) {
  state.priceLoading = false;
  clearInterval(_priceLoadingInterval);
  clearTimeout(_priceLoadingTimeout);
  if (showEmpty) {
    document.getElementById('price-container').innerHTML = priceEmptyHtml();
  }
}

// ── Precio: resultado ─────────────────────────────────────────────
function renderPriceEstimate(data) {
  const container = document.getElementById('price-container');
  if (!container) return;

  const fmt = (n) => n != null
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
    : '—';

  const range = (data.max - data.min) || 1;
  const leftPct  = ((data.p25  - data.min) / range) * 100;
  const widthPct = ((data.p75  - data.p25) / range) * 100;
  const medPct   = ((data.median - data.min) / range) * 100;

  container.innerHTML = `
    <div class="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden animate-in">
      <div class="flex items-center justify-between px-4 py-2 bg-gradient-to-r from-brand-700 to-brand-600">
        <div class="flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-white opacity-80" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>
          </svg>
          <span class="text-xs font-semibold text-white">Estimación de Precio de Referencia</span>
        </div>
        <span class="text-[11px] text-blue-200 opacity-80">${data.count.toLocaleString('es-CL')} ofertas similares</span>
      </div>
      <div class="px-4 py-3">
        <div class="flex items-end justify-between gap-4 mb-2.5">
          <div>
            <p class="text-2xl font-bold text-brand-700 leading-none">${fmt(data.median)}</p>
            <p class="text-[11px] text-slate-400 mt-0.5">mediana · precio neto (sin IVA)</p>
            <p class="text-xs font-semibold text-slate-600 mt-1">${fmt(data.median_iva)} <span class="font-normal text-slate-400">con IVA</span></p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[11px] text-slate-400 mb-0.5">Rango P25 – P75</p>
            <p class="text-xs font-medium text-slate-600">${fmt(data.p25)} – ${fmt(data.p75)}</p>
            <p class="text-[10px] text-slate-400">${fmt(data.p25_iva)} – ${fmt(data.p75_iva)} c/IVA</p>
          </div>
        </div>
        <div class="relative h-2 bg-slate-100 rounded-full mb-2">
          <div class="absolute top-0 h-full bg-brand-100 rounded-full"
               style="left:${leftPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></div>
          <div class="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-brand-600 rounded-full border-2 border-white shadow"
               style="left:calc(${medPct.toFixed(1)}% - 6px)"></div>
        </div>
        <div class="flex justify-between text-[10px] text-slate-400 border-t border-slate-100 pt-2">
          <span>Mín: ${fmt(data.min)}</span>
          <span class="text-slate-300">${data.match_description}</span>
          <span>Máx: ${fmt(data.max)}</span>
        </div>
      </div>
    </div>`;
}

// ── Sin precio encontrado ─────────────────────────────────────────
function priceNotFoundHtml() {
  return `
    <div class="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-3">
      <svg class="w-4 h-4 flex-shrink-0 text-amber-400 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <div>
        <p class="text-xs font-semibold text-amber-700">Sin precio de referencia disponible</p>
        <p class="text-[11px] text-amber-600 mt-0.5 leading-snug">No encontramos suficientes ofertas similares en Compra Ágil. Prueba ajustando el procesador, RAM o almacenamiento.</p>
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
      <p class="text-xs leading-snug">La estimación de precio aparecerá cuando la ficha tenga suficientes datos</p>
    </div>`;
}

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
  { label: 'General',           attrs: ['tipo_equipo','marca','linea_producto','nombre_modelo'] },
  { label: 'Procesador',        attrs: ['procesador_principal','nucleos_procesador','hilos_procesador','frecuencia_turbo_procesador_mhz'] },
  { label: 'Memoria RAM',       attrs: ['total_ram_gb','tecnologia_ram','frecuencia_ram_mhz'] },
  { label: 'Almacenamiento',    attrs: ['total_almacenamiento_gb','tecnologia_disco_principal','tipo_configuracion_discos'] },
  { label: 'Gráficos',          attrs: ['tiene_gpu_dedicada','gpu_dedicada_nombre','total_vram_gpu_gb'] },
  { label: 'Pantalla y Sistema',attrs: ['pantalla_pulgadas','sistema_operativo','wifi_generacion'] },
  { label: 'Identificación',    attrs: ['part_number'] },
];

function downloadFichaPDF() {
  const anyFilled = Object.values(state.ficha).some(f => f?.value != null);
  if (!anyFilled) {
    alert('La ficha aún no tiene datos. Completa al menos un atributo antes de descargar.');
    return;
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
        const display = v === true ? 'Sí' : v === false ? 'No' : String(v);
        return `<tr><td class="lbl">${ATTRS[a]?.label ?? a}</td><td class="val">${display}</td></tr>`;
      })
      .join('');
    if (!rows) continue;
    sectionsHtml += `
      <div class="sec">
        <div class="sec-title">${sec.label}</div>
        <table><tbody>${rows}</tbody></table>
      </div>`;
  }

  let priceHtml = '';
  if (state.priceData) {
    const d = state.priceData;
    priceHtml = `
      <div class="sec price-sec">
        <div class="sec-title price-title">Estimación de Precio de Referencia</div>
        <p class="price-note">Basado en ${d.count.toLocaleString('es-CL')} ofertas en Compra Ágil · ${d.match_description}</p>
        <table><tbody>
          <tr><td class="lbl">Mediana sin IVA</td><td class="val price-main">${fmt(d.median)}</td></tr>
          <tr><td class="lbl">Mediana con IVA</td><td class="val">${fmt(d.median_iva)}</td></tr>
          <tr><td class="lbl">Rango P25–P75 sin IVA</td><td class="val">${fmt(d.p25)} – ${fmt(d.p75)}</td></tr>
          <tr><td class="lbl">Rango P25–P75 con IVA</td><td class="val">${fmt(d.p25_iva)} – ${fmt(d.p75_iva)}</td></tr>
          <tr><td class="lbl">Rango completo sin IVA</td><td class="val">${fmt(d.min)} – ${fmt(d.max)}</td></tr>
        </tbody></table>
      </div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Ficha Técnica · Compra Ágil</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Helvetica Neue',Arial,sans-serif;color:#1e293b;background:#fff;padding:36px 44px;max-width:780px;margin:0 auto}
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
  .sec{margin-bottom:18px}
  .sec-title{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#0f3d78;background:#e8f0fb;padding:5px 11px;border-radius:5px;margin-bottom:7px}
  table{width:100%;border-collapse:collapse}
  tr{border-bottom:1px solid #f1f5f9}
  tr:last-child{border-bottom:none}
  .lbl{font-size:10.5px;color:#64748b;padding:5.5px 10px 5.5px 0;width:44%}
  .val{font-size:11px;font-weight:600;color:#1e293b;padding:5.5px 0}
  .price-sec{background:#f0f7ff;border:1px solid #c5d8f5;border-radius:8px;padding:14px}
  .price-title{background:#0f3d78;color:#fff;margin:-14px -14px 11px;border-radius:6px 6px 0 0;padding:7px 14px}
  .price-note{font-size:9.5px;color:#64748b;margin-bottom:9px;font-style:italic}
  .price-main{font-size:15px;color:#0f3d78;font-weight:700}
  .ftr{margin-top:28px;padding-top:14px;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center}
  .ftr p{font-size:9.5px;color:#94a3b8}
  .badge{background:#0f3d78;color:#fff;font-size:8.5px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:.03em}
  @media print{body{padding:16px}@page{margin:.8cm}}
</style>
</head>
<body>
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
      <img src="${origin}/imagenes/logo-uch.png" class="logo" alt="Universidad de Chile">
    </div>
  </div>
  <div class="meta">
    <p>Generado el <strong>${now}</strong></p>
    <p>Sesión <strong>${SESSION_ID.slice(0,8).toUpperCase()}</strong></p>
  </div>
  ${sectionsHtml}
  ${priceHtml}
  <div class="ftr">
    <p>Asistente IA · Compra Ágil · Universidad de Chile</p>
    <span class="badge">COMPRA ÁGIL</span>
  </div>
  <script>window.onload=()=>{window.print();}<\/script>
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) { alert('Permite ventanas emergentes para descargar el PDF.'); return; }
  win.document.write(html);
  win.document.close();
}

// ── Reset ─────────────────────────────────────────────────────────
function resetUI() {
  state.ficha = {};
  state.priceData = null;
  state.isTyping = false;
  state.streamingBubble = null;
  hidePriceLoading();
  hideFichaLoading();

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
    if (vs) { vs.textContent = 'sin valor'; vs.className = 'attr-value text-xs text-slate-300 italic'; }
    if (badge) { badge.className = 'attr-badge hidden'; badge.textContent = ''; }
    if (trigger) { trigger.classList.add('hidden'); trigger.textContent = ''; }
    cancelEdit(attr);
  });

  document.getElementById('price-container').innerHTML = priceEmptyHtml();
  updateProgress();
}

function resetSession() {
  resetUI();
  fetch(`${API_URL}/api/reset/${SESSION_ID}`, { method: 'POST', headers: _headers() }).catch(() => {});
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
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function useSuggestion(text) {
  setInput(text);
  document.getElementById('chat-input-field').focus();
}

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  const inputField = document.getElementById('chat-input-field');
  inputField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  inputField.addEventListener('input', () => autoResizeTextarea(inputField));

  updateProgress();
});
