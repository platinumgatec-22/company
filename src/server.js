const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { createWorkflowRouter, inboxFor, inWorkflow, ROLES } = require('./workflow');
const agents = require('./agents');
const { createConnectRoutes } = require('./connect');
const { createAppRoutes, checkMake, scenariosFor } = require('./apps');
const createAtlas = require('./atlas/routes');
const { emit } = require('./atlas/events');
const { ensureCompany, seedAtlas } = require('./seed');

const PORT = Number(process.env.PORT) || 3000;
const COMPANY_NAME = process.env.COMPANY_NAME || 'البوابة البلاتينية';
const COMPANY_NAME_EN = process.env.COMPANY_NAME_EN || 'Platinum Gate';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || 'info@platinumgatekw.com';
const INSTAGRAM = process.env.INSTAGRAM || 'championshipskw';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('تنبيه: لم يتم ضبط SESSION_SECRET، سيتم تسجيل خروج الجميع عند إعادة تشغيل الخادم.');
}

{
  const added = ensureCompany();
  if (added.includes('admin')) console.log(`تم إنشاء حساب مدير النظام (admin / ${process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD' : 'admin123'}).`);
  if (added.length) console.log(`تمت إضافة ${added.length} حساب من فريق البوابة البلاتينية.`);
}
if (seedAtlas()) console.log('تم إنشاء بيانات Atlas التجريبية.');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
// Keep the raw body so webhook signatures (Meta) can be verified.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(cookieSession({
  name: 'session',
  secret: SESSION_SECRET,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 8 * 60 * 60 * 1000,
}));

// ---------- queries ----------
const q = {
  employeeById: db.prepare(`
    SELECT e.*, d.name AS department_name, d.icon AS department_icon
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE e.id = ?`),
  employeeByUsername: db.prepare('SELECT * FROM employees WHERE username = ?'),
  departments: db.prepare(`
    SELECT d.*, COUNT(e.id) AS employee_count,
           (SELECT full_name FROM employees m
             WHERE m.department_id = d.id AND m.is_manager = 1 AND m.is_active = 1 LIMIT 1) AS manager_name
    FROM departments d
    LEFT JOIN employees e ON e.department_id = d.id AND e.is_active = 1
    GROUP BY d.id ORDER BY d.id`),
  departmentById: db.prepare('SELECT * FROM departments WHERE id = ?'),
  employeesInDepartment: db.prepare(`
    SELECT * FROM employees
    WHERE department_id = ? AND is_active = 1
      AND (? = '' OR full_name LIKE ? OR job_title LIKE ? OR username LIKE ?)
    ORDER BY is_manager DESC, full_name`),
  searchEmployees: db.prepare(`
    SELECT e.*, d.name AS department_name, d.icon AS department_icon
    FROM employees e LEFT JOIN departments d ON d.id = e.department_id
    WHERE (? = 1 OR e.is_active = 1)
      AND (? = '' OR e.full_name LIKE ? OR e.job_title LIKE ? OR e.username LIKE ? OR e.email LIKE ?)
      AND (? = 0 OR e.department_id = ?)
    ORDER BY d.id, e.is_manager DESC, e.full_name`),
  stats: db.prepare(`
    SELECT (SELECT COUNT(*) FROM departments) AS departments,
           (SELECT COUNT(*) FROM employees WHERE is_active = 1) AS employees,
           (SELECT COUNT(*) FROM employees WHERE is_active = 1 AND is_manager = 1) AS managers,
           (SELECT COUNT(*) FROM employees WHERE is_active = 1 AND is_digital = 1) AS digital,
           (SELECT COUNT(*) FROM app_docs WHERE app = 'tournaments' AND col = 'tournaments') AS tournaments`),
};

// ---------- helpers ----------
const like = (s) => `%${s}%`;
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

