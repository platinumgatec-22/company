#!/usr/bin/env python3
"""Build the Make org-chart HTML (make-structure.html) from the data below.

Data reflects the Make team "My Team" (scenarios_list, 2026-09-30).
Each agent: (name, role, schedule, errors).
"""
SCHED = {"instant": "فوري", "1h": "كل ساعة", "6h": "كل 6 ساعات", "3d": "كل 3 أيام", "daily": "يومي"}

EXEC = [("ألماس", "منسق مساحة العمل", "6h", 0),
        ("لؤلؤ", "المساعد التنفيذي — مسودات وتقارير", "1h", 0),
        ("ماس", "مراجعة الفريق — تقرير يومي موحّد", "daily", 0)]

DEPTS = [
    ("البطولات والعمليات", None, [
        ("كابتن", "منسّق البطولات — خطط وجداول وتذكيرات", "1h", 0),
        ("زمرد", "علاقات الملاعب والمنشآت", "3d", 0),
        ("نحاس", "المشتريات واللوجستيات", "3d", 0)], None),
    ("خدمة العملاء", None, [
        ("بلاتين", "خدمة العملاء عبر واتساب", "instant", 1),
        ("كهرمان", "الشكاوى والاقتراحات", "1h", 0)], None),
    ("التسويق والمحتوى", ("ياقوت", "مدير التسويق", "6h", 0), [
        ("فضة", "كتابة المحتوى وطلب الموافقة", "1h", 0),
        ("برونز", "النشر على فيسبوك وإنستغرام", "6h", 1),
        ("ماس", "النشر الشامل — تيك توك · يوتيوب · Substack", "1h", 2)],
        ("استوديو المحتوى", ("جوهر", "مدير الاستوديو — توزيع ومراجعة وتسليم", "1h", 2), [
            ("عقيق", "كاتب المحتوى", "1h", 1),
            ("فيروز", "مصممة الصور", "1h", 5),
            ("مرجان", "سكربتات الفيديو", "1h", 1)])),
    ("الرعايات والمبيعات", ("زمرّد", "مدير الرعايات", "6h", 0), [
        ("ذهب", "المبيعات وعروض الرعاية", "1h", 0),
        ("عزيزة", "قاعدة الرعاة — مسودات رسائل البطولات", "1h", 0)], None),
    ("الإدارة المالية", ("دينار", "المدير المالي", "6h", 0), [
        ("بوخمسين", "مسؤول الميزانية", "6h", 0),
        ("فلس", "المحاسب", "6h", 0),
        ("بيزة", "المصروفات المتكررة", "6h", 0)], None),
    ("الإدارة القانونية", ("صدر", "رئيس الإدارة القانونية", "6h", 0), [
        ("عدل", "الشؤون القانونية", "6h", 0),
        ("ميثاق", "العقود والتراخيص", "6h", 0),
        ("حصانة", "الامتثال والملكية الفكرية", "6h", 0)], None),
]

INFRA = [("Google Sheets", "40 سيناريو"), ("الذكاء الاصطناعي", "25 سيناريو"), ("Gmail", "23 سيناريو"),
         ("Google Drive", "4"), ("Slack", "2"), ("Notion", "2"),
         ("WhatsApp Business", "Webhook + مخزن ذاكرة"), ("Facebook · Instagram", "2"),
         ("YouTube · Buffer", "1"), ("Claude · Gemini", "توليد الصور")]


def card(a, cls="agent"):
    name, role, sched, err = a
    e = f'<span class="err">⚠ {err}</span>' if err else ""
    return (f'<div class="{cls}"><div class="nm">{name}{e}</div>'
            f'<div class="rl">{role}</div><span class="chip">{SCHED[sched]}</span></div>')


def dept(d):
    title, mgr, members, sub = d
    h = f'<div class="dept"><div class="dh">{title}</div><div class="db">'
    if mgr:
        h += card(mgr, "agent mgr")
    if sub:
        h += '<div class="split"><div class="col">' + "".join(card(m) for m in members) + "</div>"
    else:
        h += "".join(card(m) for m in members)
    if sub:
        st, smgr, smem = sub
        h += f'<div class="sub"><div class="sh">{st}</div>{card(smgr, "agent mgr")}{"".join(card(m) for m in smem)}</div></div>'
    return h + "</div></div>"


agents = len(EXEC) - 1 + sum((1 if d[1] else 0) + len(d[2]) + (1 + len(d[3][2]) if d[3] else 0) for d in DEPTS)
html = open(__file__.replace("build.py", "template.html"), encoding="utf-8").read()
html = (html.replace("{{EXEC}}", "".join(card(a, "agent exec") for a in EXEC))
            .replace("{{DEPTS}}", "".join(dept(d) for d in DEPTS))
            .replace("{{INFRA}}", "".join(f'<div class="inf"><b>{n}</b> <span>— {c}</span></div>' for n, c in INFRA))
            .replace("{{AGENTS}}", str(agents)))
open(__file__.replace("build.py", "make-structure.html"), "w", encoding="utf-8").write(html)
print("agents:", agents)
