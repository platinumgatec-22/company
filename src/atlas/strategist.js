// The Strategist: a Claude agent that reads the company and proposes actions.
// It never changes anything by itself — every write becomes a proposal that the
// employee approves or declines in the UI.
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db');
const settings = require('./settings');
const svc = require('./service');
const whatsapp = require('./whatsapp');
const { emit } = require('./events');

const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_STEPS = 8;

const SYSTEM = `You are THE STRATEGIST, the vice-CEO chair inside Atlas — the private operating system of this company.
You handle strategy, offers, market thinking, prioritisation, and what order to make decisions in.

How you work:
- Always answer in the language the employee writes in (usually Gulf Arabic). Be direct and concise; one clear recommendation beats a list of options. Say what it costs (time, money, people) when it matters.
- Ground every answer in the company's real data. Use the read tools (get_overview, search_tasks, search_clients, list_team, recent_activity) before giving advice about the company; never invent numbers, names or clients.
- You cannot change anything directly. To create or change a task, client, note or to send a WhatsApp message, call the matching propose_* tool. Each call creates a proposal the employee must approve; tell them what you proposed and that it waits for their yes.
- Only propose what the employee asked for or clearly agreed to. For WhatsApp messages to clients, propose the exact text.
- Dates are YYYY-MM-DD. get_overview returns today's date.`;

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const S = (description) => ({ type: 'string', description });
const I = (description) => ({ type: 'integer', description });

const TOOLS = [
  { name: 'get_overview', description: "Today's date and company-wide numbers: tasks by status, overdue, clients by stage, pipeline value, unread WhatsApp.", input_schema: obj({}) },
  {
    name: 'search_tasks',
    description: 'List tasks. All filters optional.',
    input_schema: obj({
      status: { type: 'string', enum: svc.TASK_STATUSES }, owner_id: I('Employee id'), client_id: I('Client id'), search: S('Text to search in title/description'),
    }),
  },
  {
    name: 'search_clients',
    description: 'List CRM clients. All filters optional.',
    input_schema: obj({ stage: { type: 'string', enum: svc.STAGES }, search: S('Name, company, phone or email') }),
  },
  { name: 'list_team', description: 'Departments and active employees with ids, titles and open task counts.', input_schema: obj({}) },
  { name: 'recent_activity', description: 'The latest events in the company (who did what).', input_schema: obj({ limit: I('1-50, default 20') }) },
  {
    name: 'propose_create_task',
    description: 'Propose a new task. Needs the employee approval before it is created.',
    input_schema: obj({
      title: S('Short task title'), description: S('Details'), owner_id: I('Employee id responsible'),
      due_date: S('YYYY-MM-DD'), priority: { type: 'string', enum: svc.PRIORITIES }, client_id: I('Related client id'),
      department_id: I('Department id'),
    }, ['title']),
  },
  {
    name: 'propose_update_task',
    description: 'Propose changing an existing task (status, owner, due date, priority...). Only include fields that change.',
    input_schema: obj({
      task_id: I('Task id'), title: S('New title'), status: { type: 'string', enum: svc.TASK_STATUSES },
      owner_id: I('Employee id'), due_date: S('YYYY-MM-DD'), priority: { type: 'string', enum: svc.PRIORITIES }, description: S('New description'),
    }, ['task_id']),
  },
  {
    name: 'propose_create_client',
    description: 'Propose adding a client/lead to the CRM.',
    input_schema: obj({
      name: S('Client name'), company: S('Company'), phone: S('Phone with country code'), email: S('Email'),
      stage: { type: 'string', enum: svc.STAGES }, value: { type: 'number', description: 'Expected deal value' }, notes: S('Notes'),
    }, ['name']),
  },
  {
    name: 'propose_update_client',
    description: 'Propose changing a client (stage, value, notes, owner). Only include fields that change.',
    input_schema: obj({
      client_id: I('Client id'), stage: { type: 'string', enum: svc.STAGES }, value: { type: 'number', description: 'Deal value' },
      notes: S('Replace notes'), owner_id: I('Employee id'),
    }, ['client_id']),
  },
  {
    name: 'propose_send_whatsapp',
    description: 'Propose sending a WhatsApp text message. Give the exact message text.',
    input_schema: obj({ to: S('Phone number with country code'), text: S('Exact message'), client_id: I('Related client id') }, ['to', 'text']),
  },
  {
    name: 'propose_create_note',
    description: 'Propose writing a note on the shared company canvas (ideas, plans, decisions).',
    input_schema: obj({ text: S('Note text'), color: { type: 'string', enum: svc.COLORS } }, ['text']),
  },
];

const PROPOSAL_KIND = {
  propose_create_task: 'create_task',
  propose_update_task: 'update_task',
  propose_create_client: 'create_client',
  propose_update_client: 'update_client',
  propose_send_whatsapp: 'send_whatsapp',
  propose_create_note: 'create_note',
};

