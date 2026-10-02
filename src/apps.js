// The integrated apps (built first as Claude artifacts): tournaments dashboard, invoices and the
// decisions portal. Their pages are served as-is from /apps/*.html with public/js/claude-runtime.js
// injected, which answers their window.claude calls with the API below.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const db = require('./db');

const APPS = {
  tournaments: {
    file: 'tournaments.html', icon: '🏆', title: 'لوحة البطولات',
    description: 'البطولات والفرق والتسجيل والمباريات والنتائج والمالية والرعاة.',
  },
  invoices: {
    file: 'invoices.html', icon: '🧾', title: 'نظام الفواتير',
    description: 'إنشاء الفواتير ووصولات الاشتراك وتصديرها PDF، وبيانات الشركة.',
  },
  decisions: {
    file: 'decisions.html', icon: '✅', title: 'بوابة القرارات',
    description: 'موافقاتك ومهام المديرين والموظفين الرقميين وتقارير لؤلؤ من Make.',
    mcp: true,
  },
};

const MAX_BLOB = 20 * 1024 * 1024;
const BLOB_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const COL_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const q = {
  rev: db.prepare('SELECT rev FROM app_revs WHERE app = ?'),
  bump: db.prepare(`INSERT INTO app_revs (app, rev) VALUES (?, 1)
                    ON CONFLICT(app) DO UPDATE SET rev = rev + 1 RETURNING rev`),
  docs: db.prepare('SELECT col, id, data FROM app_docs WHERE app = ? ORDER BY col, rowid'),
  doc: db.prepare('SELECT data FROM app_docs WHERE app = ? AND col = ? AND id = ?'),
  put: db.prepare(`INSERT INTO app_docs (app, col, id, data) VALUES (?, ?, ?, ?)
                   ON CONFLICT(app, col, id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  del: db.prepare('DELETE FROM app_docs WHERE app = ? AND col = ? AND id = ?'),
  blob: db.prepare('SELECT type, data FROM app_blobs WHERE id = ?'),
  addBlob: db.prepare('INSERT INTO app_blobs (id, app, type, size, data, created_by) VALUES (?, ?, ?, ?, ?, ?)'),
};

const newId = () => crypto.randomBytes(12).toString('base64url');
const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// ---------- Make (MCP) for the decisions portal ----------
// Either MAKE_MCP_URL (the full Make MCP server address), or MAKE_ZONE (e.g. eu1.make.com) +
// MAKE_MCP_TOKEN, from which the known Make MCP addresses are tried in order.
const MAKE_MCP_URL = process.env.MAKE_MCP_URL || '';
const MAKE_MCP_TOKEN = process.env.MAKE_MCP_TOKEN || '';
const MAKE_ZONE = (process.env.MAKE_ZONE || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const makeConfigured = Boolean(MAKE_MCP_URL || (MAKE_ZONE && MAKE_MCP_TOKEN));
let mcpClient = null;
let workingTarget = null;

function makeTargets() {
  if (MAKE_MCP_URL) {
    const auth = MAKE_MCP_TOKEN ? { Authorization: `Bearer ${MAKE_MCP_TOKEN}` } : undefined;
    return [['stream', MAKE_MCP_URL, auth], ['sse', MAKE_MCP_URL, auth]];
  }
  const t = encodeURIComponent(MAKE_MCP_TOKEN);
  const base = `https://${MAKE_ZONE}/mcp`;
  return [
    ['stream', `${base}/u/${t}/stateless`],
    ['stream', `${base}/u/${t}/stream`],
    ['sse', `${base}/u/${t}/sse`],
    ['sse', `${base}/api/v1/u/${t}/sse`],
    ['stream', `${base}/stateless`, { Authorization: `Bearer ${MAKE_MCP_TOKEN}` }],
  ];
}

// For logs: never print the token.
const redact = (url) => (MAKE_MCP_TOKEN ? url.split(encodeURIComponent(MAKE_MCP_TOKEN)).join('<token>') : url);

async function makeClient() {
  if (mcpClient) return mcpClient;
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
  const targets = workingTarget ? [workingTarget] : makeTargets();
  let lastErr;
  for (const target of targets) {
    const [kind, url, headers] = target;
    const Transport = kind === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport;
    const client = new Client({ name: 'company-portal', version: '1.0.0' });
    try {
      await client.connect(new Transport(new URL(url), { requestInit: headers ? { headers } : undefined }));
      client.onclose = () => { mcpClient = null; };
      workingTarget = target;
      mcpClient = client;
      return client;
    } catch (err) {
      lastErr = err;
      console.error(`Make MCP: ${kind} ${redact(url)} failed: ${err.message}`);
    }
  }
  throw lastErr || new Error('Make MCP is not configured');
}

// Scenarios of the Make team, cached for a few minutes (shown on digital employees' profiles).
const MAKE_TEAM_ID = Number(process.env.MAKE_TEAM_ID) || 2966345;
let scenarioCache = { at: 0, list: null };

async function makeScenarios() {
  if (!makeConfigured) return null;
  if (scenarioCache.list && Date.now() - scenarioCache.at < 5 * 60 * 1000) return scenarioCache.list;
  const result = await (await makeClient()).callTool({ name: 'scenarios_list', arguments: { teamId: MAKE_TEAM_ID } }, undefined, { timeout: 30000 });
  const payload = payloadOf(result);
  const list = (Array.isArray(payload) ? payload : payload?.scenarios || []).map((s) => ({
    id: s.id, name: String(s.name || ''), active: Boolean(s.isActive), paused: Boolean(s.isPaused),
    executions: s.executions ?? 0, errors: s.errors ?? 0, nextExec: s.nextExec || null,
    url: MAKE_ZONE ? `https://${MAKE_ZONE}/${MAKE_TEAM_ID}/scenarios/${s.id}/edit` : '',
  }));
  scenarioCache = { at: Date.now(), list };
  return list;
}

// The scenarios of one digital employee: those whose name starts with one of their prefixes.
async function scenariosFor(makeNames) {
  const prefixes = String(makeNames || '').split('|').map((p) => p.trim()).filter(Boolean);
  if (!prefixes.length) return null;
  const all = await makeScenarios();
  return all && all.filter((s) => prefixes.includes(s.name.split(' - ')[0].trim()));
}

// Logs at startup whether the decisions portal can reach Make.
async function checkMake() {
  if (!makeConfigured) return;
  try {
    const { tools } = await (await makeClient()).listTools();
    const needed = ['scenarios_run', 'scenarios_list', 'data-store-records_list', 'executions_list'];
    const missing = needed.filter((n) => !tools.some((t) => t.name === n));
    console.log(`Make MCP: connected via ${workingTarget[0]} ${redact(workingTarget[1])} (${tools.length} tools${missing.length ? `, missing: ${missing.join(', ')}` : ''})`);
  } catch (err) {
    console.error(`Make MCP: could not connect: ${err.message}`);
  }
}

// Tool results come back as text blocks holding JSON; the pages expect the parsed value.
function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(text); } catch { return text; }
}

