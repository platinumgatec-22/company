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

  -- ---------- CRM ----------
  CREATE TABLE IF NOT EXISTS crm_contacts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name  TEXT NOT NULL,
    company    TEXT NOT NULL DEFAULT '',
    job_title  TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'other',
    owner_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS crm_deals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    title            TEXT NOT NULL,
    contact_id       INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
    type             TEXT NOT NULL DEFAULT 'sponsorship',
    stage            TEXT NOT NULL DEFAULT 'lead',
    value            REAL NOT NULL DEFAULT 0,
    probability      INTEGER NOT NULL DEFAULT 10,
    close_date       TEXT NOT NULL DEFAULT '',
    owner_id         INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    source           TEXT NOT NULL DEFAULT 'other',
    lost_reason      TEXT NOT NULL DEFAULT '',
    stage_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at        TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS crm_activities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id    INTEGER REFERENCES crm_deals(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE CASCADE,
    author_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    kind       TEXT NOT NULL DEFAULT 'note',
    body       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON crm_deals(stage);
  CREATE INDEX IF NOT EXISTS idx_crm_activities_deal ON crm_activities(deal_id);
  CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON crm_activities(contact_id);
`);

module.exports = db;