function summarize(kind, p) {
  switch (kind) {
    case 'create_task': return `مهمة جديدة: ${p.title}${p.due_date ? ` (حتى ${p.due_date})` : ''}`;
    case 'update_task': {
      const t = svc.getTask(p.task_id);
      const changes = Object.keys(p).filter((k) => k !== 'task_id').join('، ');
      return `تعديل مهمة «${t?.title || `#${p.task_id}`}»: ${changes}`;
    }
    case 'create_client': return `عميل جديد: ${p.name}${p.company ? ` — ${p.company}` : ''}`;
    case 'update_client': {
      const c = svc.getClient(p.client_id);
      return `تعديل العميل «${c?.name || `#${p.client_id}`}»${p.stage ? ` → ${svc.STAGE_LABEL[p.stage]}` : ''}`;
    }
    case 'send_whatsapp': return `واتساب إلى ${p.to}: «${String(p.text).slice(0, 120)}»`;
    case 'create_note': return `ملاحظة على لوحة الشركة: ${String(p.text).slice(0, 120)}`;
    default: return kind;
  }
}

function runReadTool(name, input) {
  switch (name) {
    case 'get_overview': return svc.overview();
    case 'search_tasks':
      return svc.listTasks({ status: input.status || '', ownerId: input.owner_id, clientId: input.client_id, search: input.search || '', limit: 60 })
        .map(({ id, title, status, priority, due_date, owner_id, owner_name, client_id, client_name }) => ({ id, title, status, priority, due_date, owner_id, owner_name, client_id, client_name }));
    case 'search_clients':
      return svc.listClients({ stage: input.stage || '', search: input.search || '', limit: 60 })
        .map(({ id, name, company, phone, stage, value, owner_name, open_tasks, updated_at }) => ({ id, name, company, phone, stage, value, owner_name, open_tasks, updated_at }));
    case 'list_team':
      return {
        departments: db.prepare('SELECT id, name FROM departments ORDER BY id').all(),
        employees: db.prepare(`SELECT e.id, e.full_name, e.job_title, e.department_id, e.is_manager,
          (SELECT COUNT(*) FROM tasks t WHERE t.owner_id = e.id AND t.status != 'done') AS open_tasks
          FROM employees e WHERE e.is_active = 1 ORDER BY e.department_id, e.is_manager DESC`).all(),
      };
    case 'recent_activity':
      return svc.recentActivity(Math.min(50, Math.max(1, Number(input.limit) || 20)))
        .map(({ event, message, actor, created_at }) => ({ event, message, actor, created_at }));
    default: return null;
  }
}

function runTool(block, user) {
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  try {
    if (PROPOSAL_KIND[block.name]) {
      const kind = PROPOSAL_KIND[block.name];
      if (kind === 'update_task' && !svc.getTask(input.task_id)) throw new Error(`Task ${input.task_id} not found`);
      if (kind === 'update_client' && !svc.getClient(input.client_id)) throw new Error(`Client ${input.client_id} not found`);
      if (kind === 'send_whatsapp' && whatsapp.digits(input.to).length < 8) throw new Error('Invalid phone number');
      if (['create_task', 'create_client', 'create_note'].includes(kind) && !String(input.title || input.name || input.text || '').trim()) {
        throw new Error('Missing required text');
      }
      const r = db.prepare('INSERT INTO proposals (employee_id, kind, summary, payload) VALUES (?, ?, ?, ?)')
        .run(user.id, kind, summarize(kind, input), JSON.stringify(input));
      return { content: JSON.stringify({ proposal_id: Number(r.lastInsertRowid), status: 'waiting_for_employee_approval' }) };
    }
    const result = runReadTool(block.name, input);
    if (result === null) return { content: `Unknown tool ${block.name}`, is_error: true };
    return { content: JSON.stringify(result) };
  } catch (err) {
    return { content: err.message, is_error: true };
  }
}

async function executeProposal(proposal, user) {
  const p = JSON.parse(proposal.payload);
  switch (proposal.kind) {
    case 'create_task': return `/atlas/tasks/${svc.createTask(p, user).id}`;
    case 'update_task': { const { task_id: taskId, ...rest } = p; svc.updateTask(taskId, rest, user); return `/atlas/tasks/${taskId}`; }
    case 'create_client': return `/atlas/clients/${svc.createClient(p, user).id}`;
    case 'update_client': { const { client_id: clientId, ...rest } = p; svc.updateClient(clientId, rest, user); return `/atlas/clients/${clientId}`; }
    case 'send_whatsapp': {
      const r = await whatsapp.sendText(p.to, p.text, { senderId: user.id });
      if (!r.ok) throw new Error(r.error);
      emit('whatsapp.sent', { message: `أرسل واتساب إلى ${p.to}`, actor: user, link: `/atlas/inbox/${r.conversationId}`, data: { to: p.to, text: p.text } });
      return `/atlas/inbox/${r.conversationId}`;
    }
    case 'create_note': { const item = svc.createNote(p, user); return `/atlas/canvas/${item.canvas_id}`; }
    default: throw new Error('Unknown proposal');
  }
}

