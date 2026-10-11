// CRM vocabulary (stages, deal types, sources) and the calculations behind the dashboard,
// pipeline and reports. Deals are few enough to load once per request and summarise in JS.
const db = require('../db');

const STAGES = [
  { key: 'lead', label: 'عميل محتمل', probability: 10, color: '#8b98b8' },
  { key: 'contacted', label: 'تواصل أولي', probability: 25, color: '#5b8def' },
  { key: 'proposal', label: 'عرض سعر', probability: 50, color: '#a78bfa' },
  { key: 'negotiation', label: 'تفاوض', probability: 75, color: '#f0b429' },
  { key: 'won', label: 'تم الفوز', probability: 100, color: '#2fbf8a' },
  { key: 'lost', label: 'خسارة', probability: 0, color: '#e5675a' },
];
const OPEN_STAGES = ['lead', 'contacted', 'proposal', 'negotiation'];

// What Platinum Gate sells, from its public site: sponsorships, Premium/Custom plans, API access, events.
const TYPES = [
  { key: 'sponsorship', label: 'رعاية', icon: '🏆' },
  { key: 'custom_plan', label: 'خطة مخصصة', icon: '💎' },
  { key: 'team_premium', label: 'اشتراكات Premium جماعية', icon: '⭐' },
  { key: 'api', label: 'تكامل API', icon: '🔌' },
  { key: 'event', label: 'تنظيم بطولة', icon: '🎮' },
  { key: 'partnership', label: 'شراكة', icon: '🤝' },
];

const SOURCES = [
  { key: 'instagram', label: 'إنستغرام' },
  { key: 'website', label: 'الموقع الإلكتروني' },
  { key: 'referral', label: 'توصية' },
  { key: 'event', label: 'فعالية / بطولة' },
  { key: 'outbound', label: 'تواصل مباشر' },
  { key: 'other', label: 'أخرى' },
];

const ACTIVITY_KINDS = [
  { key: 'note', label: 'ملاحظة', icon: '📝' },
  { key: 'call', label: 'مكالمة', icon: '📞' },
  { key: 'meeting', label: 'اجتماع', icon: '👥' },
  { key: 'email', label: 'بريد', icon: '✉️' },
];

const byKey = (list) => Object.fromEntries(list.map((x) => [x.key, x]));
const stageMap = byKey(STAGES);
const typeMap = byKey(TYPES);
const sourceMap = byKey(SOURCES);
const kindMap = byKey([...ACTIVITY_KINDS, { key: 'stage', label: 'تغيير مرحلة', icon: '➜' }]);

// ---------- dates (close_date is YYYY-MM-DD, timestamps are SQLite UTC "YYYY-MM-DD HH:MM:SS") ----------
const DAY = 24 * 60 * 60 * 1000;
const today = () => new Date().toISOString().slice(0, 10);
const toTime = (s) => (s ? Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s.replace(' ', 'T')}Z`) : NaN);
const daysBetween = (from, to) => Math.round((toTime(to) - toTime(from)) / DAY);
const addDays = (date, n) => new Date(toTime(date) + n * DAY).toISOString().slice(0, 10);

// ---------- money (Kuwaiti dinar) ----------
function money(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `${+(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
const moneyFull = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });

// ---------- queries ----------
const q = {
  deals: db.prepare(`
    SELECT d.*, c.full_name AS contact_name, c.company AS company,
           e.full_name AS owner_name,
           (SELECT MAX(a.created_at) FROM crm_activities a WHERE a.deal_id = d.id) AS last_activity_at
    FROM crm_deals d
    LEFT JOIN crm_contacts c ON c.id = d.contact_id
    LEFT JOIN employees e ON e.id = d.owner_id
    ORDER BY d.close_date = '', d.close_date, d.id`),
};

function loadDeals() {
  return q.deals.all().map((d) => ({ ...d, company: d.company || '', weighted: (d.value * d.probability) / 100 }));
}