function createAppRoutes({ requireAuth }) {
  const router = express.Router();

  // Owner-level tools: the system admin and the request owner.
  const canUse = (user) => user.role === 'admin' || user.workflow_role === 'owner';
  const guard = (req, res, next) => {
    if (!canUse(req.user)) {
      if (req.originalUrl.includes('/api/')) return res.status(403).json({ code: 'not_granted', message: 'غير مصرح' });
      return res.status(403).render('error', { title: 'غير مصرح', message: 'هذه الأنظمة متاحة لمدير النظام فقط.' });
    }
    next();
  };
  const loadApp = (req, res, next) => {
    const app = APPS[req.params.app];
    if (!app) return res.status(404).render('error', { title: 'غير موجود', message: 'النظام غير موجود.' });
    req.app_ = { key: req.params.app, ...app };
    next();
  };

  router.get('/apps', requireAuth, guard, (req, res) => {
    res.render('apps/index', { title: 'الأنظمة', apps: APPS });
  });

  // The page inside the portal frame (header + full-height app).
  router.get('/apps/:app', requireAuth, guard, loadApp, (req, res) => {
    res.render('apps/frame', {
      title: req.app_.title, app: req.app_,
      mcpMissing: req.app_.mcp && !makeConfigured,
    });
  });

  // The app's own HTML with the runtime injected.
  const pages = {};
  router.get('/apps/:app/page', requireAuth, guard, loadApp, (req, res) => {
    const { key, file } = req.app_;
    if (!pages[key]) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'apps', file), 'utf8');
      const tag = `<script src="/js/claude-runtime.js" data-app="${key}"></script>`;
      pages[key] = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
    }
    res.set('Cache-Control', 'no-store').type('html').send(pages[key]);
  });

  // ---------- API used by claude-runtime.js ----------
  const api = express.Router({ mergeParams: true });
  api.use((req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 'not_granted', message: 'سجّل الدخول من جديد.' });
    next();
  }, guard, loadApp);

  api.get('/config', (req, res) => {
    res.json({ user: req.user.full_name, canWrite: true, mcp: Boolean(req.app_.mcp && makeConfigured) });
  });

  // All collections of the app in one response; `same` when nothing changed since `rev`.
  api.get('/db', (req, res) => {
    const rev = q.rev.get(req.app_.key)?.rev ?? 0;
    if (String(rev) === String(req.query.rev)) return res.json({ rev, same: true });
    const cols = {};
    for (const d of q.docs.all(req.app_.key)) (cols[d.col] ||= []).push({ id: d.id, data: JSON.parse(d.data) });
    res.json({ rev, cols });
  });

  const write = (req, res, fn) => {
    const { col } = req.params;
    if (!COL_RE.test(col) || (req.params.id && !ID_RE.test(req.params.id))) {
      return res.status(400).json({ code: 'invalid_argument', message: 'اسم غير صالح' });
    }
    const result = fn(req.app_.key, col);
    if (result?.error) return res.status(result.status || 400).json(result.error);
    q.bump.get(req.app_.key);
    res.json(result || { ok: true });
  };
  const body = (req) => (isPlainObject(req.body) ? req.body : null);
  const invalid = { error: { code: 'invalid_argument', message: 'بيانات غير صالحة' } };

  api.post('/db/:col', express.json({ limit: '1mb' }), (req, res) => write(req, res, (app, col) => {
    if (!body(req)) return invalid;
    const id = newId();
    q.put.run(app, col, id, JSON.stringify(req.body));
    return { id };
  }));

  api.put('/db/:col/:id', express.json({ limit: '1mb' }), (req, res) => write(req, res, (app, col) => {
    if (!body(req)) return invalid;
    q.put.run(app, col, req.params.id, JSON.stringify(req.body));
  }));

  api.patch('/db/:col/:id', express.json({ limit: '1mb' }), (req, res) => write(req, res, (app, col) => {
    if (!body(req)) return invalid;
    const current = q.doc.get(app, col, req.params.id);
    if (!current) return { status: 404, error: { code: 'not_found', message: 'غير موجود' } };
    q.put.run(app, col, req.params.id, JSON.stringify({ ...JSON.parse(current.data), ...req.body }));
  }));

  api.delete('/db/:col/:id', (req, res) => write(req, res, (app, col) => {
    q.del.run(app, col, req.params.id);
  }));

  api.post('/blobs', express.raw({ type: () => true, limit: MAX_BLOB }), (req, res) => {
    const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!BLOB_TYPES.includes(type)) return res.status(400).json({ code: 'unsupported_type', message: 'نوع الملف غير مدعوم' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ code: 'invalid_argument', message: 'ملف فارغ' });
    const id = newId();
    q.addBlob.run(id, req.app_.key, type, req.body.length, req.body, req.user.id);
    res.json({ id });
  });

  api.post('/mcp', express.json({ limit: '256kb' }), async (req, res) => {
    if (!req.app_.mcp || !makeConfigured) return res.status(503).json({ code: 'server_not_connected', message: 'Make غير مربوط بالموقع.' });
    const { tool, args } = req.body || {};
    if (typeof tool !== 'string' || !/^[\w-]{1,80}$/.test(tool)) return res.status(400).json({ code: 'invalid_argument', message: 'أداة غير صالحة' });
    try {
      const client = await makeClient();
      const result = await client.callTool({ name: tool, arguments: isPlainObject(args) ? args : {} }, undefined, { timeout: 120000 });
      const payload = payloadOf(result);
      if (result.isError) return res.status(422).json({ code: 'tool_error', message: typeof payload === 'string' ? payload : JSON.stringify(payload) });
      res.json({ payload });
    } catch (err) {
      mcpClient = null;
      console.error(`Make MCP (${tool}): ${err.message}`);
      res.status(502).json({ code: 'server_unavailable', message: err.message });
    }
  });

  router.use('/apps/:app/api', api);

  // Uploaded files (the tournaments page links them as /_blob/<id>).
  router.get('/_blob/:id', requireAuth, guard, (req, res) => {
    const blob = ID_RE.test(req.params.id) ? q.blob.get(req.params.id) : null;
    if (!blob) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(blob.type).send(Buffer.from(blob.data));
  });

  return router;
}

module.exports = { createAppRoutes, checkMake, scenariosFor, APPS };