function flash(req, type, message) {
  req.session.flash = { type, message };
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  // Skip the Arabic definite article so "أحمد العلي" gives "أ ع" rather than "أ ا".
  const first = (w) => (w.startsWith('ال') && w.length > 2 ? w[2] : w[0]);
  return parts.length === 1 ? parts[0][0] : `${parts[0][0]} ${first(parts[parts.length - 1])}`;
}

function avatarColor(id) {
  const hues = [210, 160, 280, 20, 340, 45, 190, 120];
  return `hsl(${hues[id % hues.length]} 55% 45%)`;
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- per-request locals ----------
app.use((req, res, next) => {
  res.locals.company = COMPANY_NAME;
  res.locals.companyEn = COMPANY_NAME_EN;
  res.locals.contactEmail = CONTACT_EMAIL;
  res.locals.instagram = INSTAGRAM;
  res.locals.year = new Date().getFullYear();
  res.locals.path = req.path;
  res.locals.initials = initials;
  res.locals.avatarColor = avatarColor;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;

  res.locals.user = null;
  res.locals.workflowInbox = 0;
  const userId = req.session.userId;
  if (userId) {
    const user = q.employeeById.get(userId);
    if (user && user.is_active) {
      req.user = user;
      res.locals.user = user;
      if (inWorkflow(user)) res.locals.workflowInbox = inboxFor(user).length;
    } else {
      req.session = null;
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) {
    flash(req, 'info', 'الرجاء تسجيل الدخول أولاً.');
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  // Force a password change before using the portal with a default/reset password.
  if (req.user.must_change_password && !req.path.startsWith('/profile') && req.path !== '/logout') {
    flash(req, 'warning', 'يجب تغيير كلمة المرور قبل المتابعة.');
    return res.redirect('/profile');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'غير مصرح', message: 'هذه الصفحة متاحة لمدير النظام فقط.' });
  }
  next();
}

// ---------- public ----------
app.get('/', (req, res) => {
  res.render('home', { title: 'الرئيسية', stats: q.stats.get(), departments: q.departments.all() });
});

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/atlas');
  res.render('login', { title: 'تسجيل الدخول', next: clean(req.query.next), username: '' });
});

app.post('/login', asyncRoute(async (req, res) => {
  const username = clean(req.body.username);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const next = clean(req.body.next);
  const user = username ? q.employeeByUsername.get(username) : null;

  const ok = user && user.is_active && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    res.locals.flash = { type: 'error', message: 'اسم المستخدم أو كلمة المرور غير صحيحة.' };
    return res.status(401).render('login', { title: 'تسجيل الدخول', next, username });
  }

  req.session.userId = user.id;
  flash(req, 'success', `أهلاً ${user.full_name} 👋`);
  // Only allow local redirects.
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/atlas');
}));

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ---------- employee portal ----------
app.get('/departments', requireAuth, (req, res) => {
  res.render('departments', { title: 'الأقسام', departments: q.departments.all(), stats: q.stats.get() });
});

app.get('/departments/:id', requireAuth, (req, res) => {
  const department = q.departmentById.get(toId(req.params.id));
  if (!department) return res.status(404).render('error', { title: 'غير موجود', message: 'القسم غير موجود.' });

  const search = clean(req.query.q);
  const s = like(search);
  const employees = q.employeesInDepartment.all(department.id, search, s, s, s);
  res.render('department', { title: department.name, department, employees, search });
});

app.get('/employees', requireAuth, (req, res) => {
  const search = clean(req.query.q);
  const deptId = toId(req.query.department);
  const s = like(search);
  const employees = q.searchEmployees.all(0, search, s, s, s, s, deptId, deptId);
  res.render('employees', {
    title: 'دليل الموظفين', employees, search, deptId, departments: q.departments.all(),
  });
});

