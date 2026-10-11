// Sales CRM: dashboard, pipeline board, deals, contacts and reports under /crm.
const express = require('express');
const db = require('../db');
const m = require('./model');

module.exports = function crmRouter({ requireAuth, flash, clean, toId }) {
  const router = express.Router();
  router.use(requireAuth);
  router.use(express.json());

  const q = {
    dealById: db.prepare(`
      SELECT d.*, c.full_name AS contact_name, c.company AS company, c.email AS contact_email,
             c.phone AS contact_phone, e.full_name AS owner_name
      FROM crm_deals d
      LEFT JOIN crm_contacts c ON c.id = d.contact_id
      LEFT JOIN employees e ON e.id = d.owner_id
      WHERE d.id = ?`),
    contacts: db.prepare(`
      SELECT c.*, e.full_name AS owner_name,
             (SELECT COUNT(*) FROM crm_deals d WHERE d.contact_id = c.id) AS deal_count,
             (SELECT COALESCE(SUM(value), 0) FROM crm_deals d
               WHERE d.contact_id = c.id AND d.stage IN ('lead','contacted','proposal','negotiation')) AS open_value,
             (SELECT COALESCE(SUM(value), 0) FROM crm_deals d WHERE d.contact_id = c.id AND d.stage = 'won') AS won_value
      FROM crm_contacts c LEFT JOIN employees e ON e.id = c.owner_id
      WHERE (? = '' OR c.full_name LIKE ? OR c.company LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)
      ORDER BY c.company, c.full_name`),
    contactById: db.prepare(`
      SELECT c.*, e.full_name AS owner_name FROM crm_contacts c
      LEFT JOIN employees e ON e.id = c.owner_id WHERE c.id = ?`),
    contactOptions: db.prepare('SELECT id, full_name, company FROM crm_contacts ORDER BY company, full_name'),
    dealsForContact: db.prepare('SELECT * FROM crm_deals WHERE contact_id = ? ORDER BY created_at DESC'),
    salesPeople: db.prepare('SELECT id, full_name FROM employees WHERE is_active = 1 ORDER BY full_name'),
    dealActivities: db.prepare(`
      SELECT a.*, e.full_name AS author_name FROM crm_activities a
      LEFT JOIN employees e ON e.id = a.author_id
      WHERE a.deal_id = ? ORDER BY a.created_at DESC, a.id DESC`),
    contactActivities: db.prepare(`
      SELECT a.*, e.full_name AS author_name, d.title AS deal_title FROM crm_activities a
      LEFT JOIN employees e ON e.id = a.author_id
      LEFT JOIN crm_deals d ON d.id = a.deal_id
      WHERE a.contact_id = ? OR a.deal_id IN (SELECT id FROM crm_deals WHERE contact_id = ?)
      ORDER BY a.created_at DESC, a.id DESC`),
    recentActivities: db.prepare(`
      SELECT a.*, e.full_name AS author_name, d.title AS deal_title, c.full_name AS contact_name
      FROM crm_activities a
      LEFT JOIN employees e ON e.id = a.author_id
      LEFT JOIN crm_deals d ON d.id = a.deal_id
      LEFT JOIN crm_contacts c ON c.id = a.contact_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT 8`),
    addActivity: db.prepare(`
      INSERT INTO crm_activities (deal_id, contact_id, author_id, kind, body) VALUES (?, ?, ?, ?, ?)`),
  };

  const canEdit = (user, deal) => user.role === 'admin' || user.is_manager === 1 || deal.owner_id === user.id;
  const notFound = (res, message) => res.status(404).render('error', { title: 'غير موجود', message });
  const forbidden = (res) => res.status(403).render('error', {
    title: 'غير مصرح', message: 'يمكن لمسؤول الصفقة أو رؤساء الأقسام أو مدير النظام فقط تعديلها.',
  });

  router.use((req, res, next) => {
    Object.assign(res.locals, {
      crm: m, canEdit: (deal) => canEdit(req.user, deal),
    });
    next();
  });

  // ---------- dashboard ----------
  router.get('/', (req, res) => {
    const deals = m.loadDeals();
    const s = m.summary(deals, 'quarter');
    const hour = (new Date().getUTCHours() + 3) % 24; // Kuwait time
    res.render('crm/dashboard', {
      title: 'لوحة المبيعات',
      greeting: hour < 12 ? 'صباح الخير' : 'مساء الخير',
      s,
      months: m.monthlyWon(deals, 6),
      risks: m.atRisk(deals),
      mine: s.open.filter((d) => d.owner_id === req.user.id).slice(0, 5),
      byStage: m.OPEN_STAGES.map((k) => {
        const list = s.open.filter((d) => d.stage === k);
        return { ...m.stageMap[k], count: list.length, value: m.sum(list) };
      }),
      activities: q.recentActivities.all(),
    });
  });

  // ---------- pipeline ----------
  router.get('/pipeline', (req, res) => {
    const filter = { owner: clean(req.query.owner), type: clean(req.query.type), closing: clean(req.query.closing) };
    const now = m.today();
    const quarterStart = m.summary([], 'quarter').start;
    const deals = m.loadDeals().filter((d) => {
      if (filter.owner === 'mine' && d.owner_id !== req.user.id) return false;
      if (filter.type && d.type !== filter.type) return false;
      if (filter.closing && !(d.close_date && m.daysBetween(now, d.close_date) <= 30)) return false;
      // Closed columns only show this quarter so the board does not grow forever.
      if (!m.OPEN_STAGES.includes(d.stage) && d.closed_at.slice(0, 10) < quarterStart) return false;
      return true;
    });
    const riskIds = new Set(m.atRisk(deals).map((r) => r.deal.id));
    res.render('crm/pipeline', {
      title: 'خط المبيعات',
      filter,
      columns: m.STAGES.map((st) => {
        const list = deals.filter((d) => d.stage === st.key);
        return { ...st, deals: list, value: m.sum(list) };
      }),
      riskIds,
      openValue: m.sum(deals.filter((d) => m.OPEN_STAGES.includes(d.stage))),
      openCount: deals.filter((d) => m.OPEN_STAGES.includes(d.stage)).length,
    });
  });

  function moveStage(deal, stage, user) {
    if (deal.stage === stage) return;
    const closed = stage === 'won' || stage === 'lost';
    db.prepare(`UPDATE crm_deals SET stage = ?, probability = ?, stage_changed_at = datetime('now'),
                closed_at = CASE WHEN ? THEN datetime('now') ELSE '' END WHERE id = ?`)
      .run(stage, m.stageMap[stage].probability, closed ? 1 : 0, deal.id);
    q.addActivity.run(deal.id, null, user.id, 'stage',
      `من «${m.stageMap[deal.stage].label}» إلى «${m.stageMap[stage].label}»`);
  }

  router.post('/deals/:id/stage', (req, res) => {
    const wantsJson = req.is('application/json');
    const deal = q.dealById.get(toId(req.params.id));
    const stage = clean(req.body.stage);
    const fail = (status, error) => (wantsJson ? res.status(status).json({ error }) : (flash(req, 'error', error), res.redirect('/crm/pipeline')));
    if (!deal) return fail(404, 'الصفقة غير موجودة.');
    if (!m.stageMap[stage]) return fail(400, 'مرحلة غير صالحة.');
    if (!canEdit(req.user, deal)) return fail(403, 'لا تملك صلاحية تعديل هذه الصفقة.');

    moveStage(deal, stage, req.user);
    if (wantsJson) return res.json({ ok: true, stage, probability: m.stageMap[stage].probability });
    flash(req, 'success', `نُقلت الصفقة إلى «${m.stageMap[stage].label}».`);
    res.redirect(`/crm/deals/${deal.id}`);
  });

  // ---------- deals ----------
  const formLocals = () => ({ contacts: q.contactOptions.all(), people: q.salesPeople.all() });

  router.get('/deals/new', (req, res) => {
    const stage = m.stageMap[clean(req.query.stage)] ? clean(req.query.stage) : 'lead';
    res.render('crm/deal-form', {
      title: 'صفقة جديدة',
      deal: {
        id: 0, title: '', contact_id: toId(req.query.contact), type: 'sponsorship', stage, value: '',
        probability: m.stageMap[stage].probability, close_date: m.addDays(m.today(), 30),
        owner_id: req.user.id, source: 'instagram', lost_reason: '',
      },
      newContact: { full_name: '', company: '' },
      ...formLocals(),
    });
  });

  router.get('/deals/:id', (req, res) => {
    const deal = q.dealById.get(toId(req.params.id));
    if (!deal) return notFound(res, 'الصفقة غير موجودة.');
    const risk = m.atRisk([{ ...deal, last_activity_at: q.dealActivities.get(deal.id)?.created_at }])[0];
    res.render('crm/deal', { title: deal.title, deal, risk, activities: q.dealActivities.all(deal.id) });
  });

  router.get('/deals/:id/edit', (req, res) => {
    const deal = q.dealById.get(toId(req.params.id));
    if (!deal) return notFound(res, 'الصفقة غير موجودة.');
    if (!canEdit(req.user, deal)) return forbidden(res);
    res.render('crm/deal-form', { title: 'تعديل صفقة', deal, newContact: { full_name: '', company: '' }, ...formLocals() });
  });

  function saveDeal(req, res) {
    const id = toId(req.params.id);
    const existing = id ? q.dealById.get(id) : null;
    if (id && !existing) return notFound(res, 'الصفقة غير موجودة.');
    if (existing && !canEdit(req.user, existing)) return forbidden(res);

    const b = req.body;
    const stage = m.stageMap[b.stage] ? b.stage : 'lead';
    const probability = Math.min(100, Math.max(0, Math.round(Number(b.probability))));
    const deal = {
      id,
      title: clean(b.title),
      contact_id: toId(b.contact_id) || null,
      type: m.typeMap[b.type] ? b.type : 'sponsorship',
      stage,
      value: Math.max(0, Number(b.value) || 0),
      probability: Number.isFinite(probability) ? probability : m.stageMap[stage].probability,
      close_date: /^\d{4}-\d{2}-\d{2}$/.test(clean(b.close_date)) ? clean(b.close_date) : '',
      owner_id: toId(b.owner_id) || req.user.id,
      source: m.sourceMap[b.source] ? b.source : 'other',
      lost_reason: stage === 'lost' ? clean(b.lost_reason).slice(0, 300) : '',
    };
    const newContact = { full_name: clean(b.new_contact_name), company: clean(b.new_contact_company) };
    const render = (message) => {
      res.locals.flash = { type: 'error', message };
      res.status(400).render('crm/deal-form', { title: id ? 'تعديل صفقة' : 'صفقة جديدة', deal, newContact, ...formLocals() });
    };
    if (!deal.title) return render('اسم الصفقة مطلوب.');
    if (!deal.contact_id && !newContact.full_name) return render('اختر جهة اتصال أو أضف جهة جديدة.');

    db.exec('BEGIN');
    try {
      if (!deal.contact_id) {
        deal.contact_id = Number(db.prepare('INSERT INTO crm_contacts (full_name, company, source, owner_id) VALUES (?, ?, ?, ?)')
          .run(newContact.full_name, newContact.company, deal.source, deal.owner_id).lastInsertRowid);
      }
      const fields = ['title', 'contact_id', 'type', 'value', 'probability', 'close_date', 'owner_id', 'source', 'lost_reason'];
      const values = fields.map((f) => deal[f]);
      let dealId = id;
      if (id) {
        db.prepare(`UPDATE crm_deals SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
        // Stage moves go through moveStage so they are logged and keep closed_at right;
        // the probability typed in the form wins over the stage default.
        if (existing.stage !== stage) {
          moveStage(existing, stage, req.user);
          db.prepare('UPDATE crm_deals SET probability = ? WHERE id = ?').run(deal.probability, id);
        }
      } else {
        const closed = stage === 'won' || stage === 'lost';
        dealId = Number(db.prepare(`INSERT INTO crm_deals (${fields.join(', ')}, stage, closed_at)
                    VALUES (${fields.map(() => '?').join(', ')}, ?, CASE WHEN ? THEN datetime('now') ELSE '' END)`)
          .run(...values, stage, closed ? 1 : 0).lastInsertRowid);
      }
      db.exec('COMMIT');
      flash(req, 'success', id ? 'تم تحديث الصفقة.' : 'تمت إضافة الصفقة.');
      res.redirect(`/crm/deals/${dealId}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  router.post('/deals', saveDeal);
  router.post('/deals/:id', saveDeal);

  router.post('/deals/:id/delete', (req, res) => {
    const deal = q.dealById.get(toId(req.params.id));
    if (!deal) return notFound(res, 'الصفقة غير موجودة.');
    if (!canEdit(req.user, deal)) return forbidden(res);
    db.prepare('DELETE FROM crm_deals WHERE id = ?').run(deal.id);
    flash(req, 'success', 'تم حذف الصفقة.');
    res.redirect('/crm/pipeline');
  });

  router.post('/deals/:id/activities', (req, res) => {
    const deal = q.dealById.get(toId(req.params.id));
    if (!deal) return notFound(res, 'الصفقة غير موجودة.');
    const body = clean(req.body.body).slice(0, 1000);
    const kind = m.ACTIVITY_KINDS.some((k) => k.key === req.body.kind) ? req.body.kind : 'note';
    if (body) q.addActivity.run(deal.id, null, req.user.id, kind, body);
    res.redirect(`/crm/deals/${deal.id}#activity`);
  });

  // ---------- contacts ----------
  router.get('/contacts', (req, res) => {
    const search = clean(req.query.q);
    const s = `%${search}%`;
    res.render('crm/contacts', { title: 'جهات الاتصال', contacts: q.contacts.all(search, s, s, s, s), search });
  });

  const emptyContact = { id: 0, full_name: '', company: '', job_title: '', email: '', phone: '', source: 'instagram', notes: '' };

  router.get('/contacts/new', (req, res) => {
    res.render('crm/contact-form', { title: 'جهة اتصال جديدة', contact: emptyContact });
  });

  router.get('/contacts/:id', (req, res) => {
    const contact = q.contactById.get(toId(req.params.id));
    if (!contact) return notFound(res, 'جهة الاتصال غير موجودة.');
    res.render('crm/contact', {
      title: contact.full_name,
      contact,
      deals: q.dealsForContact.all(contact.id),
      activities: q.contactActivities.all(contact.id, contact.id),
    });
  });

  router.get('/contacts/:id/edit', (req, res) => {
    const contact = q.contactById.get(toId(req.params.id));
    if (!contact) return notFound(res, 'جهة الاتصال غير موجودة.');
    res.render('crm/contact-form', { title: 'تعديل جهة اتصال', contact });
  });

  function saveContact(req, res) {
    const id = toId(req.params.id);
    if (id && !q.contactById.get(id)) return notFound(res, 'جهة الاتصال غير موجودة.');
    const b = req.body;
    const contact = {
      id,
      full_name: clean(b.full_name),
      company: clean(b.company),
      job_title: clean(b.job_title),
      email: clean(b.email),
      phone: clean(b.phone),
      source: m.sourceMap[b.source] ? b.source : 'other',
      notes: clean(b.notes).slice(0, 1000),
    };
    const render = (message) => {
      res.locals.flash = { type: 'error', message };
      res.status(400).render('crm/contact-form', { title: id ? 'تعديل جهة اتصال' : 'جهة اتصال جديدة', contact });
    };
    if (!contact.full_name) return render('الاسم مطلوب.');
    if (contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return render('البريد الإلكتروني غير صالح.');

    const fields = ['full_name', 'company', 'job_title', 'email', 'phone', 'source', 'notes'];
    const values = fields.map((f) => contact[f]);
    let contactId = id;
    if (id) {
      db.prepare(`UPDATE crm_contacts SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
    } else {
      contactId = Number(db.prepare(`INSERT INTO crm_contacts (${fields.join(', ')}, owner_id)
                  VALUES (${fields.map(() => '?').join(', ')}, ?)`).run(...values, req.user.id).lastInsertRowid);
    }
    flash(req, 'success', 'تم حفظ جهة الاتصال.');
    res.redirect(`/crm/contacts/${contactId}`);
  }

  router.post('/contacts', saveContact);
  router.post('/contacts/:id', saveContact);

  router.post('/contacts/:id/delete', (req, res) => {
    const contact = q.contactById.get(toId(req.params.id));
    if (!contact) return notFound(res, 'جهة الاتصال غير موجودة.');
    if (req.user.role !== 'admin' && !req.user.is_manager && contact.owner_id !== req.user.id) return forbidden(res);
    db.prepare('DELETE FROM crm_contacts WHERE id = ?').run(contact.id);
    flash(req, 'success', 'تم حذف جهة الاتصال (وبقيت صفقاتها بدون جهة اتصال).');
    res.redirect('/crm/contacts');
  });

  router.post('/contacts/:id/activities', (req, res) => {
    const contact = q.contactById.get(toId(req.params.id));
    if (!contact) return notFound(res, 'جهة الاتصال غير موجودة.');
    const body = clean(req.body.body).slice(0, 1000);
    const kind = m.ACTIVITY_KINDS.some((k) => k.key === req.body.kind) ? req.body.kind : 'note';
    if (body) q.addActivity.run(null, contact.id, req.user.id, kind, body);
    res.redirect(`/crm/contacts/${contact.id}#activity`);
  });

  // ---------- reports ----------
  router.get('/reports', (req, res) => {
    const period = ['month', 'quarter', 'year'].includes(req.query.period) ? req.query.period : 'quarter';
    const deals = m.loadDeals();
    const s = m.summary(deals, period);
    res.render('crm/reports', {
      title: 'التقارير',
      period,
      s,
      months: m.monthlyWon(deals, period === 'year' ? 12 : 6),
      byType: m.groupBy(s.won, (d) => d.type, (k) => `${m.typeMap[k].icon} ${m.typeMap[k].label}`),
      bySource: m.groupBy(s.won, (d) => d.source, (k) => m.sourceMap[k].label),
      byOwner: m.groupBy(s.won, (d) => d.owner_name || '—', (k) => k),
      pipeline: m.groupBy(s.open, (d) => d.stage, (k) => m.stageMap[k].label)
        .sort((a, b) => m.OPEN_STAGES.indexOf(a.key) - m.OPEN_STAGES.indexOf(b.key)),
    });
  });

  return router;
};
