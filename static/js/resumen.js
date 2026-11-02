/* ═══════════════════════════════════════════════════════════════
   resumen.js — Resumen ejecutivo del requerimiento

   Vista dentro de la plataforma (no es un PDF): el requerimiento completo
   (varios productos, cada uno con su cantidad, total estimado y peso en el
   gasto) y, por cada ítem, su comparación con el mercado histórico y
   actual (precios, evolución, proveedores, distribución y productos
   revisados). Los precios y comparaciones viven acá y NO en el PDF técnico.

   Se carga DESPUÉS de category_wizard.js (usa sus globales: cart,
   revisados, CONFIG, SESSION_ID, formatCLP, itemTitle...). Todo texto que
   viene de datos (nombres de proveedores, descripciones, textos del
   comprador) pasa por escapeHtml antes de entrar al DOM.
   ═══════════════════════════════════════════════════════════════ */

const rsPanel = document.getElementById('resumen-panel');
const rs = {
  tab: 'g',          // 'g' = General; si no, el id del ítem
  market: {},        // id de ítem -> datos de mercado del backend
  state: {},         // id de ítem -> 'loading' | 'ok' | 'error'
  ui: {},            // id de ítem -> filtro, página, orden y fila abierta de la tabla de compras
  opener: null,      // elemento que abrió el panel (para devolver el foco)
};

/* Qué cambia entre categorías. Computadores usa los globales del asistente
   genérico (CONFIG, SCHEMA, revisados); Medicamentos define
   window.SUMMARY_CFG antes de cargar este archivo (sin Convenio Marco ni
   productos revisados; su "proveedor" es el laboratorio). */
const RSC = window.SUMMARY_CFG || {
  label: () => (typeof SCHEMA !== 'undefined' && SCHEMA && SCHEMA.label) || '',
  logoHtml: () => CONFIG.docLogoHtml,
  marketPath: `/api/categories/${CONFIG.slug}/market`,
  hasCm: !!CONFIG.supportsConvenioMarco,
  hasRevisados: true,
  prov: ['proveedor', 'proveedores'],
  sessionId: () => SESSION_ID,
  qty: (it) => it.cantidad,
  itemTitle: (it) => itemTitle(it),
  price: (it) => {
    const p = it.price;
    return p ? { median: priceStat(p, 'median'), p25: priceStat(p, 'p25'), p75: priceStat(p, 'p75'), count: p.count } : null;
  },
  relaxed: (it) => (it.price && it.price.relaxed_attrs) || [],
  revisados: () => revisados,
  closeCart: () => closeCartPanel(),
  downloadPdf: () => downloadRequerimientosPDF(),
};
const rsCap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// Los precios del catálogo de Convenio Marco se publican NETOS ("Precio Neto no
// incluye IVA", en USD; verificado en la ficha del producto y en la base de
// datos), y los de Compra Ágil se muestran CON IVA. Para compararlos sobre la
// misma base, el catálogo se lleva a IVA incluido sumándole el 19 %.
const RS_IVA = IVA_RATE;
const rsGross = conIva;
const rsRevPrice = (r) => (r.source === 'cm' ? rsGross(r.price) : r.price);

