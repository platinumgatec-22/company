// Platinum Gate (البوابة البلاتينية): departments and team.
// The team is the digital employees running in Make (each one's scenarios start with their
// name, e.g. "كابتن - مدير العمليات"), plus the publishing team (موزة and 7 publishers).
// ensureCompany() runs on every start: it adds what is missing and never overwrites edits.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

// Set these on a public server: without a persistent disk the database (and these passwords) reset on restart.
const DEFAULT_PASSWORD = process.env.DEMO_PASSWORD || '123456';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const departments = {
  exec: ['المكتب التنفيذي', '🏛️', 'القيادة والإشراف، المساعدة التنفيذية، والتقارير اليومية والأسبوعية.'],
  ops: ['البطولات والعمليات', '🏆', 'تنظيم البطولات وجداولها، علاقات الملاعب والمنشآت، والمشتريات واللوجستيات.'],
  cs: ['خدمة العملاء', '💬', 'الاشتراكات والاستفسارات عبر واتساب، والشكاوى والاقتراحات.'],
  sales: ['الرعايات والمبيعات', '🤝', 'عروض الرعاية، قاعدة الرعاة، والمبيعات.'],
  mkt: ['التسويق والمحتوى', '📣', 'الأفكار والمحتوى والتصاميم وسكربتات الفيديو، والنشر على وسائل التواصل.'],
  elite: ['فريق النخبة للنشر والتصاميم', '🎨', 'طلبات النشر، قروب النخبة للتصاميم، والنشر على حسابات إنستقرام عبر Buffer.'],
  fin: ['الإدارة المالية', '💰', 'الميزانية والمحاسبة والمصروفات المتكررة.'],
  legal: ['الإدارة القانونية', '⚖️', 'العقود والتراخيص، الشؤون القانونية، والامتثال والملكية الفكرية.'],
};

