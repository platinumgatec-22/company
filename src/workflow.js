// Web routes of the publishing workflow (see src/workflow-core.js for the steps themselves).
const express = require('express');
const db = require('./db');
const core = require('./workflow-core');

const { ROLES, GROUPS, STATUSES, StepError, q, fmt, holderName } = core;

const isAdmin = (user) => user.role === 'admin';
const hasRole = (user, ...roles) => isAdmin(user) || roles.includes(user.workflow_role);
const inWorkflow = (user) => isAdmin(user) || Boolean(ROLES[user.workflow_role]);

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

function createWorkflowRouter({ requireAuth, flash, clean, toId }) {
  const router = express.Router();

  const notFound = (res) => res.status(404).render('error', { title: 'غير موجود', message: 'طلب النشر غير موجود.' });
  const forbidden = (res, message = 'هذه الخطوة ليست من صلاحياتك.') => res.status(403).render('error', { title: 'غير مصرح', message });

  // Runs a step and turns validation errors into a flash message.
  const run = (req, res, r, success, fn) => {
    try {
      fn();
      flash(req, 'success', success);
    } catch (err) {
      if (!(err instanceof StepError)) throw err;
      flash(req, 'error', err.message);
    }
    res.redirect(`/workflow/${r.id}`);
  };

  router.use(requireAuth, (req, res, next) => {
    if (!inWorkflow(req.user)) return forbidden(res, 'نظام النشر متاح لفريق النشر فقط.');
    res.locals.ROLES = ROLES;
    res.locals.GROUPS = GROUPS;
    res.locals.STATUSES = STATUSES;
    res.locals.fmt = fmt;
    res.locals.hasRole = (...roles) => hasRole(req.user, ...roles);
    res.locals.pipeline = ['الطلب', holderName('director'), holderName('manager'), 'النخبة للتصاميم', 'النشر', 'التقرير'];
    next();
  });

  // Loads :id and checks the user holds one of `roles` for this step.
  const step = (roles) => (req, res, next) => {
    const r = q.request.get(toId(req.params.id));
    if (!r || !canViewRequest(req.user, r)) return notFound(res);
    if (!hasRole(req.user, ...roles)) return forbidden(res);
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
    try {
      const r = core.createRequest(req.user, form);
      flash(req, 'success', `تم إرسال الطلب إلى ${holderName('director')}.`);
      res.redirect(`/workflow/${r.id}`);
    } catch (err) {
      if (!(err instanceof StepError)) throw err;
      res.locals.flash = { type: 'error', message: err.message };
      res.status(400).render('workflow/new', { title: 'طلب نشر جديد', form });
    }
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
      reportPreview: r.status === 'published' ? core.buildReport(r, assignments, '', req.user) : '',
    });
  });

  router.post('/:id/forward', step(['director']), (req, res) => {
    run(req, res, req.request, `تم تحويل الطلب إلى ${holderName('manager')} في قروب المانجير.`,
      () => core.forward(req.request, req.user, clean(req.body.note).slice(0, 2000)));
  });

  router.post('/:id/to-design', step(['manager']), (req, res) => {
    run(req, res, req.request, 'تم إرسال الطلب إلى قروب النخبة للتصاميم.',
      () => core.toDesign(req.request, req.user, [].concat(req.body.publishers || []).map(toId),
        clean(req.body.note).slice(0, 2000)));
  });

  router.post('/:id/design', step(['designer']), (req, res) => {
    run(req, res, req.request, 'تم إرسال التصميم إلى موظفي النشر.',
      // 2200 = Instagram caption limit
      () => core.deliverDesign(req.request, req.user, clean(req.body.design_url), clean(req.body.caption).slice(0, 2200)));
  });

  router.post('/:id/assignments/:aid/publish', (req, res) => {
    const r = q.request.get(toId(req.params.id));
    if (!r || !canViewRequest(req.user, r)) return notFound(res);
    const a = q.assignment.get(toId(req.params.aid));
    if (!a || a.request_id !== r.id) return notFound(res);
    if (!isAdmin(req.user) && a.employee_id !== req.user.id) return forbidden(res, 'يمكنك تأكيد النشر على حسابك فقط.');
    run(req, res, r, 'تم تأكيد النشر. شكراً!', () => core.markPublished(r, a, req.user, clean(req.body.post_url)));
  });

  router.post('/:id/report', step(['manager']), (req, res) => {
    run(req, res, req.request, `تم إرسال تقرير النشر إلى ${holderName('director')}.`,
      () => core.sendReport(req.request, req.user, clean(req.body.notes).slice(0, 2000)));
  });

  return router;
}

module.exports = { createWorkflowRouter, inboxFor, inWorkflow, ROLES, GROUPS };
