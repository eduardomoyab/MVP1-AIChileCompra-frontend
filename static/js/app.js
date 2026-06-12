/* ═══════════════════════════════════════════════════════════════
   Asistente Compra Ágil — app.js
   ═══════════════════════════════════════════════════════════════ */

const SESSION_ID = crypto.randomUUID();

// ── Atributos ────────────────────────────────────────────────────
const ATTRS = {
  tipo_equipo:                  { label: 'Tipo de equipo',       type: 'enum',    values: ['Laptop','AIO','Desktop','Otro'] },
  marca:                        { label: 'Marca',                type: 'dict' },
  nombre_modelo:                { label: 'Modelo',               type: 'free' },
  procesador_principal:         { label: 'Procesador',           type: 'dict' },
  linea_procesador:             { label: 'Línea procesador',     type: 'free' },
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

// Valores de dropdowns cargados desde /api/dropdowns al iniciar
const dropdowns = {};

// ── HTTP helpers ─────────────────────────────────────────────────
const _headers = () => ({ 'Content-Type': 'application/json' });

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
      hidePriceLoading();
      _offersData = [];
      _offersFetched = false;
      _offersSort = 'fecha_desc';
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

function showQuestions(questions) {
  clearQuestions();
  if (!questions || !questions.length) return;
  const container = document.getElementById('chat-messages');
  const wrap = document.createElement('div');
  wrap.id = 'question-chips';
  wrap.className = 'flex flex-wrap gap-2 animate-in';
  questions.forEach(q => {
    const chip = document.createElement('span');
    chip.className = 'px-4 py-2 text-[13px] bg-brand-50 border border-brand-200 text-brand-700 rounded-full';
    chip.textContent = q;
    wrap.appendChild(chip);
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
    const res = await fetch(`/api/chat/${SESSION_ID}`, {
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
      if (selected.length === 0) { cancelEdit(attr); return; }
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
    input.placeholder = `Añadir ${meta.label.toLowerCase()}...`;

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
      const opts = dropdowns[attr] || [];
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
    okBtn.className = 'p-1 text-emerald-600 hover:text-emerald-700';
    okBtn.innerHTML = '✓';
    okBtn.onclick = () => {
      removeAc();
      let val;
      if (rangeMode && meta.type === 'numeric') {
        const mn = rangeMinInput?.value.trim() ?? '';
        const mx = rangeMaxInput?.value.trim() ?? '';
        if (!mn && !mx) { cancelEdit(attr); return; }
        val = { min: mn || null, max: mx || null };
      } else {
        if (input.value.trim()) addValue(input.value.trim());
        if (selectedValues.length === 0) { cancelEdit(attr); return; }
        val = selectedValues.length === 1 ? selectedValues[0] : [...selectedValues];
      }
      commitEdit(attr, val);
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'p-1 text-slate-400 hover:text-slate-600';
    cancelBtn.innerHTML = '✕';
    cancelBtn.onclick = () => { removeAc(); cancelEdit(attr); };

    if (currentVal !== '' && currentVal != null) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'mr-auto px-2 py-0.5 text-[11px] text-red-400 hover:text-red-600 border border-red-200 hover:border-red-400 rounded transition-colors';
      clearBtn.textContent = 'Borrar';
      clearBtn.onclick = () => { removeAc(); commitEdit(attr, null); };
      actionRow.appendChild(clearBtn);
    }

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

  fetch(`/api/manual_update/${SESSION_ID}`, {
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
  const meanPct  = ((data.mean - data.min) / range) * 100;

  const broadWarning = data.count > 800 ? `
    <div class="flex items-start gap-2.5 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2.5 mt-2">
      <svg class="w-4 h-4 flex-shrink-0 text-amber-500 mt-0.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
      <div>
        <p class="text-[12px] font-semibold text-amber-700 leading-tight">Búsqueda muy amplia (${data.count.toLocaleString('es-CL')} ofertas)</p>
        <p class="text-[11px] text-amber-600 mt-0.5 leading-snug">La estimación puede no ser precisa. Agrega más atributos (procesador, RAM, almacenamiento) para acotar los resultados.</p>
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
      <div class="px-3 py-2 lg:px-4 lg:py-3">
        <div class="flex items-center justify-between gap-2 mb-1.5 lg:mb-2.5">
          <div>
            <p class="text-lg lg:text-3xl font-bold text-brand-700 leading-none">${fmt(data.mean)}</p>
            <p class="text-[11px] lg:text-[13px] text-slate-400 mt-0.5">estimación sin IVA &nbsp;·&nbsp; <span class="font-semibold text-slate-600">${fmt(data.mean_iva)}</span> c/IVA</p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[10px] lg:text-[12px] text-slate-400 mb-0.5">Rango esperado</p>
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
        <div class="text-center text-[10px] text-slate-300 border-t border-slate-100 pt-1.5">
          ${data.match_description}
        </div>
        ${broadWarning}
      </div>
    </div>
    <div class="mt-2">
      <button onclick="toggleOffers()" class="w-full flex items-center justify-between px-3 py-2.5 bg-brand-50 border border-brand-200 rounded-xl text-[12px] font-semibold text-brand-700 hover:bg-brand-100 hover:border-brand-300 transition-colors group">
        <span class="flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-brand-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          Ver transacciones recientes
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

let _offersData = [];
let _offersSort = 'fecha_desc';
let _offersFetched = false;

function toggleOffers() {
  const list = document.getElementById('offers-list');
  const chevron = document.getElementById('offers-chevron');
  if (!list) return;
  const isHidden = list.classList.contains('hidden');
  list.classList.toggle('hidden');
  if (chevron) chevron.style.transform = isHidden ? 'rotate(180deg)' : '';
  if (isHidden && !_offersFetched) fetchOffers();
}

async function fetchOffers() {
  const list = document.getElementById('offers-list');
  if (!list) return;
  try {
    const resp = await fetch(`/api/offers/${SESSION_ID}`, { headers: _headers() });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const { offers } = await resp.json();
    _offersData = offers || [];
    _offersFetched = true;
    renderOffers();
  } catch (e) {
    if (list) list.innerHTML = `<div class="text-center py-3 text-[12px] text-red-400">Error al cargar transacciones</div>`;
  }
}

function setOffersSort(key) {
  // toggle asc/desc if same key
  if (_offersSort.startsWith(key)) {
    _offersSort = _offersSort.endsWith('_desc') ? key + '_asc' : key + '_desc';
  } else {
    _offersSort = key + '_desc';
  }
  _updateSortButtons();
  _renderOfferCards();
}

function _updateSortButtons() {
  ['fecha', 'precio'].forEach(key => {
    const btn = document.getElementById(`offers-sort-${key}`);
    if (!btn) return;
    const active = _offersSort.startsWith(key);
    const asc = _offersSort === key + '_asc';
    btn.className = `inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
      active ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
    }`;
    btn.innerHTML = (key === 'fecha' ? 'Fecha' : 'Precio') + ' ' + (active ? (asc ? '↑' : '↓') : '↓');
  });
}

function _renderOfferCards() {
  const cards = document.getElementById('offers-cards');
  if (!cards) return;

  const fmt = (n) => n != null
    ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n)
    : '—';

  const sorted = [..._offersData].sort((a, b) => {
    if (_offersSort === 'fecha_desc') return (b.fecha_modificacion || '').localeCompare(a.fecha_modificacion || '');
    if (_offersSort === 'fecha_asc')  return (a.fecha_modificacion || '').localeCompare(b.fecha_modificacion || '');
    if (_offersSort === 'precio_desc') return (b.precio_unitario || 0) - (a.precio_unitario || 0);
    if (_offersSort === 'precio_asc')  return (a.precio_unitario || 0) - (b.precio_unitario || 0);
    return 0;
  });

  cards.innerHTML = sorted.map(o => {
    const ocLinks = (o.oc_urls || []).map((url, i) =>
      `<a href="${url}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[10px] text-brand-600 hover:text-brand-800 hover:underline font-medium">
        <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
        ${o.oc_codes[i] || 'OC'}
      </a>`
    );
    const linksHtml = ocLinks.length
      ? ocLinks.join('')
      : `<span class="text-[10px] text-slate-400 italic">OC no disponible, ver en portal Mercado Público</span>`;
    return `
      <div class="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
        <div class="flex items-start justify-between gap-2">
          <div class="flex-1 min-w-0">
            ${o.descripcion ? `<p class="text-[11px] text-slate-600 leading-snug mb-1">${o.descripcion}</p>` : ''}
            <p class="text-[10px] text-slate-400">${o.codigo_requerimiento || ''} ${o.fecha_modificacion ? '· ' + o.fecha_modificacion : ''}</p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[12px] font-semibold text-slate-700">${fmt(o.precio_unitario)}</p>
            <p class="text-[10px] text-slate-400">${fmt(o.precio_unitario_iva)} c/IVA</p>
          </div>
        </div>
        ${linksHtml ? `<div class="flex flex-wrap gap-2 mt-1.5">${linksHtml}</div>` : ''}
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
    <div class="flex items-center gap-1.5 mb-1.5 px-0.5">
      <span class="text-[10px] text-slate-400">Ordenar:</span>
      <button id="offers-sort-fecha"  onclick="setOffersSort('fecha')"  class=""></button>
      <button id="offers-sort-precio" onclick="setOffersSort('precio')" class=""></button>
    </div>
    <div id="offers-cards" class="max-h-80 overflow-y-auto space-y-1.5 pr-0.5"></div>`;
  _updateSortButtons();
  _renderOfferCards();
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
        <p class="text-[12px] text-amber-600 mt-0.5 leading-snug">No encontramos suficientes ofertas similares en Compra Ágil. Prueba ajustando el procesador, RAM o almacenamiento.</p>
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
  { label: 'General',           attrs: ['tipo_equipo','marca','nombre_modelo'] },
  { label: 'Procesador',        attrs: ['procesador_principal','linea_procesador','nucleos_procesador','hilos_procesador','frecuencia_turbo_procesador_mhz'] },
  { label: 'Memoria RAM',       attrs: ['total_ram_gb','tecnologia_ram','frecuencia_ram_mhz'] },
  { label: 'Almacenamiento',    attrs: ['total_almacenamiento_gb','tecnologia_disco_principal','tipo_configuracion_discos'] },
  { label: 'Gráficos',          attrs: ['tiene_gpu_dedicada','gpu_dedicada_nombre','total_vram_gpu_gb'] },
  { label: 'Pantalla y Sistema',attrs: ['pantalla_pulgadas','sistema_operativo','wifi_generacion'] },
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
    sectionsHtml += `<div class="sec"><div class="sec-title">${sec.label}</div><table><tbody>${rows}</tbody></table></div>`;
  }

  // Página de precios: page break + diseño en dos columnas
  const ca = state.priceData;
  const _stat = (lbl, val, border = '#dbeafe') =>
    `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid ${border};">
       <span style="font-size:10px;color:#64748b;">${lbl}</span>
       <span style="font-size:10.5px;font-weight:700;color:#1e293b;">${val}</span>
     </div>`;

  let caCard = '';
  if (ca) {
    caCard = `
      <div style="flex:1;border:1.5px solid #c5d8f5;border-radius:10px;overflow:hidden;">
        <div style="background:#154f96;padding:20px 22px;">
          <div style="font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:rgba(255,255,255,.6);margin-bottom:8px;">Estimación · Compra Ágil</div>
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

  const pricePageHtml = ca ? `
    <div style="page-break-before:always;padding-top:32px;">
      <div style="background:#0f3d78;color:white;padding:22px 28px;border-radius:10px;margin-bottom:22px;">
        <div style="font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.55);margin-bottom:6px;">Compra Ágil · Asistente IA</div>
        <div style="font-size:22px;font-weight:800;">Estimación de Precios</div>
        <div style="font-size:10.5px;color:rgba(255,255,255,.65);margin-top:4px;">Generado el ${now}</div>
      </div>
      <div style="display:flex;gap:18px;">
        ${caCard}
      </div>
    </div>` : '';

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
    .sec{margin-bottom:18px}
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

  html2pdf().set({
    margin: [8, 8, 8, 8],
    filename,
    image:      { type: 'jpeg', quality: 0.97 },
    html2canvas: { scale: 2, useCORS: true, logging: false },
    jsPDF:      { unit: 'mm', format: 'a4', orientation: 'portrait' },
  }).from(wrapEl).save().finally(() => {
    document.body.removeChild(tmpEl);
  });
}

// ── Reset ─────────────────────────────────────────────────────────
function resetUI() {
  state.ficha = {};
  state.priceData = null;
  state.isTyping = false;
  state.streamingBubble = null;
  switchTab('chat');
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
    if (vs) { vs.textContent = 'sin valor'; vs.className = 'attr-value text-[13px] text-slate-300 italic'; }
    if (badge) { badge.className = 'attr-badge hidden'; badge.textContent = ''; }
    if (trigger) { trigger.classList.add('hidden'); trigger.textContent = ''; }
    cancelEdit(attr);
  });

  document.getElementById('price-container').innerHTML = priceEmptyHtml();
  updateProgress();
}

function resetSession() {
  resetUI();
  fetch(`/api/reset/${SESSION_ID}`, { method: 'POST', headers: _headers() }).catch(() => {});
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

  // Cargar valores de dropdowns para autocompletado
  fetch('/api/dropdowns')
    .then(r => r.ok ? r.json() : {})
    .then(data => { Object.assign(dropdowns, data); })
    .catch(() => {});
});
