/* ═══════════════════════════════════════════════════════════════
   admin.js — Panel de administrador (grupos, usuarios, tokens, módulos)
   Administra las mismas tablas de panel_admin que db-admin-panel, vía
   /api/admin/* (ver admin_service.py en el backend). Panel de baja
   frecuencia de uso -- cada acción refresca /api/admin/overview entero al
   terminar en vez de actualizar el DOM de forma optimista (correctitud por
   sobre latencia percibida, a diferencia del chat).
   ═══════════════════════════════════════════════════════════════ */

let _adminData = { sections: [], users: [], groups: [], group_members: {} };

// ── Tabs ──────────────────────────────────────────────────────────
function switchAdminTab(tab) {
  ['users', 'groups', 'sections'].forEach(t => {
    document.getElementById(`admin-tab-${t}`)?.classList.toggle('hidden', t !== tab);
    const btn = document.getElementById(`admin-tabbtn-${t}`);
    if (!btn) return;
    const active = t === tab;
    btn.className = `px-4 py-2.5 text-[13px] font-semibold border-b-2 cursor-pointer transition-colors ${
      active ? 'text-brand-700 border-brand-600' : 'text-slate-500 border-transparent hover:text-slate-700'
    }`;
  });
}

// ── Carga y errores ───────────────────────────────────────────────
function _adminShowError(msg) {
  const el = document.getElementById('admin-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function _adminClearError() {
  document.getElementById('admin-error')?.classList.add('hidden');
}

async function _adminFetch(url, options) {
  _adminClearError();
  try {
    const resp = await apiFetch(url, {
      ...options,
      headers: { ..._headers(), ...(options && options.headers) },
    });
    if (!resp) return null;
    if (!resp.ok) {
      let detail = `Error ${resp.status}`;
      try { detail = (await resp.json()).detail || detail; } catch (e) {}
      _adminShowError(detail);
      return null;
    }
    return resp.status === 204 ? {} : await resp.json();
  } catch (e) {
    _adminShowError('Error de conexión.');
    return null;
  }
}

async function loadAdminOverview() {
  const data = await _adminFetch('/api/admin/overview');
  if (!data) return;
  _adminData = data;
  renderAdminUsers();
  renderAdminGroups();
  renderAdminSections();
}

// ── Formato del tope diario (convención: null=default, 0=ilimitado, N=propio) ──
function _limitLabel(limit) {
  if (limit === null || limit === undefined) return '<span class="text-slate-400 italic">default</span>';
  if (limit === 0) return '<span class="text-emerald-600 font-medium">Ilimitado</span>';
  return `${limit.toLocaleString('es-CL')}`;
}

function _limitEditorHtml(idPrefix, limit) {
  const unlimited = limit === 0;
  const value = (limit === null || limit === undefined || unlimited) ? '' : limit;
  return `
    <div class="flex items-center gap-1.5">
      <input type="number" min="0" placeholder="default" value="${value}"
             id="${idPrefix}-limit-input" ${unlimited ? 'disabled' : ''}
             class="w-20 px-2 py-1 text-[12.5px] border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-400 disabled:bg-slate-50 disabled:text-slate-400">
      <label class="flex items-center gap-1 text-[11px] text-slate-400 cursor-pointer whitespace-nowrap">
        <input type="checkbox" id="${idPrefix}-limit-unlimited" class="rounded" ${unlimited ? 'checked' : ''}
               onchange="document.getElementById('${idPrefix}-limit-input').disabled = this.checked">
        Ilimitado
      </label>
      <button type="button" class="text-[11px] font-semibold text-brand-600 hover:text-brand-700 cursor-pointer"
              onclick="${idPrefix.startsWith('admin-user') ? `adminSaveUserLimit(${idPrefix.split('-').pop()})` : `adminSaveGroupLimit(${idPrefix.split('-').pop()})`}">
        Guardar
      </button>
    </div>`;
}

// ── Usuarios ──────────────────────────────────────────────────────
function renderAdminUsers() {
  const tbody = document.getElementById('admin-users-tbody');
  if (!tbody) return;
  if (!_adminData.users.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="px-4 py-6 text-center text-[12.5px] text-slate-400">Sin usuarios todavía.</td></tr>`;
    return;
  }
  tbody.innerHTML = _adminData.users.map(u => {
    const sectionsHtml = _adminData.sections.map(s => `
      <label class="inline-flex items-center gap-1 text-[11.5px] text-slate-500 mr-2.5 cursor-pointer">
        <input type="checkbox" class="rounded" ${u.section_ids.includes(s.id) ? 'checked' : ''}
               onchange="adminToggleUserSection(${u.id}, ${s.id}, this.checked)">
        ${escapeHtml(s.nombre)}
      </label>`).join('');
    const usagePct = u.daily_token_limit ? Math.min(Math.round((u.tokens_used_today / u.daily_token_limit) * 100), 100) : null;
    const usageHtml = u.daily_token_limit === 0
      ? '<span class="text-slate-400">—</span>'
      : `<div class="flex items-center gap-1.5">
           <div class="w-14 h-1.5 bg-slate-100 rounded-full overflow-hidden flex-shrink-0">
             <div class="h-full ${usagePct >= 100 ? 'bg-red-500' : usagePct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}" style="width:${usagePct ?? 0}%"></div>
           </div>
           <span class="text-[11px] text-slate-400">${u.tokens_used_today.toLocaleString('es-CL')}</span>
         </div>`;
    return `
      <tr class="border-b border-slate-50 last:border-0 align-top">
        <td class="px-4 py-3 font-medium text-slate-700">${escapeHtml(u.email)}</td>
        <td class="px-4 py-3 text-slate-500">${u.group_nombre ? escapeHtml(u.group_nombre) : '<span class="text-slate-300">—</span>'}</td>
        <td class="px-4 py-3" id="admin-user-${u.id}-limit-cell">${_limitEditorHtml(`admin-user-${u.id}`, u.daily_token_limit)}</td>
        <td class="px-4 py-3">${usageHtml}</td>
        <td class="px-4 py-3">${sectionsHtml || '<span class="text-slate-300">—</span>'}</td>
        <td class="px-4 py-3 text-right">
          <button onclick="adminRemoveUser(${u.id}, '${escapeHtml(u.email)}')" title="Eliminar acceso"
                  class="w-7 h-7 inline-flex items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600 cursor-pointer">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </td>
      </tr>`;
  }).join('');
}

async function adminSubmitAddUser(e) {
  e.preventDefault();
  const email = document.getElementById('admin-new-user-email').value.trim();
  const limit = document.getElementById('admin-new-user-limit').value;
  const unlimited = document.getElementById('admin-new-user-unlimited').checked;
  const result = await _adminFetch('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, daily_token_limit: limit || null, unlimited }),
  });
  if (result) {
    document.getElementById('admin-add-user-form').reset();
    await loadAdminOverview();
  }
  return false;
}

async function adminSaveUserLimit(userId) {
  const input = document.getElementById(`admin-user-${userId}-limit-input`);
  const unlimited = document.getElementById(`admin-user-${userId}-limit-unlimited`).checked;
  const result = await _adminFetch(`/api/admin/users/${userId}/limit`, {
    method: 'POST',
    body: JSON.stringify({ daily_token_limit: input.value || null, unlimited }),
  });
  if (result) await loadAdminOverview();
}

async function adminToggleUserSection(userId, sectionId, enabled) {
  const result = await _adminFetch(`/api/admin/users/${userId}/sections/${sectionId}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
  if (result) await loadAdminOverview();
}

async function adminRemoveUser(userId, email) {
  if (!confirm(`¿Eliminar el acceso de "${email}"? Ya no podrá entrar a la aplicación.`)) return;
  const result = await _adminFetch(`/api/admin/users/${userId}/delete`, { method: 'POST' });
  if (result) await loadAdminOverview();
}

// ── Grupos ────────────────────────────────────────────────────────
function renderAdminGroups() {
  const container = document.getElementById('admin-groups-list');
  if (!container) return;
  if (!_adminData.groups.length) {
    container.innerHTML = `<p class="text-center text-[12.5px] text-slate-400 py-6">Sin grupos todavía.</p>`;
    return;
  }
  container.innerHTML = _adminData.groups.map(g => {
    const isAdminsGroup = g.nombre === 'Admins';
    const members = _adminData.group_members[g.id] || [];
    const chipsHtml = _adminData.sections.map(s => {
      const active = g.section_ids.includes(s.id);
      return `<button type="button" onclick="adminToggleGroupSection(${g.id}, ${s.id}, ${!active})"
                class="px-2.5 py-1 rounded-full text-[11.5px] font-medium border cursor-pointer transition-colors ${
                  active ? 'bg-brand-600 border-brand-600 text-white' : 'bg-white border-slate-300 text-slate-500 hover:border-brand-400'
                }">${escapeHtml(s.nombre)}</button>`;
    }).join('');
    const membersHtml = members.length
      ? members.map(m => `
          <div class="flex items-center justify-between gap-2 py-1">
            <span class="text-[12.5px] text-slate-600">${escapeHtml(m.email)}</span>
            <button onclick="adminRemoveGroupMember(${g.id}, ${m.id}, '${escapeHtml(m.email)}')"
                    class="text-[11px] text-slate-400 hover:text-rose-600 cursor-pointer">Quitar</button>
          </div>`).join('')
      : '<p class="text-[12px] text-slate-400">Sin miembros.</p>';

    return `
      <div class="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
        <div class="flex items-start justify-between gap-3 mb-3">
          <div>
            <p class="text-[14px] font-semibold text-slate-800">${escapeHtml(g.nombre)} <span class="text-[11px] font-normal text-slate-400">(${g.n_miembros} miembro${g.n_miembros === 1 ? '' : 's'})</span></p>
          </div>
          ${isAdminsGroup
            ? '<span title="El grupo Admins no se puede eliminar desde acá (evita perder acceso al panel por accidente)." class="text-[11px] text-slate-300">protegido</span>'
            : `<button onclick="adminDeleteGroup(${g.id}, '${escapeHtml(g.nombre)}')" class="text-[11px] text-slate-400 hover:text-rose-600 cursor-pointer">Eliminar grupo</button>`}
        </div>

        <div class="flex flex-wrap items-center gap-3 mb-3">
          <div id="admin-group-${g.id}-limit-cell">${_limitEditorHtml(`admin-group-${g.id}`, g.daily_token_limit)}</div>
        </div>

        <div class="flex flex-wrap gap-1.5 mb-3">${chipsHtml}</div>

        <div class="border-t border-slate-100 pt-3">
          <div class="max-h-32 overflow-y-auto mb-2">${membersHtml}</div>
          <form onsubmit="return adminSubmitAddGroupMembers(event, ${g.id})" class="flex items-start gap-2">
            <textarea id="admin-group-${g.id}-emails" rows="1" placeholder="Pega uno o varios correos (separados por coma, espacio o salto de línea)"
                      class="flex-1 px-2.5 py-1.5 text-[12.5px] border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-400 resize-none"></textarea>
            <button type="submit" class="px-3 py-1.5 text-[12px] font-semibold text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg cursor-pointer whitespace-nowrap">
              + Agregar
            </button>
          </form>
        </div>
      </div>`;
  }).join('');
}

async function adminSubmitAddGroup(e) {
  e.preventDefault();
  const nombre = document.getElementById('admin-new-group-name').value.trim();
  const limit = document.getElementById('admin-new-group-limit').value;
  const unlimited = document.getElementById('admin-new-group-unlimited').checked;
  const result = await _adminFetch('/api/admin/groups', {
    method: 'POST',
    body: JSON.stringify({ nombre, daily_token_limit: limit || null, unlimited }),
  });
  if (result) {
    document.getElementById('admin-add-group-form').reset();
    await loadAdminOverview();
  }
  return false;
}

async function adminSaveGroupLimit(groupId) {
  const input = document.getElementById(`admin-group-${groupId}-limit-input`);
  const unlimited = document.getElementById(`admin-group-${groupId}-limit-unlimited`).checked;
  const result = await _adminFetch(`/api/admin/groups/${groupId}/limit`, {
    method: 'POST',
    body: JSON.stringify({ daily_token_limit: input.value || null, unlimited }),
  });
  if (result) await loadAdminOverview();
}

async function adminToggleGroupSection(groupId, sectionId, enabled) {
  const result = await _adminFetch(`/api/admin/groups/${groupId}/sections/${sectionId}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
  if (result) await loadAdminOverview();
}

async function adminSubmitAddGroupMembers(e, groupId) {
  e.preventDefault();
  const textarea = document.getElementById(`admin-group-${groupId}-emails`);
  const emails = textarea.value.trim();
  if (!emails) return false;
  const result = await _adminFetch(`/api/admin/groups/${groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ emails }),
  });
  if (result) await loadAdminOverview();
  return false;
}