const rsE = escapeHtml;
const rsPad = (n) => String(n).padStart(2, '0');
const rsClp = (n) => (Number.isFinite(n) ? formatCLP(Math.round(n)) : '—');
const rsDelta = (d) => (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1).replace('.', ',') + ' %';
const rsSum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const rsShortDate = (t) => new Date(t).toLocaleDateString('es-CL', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ── Datos derivados del carrito ─────────────────────────────────── */

function rsItems() {
  return cart.map((it, i) => {
    const qty = Number(RSC.qty(it)) > 0 ? Number(RSC.qty(it)) : 1;
    const p = RSC.price(it);
    const c = RSC.hasCm ? (it.cmPrice || null) : null;
    const ca = p && Number.isFinite(p.median) ? p.median : null;
    return {
      it, id: it.id, i, num: rsPad(i + 1), qty,
      name: (it.texto_original || '').trim() || RSC.itemTitle(it),   // el texto tal cual lo escribió el comprador
      spec: RSC.itemTitle(it),
      ca, p25: p ? (p.p25 ?? null) : null, p75: p ? (p.p75 ?? null) : null, n: p ? (p.count ?? null) : null,
      cm: c && Number.isFinite(c.median) ? rsGross(c.median) : null,
      cmMin: Number.isFinite(c?.min) ? rsGross(c.min) : null, cmMax: Number.isFinite(c?.max) ? rsGross(c.max) : null, cmN: c?.count ?? null,
      sub: ca != null ? ca * qty : null,
    };
  });
}

function rsRevisadosOf(id) {
  return RSC.revisados().filter(r => r.itemId === id);
}

/* ── Apertura / cierre ───────────────────────────────────────────── */

function openResumen() {
  if (!cart.length) return;
  rs.opener = document.activeElement;
  if (rs.tab !== 'g' && !cart.some(i => i.id === rs.tab)) rs.tab = 'g';
  RSC.closeCart();
  rsPanel.classList.remove('hidden');
  rsRenderAll();
  rsPrefetch();
  rsPanel.scrollTop = 0;
  const closeBtn = rsPanel.querySelector('[data-rs-close]');
  if (closeBtn) closeBtn.focus();
}

function closeResumen() {
  rsPanel.classList.add('hidden');
  if (rs.opener && document.contains(rs.opener)) rs.opener.focus();
  rs.opener = null;
}

/* ── Render ──────────────────────────────────────────────────────── */

function rsRenderAll() {
  const items = rsItems();
  const many = items.length > 4;
  const fecha = new Date().toLocaleDateString('es-CL', { year: 'numeric', month: 'long', day: 'numeric' });
  const referencia = 'REQ-' + (String(RSC.sessionId()).replace(/-/g, '').slice(0, 6).toUpperCase() || '000000');

  const tabs = [{ id: 'g', num: '', label: 'General' }]
    .concat(items.map(x => ({ id: x.id, num: x.num, label: x.name })))
    .map(t => `
      <button type="button" role="tab" class="rs-tab" aria-selected="${t.id === rs.tab}" data-rs-tab="${rsE(t.id)}" title="${rsE(t.label)}">
        ${t.num ? `<span class="n">${t.num}</span>` : ''}<span class="t">${rsE(t.label)}</span>
      </button>`).join('');

  rsPanel.innerHTML = `
    <div class="rs-top">
      <div class="rs-wrap">
        ${RSC.logoHtml()}
        <div class="rs-actions">
          <button type="button" class="rs-btn" data-rs-close>Volver al asistente</button>
          <button type="button" class="rs-btn rs-btn-primary" data-rs-pdf>Descargar PDF técnico</button>
        </div>
      </div>
    </div>
    <div class="rs-main ${many ? 'rs-many' : ''}">
      <div>
        <div class="rs-eyebrow">${rsE(RSC.label())}</div>
        <h1 class="rs-h1">Resumen ejecutivo del requerimiento</h1>
      </div>
      <div class="rs-meta">
        <div><span>Fecha de emisión</span><b>${rsE(fecha)}</b></div>
        <div><span>Referencia</span><b>${rsE(referencia)}</b></div>
        <div><span>Categoría</span><b>${rsE(RSC.label())}</b></div>
        <div><span>Compras</span><b>${items.length}</b></div>
      </div>
      <div class="rs-tabs"><div class="rs-tabs-row" role="tablist" aria-label="Secciones del resumen">${tabs}</div></div>
      <div id="rs-body"></div>
    </div>`;
  rsRenderBody();
}

function rsRenderBody() {
  const body = document.getElementById('rs-body');
  if (!body) return;
  const items = rsItems();
  rsPanel.querySelectorAll('[data-rs-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.rsTab === rs.tab)));
  if (rs.tab === 'g') {
    body.innerHTML = rsGeneralHtml(items);
    return;
  }
  const x = items.find(i => i.id === rs.tab);
  if (!x) { rs.tab = 'g'; body.innerHTML = rsGeneralHtml(items); return; }
  body.innerHTML = rsItemHtml(x, items);
  rsEnsureMarket(x);
}

/* ── Gráficos de diferencia frente a la mediana (barras a izquierda/derecha del cero) ──
   La escala se ajusta a los datos: el menor tope "redondo" que contiene las
   diferencias (y el rango típico). Un valor extremo, muy por sobre el resto,
   no encoge a los demás: su barra se corta con una marca y su cifra real va
   escrita al lado. */
const RS_SPANS = [10, 20, 30, 40, 60, 80, 100, 150, 200, 300, 400, 600, 800, 1000];
function rsDivScale(deltas, extra = []) {
  const abs = deltas.filter(Number.isFinite).map(Math.abs).sort((a, b) => b - a);
  let ref = abs[0] || 0;
  if (abs.length >= 3 && abs[0] > abs[1] * 2.5) ref = abs[1] * 1.15;   // valor extremo
  ref = Math.max(ref, 5, ...extra.filter(Number.isFinite).map(Math.abs));
  return RS_SPANS.find(sp => sp >= ref * 1.05) || RS_SPANS[RS_SPANS.length - 1];
}
const rsPctTxt = (n) => (Math.round(n * 10) / 10).toString().replace('.', ',') + ' %';
const rsDivPos = (d, span) => 50 + Math.max(-span, Math.min(span, d)) / span * 50;
function rsDivBar(d, span, color) {
  const pos = rsDivPos(d, span);
  const cut = Math.abs(d) > span ? (d < 0 ? ' cut-l' : ' cut-r') : '';
  return `<div class="bar${cut}" style="left:${Math.min(50, pos).toFixed(1)}%;width:${Math.abs(pos - 50).toFixed(1)}%;background:${color}"></div>`;
}
const rsDivGrid = () => '<div class="gl" style="left:25%"></div><div class="gl" style="left:75%"></div>';
function rsDivAxis(span) {
  return `<div class="rs-axis5">
    <span class="l">${rsPctTxt(span)} más barato</span>
    <span style="left:25%">−${rsPctTxt(span / 2)}</span>
    <b style="left:50%">Mediana</b>
    <span style="left:75%">+${rsPctTxt(span / 2)}</span>
    <span class="r">${rsPctTxt(span)} más caro</span>
  </div>`;
}

/* ── General: el requerimiento completo ─────────────────────────── */

function rsGeneralHtml(items) {
  const priced = items.filter(x => x.sub != null);
  const total = rsSum(priced, x => x.sub);
  const lo = rsSum(priced, x => x.qty * (x.p25 ?? x.ca));
  const hi = rsSum(priced, x => x.qty * (x.p75 ?? x.ca));
  const qtyTotal = rsSum(items, x => x.qty);
  const missing = items.length - priced.length;
  const nCm = items.filter(x => x.cm != null).length;
  const totalCm = rsSum(priced, x => x.qty * (x.cm ?? x.ca));
  const ids = new Set(items.map(x => x.id));
  const nRev = RSC.revisados().filter(r => ids.has(r.itemId)).length;
  const nWithRev = items.filter(x => rsRevisadosOf(x.id).length).length;

  const kpis = [
    { v: rsClp(total), l: missing ? 'Total estimado (parcial)' : 'Total estimado del requerimiento',
      s: priced.length ? `Rango típico ${rsClp(lo)} a ${rsClp(hi)}${missing ? ` · faltan ${missing} ítem${missing === 1 ? '' : 's'} sin precio` : ''}` : 'Ningún ítem tiene precio estimado' },
    { v: qtyTotal.toLocaleString('es-CL'), u: qtyTotal === 1 ? ' unidad' : ' unidades', l: `En ${items.length} producto${items.length === 1 ? '' : 's'} distinto${items.length === 1 ? '' : 's'}`,
      s: RSC.hasCm ? `${nCm} de ${items.length} con Convenio Marco vigente` : `${priced.length} de ${items.length} con precio estimado` },
    RSC.hasCm ? { v: rsClp(totalCm), l: 'Total con Convenio Marco donde existe',
      s: priced.length && total ? `${rsDelta((totalCm / total - 1) * 100)} frente a Compra Ágil` : '' } : null,
    RSC.hasRevisados ? { v: String(nRev), l: 'Productos revisados para comparar', s: `En ${nWithRev} de ${items.length} ítems` } : null,
  ].filter(Boolean).map(k => `
    <div class="rs-kpi"><div class="v">${rsE(k.v)}${k.u ? `<small>${rsE(k.u)}</small>` : ''}</div><div class="l">${rsE(k.l)}</div><div class="s">${rsE(k.s)}</div></div>`).join('');

  // Dónde se concentra el gasto
  const ranked = [...priced].sort((a, b) => b.sub - a.sub);
  const maxSub = ranked.length ? ranked[0].sub : 1;
  const rank = ranked.map(x => `
    <div class="rs-row">
      <div class="name" title="${rsE(x.name)}"><b>${x.num}</b>${rsE(x.name)}</div>
      <div class="rs-track"><i style="width:${(x.sub / maxSub * 100).toFixed(1)}%"></i></div>
      <div class="val"><b>${rsClp(x.sub)}</b> <span class="rs-muted">· ${total ? (x.sub / total * 100).toFixed(1).replace('.', ',') : '0'} %</span></div>
    </div>`).join('');

  // Productos del requerimiento
  const gcls = RSC.hasCm ? 'rs-g-items' : 'rs-g-items rs-nocm';
  const rows = items.map(x => `
    <div class="tr ${gcls}">
      <div class="num">${x.num}</div>
      <div><div class="nm rs-clamp2" title="${rsE(x.name)}">${rsE(x.name)}</div><button type="button" class="rs-link" data-rs-tab="${rsE(x.id)}">Comparar con el mercado →</button></div>
      <div class="r nm">${x.qty.toLocaleString('es-CL')}</div>
      <div class="r nm" style="color:#047857">${rsClp(x.ca)}</div>
      <div class="r nm" style="font-weight:700">${rsClp(x.sub)}</div>
      ${RSC.hasCm ? `<div class="r nm" style="${x.cm == null ? 'color:#64748b' : ''}">${x.cm == null ? 'Sin datos' : rsClp(x.cm)}</div>` : ''}
    </div>`).join('');

  // Convenio Marco frente a Compra Ágil (la escala se ajusta a las diferencias reales)
  const SPG = rsDivScale(items.filter(x => x.cm != null && x.ca != null).map(x => (x.cm / x.ca - 1) * 100));
  const diff = items.map(x => {
    if (x.cm == null || x.ca == null) {
      return `
      <div class="rs-row">
        <div class="name" title="${rsE(x.name)}"><b>${x.num}</b>${rsE(x.name)}</div>
        <div class="rs-dplot"><div class="zero"></div><div class="none"><span>${x.ca == null ? 'Sin precio de Compra Ágil' : 'Sin Convenio Marco para este ítem'}</span></div></div>
        <div class="val"><b>${x.cm == null ? 'Sin datos' : rsClp(x.cm)}</b></div>
      </div>`;
    }
    const d = (x.cm / x.ca - 1) * 100;
    const color = d < 0 ? '#154f96' : '#c2410c';
    return `
      <div class="rs-row">
        <div class="name" title="${rsE(x.name)}"><b>${x.num}</b>${rsE(x.name)}</div>
        <div class="rs-dplot"${Math.abs(d) > SPG ? ` title="${rsE(rsDelta(d))} (fuera de escala)"` : ''}>${rsDivGrid()}<div class="zero"></div>${rsDivBar(d, SPG, color)}</div>
        <div class="val"><b>${rsClp(x.cm)}</b> <b style="color:${color}">${rsDelta(d)}</b></div>
      </div>`;
  }).join('');

  if (!items.length) return `<div class="rs-note">Aún no hay compras en este requerimiento.</div>`;

  return `
    <div class="rs-flow" role="tabpanel">
      <div class="rs-kpis">${kpis}</div>

      ${ranked.length >= 2 ? `
      <div class="rs-card">
        <div><div class="rs-card-title">Dónde se concentra el gasto</div>
        <div class="rs-card-sub">Subtotal de cada ítem (cantidad por mediana de Compra Ágil), de mayor a menor.</div></div>
        <div class="rs-rows">${rank}</div>
      </div>` : ''}

      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <h2 class="rs-h2">Productos del requerimiento</h2><span class="rs-muted" style="font-size:12px">Valores unitarios referenciales, IVA incluido${RSC.hasCm ? ' (al catálogo de Convenio Marco, publicado sin IVA, se le suma el 19 %)' : ''}</span>
        </div>
        <div class="rs-tablewrap"><div class="rs-t">
          <div class="hd ${gcls}"><div>Ítem</div><div>Producto</div><div class="r">Cantidad</div><div class="r">Unitario${RSC.hasCm ? ' CA' : ''}</div><div class="r">Subtotal</div>${RSC.hasCm ? '<div class="r">Unitario CM</div>' : ''}</div>
          ${rows}
          <div class="tr tot ${gcls}"><div></div><div class="nm" style="font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#0f3d78">Total estimado${missing ? ' (parcial)' : ''}</div><div class="r nm">${qtyTotal.toLocaleString('es-CL')}</div><div></div><div class="r nm" style="font-size:16px;color:#0a2d5e;font-weight:700">${rsClp(total)}</div>${RSC.hasCm ? '<div></div>' : ''}</div>
        </div></div>
      </div>

      ${RSC.hasCm && items.length >= 2 ? `
      <div class="rs-card">
        <div><div class="rs-card-title">Convenio Marco frente a Compra Ágil</div>
        <div class="rs-card-sub">Diferencia entre la mediana del catálogo de Convenio Marco y la mediana de Compra Ágil de cada ítem. Ambas con IVA incluido: el catálogo se publica sin IVA y aquí se le suma el 19 %. Responde si el catálogo es más caro o más barato que el mercado.</div></div>
        <div class="rs-legend">
          <div><span style="width:2px;height:14px;background:#0a2d5e"></span>Mediana de Compra Ágil</div>
          <div><span class="rs-sw" style="background:#154f96"></span>Catálogo más barato</div>
          <div><span class="rs-sw" style="background:#c2410c"></span>Catálogo más caro</div>
        </div>
        <div class="rs-rows">${diff}</div>
        <div class="rs-row" style="margin-top:-2px"><div></div>${rsDivAxis(SPG)}<div></div></div>
      </div>
      ` : ''}
    </div>`;
}

/* ── Detalle de un ítem ──────────────────────────────────────────── */

function rsItemHtml(x, items) {
  const total = rsSum(items.filter(i => i.sub != null), i => i.sub);
  const share = x.sub != null && total ? (x.sub / total * 100).toFixed(1).replace('.', ',') + ' %' : '—';

  const range = x.ca != null && x.p25 != null && x.p75 != null && x.p75 > x.p25
    ? Math.max(0, Math.min(100, (x.ca - x.p25) / (x.p75 - x.p25) * 100)) : 50;
  const caCard = `
    <div class="rs-pc">
      <div class="k">Compra Ágil · histórico</div>
      <div class="v" style="color:${x.ca != null ? '#047857' : '#64748b'}">${x.ca != null ? rsClp(x.ca) : 'Sin datos'}</div>
      <div class="d">${x.ca != null ? `Mediana unitaria, IVA incluido · ${rsE(String(x.n ?? '—'))} compras` : 'No hay compras históricas registradas para esta especificación.'}</div>
      ${x.ca != null && x.p25 != null ? `<div class="rs-range"><i style="left:${range.toFixed(1)}%"></i></div><div class="rs-range-ends"><span>${rsClp(x.p25)}</span><span>${rsClp(x.p75)}</span></div>` : ''}
    </div>`;
  const hasCm = x.cm != null;
  const cmCard = `
    <div class="rs-pc cm ${hasCm ? '' : 'off'}">
      <div class="k">Convenio Marco vigente</div>
      <div class="v">${hasCm ? rsClp(x.cm) : 'Sin datos'}</div>
      <div class="d">${hasCm ? `Mediana del catálogo con IVA (precio neto + 19 %) · ${rsE(String(x.cmN ?? '—'))} productos entre ${rsClp(x.cmMin)} y ${rsClp(x.cmMax)}` : 'No hay productos equivalentes vigentes en Convenio Marco para esta especificación.'}</div>
    </div>`;
  const dCm = hasCm && x.ca != null ? (x.cm / x.ca - 1) * 100 : null;
  const diffCard = `
    <div class="rs-pc">
      <div class="k">Convenio Marco vs. Compra Ágil</div>
      <div class="v" style="color:#0a2d5e">${dCm != null ? rsDelta(dCm) : '—'}</div>
      <div class="d">${dCm != null ? `El catálogo está ${Math.abs(dCm).toFixed(1).replace('.', ',')} % ${dCm > 0 ? 'por encima' : 'por debajo'} de la mediana de Compra Ágil.` : 'Sin ambos precios para comparar.'}</div>
    </div>`;

  const subCard = `
    <div class="rs-pc">
      <div class="k">Subtotal estimado</div>
      <div class="v" style="color:#0a2d5e">${rsClp(x.sub)}</div>
      <div class="d">${x.sub != null ? `${x.qty.toLocaleString('es-CL')} × ${rsClp(x.ca)}${x.p25 != null && x.p75 != null ? ` · rango típico ${rsClp(x.qty * x.p25)} a ${rsClp(x.qty * x.p75)}` : ''}` : 'Sin precio estimado'}</div>
    </div>`;

  return `
    <div class="rs-flow t24" role="tabpanel">
      <div>
        <div class="rs-eyebrow">Ítem ${x.num} de ${rsPad(items.length)}</div>
        <h2 class="rs-item-title" title="${rsE(x.name)}">${rsE(x.name)}</h2>
        <div class="rs-muted" style="margin-top:6px">${rsE(x.spec)}</div>
        <div class="rs-strip">
          <span>Cantidad requerida <strong>${x.qty.toLocaleString('es-CL')}</strong></span>
          <span>Subtotal estimado <strong>${rsClp(x.sub)}</strong></span>
          <span>Peso en el requerimiento <strong>${share}</strong></span>
        </div>
      </div>
      <div class="rs-pcards">${RSC.hasCm ? caCard + cmCard + diffCard : caCard + subCard}</div>
      <div id="rs-market" class="rs-flow t24">${rsMarketHtml(x)}</div>
      ${RSC.hasRevisados ? rsRevisadosHtml(x) : ''}
    </div>`;
}

/* ── Datos de mercado ────────────────────────────────────────────────
   Se piden en cuanto se abre el resumen (el ítem que se está mirando
   primero, el resto en segundo plano, de a dos), así al cambiar de pestaña
   ya están. El backend los cachea por contenido de la ficha. */

function rsEnsureMarket(x, done) {
  if (rs.state[x.id] === 'ok' || rs.state[x.id] === 'loading') { if (done) done(); return; }
  rs.state[x.id] = 'loading';
  apiFetch(RSC.marketPath, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ items: [{ id: x.id, atributos: x.it.atributos || {}, relaxed_attrs: RSC.relaxed(x.it) }] }),
  })
    .then(r => (r && r.ok ? r.json() : Promise.reject(new Error('market'))))
    .then(d => {
      const m = (d.items || []).find(i => i.id === x.id);
      if (!m) throw new Error('sin datos');
      rs.market[x.id] = m;
      rs.state[x.id] = 'ok';
    })
    .catch(() => { rs.state[x.id] = 'error'; })
    .finally(() => {
      // Repinta solo el bloque de mercado, y solo si sigue abierto ese ítem
      const box = document.getElementById('rs-market');
      if (box && rs.tab === x.id) box.innerHTML = rsMarketHtml(rsItems().find(i => i.id === x.id) || x);
      if (done) done();
    });
}