app.get('/employees/:id', requireAuth, asyncRoute(async (req, res) => {
  const employee = q.employeeById.get(toId(req.params.id));
  if (!employee || (!employee.is_active && req.user.role !== 'admin')) {
    return res.status(404).render('error', { title: 'غير موجود', message: 'الموظف غير موجود.' });
  }
  // A digital employee's live scenarios in Make, for the admin and the owner.
  let scenarios = null;
  let makeError = '';
  if (employee.make_names && (req.user.role === 'admin' || req.user.workflow_role === 'owner')) {
    try {
      scenarios = await scenariosFor(employee.make_names);
    } catch (err) {
      makeError = 'تعذر الوصول إلى Make الآن.';
      console.error(`Make scenarios: ${err.message}`);
    }
  }
  res.render('employee', { title: employee.full_name, employee, scenarios, makeError });
}));

// ---------- my profile ----------
app.get('/profile', requireAuth, (req, res) => {
  res.render('profile', { title: 'حسابي' });
});

app.post('/profile', requireAuth, (req, res) => {
  const email = clean(req.body.email);
  const phone = clean(req.body.phone);
  const bio = clean(req.body.bio).slice(0, 500);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    flash(req, 'error', 'البريد الإلكتروني غير صالح.');
    return res.redirect('/profile');
  }
  db.prepare('UPDATE employees SET email = ?, phone = ?, bio = ? WHERE id = ?').run(email, phone, bio, req.user.id);
  flash(req, 'success', 'تم حفظ بياناتك.');
  res.redirect('/profile');
});

