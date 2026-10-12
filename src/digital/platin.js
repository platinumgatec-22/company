// بلاتين, the digital customer-service employee on WhatsApp. It answers customers, and when one
// registers a team in a tournament it does the whole job across the site:
//   Atlas client → interaction → team in the tournaments app → sales deal → invoice in the invoices
//   app (and the tournaments app's invoice list) → follow-up tasks for accounting and operations →
//   the invoice sent back on WhatsApp.
// The same code serves real WhatsApp messages (when auto-reply is on) and the simulator.
const db = require('../db');
const svc = require('../atlas/service');
const settings = require('../atlas/settings');
const whatsapp = require('../atlas/whatsapp');
const { emit } = require('../atlas/events');
const appdata = require('../appdata');
const deals = require('../crm/service');
const ai = require('../ai');

const USERNAME = 'platin';
const FEE_FALLBACK = 50;
const DUE_DAYS = 7;

const employee = (username) => db.prepare('SELECT * FROM employees WHERE username = ? AND is_active = 1').get(username) || null;
const agent = () => employee(USERNAME);
const fils = () => employee('fils');
const captain = () => employee('captain');
const deptId = (name) => db.prepare('SELECT id FROM departments WHERE name = ?').get(name)?.id || null;

const kwd = (n) => `${(Number(n) || 0).toFixed(3)} د.ك`;
const today = () => svc.today();
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
// Arabic-Indic digits → ASCII, trimmed.
const norm = (s) => String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).trim();
// \b only knows ASCII letters, so the word end is spelled out (space, punctuation or end of text).
const END = '(?=$|[\\s!.,،؟?])';
const YES = new RegExp(`^(نعم|ايوه|إيوه|اي|أي|ايه|أكد|اكد|أكّد|تمام|موافق|اوكي|أوكي|ok|okay|yes|y|1)${END}`, 'i');
const NO = new RegExp(`^(لا|كلا|الغاء|إلغاء|الغ|no|n|2)${END}`, 'i');
const WANTS_REGISTER = /(سجل|سجّل|تسجيل|اشترك|اشتراك|register)/i;

// ---------- conversation state ----------
const stateQ = {
  get: db.prepare('SELECT * FROM wa_bot_state WHERE conversation_id = ?'),
  set: db.prepare(`INSERT INTO wa_bot_state (conversation_id, state, data, updated_at) VALUES (?, ?, ?, datetime('now'))
                   ON CONFLICT(conversation_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`),
};
function loadState(convId) {
  const row = stateQ.get.get(convId);
  return row ? { state: row.state, data: JSON.parse(row.data) } : { state: 'start', data: {} };
}
const saveState = (convId, state, data) => stateQ.set.run(convId, state, JSON.stringify(data));

// ---------- tournaments ----------
function openTournaments() {
  const teams = appdata.list('tournaments', 'teams');
  return appdata.list('tournaments', 'tournaments')
    .filter((t) => ['registration', 'upcoming'].includes(t.status))
    .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')))
    .map((t) => {
      const taken = teams.filter((x) => x.tournamentId === t.id).length;
      const capacity = Number(t.capacity) || 0;
      return { ...t, taken, full: capacity > 0 && taken >= capacity, fee: Number(t.entryFee) || FEE_FALLBACK };
    });
}

/** Adds sample tournaments to the tournaments app when none is open for registration (simulator). */
function ensureDemoTournaments() {
  if (openTournaments().length) return false;
  const start = addDays(today(), 21);
  appdata.add('tournaments', 'tournaments', {
    name: 'دوري البوابة البلاتينية لكرة القدم الخماسية', sport: 'football', status: 'registration',
    venue: 'ملاعب الشويخ', startDate: start, endDate: addDays(start, 10), capacity: 16, entryFee: 60, prizePool: 1000,
  });
  appdata.add('tournaments', 'tournaments', {
    name: 'بطولة البادل المفتوحة', sport: 'padel', status: 'registration',
    venue: 'نادي البادل - السالمية', startDate: addDays(start, 7), endDate: addDays(start, 9), capacity: 32, entryFee: 25, prizePool: 500,
  });
  return true;
}