function rsPrefetch() {
  const queue = rsItems().filter(x => !rs.state[x.id]);
  queue.sort((a, b) => (b.id === rs.tab) - (a.id === rs.tab));   // primero el ítem que se está viendo
  let running = 0;
  const pump = () => {
    while (running < 2 && queue.length) {
      running++;
      rsEnsureMarket(queue.shift(), () => { running--; pump(); });
    }
  };
  pump();
}

function rsCurrentItem() {
  return rsItems().find(i => i.id === rs.tab) || null;
}

// Repinta el bloque de mercado conservando el foco (teclado) sobre el control tocado
function rsRefreshMarket(focusSelector) {
  const x = rsCurrentItem();
  const box = document.getElementById('rs-market');
  if (!x || !box) return;
  box.innerHTML = rsMarketHtml(x);
  if (focusSelector) { const el = box.querySelector(focusSelector); if (el) el.focus({ preventScroll: true }); }
}

/* ── Mercado: evolución (tendencia), proveedores, distribución y compras ──
   Todo se puede tocar: un punto de la línea, un tramo del histograma o un
   proveedor filtran la tabla de compras de abajo. */

const RS_PAGE = 5;
const RS_REV_PAGE = 5;
const RS_SORTS = [
  ['fecha_desc', 'Más recientes primero'], ['fecha_asc', 'Más antiguas primero'],
  ['precio_desc', 'Mayor precio primero'], ['precio_asc', 'Menor precio primero'],
];

