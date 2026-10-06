# موقع الشركة + Atlas (نظام تشغيل الشركة)

## ◉ Atlas

بعد تسجيل الدخول يفتح **Atlas**: مدار الشركة — كوكب في المنتصف وكل وحدات الشركة تدور حوله، مع «مساء الخير، فلان. 3 أشياء تنتظرك».

| الوحدة | ماذا تفعل |
|---|---|
| **المدار** `/atlas` | الصفحة الرئيسية: ما ينتظرك (مهام متأخرة/اليوم، اقتراحات، رسائل غير مقروءة)، الأرقام، آخر النشاط، وحالة الربط. |
| **المهام** `/atlas/board` | لوحة كانبان (للتنفيذ / قيد العمل / مراجعة / منجزة) بالسحب والإفلات، أولوية، مسؤول، قسم، عميل، تاريخ استحقاق. |
| **التقويم** `/atlas/calendar` | المهام حسب تاريخ الاستحقاق (الأسبوع يبدأ السبت). |
| **اللوحات** `/atlas/canvas` | لوحات حرة (مشتركة أو خاصة): ملاحظات، نصوص، أقسام، مهام، وروابط بينها. أي ملاحظة تتحول إلى مهمة حقيقية بضغطة. |
| **العملاء (CRM)** `/atlas/clients` | خط المبيعات بالمراحل مع السحب، القيمة، المسؤول، سجل التواصل، المهام، ومحادثة واتساب العميل. |
| **واتساب** `/atlas/inbox` | صندوق محادثات مشترك عبر WhatsApp Cloud API. كل رقم جديد يراسلكم يصير «عميل محتمل» تلقائياً. |
| **المستشار** `/atlas/strategist` | وكيل Claude («The Strategist») يقرأ بيانات الشركة الحقيقية ويقترح مهام/عملاء/رسائل واتساب/ملاحظات — **ولا ينفّذ شيئاً قبل موافقتك**. |
| **النشاط** `/atlas/activity` | سجل كل ما يحدث (من الفريق، واتساب، Make). |
| **الأتمتة** `/atlas/automations` | (لمدير النظام) ربط Make وواتساب وClaude، مفاتيح API، وسجل الإرسال. |

### الربط مع Make

1. **Atlas → Make:** في Make أنشئ سيناريو يبدأ بـ *Webhooks → Custom webhook*، والصق الرابط في صفحة الأتمتة واختر الأحداث. كل حدث يُرسل JSON:
   `{ "event": "task.created", "at": "...", "actor": {...}, "data": {...} }`
   الأحداث: `task.created`, `task.updated`, `task.status_changed`, `task.deleted`, `client.created`, `client.updated`, `client.stage_changed`, `interaction.created`, `whatsapp.received`, `whatsapp.sent`, `note.created`, `proposal.approved`, `employee.created`.
   يمكن وضع «سر توقيع» فيُرسل `X-Atlas-Signature: sha256=<HMAC>`.
2. **Make → Atlas:** أنشئ مفتاح API من صفحة الأتمتة، واستخدم في Make وحدة *HTTP → Make a request* مع `Authorization: Bearer <key>`:

   ```
   GET    /api/v1/overview | /employees | /departments
   GET    /api/v1/tasks?status=&owner_id=&client_id=&q=
   POST   /api/v1/tasks                  PATCH /api/v1/tasks/:id      DELETE /api/v1/tasks/:id
   GET    /api/v1/clients?stage=&q=      GET   /api/v1/clients/by-phone/:phone
   POST   /api/v1/clients                PATCH /api/v1/clients/:id
   POST   /api/v1/clients/:id/interactions
   POST   /api/v1/notes                  POST  /api/v1/activity
   POST   /api/v1/whatsapp/send          {"to": "+965...", "text": "..."}
   ```
3. **سيناريوهات Make داخل Atlas:** أضف `Make API token` و`Team ID` (و`zone` مثل `eu1.make.com`) لعرض سيناريوهاتك وتشغيلها من Atlas.

### واتساب (WhatsApp Cloud API)

من Meta for Developers: أنشئ تطبيق WhatsApp، وخذ **Access token** و**Phone number ID**، وضعهم في صفحة الأتمتة مع **Verify token** من اختيارك.
في إعدادات الـ Webhook عند Meta: Callback URL = `https://<موقعك>/webhooks/whatsapp`، ثم اشترك في `messages`.
ضع **App secret** ليتم التحقق من توقيع كل رسالة واردة (موصى به بشدة في الإنتاج).
خيار `WHATSAPP_NOTIFY=1` يرسل للموظف رسالة واتساب عندما تُسند إليه مهمة (يحتاج رقم هاتفه في ملفه).
> ملاحظة: واتساب يسمح بالرسائل الحرة فقط خلال 24 ساعة من آخر رسالة للعميل؛ بعدها تحتاج قوالب معتمدة (يمكن إرسالها عبر Make).

### المستشار (Claude)

ضع مفتاح Anthropic API في صفحة الأتمتة (أو `ANTHROPIC_API_KEY`). النموذج الافتراضي `claude-opus-5-5` ويمكن تغييره (`ATLAS_MODEL`).
المستشار يملك أدوات قراءة (الأرقام، المهام، العملاء، الفريق، النشاط) وأدوات «اقتراح» فقط؛ كل اقتراح يظهر لك بزر «موافق / لا».

---

## بوابة الموظفين

الموقع يحتوي أيضاً على:

