const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'company.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    icon        TEXT NOT NULL DEFAULT '🏢',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS employees (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name            TEXT NOT NULL,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,
    email                TEXT NOT NULL DEFAULT '',
    phone                TEXT NOT NULL DEFAULT '',
    job_title            TEXT NOT NULL DEFAULT '',
    department_id        INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    is_manager           INTEGER NOT NULL DEFAULT 0,
    role                 TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
    hire_date            TEXT NOT NULL DEFAULT '',
    bio                  TEXT NOT NULL DEFAULT '',
    is_active            INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    created_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department_id);

  -- ---------- Atlas ----------
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS clients (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    company    TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    stage      TEXT NOT NULL DEFAULT 'lead'
               CHECK (stage IN ('lead', 'contacted', 'proposal', 'won', 'lost')),
    value      REAL NOT NULL DEFAULT 0,
    source     TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    owner_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'note',
    body        TEXT NOT NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'review', 'done')),
    priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    due_date      TEXT NOT NULL DEFAULT '',
    owner_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    created_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    position      REAL NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS canvases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    owner_id   INTEGER REFERENCES employees(id) ON DELETE CASCADE, -- NULL = shared with everyone
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS canvas_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id  INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'text', 'task', 'section')),
    text       TEXT NOT NULL DEFAULT '',
    x          REAL NOT NULL DEFAULT 0,
    y          REAL NOT NULL DEFAULT 0,
    w          REAL NOT NULL DEFAULT 220,
    h          REAL NOT NULL DEFAULT 140,
    color      TEXT NOT NULL DEFAULT 'teal',
    task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS canvas_links (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    from_id   INTEGER NOT NULL REFERENCES canvas_items(id) ON DELETE CASCADE,
    to_id     INTEGER NOT NULL REFERENCES canvas_items(id) ON DELETE CASCADE,
    UNIQUE (from_id, to_id)
  );

  CREATE TABLE IF NOT EXISTS wa_conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    phone           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL DEFAULT '',
    client_id       INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    unread          INTEGER NOT NULL DEFAULT 0,
    last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS wa_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    body            TEXT NOT NULL,
    wa_id           TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT '',
    sender_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event       TEXT NOT NULL,
    message     TEXT NOT NULL,
    actor       TEXT NOT NULL DEFAULT '',
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    link        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Outbound webhooks (Make scenarios with a "Custom webhook" trigger).
  CREATE TABLE IF NOT EXISTS webhooks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    url        TEXT NOT NULL,
    events     TEXT NOT NULL DEFAULT '*',
    secret     TEXT NOT NULL DEFAULT '',
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER REFERENCES webhooks(id) ON DELETE CASCADE,
    target     TEXT NOT NULL DEFAULT '',
    event      TEXT NOT NULL,
    status     INTEGER NOT NULL DEFAULT 0,
    error      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Inbound REST API keys (for Make HTTP modules); only the SHA-256 is stored.
  CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,
    created_by   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    last_used_at TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- The Strategist: append-only conversation per employee, plus actions waiting for a yes.
  CREATE TABLE IF NOT EXISTS agent_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    thread      INTEGER NOT NULL DEFAULT 1,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    summary     TEXT NOT NULL,
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'failed')),
    result      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
  CREATE INDEX IF NOT EXISTS idx_items_canvas ON canvas_items(canvas_id);
  CREATE INDEX IF NOT EXISTS idx_wa_messages_conv ON wa_messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_client ON interactions(client_id);
  CREATE INDEX IF NOT EXISTS idx_agent_messages ON agent_messages(employee_id, thread);
