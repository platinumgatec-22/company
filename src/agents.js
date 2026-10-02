// Digital employees: whenever a request reaches a step owned by an employee marked is_digital,
// the system does that step for them.
//   director  → reviews the request and forwards it to the manager with a note (written by Claude)
//   manager   → sends it to the design group for all publishers, and later writes and sends the report
//   designer  → writes the caption; gets the design from the design service (webhook + callback),
//               or produces a simple branded design (SVG) when no webhook is configured
//   publisher → hands the post to Buffer through the webhook; the callback confirms it was published
const express = require('express');
const db = require('./db');
const core = require('./workflow-core');
const ai = require('./ai');
const { notify, webhookEnabled } = require('./notify');

const { q, ROLES, StepError } = core;
const COMPANY_NAME = process.env.COMPANY_NAME || 'شركتنا';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL
  || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/+$/, '');
const CALLBACK_TOKEN = process.env.WORKFLOW_CALLBACK_TOKEN || '';

const digital = (role) => {
  const e = q.roleHolder.get(role);
  return e && e.is_digital ? e : null;
};

const system = (e) => `أنت ${e.full_name}، ${ROLES[e.workflow_role]} (موظف رقمي) في فريق النشر على إنستقرام في ${COMPANY_NAME}.
تكتب بالعربية بإيجاز ووضوح ومهنية. اكتب النص المطلوب فقط، دون مقدمات أو عناوين أو علامات تنسيق.`;

const describe = (r) => `عنوان الطلب: ${r.title}\nالتفاصيل: ${r.brief || '—'}\nموعد النشر: ${r.due_date || 'غير محدد'}`;

// ---------- one step per role ----------

async function directorStep(r) {
  const director = digital('director');
  if (!director) return;
  const note = await ai.write({
    system: system(director),
    prompt: `وصلك طلب النشر التالي. اكتب ملاحظة قصيرة (سطرين كحد أقصى) للمانجير ${core.holderName('manager')} عند تحويله لها: الأولوية وأهم نقطة يجب الانتباه لها.\n\n${describe(r)}`,
    fallback: `تمت مراجعة الطلب، يرجى التنفيذ${r.due_date ? ` قبل ${r.due_date}` : ' في أقرب وقت'}.`,
  });
  return () => core.forward(r, director, note);
}

async function managerSendStep(r) {
  const manager = digital('manager');
  if (!manager) return;
  const publishers = q.publishers.all();
  if (publishers.length === 0) return;
  const note = await ai.write({
    system: system(manager),
    prompt: `حوّل هذا الطلب إلى قروب النخبة للتصاميم. اكتب تعليمات قصيرة للمصممين (3 أسطر كحد أقصى): الفكرة، المقاس (منشور إنستقرام مربع 1080×1080)، وأي ملاحظة مهمة.\n\n${describe(r)}`,
    fallback: 'منشور إنستقرام مربع 1080×1080 بهوية الشركة، نص واضح ومختصر.',
  });
  return () => core.toDesign(r, manager, publishers.map((p) => p.id), note);
}

async function designerStep(r) {
  const designer = digital('designer');
  if (!designer || r.design_requested_at) return;
  const caption = await ai.write({
    system: system(designer),
    prompt: `اكتب كابشن منشور إنستقرام جذاب لهذا الطلب (أقل من 600 حرف) مع 3 إلى 5 هاشتاقات مناسبة في آخره.\n\n${describe(r)}`,
    fallback: `${r.title}${r.brief ? `\n\n${r.brief.slice(0, 500)}` : ''}`,
  });
  if (!webhookEnabled) {
    return () => core.deliverDesign(r, designer, `${PUBLIC_URL}/designs/${r.id}.svg`, caption.slice(0, 2200));
  }
  // Ask the external design service (e.g. Make → Canva) and wait for its callback.
  return () => {
    const { changes } = db.prepare(`UPDATE publish_requests SET caption = ?, design_requested_at = datetime('now', 'localtime')
                                    WHERE id = ? AND status = 'in_design' AND design_requested_at = ''`)
      .run(caption.slice(0, 2200), r.id);
    if (changes === 0) return;
    core.post(r, 'designs', designer, '', '🤖 كتبت الكابشن وأرسلت طلب التصميم إلى خدمة التصاميم، بانتظار التصميم.');
    notify('design_requested', {
      request: { ...r, caption }, designer: core.person(designer),
      callback: { url: `${PUBLIC_URL}/api/workflow/requests/${r.id}/design`, fields: ['design_url', 'caption'] },
    });
  };
}

const warnedNoBuffer = new Set();

