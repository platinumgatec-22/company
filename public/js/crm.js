// Sales CRM: animated numbers, drag-and-drop pipeline, and deal form helpers.
(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const money = (v) => {
    if (Math.abs(v) >= 1e6) return `${+(v / 1e6).toFixed(2)}M`;
    if (Math.abs(v) >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
    return String(Math.round(v));
  };
  const full = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 3 });

  // Count a number up from 0 (or from its previous value) to `to`.
  function countTo(el, to, format = full, from = 0) {
    if (reduceMotion) { el.textContent = format(to); return; }
    const start = performance.now();
    const dur = 700;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = format(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  document.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count);
    countTo(el, to, Number.isInteger(to) ? (v) => full(Math.round(v)) : full);
  });

  // ---------- pipeline board ----------
  const board = document.querySelector('[data-board]');
  if (board) {
    const base = board.dataset.base || '';
    const toast = document.querySelector('[data-toast]');
    const openStages = ['lead', 'contacted', 'proposal', 'negotiation'];
    let toastTimer;
    let dragged = null;

    const showToast = (text, isError) => {
      toast.textContent = text;
      toast.classList.toggle('error', !!isError);
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
    };

    const flash = (el) => {
      el.classList.add('flash-num');
      setTimeout(() => el.classList.remove('flash-num'), 700);
    };

    // Recompute every column total and the open-pipeline total from the cards on the board.
    function refreshTotals() {
      let openValue = 0;
      let openCount = 0;
      board.querySelectorAll('.column').forEach((col) => {
        const cards = [...col.querySelectorAll('.deal-card')];
        const value = cards.reduce((s, c) => s + Number(c.dataset.value), 0);
        const sumEl = col.querySelector('[data-sum-col]');
        const countEl = col.querySelector('[data-count-col]');
        const prev = Number(sumEl.dataset.raw ?? value);
        if (prev !== value) { countTo(sumEl, value, money, prev); flash(sumEl); }
        sumEl.dataset.raw = value;
        countEl.textContent = cards.length;
        if (openStages.includes(col.dataset.stage)) { openValue += value; openCount += cards.length; }
      });
      const totalEl = document.querySelector('[data-open-total]');
      const prevTotal = Number(totalEl.dataset.raw ?? openValue);
      if (prevTotal !== openValue) { countTo(totalEl, openValue, full, prevTotal); flash(totalEl); }
      totalEl.dataset.raw = openValue;
      document.querySelector('[data-open-count]').textContent = openCount;
    }

    function placeCard(card, column) {
      const zone = column.querySelector('[data-dropzone]');
      zone.insertBefore(card, zone.querySelector('.column-add, .drop-hint'));
    }

    async function move(card, column) {
      const fromColumn = card.closest('.column');
      if (fromColumn === column) return;
      const stage = column.dataset.stage;
      const prob = card.querySelector('[data-prob]');
      const bar = card.querySelector('.prob span');
      const before = { prob: prob.textContent, width: bar.style.getPropertyValue('--w') };

      placeCard(card, column);
      prob.textContent = `${column.dataset.probability}% احتمال`;
      bar.style.setProperty('--w', `${column.dataset.probability}%`);
      card.classList.remove('landed');
      void card.offsetWidth;
      card.classList.add('landed');
      refreshTotals();

      try {
        const res = await fetch(`${base}/crm/deals/${card.dataset.id}/stage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ stage }),
          credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'تعذّر حفظ التغيير.');
        const title = card.querySelector('.deal-card-title a').textContent;
        showToast(stage === 'won' ? `🎉 تم الفوز: ${title}` : `نُقلت إلى «${column.querySelector('h2').textContent}»`);
      } catch (err) {
        placeCard(card, fromColumn);
        prob.textContent = before.prob;
        bar.style.setProperty('--w', before.width);
        refreshTotals();
        showToast(err.message, true);
      }
    }

    refreshTotals();

    board.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.deal-card[draggable="true"]');
      if (!card) return;
      dragged = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
    });
    board.addEventListener('dragend', () => {
      if (dragged) dragged.classList.remove('dragging');
      board.querySelectorAll('.drag-over').forEach((c) => c.classList.remove('drag-over'));
      dragged = null;
    });
    board.addEventListener('dragover', (e) => {
      const column = e.target.closest('.column');
      if (!dragged || !column) return;
      e.preventDefault();
      board.querySelectorAll('.drag-over').forEach((c) => c !== column && c.classList.remove('drag-over'));
      column.classList.add('drag-over');
    });
    board.addEventListener('drop', (e) => {
      const column = e.target.closest('.column');
      if (!dragged || !column) return;
      e.preventDefault();
      column.classList.remove('drag-over');
      move(dragged, column);
    });

    // Keyboard: focus a card and use the arrow keys to move it between stages (RTL: left = next).
    board.addEventListener('keydown', (e) => {
      const card = e.target.closest('.deal-card[draggable="true"]');
      if (!card || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const columns = [...board.querySelectorAll('.column')];
      const i = columns.indexOf(card.closest('.column')) + (e.key === 'ArrowLeft' ? 1 : -1);
      if (columns[i]) move(card, columns[i]).then(() => card.focus());
    });
  }

  // ---------- deal form ----------
  const form = document.querySelector('[data-deal-form]');
  if (form) {
    const contact = form.querySelector('[data-contact-select]');
    const stage = form.querySelector('[data-stage-select]');
    const probability = form.querySelector('[data-probability]');
    const sync = () => {
      form.querySelectorAll('[data-new-contact]').forEach((el) => { el.hidden = contact.value !== ''; });
      form.querySelector('[data-lost-reason]').hidden = stage.value !== 'lost';
    };
    contact.addEventListener('change', sync);
    stage.addEventListener('change', () => {
      probability.value = stage.selectedOptions[0].dataset.probability;
      sync();
    });
    sync();
  }
})();
