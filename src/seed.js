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

if (require.main === module) {
  console.log(seed() ? 'تمت إضافة البيانات التجريبية.' : 'قاعدة البيانات تحتوي على بيانات مسبقاً، لم يتم تغيير شيء.');
}

module.exports = { seed, DEFAULT_PASSWORD };