async function publishersStep(r) {
  const waiting = q.assignments.all(r.id).filter((a) => a.is_digital && !a.published_at && !a.requested_at);
  if (waiting.length === 0) return;
  if (!webhookEnabled) {
    if (warnedNoBuffer.has(r.id)) return;
    warnedNoBuffer.add(r.id);
    return () => core.post(r, 'designs', null, '',
      '🤖 موظفو النشر الرقميون جاهزون، لكن ربط Buffer غير مفعّل (WORKFLOW_WEBHOOK_URL). يمكن لمدير النظام تأكيد النشر يدوياً.');
  }
  return () => {
    for (const a of waiting) {
      const { changes } = db.prepare(`UPDATE publish_assignments SET requested_at = datetime('now', 'localtime')
                                      WHERE id = ? AND requested_at = ''`).run(a.id);
      if (changes === 0) continue;
      core.post(r, 'designs', q.employee.get(a.employee_id), '', `🤖 أرسلت المنشور إلى Buffer (${a.buffer_user}) للنشر على @${a.instagram_account}.`);
      notify('publish_requested', {
        request: r, design_url: r.design_url, caption: r.caption, publisher: core.person(a),
        callback: { url: `${PUBLIC_URL}/api/workflow/assignments/${a.id}/published`, fields: ['post_url'] },
      });
    }
  };
}

async function managerReportStep(r) {
  const manager = digital('manager');
  if (!manager) return;
  const draft = core.buildReport(r, q.assignments.all(r.id), '', manager);
  const notes = await ai.write({
    system: system(manager),
    prompt: `هذا تقرير النشر الذي سترسلينه إلى ${core.holderName('director')}. اكتبي ملخصاً من سطرين: هل اكتمل النشر على كل الحسابات وفي الموعد، وأي ملاحظة.\n\n${draft}`,
    fallback: 'تم النشر على جميع الحسابات المطلوبة حسب الخطة.',
  });
  return () => core.sendReport(r, manager, notes);
}

const STEPS = {
  to_director: directorStep,
  to_manager: managerSendStep,
  in_design: designerStep,
  publishing: publishersStep,
  published: managerReportStep,
};

// ---------- scheduling ----------
// One run per request at a time; a change during a run triggers one more run afterwards.
const running = new Set();
const again = new Set();

async function act(id) {
  const r = q.request.get(id);
  const stepFn = r && STEPS[r.status];
  if (!stepFn) return;
  const apply = await stepFn(r);
  if (!apply) return;
  // Someone (e.g. an admin) may have acted while Claude was writing: only apply on the same step.
  if (q.request.get(id)?.status !== r.status) return;
  try {
    apply();
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
  }
}

function wake(id) {
  if (running.has(id)) {
    again.add(id);
    return;
  }
  running.add(id);
  act(id)
    .catch((err) => console.error(`digital employees, request #${id}:`, err))
    .finally(() => {
      running.delete(id);
      if (again.delete(id)) wake(id);
    });
}

function start() {
  core.events.on('changed', (id) => setImmediate(wake, id));
  for (const { id } of q.openRequestIds.all()) wake(id);
}

// ---------- design fallback (no design service) ----------
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 5);
}

function designSvg(r) {
  const lines = wrap(r.title, 16);
  const top = 540 - ((lines.length - 1) * 95) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080" direction="rtl">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f1b3d"/><stop offset="1" stop-color="#1c3a8a"/></linearGradient></defs>
  <rect width="1080" height="1080" fill="url(#g)"/>
  <rect x="60" y="60" width="960" height="960" rx="36" fill="none" stroke="#c9a227" stroke-width="4"/>
  <g font-family="Tajawal, 'Noto Kufi Arabic', 'Noto Sans Arabic', sans-serif" text-anchor="middle" fill="#fff">
    ${lines.map((l, i) => `<text x="540" y="${top + i * 95}" font-size="80" font-weight="800">${xml(l)}</text>`).join('\n    ')}
    <text x="540" y="960" font-size="40" fill="#c9a227">◆ ${xml(COMPANY_NAME)}</text>
  </g>
</svg>`;
}

// ---------- routes: design file + callbacks from the design service / Buffer scenario ----------
function createAgentRoutes({ toId, clean }) {
  const router = express.Router();

  // Public so Buffer / Instagram can fetch the design.
  router.get('/designs/:id.svg', (req, res) => {
    const r = q.request.get(toId(req.params.id));
    if (!r) return res.status(404).end();
    res.type('image/svg+xml').send(designSvg(r));
  });

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }), (req, res, next) => {
    if (!CALLBACK_TOKEN) return res.status(503).json({ error: 'WORKFLOW_CALLBACK_TOKEN is not set' });
    if (req.get('authorization') !== `Bearer ${CALLBACK_TOKEN}`) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  const reply = (res, fn) => {
    try {
      fn();
      res.json({ ok: true });
    } catch (err) {
      if (!(err instanceof StepError)) throw err;
      res.status(409).json({ error: err.message });
    }
  };

  api.post('/requests/:id/design', (req, res) => {
    const r = q.request.get(toId(req.params.id));
    if (!r) return res.status(404).json({ error: 'not found' });
    const caption = clean(req.body?.caption) || r.caption;
    reply(res, () => core.deliverDesign(r, q.roleHolder.get('designer'), clean(req.body?.design_url), caption.slice(0, 2200)));
  });

  api.post('/assignments/:aid/published', (req, res) => {
    const a = q.assignment.get(toId(req.params.aid));
    const r = a && q.request.get(a.request_id);
    if (!r) return res.status(404).json({ error: 'not found' });
    reply(res, () => core.markPublished(r, a, a.employee_id ? q.employee.get(a.employee_id) : null, clean(req.body?.post_url)));
  });

  router.use('/api/workflow', api);
  return router;
}

module.exports = { start, createAgentRoutes, designSvg };
