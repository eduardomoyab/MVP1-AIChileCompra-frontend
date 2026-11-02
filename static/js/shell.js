/* ═══════════════════════════════════════════════════════════════
   shell.js — compartido entre todas las categorías (categorías,
   computadores, medicamentos, las que se agreguen después): header,
   panel de cuenta, uso diario, y el manejo de sesión vencida.
   ═══════════════════════════════════════════════════════════════ */

// ── Utils ─────────────────────────────────────────────────────────
// Texto de un atributo no numérico tal como se muestra en toda la app y en el
// PDF: espacios limpios y en MAYÚSCULAS (los valores guardados no cambian).
function upperText(v) {
  return String(v).replace(/\s+/g, ' ').trim().toLocaleUpperCase('es');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Solo deja pasar URLs http/https -- evita que un valor "url" que venga de
// datos externos (catálogo Convenio Marco, etc.) sea un "javascript:" u
// otro esquema ejecutable al usarse en un href.
function safeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url), window.location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch {
    return '';
  }
}

// ── SSE helpers ───────────────────────────────────────────────────
// Lee un stream SSE genérico, invocando onEvent(data) por cada línea
// "data: {...}" -- se detiene en "data: [DONE]". Qué hacer con cada tipo
// de evento queda a cargo de quien llama (distinto por página: app.js
// para Computadores, medicamentos.js para el selector guiado).
async function readSSEStream(response, onEvent) {
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
        try { onEvent(JSON.parse(raw)); } catch (e) {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────
const _headers = () => ({ 'Content-Type': 'application/json' });

// Envoltorio de fetch para todas las llamadas a /api/* -- si la sesión ya
// venció (el usuario se quedó AFK, el token expiró, etc.), el backend del
// frontend devuelve 401 en vez de un redirect (ver app.py) para que esto
// se pueda detectar acá y mostrar el aviso, en vez de que el fetch siga el
// redirect solo y termine leyendo el HTML de /login como si fuera la
// respuesta esperada. Devuelve null si la sesión expiró -- cada llamador
// debe cortar su flujo normal cuando eso pasa.
function showSessionExpiredModal() {
  const modal = document.getElementById('session-expired-modal');
  if (modal) modal.classList.remove('hidden');
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    showSessionExpiredModal();
    return null;
  }
  return res;
}

// ── Cuenta: panel + uso diario ──────────────────────────────────────
function toggleAccountPanel() {
  const panel = document.getElementById('account-panel');
  if (!panel) return;
  panel.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('account-panel');
  const btn = document.getElementById('account-btn');
  if (!panel || panel.classList.contains('hidden')) return;
  if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
  panel.classList.add('hidden');
});

