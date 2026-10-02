// Account connection links: each publisher gets a private link (/connect/<token>) that walks
// through connecting their Instagram account to their Buffer user, then saves both to the portal.
const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');
const { notify } = require('./notify');

const newToken = () => crypto.randomBytes(18).toString('base64url');

const q = {
  publishers: db.prepare(`SELECT * FROM employees WHERE is_active = 1 AND workflow_role = 'publisher' ORDER BY id`),
  byToken: db.prepare(`SELECT * FROM employees WHERE connect_token = ? AND connect_token <> '' AND is_active = 1`),
  setToken: db.prepare("UPDATE employees SET connect_token = ? WHERE id = ? AND workflow_role = 'publisher'"),
  save: db.prepare(`UPDATE employees SET instagram_account = ?, buffer_user = ?, buffer_profile_id = ?,
                    connected_at = datetime('now', 'localtime') WHERE id = ?`),
};

function baseUrl(req) {
  const configured = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
  return (configured || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

function createConnectRoutes({ requireAuth, requireAdmin, flash, clean, toId }) {
  const router = express.Router();
  const handle = (v) => clean(v).replace(/^@+/, '').toLowerCase();

  // ---------- admin: the list of links ----------
  router.get('/admin/connections', requireAuth, requireAdmin, (req, res) => {
    const base = baseUrl(req);
    const publishers = q.publishers.all().map((p) => {
      if (!p.connect_token) {
        p.connect_token = newToken();
        q.setToken.run(p.connect_token, p.id);
      }
      return { ...p, link: `${base}/connect/${p.connect_token}` };
    });
    res.render('admin/connections', { title: 'ربط الحسابات', publishers });
  });

  // Issues a new link; the old one stops working.
  router.post('/admin/connections/:id/regenerate', requireAuth, requireAdmin, (req, res) => {
    q.setToken.run(newToken(), toId(req.params.id));
    flash(req, 'success', 'تم إنشاء رابط جديد، والرابط القديم لم يعد يعمل.');
    res.redirect('/admin/connections');
  });

  // ---------- the employee's connection page (no login: the token is the key) ----------
  const load = (req, res, next) => {
    const employee = q.byToken.get(String(req.params.token));
    if (!employee) {
      return res.status(404).render('error', { title: 'رابط غير صالح', message: 'رابط الربط غير صالح أو تم استبداله. اطلب رابطاً جديداً من الإدارة.' });
    }
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    req.employee = employee;
    next();
  };

  const render = (req, res, form, status = 200) => res.status(status).render('connect', {
    title: `ربط حسابات ${req.employee.full_name}`, employee: req.employee, form,
  });

  router.get('/connect/:token', load, (req, res) => {
    const e = req.employee;
    // Seeded placeholders are not real accounts: start with empty fields until connected once.
    const form = e.connected_at
      ? { instagram_account: e.instagram_account, buffer_user: e.buffer_user, buffer_profile_id: e.buffer_profile_id }
      : { instagram_account: '', buffer_user: '', buffer_profile_id: '' };
    render(req, res, form);
  });

  router.post('/connect/:token', load, (req, res) => {
    const e = req.employee;
    const form = {
      instagram_account: handle(req.body.instagram_account),
      buffer_user: clean(req.body.buffer_user).toLowerCase(),
      buffer_profile_id: clean(req.body.buffer_profile_id),
    };
    const fail = (message) => {
      res.locals.flash = { type: 'error', message };
      render(req, res, form, 400);
    };
    if (!/^[a-z0-9._]{1,30}$/.test(form.instagram_account)) return fail('اكتب اسم حساب الإنستقرام (حروف إنجليزية وأرقام و . _ فقط).');
    if (!form.buffer_user) return fail('اكتب بريد أو اسم مستخدم حساب Buffer.');
    if (form.buffer_profile_id && !/^[a-zA-Z0-9_-]{6,64}$/.test(form.buffer_profile_id)) return fail('رقم القناة في Buffer غير صالح.');
    if (!req.body.confirmed) return fail('أكّد أنك ربطت حساب الإنستقرام داخل Buffer.');

    try {
      q.save.run(form.instagram_account, form.buffer_user, form.buffer_profile_id, e.id);
    } catch (err) {
      if (/instagram/.test(err.message)) return fail('حساب الإنستقرام هذا مربوط بموظف آخر.');
      if (/buffer/.test(err.message)) return fail('حساب Buffer هذا مربوط بموظف آخر.');
      throw err;
    }
    notify('account_connected', {
      employee: { id: e.id, name: e.full_name, username: e.username, ...form, instagram: form.instagram_account },
    });
    flash(req, 'success', `تم ربط @${form.instagram_account} مع Buffer بنجاح ✅`);
    res.redirect(req.originalUrl);
  });

  return router;
}

module.exports = { createConnectRoutes };
