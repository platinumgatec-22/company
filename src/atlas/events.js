// One place every change goes through: it is written to the activity log and
// pushed to Make (and any other webhook) so scenarios can react to it.
const crypto = require('node:crypto');
const db = require('../db');
const settings = require('./settings');

const EVENTS = [
  'task.created', 'task.updated', 'task.status_changed', 'task.deleted',
  'client.created', 'client.updated', 'client.stage_changed', 'interaction.created',
  'whatsapp.received', 'whatsapp.sent', 'note.created', 'proposal.approved', 'employee.created', 'atlas.test',
];

const insertActivity = db.prepare(`INSERT INTO activity (event, message, actor, employee_id, link)
  VALUES (?, ?, ?, ?, ?)`);
const insertDelivery = db.prepare(`INSERT INTO webhook_deliveries (webhook_id, target, event, status, error)
  VALUES (?, ?, ?, ?, ?)`);
const trimDeliveries = db.prepare(`DELETE FROM webhook_deliveries
  WHERE id <= (SELECT id FROM webhook_deliveries ORDER BY id DESC LIMIT 1 OFFSET 500)`);

function targetsFor(event) {
  const hooks = db.prepare('SELECT * FROM webhooks WHERE is_active = 1').all()
    .filter((h) => h.events.split(',').map((e) => e.trim()).some((e) => e === '*' || e === event));
  const fallback = settings.get('make_webhook_url');
  if (fallback && !hooks.some((h) => h.url === fallback)) hooks.push({ id: null, url: fallback, secret: '' });
  return hooks;
}

async function deliver(hook, event, body) {
  const headers = { 'content-type': 'application/json', 'x-atlas-event': event };
  if (hook.secret) {
    headers['x-atlas-signature'] = `sha256=${crypto.createHmac('sha256', hook.secret).update(body).digest('hex')}`;
  }
  let status = 0;
  let error = '';
  try {
    const res = await fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
    status = res.status;
    if (!res.ok) error = (await res.text()).slice(0, 300);
  } catch (err) {
    error = err.message;
  }
  insertDelivery.run(hook.id, hook.url, event, status, error);
  trimDeliveries.run();
  return { status, error };
}

/**
 * emit('task.created', { message, actor, link, data })
 * Never throws: webhook delivery runs in the background.
 */
function emit(event, { message, actor = null, link = '', data = {} } = {}) {
  // Only in-app links: anything else (e.g. javascript:) could come from an API caller.
  const safeLink = /^\/(?![/\\])/.test(link) ? link : '';
  if (message) insertActivity.run(event, message, actor?.full_name || actor?.name || 'Atlas', actor?.id || null, safeLink);
  const body = JSON.stringify({ event, at: new Date().toISOString(), actor: actor ? { id: actor.id, name: actor.full_name } : null, data });
  const hooks = targetsFor(event);
  return Promise.all(hooks.map((h) => deliver(h, event, body))).catch((err) => console.error('webhook', err));
}

module.exports = { emit, deliver, EVENTS };
