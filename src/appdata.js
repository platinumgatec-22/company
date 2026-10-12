// Server-side access to the integrated apps' collections (/apps: tournaments, invoices, decisions),
// so the rest of the portal (e.g. the digital customer-service employee) can read and write the same
// records the apps show. Every write bumps the app's revision, so open app pages refresh on their next poll.
const crypto = require('node:crypto');
const db = require('./db');

const q = {
  list: db.prepare('SELECT id, data FROM app_docs WHERE app = ? AND col = ? ORDER BY rowid'),
  get: db.prepare('SELECT data FROM app_docs WHERE app = ? AND col = ? AND id = ?'),
  put: db.prepare(`INSERT INTO app_docs (app, col, id, data) VALUES (?, ?, ?, ?)
                   ON CONFLICT(app, col, id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`),
  bump: db.prepare(`INSERT INTO app_revs (app, rev) VALUES (?, 1)
                    ON CONFLICT(app) DO UPDATE SET rev = rev + 1 RETURNING rev`),
};

const newId = () => crypto.randomBytes(12).toString('base64url');

function list(app, col) {
  return q.list.all(app, col).map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
}

function get(app, col, id) {
  const row = q.get.get(app, col, id);
  return row ? { id, ...JSON.parse(row.data) } : null;
}

function put(app, col, id, data) {
  const { id: _ignored, ...rest } = data;
  q.put.run(app, col, id, JSON.stringify(rest));
  q.bump.get(app);
  return { id, ...rest };
}

const add = (app, col, data) => put(app, col, newId(), { ...data, createdAt: new Date().toISOString() });
const update = (app, col, id, patch) => {
  const current = get(app, col, id);
  return current ? put(app, col, id, { ...current, ...patch, updatedAt: new Date().toISOString() }) : null;
};

module.exports = { list, get, put, add, update };