// [full_name, username, job_title, department, is_manager, workflow_role, make_names, bio]
// make_names: the prefixes (before " - ") of this employee's scenarios in Make.
const team = [
  ['حسون', 'hassoun', 'المشرف الأعلى', 'exec', 0, 'director', 'حسون',
    'يكتب التقرير التنفيذي اليومي ويدير الاجتماع الأسبوعي للمديرين، ويستلم طلبات النشر ويحوّلها إلى موزة.'],
  ['لؤلؤ', 'lulu', 'المساعدة التنفيذية لحسين', 'exec', 0, '', 'لؤلؤ',
    'تكتب المسودات والتقارير لحسين، وتقرير المديرين المنسّق (PDF)، والتقرير الكامل لكل مدير.'],
  ['ألماس', 'almas', 'منسقة مساحة العمل', 'exec', 0, '', 'ألماس',
    'تنسّق مساحة عمل المكتب التنفيذي، ومحادثة مباشرة مع حسين على تيليجرام تسجّل منها المهام.'],

  ['علي', 'ali', 'مدير البطولات والعمليات', 'ops', 1, '', 'المديرون|بوت المديرين',
    'يستلم مهام حسين عبر بوت المديرين ويكتب خطط التنفيذ لفريقه: كابتن، نحاس، زمرد.'],
  ['كابتن', 'captain', 'مدير العمليات', 'ops', 0, '', 'كابتن', 'خطط البطولات وجداولها والتذكيرات.'],
  ['زمرد', 'zumurrud', 'علاقات الملاعب والمنشآت', 'ops', 0, '', 'زمرد', 'التواصل مع الملاعب والمنشآت وحجزها.'],
  ['نحاس', 'nuhas', 'المشتريات واللوجستيات', 'ops', 0, '', 'نحاس', 'مشتريات البطولات والخدمات اللوجستية.'],

  ['مفلح', 'mufleh', 'مدير خدمة العملاء والرعايات والمبيعات', 'cs', 1, '', 'المديرون|بوت المديرين',
    'يكتب خطط التنفيذ لفريقه: بلاتين، كهرمان، ذهب، عزيزة، زمرّد.'],
  ['بلاتين', 'platin', 'خدمة العملاء (واتساب)', 'cs', 0, '', 'بلاتين',
    'يستقبل العملاء على واتساب: الاشتراك، الاقتراحات، تنظيم البطولات، تشغيل الملاعب، المعسكرات.'],
  ['كهرمان', 'kahraman', 'الشكاوى والاقتراحات', 'cs', 0, '', 'كهرمان', 'متابعة الشكاوى والاقتراحات والرد عليها.'],

  ['زمرّد', 'zumurrud.sponsors', 'مدير الرعايات', 'sales', 1, '', 'زمرّد', 'إدارة الرعايات وخططها.'],
  ['ذهب', 'dhahab', 'المبيعات والرعايات', 'sales', 0, '', 'ذهب', 'إعداد عروض الرعاية والمبيعات.'],
  ['عزيزة', 'aziza', 'قاعدة الرعاة', 'sales', 0, '', 'عزيزة', 'قاعدة بيانات الرعاة ومسودات رسائل البطولات.'],

  ['ماس', 'mas', 'مدير التسويق والمحتوى', 'mkt', 1, '', 'ماس|المديرون|بوت المديرين',
    'خطة النشر ورفعها لحسين، المراجعة اليومية للفريق، والنشر على تيك توك ويوتيوب وSubstack.'],
  ['ياقوت', 'yaqoot', 'مدير التسويق', 'mkt', 0, '', 'ياقوت', 'المراجعة التسويقية، ومنشور اليوم (فكرة يومية تُنشر 3:00 عصراً).'],
  ['جوهر', 'jawhar', 'مدير الاستوديو', 'mkt', 0, '', 'جوهر', 'توزيع مهام الاستوديو ومراجعة الحزمة وتسليم الموافَق عليه لبرونز.'],
  ['فضة', 'fidda', 'استقبال الأفكار', 'mkt', 0, '', 'فضة', 'تحويل الأفكار الجديدة إلى الاستوديو أو فريق النخبة، وتسليم المنشورات الموافَق عليها لبرونز.'],
  ['عقيق', 'aqeeq', 'كاتب المحتوى', 'mkt', 0, '', 'عقيق', 'كتابة محتوى المنشورات في الاستوديو.'],
  ['فيروز', 'fairouz', 'مصممة الصور', 'mkt', 0, '', 'فيروز', 'تصميم صور المنشورات بالذكاء الاصطناعي وحفظها في Drive وCanva.'],
  ['مرجان', 'marjan', 'كاتب سكربتات الفيديو', 'mkt', 0, '', 'مرجان', 'كتابة سكربتات الفيديو في الاستوديو.'],
  ['برونز', 'bronze', 'النشر الموحّد على السوشيال', 'mkt', 0, '', 'برونز',
    'ينشر يومياً 3:00 عصراً على فيسبوك وإنستغرام وتيك توك @championshipskw وديسكورد وX.'],

  ['موزة', 'moza', 'مانجير النشر', 'elite', 1, 'manager', '',
    'توزّع طلبات النشر على قروب النخبة للتصاميم وموظفي النشر، وترسل تقرير النشر إلى حسون.'],
  ['زبرجد', 'zabarjad', 'مصمم فريق النخبة', 'elite', 0, 'designer', 'زبرجد|النخبة', 'تصميم ونشر سريع لفريق النخبة.'],

  ['جمانة', 'jumana', 'مدير الإدارة المالية والقانونية', 'fin', 1, '', 'المديرون|بوت المديرين',
    'تكتب خطط التنفيذ لفريقها: دينار، فلس، بيزة، بوخمسين، صدر، عدل، ميثاق، حصانة.'],
  ['دينار', 'dinar', 'المدير المالي', 'fin', 0, '', 'دينار', 'الإدارة المالية والتقارير المالية.'],
  ['بوخمسين', 'bukhamseen', 'مسؤول الميزانية', 'fin', 0, '', 'بوخمسين', 'إعداد الميزانيات ومتابعتها.'],
  ['فلس', 'fils', 'المحاسب', 'fin', 0, '', 'فلس', 'القيود المحاسبية والفواتير.'],
  ['بيزة', 'baiza', 'المصروفات المتكررة', 'fin', 0, '', 'بيزة', 'متابعة المصروفات والاشتراكات المتكررة.'],

  ['صدر', 'sadr', 'رئيس الإدارة القانونية', 'legal', 1, '', 'صدر', 'رئاسة الإدارة القانونية.'],
  ['عدل', 'adl', 'الشؤون القانونية', 'legal', 0, '', 'عدل', 'الاستشارات والشؤون القانونية.'],
  ['ميثاق', 'mithaq', 'العقود والتراخيص', 'legal', 0, '', 'ميثاق', 'صياغة العقود ومتابعة التراخيص.'],
  ['حصانة', 'hasana', 'الامتثال والملكية الفكرية', 'legal', 0, '', 'حصانة', 'الامتثال وحماية الملكية الفكرية.'],

  // Publishers: each one has their own Instagram account and Buffer user (connected from
  // لوحة الإدارة ← ربط الحسابات); the values here are placeholders.
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => [
    `موظف النشر ${n}`, `publisher${n}`, 'موظف نشر', 'elite', 0, 'publisher', '',
    'ينشر تصاميم فريق النخبة على حساب الإنستقرام الخاص به عبر Buffer.',
  ]),
];
const PUBLISHER_PLACEHOLDERS = (username) => {
  const n = /^publisher(\d)$/.exec(username)?.[1];
  return n ? [`company.account${n}`, `buffer.user${n}`] : ['', ''];
};

