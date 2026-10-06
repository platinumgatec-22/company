// Fills an empty database with sample departments and employees.
// Run directly (`npm run seed`) or automatically on first server start.
const bcrypt = require('bcryptjs');
const db = require('./db');

const DEFAULT_PASSWORD = '123456';

const departments = [
  { name: 'الإدارة العليا', icon: '🏛️', description: 'رسم الاستراتيجية العامة للشركة واتخاذ القرارات الرئيسية.' },
  { name: 'الموارد البشرية', icon: '🧑‍🤝‍🧑', description: 'التوظيف، شؤون الموظفين، التدريب والتطوير.' },
  { name: 'المالية والمحاسبة', icon: '💰', description: 'الميزانيات، الرواتب، التقارير المالية والمشتريات.' },
  { name: 'تقنية المعلومات', icon: '💻', description: 'الأنظمة، الشبكات، الدعم الفني وتطوير البرمجيات.' },
  { name: 'المبيعات', icon: '📈', description: 'إدارة العملاء، العروض والعقود وتحقيق أهداف المبيعات.' },
  { name: 'التسويق', icon: '📣', description: 'الهوية، الحملات الإعلانية، ووسائل التواصل الاجتماعي.' },
  { name: 'العمليات', icon: '⚙️', description: 'تنفيذ المشاريع ومتابعة الجودة وسلاسل الإمداد.' },
];

// [full_name, username, job_title, department index, is_manager]
const employees = [
  ['أحمد العلي', 'ahmad', 'المدير التنفيذي', 0, 1],
  ['سارة الكندري', 'sara', 'نائب المدير التنفيذي', 0, 0],
  ['فاطمة الرشيد', 'fatima', 'مديرة الموارد البشرية', 1, 1],
  ['يوسف الحربي', 'yousef', 'أخصائي توظيف', 1, 0],
  ['نورة المطيري', 'noura', 'منسقة تدريب', 1, 0],
  ['خالد العنزي', 'khaled', 'المدير المالي', 2, 1],
  ['مريم الشمري', 'maryam', 'محاسبة', 2, 0],
  ['عبدالله السالم', 'abdullah', 'مدير تقنية المعلومات', 3, 1],
  ['محمد الهاجري', 'mohammad', 'مطوّر برمجيات', 3, 0],
  ['ريم الصباح', 'reem', 'مهندسة شبكات', 3, 0],
  ['عمر الدوسري', 'omar', 'فني دعم', 3, 0],
  ['هند العتيبي', 'hind', 'مديرة المبيعات', 4, 1],
  ['بدر القحطاني', 'bader', 'مندوب مبيعات', 4, 0],
  ['لطيفة الفضلي', 'latifa', 'مديرة التسويق', 5, 1],
  ['جاسم البلوشي', 'jasem', 'مصمم جرافيك', 5, 0],
  ['دانة الرفاعي', 'dana', 'أخصائية تواصل اجتماعي', 5, 0],
  ['سلمان العجمي', 'salman', 'مدير العمليات', 6, 1],
  ['حصة الخالدي', 'hessa', 'مشرفة جودة', 6, 0],
];

function seed() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM employees').get();
  if (n > 0) return false;

  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  const insertDept = db.prepare('INSERT INTO departments (name, icon, description) VALUES (?, ?, ?)');
  const insertEmp = db.prepare(`
    INSERT INTO employees (full_name, username, password_hash, email, phone, job_title,
                           department_id, is_manager, role, hire_date, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    const deptIds = departments.map((d) => Number(insertDept.run(d.name, d.icon, d.description).lastInsertRowid));

    insertEmp.run('مدير النظام', 'admin', bcrypt.hashSync('admin123', 10), 'admin@company.com', '',
      'مسؤول النظام', deptIds[3], 0, 'admin', '2020-01-01', 1);

    employees.forEach(([name, username, title, deptIdx, isManager], i) => {
      const phone = `+965 5${String(1000000 + i * 73519).slice(-7)}`;
      const year = 2015 + (i % 10);
      const month = String((i % 12) + 1).padStart(2, '0');
      insertEmp.run(name, username, hash, `${username}@company.com`, phone, title,
        deptIds[deptIdx], isManager, 'employee', `${year}-${month}-01`, 1);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
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
  console.log(seed() ? 'تمت إضافة البيانات التجريبية.' : 'قاعدة البيانات تحتوي على بيانات مسبقاً، لم يتم تغيير شيء.');
  if (seedAtlas()) console.log('تمت إضافة بيانات Atlas التجريبية.');
}

module.exports = { seed, seedAtlas, DEFAULT_PASSWORD };