function rsUi(id) {
  return rs.ui[id] || (rs.ui[id] = { gran: null, sel: null, page: 0, sort: 'fecha_desc', open: null });
}

// Períodos: mes, trimestre o año (por defecto según cuánto abarcan los datos)
function rsAutoGran(tmin, tmax) {
  const months = (tmax - tmin) / (86400000 * 30.4);
  return months <= 18 ? 'm' : months <= 60 ? 'q' : 'y';
}
function rsPeriodKey(f, gran) {
  const y = f.slice(0, 4), m = Number(f.slice(5, 7));
  return gran === 'y' ? y : gran === 'q' ? `${y}-T${Math.ceil(m / 3)}` : f.slice(0, 7);
}
function rsPeriodLabel(key, gran) {
  if (gran === 'y') return key;
  if (gran === 'q') { const [y, t] = key.split('-'); return `${t} ${y}`; }
  return rsShortDate(Date.parse(key + '-15'));
}

function rsPeriods(serie, gran) {
  const map = new Map();
  serie.forEach((d, idx) => {
    const t = Date.parse(d.f);
    if (!Number.isFinite(t)) return;
    const k = rsPeriodKey(d.f, gran);
    if (!map.has(k)) map.set(k, { key: k, n: 0, sum: 0, min: Infinity, max: -Infinity, tsum: 0 });
    const g = map.get(k);
    g.n++; g.sum += d.p; g.tsum += t;
    g.min = Math.min(g.min, d.p); g.max = Math.max(g.max, d.p);
  });
  return [...map.values()]
    .map(g => ({ ...g, avg: Math.round(g.sum / g.n), t: g.tsum / g.n, label: rsPeriodLabel(g.key, gran) }))
    .sort((a, b) => a.t - b.t);
}

function rsFiltered(x, m) {
  const ui = rsUi(x.id);
  let list = m.serie.map((d, idx) => ({ ...d, idx }));
  const s = ui.sel;
  if (s) {
    if (s.kind === 'period') list = list.filter(d => rsPeriodKey(d.f, s.gran) === s.key);
    else if (s.kind === 'prov') list = list.filter(d => d.v === s.key);
    else if (s.kind === 'bin' && m.histograma) {
      const h = m.histograma, w = (h.hi - h.lo) / h.counts.length, i = Number(s.key);
      list = list.filter(d => {
        const b = Math.min(Math.floor((d.p - h.lo) / w), h.counts.length - 1);
        return b === i;
      });
    }
  }
  const by = {
    fecha_desc: (a, b) => b.f.localeCompare(a.f), fecha_asc: (a, b) => a.f.localeCompare(b.f),
    precio_desc: (a, b) => b.p - a.p, precio_asc: (a, b) => a.p - b.p,
  }[ui.sort] || ((a, b) => b.f.localeCompare(a.f));
  return list.sort(by);
}

function rsMarketHtml(x) {
  const st = rs.state[x.id];
  if (st === 'error') {
    return `<div class="rs-note">No pudimos cargar el historial de mercado de este ítem. Cierra y vuelve a abrir el resumen para intentarlo de nuevo.</div>`;
  }
  if (st !== 'ok') {
    return `<div class="rs-card">${loadingBlockHtml('Cargando el historial de mercado de este ítem...', { pills: [140, 110, 170, 90, 130, 120] })}</div>`;
  }
  const m = rs.market[x.id];
  if (!m || !m.serie || !m.serie.length) {
    return `<div class="rs-note">No hay compras históricas de Compra Ágil con esta especificación para mostrar la evolución, los proveedores ni la distribución de precios.</div>`;
  }
  const ui = rsUi(x.id);
  const muestra = m.n_total > m.n_muestra
    ? `Basado en las ${m.n_muestra} compras más recientes (de ${m.n_total} en total)`
    : `Basado en ${m.n_muestra} compras`;
  const nAt = Number(m.n_atipicos) || 0;
  const atipicos = nAt ? ` No se muestran ${nAt} compra${nAt === 1 ? '' : 's'} con precios atípicos (muy por encima o por debajo del resto).` : '';

  return rsEvolutionHtml(x, m, ui, muestra, atipicos) + rsProvHistHtml(x, m, ui) + rsComprasHtml(x, m, ui);
}