async function adminRemoveGroupMember(groupId, userId, email) {
  if (!confirm(`¿Quitar a "${email}" del grupo? Conserva el acceso/módulos que tenía, ahora sueltos.`)) return;
  const result = await _adminFetch(`/api/admin/groups/${groupId}/members/${userId}/remove`, { method: 'POST' });
  if (result) await loadAdminOverview();
}

async function adminDeleteGroup(groupId, nombre) {
  if (!confirm(`¿Eliminar el grupo "${nombre}"? Sus miembros conservan el acceso que tenían, ahora sueltos.`)) return;
  const result = await _adminFetch(`/api/admin/groups/${groupId}/delete`, { method: 'POST' });
  if (result) await loadAdminOverview();
}

// ── Módulos (secciones) ──────────────────────────────────────────
function renderAdminSections() {
  const container = document.getElementById('admin-sections-list');
  if (!container) return;
  if (!_adminData.sections.length) {
    container.innerHTML = `<p class="text-center text-[12.5px] text-slate-400 py-6">Sin módulos todavía.</p>`;
    return;
  }
  container.innerHTML = _adminData.sections.map(s => `
    <div class="flex items-center justify-between px-4 py-3">
      <div>
        <p class="text-[13px] font-medium text-slate-700">${escapeHtml(s.nombre)}</p>
        <p class="text-[11px] text-slate-400">${escapeHtml(s.slug)}</p>
      </div>
      <button onclick="adminDeleteSection(${s.id}, '${escapeHtml(s.nombre)}')" class="text-[11px] text-slate-400 hover:text-rose-600 cursor-pointer">Eliminar</button>
    </div>`).join('');
}

async function adminSubmitAddSection(e) {
  e.preventDefault();
  const slug = document.getElementById('admin-new-section-slug').value.trim();
  const nombre = document.getElementById('admin-new-section-nombre').value.trim();
  const result = await _adminFetch('/api/admin/sections', {
    method: 'POST',
    body: JSON.stringify({ slug, nombre }),
  });
  if (result) {
    document.getElementById('admin-add-section-form').reset();
    await loadAdminOverview();
  }
  return false;
}

async function adminDeleteSection(sectionId, nombre) {
  if (!confirm(`¿Eliminar el módulo "${nombre}"? Se quita el acceso a ese módulo de todos los usuarios/grupos que lo tenían.`)) return;
  const result = await _adminFetch(`/api/admin/sections/${sectionId}/delete`, { method: 'POST' });
  if (result) await loadAdminOverview();
}

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  switchAdminTab('users');
  loadAdminOverview();
});
