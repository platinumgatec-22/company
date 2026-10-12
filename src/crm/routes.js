// Sales CRM: dashboard, pipeline board, deals and reports under /crm.
// Customers are Atlas clients (/atlas/clients); a deal's notes live in its client's interactions.
const express = require('express');
const db = require('../db');
const svc = require('../atlas/service');
const m = require('./model');
const deals = require('./service');

module.exports = function crmRouter({ requireAuth, flash, clean, toId }) {
  const router = express.Router();
  router.use(requireAuth);

  const q = {
    clientOptions: db.prepare('SELECT id, name, company FROM clients ORDER BY company, name'),
    salesPeople: db.prepare('SELECT id, full_name FROM employees WHERE is_active = 1 ORDER BY full_name'),
    dealActivities: db.prepare(`
      SELECT i.*, e.full_name AS author_name FROM interactions i
      LEFT JOIN employees e ON e.id = i.employee_id
      WHERE i.deal_id = ? ORDER BY i.created_at DESC, i.id DESC`),
    lastClientContact: db.prepare(`
      SELECT MAX(created_at) AS at FROM interactions WHERE deal_id = ? OR (deal_id IS NULL AND client_id = ?)`),
    recentActivities: db.prepare(`
      SELECT i.*, e.full_name AS author_name, d.title AS deal_title, c.name AS client_name
      FROM interactions i
      LEFT JOIN employees e ON e.id = i.employee_id
      LEFT JOIN crm_deals d ON d.id = i.deal_id
      LEFT JOIN clients c ON c.id = i.client_id
      ORDER BY i.created_at DESC, i.id DESC LIMIT 8`),
    conversation: db.prepare('SELECT id FROM wa_conversations WHERE client_id = ? ORDER BY id LIMIT 1'),
  };

  const canEdit = (user, deal) => user.role === 'admin' || user.is_manager === 1 || deal.owner_id === user.id;
  const notFound = (res, message) => res.status(404).render('error', { title: 'غير موجود', message });
  const forbidden = (res) => res.status(403).render('error', {
    title: 'غير مصرح', message: 'يمكن لمسؤول الصفقة أو رؤساء الأقسام أو مدير النظام فقط تعديلها.',
  });

  router.use((req, res, next) => {
    Object.assign(res.locals, {
      crm: m, canEdit: (deal) => canEdit(req.user, deal), base: res.locals.base || '',
    });
    next();
  });

  // ---------- dashboard ----------
  router.get('/', (req, res) => {
    const all = m.loadDeals();
    const s = m.summary(all, 'quarter');
    const hour = (new Date().getUTCHours() + 3) % 24; // Kuwait time
    res.render('crm/dashboard', {
      title: 'لوحة المبيعات',
      greeting: hour < 12 ? 'صباح الخير' : 'مساء الخير',
      s,
      months: m.monthlyWon(all, 6),
      risks: m.atRisk(all),
      mine: s.open.filter((d) => d.owner_id === req.user.id).slice(0, 5),
      byStage: m.OPEN_STAGES.map((k) => {
        const list = s.open.filter((d) => d.stage === k);
        return { ...m.stageMap[k], count: list.length, value: m.sum(list) };
      }),
      activities: q.recentActivities.all(),
      myTasks: svc.listTasks({ ownerId: req.user.id, limit: 50 }).filter((t) => t.status !== 'done').slice(0, 5),
    });
  });

  // ---------- pipeline ----------
  router.get('/pipeline', (req, res) => {
    const filter = { owner: clean(req.query.owner), type: clean(req.query.type), closing: clean(req.query.closing) };
    const now = m.today();
    const quarterStart = m.summary([], 'quarter').start;
    const list = m.loadDeals().filter((d) => {
      if (filter.owner === 'mine' && d.owner_id !== req.user.id) return false;
      if (filter.type && d.type !== filter.type) return false;
      if (filter.closing && !(d.close_date && m.daysBetween(now, d.close_date) <= 30)) return false;
      // Closed columns only show this quarter so the board does not grow forever.
      if (!m.OPEN_STAGES.includes(d.stage) && d.closed_at.slice(0, 10) < quarterStart) return false;
      return true;
    });
    const riskIds = new Set(m.atRisk(list).map((r) => r.deal.id));
    const open = list.filter((d) => m.OPEN_STAGES.includes(d.stage));
    res.render('crm/pipeline', {
      title: 'خط المبيعات',
      filter,
      columns: m.STAGES.map((st) => {
        const inStage = list.filter((d) => d.stage === st.key);
        return { ...st, deals: inStage, value: m.sum(inStage) };
      }),
      riskIds,
      openValue: m.sum(open),
      openCount: open.length,
    });
  });

  router.post('/deals/:id/stage', (req, res) => {
    const wantsJson = req.is('application/json');
    const deal = deals.getDeal(toId(req.params.id));
    const stage = clean(req.body.stage);
    const fail = (status, error) => (wantsJson ? res.status(status).json({ error }) : (flash(req, 'error', error), res.redirect('/crm/pipeline')));
    if (!deal) return fail(404, 'الصفقة غير موجودة.');
    if (!m.stageMap[stage]) return fail(400, 'مرحلة غير صالحة.');
    if (!canEdit(req.user, deal)) return fail(403, 'لا تملك صلاحية تعديل هذه الصفقة.');

    deals.moveStage(deal, stage, req.user);
    if (wantsJson) return res.json({ ok: true, stage, probability: m.stageMap[stage].probability });
    flash(req, 'success', `نُقلت الصفقة إلى «${m.stageMap[stage].label}».`);
    res.redirect(`/crm/deals/${deal.id}`);
  });

  // ---------- deals ----------
  const formLocals = () => ({ clients: q.clientOptions.all(), people: q.salesPeople.all() });
  const emptyNewClient = { name: '', company: '', phone: '' };

  router.get('/deals/new', (req, res) => {
    const stage = m.stageMap[clean(req.query.stage)] ? clean(req.query.stage) : 'lead';
    res.render('crm/deal-form', {
      title: 'صفقة جديدة',
      deal: {
        id: 0, title: '', client_id: toId(req.query.client), type: 'sponsorship', stage, value: '',
        probability: m.stageMap[stage].probability, close_date: m.addDays(m.today(), 30),
        owner_id: req.user.id, source: 'instagram', lost_reason: '',
      },
      newClient: emptyNewClient,
      ...formLocals(),
    });
  });

  router.get('/deals/:id', (req, res) => {
    const deal = deals.getDeal(toId(req.params.id));
    if (!deal) return notFound(res, 'الصفقة غير موجودة.');
    const lastContact = q.lastClientContact.get(deal.id, deal.client_id)?.at;
    res.render('crm/deal', {
      title: deal.title,
      deal,
      risk: m.atRisk([{ ...deal, last_activity_at: lastContact }])[0],
      activities: q.dealActivities.all(deal.id),
      tasks: deal.client_id ? svc.listTasks({ clientId: deal.client_id, limit: 20 }) : [],
      conversation: deal.client_id ? q.conversation.get(deal.client_id) : null,
      otherDeals: deal.client_id
        ? db.prepare('SELECT id, title, type, stage, value FROM crm_deals WHERE client_id = ? AND id != ? ORDER BY created_at DESC')
          .all(deal.client_id, deal.id)
        : [],
      statusLabel: svc.STATUS_LABEL,
    });
  });

  router.get('/deals/:id/edit', (req, res) => {
    const deal = deals.getDeal(toId(req.params.id));
    if (!deal) return notFound(res, 'الصفقة غير موجودة.');
    if (!canEdit(req.user, deal)) return forbidden(res);
    res.render('crm/deal-form', { title: 'تعديل صفقة', deal, newClient: emptyNewClient, ...formLocals() });
  });

  function saveDeal(req, res) {
    const id = toId(req.params.id);
    const existing = id ? deals.getDeal(id) : null;
    if (id && !existing) return notFound(res, 'الصفقة غير موجودة.');
    if (existing && !canEdit(req.user, existing)) return forbidden(res);

    const b = req.body;
    const stage = m.stageMap[b.stage] ? b.stage : 'lead';
    const probability = Math.min(100, Math.max(0, Math.round(Number(b.probability))));
    const deal = {
      id,
      title: clean(b.title),
      client_id: toId(b.client_id) || null,
      type: m.typeMap[b.type] ? b.type : 'sponsorship',
      stage,
      value: Math.max(0, Number(b.value) || 0),
      probability: Number.isFinite(probability) ? probability : m.stageMap[stage].probability,
      close_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(b.close_date)) ? clean(b.close_date) : '',
      owner_id: toId(b.owner_id) || req.user.id,
      source: m.sourceMap[b.source] ? b.source : 'other',
      lost_reason: stage === 'lost' ? clean(b.lost_reason).slice(0, 300) : '',
    };
    const newClient = { name: clean(b.new_client_name), company: clean(b.new_client_company), phone: clean(b.new_client_phone) };
    const render = (message) => {
      res.locals.flash = { type: 'error', message };
      res.status(400).render('crm/deal-form', { title: id ? 'تعديل صفقة' : 'صفقة جديدة', deal, newClient, ...formLocals() });
    };
    if (!deal.title) return render('اسم الصفقة مطلوب.');
    if (deal.client_id && !svc.getClient(deal.client_id)) return render('العميل غير موجود.');
    if (!deal.client_id && !newClient.name) return render('اختر عميلاً أو أضف عميلاً جديداً.');

    db.exec('BEGIN');
    let saved;
    try {
      if (!deal.client_id) {
        // A new customer goes into the shared Atlas client list (and is matched to its WhatsApp chat).
        deal.client_id = svc.createClient({
          ...newClient, source: m.sourceMap[deal.source].label, owner_id: deal.owner_id,
        }, req.user).id;
      }
      saved = existing ? deals.updateDeal(existing, deal, req.user) : deals.createDeal(deal, req.user);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      if (err instanceof svc.ValidationError) return render(err.message);
      throw err;
    }
    flash(req, 'success', id ? 'تم تحديث الصفقة.' : 'تمت إضافة الصفقة.');
    res.redirect(`/crm/deals/${saved.id}`);
  }

  router.post('/deals', saveDeal);
  router.post('/deals/:id', saveDeal);

  router.post('/deals/:id/delete', (req, res) => {
    const deal = deals.getDeal(toId(req.params.id));
    if (!deal) return notFound(res, 'الصفقة غير موجودة.');
    if (!canEdit(req.user, deal)) return forbidden(res);
    deals.deleteDeal(deal, req.user);
    flash(req, 'success', 'تم حذف الصفقة.');
    res.redirect('/crm/pipeline');
  });

  router.post('/deals/:id/activities', (req, res) => {
    const deal = deals.getDeal(toId(req.params.id));
    if (!deal) return notFound(res, 'الصفقة غير موجودة.');
    const body = clean(req.body.body).slice(0, 1000);
    const kind = m.ACTIVITY_KINDS.some((k) => k.key === req.body.kind) ? req.body.kind : 'note';
    if (!deal.client_id) flash(req, 'error', 'اربط الصفقة بعميل أولاً لتسجيل النشاط.');
    else if (body) deals.addNote(deal, kind, body, req.user);
    res.redirect(`/crm/deals/${deal.id}#activity`);
  });

  // The first version had its own contact list; customers now live in Atlas.
  router.get(['/contacts', '/contacts/*rest'], (req, res) => res.redirect('/atlas/clients'));

  // ---------- reports ----------
  router.get('/reports', (req, res) => {
    const period = ['month', 'quarter', 'year'].includes(req.query.period) ? req.query.period : 'quarter';
    const all = m.loadDeals();
    const s = m.summary(all, period);
    res.render('crm/reports', {
      title: 'التقارير',
      period,
      s,
      months: m.monthlyWon(all, period === 'year' ? 12 : 6),
      byType: m.groupBy(s.won, (d) => d.type, (k) => `${m.typeMap[k].icon} ${m.typeMap[k].label}`),
      bySource: m.groupBy(s.won, (d) => d.source, (k) => m.sourceMap[k].label),
      byOwner: m.groupBy(s.won, (d) => d.owner_name || '—', (k) => k),
      pipeline: m.groupBy(s.open, (d) => d.stage, (k) => m.stageMap[k].label)
        .sort((a, b) => m.OPEN_STAGES.indexOf(a.key) - m.OPEN_STAGES.indexOf(b.key)),
    });
  });

  return router;
};