/* Evolución: línea de tendencia del precio promedio por período */
function rsEvolutionHtml(x, m, ui, muestra, atipicos) {
  const serie = m.serie;
  const tAll = serie.map(d => Date.parse(d.f)).filter(Number.isFinite);
  const tmin = Math.min(...tAll);
  let tmax = Math.max(...tAll);
  const gran = ui.gran || rsAutoGran(tmin, tmax);
  const periods = rsPeriods(serie, gran);

  const marks = rsRevisadosOf(x.id)
    .map((r, i) => ({ i, r, t: r.raw ? Date.parse(r.raw.fecha_modificacion) : NaN, p: r.price }))
    .filter(d => d.r.source === 'ca' && Number.isFinite(d.t) && Number.isFinite(d.p));
  const T0 = Math.min(tmin, ...marks.map(d => d.t)), T1 = Math.max(tmax, ...marks.map(d => d.t), T0 + 86400000);
  const prices = serie.map(d => d.p).concat(marks.map(d => d.p), x.ca != null ? [x.ca] : []);
  const pmin = Math.min(...prices), pmax = Math.max(...prices);
  const pad = (pmax - pmin) * 0.08 || pmax * 0.05 || 1;
  const lo = Math.max(0, pmin - pad), hi = pmax + pad;
  const X = (t) => 4 + (t - T0) / (T1 - T0) * 92;
  const Y = (p) => Math.max(2, Math.min(98, (p - lo) / (hi - lo) * 100));

  const line = periods.length > 1
    ? `<polyline points="${periods.map(g => `${X(g.t).toFixed(2)},${(100 - Y(g.avg)).toFixed(2)}`).join(' ')}" fill="none" stroke="#154f96" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>` : '';
  const band = periods.length > 1
    ? `<polygon points="${periods.map(g => `${X(g.t).toFixed(2)},${(100 - Y(g.max)).toFixed(2)}`).join(' ')} ${[...periods].reverse().map(g => `${X(g.t).toFixed(2)},${(100 - Y(g.min)).toFixed(2)}`).join(' ')}" fill="#dfeaf8" opacity=".75"/>` : '';

  const faint = serie.map(d => { const t = Date.parse(d.f); return Number.isFinite(t) ? `<i class="rs-fp" style="left:${X(t).toFixed(1)}%;bottom:${Y(d.p).toFixed(1)}%"></i>` : ''; }).join('');
  const sel = ui.sel && ui.sel.kind === 'period' ? ui.sel.key : null;
  const dots = periods.map(g => {
    const tip = `${g.label}: promedio ${rsClp(g.avg)} · ${g.n} compra${g.n === 1 ? '' : 's'} (entre ${rsClp(g.min)} y ${rsClp(g.max)})`;
    return `
      <button type="button" class="rs-dot ${sel === g.key ? 'on' : ''}" data-rs-period="${rsE(g.key)}" aria-label="${rsE(tip)}. Ver estas compras"
              style="left:${X(g.t).toFixed(2)}%;bottom:${Y(g.avg).toFixed(2)}%">
        <span class="rs-tip"><b>${rsE(g.label)}</b><br>Promedio ${rsClp(g.avg)}<br>${g.n} compra${g.n === 1 ? '' : 's'} · ${rsClp(g.min)} a ${rsClp(g.max)}<br><em>Clic para ver las compras</em></span>
      </button>`;
  }).join('');
  const mks = marks.map(d => {
    const tip = `Compra que revisaste: ${d.r.label} · ${rsClp(d.p)} · ${d.r.raw.fecha_modificacion}`;
    return `
      <button type="button" class="rs-mark" data-rs-mark="${d.i}" aria-label="${rsE(tip)}. Ver detalle"
              style="left:${X(d.t).toFixed(1)}%;bottom:${Y(d.p).toFixed(1)}%">
        <span class="rs-tip"><b>Compra que revisaste</b><br>${rsE(d.r.label)}<br>${rsClp(d.p)} · ${rsE(d.r.raw.fecha_modificacion)}<br><em>Clic para ver el detalle</em></span>
      </button>`;
  }).join('');
  const medY = x.ca != null ? Y(x.ca) : null;

  const grans = [['m', 'Mensual'], ['q', 'Trimestral'], ['y', 'Anual']].map(([k, l]) =>
    `<button type="button" class="rs-seg ${gran === k ? 'on' : ''}" data-rs-gran="${k}" aria-pressed="${gran === k}">${l}</button>`).join('');
  // Eje de fechas: marcas parejas en el tiempo (no una por punto, que se pisaban entre sí)
  const NT = 5, ticks = [];
  for (let i = 0; i < NT; i++) {
    const t = T0 + (T1 - T0) * i / (NT - 1);
    const label = gran === 'y' ? String(new Date(t).getUTCFullYear()) : rsShortDate(t);
    if (!ticks.length || ticks[ticks.length - 1].label !== label) ticks.push({ t, label });
  }
  const xl = ticks.map(g => `<span style="left:${X(g.t).toFixed(1)}%">${rsE(g.label)}</span>`).join('');

  return `
    <div class="rs-card">
      <div class="rs-card-head">
        <div><div class="rs-card-title">Evolución del precio</div>
        <div class="rs-card-sub">Precio promedio por período de las compras históricas de Compra Ágil de este ítem. ${rsE(muestra)}.${atipicos ? rsE(atipicos) : ''}</div></div>
        <div class="rs-segs" role="group" aria-label="Agrupar por">${grans}</div>
      </div>
      <div class="rs-legend">
        <div><span style="width:18px;height:3px;background:#154f96;border-radius:2px"></span>Promedio del período</div>
        <div><span style="width:18px;height:10px;background:#dfeaf8"></span>Rango del período (mín. a máx.)</div>
        <div><span style="width:6px;height:6px;border-radius:999px;background:#047857;opacity:.45"></span>Cada compra</div>
        ${marks.length ? `<div><span style="width:13px;height:13px;box-sizing:border-box;border-radius:999px;background:#fff;border:3px solid #0a2d5e"></span>Compra que revisaste</div>` : ''}
        ${medY != null ? `<div><span style="width:18px;border-top:2px dashed #0a2d5e"></span>Mediana de Compra Ágil (${rsClp(x.ca)})</div>` : ''}
      </div>
      <div class="rs-plot rs-plot-line" role="group" aria-label="Línea de tendencia del precio promedio por período">
        <svg class="rs-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${band}${line}</svg>
        <div class="g" style="bottom:25%"></div><div class="g" style="bottom:50%"></div><div class="g" style="bottom:75%"></div>
        ${medY != null ? `<div class="med" style="bottom:${medY.toFixed(1)}%"></div>` : ''}
        <div class="yl" style="top:4px">${rsClp(hi)}</div><div class="yl" style="bottom:4px">${rsClp(lo)}</div>
        ${faint}${mks}${dots}
      </div>
      <div class="rs-xl">${xl}</div>
    </div>`;
}

