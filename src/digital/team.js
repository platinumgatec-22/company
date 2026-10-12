// The digital team: which sections of the site each department works in, and what each
// employee has done there, gathered from every part of the site in one place.
const db = require('../db');
const svc = require('../atlas/service');
const crm = require('../crm/model');
const appdata = require('../appdata');

const SECTIONS = {
  dashboard: { label: 'المدار', href: '/atlas', icon: '◉' },
  tasks: { label: 'المهام', href: '/atlas/board', icon: '✅' },
  calendar: { label: 'التقويم', href: '/atlas/calendar', icon: '📅' },
  canvas: { label: 'اللوحات', href: '/atlas/canvas', icon: '🧩' },
  clients: { label: 'العملاء', href: '/atlas/clients', icon: '👥' },
  whatsapp: { label: 'واتساب', href: '/atlas/inbox', icon: '💬' },
  sales: { label: 'المبيعات', href: '/crm', icon: '💼' },
  workflow: { label: 'سير النشر', href: '/workflow', icon: '📣' },
  tournaments: { label: 'لوحة البطولات', href: '/apps/tournaments', icon: '🏆' },
  invoices: { label: 'الفواتير', href: '/apps/invoices', icon: '🧾' },
  decisions: { label: 'بوابة القرارات', href: '/apps/decisions', icon: '🗳️' },
  activity: { label: 'النشاط', href: '/atlas/activity', icon: '〰️' },
};

// Department (by its name in seed.js) → the sections its people work in.
const BY_DEPARTMENT = {
  'المكتب التنفيذي': ['dashboard', 'tasks', 'calendar', 'clients', 'sales', 'whatsapp', 'workflow', 'tournaments', 'invoices', 'decisions', 'activity'],
  'البطولات والعمليات': ['tournaments', 'tasks', 'calendar', 'clients'],
  'خدمة العملاء': ['whatsapp', 'clients', 'tournaments', 'sales', 'tasks'],
  'الرعايات والمبيعات': ['sales', 'clients', 'tournaments', 'whatsapp', 'tasks'],
  'التسويق والمحتوى': ['workflow', 'canvas', 'tasks', 'calendar'],
  'فريق النخبة للنشر والتصاميم': ['workflow', 'tasks'],
  'الإدارة المالية': ['invoices', 'tournaments', 'sales', 'tasks', 'decisions'],
  'الإدارة القانونية': ['tasks', 'decisions', 'clients'],
};

const sectionsFor = (departmentName) => (BY_DEPARTMENT[departmentName] || ['tasks']).map((k) => ({ key: k, ...SECTIONS[k] }));

const q = {
  digital: db.prepare(`
    SELECT e.id, e.full_name, e.username, e.job_title, e.is_manager, e.department_id, d.name AS department_name, d.icon AS department_icon
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.is_active = 1 AND e.is_digital = 1 ORDER BY d.id, e.is_manager DESC, e.full_name`),
  waSent: db.prepare("SELECT COUNT(*) AS n FROM wa_messages WHERE sender_id = ? AND direction = 'out'"),
  conversations: db.prepare(`
    SELECT w.id, w.name, w.phone, w.last_message_at, c.name AS client_name,
           (SELECT body FROM wa_messages m WHERE m.conversation_id = w.id ORDER BY m.id DESC LIMIT 1) AS last_body
    FROM wa_conversations w LEFT JOIN clients c ON c.id = w.client_id
    WHERE EXISTS (SELECT 1 FROM wa_messages m WHERE m.conversation_id = w.id AND m.sender_id = ?)
    ORDER BY w.last_message_at DESC LIMIT 6`),
  activity: db.prepare('SELECT * FROM activity WHERE employee_id = ? ORDER BY id DESC LIMIT ?'),
  lastActivity: db.prepare('SELECT MAX(created_at) AS at FROM activity WHERE employee_id = ?'),
  interactions: db.prepare('SELECT COUNT(*) AS n FROM interactions WHERE employee_id = ?'),
};

// Invoices and team registrations the employee issued in the apps (records carry createdById).
function appRecords(employeeId) {
  const mine = (rows) => rows.filter((r) => r.createdById === employeeId);
  return {
    invoices: mine(appdata.list('invoices', 'invoices')),
    registrations: mine(appdata.list('tournaments', 'teams')),
  };
}

function counts(employee) {
  const deals = crm.loadDeals().filter((d) => d.owner_id === employee.id);
  const open = deals.filter((d) => crm.OPEN_STAGES.includes(d.stage));
  const tasks = svc.listTasks({ ownerId: employee.id, limit: 500 });
  const apps = appRecords(employee.id);
  return {
    openDeals: open.length,
    openValue: crm.sum(open),
    wonValue: crm.sum(deals.filter((d) => d.stage === 'won')),
    openTasks: tasks.filter((t) => t.status !== 'done').length,
    doneTasks: tasks.filter((t) => t.status === 'done').length,
    whatsapp: q.waSent.get(employee.id).n,
    interactions: q.interactions.get(employee.id).n,
    invoices: apps.invoices.length,
    registrations: apps.registrations.length,
    lastActivity: q.lastActivity.get(employee.id).at || '',
  };
}

// The digital team grouped by department, each with its sections and work counts.
function overview() {
  const groups = new Map();
  for (const e of q.digital.all()) {
    const key = e.department_name || 'بدون قسم';
    if (!groups.has(key)) {
      groups.set(key, { name: key, icon: e.department_icon || '🏢', id: e.department_id, sections: sectionsFor(key), people: [] });
    }
    groups.get(key).people.push({ ...e, counts: counts(e) });
  }
  return [...groups.values()];
}

// Everything one employee has done, for their page.
function workOf(employee) {
  return {
    sections: sectionsFor(employee.department_name),
    counts: counts(employee),
    conversations: q.conversations.all(employee.id),
    activity: q.activity.all(employee.id, 12),
    ...appRecords(employee.id),
  };
}

module.exports = { SECTIONS, sectionsFor, overview, workOf };
