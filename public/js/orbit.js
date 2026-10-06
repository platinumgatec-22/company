// Atlas home: lays the modules on an orbit around the company planet and animates the sky.
(() => {
  const orbit = document.getElementById('orbit');
  if (!orbit) return;
  const canvas = document.getElementById('orbit-canvas');
  const ring = document.getElementById('orbit-ring');
  const core = document.getElementById('orbit-core');
  const nodes = [...orbit.querySelectorAll('.orbit-node')];
  const ctx = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const NS = 'http://www.w3.org/2000/svg';
  let W = 0; let H = 0; let R = 0; let dpr = 1;
  let stars = []; let inner = [];

  const rand = (a, b) => a + Math.random() * (b - a);

  function layout() {
    const rect = orbit.getBoundingClientRect();
    const flat = rect.width < 640;
    orbit.classList.toggle('flat', flat);
    if (flat) return false;
    W = rect.width; H = rect.height;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = Math.min(W, H) * 0.2;
    core.style.setProperty('--core', `${R * 2}px`);

    const cx = W / 2; const cy = H / 2;
    const rx = Math.min(W * 0.42, W / 2 - 70); const ry = H / 2 - 70;
    ring.setAttribute('viewBox', `0 0 ${W} ${H}`);
    ring.innerHTML = '';
    const ell = (rxx, ryy, cls) => {
      const e = document.createElementNS(NS, 'ellipse');
      e.setAttribute('cx', cx); e.setAttribute('cy', cy); e.setAttribute('rx', rxx); e.setAttribute('ry', ryy);
      if (cls) e.setAttribute('class', cls);
      ring.appendChild(e);
    };
    ell(rx, ry, 'dash');
    ell(R * 1.45, R * 1.45);
    nodes.forEach((node, i) => {
      const a = -Math.PI / 2 + (i / nodes.length) * Math.PI * 2;
      const x = cx + Math.cos(a) * rx; const y = cy + Math.sin(a) * ry;
      node.style.left = `${x}px`; node.style.top = `${y}px`;
      const line = document.createElementNS(NS, 'line');
      const k = (R * 1.45) / Math.hypot(x - cx, y - cy);
      line.setAttribute('x1', cx + (x - cx) * k); line.setAttribute('y1', cy + (y - cy) * k);
      line.setAttribute('x2', x); line.setAttribute('y2', y);
      ring.appendChild(line);
      node.onmouseenter = () => line.classList.add('hot');
      node.onmouseleave = () => line.classList.remove('hot');
    });

    stars = Array.from({ length: Math.round((W * H) / 2600) }, () => ({ x: rand(0, W), y: rand(0, H), r: rand(0.3, 1.3), p: rand(0, 6.28), s: rand(0.4, 1.4) }));
    inner = Array.from({ length: 140 }, () => ({ u: rand(-1, 1), v: rand(-1, 1), r: rand(0.4, 1.6), c: Math.random() < 0.25 ? '#5eead4' : '#e6eef6' }));
    return true;
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2; const cy = H / 2;
    for (const s of stars) {
      const a = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t / 1000 * s.s + s.p));
      ctx.fillStyle = `rgba(220,235,255,${a})`;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283); ctx.fill();
    }
    // glow
    const glow = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.8);
    glow.addColorStop(0, 'rgba(94,234,212,.16)'); glow.addColorStop(1, 'rgba(94,234,212,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R * 1.8, 0, 6.283); ctx.fill();
    // planet body
    const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    body.addColorStop(0, '#1b2738'); body.addColorStop(0.7, '#0a111c'); body.addColorStop(1, '#05080e');
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.fill();
    // rotating star field inside the planet
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R - 2, 0, 6.283); ctx.clip();
    const shift = (t / 40000) % 2;
    for (const s of inner) {
      let u = s.u + shift; if (u > 1) u -= 2;
      const depth = Math.sqrt(Math.max(0, 1 - u * u));
      const x = cx + u * R; const y = cy + s.v * R * 0.95;
      ctx.globalAlpha = 0.2 + 0.8 * depth;
      ctx.fillStyle = s.c; ctx.beginPath(); ctx.arc(x, y, s.r * (0.6 + depth * 0.6), 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.restore();
    // chromatic rim
    ctx.lineWidth = 2;
    [['rgba(192,132,252,.75)', -2.5], ['rgba(94,234,212,.9)', 2.5], ['rgba(240,250,255,.95)', 0]].forEach(([c, o]) => {
      ctx.strokeStyle = c; ctx.beginPath(); ctx.arc(cx + o, cy, R, Math.PI * 0.55, Math.PI * 1.85); ctx.stroke();
    });
    ctx.strokeStyle = 'rgba(94,234,212,.35)'; ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI * 1.85, Math.PI * 2.55); ctx.stroke();
    // tick ring
    const ticks = 120; const rot = t / 30000;
    ctx.strokeStyle = 'rgba(167,243,208,.45)'; ctx.lineWidth = 1;
    for (let i = 0; i < ticks; i++) {
      const a = rot + (i / ticks) * 6.283;
      const len = i % 10 === 0 ? 9 : 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (R + 10), cy + Math.sin(a) * (R + 10));
      ctx.lineTo(cx + Math.cos(a) * (R + 10 + len), cy + Math.sin(a) * (R + 10 + len));
      ctx.stroke();
    }
    // wordmark
    ctx.fillStyle = 'rgba(230,238,246,.9)';
    ctx.font = `800 ${Math.max(14, R * 0.16)}px Unbounded, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('ATLAS', cx, cy);
  }

  let raf = 0;
  function loop(t) { draw(t); raf = requestAnimationFrame(loop); }
  function start() {
    cancelAnimationFrame(raf);
    if (!layout()) return;
    if (reduce) draw(0); else raf = requestAnimationFrame(loop);
  }
  let timer;
  addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(start, 120); });
  document.addEventListener('visibilitychange', () => (document.hidden ? cancelAnimationFrame(raf) : start()));
  (document.fonts?.ready || Promise.resolve()).then(start);
  start();
})();
