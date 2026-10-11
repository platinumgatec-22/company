// Fills an empty CRM with sample Platinum Gate clients and deals, dated relative to today
// so the dashboard always looks current. Runs on first start with a fresh database,
// or directly (`npm run seed:crm`) when the CRM has no deals yet.
const db = require('../db');
const { stageMap, addDays, today } = require('./model');

// [full_name, company, job_title, source]
const contacts = [
  ['فهد الصالح', 'زين الكويت', 'مدير الرعايات', 'outbound'],
  ['منيرة العوضي', 'بنك بوبيان', 'مديرة التسويق', 'referral'],
  ['طلال المطوع', 'نادي الكويت للرياضات الإلكترونية', 'رئيس النادي', 'instagram'],
  ['شهد الكندري', 'جامعة الكويت - اتحاد الطلبة', 'منسقة الأنشطة', 'website'],
  ['ناصر الشايع', 'GameHub Kuwait', 'المؤسس', 'event'],
  ['دلال الغانم', 'Talabat', 'مديرة الشراكات', 'outbound'],
  ['مشاري الرومي', 'X-cite', 'مدير العلامة التجارية', 'referral'],
  ['عبير المسلم', 'وزارة الشباب', 'رئيسة قسم الفعاليات', 'event'],
  ['يعقوب بهبهاني', 'Arena Esports Café', 'المدير العام', 'instagram'],
  ['هيا الفليج', 'مدارس البيان ثنائية اللغة', 'مديرة الأنشطة', 'website'],
];

// [title, contact index, type, stage, value KWD, close in days (negative = past), created days ago, last activity days ago]
const deals = [
  ['رعاية الدوري الرمضاني', 0, 'sponsorship', 'negotiation', 18500, 9, 40, 2],
  ['رعاية شعار صفحة البطولات', 1, 'sponsorship', 'proposal', 7200, 6, 25, 3],
  ['خطة مخصصة للنادي - 512 لاعب', 2, 'custom_plan', 'won', 4800, -12, 50, 12],
  ['بطولة FIFA الجامعية', 3, 'event', 'contacted', 3500, 20, 10, 4],
  ['تكامل API لعرض الجداول', 4, 'api', 'proposal', 2900, -2, 35, 9],
  ['رعاية تحدي التوصيل', 5, 'sponsorship', 'lead', 12000, 45, 5, 5],
  ['حملة إعلانية داخل المنصة', 6, 'sponsorship', 'negotiation', 9600, 14, 30, 16],
  ['بطولة الشباب الوطنية', 7, 'event', 'proposal', 22000, 12, 28, 1],
  ['اشتراكات Premium لفروع المقهى', 8, 'team_premium', 'won', 1450, -30, 60, 30],
  ['دوري المدارس - الفصل الثاني', 9, 'event', 'lead', 2600, 60, 3, 3],
  ['شراكة بطولات الجامعات', 3, 'partnership', 'lost', 5000, -20, 70, 20],
  ['رعاية بطولة الصيف', 0, 'sponsorship', 'won', 15000, -70, 120, 70],
  ['خطة مخصصة - دوري المقاهي', 8, 'custom_plan', 'contacted', 3100, 25, 12, 15],
  ['تكامل API لتطبيق البنك', 1, 'api', 'won', 6400, -100, 150, 100],
  ['بطولة اليوم الوطني', 7, 'event', 'won', 11000, -5, 45, 5],
];

const notes = [
  ['call', 'اتصال تعريفي، مهتمون برعاية موسم كامل وليس بطولة واحدة.'],
  ['meeting', 'اجتماع في مكتبهم، عرضنا لوحة البطولات المباشرة وأُعجبوا بخاصية البث.'],
  ['email', 'أرسلنا عرض السعر مع ثلاث باقات رعاية.'],
  ['note', 'ينتظرون موافقة الإدارة المالية قبل التوقيع.'],
];

function seedCrm() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM crm_deals').get();
  if (n > 0) return false;

  const owners = db.prepare(`SELECT id FROM employees WHERE username IN ('hind', 'bader', 'latifa') AND is_active = 1 ORDER BY id`)
    .all().map((r) => r.id);
  if (owners.length === 0) owners.push(...db.prepare('SELECT id FROM employees ORDER BY id LIMIT 1').all().map((r) => r.id));

  const now = today();
  const stamp = (daysAgo) => `${addDays(now, -daysAgo)} 09:00:00`;
  const insertContact = db.prepare(`INSERT INTO crm_contacts (full_name, company, job_title, email, phone, source, owner_id, created_at)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDeal = db.prepare(`
    INSERT INTO crm_deals (title, contact_id, type, stage, value, probability, close_date, owner_id, source,
                           lost_reason, stage_changed_at, closed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertActivity = db.prepare(`INSERT INTO crm_activities (deal_id, contact_id, author_id, kind, body, created_at)
                                     VALUES (?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    const contactIds = contacts.map(([name, company, title, source], i) => Number(insertContact.run(
      name, company, title, `contact${i + 1}@example.com`, `+965 6${String(5000000 + i * 91237).slice(-7)}`,
      source, owners[i % owners.length], stamp(160 - i * 5),
    ).lastInsertRowid));

    deals.forEach(([title, ci, type, stage, value, closeIn, createdAgo, lastAgo], i) => {
      const closed = stage === 'won' || stage === 'lost';
      const owner = owners[i % owners.length];
      const dealId = Number(insertDeal.run(
        title, contactIds[ci], type, stage, value, stageMap[stage].probability, addDays(now, closeIn), owner,
        contacts[ci][3], stage === 'lost' ? 'اختاروا منصة أخرى بسعر أقل' : '',
        stamp(Math.min(createdAgo, lastAgo + 3)), closed ? stamp(-closeIn > 0 ? -closeIn : 0) : '', stamp(createdAgo),
      ).lastInsertRowid);
      const [kind, body] = notes[i % notes.length];
      insertActivity.run(dealId, null, owner, kind, body, stamp(lastAgo));
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

if (require.main === module) {
  console.log(seedCrm() ? 'تمت إضافة بيانات المبيعات التجريبية.' : 'يوجد صفقات مسبقاً، لم يتم تغيير شيء.');
}

module.exports = { seedCrm };