/* Proveedores y distribución: se pueden tocar para filtrar las compras */
function rsProvHistHtml(x, m, ui) {
  const selProv = ui.sel && ui.sel.kind === 'prov' ? ui.sel.key : null;
  const avgBy = {};
  m.serie.forEach(d => { (avgBy[d.v] = avgBy[d.v] || []).push(d.p); });
  const maxProv = m.proveedores.length ? m.proveedores[0].count : 1;
  const prov = m.proveedores.map((v, i) => {
    const arr = avgBy[v.name] || [];
    const avg = arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    return `
      <button type="button" class="rs-row prov rs-click ${selProv === v.name ? 'on' : ''}" data-rs-provi="${i}" aria-label="${rsE(v.name)}: ${v.count} compras. Ver estas compras">
        <div class="name" title="${rsE(v.name)}">${rsE(v.name)}${avg != null ? `<small>Promedio ${rsClp(avg)}</small>` : ''}</div>
        <div class="rs-track" style="height:14px"><i style="height:14px;width:${(v.count / maxProv * 100).toFixed(0)}%"></i></div>
        <div class="val"><b>${rsE(String(v.count))}</b> <span class="rs-muted">· ${m.proveedores_total ? Math.round(v.count / m.proveedores_total * 100) : 0} %</span></div>
      </button>`;
  }).join('');

  const h = m.histograma;
  let hist;
  if (h && h.counts && h.counts.length) {
    const nb = h.counts.length, w = (h.hi - h.lo) / nb;
    const peak = Math.max(...h.counts, 1);
    const medBin = x.ca != null ? Math.max(0, Math.min(nb - 1, Math.floor((x.ca - h.lo) / (h.hi - h.lo) * nb))) : -1;
    const selBin = ui.sel && ui.sel.kind === 'bin' ? Number(ui.sel.key) : -1;
    const bars = h.counts.map((c, i) => {
      const a = h.lo + i * w, b = h.lo + (i + 1) * w;
      const tip = `${rsClp(a)} a ${rsClp(b)}: ${c} compra${c === 1 ? '' : 's'}`;
      return `
        <button type="button" class="rs-bin ${i === medBin ? 'med' : ''} ${i === selBin ? 'on' : ''}" data-rs-bin="${i}" ${c ? '' : 'disabled'} aria-label="${rsE(tip)}">
          <b>${c ? rsE(String(c)) : ''}</b><i style="height:${c ? Math.max(6, Math.round(c / peak * 124)) : 2}px"></i>
          <span class="rs-tip"><b>${rsClp(a)} a ${rsClp(b)}</b><br>${c} compra${c === 1 ? '' : 's'}${c ? '<br><em>Clic para ver las compras</em>' : ''}</span>
        </button>`;
    }).join('');
    hist = `
      <div class="rs-card">
        <div><div class="rs-card-title">Distribución de precios</div><div class="rs-card-sub">Número de compras por tramo de precio. Toca un tramo para ver sus compras.</div></div>
        <div class="rs-hist" role="group" aria-label="Histograma de precios">${bars}</div>
        <div class="rs-axis"><span>${rsClp(h.lo)}</span><span>${rsClp(h.hi)}</span></div>
        ${medBin >= 0 ? `<div class="rs-legend"><div><span class="rs-sw" style="background:#154f96"></span>Tramo de la mediana (${rsClp(x.ca)})</div></div>` : ''}
      </div>`;
  } else {
    hist = `
      <div class="rs-card">
        <div><div class="rs-card-title">Distribución de precios</div></div>
        <div class="rs-card-sub" style="margin:0">Hay muy pocas compras (${rsE(String(m.serie.length))}) para mostrar una distribución. Revisa el detalle de cada una en la tabla de abajo.</div>
      </div>`;
  }

  return `
    <div class="rs-grid2">
      <div class="rs-card">
        <div><div class="rs-card-title">Principales ${RSC.prov[1]}</div><div class="rs-card-sub">Los ${m.proveedores.length} con más compras${RSC.prov[0] === 'proveedor' ? ' adjudicadas' : ''}. Toca uno para ver sus compras.</div></div>
        <div class="rs-rows">${prov}</div>
      </div>
      ${hist}
    </div>`;
}

/* Compras históricas: tabla de filas fijas, con filtro, orden, paginación y detalle */
function rsComprasHtml(x, m, ui) {
  const list = rsFiltered(x, m);
  const pages = Math.max(1, Math.ceil(list.length / RS_PAGE));
  ui.page = Math.max(0, Math.min(ui.page, pages - 1));
  const slice = list.slice(ui.page * RS_PAGE, (ui.page + 1) * RS_PAGE);

  const s = ui.sel;
  let chip = '';
  if (s) {
    const label = s.kind === 'period' ? `Período: ${rsPeriodLabel(s.key, s.gran)}`
      : s.kind === 'prov' ? `${rsCap(RSC.prov[0])}: ${s.key}`
      : (() => { const h = m.histograma, w = (h.hi - h.lo) / h.counts.length, i = Number(s.key); return `Precio: ${rsClp(h.lo + i * w)} a ${rsClp(h.lo + (i + 1) * w)}`; })();
    chip = `<span class="rs-chip">${rsE(label)}<button type="button" data-rs-clear aria-label="Quitar filtro">×</button></span>`;
  }

  const rows = slice.map(d => {
    const open = ui.open === d.idx;
    return `
      <div class="rs-prow-wrap ${open ? 'open' : ''}">
        <button type="button" class="rs-prow" data-rs-row="${d.idx}" aria-expanded="${open}">
          <span class="f">${rsE(d.f)}</span>
          <span class="v" title="${rsE(d.v)}">${rsE(d.v)}</span>
          <span class="d" title="${rsE(d.d || '')}">${rsE(d.d || '—')}</span>
          <span class="p">${rsClp(d.p)}</span>
          <span class="c" aria-hidden="true">${open ? '▴' : '▾'}</span>
        </button>
        ${open ? `
        <div class="rs-pdet">
          <div><span>${rsCap(RSC.prov[0])}</span><b>${rsE(d.v)}</b></div>
          <div><span>Precio unitario (IVA incl.)</span><b>${rsClp(d.p)}</b></div>
          <div><span>Fecha</span><b>${rsE(d.f)}</b></div>
          <div><span>Requerimiento</span><b>${rsE(d.c || '—')}</b></div>
          <div class="wide"><span>Descripción</span><p>${rsE(d.d || 'Sin descripción')}</p></div>
          ${d.u ? `<div class="wide"><a class="rs-btn" href="${rsE(safeUrl(d.u))}" target="_blank" rel="noopener">Ver en Compra Ágil ↗</a></div>` : ''}
        </div>` : ''}
      </div>`;
  }).join('');

  const sorts = RS_SORTS.map(([v, l]) => `<option value="${v}" ${ui.sort === v ? 'selected' : ''}>${l}</option>`).join('');
  return `
    <div class="rs-card" id="rs-compras">
      <div class="rs-card-head">
        <div><div class="rs-card-title">Compras históricas</div>
        <div class="rs-card-sub">${list.length} compra${list.length === 1 ? '' : 's'}${s ? ' con el filtro aplicado' : ' analizadas'}. Toca una fila para ver su detalle.</div></div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${chip}
          <select class="rs-select" data-rs-sort aria-label="Ordenar compras">${sorts}</select></div>
      </div>
      ${list.length ? `
      <div class="rs-ptable">
        <div class="rs-phead"><span>Fecha</span><span>${rsCap(RSC.prov[0])}</span><span>Descripción</span><span class="p">Precio</span><span></span></div>
        ${rows}
      </div>
      <div class="rs-pager">
        <button type="button" class="rs-btn" data-rs-page="-1" ${ui.page <= 0 ? 'disabled' : ''}>← Anterior</button>
        <span>Página ${ui.page + 1} de ${pages} · ${list.length} compras</span>
        <button type="button" class="rs-btn" data-rs-page="1" ${ui.page >= pages - 1 ? 'disabled' : ''}>Siguiente →</button>
      </div>` : `<div class="rs-note" style="border:0;padding:8px 0">No hay compras con ese filtro.</div>`}
    </div>`;
}

