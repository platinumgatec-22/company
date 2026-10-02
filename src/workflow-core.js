// Publishing workflow state machine, shared by the web routes (human employees) and
// src/agents.js (digital employees):
//   owner (أنا) → director (حسون) → manager (موزة, قروب المانجير) → designers (قروب النخبة للتصاميم)
//   → publishers (7 employees, each with their own Instagram + Buffer) → manager sends the
//   publishing report to the director through قروب المانجير.
const { EventEmitter } = require('node:events');
const db = require('./db');
const { notify } = require('./notify');

const ROLES = {
  owner: 'صاحب الطلبات',
  director: 'المدير العام',
  manager: 'المانجير',
  designer: 'مصمم',
  publisher: 'موظف نشر',
};

const GROUPS = {
  managers: { key: 'managers', name: 'قروب المانجير', icon: '🧭', roles: ['manager', 'director'] },
  designs: { key: 'designs', name: 'قروب النخبة للتصاميم', icon: '🎨', roles: ['manager', 'designer', 'publisher'] },
};

const STATUSES = {
  to_director: { step: 1, label: 'عند المدير العام' },
  to_manager: { step: 2, label: 'عند المانجير' },
  in_design: { step: 3, label: 'في قروب التصاميم' },
  publishing: { step: 4, label: 'قيد النشر' },
  published: { step: 5, label: 'تم النشر — بانتظار التقرير' },
  reported: { step: 6, label: 'تم إرسال التقرير' },
};

// Emits 'changed' (requestId) after every step so digital employees can pick up their work.
const events = new EventEmitter();

class StepError extends Error {}

const q = {
  roleHolder: db.prepare(`SELECT * FROM employees WHERE workflow_role = ? AND is_active = 1 ORDER BY id LIMIT 1`),
  byRoles: db.prepare(`
    SELECT * FROM employees WHERE is_active = 1 AND workflow_role IN (SELECT value FROM json_each(?))
    ORDER BY CASE workflow_role WHEN 'director' THEN 0 WHEN 'manager' THEN 1 WHEN 'designer' THEN 2 ELSE 3 END, id`),
  employee: db.prepare('SELECT * FROM employees WHERE id = ?'),
  publishers: db.prepare(`SELECT * FROM employees WHERE is_active = 1 AND workflow_role = 'publisher' ORDER BY id`),
  request: db.prepare(`
    SELECT r.*, c.full_name AS created_by_name, d.full_name AS designed_by_name
    FROM publish_requests r
    LEFT JOIN employees c ON c.id = r.created_by
    LEFT JOIN employees d ON d.id = r.designed_by
    WHERE r.id = ?`),
  requests: db.prepare(`
    SELECT r.*, c.full_name AS created_by_name,
           (SELECT COUNT(*) FROM publish_assignments a WHERE a.request_id = r.id) AS assigned,
           (SELECT COUNT(*) FROM publish_assignments a WHERE a.request_id = r.id AND a.published_at <> '') AS done
    FROM publish_requests r LEFT JOIN employees c ON c.id = r.created_by
    WHERE (? = '' OR r.status = ?)
    ORDER BY r.id DESC`),
  openRequestIds: db.prepare("SELECT id FROM publish_requests WHERE status <> 'reported' ORDER BY id"),
  assignments: db.prepare(`
    SELECT a.*, COALESCE(e.is_digital, 0) AS is_digital FROM publish_assignments a
    LEFT JOIN employees e ON e.id = a.employee_id WHERE a.request_id = ? ORDER BY a.id`),
  assignment: db.prepare('SELECT * FROM publish_assignments WHERE id = ?'),
  myAssignmentRequests: db.prepare('SELECT request_id FROM publish_assignments WHERE employee_id = ?'),
  messages: db.prepare(`
    SELECT m.*, COALESCE(e.is_digital, 0) AS is_digital FROM workflow_messages m
    LEFT JOIN employees e ON e.id = m.from_id WHERE m.request_id = ? ORDER BY m.id`),
  groupMessages: db.prepare(`
    SELECT m.*, r.title AS request_title, COALESCE(e.is_digital, 0) AS is_digital FROM workflow_messages m
    JOIN publish_requests r ON r.id = m.request_id
    LEFT JOIN employees e ON e.id = m.from_id
    WHERE m.group_key = ? ORDER BY m.id DESC LIMIT 200`),
  reports: db.prepare(`
    SELECT r.*, c.full_name AS created_by_name FROM publish_requests r
    LEFT JOIN employees c ON c.id = r.created_by
    WHERE r.status = 'reported' ORDER BY r.reported_at DESC`),
  // Moves a request on only if it is still at the expected step (guards double submits and races).
  advance: db.prepare(`UPDATE publish_requests SET status = ?, updated_at = datetime('now', 'localtime')
                       WHERE id = ? AND status = ?`),
  insertMessage: db.prepare(`
    INSERT INTO workflow_messages (request_id, group_key, from_id, from_name, to_label, body)
    VALUES (?, ?, ?, ?, ?, ?)`),
};