- **صفحة رئيسية عامة**: من نحن، أقسام الشركة، تواصل معنا.
- **حساب دخول لكل موظف** (اسم مستخدم + كلمة مرور مشفّرة).
- **الأقسام**: بعد تسجيل الدخول تظهر كل الأقسام، وعند الضغط على أي قسم تظهر قائمة موظفيه (مع البحث داخل القسم، وتمييز رئيس القسم).
- **ملف الموظف**: المسمى الوظيفي، القسم، البريد، الهاتف، تاريخ التعيين، نبذة.
- **دليل الموظفين**: بحث في جميع الأقسام مع تصفية حسب القسم.
- **حسابي**: كل موظف يعدّل بريده وهاتفه ونبذته ويغيّر كلمة المرور.
- **لوحة الإدارة** (لمدير النظام فقط): إضافة/تعديل/حذف الأقسام والموظفين، إنشاء حسابات، إعادة تعيين كلمات المرور، تعطيل الحسابات.
- عند أول دخول (أو بعد إعادة تعيين كلمة المرور) يُجبر الموظف على تغيير كلمة المرور.
- تصميم عربي (RTL) متجاوب مع الجوال.

## التشغيل

يتطلب Node.js الإصدار 22.13 أو أحدث (يستخدم قاعدة SQLite المدمجة في Node).

```bash
npm install
npm start
```

ثم افتح: http://localhost:3000

عند التشغيل الأول تُنشأ قاعدة البيانات في `data/company.db` مع بيانات تجريبية (7 أقسام و18 موظفاً).

### حسابات تجريبية

| الحساب | اسم المستخدم | كلمة المرور |
|---|---|---|
| مدير النظام | `admin` | `admin123` |
| أي موظف (مثال: أحمد العلي) | `ahmad` | `123456` |

أسماء المستخدمين للموظفين التجريبيين: ahmad, sara, fatima, yousef, noura, khaled, maryam, abdullah, mohammad, reem, omar, hind, bader, latifa, jasem, dana, salman, hessa.

> **مهم:** غيّر كلمات المرور فور الدخول، واحذف أو عدّل البيانات التجريبية من لوحة الإدارة واستبدلها بموظفي الشركة الحقيقيين.

## الإعدادات (متغيرات البيئة)

| المتغير | الوصف | الافتراضي |
|---|---|---|
| `PORT` | منفذ الخادم | `3000` |
| `COMPANY_NAME` | اسم الشركة الظاهر في الموقع | `شركتنا` |
| `SESSION_SECRET` | مفتاح تشفير جلسات الدخول (ضعه في الإنتاج) | عشوائي عند كل تشغيل |
| `DB_PATH` | مسار ملف قاعدة البيانات | `data/company.db` |
| `NODE_ENV` | ضعه `production` لتفعيل الكوكيز الآمنة (HTTPS) | — |
| `TZ` | المنطقة الزمنية للشركة (التحية، «اليوم») | `Asia/Kuwait` |
| `ANTHROPIC_API_KEY`, `ATLAS_MODEL` | المستشار (Claude) | — / `claude-opus-5-5` |
| `MAKE_WEBHOOK_URL` | Webhook افتراضي يستقبل كل الأحداث | — |
| `MAKE_API_TOKEN`, `MAKE_ZONE`, `MAKE_TEAM_ID` | عرض وتشغيل سيناريوهات Make | — |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_NOTIFY` | واتساب | — |

متغيرات الربط اختيارية: يمكن ضبطها من صفحة **الأتمتة** داخل Atlas، ومتغير البيئة يتقدّم دائماً على القيمة المحفوظة.

مثال:

```bash
COMPANY_NAME="اسم شركتك" SESSION_SECRET="نص-طويل-عشوائي" npm start
```

## النشر على الإنترنت

### Render (الأسهل)

المستودع يحتوي على ملف `render.yaml` يجهّز كل شيء تلقائياً:

1. ادخل إلى https://dashboard.render.com وسجّل بحساب GitHub.
2. اختر **New → Blueprint** ثم اختر مستودع `platinumgatec-22/company` والفرع الذي فيه الموقع.
3. اكتب اسم الشركة في خانة `COMPANY_NAME` ثم اضغط **Apply**.
4. بعد انتهاء البناء يعطيك Render رابطاً مثل `https://company-portal.onrender.com`.
5. ادخل بحساب `admin` / `admin123`، وغيّر كلمة المرور فوراً.

الخطة المستخدمة `starter` مدفوعة (حوالي 7$ شهرياً + القرص)، لأن قاعدة البيانات تحتاج قرصاً دائماً (`/var/data`). الخطة المجانية تحذف البيانات عند كل إعادة تشغيل.

`SESSION_SECRET` يُنشأ تلقائياً. ويمكن ربط نطاق خاص من إعدادات الخدمة في Render (Custom Domains).

### Docker (أي خادم)

```bash
docker build -t company-portal .
docker run -d -p 3000:3000 -v company-data:/data \
  -e SESSION_SECRET="نص-طويل-عشوائي" -e COMPANY_NAME="اسم شركتك" company-portal
```

> يجب أن يكون الموقع خلف HTTPS في الإنتاج، لأن `NODE_ENV=production` يجعل كوكيز الدخول آمنة (Secure).

## هيكل المشروع

```
src/server.js            المسارات والصلاحيات
src/db.js                قاعدة البيانات والجداول
src/seed.js              البيانات التجريبية (npm run seed)
src/atlas/routes.js      صفحات Atlas + JSON + webhooks + REST API
src/atlas/service.js     منطق المهام والعملاء والملاحظات (مشترك بين الواجهة والـ API والمستشار)
src/atlas/strategist.js  وكيل Claude والاقتراحات
src/atlas/events.js      سجل النشاط وإرسال الأحداث إلى Make
src/atlas/whatsapp.js    WhatsApp Cloud API
src/atlas/make.js        Make API (السيناريوهات)
views/atlas/             صفحات Atlas
public/js/               المدار، الكانبان، اللوحة، المستشار
public/css/              التصميم
```
