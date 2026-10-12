// WhatsApp simulator: the admin writes as the customer, the server answers as the digital employee.
(() => {
  const root = document.querySelector('[data-sim]');
  if (!root) return;
  const chat = root.querySelector('[data-chat]');
  const form = root.querySelector('[data-form]');
  const input = form.querySelector('[name=text]');
  const name = form.querySelector('[name=name]').value;
  const stepsEl = root.querySelector('[data-steps]');
  const stepsEmpty = root.querySelector('[data-steps-empty]');
  const autoBtn = document.querySelector('[data-autoplay]');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
  let shown = stepsEl.children.length;
  let busy = false;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const time = () => new Date().toTimeString().slice(0, 5);

  function bubble(text, mine, who) {
    root.querySelector('[data-empty]')?.remove();
    const el = document.createElement('div');
    el.className = `bubble ${mine ? 'out' : 'in'}`;
    el.innerHTML = `${esc(text)}<span class="meta">${esc(who)} · ${time()}</span>`;
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function addSteps(steps) {
    for (const s of steps.slice(shown)) {
      const li = document.createElement('li');
      li.className = 'sim-step' + (s.icon === '🧾' ? ' sim-done' : '');
      li.innerHTML = `<span class="ic" aria-hidden="true">${esc(s.icon)}</span><div><strong>${esc(s.title)}</strong>`
        + `<div class="small muted">${esc(s.detail || '')}</div><div class="meta"><span class="chip">${esc(s.section)}</span>`
        + `<span>${esc(s.by)}</span>${s.link ? `<a class="go" href="${esc(s.link)}">فتح ↗</a>` : ''}</div></div>`;
      stepsEl.appendChild(li);
    }
    shown = steps.length;
    stepsEmpty.hidden = shown > 0;
  }

  async function send(text) {
    if (busy || !text.trim()) return;
    busy = true;
    bubble(text, true, 'أنت');
    const typing = document.createElement('div');
    typing.className = 'sim-typing';
    typing.textContent = 'يكتب…';
    chat.appendChild(typing);
    chat.scrollTop = chat.scrollHeight;
    try {
      const res = await fetch('/atlas/simulator/message', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Atlas': '1' },
        body: JSON.stringify({ text, name }),
      });
      const data = await res.json();
      await wait(600);
      typing.remove();
      if (!res.ok) throw new Error(data.error || 'تعذّر الإرسال');
      for (const r of data.replies) { bubble(r, false, data.agent); await wait(350); }
      addSteps(data.steps || []);
    } catch (err) {
      typing.remove();
      bubble(`⚠️ ${err.message}`, false, 'النظام');
    }
    busy = false;
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); const t = input.value; input.value = ''; send(t); input.focus(); });
  root.querySelectorAll('[data-quick] button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));

  document.querySelector('[data-reset]')?.addEventListener('click', async () => {
    await fetch('/atlas/simulator/reset', { method: 'POST', credentials: 'same-origin', headers: { 'X-Atlas': '1' } });
    location.reload();
  });

  // The whole story: greeting → tournament → team → captain → confirm → invoice.
  autoBtn?.addEventListener('click', async () => {
    autoBtn.disabled = true;
    const script = ['السلام عليكم، أبي أسجل فريقي في بطولة', '1', root.dataset.team, root.dataset.name, 'نعم'];
    for (const line of script) {
      input.value = line;
      await wait(900);
      input.value = '';
      await send(line);
      await wait(700);
    }
    autoBtn.disabled = false;
  });
})();
