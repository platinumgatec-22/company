// Publishing workflow:
//   owner (أنا) → director (حسون) → manager (موزة, قروب المانجير) → designers (قروب النخبة للتصاميم)
//   → publishers (7 employees, each with their own Instagram + Buffer) → manager sends the
//   publishing report to the director through قروب المانجير.
const express = require('express');
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

const q = {
  roleHolder: db.prepare(`SELECT * FROM employees WHERE workflow_role = ? AND is_active = 1 ORDER BY id LIMIT 1`),
  byRoles: db.prepare(`
    SELECT * FROM employees WHERE is_active = 1 AND workflow_role IN (SELECT value FROM json_each(?))
    ORDER BY CASE workflow_role WHEN 'director' THEN 0 WHEN 'manager' THEN 1 WHEN 'designer' THEN 2 ELSE 3 END, id`),
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
  assignments: db.prepare('SELECT * FROM publish_assignments WHERE request_id = ? ORDER BY id'),
  assignment: db.prepare('SELECT * FROM publish_assignments WHERE id = ? AND request_id = ?'),
  myAssignmentRequests: db.prepare('SELECT request_id FROM publish_assignments WHERE employee_id = ?'),
  messages: db.prepare('SELECT * FROM workflow_messages WHERE request_id = ? ORDER BY id'),
  groupMessages: db.prepare(`
    SELECT m.*, r.title AS request_title FROM workflow_messages m
    JOIN publish_requests r ON r.id = m.request_id
    WHERE m.group_key = ? ORDER BY m.id DESC LIMIT 200`),
  reports: db.prepare(`
    SELECT r.*, c.full_name AS created_by_name FROM publish_requests r
    LEFT JOIN employees c ON c.id = r.created_by
    WHERE r.status = 'reported' ORDER BY r.reported_at DESC`),
  setStatus: db.prepare("UPDATE publish_requests SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"),
  insertMessage: db.prepare(`
    INSERT INTO workflow_messages (request_id, group_key, from_id, from_name, to_label, body)
    VALUES (?, ?, ?, ?, ?, ?)`),
};

const isAdmin = (user) => user.role === 'admin';
const hasRole = (user, ...roles) => isAdmin(user) || roles.includes(user.workflow_role);
const inWorkflow = (user) => isAdmin(user) || Boolean(ROLES[user.workflow_role]);
const holderName = (role, fallback) => q.roleHolder.get(role)?.full_name || fallback;
const fmt = (ts) => String(ts || '').slice(0, 16);
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s);

function canViewRequest(user, r) {
  if (hasRole(user, 'owner', 'director', 'manager')) return true;
  if (user.workflow_role === 'designer') return STATUSES[r.status].step >= STATUSES.in_design.step;
  if (user.workflow_role === 'publisher') {
    return q.myAssignmentRequests.all(user.id).some((a) => a.request_id === r.id);
  }
  return false;
}

function canViewGroup(user, group) {
  return isAdmin(user) || user.workflow_role === 'owner' || group.roles.includes(user.workflow_role);
}

// Requests waiting on this user's role (admins see only what their own workflow role owes).
function inboxFor(user) {
  const role = user.workflow_role;
  const statuses = { director: ['to_director'], manager: ['to_manager', 'published'], designer: ['in_design'] }[role];
  if (statuses) {
    return q.requests.all('', '').filter((r) => statuses.includes(r.status));
  }
  if (role === 'publisher') {
    const mine = new Set(db.prepare(`
      SELECT a.request_id FROM publish_assignments a JOIN publish_requests r ON r.id = a.request_id
      WHERE a.employee_id = ? AND a.published_at = '' AND r.status = 'publishing'`).all(user.id).map((a) => a.request_id));
    return q.requests.all('', '').filter((r) => mine.has(r.id));
  }
  return [];
}

function post(request, groupKey, from, toLabel, body) {
  q.insertMessage.run(request.id, groupKey, from?.id ?? null, from?.full_name ?? 'النظام', toLabel, body);
}

