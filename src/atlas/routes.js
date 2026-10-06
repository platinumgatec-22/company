// Atlas: the company operating system (pages, in-app JSON API, webhooks, REST API for Make).
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const svc = require('./service');
const settings = require('./settings');
const whatsapp = require('./whatsapp');
const make = require('./make');
const strategist = require('./strategist');
const { emit, deliver, EVENTS } = require('./events');

const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
};
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const flash = (req, type, message) => { req.session.flash = { type, message }; };
const notFound = (res, message = 'غير موجود.') => res.status(404).render('atlas/error', { title: 'غير موجود', message });

const employees = () => db.prepare('SELECT id, full_name, job_title, phone, department_id FROM employees WHERE is_active = 1 ORDER BY full_name').all();
const departments = () => db.prepare('SELECT id, name, icon FROM departments ORDER BY id').all();
const clientsBrief = () => db.prepare('SELECT id, name, company FROM clients ORDER BY name').all();

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: svc.TIME_ZONE }).format(new Date()));
  if (h < 12) return 'صباح الخير';
  if (h < 18) return 'نهارك سعيد';
  return 'مساء الخير';
}

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

function createRouters({ requireAuth, requireAdmin }) {
  const atlas = express.Router();
  atlas.use(requireAuth);
  atlas.use((req, res, next) => {
    res.locals.STATUS_LABEL = svc.STATUS_LABEL;
    res.locals.STAGE_LABEL = svc.STAGE_LABEL;
    res.locals.PRIORITY_LABEL = svc.PRIORITY_LABEL;
    res.locals.badges = {
      inbox: db.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM wa_conversations').get().n,
      proposals: db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE employee_id = ? AND status = 'pending'").get(req.user.id).n,
    };
    next();
  });

  // In-app JSON calls must carry this header: a cross-site form can't set it.
  const jsonGuard = (req, res, next) => {
    if (req.get('x-atlas') !== '1') return res.status(403).json({ error: 'Missing X-Atlas header' });
    next();
  };
  const handle = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch((err) => {
    if (err instanceof svc.ValidationError) return res.status(400).json({ error: err.message });
    next(err);
  });

  // ---------- home ----------
  atlas.get('/', (req, res) => {
    const ov = svc.overview();
    const connected = {
      whatsapp: settings.connected.whatsapp(),
      make: settings.connected.make(),
      strategist: settings.connected.strategist(),
    };
    res.render('atlas/home', {
      title: 'Atlas', ov, connected, greeting: greeting(),
      waiting: svc.waitingFor(req.user),
      activity: svc.recentActivity(6),
      notConnected: Object.values(connected).filter((v) => !v).length,
    });
  });

  // ---------- tasks / board ----------
  atlas.get('/board', (req, res) => {
    const mine = req.query.owner === 'me';
    const deptId = toId(req.query.department);
    const search = clean(req.query.q);
    const tasks = svc.listTasks({ ownerId: mine ? req.user.id : null, departmentId: deptId || null, search });
    res.render('atlas/board', {
      title: 'لوحة المهام', tasks, mine, deptId, search, departments: departments(),
      columns: svc.TASK_STATUSES, today: svc.today(),
    });
  });

  const taskForm = (res, task, status = 200) => res.status(status).render('atlas/task', {
    title: task.id ? task.title : 'مهمة جديدة', task, employees: employees(), departments: departments(), clients: clientsBrief(),
    statuses: svc.TASK_STATUSES, priorities: svc.PRIORITIES,
  });

  atlas.get('/tasks/new', (req, res) => taskForm(res, {
    id: 0, title: clean(req.query.title), description: '', status: svc.TASK_STATUSES.includes(req.query.status) ? req.query.status : 'todo',
    priority: 'normal', due_date: clean(req.query.due), owner_id: req.user.id, department_id: req.user.department_id,
    client_id: toId(req.query.client) || null,
  }));

  atlas.get('/tasks/:id', (req, res) => {
    const task = svc.getTask(toId(req.params.id));
    if (!task) return notFound(res, 'المهمة غير موجودة.');
    taskForm(res, task);
  });

  const saveTask = (req, res) => {
    const taskId = toId(req.params.id);
    try {
      const task = taskId ? svc.updateTask(taskId, req.body, req.user) : svc.createTask(req.body, req.user);
      flash(req, 'success', taskId ? 'تم حفظ المهمة.' : 'تم إنشاء المهمة.');
      res.redirect(req.body.back === 'client' && task.client_id ? `/atlas/clients/${task.client_id}` : '/atlas/board');
    } catch (err) {
      if (!(err instanceof svc.ValidationError)) throw err;
      res.locals.flash = { type: 'error', message: err.message };
      taskForm(res, { id: taskId, ...req.body }, 400);
    }
  };
  atlas.post('/tasks', saveTask);
  atlas.post('/tasks/:id', saveTask);
  atlas.post('/tasks/:id/delete', (req, res) => {
    svc.deleteTask(toId(req.params.id), req.user);
    flash(req, 'success', 'تم حذف المهمة.');
    res.redirect('/atlas/board');
  });

  atlas.patch('/api/tasks/:id', jsonGuard, handle((req, res) => {
    const patch = {};
    if (req.body.status) patch.status = req.body.status;
    if (req.body.position !== undefined) patch.position = req.body.position;
    res.json({ task: svc.updateTask(toId(req.params.id), patch, req.user) });
  }));

  // ---------- calendar ----------
  atlas.get('/calendar', (req, res) => {
    const m = /^(\d{4})-(\d{2})$/.exec(clean(req.query.m)) || /^(\d{4})-(\d{2})/.exec(svc.today());
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const first = new Date(Date.UTC(year, month, 1));
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const tasks = db.prepare(`SELECT t.id, t.title, t.status, t.priority, t.due_date, e.full_name AS owner_name
      FROM tasks t LEFT JOIN employees e ON e.id = t.owner_id WHERE t.due_date LIKE ? ORDER BY t.due_date`).all(`${prefix}-%`);
    const byDay = {};
    for (const t of tasks) (byDay[Number(t.due_date.slice(8, 10))] ||= []).push(t);
    const shift = (d) => {
      const x = new Date(Date.UTC(year, month + d, 1));
      return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    res.render('atlas/calendar', {
      title: 'التقويم', year, month, days, prefix, byDay,
      // Weeks start on Saturday (Gulf work week).
      offset: (first.getUTCDay() + 1) % 7,
      monthName: new Intl.DateTimeFormat('ar', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first),
      prev: shift(-1), next: shift(1), today: svc.today(),
    });
  });

  // ---------- canvas ----------
  const canvasFor = (req, canvasId) => {
    const canvas = db.prepare('SELECT * FROM canvases WHERE id = ?').get(canvasId);
    return svc.canAccessCanvas(canvas, req.user) ? canvas : null;
  };
  const itemFor = (req, itemId) => {
    const item = db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(itemId);
    return item && canvasFor(req, item.canvas_id) ? item : null;
  };

  atlas.get('/canvas', (req, res) => {
    svc.sharedCanvas();
    const canvases = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM canvas_items i WHERE i.canvas_id = c.id) AS items
      FROM canvases c WHERE c.owner_id IS NULL OR c.owner_id = ? ORDER BY c.owner_id IS NOT NULL, c.id`).all(req.user.id);
    res.render('atlas/canvases', { title: 'اللوحات', canvases });
  });

  atlas.post('/canvas', (req, res) => {
    const name = clean(req.body.name).slice(0, 100) || 'لوحة جديدة';
    const r = db.prepare('INSERT INTO canvases (name, owner_id) VALUES (?, ?)')
      .run(name, req.body.private ? req.user.id : null);
    res.redirect(`/atlas/canvas/${r.lastInsertRowid}`);
  });

  atlas.get('/canvas/:id', (req, res) => {
    const canvas = canvasFor(req, toId(req.params.id));
    if (!canvas) return notFound(res, 'اللوحة غير موجودة.');
    res.render('atlas/canvas', { title: canvas.name, canvas, employees: employees(), colors: svc.COLORS });
  });

  atlas.post('/canvas/:id/delete', (req, res) => {
    const canvas = canvasFor(req, toId(req.params.id));
    if (canvas && (canvas.owner_id === req.user.id || req.user.role === 'admin')) {
      db.prepare('DELETE FROM canvases WHERE id = ?').run(canvas.id);
      flash(req, 'success', 'تم حذف اللوحة.');
    }
    res.redirect('/atlas/canvas');
  });

  atlas.get('/api/canvas/:id', jsonGuard, (req, res) => {
    const canvas = canvasFor(req, toId(req.params.id));
    if (!canvas) return res.status(404).json({ error: 'not found' });
    const items = db.prepare(`SELECT i.*, t.status AS task_status, t.due_date AS task_due, e.full_name AS task_owner,
        w.full_name AS author
      FROM canvas_items i LEFT JOIN tasks t ON t.id = i.task_id LEFT JOIN employees e ON e.id = t.owner_id
      LEFT JOIN employees w ON w.id = i.created_by
      WHERE i.canvas_id = ? ORDER BY i.kind = 'section' DESC, i.id`).all(canvas.id);
    const links = db.prepare('SELECT * FROM canvas_links WHERE canvas_id = ?').all(canvas.id);
    res.json({ canvas, items, links });
  });

  atlas.post('/api/canvas/:id/items', jsonGuard, handle((req, res) => {
    const canvas = canvasFor(req, toId(req.params.id));
    if (!canvas) return res.status(404).json({ error: 'not found' });
    const kind = ['note', 'text', 'section', 'task'].includes(req.body.kind) ? req.body.kind : 'note';
    const text = clean(req.body.text) || (kind === 'section' ? 'قسم جديد' : kind === 'task' ? 'مهمة جديدة' : 'ملاحظة جديدة');
    let item = svc.createNote({ ...req.body, kind: kind === 'task' ? 'note' : kind, text, canvas_id: canvas.id }, req.user);
    if (kind === 'task') item = convertToTask(item, req.user);
    res.json({ item });
  }));

  function convertToTask(item, user) {
    const [title, ...rest] = item.text.split('\n');
    const task = svc.createTask({ title: title.slice(0, 200), description: rest.join('\n'), owner_id: user.id }, user);
    db.prepare("UPDATE canvas_items SET kind = 'task', task_id = ?, updated_at = datetime('now') WHERE id = ?").run(task.id, item.id);
    return db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(item.id);
  }

  atlas.patch('/api/items/:id', jsonGuard, handle((req, res) => {
    const item = itemFor(req, toId(req.params.id));
    if (!item) return res.status(404).json({ error: 'not found' });
    const next = { ...item };
    for (const k of ['x', 'y', 'w', 'h']) {
      if (req.body[k] !== undefined && Number.isFinite(Number(req.body[k]))) next[k] = Math.round(Number(req.body[k]));
    }
    next.w = Math.max(80, next.w);
    next.h = Math.max(50, next.h);
    if (typeof req.body.text === 'string') next.text = req.body.text.slice(0, 5000);
    if (svc.COLORS.includes(req.body.color)) next.color = req.body.color;
    if (['note', 'text', 'section'].includes(req.body.kind) && item.kind !== 'task') next.kind = req.body.kind;
    db.prepare(`UPDATE canvas_items SET x = ?, y = ?, w = ?, h = ?, text = ?, color = ?, kind = ?, updated_at = datetime('now')
                WHERE id = ?`).run(next.x, next.y, next.w, next.h, next.text, next.color, next.kind, item.id);
    // Keep the linked task title in sync with the card.
    if (item.task_id && typeof req.body.text === 'string' && next.text.trim()) {
      const title = next.text.split('\n')[0].slice(0, 200);
      const task = svc.getTask(item.task_id);
      if (task && task.title !== title) svc.updateTask(item.task_id, { title }, req.user);
    }
    res.json({ item: db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(item.id) });
  }));

  atlas.post('/api/items/:id/to-task', jsonGuard, handle((req, res) => {
    const item = itemFor(req, toId(req.params.id));
    if (!item) return res.status(404).json({ error: 'not found' });
    if (item.task_id) return res.json({ item });
    res.json({ item: convertToTask(item, req.user) });
  }));

  atlas.delete('/api/items/:id', jsonGuard, (req, res) => {
    const item = itemFor(req, toId(req.params.id));
    if (!item) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM canvas_items WHERE id = ?').run(item.id);
    res.json({ ok: true });
  });

  atlas.post('/api/canvas/:id/links', jsonGuard, (req, res) => {
    const canvas = canvasFor(req, toId(req.params.id));
    const from = itemFor(req, toId(req.body.from_id));
    const to = itemFor(req, toId(req.body.to_id));
    if (!canvas || !from || !to || from.canvas_id !== canvas.id || to.canvas_id !== canvas.id || from.id === to.id) {
      return res.status(400).json({ error: 'invalid link' });
    }
    db.prepare('INSERT OR IGNORE INTO canvas_links (canvas_id, from_id, to_id) VALUES (?, ?, ?)').run(canvas.id, from.id, to.id);
    res.json({ link: db.prepare('SELECT * FROM canvas_links WHERE from_id = ? AND to_id = ?').get(from.id, to.id) });
  });

  atlas.delete('/api/links/:id', jsonGuard, (req, res) => {
    const link = db.prepare('SELECT * FROM canvas_links WHERE id = ?').get(toId(req.params.id));
    if (!link || !canvasFor(req, link.canvas_id)) return res.status(404).json({ error: 'not found' });
    db.prepare('DELETE FROM canvas_links WHERE id = ?').run(link.id);
    res.json({ ok: true });
  });

  // ---------- CRM ----------
  atlas.get('/clients', (req, res) => {
    const view = req.query.view === 'list' ? 'list' : 'pipeline';
    const search = clean(req.query.q);
    const stage = svc.STAGES.includes(req.query.stage) ? req.query.stage : '';
    res.render('atlas/clients', {
      title: 'العملاء', view, search, stage, stages: svc.STAGES,
      clients: svc.listClients({ search, stage: view === 'list' ? stage : '' }), ov: svc.overview(),
    });
  });

  const clientForm = (res, client, status = 200) => res.status(status).render('atlas/client-form', {
    title: client.id ? `تعديل ${client.name}` : 'عميل جديد', client, employees: employees(), stages: svc.STAGES,
  });

  atlas.get('/clients/new', (req, res) => clientForm(res, {
    id: 0, name: clean(req.query.name), company: '', phone: clean(req.query.phone), email: '', stage: 'lead', value: 0,
    source: clean(req.query.source), notes: '', owner_id: req.user.id,
  }));

  atlas.get('/clients/:id/edit', (req, res) => {
    const client = svc.getClient(toId(req.params.id));
    if (!client) return notFound(res, 'العميل غير موجود.');
    clientForm(res, client);
  });

  atlas.get('/clients/:id', (req, res) => {
    const client = svc.getClient(toId(req.params.id));
    if (!client) return notFound(res, 'العميل غير موجود.');
    const interactions = db.prepare(`SELECT i.*, e.full_name AS employee_name FROM interactions i
      LEFT JOIN employees e ON e.id = i.employee_id WHERE i.client_id = ? ORDER BY i.id DESC`).all(client.id);
    const conversation = db.prepare('SELECT * FROM wa_conversations WHERE client_id = ? ORDER BY id LIMIT 1').get(client.id);
    const messages = conversation
      ? db.prepare('SELECT * FROM wa_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 5').all(conversation.id).reverse()
      : [];
    res.render('atlas/client', {
      title: client.name, client, interactions, conversation, messages,
      tasks: svc.listTasks({ clientId: client.id }), kinds: svc.INTERACTION_KINDS,
    });
  });

  const saveClient = (req, res) => {
    const clientId = toId(req.params.id);
    try {
      const client = clientId ? svc.updateClient(clientId, req.body, req.user) : svc.createClient(req.body, req.user);
      const conv = toId(req.body.conversation_id);
      if (conv) db.prepare('UPDATE wa_conversations SET client_id = ? WHERE id = ?').run(client.id, conv);
      flash(req, 'success', 'تم حفظ العميل.');
      res.redirect(`/atlas/clients/${client.id}`);
    } catch (err) {
      if (!(err instanceof svc.ValidationError)) throw err;
      res.locals.flash = { type: 'error', message: err.message };
      clientForm(res, { id: clientId, ...req.body }, 400);
    }
  };
  atlas.post('/clients', saveClient);
  atlas.post('/clients/:id', saveClient);

  atlas.post('/clients/:id/delete', (req, res) => {
    svc.deleteClient(toId(req.params.id), req.user);
    flash(req, 'success', 'تم حذف العميل.');
    res.redirect('/atlas/clients');
  });

  atlas.post('/clients/:id/interactions', (req, res) => {
    const clientId = toId(req.params.id);
    try {
      svc.addInteraction(clientId, req.body, req.user);
    } catch (err) {
      if (!(err instanceof svc.ValidationError)) throw err;
      flash(req, 'error', err.message);
    }
    res.redirect(`/atlas/clients/${clientId}`);
  });

  atlas.patch('/api/clients/:id', jsonGuard, handle((req, res) => {
    const patch = {};
    if (req.body.stage) patch.stage = req.body.stage;
    res.json({ client: svc.updateClient(toId(req.params.id), patch, req.user) });
  }));

  // ---------- WhatsApp inbox ----------
  const conversations = (search = '') => db.prepare(`
    SELECT w.*, c.name AS client_name,
      (SELECT body FROM wa_messages m WHERE m.conversation_id = w.id ORDER BY m.id DESC LIMIT 1) AS last_body,
      (SELECT direction FROM wa_messages m WHERE m.conversation_id = w.id ORDER BY m.id DESC LIMIT 1) AS last_direction
    FROM wa_conversations w LEFT JOIN clients c ON c.id = w.client_id
    WHERE (? = '' OR w.name LIKE ? OR w.phone LIKE ? OR c.name LIKE ?)
    ORDER BY w.last_message_at DESC`).all(search, `%${search}%`, `%${search}%`, `%${search}%`);

  const renderInbox = (req, res, conversation = null) => {
    const search = clean(req.query.q);
    let messages = [];
    if (conversation) {
      messages = db.prepare(`SELECT m.*, e.full_name AS sender_name FROM wa_messages m
        LEFT JOIN employees e ON e.id = m.sender_id WHERE m.conversation_id = ? ORDER BY m.id`).all(conversation.id);
      db.prepare('UPDATE wa_conversations SET unread = 0 WHERE id = ?').run(conversation.id);
      res.locals.badges.inbox = Math.max(0, res.locals.badges.inbox - conversation.unread);
    }
    res.render('atlas/inbox', {
      title: 'واتساب', conversations: conversations(search), conversation, messages, search,
      connected: settings.connected.whatsapp(), clients: clientsBrief(),
    });
  };

  atlas.get('/inbox', (req, res) => renderInbox(req, res));
  atlas.get('/inbox/:id', (req, res) => {
    const conversation = db.prepare(`SELECT w.*, c.name AS client_name, c.stage AS client_stage FROM wa_conversations w
      LEFT JOIN clients c ON c.id = w.client_id WHERE w.id = ?`).get(toId(req.params.id));
    if (!conversation) return notFound(res, 'المحادثة غير موجودة.');
    renderInbox(req, res, conversation);
  });

  async function sendFromInbox(req, res, to, convId) {
    const text = clean(req.body.text).slice(0, 4096);
    if (!text || whatsapp.digits(to).length < 8) {
      flash(req, 'error', 'اكتب رقماً صحيحاً (مع رمز الدولة) ونص الرسالة.');
      return res.redirect(convId ? `/atlas/inbox/${convId}` : '/atlas/inbox');
    }
    const r = await whatsapp.sendText(to, text, { senderId: req.user.id });
    if (r.ok) {
      emit('whatsapp.sent', { message: `أرسل واتساب إلى ${to}`, actor: req.user, link: `/atlas/inbox/${r.conversationId}`, data: { to, text } });
    } else {
      flash(req, 'error', `لم تُرسل الرسالة: ${r.error}`);
    }
    const conv = db.prepare('SELECT id FROM wa_conversations WHERE phone = ?').get(whatsapp.digits(to));
    res.redirect(conv ? `/atlas/inbox/${conv.id}` : '/atlas/inbox');
  }

  atlas.post('/inbox/new', asyncRoute((req, res) => sendFromInbox(req, res, clean(req.body.to), 0)));
  atlas.post('/inbox/:id/send', asyncRoute((req, res) => {
    const conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ?').get(toId(req.params.id));
    if (!conv) return notFound(res);
    return sendFromInbox(req, res, conv.phone, conv.id);
  }));
  atlas.post('/inbox/:id/link', (req, res) => {
    const convId = toId(req.params.id);
    const clientId = toId(req.body.client_id);
    if (clientId && svc.getClient(clientId)) {
      db.prepare('UPDATE wa_conversations SET client_id = ? WHERE id = ?').run(clientId, convId);
      flash(req, 'success', 'تم ربط المحادثة بالعميل.');
    }
    res.redirect(`/atlas/inbox/${convId}`);
  });

  // ---------- The Strategist ----------
  atlas.get('/strategist', (req, res) => {
    res.render('atlas/strategist', {
      title: 'المستشار', transcript: strategist.transcript(req.user.id),
      proposals: strategist.pendingProposals(req.user.id), connected: settings.connected.strategist(),
    });
  });

  atlas.post('/api/strategist', jsonGuard, asyncRoute(async (req, res) => {
    const text = clean(req.body.text).slice(0, 8000);
    if (!text) return res.status(400).json({ error: 'اكتب رسالتك.' });
    try {
      const reply = await strategist.ask(req.user, text);
      res.json({ reply, proposals: strategist.pendingProposals(req.user.id) });
    } catch (err) {
      console.error('strategist', err);
      res.status(502).json({ error: err.message });
    }
  }));

  atlas.post('/strategist/new', (req, res) => {
    strategist.newThread(req.user.id);
    res.redirect('/atlas/strategist');
  });

  atlas.post('/strategist/proposals/:id', asyncRoute(async (req, res) => {
    const r = await strategist.decide(toId(req.params.id), req.user, req.body.decision === 'approve');
    if (r?.status === 'approved') flash(req, 'success', 'تم التنفيذ ✓');
    else if (r?.status === 'declined') flash(req, 'info', 'تم رفض الاقتراح.');
    else if (r?.status === 'failed') flash(req, 'error', `تعذّر التنفيذ: ${r.error}`);
    res.redirect(r?.status === 'approved' && r.link && req.body.go ? r.link : '/atlas/strategist');
  }));

  // ---------- activity ----------
  atlas.get('/activity', (req, res) => {
    res.render('atlas/activity', { title: 'سجل النشاط', activity: svc.recentActivity(200) });
  });

  // ---------- automations: Make, WhatsApp, Claude (admin) ----------
  const automations = express.Router();
  automations.use(requireAdmin);

  automations.get('/', asyncRoute(async (req, res) => {
    const makeCfg = make.config();
    let scenarios = null;
    let scenariosError = '';
    if (makeCfg.ready) {
      try {
        scenarios = await make.listScenarios();
      } catch (err) {
        scenariosError = err.message;
      }
    }
    const base = `${req.protocol}://${req.get('host')}`;
    res.render('atlas/automations', {
      title: 'الأتمتة والربط', base, events: EVENTS, fields: settings.FIELDS,
      values: Object.fromEntries(Object.keys(settings.FIELDS).map((k) => {
        const v = settings.get(k);
        return [k, { value: settings.FIELDS[k].secret ? settings.mask(v) : v, set: Boolean(v), env: settings.fromEnv(k) }];
      })),
      webhooks: db.prepare('SELECT * FROM webhooks ORDER BY id').all(),
      deliveries: db.prepare(`SELECT d.*, w.name AS webhook_name FROM webhook_deliveries d
        LEFT JOIN webhooks w ON w.id = d.webhook_id ORDER BY d.id DESC LIMIT 25`).all(),
      keys: db.prepare('SELECT * FROM api_keys ORDER BY id').all(),
      newKey: req.session.newKey || null,
      scenarios, scenariosError, makeReady: makeCfg.ready,
      connected: { whatsapp: settings.connected.whatsapp(), make: settings.connected.make(), strategist: settings.connected.strategist() },
      defaultModel: strategist.DEFAULT_MODEL,
    });
    delete req.session.newKey;
  }));

  automations.post('/settings', (req, res) => {
    for (const key of Object.keys(settings.FIELDS)) {
      if (!(key in req.body) || settings.fromEnv(key)) continue;
      const value = clean(req.body[key]);
      // Secret inputs are left blank to keep the saved value; "-" clears it.
      if (settings.FIELDS[key].secret && value === '') continue;
      settings.set(key, value === '-' ? '' : value);
    }
    flash(req, 'success', 'تم حفظ الإعدادات.');
    res.redirect('/atlas/automations');
  });

  automations.post('/webhooks', (req, res) => {
    const url = clean(req.body.url);
    if (!/^https:\/\/\S+$/.test(url)) {
      flash(req, 'error', 'رابط الـ webhook يجب أن يبدأ بـ https://');
      return res.redirect('/atlas/automations');
    }
    const events = [].concat(req.body.events || []).filter((e) => EVENTS.includes(e));
    db.prepare('INSERT INTO webhooks (name, url, events, secret) VALUES (?, ?, ?, ?)')
      .run(clean(req.body.name) || 'Make scenario', url, events.length ? events.join(',') : '*', clean(req.body.secret));
    flash(req, 'success', 'تمت إضافة الـ webhook.');
    res.redirect('/atlas/automations');
  });

  automations.post('/webhooks/:id/toggle', (req, res) => {
    db.prepare('UPDATE webhooks SET is_active = 1 - is_active WHERE id = ?').run(toId(req.params.id));
    res.redirect('/atlas/automations');
  });

  automations.post('/webhooks/:id/delete', (req, res) => {
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(toId(req.params.id));
    flash(req, 'success', 'تم حذف الـ webhook.');
    res.redirect('/atlas/automations');
  });

  automations.post('/webhooks/:id/test', asyncRoute(async (req, res) => {
    const hook = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(toId(req.params.id));
    if (hook) {
      const body = JSON.stringify({ event: 'atlas.test', at: new Date().toISOString(), actor: { id: req.user.id, name: req.user.full_name }, data: { hello: 'from Atlas' } });
      const r = await deliver(hook, 'atlas.test', body);
      flash(req, r.error ? 'error' : 'success', r.error ? `فشل الإرسال (${r.status}): ${r.error}` : `تم الإرسال — HTTP ${r.status}`);
    }
    res.redirect('/atlas/automations');
  }));

  automations.post('/keys', (req, res) => {
    const key = `atlas_${crypto.randomBytes(24).toString('base64url')}`;
    db.prepare('INSERT INTO api_keys (name, key_hash, prefix, created_by) VALUES (?, ?, ?, ?)')
      .run(clean(req.body.name) || 'Make', hashKey(key), key.slice(0, 12), req.user.id);
    req.session.newKey = key;
    res.redirect('/atlas/automations#keys');
  });

  automations.post('/keys/:id/delete', (req, res) => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(toId(req.params.id));
    flash(req, 'success', 'تم إلغاء المفتاح.');
    res.redirect('/atlas/automations#keys');
  });

  automations.post('/scenarios/:id/run', asyncRoute(async (req, res) => {
    try {
      const r = await make.runScenario(toId(req.params.id), { triggeredBy: req.user.full_name });
      flash(req, 'success', `تم تشغيل السيناريو${r.executionId ? ` (تنفيذ ${r.executionId})` : ''}.`);
      emit('atlas.test', { message: `شغّل سيناريو Make رقم ${req.params.id}`, actor: req.user });
    } catch (err) {
      flash(req, 'error', `تعذّر تشغيل السيناريو: ${err.message}`);
    }
    res.redirect('/atlas/automations#scenarios');
  }));

  automations.post('/whatsapp-test', asyncRoute(async (req, res) => {
    const r = await whatsapp.sendText(clean(req.body.to), clean(req.body.text) || 'Atlas is connected ✓', { senderId: req.user.id });
    flash(req, r.ok ? 'success' : 'error', r.ok ? 'تم إرسال رسالة الاختبار.' : `فشل: ${r.error}`);
    res.redirect('/atlas/automations#whatsapp');
  }));

  atlas.use('/automations', automations);

  // ---------- public webhooks ----------
  const hooks = express.Router();

  hooks.get('/whatsapp', (req, res) => {
    const verify = settings.get('whatsapp_verify_token');
    if (verify && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verify) {
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  hooks.post('/whatsapp', (req, res) => {
    if (!whatsapp.validSignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
    for (const m of whatsapp.parseInbound(req.body)) {
      let conv = whatsapp.conversationFor(m.from, m.name);
      if (db.prepare('SELECT 1 FROM wa_messages WHERE wa_id = ? AND wa_id != ?').get(m.id, '')) continue; // Meta retries
      whatsapp.storeMessage(conv, 'in', m.text, { waId: m.id, status: 'received' });
      // A new number becomes a lead in the CRM automatically.
      if (!conv.client_id) {
        const client = svc.createClient({ name: m.name || `+${m.from}`, phone: `+${m.from}`, source: 'whatsapp', stage: 'lead' }, null);
        db.prepare('UPDATE wa_conversations SET client_id = ? WHERE id = ?').run(client.id, conv.id);
        conv = { ...conv, client_id: client.id };
      }
      emit('whatsapp.received', {
        message: `رسالة واتساب من ${m.name || m.from}`, link: `/atlas/inbox/${conv.id}`,
        data: { from: m.from, name: m.name, text: m.text, conversation_id: conv.id, client_id: conv.client_id },
      });
    }
    res.sendStatus(200);
  });

  // ---------- REST API v1 (for Make HTTP modules) ----------
  const api = express.Router();
  api.use((req, res, next) => {
    const header = req.get('authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : clean(req.get('x-api-key'));
    const row = key ? db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashKey(key)) : null;
    if (!row) return res.status(401).json({ error: 'Invalid or missing API key' });
    db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    req.actor = row.created_by ? db.prepare('SELECT * FROM employees WHERE id = ?').get(row.created_by) : null;
    if (req.actor) req.actor = { ...req.actor, full_name: `${row.name} (API)` };
    next();
  });
  const apiHandle = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((err) => {
    if (err instanceof svc.ValidationError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  api.get('/overview', (req, res) => res.json(svc.overview()));
  api.get('/employees', (req, res) => res.json(employees()));
  api.get('/departments', (req, res) => res.json(departments()));
  api.get('/tasks', (req, res) => res.json(svc.listTasks({
    status: svc.TASK_STATUSES.includes(req.query.status) ? req.query.status : '',
    ownerId: toId(req.query.owner_id) || null, clientId: toId(req.query.client_id) || null, search: clean(req.query.q),
  })));
  api.get('/tasks/:id', (req, res) => {
    const task = svc.getTask(toId(req.params.id));
    return task ? res.json(task) : res.status(404).json({ error: 'not found' });
  });
  api.post('/tasks', apiHandle((req, res) => res.status(201).json(svc.createTask(req.body || {}, req.actor))));
  api.patch('/tasks/:id', apiHandle((req, res) => res.json(svc.updateTask(toId(req.params.id), req.body || {}, req.actor))));
  api.delete('/tasks/:id', (req, res) => res.json({ deleted: svc.deleteTask(toId(req.params.id), req.actor) }));
  api.get('/clients', (req, res) => res.json(svc.listClients({
    stage: svc.STAGES.includes(req.query.stage) ? req.query.stage : '', search: clean(req.query.q),
  })));
  api.get('/clients/by-phone/:phone', (req, res) => {
    const client = whatsapp.findClientByPhone(req.params.phone);
    return client ? res.json(client) : res.status(404).json({ error: 'not found' });
  });
  api.get('/clients/:id', (req, res) => {
    const client = svc.getClient(toId(req.params.id));
    return client ? res.json(client) : res.status(404).json({ error: 'not found' });
  });
  api.post('/clients', apiHandle((req, res) => res.status(201).json(svc.createClient(req.body || {}, req.actor))));
  api.patch('/clients/:id', apiHandle((req, res) => res.json(svc.updateClient(toId(req.params.id), req.body || {}, req.actor))));
  api.post('/clients/:id/interactions', apiHandle((req, res) => res.status(201).json(svc.addInteraction(toId(req.params.id), req.body || {}, req.actor))));
  api.post('/notes', apiHandle((req, res) => res.status(201).json(svc.createNote(req.body || {}, null))));
  api.post('/activity', apiHandle((req, res) => {
    const message = clean(req.body?.message).slice(0, 500);
    if (!message) throw new svc.ValidationError('message is required');
    emit(clean(req.body.event) || 'make.event', { message, actor: req.actor, link: clean(req.body.link), data: req.body.data || {} });
    res.status(201).json({ ok: true });
  }));
  api.post('/whatsapp/send', apiHandle(async (req, res) => {
    const to = clean(req.body?.to);
    const text = clean(req.body?.text).slice(0, 4096);
    if (!to || !text) throw new svc.ValidationError('to and text are required');
    const r = await whatsapp.sendText(to, text, { senderId: req.actor?.id || null });
    if (r.ok) emit('whatsapp.sent', { message: `أرسل واتساب إلى ${to}`, actor: req.actor, link: `/atlas/inbox/${r.conversationId}`, data: { to, text } });
    res.status(r.ok ? 200 : 502).json(r);
  }));
  api.use((req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

  return { atlas, hooks, api };
}

module.exports = createRouters;