const tournamentList = (list) => list.map((t, i) =>
  `${i + 1}️⃣ ${t.name}\n   📅 ${t.startDate || 'قريباً'} · 📍 ${t.venue || '—'} · 💰 ${kwd(t.fee)}${t.full ? ' · ❌ مكتملة' : ` · ${t.taken}/${t.capacity || '∞'} فريق`}`).join('\n');

// ---------- invoices ----------
function nextInvoiceNumber(date) {
  const company = appdata.get('invoices', 'settings', 'company') || {};
  const prefix = String(company.prefix || 'PG').trim() || 'PG';
  const year = date.slice(0, 4);
  const max = appdata.list('invoices', 'invoices').filter((i) => i.year === year)
    .reduce((m, i) => Math.max(m, Number(i.seq) || 0), 0);
  const seq = max + 1;
  return { seq, year, number: `${prefix}-${year}-${String(seq).padStart(4, '0')}` };
}

// ---------- the registration, from WhatsApp to invoice ----------
function register(conv, data, actor) {
  const steps = [];
  const step = (s) => steps.push({ at: new Date().toISOString(), by: actor.full_name, ...s });
  const t = appdata.get('tournaments', 'tournaments', data.tournamentId);
  const fee = Number(t?.entryFee) || FEE_FALLBACK;
  const date = today();
  const due = addDays(date, DUE_DAYS);
  const phone = `+${whatsapp.digits(conv.phone)}`;

  db.exec('BEGIN');
  try {
    // 1. The customer in Atlas: real name, team, owner.
    let client = conv.client_id && svc.getClient(conv.client_id);
    const fields = { name: data.captain, company: data.team, phone, owner_id: actor.id, source: 'واتساب' };
    client = client ? svc.updateClient(client.id, fields, actor) : svc.createClient({ ...fields, stage: 'contacted' }, actor);
    if (!conv.client_id) db.prepare('UPDATE wa_conversations SET client_id = ? WHERE id = ?').run(client.id, conv.id);
    svc.addInteraction(client.id, { kind: 'whatsapp', body: `طلب تسجيل فريق «${data.team}» في «${t.name}» عبر واتساب.` }, actor);
    step({ icon: '👥', section: 'العملاء', title: `حدّث بيانات العميل «${client.name}»`, detail: `فريق ${data.team} · ${phone}`, link: `/atlas/clients/${client.id}` });

    // 2. The team in the tournaments app.
    const team = appdata.add('tournaments', 'teams', {
      name: data.team, tournamentId: t.id, captain: data.captain, phone, group: '', fee, paid: false,
      source: 'whatsapp', clientId: client.id, createdById: actor.id, createdBy: actor.full_name,
    });
    step({ icon: '🏆', section: 'لوحة البطولات', title: `سجّل فريق «${data.team}» في «${t.name}»`, detail: `رسوم ${kwd(fee)} · غير مدفوعة`, link: '/apps/tournaments' });
    emit('tournament.registered', {
      message: `سجّل فريق «${data.team}» في «${t.name}» عبر واتساب`, actor, link: `/atlas/clients/${client.id}`,
      data: { team, tournament: t, client },
    });

    // 3. The sale: a registration deal owned by بلاتين (moves the client to "proposal").
    const deal = deals.createDeal({
      title: `تسجيل ${data.team} — ${t.name}`, client_id: client.id, type: 'registration', stage: 'proposal',
      value: fee, probability: 50, close_date: due, owner_id: actor.id, source: 'whatsapp', lost_reason: '',
    }, actor);
    step({ icon: '💼', section: 'المبيعات', title: `فتح صفقة «${deal.title}»`, detail: `${kwd(fee)} · مرحلة عرض سعر`, link: `/crm/deals/${deal.id}` });

    // 4. The invoice, in the invoices app (with the same fields the app itself saves) …
    const n = nextInvoiceNumber(date);
    const item = { d: `رسوم تسجيل فريق «${data.team}» في «${t.name}»`, q: 1, p: fee };
    const invoice = appdata.add('invoices', 'invoices', {
      number: n.number, seq: n.seq, year: n.year, date, due,
      client: { name: data.captain, phone, email: '', address: '' }, ref: `${data.team} · ${t.name}`,
      items: [item], discount: 0, taxRate: 0, paid: 0, currency: 'KWD', total: fee, balance: fee,
      notes: 'يرجى السداد قبل تاريخ الاستحقاق لتأكيد مشاركة الفريق.',
      internal: `أصدرها ${actor.full_name} آلياً من محادثة واتساب · صفقة #${deal.id}`,
      updatedAt: new Date().toISOString(), createdById: actor.id, createdBy: actor.full_name, dealId: deal.id, clientId: client.id,
    });
    // … and in the tournaments app's invoice list, linked to the tournament.
    appdata.add('tournaments', 'invoices', {
      number: n.number, direction: 'issued', party: `${data.team} (${data.captain})`, tournamentId: t.id,
      issueDate: date, dueDate: due, amount: fee, status: 'unpaid', note: 'رسوم تسجيل · واتساب',
      createdById: actor.id, createdBy: actor.full_name,
    });
    svc.addInteraction(client.id, { kind: 'note', body: `صدرت الفاتورة ${n.number} بمبلغ ${kwd(fee)}، تستحق ${due}.` }, actor);
    step({ icon: '🧾', section: 'الفواتير', title: `أصدر الفاتورة ${n.number}`, detail: `${kwd(fee)} · تستحق ${due}`, link: '/apps/invoices' });
    emit('invoice.issued', {
      message: `أصدر الفاتورة ${n.number} لفريق «${data.team}» (${kwd(fee)})`, actor, link: `/crm/deals/${deal.id}`,
      data: { invoice, deal, client },
    });

    // 5. Hand-offs to the people who take it from here.
    const accountant = fils();
    const ops = captain();
    const payTask = svc.createTask({
      title: `متابعة دفع الفاتورة ${n.number} — فريق ${data.team}`, priority: 'high', due_date: due,
      description: `${kwd(fee)} رسوم تسجيل في «${t.name}». عند السداد: علّم الفاتورة مدفوعة في نظام الفواتير، وفعّل «مدفوع» للفريق في لوحة البطولات، وانقل الصفقة إلى «تم الفوز».`,
      owner_id: accountant?.id || null, department_id: deptId('الإدارة المالية'), client_id: client.id,
    }, actor);
    step({ icon: '✅', section: 'المهام', title: `أسند متابعة الدفع إلى ${accountant?.full_name || 'المالية'}`, detail: payTask.title, link: `/atlas/tasks/${payTask.id}` });
    const opsTask = svc.createTask({
      title: `إضافة فريق ${data.team} إلى جدول «${t.name}»`, priority: 'normal', due_date: t.startDate || '',
      description: `الكابتن ${data.captain} · ${phone}. يُثبَّت في الجدول بعد سداد الفاتورة ${n.number}.`,
      owner_id: ops?.id || null, department_id: deptId('البطولات والعمليات'), client_id: client.id,
    }, actor);
    step({ icon: '📋', section: 'المهام', title: `أسند الجدولة إلى ${ops?.full_name || 'العمليات'}`, detail: opsTask.title, link: `/atlas/tasks/${opsTask.id}` });

    db.exec('COMMIT');
    return { steps, invoice, deal, client, tournament: t, due, fee };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- replies ----------
const MENU = '1️⃣ التسجيل في بطولة\n2️⃣ البطولات القادمة\n3️⃣ اقتراح أو شكوى';

async function freeAnswer(text, actor) {
  return ai.write({
    system: `أنت ${actor.full_name}، موظف خدمة العملاء (موظف رقمي) في البوابة البلاتينية لتنظيم البطولات الرياضية في الكويت. ترد على واتساب بالعربية بإيجاز وود، في 3 أسطر كحد أقصى، دون وعود بأسعار أو مواعيد غير مذكورة. اختم بدعوة العميل لاختيار رقم من القائمة.`,
    prompt: `البطولات المفتوحة الآن:\n${tournamentList(openTournaments()) || 'لا توجد'}\n\nرسالة العميل: ${text}`,
    fallback: 'شكراً لتواصلك 🙏 أقدر أساعدك في التالي:',
  });
}

/** Decides the reply for one inbound message. Returns { replies, steps }. */
async function respond(conv, text, actor) {
  const msg = norm(text);
  let { state, data } = loadState(conv.id);
  const replies = [];
  let steps = [];
  const say = (s) => replies.push(s);

  const showTournaments = () => {
    const list = openTournaments();
    if (!list.length) {
      say('حالياً لا توجد بطولات مفتوحة للتسجيل، وسأبلغك أول ما تفتح بطولة جديدة 🙏');
      return 'menu';
    }
    data.options = list.map((t) => t.id);
    say(`البطولات المفتوحة للتسجيل:\n\n${tournamentList(list)}\n\nاكتب رقم البطولة التي تريد التسجيل فيها.`);
    return 'pick_tournament';
  };

  switch (state) {
    case 'pick_tournament': {
      const t = appdata.get('tournaments', 'tournaments', data.options?.[Number(msg) - 1]);
      const open = t && openTournaments().find((x) => x.id === t.id);
      if (!open) { say('اكتب رقم البطولة من القائمة فقط (مثلاً 1).'); break; }
      if (open.full) { say('للأسف هذه البطولة مكتملة العدد 😔 اختر بطولة أخرى من القائمة.'); break; }
      data = { ...data, tournamentId: t.id, tournamentName: t.name, fee: open.fee };
      say(`اختيار موفق 👌 «${t.name}».\nما اسم الفريق؟`);
      state = 'team';
      break;
    }
    case 'team':
      if (msg.length < 2) { say('اكتب اسم الفريق من فضلك.'); break; }
      data.team = msg.slice(0, 80);
      say(`فريق «${data.team}» 💪\nما اسم كابتن الفريق (الاسم الكامل)؟`);
      state = 'captain';
      break;
    case 'captain':
      if (msg.length < 2) { say('اكتب اسم الكابتن من فضلك.'); break; }
      data.captain = msg.slice(0, 80);
      say(`راجع بيانات التسجيل:\n\n🏆 البطولة: ${data.tournamentName}\n👕 الفريق: ${data.team}\n🧢 الكابتن: ${data.captain}\n📱 الهاتف: +${whatsapp.digits(conv.phone)}\n💰 الرسوم: ${kwd(data.fee)}\n\nهل تؤكد التسجيل؟ (نعم / لا)`);
      state = 'confirm';
      break;
    case 'confirm':
      if (YES.test(msg)) {
        const r = register(conv, data, actor);
        steps = r.steps;
        say(`تم تسجيل فريق «${data.team}» في «${r.tournament.name}» بنجاح ✅\n\n🧾 الفاتورة: ${r.invoice.number}\n💰 المبلغ: ${kwd(r.fee)}\n📅 تاريخ الاستحقاق: ${r.due}\n\nيُثبَّت الفريق في جدول البطولة بعد السداد، وسيتواصل معك فريق المحاسبة لإتمام الدفع. بالتوفيق 🏆`);
        data = { lastInvoice: r.invoice.number, dealId: r.deal.id };
        state = 'done';
      } else if (NO.test(msg)) {
        say(`تم إلغاء الطلب. تقدر تبدأ من جديد في أي وقت:\n\n${MENU}`);
        data = {};
        state = 'menu';
      } else {
        say('اكتب «نعم» لتأكيد التسجيل أو «لا» للإلغاء.');
      }
      break;
    case 'complaint': {
      const owner = employee('kahraman');
      const task = svc.createTask({
        title: `اقتراح/شكوى من +${whatsapp.digits(conv.phone)}`, description: msg, priority: 'normal',
        owner_id: owner?.id || null, department_id: deptId('خدمة العملاء'), client_id: conv.client_id || null,
      }, actor);
      steps = [{ at: new Date().toISOString(), by: actor.full_name, icon: '📨', section: 'المهام', title: `حوّل الملاحظة إلى ${owner?.full_name || 'خدمة العملاء'}`, detail: task.title, link: `/atlas/tasks/${task.id}` }];
      say(`وصلت ملاحظتك وحوّلتها إلى ${owner?.full_name || 'الفريق المختص'} للمتابعة 🙏\n\n${MENU}`);
      state = 'menu';
      break;
    }
    default: // start, menu, done
      if (msg === '1' || WANTS_REGISTER.test(msg)) {
        if (state === 'start') say(`أهلاً وسهلاً في البوابة البلاتينية 👋 معك ${actor.full_name} من خدمة العملاء.`);
        state = showTournaments();
      } else if (msg === '2') {
        const list = openTournaments();
        say(list.length ? `البطولات القادمة:\n\n${tournamentList(list)}\n\nللتسجيل اكتب 1.` : 'لا توجد بطولات قادمة حالياً.');
        state = 'menu';
      } else if (msg === '3') {
        say('تفضّل، اكتب اقتراحك أو شكواك في رسالة واحدة وسأحوّلها للفريق المختص.');
        state = 'complaint';
      } else if (state === 'start') {
        say(`أهلاً وسهلاً في البوابة البلاتينية 👋 معك ${actor.full_name} من خدمة العملاء. كيف أقدر أساعدك؟\n\n${MENU}`);
        state = 'menu';
      } else {
        say(`${await freeAnswer(text, actor)}\n\n${MENU}`);
        state = 'menu';
      }
  }
  saveState(conv.id, state, data);
  return { replies, steps, state };
}

/**
 * Handles one inbound WhatsApp message end to end: stores it, makes sure the sender is an Atlas
 * client, and (when `reply`) answers as بلاتين. `simulate` keeps replies inside the site.
 */
async function receive({ from, name = '', text, waId = '' }, { reply = true, simulate = false } = {}) {
  const steps = [];
  let conv = whatsapp.conversationFor(from, name);
  whatsapp.storeMessage(conv, 'in', text, { waId, status: simulate ? 'simulated' : 'received' });
  if (!conv.client_id) {
    // A new number becomes a lead in the CRM automatically.
    const client = svc.createClient({ name: name || `+${whatsapp.digits(from)}`, phone: `+${whatsapp.digits(from)}`, source: 'واتساب', stage: 'lead' }, null);
    db.prepare('UPDATE wa_conversations SET client_id = ? WHERE id = ?').run(client.id, conv.id);
    conv = { ...conv, client_id: client.id };
    steps.push({ at: new Date().toISOString(), by: 'Atlas', icon: '✨', section: 'العملاء', title: `عميل محتمل جديد «${client.name}»`, detail: 'من أول رسالة واتساب', link: `/atlas/clients/${client.id}` });
  }
  emit('whatsapp.received', {
    message: `رسالة واتساب من ${name || from}`, link: `/atlas/inbox/${conv.id}`,
    data: { from, name, text, conversation_id: conv.id, client_id: conv.client_id },
  });

  const actor = agent();
  if (!reply || !actor) return { conversationId: conv.id, replies: [], steps };
  const r = await respond(conv, text, actor);
  for (const body of r.replies) {
    if (simulate) whatsapp.storeMessage(conv, 'out', body, { status: 'simulated', senderId: actor.id });
    else await whatsapp.sendText(conv.phone, body, { senderId: actor.id });
  }
  if (r.replies.length) db.prepare('UPDATE wa_conversations SET unread = 0 WHERE id = ?').run(conv.id);
  return { conversationId: conv.id, replies: r.replies, steps: [...steps, ...r.steps], state: r.state };
}

const autoReplyOn = () => settings.get('platin_autoreply') === '1';

module.exports = { receive, respond, register, ensureDemoTournaments, openTournaments, autoReplyOn, agent };
