// Chat with The Strategist without leaving the page.
(() => {
  const form = document.getElementById('strat-form');
  if (!form) return;
  const text = document.getElementById('strat-text');
  const btn = document.getElementById('strat-btn');
  const body = document.getElementById('strat-body');
  const proposals = document.getElementById('proposals');
  const me = document.querySelector('.a-me-name')?.textContent || 'You';

  const add = (role, content, extra = '') => {
    const el = document.createElement('div');
    el.className = `msg ${role} ${extra}`;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = role === 'user' ? me : 'The Strategist';
    const b = document.createElement('div');
    b.className = 'body';
    b.textContent = content;
    el.append(who, b);
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  };

  const LABEL = { pending: 'بانتظارك', approved: 'نُفّذ', declined: 'مرفوض', failed: 'فشل' };
  const CLS = { pending: 'mauve', approved: 'green', declined: '', failed: 'red' };
  function renderProposals(list) {
    proposals.replaceChildren();
    if (!list.length) {
      proposals.innerHTML = '<div class="a-empty small">لا توجد اقتراحات بعد.</div>';
      return;
    }
    for (const p of list) {
      const card = document.createElement('div');
      card.className = `proposal ${p.status}`;
      const head = document.createElement('div');
      head.className = 'a-actions';
      head.style.justifyContent = 'space-between';
      const chip = document.createElement('span');
      chip.className = `chip ${CLS[p.status]}`;
      chip.textContent = LABEL[p.status];
      const time = document.createElement('span');
      time.className = 'small dim mono';
      time.textContent = p.created_at.slice(5, 16);
      head.append(chip, time);
      const s = document.createElement('div');
      s.className = 's';
      s.textContent = p.summary;
      card.append(head, s);
      if (p.status === 'pending') {
        const f = document.createElement('form');
        f.method = 'post';
        f.action = `/atlas/strategist/proposals/${p.id}`;
        f.className = 'a-actions';
        f.innerHTML = '<button class="a-btn a-btn-sm a-btn-solid" name="decision" value="approve">موافق</button>'
          + '<button class="a-btn a-btn-sm a-btn-ghost" name="decision" value="decline">لا</button>';
        card.appendChild(f);
      }
      proposals.appendChild(card);
    }
  }

  async function send(message) {
    if (!message.trim() || btn.disabled) return;
    add('user', message);
    text.value = '';
    btn.disabled = true;
    const wait = add('agent', 'يقرأ الشركة', 'thinking');
    try {
      const res = await fetch('/atlas/api/strategist', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atlas': '1' },
        body: JSON.stringify({ text: message }),
      });
      const json = await res.json().catch(() => ({}));
      wait.remove();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      add('agent', json.reply || '(لا يوجد رد نصي — راجع الاقتراحات)');
      if (json.proposals) renderProposals(json.proposals);
    } catch (err) {
      wait.remove();
      add('agent', `تعذّر الوصول للمستشار: ${err.message}`);
    } finally {
      btn.disabled = false;
      text.focus();
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); send(text.value); });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(text.value); }
  });
  document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => send(b.dataset.q)));
  body.scrollTop = body.scrollHeight;
})();
