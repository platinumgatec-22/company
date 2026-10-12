// Atlas pages for the digital team (/atlas/team) and the WhatsApp simulator (/atlas/simulator).
const express = require('express');
const db = require('../db');
const team = require('./team');
const platin = require('./platin');

// What happened in each simulated conversation, newest last (kept while the server runs).
const simSteps = new Map();

module.exports = function digitalRoutes({ requireAdmin, jsonGuard, asyncRoute }) {
  const router = express.Router();

  router.get('/team', (req, res) => {
    res.render('atlas/team', { title: 'الفريق الرقمي', groups: team.overview(), sections: team.SECTIONS });
  });

  // ---------- simulator ----------
  const SAMPLE = { name: 'خالد المطيري', team: 'نسور الشويخ' };
  const newPhone = () => `9655${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const conversation = (phone) => db.prepare(`SELECT w.*, c.name AS client_name FROM wa_conversations w
    LEFT JOIN clients c ON c.id = w.client_id WHERE w.phone = ?`).get(phone);
  const messages = (convId) => db.prepare(`SELECT m.id, m.direction, m.body, m.created_at, e.full_name AS sender_name
    FROM wa_messages m LEFT JOIN employees e ON e.id = m.sender_id WHERE m.conversation_id = ? ORDER BY m.id`).all(convId);

  const sim = express.Router();
  sim.use(requireAdmin);

  sim.get('/', (req, res) => {
    if (!req.session.simPhone) req.session.simPhone = newPhone();
    const conv = conversation(req.session.simPhone);
    res.render('atlas/simulator', {
      title: 'محاكي واتساب',
      phone: req.session.simPhone,
      sample: SAMPLE,
      agent: platin.agent(),
      conv,
      messages: conv ? messages(conv.id) : [],
      steps: conv ? simSteps.get(conv.id) || [] : [],
      autoReply: platin.autoReplyOn(),
    });
  });

  sim.post('/message', jsonGuard, asyncRoute(async (req, res) => {
    const text = String(req.body.text || '').trim().slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'اكتب رسالة.' });
    if (!req.session.simPhone) req.session.simPhone = newPhone();
    if (!platin.agent()) return res.status(409).json({ error: 'حساب الموظف الرقمي «بلاتين» (platin) غير موجود أو غير نشط.' });
    const seeded = platin.ensureDemoTournaments();
    const r = await platin.receive({ from: req.session.simPhone, name: String(req.body.name || '').trim().slice(0, 80), text }, { simulate: true });
    const steps = simSteps.get(r.conversationId) || [];
    if (seeded) steps.push({ at: new Date().toISOString(), by: 'المحاكي', icon: '🏟️', section: 'لوحة البطولات', title: 'أضاف بطولتين تجريبيتين مفتوحتين للتسجيل', detail: 'لم تكن هناك بطولة مفتوحة', link: '/apps/tournaments' });
    steps.push(...r.steps);
    simSteps.set(r.conversationId, steps);
    res.json({ replies: r.replies, steps, state: r.state, conversationId: r.conversationId, agent: platin.agent().full_name });
  }));

  sim.post('/reset', jsonGuard, (req, res) => {
    req.session.simPhone = newPhone();
    res.json({ phone: req.session.simPhone });
  });

  router.use('/simulator', sim);
  return router;
};