/* ── Productos revisados del ítem ────────────────────────────────── */

function rsRevisadosHtml(x) {
  const revs = rsRevisadosOf(x.id);
  const title = `<h3 class="rs-h2">Productos revisados${revs.length ? ` <small>(${revs.length})</small>` : ''}</h3>`;
  if (!revs.length) {
    return `<div class="rs-flow t24" id="rs-rev" style="gap:12px">${title}<div class="rs-note">No marcaste productos para revisar en este ítem. Puedes hacerlo desde el asistente, en las compras históricas o en los productos de Convenio Marco.</div></div>`;
  }

  // Convenio Marco revisado frente a la mediana de Compra Ágil (escala ajustada a los datos)
  const cm = revs.filter(r => r.source === 'cm' && Number.isFinite(r.price));
  let chart = '';
  if (cm.length && x.ca != null) {
    const hasBand = x.p25 != null && x.p75 != null;
    const dLo = hasBand ? (x.p25 / x.ca - 1) * 100 : NaN, dHi = hasBand ? (x.p75 / x.ca - 1) * 100 : NaN;
    const SPAN = rsDivScale(cm.map(r => (rsRevPrice(r) / x.ca - 1) * 100), [dLo, dHi]);
    const bLo = hasBand ? rsDivPos(dLo, SPAN) : 0, bHi = hasBand ? rsDivPos(dHi, SPAN) : 0;
    const rows = cm.map(r => {
      const d = (rsRevPrice(r) / x.ca - 1) * 100, neg = d < 0;
      const color = neg ? '#154f96' : '#c2410c';
      return `
        <div class="rs-row" style="grid-template-columns:170px minmax(0,1fr) 118px">
          <div class="name" title="${rsE(r.label)}">${rsE(r.label)}</div>
          <div class="rs-dplot tall"${Math.abs(d) > SPAN ? ` title="${rsE(rsDelta(d))} (fuera de escala)"` : ''}>
            ${hasBand ? `<div class="band" style="left:${bLo.toFixed(1)}%;width:${(bHi - bLo).toFixed(1)}%"></div>` : ''}
            ${rsDivGrid()}
            <div class="zero"></div>
            ${rsDivBar(d, SPAN, color)}
          </div>
          <div class="val"><b>desde ${rsClp(rsRevPrice(r))}</b><br><b style="color:${color}">${rsDelta(d)}</b></div>
        </div>`;
    }).join('');
    chart = `
      <div class="rs-card">
        <div><div class="rs-card-title">Convenio Marco revisado vs. precio de mercado</div>
        <div class="rs-card-sub">Precio de catálogo de cada producto de Convenio Marco que revisaste (neto más 19 % de IVA), comparado con la mediana de Compra Ágil de este ítem (${rsClp(x.ca)}).</div></div>
        <div class="rs-legend">
          <div><span style="width:2px;height:14px;background:#0a2d5e"></span>Mediana de mercado</div>
          ${hasBand ? `<div><span style="width:18px;height:12px;border-radius:2px;background:#dfeaf8"></span>Rango típico (50 % central de las compras)</div>` : ''}
          <div><span class="rs-sw" style="background:#154f96"></span>Más barato que la mediana</div>
          <div><span class="rs-sw" style="background:#c2410c"></span>Más caro que la mediana</div>
        </div>
        <div class="rs-rows" style="gap:14px;padding:7px 0">${rows}</div>
        <div class="rs-row" style="grid-template-columns:170px minmax(0,1fr) 118px"><div></div>${rsDivAxis(SPAN)}<div></div></div>
      </div>`;
  }

  return `
    <div class="rs-flow t24" id="rs-rev" style="gap:12px">
      ${title}
      ${chart}
      <div id="rs-revtable">${rsRevTableHtml(x)}</div>
    </div>`;
}

