// Business actions shared by the web UI, the REST API (Make) and The Strategist.
const db = require('../db');
const { emit } = require('./events');
const whatsapp = require('./whatsapp');
const settings = require('./settings');

const TASK_STATUSES = ['todo', 'doing', 'review', 'done'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STAGES = ['lead', 'contacted', 'proposal', 'won', 'lost'];
const COLORS = ['teal', 'mint', 'mauve', 'gold', 'sky', 'rose', 'slate'];
const INTERACTION_KINDS = ['note', 'call', 'meeting', 'whatsapp', 'email'];

const STATUS_LABEL = { todo: 'للتنفيذ', doing: 'قيد العمل', review: 'مراجعة', done: 'منجزة' };
const STAGE_LABEL = { lead: 'عميل محتمل', contacted: 'تم التواصل', proposal: 'عرض سعر', won: 'تم الكسب', lost: 'خسارة' };
const PRIORITY_LABEL = { low: 'منخفضة', normal: 'عادية', high: 'عالية', urgent: 'عاجلة' };

class ValidationError extends Error {}

const TIME_ZONE = process.env.TZ || 'Asia/Kuwait';
/** Today's date (YYYY-MM-DD) in the company's time zone. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date());

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : v == null ? '' : String(v).trim().slice(0, max));
const id = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

const q = {
  task: db.prepare(`
    SELECT t.*, e.full_name AS owner_name, e.phone AS owner_phone, d.name AS department_name, c.name AS client_name
    FROM tasks t
    LEFT JOIN employees e ON e.id = t.owner_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN clients c ON c.id = t.client_id
    WHERE t.id = ?`),
  client: db.prepare(`
    SELECT c.*, e.full_name AS owner_name FROM clients c
    LEFT JOIN employees e ON e.id = c.owner_id WHERE c.id = ?`),
};

const getTask = (taskId) => q.task.get(taskId) || null;
const getClient = (clientId) => q.client.get(clientId) || null;

function listTasks({ status = '', ownerId = null, departmentId = null, clientId = null, search = '', limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push('t.status = ?'); args.push(status); }
  if (ownerId) { where.push('t.owner_id = ?'); args.push(ownerId); }
  if (departmentId) { where.push('t.department_id = ?'); args.push(departmentId); }
  if (clientId) { where.push('t.client_id = ?'); args.push(clientId); }
  if (search) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  return db.prepare(`
    SELECT t.*, e.full_name AS owner_name, d.name AS department_name, c.name AS client_name
    FROM tasks t
    LEFT JOIN employees e ON e.id = t.owner_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN clients c ON c.id = t.client_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.position, CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
             CASE WHEN t.due_date = '' THEN 1 ELSE 0 END, t.due_date, t.id DESC
    LIMIT ?`).all(...args, limit);
}

function listClients({ stage = '', search = '', ownerId = null, limit = 500 } = {}) {
  const where = [];
  const args = [];
  if (stage) { where.push('c.stage = ?'); args.push(stage); }
  if (ownerId) { where.push('c.owner_id = ?'); args.push(ownerId); }
  if (search) {
    where.push('(c.name LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
    args.push(...Array(4).fill(`%${search}%`));
  }
  return db.prepare(`
    SELECT c.*, e.full_name AS owner_name,
      (SELECT COUNT(*) FROM tasks t WHERE t.client_id = c.id AND t.status != 'done') AS open_tasks
    FROM clients c LEFT JOIN employees e ON e.id = c.owner_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.updated_at DESC LIMIT ?`).all(...args, limit);
}

function cleanTask(input, existing = {}) {
  const t = { ...existing };
  if ('title' in input) t.title = str(input.title, 200);
  if ('description' in input) t.description = str(input.description, 5000);
  if ('status' in input) t.status = TASK_STATUSES.includes(input.status) ? input.status : 'todo';
  if ('priority' in input) t.priority = PRIORITIES.includes(input.priority) ? input.priority : 'normal';
  if ('due_date' in input) t.due_date = isDate(str(input.due_date)) ? str(input.due_date) : '';
  if ('owner_id' in input) t.owner_id = id(input.owner_id);
  if ('department_id' in input) t.department_id = id(input.department_id);
  if ('client_id' in input) t.client_id = id(input.client_id);
  if ('position' in input && Number.isFinite(Number(input.position))) t.position = Number(input.position);
  if (!t.title) throw new ValidationError('عنوان المهمة مطلوب.');
  if (t.owner_id && !db.prepare('SELECT 1 FROM employees WHERE id = ?').get(t.owner_id)) throw new ValidationError('الموظف المسؤول غير موجود.');
  if (t.client_id && !getClient(t.client_id)) throw new ValidationError('العميل غير موجود.');
  if (t.department_id && !db.prepare('SELECT 1 FROM departments WHERE id = ?').get(t.department_id)) throw new ValidationError('القسم غير موجود.');
  return t;
}

function notifyOwner(task, actor) {
  if (settings.get('whatsapp_notify') !== '1' || !task.owner_id || task.owner_id === actor?.id) return;
  const owner = db.prepare('SELECT full_name, phone FROM employees WHERE id = ?').get(task.owner_id);
  if (!owner?.phone) return;
  const due = task.due_date ? ` — الاستحقاق ${task.due_date}` : '';
  whatsapp.sendText(owner.phone, `📌 مهمة جديدة لك من ${actor?.full_name || 'Atlas'}: ${task.title}${due}`, { store: false })
    .catch(() => {});
}

function createTask(input, actor) {
  const t = cleanTask({ status: 'todo', priority: 'normal', ...input });
  const r = db.prepare(`INSERT INTO tasks (title, description, status, priority, due_date, owner_id, department_id,
                        client_id, created_by, position)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(t.title, t.description || '', t.status, t.priority, t.due_date || '', t.owner_id || null,
      t.department_id || null, t.client_id || null, actor?.id || null, t.position || Date.now() / 1e6);
  const task = getTask(Number(r.lastInsertRowid));
  emit('task.created', { message: `أنشأ مهمة «${task.title}»`, actor, link: `/atlas/tasks/${task.id}`, data: { task } });
  notifyOwner(task, actor);
  return task;
}

function updateTask(taskId, input, actor) {
  const before = getTask(taskId);
  if (!before) throw new ValidationError('المهمة غير موجودة.');
  const t = cleanTask(input, before);
  db.prepare(`UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, due_date = ?, owner_id = ?,
              department_id = ?, client_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(t.title, t.description, t.status, t.priority, t.due_date, t.owner_id, t.department_id, t.client_id,
      t.position, taskId);
  const task = getTask(taskId);
  if (before.status !== task.status) {
    emit('task.status_changed', {
      message: `نقل «${task.title}» إلى ${STATUS_LABEL[task.status]}`, actor, link: `/atlas/tasks/${task.id}`,
      data: { task, from: before.status, to: task.status },
    });
  } else if (['title', 'description', 'priority', 'due_date', 'owner_id', 'client_id', 'department_id']
    .some((k) => before[k] !== task[k])) {
    emit('task.updated', { message: `عدّل مهمة «${task.title}»`, actor, link: `/atlas/tasks/${task.id}`, data: { task, before } });
  }
  if (task.owner_id && before.owner_id !== task.owner_id) notifyOwner(task, actor);
  return task;
}

function deleteTask(taskId, actor) {
  const task = getTask(taskId);
  if (!task) return false;
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  emit('task.deleted', { message: `حذف مهمة «${task.title}»`, actor, data: { task } });
  return true;
}

function cleanClient(input, existing = {}) {
  const c = { ...existing };
  for (const [k, max] of [['name', 200], ['company', 200], ['phone', 40], ['email', 200], ['source', 100], ['notes', 5000]]) {
    if (k in input) c[k] = str(input[k], max);
  }
  if ('stage' in input) c.stage = STAGES.includes(input.stage) ? input.stage : 'lead';
  if ('value' in input) c.value = Math.max(0, Number(input.value) || 0);
  if ('owner_id' in input) c.owner_id = id(input.owner_id);
  if (!c.name) throw new ValidationError('اسم العميل مطلوب.');
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) throw new ValidationError('البريد الإلكتروني غير صالح.');
  return c;
}

function createClient(input, actor) {
  const c = cleanClient({ stage: 'lead', ...input });
  const r = db.prepare(`INSERT INTO clients (name, company, phone, email, stage, value, source, notes, owner_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.name, c.company || '', c.phone || '', c.email || '', c.stage, c.value || 0, c.source || '', c.notes || '',
      c.owner_id || null);
  const client = getClient(Number(r.lastInsertRowid));
  if (client.phone) {
    db.prepare('UPDATE wa_conversations SET client_id = ? WHERE client_id IS NULL AND phone = ?')
      .run(client.id, whatsapp.digits(client.phone));
  }
  emit('client.created', { message: `أضاف العميل «${client.name}»`, actor, link: `/atlas/clients/${client.id}`, data: { client } });
  return client;
}

function updateClient(clientId, input, actor) {
  const before = getClient(clientId);
  if (!before) throw new ValidationError('العميل غير موجود.');
  const c = cleanClient(input, before);
  db.prepare(`UPDATE clients SET name = ?, company = ?, phone = ?, email = ?, stage = ?, value = ?, source = ?, notes = ?,
              owner_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(c.name, c.company, c.phone, c.email, c.stage, c.value, c.source, c.notes, c.owner_id, clientId);
  const client = getClient(clientId);
  if (before.stage !== client.stage) {
    emit('client.stage_changed', {
      message: `نقل العميل «${client.name}» إلى ${STAGE_LABEL[client.stage]}`, actor, link: `/atlas/clients/${client.id}`,
      data: { client, from: before.stage, to: client.stage },
    });
  } else {
    emit('client.updated', { message: `عدّل بيانات العميل «${client.name}»`, actor, link: `/atlas/clients/${client.id}`, data: { client } });
  }
  return client;
}

function deleteClient(clientId, actor) {
  const client = getClient(clientId);
  if (!client) return false;
  db.prepare('DELETE FROM clients WHERE id = ?').run(clientId);
  emit('client.updated', { message: `حذف العميل «${client.name}»`, actor, data: { client, deleted: true } });
  return true;
}

function addInteraction(clientId, input, actor) {
  const client = getClient(clientId);
  if (!client) throw new ValidationError('العميل غير موجود.');
  const body = str(input.body, 5000);
  if (!body) throw new ValidationError('نص التفاعل مطلوب.');
  const kind = INTERACTION_KINDS.includes(input.kind) ? input.kind : 'note';
  const r = db.prepare('INSERT INTO interactions (client_id, kind, body, employee_id) VALUES (?, ?, ?, ?)')
    .run(clientId, kind, body, actor?.id || null);
  db.prepare("UPDATE clients SET updated_at = datetime('now') WHERE id = ?").run(clientId);
  const interaction = { id: Number(r.lastInsertRowid), client_id: clientId, kind, body };
  emit('interaction.created', { message: `سجّل ${kind} مع «${client.name}»`, actor, link: `/atlas/clients/${clientId}`, data: { client, interaction } });
  return interaction;
}

function sharedCanvas() {
  let canvas = db.prepare('SELECT * FROM canvases WHERE owner_id IS NULL ORDER BY id LIMIT 1').get();
  if (!canvas) {
    const r = db.prepare("INSERT INTO canvases (name, owner_id) VALUES ('لوحة الشركة', NULL)").run();
    canvas = db.prepare('SELECT * FROM canvases WHERE id = ?').get(r.lastInsertRowid);
  }
  return canvas;
}

function canAccessCanvas(canvas, user) {
  return Boolean(canvas && (canvas.owner_id === null || canvas.owner_id === user?.id));
}

function createNote(input, actor) {
  const canvas = input.canvas_id ? db.prepare('SELECT * FROM canvases WHERE id = ?').get(id(input.canvas_id)) : sharedCanvas();
  if (!canvas) throw new ValidationError('اللوحة غير موجودة.');
  if (actor && !canAccessCanvas(canvas, actor)) throw new ValidationError('لا تملك صلاحية على هذه اللوحة.');
  const text = str(input.text, 5000);
  if (!text) throw new ValidationError('نص الملاحظة مطلوب.');
  const kind = ['note', 'text', 'section'].includes(input.kind) ? input.kind : 'note';
  const color = COLORS.includes(input.color) ? input.color : 'teal';
  const count = db.prepare('SELECT COUNT(*) AS n FROM canvas_items WHERE canvas_id = ?').get(canvas.id).n;
  const x = Number.isFinite(Number(input.x)) ? Number(input.x) : 80 + (count % 5) * 250;
  const y = Number.isFinite(Number(input.y)) ? Number(input.y) : 80 + Math.floor(count / 5) * 180;
  const r = db.prepare(`INSERT INTO canvas_items (canvas_id, kind, text, x, y, w, h, color, created_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(canvas.id, kind, text, x, y, kind === 'section' ? 520 : 220, kind === 'section' ? 340 : 140, color, actor?.id || null);
  const item = db.prepare('SELECT * FROM canvas_items WHERE id = ?').get(r.lastInsertRowid);
  if (canvas.owner_id === null) {
    emit('note.created', { message: `أضاف ملاحظة على «${canvas.name}»`, actor, link: `/atlas/canvas/${canvas.id}`, data: { canvas, item } });
  }
  return item;
}

/** The "N things wait for you" list on the Atlas home. */
function waitingFor(user) {
  const now = today();
  const items = [];
  const myTasks = db.prepare(`SELECT id, title, due_date FROM tasks
    WHERE owner_id = ? AND status != 'done' AND due_date != '' AND due_date <= ? ORDER BY due_date`).all(user.id, now);
  for (const t of myTasks) {
    items.push({ kind: 'task', text: `${t.due_date < now ? 'متأخرة' : 'اليوم'}: ${t.title}`, link: `/atlas/tasks/${t.id}` });
  }
  const proposals = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE employee_id = ? AND status = 'pending'").get(user.id).n;
  if (proposals) items.push({ kind: 'proposal', text: `${proposals} اقتراح من المستشار بانتظار موافقتك`, link: '/atlas/strategist' });
  const unread = db.prepare('SELECT COALESCE(SUM(unread), 0) AS n FROM wa_conversations').get().n;
  if (unread) items.push({ kind: 'whatsapp', text: `${unread} رسالة واتساب غير مقروءة`, link: '/atlas/inbox' });
  const review = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'review' AND created_by = ?").get(user.id).n;
  if (review) items.push({ kind: 'review', text: `${review} مهمة أنشأتها بانتظار مراجعتك`, link: '/atlas/board?status=review' });
  return items;
}

function overview() {
  const day = today();
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    today: day,
    employees: one('SELECT COUNT(*) AS n FROM employees WHERE is_active = 1'),
    departments: one('SELECT COUNT(*) AS n FROM departments'),
    tasks: Object.fromEntries(TASK_STATUSES.map((s) => [s, one('SELECT COUNT(*) AS n FROM tasks WHERE status = ?', s)])),
    overdue: one("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done' AND due_date != '' AND due_date < ?", day),
    dueToday: one("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done' AND due_date = ?", day),
    clients: Object.fromEntries(STAGES.map((s) => [s, one('SELECT COUNT(*) AS n FROM clients WHERE stage = ?', s)])),
    pipelineValue: db.prepare("SELECT COALESCE(SUM(value), 0) AS n FROM clients WHERE stage NOT IN ('won', 'lost')").get().n,
    wonValue: db.prepare("SELECT COALESCE(SUM(value), 0) AS n FROM clients WHERE stage = 'won'").get().n,
    unreadWhatsapp: one('SELECT COALESCE(SUM(unread), 0) AS n FROM wa_conversations'),
    conversations: one('SELECT COUNT(*) AS n FROM wa_conversations'),
    notes: one('SELECT COUNT(*) AS n FROM canvas_items ci JOIN canvases c ON c.id = ci.canvas_id WHERE c.owner_id IS NULL'),
  };
}

function recentActivity(limit = 30) {
  return db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  ValidationError, today, TIME_ZONE, TASK_STATUSES, PRIORITIES, STAGES, COLORS, INTERACTION_KINDS,
  STATUS_LABEL, STAGE_LABEL, PRIORITY_LABEL,
  getTask, getClient, listTasks, listClients, createTask, updateTask, deleteTask,
  createClient, updateClient, deleteClient, addInteraction, createNote, sharedCanvas, canAccessCanvas,
  waitingFor, overview, recentActivity,
};