`);

// Columns added after the first release: add them to existing databases.
function addColumns(table, columns) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, def] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}

addColumns('employees', [
  // '' | owner | director | manager | designer | publisher (see src/workflow-core.js)
  ['workflow_role', "TEXT NOT NULL DEFAULT ''"],
  ['instagram_account', "TEXT NOT NULL DEFAULT ''"],
  ['buffer_user', "TEXT NOT NULL DEFAULT ''"],
  // Digital employee: the system does this employee's workflow steps automatically (src/agents.js).
  ['is_digital', 'INTEGER NOT NULL DEFAULT 0'],
  // Buffer channel (profile) id of the employee's Instagram, used by the Make/Buffer scenario.
  ['buffer_profile_id', "TEXT NOT NULL DEFAULT ''"],
  // Private link (/connect/<token>) used to connect the employee's Instagram + Buffer accounts.
  ['connect_token', "TEXT NOT NULL DEFAULT ''"],
  ['connected_at', "TEXT NOT NULL DEFAULT ''"],
  // Prefixes (before " - ") of this digital employee's scenarios in Make, separated by "|".
  ['make_names', "TEXT NOT NULL DEFAULT ''"],
]);

// Small key/value store for one-time migrations.
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

db.exec(`
  -- Each publisher has their own Instagram account and Buffer user.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_instagram
    ON employees(instagram_account COLLATE NOCASE) WHERE instagram_account <> '';
  CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_buffer
    ON employees(buffer_user COLLATE NOCASE) WHERE buffer_user <> '';

  CREATE TABLE IF NOT EXISTS publish_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    brief         TEXT NOT NULL DEFAULT '',
    due_date      TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'to_director',
    created_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    design_url    TEXT NOT NULL DEFAULT '',
    caption       TEXT NOT NULL DEFAULT '',
    designed_by   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    report_text   TEXT NOT NULL DEFAULT '',
    reported_at   TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS publish_assignments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id        INTEGER NOT NULL REFERENCES publish_requests(id) ON DELETE CASCADE,
    employee_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    -- Snapshot of the accounts used, so reports stay correct if the employee changes later.
    employee_name     TEXT NOT NULL,
    instagram_account TEXT NOT NULL DEFAULT '',
    buffer_user       TEXT NOT NULL DEFAULT '',
    post_url          TEXT NOT NULL DEFAULT '',
    published_at      TEXT NOT NULL DEFAULT '',
    UNIQUE (request_id, employee_id)
  );

  -- Hand-off messages posted to the groups (managers / elite designs) for each request.
  CREATE TABLE IF NOT EXISTS workflow_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id  INTEGER NOT NULL REFERENCES publish_requests(id) ON DELETE CASCADE,
    group_key   TEXT NOT NULL DEFAULT '',
    from_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    from_name   TEXT NOT NULL DEFAULT '',
    to_label    TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_assignments_request ON publish_assignments(request_id);
  CREATE INDEX IF NOT EXISTS idx_assignments_employee ON publish_assignments(employee_id);
  CREATE INDEX IF NOT EXISTS idx_messages_request ON workflow_messages(request_id);
  CREATE INDEX IF NOT EXISTS idx_messages_group ON workflow_messages(group_key);
`);

addColumns('publish_requests', [
  // When a digital designer asked the external design service (webhook) for the design.
  ['design_requested_at', "TEXT NOT NULL DEFAULT ''"],
]);
addColumns('publish_assignments', [
  // When a digital publisher handed the post to Buffer (webhook).
  ['requested_at', "TEXT NOT NULL DEFAULT ''"],
  ['buffer_profile_id', "TEXT NOT NULL DEFAULT ''"],
]);

// Data of the integrated apps (tournaments dashboard, invoices): document collections
// like the Claude artifact database they were built on, plus uploaded files.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_docs (
    app         TEXT NOT NULL,
    col         TEXT NOT NULL,
    id          TEXT NOT NULL,
    data        TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (app, col, id)
  );

  -- One counter per app, bumped on every write, so pages can poll cheaply for changes.
  CREATE TABLE IF NOT EXISTS app_revs (
    app  TEXT PRIMARY KEY,
    rev  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS app_blobs (
    id          TEXT PRIMARY KEY,
    app         TEXT NOT NULL,
    type        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    data        BLOB NOT NULL,
    created_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
