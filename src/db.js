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
`);

// Columns added after the first release: add them to existing databases.
const employeeColumns = new Set(db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name));
for (const [name, def] of [
  // '' | owner | director | manager | designer | publisher (see src/workflow.js)
  ['workflow_role', "TEXT NOT NULL DEFAULT ''"],
  ['instagram_account', "TEXT NOT NULL DEFAULT ''"],
  ['buffer_user', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (!employeeColumns.has(name)) db.exec(`ALTER TABLE employees ADD COLUMN ${name} ${def}`);
}

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

module.exports = db;