const person = (e) => ({
  id: e.id ?? e.employee_id, name: e.full_name ?? e.employee_name, username: e.username,
  phone: e.phone, instagram: e.instagram_account, buffer_user: e.buffer_user,
});

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

function createWorkflowRouter({ requireAuth, flash, clean, toId }) {
  const router = express.Router();

  const notFound = (res) => res.status(404).render('error', { title: 'غير موجود', message: 'طلب النشر غير موجود.' });
  const forbidden = (res, message = 'هذه الخطوة ليست من صلاحياتك.') => res.status(403).render('error', { title: 'غير مصرح', message });

  router.use(requireAuth, (req, res, next) => {
    if (!inWorkflow(req.user)) return forbidden(res, 'نظام النشر متاح لفريق النشر فقط.');
    res.locals.ROLES = ROLES;
    res.locals.GROUPS = GROUPS;
    res.locals.STATUSES = STATUSES;
    res.locals.fmt = fmt;
    res.locals.hasRole = (...roles) => hasRole(req.user, ...roles);
    res.locals.pipeline = ['الطلب', holderName('director', 'المدير العام'), holderName('manager', 'المانجير'),
      'النخبة للتصاميم', 'النشر', 'التقرير'];
    next();
  });

  // Loads :id and checks the request is at `status` and the user holds one of `roles`.
  const step = (status, roles) => (req, res, next) => {
    const r = q.request.get(toId(req.params.id));
    if (!r || !canViewRequest(req.user, r)) return notFound(res);
    if (!hasRole(req.user, ...roles)) return forbidden(res);
    if (r.status !== status) {
      flash(req, 'error', 'تم تنفيذ هذه الخطوة مسبقاً أو أن الطلب في مرحلة أخرى.');
      return res.redirect(`/workflow/${r.id}`);
    }
    req.request = r;
    next();
  };

  router.get('/', (req, res) => {
    const status = STATUSES[req.query.status] ? req.query.status : '';
    const all = q.requests.all(status, status).filter((r) => canViewRequest(req.user, r));
    res.render('workflow/index', { title: 'سير النشر', requests: all, inbox: inboxFor(req.user), status });
  });

  router.get('/new', (req, res) => {
    if (!hasRole(req.user, 'owner')) return forbidden(res);
    res.render('workflow/new', { title: 'طلب نشر جديد', form: { title: '', brief: '', due_date: '' } });
  });

  router.post('/', (req, res) => {
    if (!hasRole(req.user, 'owner')) return forbidden(res);
    const form = { title: clean(req.body.title), brief: clean(req.body.brief).slice(0, 4000), due_date: clean(req.body.due_date) };
    if (!form.title) {
      res.locals.flash = { type: 'error', message: 'عنوان الطلب مطلوب.' };
      return res.status(400).render('workflow/new', { title: 'طلب نشر جديد', form });
    }
    const id = Number(db.prepare('INSERT INTO publish_requests (title, brief, due_date, created_by) VALUES (?, ?, ?, ?)')
      .run(form.title, form.brief, form.due_date, req.user.id).lastInsertRowid);
    const r = q.request.get(id);
    const director = q.roleHolder.get('director');
    post(r, '', req.user, director?.full_name || ROLES.director,
      `طلب نشر جديد: ${r.title}${r.due_date ? ` — الموعد ${r.due_date}` : ''}\n${r.brief}`.trim());
    notify('request_created', { request: r, to: director ? [person(director)] : [] });
    flash(req, 'success', `تم إرسال الطلب إلى ${director?.full_name || ROLES.director}.`);
    res.redirect(`/workflow/${id}`);
  });

  router.get('/reports', (req, res) => {
    if (!hasRole(req.user, 'owner', 'director', 'manager')) return forbidden(res);
    res.render('workflow/reports', { title: 'تقارير النشر', reports: q.reports.all() });
  });

  router.get('/groups/:key', (req, res) => {
    const group = GROUPS[req.params.key];
    if (!group) return notFound(res);
    if (!canViewGroup(req.user, group)) return forbidden(res, `أنت لست عضواً في ${group.name}.`);
    res.render('workflow/group', {
      title: group.name, group,
      members: q.byRoles.all(JSON.stringify(group.roles)),
      messages: q.groupMessages.all(group.key),
    });
  });

  router.get('/:id', (req, res) => {
    const r = q.request.get(toId(req.params.id));
    if (!r || !canViewRequest(req.user, r)) return notFound(res);
    const assignments = q.assignments.all(r.id);
    res.render('workflow/show', {
      title: `طلب #${r.id}`, r, assignments,
      messages: q.messages.all(r.id),
      publishers: q.publishers.all(),
      myAssignment: assignments.find((a) => a.employee_id === req.user.id) || null,
      reportPreview: r.status === 'published' ? buildReport(r, assignments, '', req.user) : '',
    });
  });

  // حسون → موزة
  router.post('/:id/forward', step('to_director', ['director']), (req, res) => {
    const r = req.request;
    const manager = q.roleHolder.get('manager');
    const note = clean(req.body.note).slice(0, 2000);
    q.setStatus.run('to_manager', r.id);
    post(r, 'managers', req.user, manager?.full_name || ROLES.manager,
      `تحويل طلب النشر "${r.title}" للتنفيذ.${note ? `\n${note}` : ''}`);
    notify('forwarded_to_manager', { request: r, note, group: GROUPS.managers, to: manager ? [person(manager)] : [] });
    flash(req, 'success', `تم تحويل الطلب إلى ${manager?.full_name || ROLES.manager} في قروب المانجير.`);
    res.redirect(`/workflow/${r.id}`);
  });

  // موزة → قروب النخبة للتصاميم (and choose which publishers will post it)
  router.post('/:id/to-design', step('to_manager', ['manager']), (req, res) => {
    const r = req.request;
    const chosen = new Set([].concat(req.body.publishers || []).map(toId));
    const publishers = q.publishers.all().filter((p) => chosen.has(p.id));
    if (publishers.length === 0) {
      flash(req, 'error', 'اختر موظف نشر واحداً على الأقل.');
      return res.redirect(`/workflow/${r.id}`);
    }
    const note = clean(req.body.note).slice(0, 2000);
    const insert = db.prepare(`
      INSERT INTO publish_assignments (request_id, employee_id, employee_name, instagram_account, buffer_user)
      VALUES (?, ?, ?, ?, ?)`);
    db.exec('BEGIN');
    try {
      for (const p of publishers) insert.run(r.id, p.id, p.full_name, p.instagram_account, p.buffer_user);
      q.setStatus.run('in_design', r.id);
      post(r, 'designs', req.user, 'فريق التصاميم',
        `مطلوب تصميم: ${r.title}\n${r.brief}${note ? `\nملاحظات: ${note}` : ''}\n`
        + `سيُنشر على: ${publishers.map((p) => `@${p.instagram_account}`).join('، ')}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    notify('sent_to_design', {
      request: r, note, group: GROUPS.designs,
      to: q.byRoles.all(JSON.stringify(['designer'])).map(person), publishers: publishers.map(person),
    });
    flash(req, 'success', 'تم إرسال الطلب إلى قروب النخبة للتصاميم.');
    res.redirect(`/workflow/${r.id}`);
  });

  // التصاميم → الموظفين للنشر
  router.post('/:id/design', step('in_design', ['designer']), (req, res) => {
    const r = req.request;
    const designUrl = clean(req.body.design_url);
    const caption = clean(req.body.caption).slice(0, 2200); // Instagram caption limit
    if (!isUrl(designUrl)) {
      flash(req, 'error', 'ضع رابط التصميم (يبدأ بـ http أو https).');
      return res.redirect(`/workflow/${r.id}`);
    }
    db.prepare(`UPDATE publish_requests SET design_url = ?, caption = ?, designed_by = ?, status = 'publishing',
                updated_at = datetime('now', 'localtime') WHERE id = ?`).run(designUrl, caption, req.user.id, r.id);
    const assignments = q.assignments.all(r.id);
    post(r, 'designs', req.user, 'موظفو النشر',
      `التصميم جاهز للنشر: ${r.title}\n${designUrl}${caption ? `\nالكابشن:\n${caption}` : ''}\n`
      + `المطلوب النشر من: ${assignments.map((a) => `${a.employee_name} (@${a.instagram_account})`).join('، ')}`);
    notify('design_ready', {
      request: { ...r, design_url: designUrl, caption }, group: GROUPS.designs,
      // Each publisher posts from their own Instagram account through their own Buffer user.
      to: assignments.map(person),
    });
    flash(req, 'success', 'تم إرسال التصميم إلى موظفي النشر.');
    res.redirect(`/workflow/${r.id}`);
  });

  // Each publisher confirms their post; the last one moves the request back to موزة.
  router.post('/:id/assignments/:aid/publish', (req, res) => {
    const r = q.request.get(toId(req.params.id));
    if (!r || !canViewRequest(req.user, r)) return notFound(res);
    const a = q.assignment.get(toId(req.params.aid), r.id);
    if (!a) return notFound(res);
    if (!isAdmin(req.user) && a.employee_id !== req.user.id) return forbidden(res, 'يمكنك تأكيد النشر على حسابك فقط.');
    if (r.status !== 'publishing' || a.published_at) {
      flash(req, 'error', 'تم تأكيد هذا النشر مسبقاً أو أن الطلب ليس في مرحلة النشر.');
      return res.redirect(`/workflow/${r.id}`);
    }
    const postUrl = clean(req.body.post_url);
    if (postUrl && !isUrl(postUrl)) {
      flash(req, 'error', 'رابط المنشور غير صالح.');
      return res.redirect(`/workflow/${r.id}`);
    }
    db.prepare("UPDATE publish_assignments SET post_url = ?, published_at = datetime('now', 'localtime') WHERE id = ?")
      .run(postUrl, a.id);
    post(r, 'designs', req.user, '', `✅ تم النشر على @${a.instagram_account}${postUrl ? `\n${postUrl}` : ''}`);
    notify('post_published', { request: r, publisher: person(a), post_url: postUrl });

    const { pending } = db.prepare("SELECT COUNT(*) AS pending FROM publish_assignments WHERE request_id = ? AND published_at = ''").get(r.id);
    if (pending === 0) {
      q.setStatus.run('published', r.id);
      const manager = q.roleHolder.get('manager');
      post(r, 'managers', null, manager?.full_name || ROLES.manager,
        `تم نشر "${r.title}" على جميع الحسابات. بانتظار إرسال تقرير النشر.`);
      notify('all_published', { request: r, group: GROUPS.managers, to: manager ? [person(manager)] : [] });
    }
    flash(req, 'success', 'تم تأكيد النشر. شكراً!');
    res.redirect(`/workflow/${r.id}`);
  });

  // موزة → حسون: publishing report through قروب المانجير.
  router.post('/:id/report', step('published', ['manager']), (req, res) => {
    const r = req.request;
    const notes = clean(req.body.notes).slice(0, 2000);
    const report = buildReport(r, q.assignments.all(r.id), notes, req.user);
    db.prepare(`UPDATE publish_requests SET report_text = ?, reported_at = datetime('now', 'localtime'),
                status = 'reported', updated_at = datetime('now', 'localtime') WHERE id = ?`).run(report, r.id);
    const director = q.roleHolder.get('director');
    post(r, 'managers', req.user, director?.full_name || ROLES.director, report);
    notify('report_sent', { request: r, group: GROUPS.managers, report, to: director ? [person(director)] : [] });
    flash(req, 'success', `تم إرسال تقرير النشر إلى ${director?.full_name || ROLES.director}.`);
    res.redirect(`/workflow/${r.id}`);
  });

  return router;
}

module.exports = { createWorkflowRouter, inboxFor, inWorkflow, ROLES, GROUPS };