async function decide(proposalId, user, approve) {
  const proposal = db.prepare('SELECT * FROM proposals WHERE id = ? AND employee_id = ?').get(proposalId, user.id);
  if (!proposal || proposal.status !== 'pending') return null;
  if (!approve) {
    db.prepare("UPDATE proposals SET status = 'declined' WHERE id = ?").run(proposal.id);
    return { status: 'declined' };
  }
  try {
    const link = await executeProposal(proposal, user);
    db.prepare("UPDATE proposals SET status = 'approved', result = ? WHERE id = ?").run(link, proposal.id);
    emit('proposal.approved', { message: `وافق على اقتراح المستشار: ${proposal.summary}`, actor: user, link, data: { proposal } });
    return { status: 'approved', link };
  } catch (err) {
    db.prepare("UPDATE proposals SET status = 'failed', result = ? WHERE id = ?").run(err.message, proposal.id);
    return { status: 'failed', error: err.message };
  }
}

// ---------- conversation ----------
function currentThread(userId) {
  return db.prepare('SELECT COALESCE(MAX(thread), 1) AS t FROM agent_messages WHERE employee_id = ?').get(userId).t;
}

function newThread(userId) {
  const t = currentThread(userId) + 1;
  // Placeholder row so the new thread number sticks even before the first message.
  db.prepare("INSERT INTO agent_messages (employee_id, thread, role, content) VALUES (?, ?, 'user', '[]')").run(userId, t);
}

function history(userId) {
  return db.prepare('SELECT role, content FROM agent_messages WHERE employee_id = ? AND thread = ? ORDER BY id')
    .all(userId, currentThread(userId))
    .map((m) => ({ role: m.role, content: JSON.parse(m.content) }))
    .filter((m) => !(Array.isArray(m.content) && m.content.length === 0));
}

/** Visible transcript: employee texts and the agent's text answers only. */
function transcript(userId) {
  const out = [];
  for (const m of history(userId)) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
    if (text) out.push({ role: m.role, text });
  }
  return out;
}

const store = db.prepare('INSERT INTO agent_messages (employee_id, thread, role, content) VALUES (?, ?, ?, ?)');

async function ask(user, text) {
  const apiKey = settings.get('anthropic_api_key');
  if (!apiKey) throw new Error('The Strategist is not connected yet: add an Anthropic API key on the Automations page.');
  const client = new Anthropic({ apiKey });
  const model = settings.get('atlas_model') || DEFAULT_MODEL;
  const thread = currentThread(user.id);
  const messages = history(user.id);

  const userMsg = { role: 'user', content: [{ type: 'text', text: `[${user.full_name} — ${user.job_title || 'employee'}, id ${user.id}]\n${text}` }] };
  store.run(user.id, thread, 'user', JSON.stringify(userMsg.content));
  messages.push(userMsg);

  const replies = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        tools: TOOLS,
        messages,
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic API key is invalid.');
      if (err instanceof Anthropic.RateLimitError) throw new Error('Rate limited by the Anthropic API — try again in a minute.');
      if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status}: ${err.message}`);
      throw err;
    }

    const assistant = { role: 'assistant', content: response.content };
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
    if (text) replies.push(text);
    if (response.stop_reason === 'refusal') replies.push('عذراً، لا أستطيع المساعدة في هذا الطلب.');

    // Every tool_use must be answered, so store the assistant turn and its results together.
    const results = toolUses.map((b) => {
      const r = response.stop_reason === 'tool_use' ? runTool(b, user) : { content: 'Not run: response was cut off.', is_error: true };
      return { type: 'tool_result', tool_use_id: b.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) };
    });
    db.exec('BEGIN');
    try {
      store.run(user.id, thread, 'assistant', JSON.stringify(response.content));
      if (results.length) store.run(user.id, thread, 'user', JSON.stringify(results));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    messages.push(assistant);
    if (results.length) messages.push({ role: 'user', content: results });
    if (response.stop_reason !== 'tool_use') break;
  }
  return replies.join('\n\n');
}

function pendingProposals(userId) {
  return db.prepare("SELECT * FROM proposals WHERE employee_id = ? ORDER BY status = 'pending' DESC, id DESC LIMIT 30").all(userId);
}

module.exports = { ask, transcript, newThread, decide, pendingProposals, DEFAULT_MODEL };