// Rule-based "Assist": open deals that are likely to slip, most urgent first.
function atRisk(deals, now = today()) {
  const flags = [];
  for (const d of deals) {
    if (!OPEN_STAGES.includes(d.stage)) continue;
    const toClose = d.close_date ? daysBetween(now, d.close_date) : null;
    const idle = daysBetween((d.last_activity_at || d.created_at).slice(0, 10), now);
    let reason = null;
    let urgency = 0;
    if (toClose !== null && toClose < 0) {
      reason = `متأخرة ${-toClose} يوم عن تاريخ الإغلاق`;
      urgency = 100 - toClose;
    } else if (toClose !== null && toClose <= 14 && ['lead', 'contacted', 'proposal'].includes(d.stage)) {
      reason = `تُغلق خلال ${toClose} يوم وما زالت في «${stageMap[d.stage].label}»`;
      urgency = 60 - toClose;
    } else if (idle >= 14) {
      reason = `لا يوجد أي نشاط منذ ${idle} يوم`;
      urgency = idle;
    }
    if (reason) flags.push({ deal: d, reason, urgency });
  }
  return flags.sort((a, b) => b.urgency - a.urgency);
}

function sum(list, f = (d) => d.value) {
  return list.reduce((s, d) => s + f(d), 0);
}

// Won revenue for each of the last `count` calendar months, oldest first.
function monthlyWon(deals, count = 6, now = today()) {
  const months = [];
  const [y, m] = now.split('-').map(Number);
  for (let i = count - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = dt.toISOString().slice(0, 7);
    months.push({
      key,
      label: dt.toLocaleDateString('ar', { month: 'short', timeZone: 'UTC' }),
      value: sum(deals.filter((d) => d.stage === 'won' && d.closed_at.slice(0, 7) === key)),
    });
  }
  return months;
}

function periodStart(period, now = today()) {
  const [y, m] = now.split('-').map(Number);
  if (period === 'month') return `${now.slice(0, 7)}-01`;
  if (period === 'year') return `${y}-01-01`;
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(qm).padStart(2, '0')}-01`;
}

// Share of a total for grouped bar charts: [{ key, label, value, count, pct }]
function groupBy(deals, keyOf, labels) {
  const groups = new Map();
  for (const d of deals) {
    const k = keyOf(d);
    const g = groups.get(k) || { key: k, label: labels(k), value: 0, count: 0 };
    g.value += d.value;
    g.count += 1;
    groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...list.map((g) => g.value));
  return list.map((g) => ({ ...g, pct: Math.round((g.value / max) * 100) }));
}

function summary(deals, period = 'quarter', now = today()) {
  const start = periodStart(period, now);
  const open = deals.filter((d) => OPEN_STAGES.includes(d.stage));
  const closed = deals.filter((d) => d.closed_at && d.closed_at.slice(0, 10) >= start);
  const won = closed.filter((d) => d.stage === 'won');
  const lost = closed.filter((d) => d.stage === 'lost');
  const cycles = won.map((d) => daysBetween(d.created_at.slice(0, 10), d.closed_at.slice(0, 10)));
  return {
    start,
    open,
    won,
    lost,
    openValue: sum(open),
    weighted: sum(open, (d) => d.weighted),
    wonValue: sum(won),
    winRate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : 0,
    avgCycle: cycles.length ? Math.round(sum(cycles, (n) => n) / cycles.length) : 0,
    avgDeal: won.length ? sum(won) / won.length : 0,
    closingSoon: open.filter((d) => d.close_date && daysBetween(now, d.close_date) >= 0 && daysBetween(now, d.close_date) <= 30),
  };
}

module.exports = {
  STAGES, OPEN_STAGES, TYPES, SOURCES, ACTIVITY_KINDS,
  stageMap, typeMap, sourceMap, kindMap,
  today, daysBetween, addDays, money, moneyFull,
  loadDeals, atRisk, monthlyWon, summary, groupBy, sum,
};