function formatResetTime(resetsAtIso) {
  if (!resetsAtIso) return 'a medianoche (hora Chile)';
  const resetsAt = new Date(resetsAtIso);
  const diffMs = resetsAt - new Date();
  if (diffMs <= 0) return 'en cualquier momento';
  const h = Math.floor(diffMs / 3600000);
  const m = Math.round((diffMs % 3600000) / 60000);
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}min`);
  return `en ${parts.join(' ')}`;
}

function renderUsage(usage) {
  if (!usage) return;
  const bar = document.getElementById('usage-bar');
  const text = document.getElementById('usage-text');
  const reset = document.getElementById('usage-reset');
  if (!bar || !text || !reset) return;

  // unlimited = esta persona tiene acceso ilimitado (configurado en
  // "Aplicaciones" en db-admin-panel) — no hay porcentaje que mostrar. El
  // backend ya no manda números de tokens crudos en absoluto (ver
  // usage_service.to_public en el backend) — solo % / bloqueado / reset.
  if (usage.unlimited) {
    bar.style.width = '100%';
    bar.className = 'h-full transition-all duration-300 bg-brand-400';
    text.textContent = 'Sin límite';
    reset.textContent = 'Acceso ilimitado';
    return;
  }

  const pct = Math.min(usage.percent_used ?? 0, 100);
  bar.style.width = `${pct}%`;
  bar.className = 'h-full transition-all duration-300 ' + (
    pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'
  );
  text.textContent = `${Math.round(pct)}% usado`;
  reset.textContent = usage.blocked
    ? `Se reinicia ${formatResetTime(usage.resets_at)}`
    : `Se reinicia a las 00:00 (hora Chile)`;
}

function fetchUsage() {
  apiFetch(`/api/usage`, { headers: _headers() })
    .then(r => r && r.ok ? r.json() : null)
    .then(data => { if (data) renderUsage(data); })
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  fetchUsage();
  // Heartbeat liviano -- detecta una sesión vencida por inactividad (AFK)
  // aunque el usuario no haya vuelto a interactuar todavía, no solo cuando
  // reintenta una acción.
  setInterval(fetchUsage, 5 * 60 * 1000);
});

// ── Estados de carga (compartidos por todas las categorías) ───────
// Bloque "cargando sugerencias": mensaje + pastillas esqueleto con shimmer.
// Reemplaza al spinner suelto -- se ve como lo que va a aparecer, no como
// un círculo girando sobre un hueco.
function loadingBlockHtml(message, { pills = [92, 120, 78, 104, 86] } = {}) {
  return `
    <div class="w-full load-block" role="status" aria-live="polite">
      <div class="load-label"><span class="load-dot"></span><span>${escapeHtml(message)}</span></div>
      <div class="load-skel">${pills.map(w => `<i style="width:${w}px"></i>`).join('')}</div>
    </div>`;
}

// Esqueleto del bloque de precio (número grande + barra de rango).
function priceSkeletonHtml(message) {
  return `
    <div class="load-price" role="status" aria-live="polite">
      <div class="load-label"><span class="load-dot"></span><span>${escapeHtml(message)}</span></div>
      <div class="load-skel-block">
        <i class="sk-num"></i>
        <i class="sk-line" style="width:62%"></i>
        <i class="sk-bar"></i>
        <div class="sk-ends"><i></i><i></i></div>
      </div>
    </div>`;
}

// Capa sobre la tarjeta mientras la IA analiza el texto. Rota los mensajes
// con fade para dar sensación de avance sin prometer pasos que no existen.
let _analyzingTimer = null;
function showAnalyzing(anchorEl, messages) {
  const card = anchorEl && anchorEl.closest('.rounded-2xl');
  if (!card || card.querySelector('.analyzing-overlay')) return;
  const ov = document.createElement('div');
  ov.className = 'analyzing-overlay';
  ov.setAttribute('role', 'status');
  ov.setAttribute('aria-live', 'polite');
  ov.innerHTML = `
    <div class="analyzing-orb"><span></span><span></span><span></span></div>
    <p class="analyzing-title">Analizando tu requerimiento</p>
    <p class="analyzing-msg"></p>
    <div class="analyzing-bar"><i></i></div>`;
  card.appendChild(ov);
  const msgEl = ov.querySelector('.analyzing-msg');
  let i = 0;
  const tick = () => {
    msgEl.classList.remove('in'); void msgEl.offsetWidth;
    msgEl.textContent = messages[i % messages.length];
    msgEl.classList.add('in');
    i++;
  };
  tick();
  clearInterval(_analyzingTimer);
  _analyzingTimer = setInterval(tick, 2200);
}

function hideAnalyzing(anchorEl) {
  clearInterval(_analyzingTimer);
  const card = anchorEl && anchorEl.closest && anchorEl.closest('.rounded-2xl');
  const ov = card && card.querySelector('.analyzing-overlay');
  if (ov) ov.remove();
}

// ── Texto libre del requerimiento ─────────────────────────────────
// El campo crece con lo que se escribe (sin scroll interno, hasta un tope de
// alto), limita el largo y muestra cuántos caracteres lleva. El mismo tope lo
// exige el backend (MAX_TEXTO en main.py).
const TEXTO_MAX = 1000;
const TEXTO_ALTO_MAX = 420;

function bindTextoLibre(textarea, counterEl, max = TEXTO_MAX) {
  if (!textarea || textarea.dataset.textoLibre) return;
  textarea.dataset.textoLibre = '1';
  textarea.setAttribute('maxlength', String(max));
  textarea.style.overflowY = 'hidden';
  let noteTimer = null;

  const fit = () => {
    textarea.style.height = 'auto';
    const h = Math.min(textarea.scrollHeight + 2, TEXTO_ALTO_MAX);
    textarea.style.height = h + 'px';
    textarea.style.overflowY = textarea.scrollHeight + 2 > TEXTO_ALTO_MAX ? 'auto' : 'hidden';
  };
  const count = () => {
    if (!counterEl) return;
    const n = textarea.value.length;
    counterEl.textContent = `${n.toLocaleString('es-CL')} / ${max.toLocaleString('es-CL')}`;
    counterEl.classList.toggle('text-amber-600', n >= max * 0.9);
    counterEl.classList.toggle('font-semibold', n >= max * 0.9);
    counterEl.classList.toggle('text-slate-400', n < max * 0.9);
  };
  textarea.addEventListener('input', () => { fit(); count(); });
  // Un texto pegado más largo que lo que cabe se recorta solo (maxlength): se avisa.
  textarea.addEventListener('paste', (e) => {
    const pasted = ((e.clipboardData || window.clipboardData)?.getData('text')) || '';
    const room = max - (textarea.value.length - (textarea.selectionEnd - textarea.selectionStart));
    if (pasted.length <= room || !counterEl) return;
    counterEl.textContent = `Se recortó a ${max.toLocaleString('es-CL')} caracteres`;
    counterEl.classList.add('text-amber-600', 'font-semibold');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(count, 3500);
  });
  fit();
  count();
}

// ── Precios: base común (IVA) y descarga de archivos ───────────────────
// El catálogo de Convenio Marco se publica NETO ("Precio Neto no incluye IVA",
// verificado en la ficha del producto). Para mostrarlo sobre la misma base
// que Compra Ágil se le suma el IVA; el dato guardado sigue siendo el neto.
const IVA_RATE = 1.19;
function conIva(n) { return Number.isFinite(n) ? Math.round(n * IVA_RATE) : n; }
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}



// ── Pantalla de ingreso del requerimiento (Computadores y Medicamentos) ──
// Pasos del proceso arriba, tarjeta con dos caminos (describir con palabras /
// elegir paso a paso), guía de qué incluir al costado y acciones abajo.
// `o`: prefix ('wiz'|'med': prefijo de los ids que usa analizar()), title,
// mode ('texto'|'manual'), bannersHtml, helper, placeholder, guide [{title,
// text}] y manual { title, hint, options:[{value, desc}] | null, buttonLabel }.
function inputScreenHtml(o) {
  const p = o.prefix;
  const manual = o.mode === 'manual' && o.manual;
  const steps = ['Describir', 'Revisar la ficha', 'Agregar a la cotización'];
  const stepper = steps.map((t, i) => `
    <div class="flex items-center gap-2.5">
      <span class="w-6 h-6 rounded-full text-[12px] font-semibold flex items-center justify-center ${i === 0 ? 'bg-brand-700 text-white' : 'border border-slate-300 text-slate-500'}">${i + 1}</span>
      <span class="text-[13px] ${i === 0 ? 'font-semibold text-brand-800' : 'text-slate-500'}">${t}</span>
    </div>`).join('<span class="hidden sm:block w-8 h-px bg-slate-300"></span>');

  const tab = (key, label, first) => {
    const active = (key === 'manual') === !!manual;
    return `<button type="button" role="tab" aria-selected="${active}" data-input-tab="${key}"
      class="px-6 py-3.5 text-left text-[14px] border-b-2 transition-colors ${first ? '' : 'border-l border-l-slate-200 '}${active ? 'font-semibold text-brand-800 border-b-brand-700 bg-white' : 'font-medium text-slate-600 border-b-transparent bg-slate-50/60 hover:bg-slate-50'}">${label}</button>`;
  };

  let body;
  if (manual) {
    const m = o.manual;
    body = `
      <div class="p-6 pt-5">
        <p class="text-[13.5px] font-semibold text-slate-700">${escapeHtml(m.title)}</p>
        <p class="text-[13px] text-slate-500 mt-0.5">${escapeHtml(m.hint)}</p>
        ${m.options ? `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
          ${m.options.map(op => `
            <button type="button" data-manual-pick="${escapeHtml(op.value)}"
                    class="flex flex-col items-start justify-start text-left border border-slate-200 rounded-xl px-4 py-4 bg-white hover:border-brand-400 hover:bg-brand-50/40 hover:shadow-sm transition-all">
              <span class="block text-[15px] font-semibold text-slate-900">${escapeHtml(op.value)}</span>
              <span class="block text-[12.5px] text-slate-500 leading-snug mt-1.5">${escapeHtml(op.desc)}</span>
            </button>`).join('')}
        </div>` : `
        <button type="button" data-skip-to-manual class="mt-4 px-6 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[14px] font-semibold rounded-lg transition-colors">${escapeHtml(m.buttonLabel)}</button>`}
      </div>`;
  } else {
    body = `
      <div>
        <div class="p-6 pt-5 min-w-0">
          ${o.bannersHtml || ''}
          <p class="text-[13.5px] font-semibold text-slate-700">Tu requerimiento</p>
          <p class="text-[13px] text-slate-500 mt-0.5 mb-3">${escapeHtml(o.helper)}</p>
          <textarea id="${p}-texto-input" rows="4" placeholder="${escapeHtml(o.placeholder)}"
                    class="w-full resize-none bg-white border border-slate-300 rounded-lg px-3.5 py-2.5 text-[14.5px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 transition-all text-left"></textarea>
          <div class="flex items-start justify-between gap-3 mt-2">
            <p id="${p}-analizar-hint" class="flex-1 min-w-0 text-[12px] text-slate-400 text-left min-h-[16px]">Ctrl + Enter para analizar</p>
            <span id="${p}-texto-count" class="flex-shrink-0 text-[12px] text-slate-400 tabular-nums" aria-live="polite">0 / 1.000</span>
          </div>
          <div class="flex items-center justify-between gap-3 mt-4">
            <button type="button" data-fill-example class="text-[13px] font-medium text-brand-600 hover:text-brand-800 hover:underline whitespace-nowrap">Usar un ejemplo</button>
            <button id="${p}-analizar-btn" type="button"
                    class="flex items-center justify-center gap-1.5 px-7 py-2.5 bg-brand-600 hover:bg-brand-700 text-white text-[14px] font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              <span id="${p}-analizar-icon" class="hidden"></span>
              Analizar
            </button>
          </div>
        </div>
        <div class="bg-slate-50 border-t border-slate-100 px-6 py-4">
          <p class="text-[12.5px] font-semibold text-slate-700 mb-2.5">Qué conviene incluir <span class="font-normal text-slate-400">· lo que no indiques, te lo preguntamos</span></p>
          <div class="grid grid-cols-2 gap-x-6 gap-y-2.5">
            ${(o.guide || []).map(g => `
              <div>
                <p class="text-[13px] font-semibold text-brand-800">${escapeHtml(g.title)}</p>
                <p class="text-[12px] text-slate-500 leading-snug">${escapeHtml(g.text)}</p>
              </div>`).join('')}
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 mb-5">${stepper}</div>
    <div class="relative bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden" style="padding:0">
      <div class="px-6 pt-6 pb-4">
        <h1 class="text-[24px] font-semibold text-brand-800 tracking-tight">${o.title}</h1>
      </div>
      <div role="tablist" class="grid grid-cols-2 border-t border-b border-slate-200">
        ${tab('texto', 'Describir con mis palabras', true)}
        ${tab('manual', 'Elegir paso a paso', false)}
      </div>
      ${body}
    </div>`;
}