// The sample company the portal shipped with; removed once from existing databases.
const DEMO_USERS = ['ahmad', 'sara', 'fatima', 'yousef', 'noura', 'khaled', 'maryam', 'abdullah', 'mohammad',
  'reem', 'omar', 'hind', 'bader', 'latifa', 'jasem', 'dana', 'salman', 'hessa'];
const DEMO_DEPARTMENTS = ['الإدارة العليا', 'الموارد البشرية', 'المالية والمحاسبة', 'تقنية المعلومات', 'المبيعات', 'التسويق', 'العمليات'];
const RENAMED_DEPARTMENTS = { 'النشر والتصاميم': departments.elite[0] };

const meta = {
  get: db.prepare('SELECT value FROM meta WHERE key = ?'),
  set: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

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

// Returns a summary of what was added (empty when nothing changed).
function ensureCompany() {
  const fresh = db.prepare('SELECT COUNT(*) AS n FROM employees').get().n === 0;
  // Digital employees run in Make and don't sign in: they get an unknown random password
  // (the admin can set one from لوحة الإدارة if a person needs to sign in as them).
  const lockedHash = bcrypt.hashSync(crypto.randomBytes(24).toString('base64url'), 10);
  const added = [];

  transaction(() => {
    // 1. Departments (earlier names are renamed first, so their members follow).
    for (const [from, to] of Object.entries(RENAMED_DEPARTMENTS)) {
      if (!db.prepare('SELECT 1 FROM departments WHERE name = ?').get(to)) {
        db.prepare('UPDATE departments SET name = ? WHERE name = ?').run(to, from);
      }
    }
    const deptId = {};
    for (const [key, [name, icon, description]] of Object.entries(departments)) {
      const row = db.prepare('SELECT id FROM departments WHERE name = ?').get(name);
      deptId[key] = row ? row.id : Number(db.prepare('INSERT INTO departments (name, icon, description) VALUES (?, ?, ?)')
        .run(name, icon, description).lastInsertRowid);
    }

    // 2. One-time clean-up of the sample company.
    if (!meta.get.get('demo_removed')) {
      const delUser = db.prepare('DELETE FROM employees WHERE username = ?');
      for (const u of DEMO_USERS) delUser.run(u);
      // The admin account (حسين's) moves out of the sample departments.
      const demoDepts = JSON.stringify(DEMO_DEPARTMENTS);
      db.prepare(`UPDATE employees SET department_id = ?,
                    full_name = CASE WHEN full_name = 'مدير النظام' THEN 'حسين' ELSE full_name END,
                    job_title = CASE WHEN job_title = 'مسؤول النظام' THEN 'الرئيس التنفيذي' ELSE job_title END
                  WHERE username = 'admin'
                    AND (department_id IS NULL OR department_id IN (SELECT id FROM departments WHERE name IN (SELECT value FROM json_each(?))))`)
        .run(deptId.exec, demoDepts);
      for (const name of DEMO_DEPARTMENTS) {
        db.prepare(`DELETE FROM departments WHERE name = ?
                    AND NOT EXISTS (SELECT 1 FROM employees WHERE department_id = departments.id)`).run(name);
      }
      // The earlier publishing team had a placeholder designer; Make's elite designer is زبرجد.
      if (!db.prepare("SELECT 1 FROM employees WHERE username = 'zabarjad'").get()) {
        db.prepare(`UPDATE employees SET username = 'zabarjad', full_name = 'زبرجد'
                    WHERE username = 'elite.designer'`).run();
      }
      meta.set.run('demo_removed', '1');
    }

    // 3. The admin account is حسين's.
    if (fresh) {
      db.prepare(`INSERT INTO employees (full_name, username, password_hash, email, job_title, department_id,
                    is_manager, role, workflow_role, must_change_password)
                  VALUES ('حسين', 'admin', ?, 'info@platinumgatekw.com', 'الرئيس التنفيذي', ?, 1, 'admin', 'owner', 1)`)
        .run(bcrypt.hashSync(ADMIN_PASSWORD, 10), deptId.exec);
      added.push('admin');
    }

    // 4. The team.
    const byUsername = db.prepare('SELECT id FROM employees WHERE username = ?');
    const insert = db.prepare(`
      INSERT INTO employees (full_name, username, password_hash, job_title, department_id, is_manager,
                             workflow_role, make_names, bio, instagram_account, buffer_user, is_digital, must_change_password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`);
    // Existing accounts keep their edits; only fill in what the earlier versions didn't have.
    const complete = db.prepare(`
      UPDATE employees SET department_id = COALESCE(department_id, ?), workflow_role = CASE WHEN workflow_role = '' THEN ? ELSE workflow_role END,
        make_names = CASE WHEN make_names = '' THEN ? ELSE make_names END, bio = CASE WHEN bio = '' THEN ? ELSE bio END
      WHERE id = ?`);
    for (const [name, username, title, dept, isManager, role, makeNames, bio] of team) {
      const existing = byUsername.get(username);
      if (existing) {
        complete.run(deptId[dept], role, makeNames, bio, existing.id);
        continue;
      }
      const [instagram, buffer] = PUBLISHER_PLACEHOLDERS(username);
      insert.run(name, username, lockedHash, title, deptId[dept], isManager, role, makeNames, bio, instagram, buffer);
      added.push(username);
    }
    // Earlier versions put the publishing team in its own department; move them to the elite team.
    db.prepare(`UPDATE employees SET department_id = ? WHERE username IN ('hassoun') AND department_id = ?`)
      .run(deptId.exec, deptId.elite);
  });
  return added;
}

// Sample Atlas data (tasks, clients, a canvas, one WhatsApp thread) the first time Atlas runs.
function seedAtlas() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'atlas_seeded'").get();
  if (done) return false;
  const mark = () => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('atlas_seeded', '1')").run();
  const has = db.prepare('SELECT (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM clients) AS n').get().n;
  const emp = (u) => db.prepare('SELECT id, department_id FROM employees WHERE username = ?').get(u);
  if (has > 0 || !emp('hind')) {
    mark();
    return false;
  }

  const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
  db.exec('BEGIN');
  try {
    const client = db.prepare(`INSERT INTO clients (name, company, phone, email, stage, value, source, notes, owner_id)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const clients = [
      ['فهد المطيري', 'مجموعة الخليج للتجارة', '+965 5555 1201', 'fahad@gulf-trade.com', 'proposal', 12000, 'معرض', 'يريد نظام إدارة مخزون، ينتظر العرض النهائي.', 'hind'],
      ['شركة النخبة العقارية', 'النخبة العقارية', '+965 5555 3302', 'info@elite-re.com', 'contacted', 8500, 'موقع الشركة', 'تواصلنا مبدئياً، طلبوا اجتماعاً الأسبوع القادم.', 'bader'],
      ['منى الكندري', 'عيادات منى', '+965 5555 7710', 'mona@clinic.com', 'lead', 4000, 'واتساب', '', 'bader'],
      ['مطاعم البحر', 'مطاعم البحر', '+965 5555 4410', 'ops@albahar.com', 'won', 15000, 'توصية', 'عقد سنوي، التجديد في الربع القادم.', 'hind'],
      ['يوسف الشمري', 'متجر يوسف', '+965 5555 9901', '', 'lost', 2500, 'إنستغرام', 'اختار مزوداً أرخص.', 'bader'],
    ].map(([name, company, phone, email, stage, value, source, notes, owner]) =>
      Number(client.run(name, company, phone, email, stage, value, source, notes, emp(owner).id).lastInsertRowid));

    const task = db.prepare(`INSERT INTO tasks (title, description, status, priority, due_date, owner_id, department_id,
                             client_id, created_by, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const admin = emp('admin');
    [
      ['إرسال العرض النهائي لمجموعة الخليج', 'تحديث الأسعار وإرسال PDF', 'doing', 'high', day(0), 'hind', clients[0]],
      ['تجهيز اجتماع النخبة العقارية', 'عرض تقديمي + دراسة احتياج', 'todo', 'normal', day(3), 'bader', clients[1]],
      ['متابعة منى الكندري على واتساب', '', 'todo', 'normal', day(-1), 'bader', clients[2]],
      ['حملة التسويق لشهر القادم', 'محتوى إنستغرام وتيك توك', 'todo', 'normal', day(7), 'latifa', null],
      ['تحديث سياسة الإجازات', '', 'review', 'low', day(2), 'fatima', null],
      ['ترحيل الخادم إلى النسخة الجديدة', 'نسخة احتياطية أولاً', 'doing', 'urgent', day(1), 'abdullah', null],
      ['إقفال حسابات الشهر', '', 'todo', 'high', day(5), 'khaled', null],
      ['تجديد عقد مطاعم البحر', '', 'done', 'normal', day(-4), 'hind', clients[3]],
    ].forEach(([title, desc, status, priority, due, owner, clientId], i) => {
      const e = emp(owner);
      task.run(title, desc, status, priority, due, e.id, e.department_id, clientId, admin.id, i);
    });

    const canvasId = Number(db.prepare("INSERT INTO canvases (name, owner_id) VALUES ('لوحة الشركة', NULL)").run().lastInsertRowid);
    const item = db.prepare(`INSERT INTO canvas_items (canvas_id, kind, text, x, y, w, h, color, created_by)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const sec = item.run(canvasId, 'section', 'أهداف الربع', 40, 40, 560, 360, 'slate', admin.id);
    const a = item.run(canvasId, 'note', 'رفع المبيعات 20%\nالتركيز على عملاء الشركات', 70, 110, 230, 130, 'teal', admin.id);
    const b = item.run(canvasId, 'note', 'إطلاق خدمة الصيانة الشهرية', 330, 110, 230, 130, 'mint', admin.id);
    const c = item.run(canvasId, 'note', 'كل عميل جديد من واتساب يدخل الـ CRM تلقائياً', 660, 120, 250, 130, 'mauve', admin.id);
    item.run(canvasId, 'text', 'اكتب أفكارك هنا — نقرتان على اللوحة لإضافة ملاحظة', 70, 440, 420, 60, 'slate', admin.id);
    void sec;
    const link = db.prepare('INSERT INTO canvas_links (canvas_id, from_id, to_id) VALUES (?, ?, ?)');
    link.run(canvasId, a.lastInsertRowid, b.lastInsertRowid);
    link.run(canvasId, b.lastInsertRowid, c.lastInsertRowid);

    const conv = Number(db.prepare("INSERT INTO wa_conversations (phone, name, client_id, unread) VALUES ('96555557710', 'منى الكندري', ?, 1)")
      .run(clients[2]).lastInsertRowid);
    const msg = db.prepare('INSERT INTO wa_messages (conversation_id, direction, body, status) VALUES (?, ?, ?, ?)');
    msg.run(conv, 'in', 'السلام عليكم، أبي أعرف أسعار النظام للعيادات', 'received');
    msg.run(conv, 'out', 'وعليكم السلام، أهلاً منى! بنرسل لك العرض اليوم 🌹', 'sent');
    msg.run(conv, 'in', 'تمام، بانتظاركم', 'received');

    db.prepare("INSERT INTO activity (event, message, actor) VALUES ('atlas.test', 'تم تشغيل Atlas لأول مرة ✨', 'Atlas')").run();
    mark();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

if (require.main === module) {
  const added = ensureCompany();
  console.log(added.length ? `تمت إضافة: ${added.join('، ')}` : 'كل الأقسام والموظفين موجودون، لم يتغير شيء.');
}

module.exports = { ensureCompany, seedAtlas, DEFAULT_PASSWORD };
