// WhatsApp Cloud API (Meta): send text messages and store the thread.
const crypto = require('node:crypto');
const db = require('../db');
const settings = require('./settings');

const GRAPH = 'https://graph.facebook.com/v21.0';

const digits = (phone) => String(phone || '').replace(/\D/g, '');

function findClientByPhone(phone) {
  const d = digits(phone);
  if (d.length < 6) return null;
  // Match on the last 8 digits so "+965 5123 4567" and "96551234567" are the same person.
  return db.prepare(`SELECT * FROM clients WHERE phone != '' ORDER BY id`).all()
    .find((c) => digits(c.phone).endsWith(d.slice(-8))) || null;
}

function conversationFor(phone, name = '') {
  const d = digits(phone);
  let conv = db.prepare('SELECT * FROM wa_conversations WHERE phone = ?').get(d);
  if (!conv) {
    const client = findClientByPhone(d);
    const id = db.prepare('INSERT INTO wa_conversations (phone, name, client_id) VALUES (?, ?, ?)')
      .run(d, name || client?.name || '', client?.id || null).lastInsertRowid;
    conv = db.prepare('SELECT * FROM wa_conversations WHERE id = ?').get(id);
  } else if (name && !conv.name) {
    db.prepare('UPDATE wa_conversations SET name = ? WHERE id = ?').run(name, conv.id);
  }
  return conv;
}

function storeMessage(conv, direction, body, { waId = '', status = '', senderId = null } = {}) {
  db.prepare(`INSERT INTO wa_messages (conversation_id, direction, body, wa_id, status, sender_id)
              VALUES (?, ?, ?, ?, ?, ?)`).run(conv.id, direction, body, waId, status, senderId);
  db.prepare(`UPDATE wa_conversations SET last_message_at = datetime('now'),
              unread = CASE WHEN ? = 'in' THEN unread + 1 ELSE unread END WHERE id = ?`).run(direction, conv.id);
}

/** Sends a text message. Returns { ok, id, error }. Stores it in the inbox either way. */
async function sendText(to, text, { senderId = null, store = true } = {}) {
  const token = settings.get('whatsapp_token');
  const phoneId = settings.get('whatsapp_phone_id');
  const conv = store ? conversationFor(to) : null;
  if (!token || !phoneId) {
    if (conv) storeMessage(conv, 'out', text, { status: 'not_sent', senderId });
    return { ok: false, error: 'WhatsApp is not connected yet (token / phone ID missing).' };
  }
  try {
    const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text } }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = json.error?.message || `HTTP ${res.status}`;
      if (conv) storeMessage(conv, 'out', text, { status: 'failed', senderId });
      return { ok: false, error };
    }
    const id = json.messages?.[0]?.id || '';
    if (conv) storeMessage(conv, 'out', text, { waId: id, status: 'sent', senderId });
    return { ok: true, id, conversationId: conv?.id };
  } catch (err) {
    if (conv) storeMessage(conv, 'out', text, { status: 'failed', senderId });
    return { ok: false, error: err.message };
  }
}

function validSignature(rawBody, header) {
  const secret = settings.get('whatsapp_app_secret');
  if (!secret) return true; // not configured: accept (document this in README)
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extracts { from, name, text, id } for each inbound message in a webhook payload. */
function parseInbound(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const m of value.messages || []) {
        const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title
          || m.interactive?.list_reply?.title || (m.type ? `[${m.type}]` : '');
        out.push({ from: m.from, name: names[m.from] || '', text, id: m.id });
      }
      for (const s of value.statuses || []) {
        db.prepare('UPDATE wa_messages SET status = ? WHERE wa_id = ?').run(s.status, s.id);
      }
    }
  }
  return out;
}

module.exports = { sendText, conversationFor, storeMessage, parseInbound, validSignature, findClientByPhone, digits };
