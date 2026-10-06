// Drag cards between columns; the new column value is saved with a PATCH.
(() => {
  for (const board of document.querySelectorAll('[data-kanban]')) {
    const url = board.dataset.url;
    const field = board.dataset.field;
    let dragged = null;
    let from = null;

    const recount = () => board.querySelectorAll('.k-col').forEach((col) => {
      const n = col.querySelector('[data-count]');
      if (n) n.textContent = col.querySelectorAll('.k-card').length;
    });

    board.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.k-card');
      if (!card) return;
      dragged = card;
      from = card.closest('.k-col');
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
    });
    board.addEventListener('dragend', () => {
      dragged?.classList.remove('dragging');
      board.querySelectorAll('.drop').forEach((c) => c.classList.remove('drop'));
      dragged = null;
    });
    board.addEventListener('dragover', (e) => {
      const col = e.target.closest('.k-col');
      if (!col || !dragged) return;
      e.preventDefault();
      board.querySelectorAll('.drop').forEach((c) => c !== col && c.classList.remove('drop'));
      col.classList.add('drop');
      const list = col.querySelector('.k-list');
      const after = [...list.querySelectorAll('.k-card:not(.dragging)')]
        .find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      list.insertBefore(dragged, after || null);
    });
    board.addEventListener('drop', async (e) => {
      const col = e.target.closest('.k-col');
      if (!col || !dragged) return;
      e.preventDefault();
      col.classList.remove('drop');
      const card = dragged;
      const source = from;
      recount();
      if (col === source) return;
      try {
        const res = await fetch(url.replace('{id}', card.dataset.id), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-atlas': '1' },
          body: JSON.stringify({ [field]: col.dataset.value }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
      } catch (err) {
        source.querySelector('.k-list').appendChild(card);
        recount();
        alert(`تعذّر الحفظ: ${err.message}`);
      }
    });
  }
})();
