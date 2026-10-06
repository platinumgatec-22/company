// Atlas canvas: notes, text, sections and tasks on an infinite board, with links between them.
(() => {
  const root = document.getElementById('cv');
  if (!root) return;
  const canvasId = root.dataset.id;
  const viewport = document.getElementById('cv-viewport');
  const world = document.getElementById('cv-world');
  const svg = document.getElementById('cv-links');
  const panel = document.getElementById('cv-panel');
  const zl = document.getElementById('cv-zl');
  const STATUS = window.ATLAS_STATUS || {};
  const NS = 'http://www.w3.org/2000/svg';
  const KIND = { note: 'note', text: 'text', task: 'task', section: 'section' };

  const items = new Map(); // id -> { data, el }
  let links = [];
  const view = { x: 120, y: 90, z: 1 };
  let tool = 'select';
  let selected = null;
  let linkFrom = null;
  let editing = null;

  // ---------- api ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-atlas': '1' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }
  const fail = (err) => alert(`تعذّر الحفظ: ${err.message}`);

  // ---------- view ----------
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    viewport.style.backgroundSize = `${24 * view.z}px ${24 * view.z}px`;
    zl.textContent = `${Math.round(view.z * 100)}%`;
  }
  function toWorld(clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.z, y: (clientY - r.top - view.y) / view.z };
  }
  function zoomAt(factor, clientX, clientY) {
    const r = viewport.getBoundingClientRect();
    const cx = clientX ?? r.left + r.width / 2;
    const cy = clientY ?? r.top + r.height / 2;
    const before = toWorld(cx, cy);
    view.z = Math.min(2.5, Math.max(0.2, view.z * factor));
    view.x = cx - r.left - before.x * view.z;
    view.y = cy - r.top - before.y * view.z;
    applyView();
  }
  function fit() {
    if (!items.size) return applyView();
    const r = viewport.getBoundingClientRect();
    let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
    for (const { data: d } of items.values()) {
      x1 = Math.min(x1, d.x); y1 = Math.min(y1, d.y); x2 = Math.max(x2, d.x + d.w); y2 = Math.max(y2, d.y + d.h);
    }
    const pad = 80;
    view.z = Math.min(1.2, Math.max(0.2, Math.min(r.width / (x2 - x1 + pad * 2), r.height / (y2 - y1 + pad * 2))));
    view.x = (r.width - (x2 - x1) * view.z) / 2 - x1 * view.z;
    view.y = (r.height - (y2 - y1) * view.z) / 2 - y1 * view.z;
    applyView();
  }

  // ---------- render ----------
  function render(d) {
    let entry = items.get(d.id);
    if (!entry) {
      const el = document.createElement('div');
      el.dataset.id = d.id;
      el.innerHTML = '<div class="cv-kind"></div><div class="cv-text"></div><div class="cv-meta"></div><div class="cv-resize"></div>';
      // Sections sit beneath everything else.
      if (d.kind === 'section') world.insertBefore(el, svg.nextSibling); else world.appendChild(el);
      entry = { el, data: d };
      items.set(d.id, entry);
    }
    entry.data = { ...entry.data, ...d };
    const x = entry.data;
    const el = entry.el;
    el.className = `cv-item k-${x.kind} c-${x.color}${x.task_status === 'done' ? ' done' : ''}${selected === x.id ? ' sel' : ''}${linkFrom === x.id ? ' link-from' : ''}`;
    Object.assign(el.style, { left: `${x.x}px`, top: `${x.y}px`, width: `${x.w}px`, height: `${x.h}px` });
    el.querySelector('.cv-kind').textContent = x.kind === 'task' ? `task · ${STATUS[x.task_status] || ''}` : KIND[x.kind];
    if (editing !== x.id) el.querySelector('.cv-text').textContent = x.text;
    const meta = el.querySelector('.cv-meta');
    meta.textContent = '';
    if (x.kind === 'task') {
      const who = document.createElement('span');
      who.textContent = x.task_owner || '';
      const due = document.createElement('span');
      due.textContent = x.task_due || '';
      meta.append(who, due);
    } else if (x.kind === 'note' && x.author) {
      meta.textContent = x.author;
    }
    if (selected === x.id) showPanel(x);
    drawLinks();
  }

  function drawLinks() {
    svg.replaceChildren();
    for (const l of links) {
      const a = items.get(l.from_id)?.data;
      const b = items.get(l.to_id)?.data;
      if (!a || !b) continue;
      const ax = a.x + a.w / 2; const ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2; const by = b.y + b.h / 2;
      const mx = (ax + bx) / 2;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M${ax},${ay} C${mx},${ay} ${mx},${by} ${bx},${by}`);
      p.dataset.link = l.id;
      svg.appendChild(p);
    }
  }

  // ---------- panel ----------
  function showPanel(d) {
    panel.classList.remove('hidden');
    panel.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === d.color));
    document.getElementById('cv-swatches').style.display = d.kind === 'task' ? 'none' : '';
    const t = document.getElementById('cv-task');
    t.replaceChildren();
    if (d.task_id) {
      const a = document.createElement('a');
      a.href = `/atlas/tasks/${d.task_id}`;
      a.textContent = `${STATUS[d.task_status] || 'مهمة'} · فتح المهمة ←`;
      t.appendChild(a);
    } else if (d.kind !== 'section') {
      const b = document.createElement('button');
      b.className = 'a-btn a-btn-sm';
      b.textContent = 'حوّلها إلى مهمة';
      b.onclick = async () => {
        try {
          const { item } = await api('POST', `/atlas/api/items/${d.id}/to-task`);
          await reload();
          select(item.id);
        } catch (err) { fail(err); }
      };
      t.appendChild(b);
    } else {
      t.innerHTML = '<span class="small dim">—</span>';
    }
    document.getElementById('cv-author').textContent = d.author || '—';
  }
  function select(id) {
    const prev = selected;
    selected = id;
    if (prev && items.has(prev)) render(items.get(prev).data);
    if (id && items.has(id)) render(items.get(id).data);
    else panel.classList.add('hidden');
  }

  panel.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-color]');
    if (sw && selected) {
      render({ id: selected, color: sw.dataset.color });
      api('PATCH', `/atlas/api/items/${selected}`, { color: sw.dataset.color }).catch(fail);
    }
  });
  document.getElementById('cv-edit').onclick = () => selected && startEdit(selected);
  document.getElementById('cv-delete').onclick = () => selected && removeItem(selected);

  // ---------- actions ----------
  async function create(kind, at) {
    const w = kind === 'section' ? 520 : kind === 'text' ? 260 : 220;
    const h = kind === 'section' ? 340 : kind === 'text' ? 60 : 140;
    try {
      const { item } = await api('POST', `/atlas/api/canvas/${canvasId}/items`, {
        kind, x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2),
        color: kind === 'section' || kind === 'text' ? 'slate' : 'teal',
      });
      if (kind === 'task') await reload(); else render(item);
      select(item.id);
      setTool('select');
      startEdit(item.id, true);
    } catch (err) { fail(err); }
  }

  async function removeItem(id) {
    const d = items.get(id)?.data;
    if (!d) return;
    if (d.text.trim() && !confirm('حذف هذا العنصر؟')) return;
    try {
      await api('DELETE', `/atlas/api/items/${id}`);
      items.get(id).el.remove();
      items.delete(id);
      links = links.filter((l) => l.from_id !== id && l.to_id !== id);
      if (selected === id) select(null);
      drawLinks();
    } catch (err) { fail(err); }
  }

  function startEdit(id, selectAll = false) {
    const entry = items.get(id);
    if (!entry) return;
    editing = id;
    const t = entry.el.querySelector('.cv-text');
    t.contentEditable = 'true';
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    if (!selectAll) range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const finish = async () => {
      t.removeEventListener('blur', finish);
      t.contentEditable = 'false';
      editing = null;
      const text = t.innerText.replace(/\n$/, '');
      if (text === entry.data.text) return;
      try {
        const { item } = await api('PATCH', `/atlas/api/items/${id}`, { text });
        render(item);
        if (item.task_id) reload();
      } catch (err) { fail(err); }
    };
    t.addEventListener('blur', finish);
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); t.blur(); }
    });
  }

  // ---------- pointer ----------
  let drag = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || editing) return;
    const itemEl = e.target.closest('.cv-item');
    const linkEl = e.target.closest('path[data-link]');
    const pt = toWorld(e.clientX, e.clientY);

    if (linkEl) {
      if (confirm('حذف هذا الرابط؟')) {
        const id = Number(linkEl.dataset.link);
        api('DELETE', `/atlas/api/links/${id}`).then(() => { links = links.filter((l) => l.id !== id); drawLinks(); }).catch(fail);
      }
      return;
    }

    if (!itemEl) {
      if (['note', 'text', 'task', 'section'].includes(tool)) return create(tool, pt);
      if (linkFrom) { const f = linkFrom; linkFrom = null; render(items.get(f).data); }
      select(null);
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      viewport.classList.add('panning');
      viewport.setPointerCapture(e.pointerId);
      return;
    }

    const id = Number(itemEl.dataset.id);
    const d = items.get(id).data;
    if (tool === 'erase') return removeItem(id);
    if (tool === 'connect') {
      if (!linkFrom) { linkFrom = id; render(d); return; }
      const from = linkFrom;
      linkFrom = null;
      render(items.get(from).data);
      if (from === id) return;
      api('POST', `/atlas/api/canvas/${canvasId}/links`, { from_id: from, to_id: id })
        .then(({ link }) => { if (!links.some((l) => l.id === link.id)) links.push(link); drawLinks(); }).catch(fail);
      return;
    }
    select(id);
    const resize = e.target.classList.contains('cv-resize');
    drag = { mode: resize ? 'resize' : 'move', id, sx: pt.x, sy: pt.y, ox: d.x, oy: d.y, ow: d.w, oh: d.h, moved: false };
    viewport.setPointerCapture(e.pointerId);
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.mode === 'pan') {
      view.x = drag.vx + (e.clientX - drag.sx);
      view.y = drag.vy + (e.clientY - drag.sy);
      return applyView();
    }
    const pt = toWorld(e.clientX, e.clientY);
    const dx = pt.x - drag.sx; const dy = pt.y - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (!drag.moved) return;
    // The resize grip sits on the inline-start (left in LTR, right in RTL) bottom corner.
    const rtl = getComputedStyle(root).direction === 'rtl';
    if (drag.mode === 'move') render({ id: drag.id, x: Math.round(drag.ox + dx), y: Math.round(drag.oy + dy) });
    else if (rtl) render({ id: drag.id, w: Math.max(80, Math.round(drag.ow + dx)), h: Math.max(50, Math.round(drag.oh + dy)) });
    else render({ id: drag.id, x: Math.round(drag.ox + Math.min(dx, drag.ow - 80)), w: Math.max(80, Math.round(drag.ow - dx)), h: Math.max(50, Math.round(drag.oh + dy)) });
  });

  const endDrag = () => {
    if (!drag) return;
    viewport.classList.remove('panning');
    if ((drag.mode === 'move' || drag.mode === 'resize') && drag.moved) {
      const { x, y, w, h } = items.get(drag.id).data;
      api('PATCH', `/atlas/api/items/${drag.id}`, { x, y, w, h }).catch(fail);
    }
    drag = null;
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  viewport.addEventListener('dblclick', (e) => {
    const itemEl = e.target.closest('.cv-item');
    if (itemEl) return startEdit(Number(itemEl.dataset.id));
    create('note', toWorld(e.clientX, e.clientY));
  });

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2 && !e.shiftKey) {
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    } else {
      view.x -= e.deltaX; view.y -= e.deltaY; applyView();
    }
  }, { passive: false });

  document.getElementById('cv-zin').onclick = () => zoomAt(1.2);
  document.getElementById('cv-zout').onclick = () => zoomAt(1 / 1.2);
  document.getElementById('cv-fit').onclick = fit;

  // ---------- tools ----------
  function setTool(t) {
    tool = t;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    viewport.style.cursor = t === 'select' ? '' : t === 'erase' ? 'not-allowed' : t === 'connect' ? 'alias' : 'crosshair';
    if (t !== 'connect' && linkFrom) { const f = linkFrom; linkFrom = null; render(items.get(f).data); }
  }
  document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  const KEYS = { v: 'select', n: 'note', t: 'text', k: 'task', f: 'section', c: 'connect', e: 'erase' };
  document.addEventListener('keydown', (e) => {
    if (editing || e.target.closest('input, textarea, select, [contenteditable=true]') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (KEYS[k]) { setTool(KEYS[k]); e.preventDefault(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { removeItem(selected); e.preventDefault(); }
    if (e.key === 'Enter' && selected) { startEdit(selected); e.preventDefault(); }
    if (e.key === 'Escape') { select(null); setTool('select'); }
  });

  // ---------- load ----------
  async function reload() {
    const json = await api('GET', `/atlas/api/canvas/${canvasId}`);
    const seen = new Set();
    for (const it of json.items) { seen.add(it.id); render(it); }
    for (const [id, entry] of items) if (!seen.has(id)) { entry.el.remove(); items.delete(id); }
    links = json.links;
    drawLinks();
    return json;
  }
  reload().then(fit).catch(fail);
  applyView();
})();