/* Tabla de productos revisados: filas de alto fijo, 5 por página; tocar una fila abre su detalle */
function rsRevTableHtml(x) {
  const revs = rsRevisadosOf(x.id);
  const ui = rsUi(x.id);
  const pages = Math.max(1, Math.ceil(revs.length / RS_REV_PAGE));
  ui.revPage = Math.max(0, Math.min(ui.revPage || 0, pages - 1));
  const start = ui.revPage * RS_REV_PAGE;

  const rows = revs.slice(start, start + RS_REV_PAGE).map((r, j) => {
    const i = start + j, open = ui.revOpen === i;
    const d = x.ca != null && Number.isFinite(r.price) ? (rsRevPrice(r) / x.ca - 1) * 100 : null;
    const color = d == null ? '#475569' : d < 0 ? '#154f96' : '#c2410c';
    const isCm = r.source === 'cm';
    const raw = r.raw || {};
    const fecha = raw.fecha_modificacion || null;
    const code = raw.codigo_requerimiento || null;
    const detalle = isCm ? (r.sub ? `${r.sub} · catálogo neto + 19 % de IVA, valor mínimo` : 'Catálogo neto + 19 % de IVA, valor mínimo') : (r.sub || '');
    const largo = (isCm ? '' : (raw.descripcion || '')) || r.sub || 'Sin descripción';
    const rango = isCm && Number.isFinite(raw.precio_min_clp) && Number.isFinite(raw.precio_max_clp) && raw.precio_max_clp !== raw.precio_min_clp
      ? `${rsClp(rsGross(raw.precio_min_clp))} a ${rsClp(rsGross(raw.precio_max_clp))}` : null;
    return `
      <div class="rs-prow-wrap ${open ? 'open' : ''}">
        <button type="button" class="rs-prow rs-rrow" data-rs-rrow="${i}" aria-expanded="${open}">
          <span><span class="rs-tag ${isCm ? 'cm' : 'ca'}">${isCm ? 'CONV. MARCO' : 'COMPRA ÁGIL'}</span></span>
          <span class="v" title="${rsE(r.label)}">${rsE(r.label)}</span>
          <span class="d" title="${rsE(detalle)}">${rsE(detalle || '—')}</span>
          <span class="p" style="color:#0f172a">${rsClp(rsRevPrice(r))}</span>
          <span class="p" style="color:${color}">${d == null ? '—' : rsDelta(d)}</span>
          <span class="c" aria-hidden="true">${open ? '▴' : '▾'}</span>
        </button>
        ${open ? `
        <div class="rs-pdet">
          <div><span>Origen</span><b>${isCm ? 'Convenio Marco' : 'Compra Ágil'}</b></div>
          <div><span>${isCm ? 'Precio de catálogo con IVA (mínimo)' : 'Precio unitario (IVA incl.)'}</span><b>${rsClp(rsRevPrice(r))}</b></div>
          ${isCm ? `<div><span>Precio neto de catálogo</span><b>${rsClp(r.price)}</b></div>` : ''}
          ${rango ? `<div><span>Rango de precios del producto</span><b>${rsE(rango)}</b></div>` : ''}
          <div><span>Frente a la mediana de este ítem</span><b style="color:${color}">${d == null ? '—' : rsDelta(d)}</b></div>
          ${fecha ? `<div><span>Fecha</span><b>${rsE(fecha)}</b></div>` : ''}
          ${code ? `<div><span>Requerimiento</span><b>${rsE(code)}</b></div>` : ''}
          <div class="wide"><span>${isCm ? 'Producto' : 'Descripción'}</span><p>${rsE(isCm ? r.label : largo)}</p></div>
          ${r.url ? `<div class="wide"><a class="rs-btn" href="${rsE(safeUrl(r.url))}" target="_blank" rel="noopener">Ver en ${isCm ? 'Convenio Marco' : 'Compra Ágil'} ↗</a></div>` : ''}
        </div>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="rs-ptable">
      <div class="rs-phead rs-rhead"><span>Origen</span><span>Producto o proveedor</span><span>Detalle</span><span class="p">Precio</span><span class="p">vs. mediana</span><span></span></div>
      ${rows}
    </div>
    ${pages > 1 ? `
    <div class="rs-pager" style="margin-top:12px">
      <button type="button" class="rs-btn" data-rs-rpage="-1" ${ui.revPage <= 0 ? 'disabled' : ''}>← Anterior</button>
      <span>Página ${ui.revPage + 1} de ${pages} · ${revs.length} productos</span>
      <button type="button" class="rs-btn" data-rs-rpage="1" ${ui.revPage >= pages - 1 ? 'disabled' : ''}>Siguiente →</button>
    </div>` : ''}`;
}

function rsRefreshRev(focusSelector) {
  const x = rsCurrentItem();
  const box = document.getElementById('rs-revtable');
  if (!x || !box) return;
  box.innerHTML = rsRevTableHtml(x);
  if (focusSelector) { const el = box.querySelector(focusSelector); if (el) el.focus({ preventScroll: true }); }
}

/* ── Eventos ─────────────────────────────────────────────────────── */

rsPanel.addEventListener('click', (e) => {
  if (e.target.closest('[data-rs-close]')) { closeResumen(); return; }
  if (e.target.closest('[data-rs-pdf]')) { RSC.downloadPdf(); return; }
  // ── Interacción con los gráficos y las tablas del ítem ──
  const x = rs.tab !== 'g' ? rsCurrentItem() : null;
  if (x) {
    const uiR = rsUi(x.id);
    const rrow = e.target.closest('[data-rs-rrow]');
    if (rrow) { const i = Number(rrow.dataset.rsRrow); uiR.revOpen = uiR.revOpen === i ? null : i; rsRefreshRev(`[data-rs-rrow="${i}"]`); return; }
    const rpg = e.target.closest('[data-rs-rpage]');
    if (rpg) { uiR.revPage = (uiR.revPage || 0) + Number(rpg.dataset.rsRpage); uiR.revOpen = null; rsRefreshRev(`[data-rs-rpage="${rpg.dataset.rsRpage}"]`); return; }
    const mark = e.target.closest('[data-rs-mark]');
    if (mark) {
      const i = Number(mark.dataset.rsMark);
      uiR.revOpen = i; uiR.revPage = Math.floor(i / RS_REV_PAGE);
      rsRefreshRev();
      const sec = document.getElementById('rs-rev');
      if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
  }
  if (x && rs.state[x.id] === 'ok') {
    const ui = rsUi(x.id), m = rs.market[x.id];
    const pick = (sel, focus) => {
      ui.sel = sel; ui.page = 0; ui.open = null;
      rsRefreshMarket(focus);
      const t = document.getElementById('rs-compras');
      if (t) t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    const per = e.target.closest('[data-rs-period]');
    if (per) {
      const key = per.dataset.rsPeriod;
      const gran = ui.gran || rsAutoGran(...(() => { const t = m.serie.map(d => Date.parse(d.f)).filter(Number.isFinite); return [Math.min(...t), Math.max(...t)]; })());
      const same = ui.sel && ui.sel.kind === 'period' && ui.sel.key === key;
      pick(same ? null : { kind: 'period', key, gran }, `[data-rs-period="${CSS.escape(key)}"]`);
      return;
    }
    const bin = e.target.closest('[data-rs-bin]');
    if (bin) {
      const key = bin.dataset.rsBin;
      const same = ui.sel && ui.sel.kind === 'bin' && ui.sel.key === key;
      pick(same ? null : { kind: 'bin', key }, `[data-rs-bin="${key}"]`);
      return;
    }
    const provBtn = e.target.closest('[data-rs-provi]');
    if (provBtn) {
      const i = Number(provBtn.dataset.rsProvi), name = m.proveedores[i] && m.proveedores[i].name;
      if (name != null) {
        const same = ui.sel && ui.sel.kind === 'prov' && ui.sel.key === name;
        pick(same ? null : { kind: 'prov', key: name }, `[data-rs-provi="${i}"]`);
      }
      return;
    }
    const gran = e.target.closest('[data-rs-gran]');
    if (gran) { ui.gran = gran.dataset.rsGran; if (ui.sel && ui.sel.kind === 'period') ui.sel = null; ui.page = 0; ui.open = null; rsRefreshMarket(`[data-rs-gran="${gran.dataset.rsGran}"]`); return; }
    if (e.target.closest('[data-rs-clear]')) { ui.sel = null; ui.page = 0; ui.open = null; rsRefreshMarket(); return; }
    const pg = e.target.closest('[data-rs-page]');
    if (pg) { ui.page += Number(pg.dataset.rsPage); ui.open = null; rsRefreshMarket(`[data-rs-page="${pg.dataset.rsPage}"]`); return; }
    const row = e.target.closest('[data-rs-row]');
    if (row) { const i = Number(row.dataset.rsRow); ui.open = ui.open === i ? null : i; rsRefreshMarket(`[data-rs-row="${i}"]`); return; }
  }

  const tab = e.target.closest('[data-rs-tab]');
  if (tab) {
    rs.tab = tab.dataset.rsTab;
    rsRenderBody();
    rsPanel.scrollTop = 0;
    const active = rsPanel.querySelector(`.rs-tab[data-rs-tab="${CSS.escape(rs.tab)}"]`);
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
});

rsPanel.addEventListener('change', (e) => {
  if (!e.target.matches('[data-rs-sort]')) return;
  const x = rsCurrentItem();
  if (!x) return;
  const ui = rsUi(x.id);
  ui.sort = e.target.value; ui.page = 0; ui.open = null;
  rsRefreshMarket('[data-rs-sort]');
});

// Flechas izquierda/derecha entre pestañas (patrón de teclado de role="tablist")
rsPanel.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const current = e.target.closest('.rs-tab');
  if (!current) return;
  const tabs = [...rsPanel.querySelectorAll('.rs-tab')];
  const next = tabs[(tabs.indexOf(current) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  if (next) { next.focus(); next.click(); e.preventDefault(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !rsPanel.classList.contains('hidden')) closeResumen();
});

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('cart-resumen-btn');
  if (btn) btn.addEventListener('click', openResumen);
});