const fmt = (ts) => String(ts || '').slice(0, 16);
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s);
const holderName = (role) => q.roleHolder.get(role)?.full_name || ROLES[role];

function post(request, groupKey, from, toLabel, body) {
  q.insertMessage.run(request.id, groupKey, from?.id ?? null, from?.full_name ?? 'النظام', toLabel, body);
}

const person = (e) => ({
  id: e.id ?? e.employee_id, name: e.full_name ?? e.employee_name, username: e.username,
  phone: e.phone, instagram: e.instagram_account, buffer_user: e.buffer_user, buffer_profile_id: e.buffer_profile_id,
});

function advance(r, from, to) {
  if (q.advance.run(to, r.id, from).changes === 0) {
    throw new StepError('تم تنفيذ هذه الخطوة مسبقاً أو أن الطلب في مرحلة أخرى.');
  }
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function buildReport(r, assignments, notes, manager) {
  const lines = [
    `📊 تقرير النشر — طلب #${r.id}: ${r.title}`,
    `صاحب الطلب: ${r.created_by_name || '—'} | تاريخ الطلب: ${fmt(r.created_at)}`,
    `التصميم: ${r.design_url || '—'}${r.designed_by_name ? ` (المصمم: ${r.designed_by_name})` : ''}`,
    `تم النشر على ${assignments.filter((a) => a.published_at).length} من ${assignments.length} حسابات:`,
    ...assignments.map((a, i) => `${i + 1}. ${a.employee_name} — إنستقرام @${a.instagram_account || '—'}`
      + ` (Buffer: ${a.buffer_user || '—'}) — ${a.published_at ? `نُشر ${fmt(a.published_at)}` : 'لم يُنشر'}`
      + `${a.post_url ? ` — ${a.post_url}` : ''}`),
  ];
  if (notes) lines.push(`ملاحظات ${manager.full_name}: ${notes}`);
  return lines.join('\n');
}

// ---------- steps ----------
// Each step validates, moves the request on, posts the hand-off to its group and notifies the webhook.

function createRequest(owner, { title, brief, due_date: dueDate }) {
  if (!title) throw new StepError('عنوان الطلب مطلوب.');
  const id = Number(db.prepare('INSERT INTO publish_requests (title, brief, due_date, created_by) VALUES (?, ?, ?, ?)')
    .run(title, brief, dueDate, owner.id).lastInsertRowid);
  const r = q.request.get(id);
  const director = q.roleHolder.get('director');
  post(r, '', owner, holderName('director'),
    `طلب نشر جديد: ${r.title}${r.due_date ? ` — الموعد ${r.due_date}` : ''}\n${r.brief}`.trim());
  notify('request_created', { request: r, to: director ? [person(director)] : [] });
  events.emit('changed', id);
  return r;
}

// حسون → موزة
function forward(r, actor, note) {
  const manager = q.roleHolder.get('manager');
  transaction(() => {
    advance(r, 'to_director', 'to_manager');
    post(r, 'managers', actor, holderName('manager'), `تحويل طلب النشر "${r.title}" للتنفيذ.${note ? `\n${note}` : ''}`);
  });
  notify('forwarded_to_manager', { request: r, note, group: GROUPS.managers, to: manager ? [person(manager)] : [] });
  events.emit('changed', r.id);
}

// موزة → قروب النخبة للتصاميم (and the publishers who will post it)
function toDesign(r, actor, publisherIds, note) {
  const chosen = new Set(publisherIds);
  const publishers = q.publishers.all().filter((p) => chosen.has(p.id));
  if (publishers.length === 0) throw new StepError('اختر موظف نشر واحداً على الأقل.');
  const insert = db.prepare(`
    INSERT INTO publish_assignments (request_id, employee_id, employee_name, instagram_account, buffer_user, buffer_profile_id)
    VALUES (?, ?, ?, ?, ?, ?)`);
  transaction(() => {
    advance(r, 'to_manager', 'in_design');
    for (const p of publishers) insert.run(r.id, p.id, p.full_name, p.instagram_account, p.buffer_user, p.buffer_profile_id);
    post(r, 'designs', actor, 'فريق التصاميم',
      `مطلوب تصميم: ${r.title}\n${r.brief}${note ? `\nملاحظات: ${note}` : ''}\n`
      + `سيُنشر على: ${publishers.map((p) => `@${p.instagram_account}`).join('، ')}`);
  });
  notify('sent_to_design', {
    request: r, note, group: GROUPS.designs,
    to: q.byRoles.all(JSON.stringify(['designer'])).map(person), publishers: publishers.map(person),
  });
  events.emit('changed', r.id);
}

// التصاميم → الموظفين للنشر
function deliverDesign(r, actor, designUrl, caption) {
  if (!isUrl(designUrl)) throw new StepError('ضع رابط التصميم (يبدأ بـ http أو https).');
  transaction(() => {
    advance(r, 'in_design', 'publishing');
    db.prepare('UPDATE publish_requests SET design_url = ?, caption = ?, designed_by = ? WHERE id = ?')
      .run(designUrl, caption, actor?.id ?? null, r.id);
    const assignments = q.assignments.all(r.id);
    post(r, 'designs', actor, 'موظفو النشر',
      `التصميم جاهز للنشر: ${r.title}\n${designUrl}${caption ? `\nالكابشن:\n${caption}` : ''}\n`
      + `المطلوب النشر من: ${assignments.map((a) => `${a.employee_name} (@${a.instagram_account})`).join('، ')}`);
  });
  notify('design_ready', {
    request: { ...r, design_url: designUrl, caption }, group: GROUPS.designs,
    to: q.assignments.all(r.id).map(person),
  });
  events.emit('changed', r.id);
}

// One publisher confirms their post; the last one moves the request back to موزة.
function markPublished(r, a, actor, postUrl) {
  if (postUrl && !isUrl(postUrl)) throw new StepError('رابط المنشور غير صالح.');
  if (r.status !== 'publishing' || a.published_at) {
    throw new StepError('تم تأكيد هذا النشر مسبقاً أو أن الطلب ليس في مرحلة النشر.');
  }
  const allDone = transaction(() => {
    const { changes } = db.prepare(`UPDATE publish_assignments SET post_url = ?, published_at = datetime('now', 'localtime')
                                    WHERE id = ? AND published_at = ''`).run(postUrl, a.id);
    if (changes === 0) throw new StepError('تم تأكيد هذا النشر مسبقاً.');
    post(r, 'designs', actor, '', `✅ تم النشر على @${a.instagram_account}${postUrl ? `\n${postUrl}` : ''}`);
    const { pending } = db.prepare("SELECT COUNT(*) AS pending FROM publish_assignments WHERE request_id = ? AND published_at = ''").get(r.id);
    if (pending > 0) return false;
    advance(r, 'publishing', 'published');
    post(r, 'managers', null, holderName('manager'), `تم نشر "${r.title}" على جميع الحسابات. بانتظار إرسال تقرير النشر.`);
    return true;
  });
  notify('post_published', { request: r, publisher: person(a), post_url: postUrl });
  if (allDone) {
    const manager = q.roleHolder.get('manager');
    notify('all_published', { request: r, group: GROUPS.managers, to: manager ? [person(manager)] : [] });
  }
  events.emit('changed', r.id);
}

// موزة → حسون: the publishing report, through قروب المانجير.
function sendReport(r, actor, notes) {
  const report = buildReport(r, q.assignments.all(r.id), notes, actor);
  transaction(() => {
    advance(r, 'published', 'reported');
    db.prepare("UPDATE publish_requests SET report_text = ?, reported_at = datetime('now', 'localtime') WHERE id = ?")
      .run(report, r.id);
    post(r, 'managers', actor, holderName('director'), report);
  });
  const director = q.roleHolder.get('director');
  notify('report_sent', { request: r, group: GROUPS.managers, report, to: director ? [person(director)] : [] });
  events.emit('changed', r.id);
}

module.exports = {
  ROLES, GROUPS, STATUSES, StepError, events, q, fmt, isUrl, holderName, post, person, buildReport,
  createRequest, forward, toDesign, deliverDesign, markPublished, sendReport,
};