app.post('/profile/password', requireAuth, asyncRoute(async (req, res) => {
  const { current_password: current = '', new_password: next = '', confirm_password: confirm = '' } = req.body;
  if (!(await bcrypt.compare(String(current), req.user.password_hash))) {
    flash(req, 'error', 'كلمة المرور الحالية غير صحيحة.');
  } else if (String(next).length < 6) {
    flash(req, 'error', 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل.');
  } else if (next !== confirm) {
    flash(req, 'error', 'تأكيد كلمة المرور غير مطابق.');
  } else if (next === current) {
    flash(req, 'error', 'اختر كلمة مرور مختلفة عن الحالية.');
  } else {
    const hash = await bcrypt.hash(String(next), 10);
    db.prepare('UPDATE employees SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, req.user.id);
    flash(req, 'success', 'تم تغيير كلمة المرور بنجاح.');
    return res.redirect('/atlas');
  }
  res.redirect('/profile');
}));

// ---------- admin: departments ----------
const admin = express.Router();
admin.use(requireAuth, requireAdmin);

admin.get('/', (req, res) => res.redirect('/admin/employees'));

admin.get('/departments', (req, res) => {
  res.render('admin/departments', { title: 'إدارة الأقسام', departments: q.departments.all() });
});

admin.get('/departments/new', (req, res) => {
  res.render('admin/department-form', { title: 'قسم جديد', department: { name: '', icon: '🏢', description: '' } });
});

admin.get('/departments/:id/edit', (req, res) => {
  const department = q.departmentById.get(toId(req.params.id));
  if (!department) return res.redirect('/admin/departments');
  res.render('admin/department-form', { title: 'تعديل قسم', department });
});

function saveDepartment(req, res) {
  const id = toId(req.params.id);
  const department = {
    id,
    name: clean(req.body.name),
    icon: clean(req.body.icon) || '🏢',
    description: clean(req.body.description),
  };
  const render = (message) => {
    res.locals.flash = { type: 'error', message };
    res.status(400).render('admin/department-form', { title: id ? 'تعديل قسم' : 'قسم جديد', department });
  };
  if (!department.name) return render('اسم القسم مطلوب.');

  try {
    if (id) {
      db.prepare('UPDATE departments SET name = ?, icon = ?, description = ? WHERE id = ?')
        .run(department.name, department.icon, department.description, id);
    } else {
      db.prepare('INSERT INTO departments (name, icon, description) VALUES (?, ?, ?)')
        .run(department.name, department.icon, department.description);
    }
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return render('يوجد قسم بنفس الاسم.');
    throw err;
  }
  flash(req, 'success', 'تم حفظ القسم.');
  res.redirect('/admin/departments');
}

admin.post('/departments', saveDepartment);
admin.post('/departments/:id', saveDepartment);

admin.post('/departments/:id/delete', (req, res) => {
  const id = toId(req.params.id);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM employees WHERE department_id = ?').get(id);
  if (n > 0) {
    flash(req, 'error', 'لا يمكن حذف قسم يحتوي على موظفين. انقلهم إلى قسم آخر أولاً.');
  } else {
    db.prepare('DELETE FROM departments WHERE id = ?').run(id);
    flash(req, 'success', 'تم حذف القسم.');
  }
  res.redirect('/admin/departments');
});

// ---------- admin: employees ----------
admin.get('/employees', (req, res) => {
  const search = clean(req.query.q);
  const deptId = toId(req.query.department);
  const s = like(search);
  res.render('admin/employees', {
    title: 'إدارة الموظفين',
    employees: q.searchEmployees.all(1, search, s, s, s, s, deptId, deptId),
    departments: q.departments.all(),
    search,
    deptId,
  });
});

const emptyEmployee = {
  full_name: '', username: '', email: '', phone: '', job_title: '', department_id: 0,
  is_manager: 0, role: 'employee', hire_date: '', bio: '', is_active: 1,
  workflow_role: '', instagram_account: '', buffer_user: '', is_digital: 0,
};
const handle = (v) => clean(v).replace(/^@+/, '').toLowerCase();

admin.get('/employees/new', (req, res) => {
  res.render('admin/employee-form', {
    title: 'موظف جديد', employee: { ...emptyEmployee, department_id: toId(req.query.department) },
    departments: q.departments.all(), ROLES,
  });
});

admin.get('/employees/:id/edit', (req, res) => {
  const employee = q.employeeById.get(toId(req.params.id));
  if (!employee) return res.redirect('/admin/employees');
  res.render('admin/employee-form', { title: 'تعديل موظف', employee, departments: q.departments.all(), ROLES });
});

async function saveEmployee(req, res) {
  const id = toId(req.params.id);
  const b = req.body;
  const employee = {
    id,
    full_name: clean(b.full_name),
    username: clean(b.username).toLowerCase(),
    email: clean(b.email),
    phone: clean(b.phone),
    job_title: clean(b.job_title),
    department_id: toId(b.department_id) || null,
    is_manager: b.is_manager ? 1 : 0,
    role: b.role === 'admin' ? 'admin' : 'employee',
    hire_date: clean(b.hire_date),
    bio: clean(b.bio).slice(0, 500),
    is_active: b.is_active ? 1 : 0,
    workflow_role: ROLES[b.workflow_role] ? b.workflow_role : '',
    is_digital: b.is_digital ? 1 : 0,
    instagram_account: handle(b.instagram_account),
    buffer_user: clean(b.buffer_user),
  };
  const password = typeof b.password === 'string' ? b.password : '';
  const render = (message) => {
    res.locals.flash = { type: 'error', message };
    res.status(400).render('admin/employee-form', {
      title: id ? 'تعديل موظف' : 'موظف جديد', employee, departments: q.departments.all(), ROLES,
    });
  };

  if (!employee.full_name) return render('اسم الموظف مطلوب.');
  if (!/^[a-z0-9._-]{3,32}$/.test(employee.username)) {
    return render('اسم المستخدم يجب أن يكون 3-32 حرفاً إنجليزياً أو أرقام أو (. _ -).');
  }
  if (employee.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)) return render('البريد الإلكتروني غير صالح.');
  if (employee.instagram_account && !/^[a-z0-9._]{1,30}$/.test(employee.instagram_account)) {
    return render('حساب إنستقرام غير صالح (حروف إنجليزية وأرقام و . _ فقط).');
  }
  if (employee.workflow_role === 'publisher' && (!employee.instagram_account || !employee.buffer_user)) {
    return render('موظف النشر يحتاج حساب إنستقرام ومستخدم Buffer خاصين به.');
  }
  if (!id && password.length < 6) return render('كلمة المرور المبدئية يجب أن تكون 6 أحرف على الأقل.');
  if (id && password && password.length < 6) return render('كلمة المرور يجب أن تكون 6 أحرف على الأقل.');
  if (id === req.user.id && (employee.role !== 'admin' || !employee.is_active)) {
    return render('لا يمكنك إزالة صلاحية المدير أو تعطيل حسابك بنفسك.');
  }

  const fields = ['full_name', 'username', 'email', 'phone', 'job_title', 'department_id',
    'is_manager', 'role', 'hire_date', 'bio', 'is_active', 'workflow_role', 'instagram_account', 'buffer_user', 'is_digital'];
  const values = fields.map((f) => employee[f]);

  try {
    if (id) {
      db.prepare(`UPDATE employees SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
      if (password) {
        db.prepare('UPDATE employees SET password_hash = ?, must_change_password = 1 WHERE id = ?')
          .run(await bcrypt.hash(password, 10), id);
      }
    } else {
      db.prepare(`INSERT INTO employees (${fields.join(', ')}, password_hash, must_change_password)
                  VALUES (${fields.map(() => '?').join(', ')}, ?, 1)`)
        .run(...values, await bcrypt.hash(password, 10));
    }
  } catch (err) {
    if (/instagram/.test(err.message)) return render('حساب الإنستقرام هذا مربوط بموظف آخر.');
    if (/buffer/.test(err.message)) return render('مستخدم Buffer هذا مربوط بموظف آخر.');
    if (/UNIQUE/.test(err.message)) return render('اسم المستخدم مستخدم من قبل موظف آخر.');
    throw err;
  }
  if (!id) emit('employee.created', { message: `أضاف الموظف «${employee.full_name}»`, actor: req.user, data: { username: employee.username } });
  flash(req, 'success', id ? 'تم تحديث بيانات الموظف.' : `تم إنشاء حساب ${employee.full_name} (اسم المستخدم: ${employee.username}).`);
  res.redirect('/admin/employees');
}

admin.post('/employees', asyncRoute(saveEmployee));
admin.post('/employees/:id', asyncRoute(saveEmployee));

admin.post('/employees/:id/delete', (req, res) => {
  const id = toId(req.params.id);
  if (id === req.user.id) {
    flash(req, 'error', 'لا يمكنك حذف حسابك.');
  } else {
    db.prepare('DELETE FROM employees WHERE id = ?').run(id);
    flash(req, 'success', 'تم حذف الموظف.');
  }
  res.redirect('/admin/employees');
});

app.use('/admin', admin);

// ---------- publishing workflow ----------
app.use(agents.createAgentRoutes({ toId, clean }));
app.use(createConnectRoutes({ requireAuth, requireAdmin, flash, clean, toId }));
app.use(createAppRoutes({ requireAuth }));
app.use('/workflow', createWorkflowRouter({ requireAuth, flash, clean, toId }));

// ---------- Atlas ----------
const atlas = createAtlas({ requireAuth, requireAdmin });
app.use('/atlas', atlas.atlas);
app.use('/webhooks', atlas.hooks);
app.use('/api/v1', atlas.api);

// ---------- errors ----------
app.use((req, res) => {
  res.status(404).render('error', { title: 'غير موجود', message: 'الصفحة المطلوبة غير موجودة.' });
});

app.use((err, req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  if (req.path.startsWith('/api/') || req.path.startsWith('/atlas/api/')) return res.status(500).json({ error: 'Internal error' });
  res.status(500).render('error', { title: 'خطأ', message: 'حدث خطأ غير متوقع، حاول مرة أخرى.' });
});

if (require.main === module) {
  agents.start();
  checkMake();
  app.listen(PORT, () => console.log(`${COMPANY_NAME}: http://localhost:${PORT}`));
}

module.exports = app;
