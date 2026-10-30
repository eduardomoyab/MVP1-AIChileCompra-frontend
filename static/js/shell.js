/* ═══════════════════════════════════════════════════════════════
   shell.js — compartido entre todas las categorías (categorías,
   computadores, medicamentos, las que se agreguen después): header,
   panel de cuenta, uso diario, y el manejo de sesión vencida.
   ═══════════════════════════════════════════════════════════════ */

// ── Utils ─────────────────────────────────────────────────────────
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

