// Integration settings: an environment variable always wins, otherwise the value
// saved by an admin on the Automations page.
const db = require('../db');

const FIELDS = {
  whatsapp_token: { env: 'WHATSAPP_TOKEN', secret: true, label: 'WhatsApp Cloud API access token' },
  whatsapp_phone_id: { env: 'WHATSAPP_PHONE_ID', label: 'WhatsApp phone number ID' },
  whatsapp_verify_token: { env: 'WHATSAPP_VERIFY_TOKEN', label: 'Webhook verify token' },
  whatsapp_app_secret: { env: 'WHATSAPP_APP_SECRET', secret: true, label: 'Meta app secret (signature check)' },
  whatsapp_notify: { env: 'WHATSAPP_NOTIFY', label: 'Notify task owners on WhatsApp (1 = yes)' },
  make_webhook_url: { env: 'MAKE_WEBHOOK_URL', label: 'Default Make webhook URL (all events)' },
  make_api_token: { env: 'MAKE_API_TOKEN', secret: true, label: 'Make API token' },
  make_zone: { env: 'MAKE_ZONE', label: 'Make zone (e.g. eu1.make.com)' },
  make_team_id: { env: 'MAKE_TEAM_ID', label: 'Make team ID' },
  anthropic_api_key: { env: 'ANTHROPIC_API_KEY', secret: true, label: 'Anthropic API key (The Strategist)' },
  atlas_model: { env: 'ATLAS_MODEL', label: 'Claude model' },
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

function get(key) {
  const field = FIELDS[key];
  if (field && process.env[field.env]) return process.env[field.env];
  return getStmt.get(key)?.value || '';
}

function set(key, value) {
  setStmt.run(key, String(value ?? ''));
}

function fromEnv(key) {
  return Boolean(FIELDS[key] && process.env[FIELDS[key].env]);
}

function mask(value) {
  if (!value) return '';
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

const connected = {
  whatsapp: () => Boolean(get('whatsapp_token') && get('whatsapp_phone_id')),
  make: () => Boolean(get('make_webhook_url') || get('make_api_token')
    || db.prepare('SELECT 1 FROM webhooks WHERE is_active = 1 LIMIT 1').get()
    || db.prepare('SELECT 1 FROM api_keys LIMIT 1').get()),
  strategist: () => Boolean(get('anthropic_api_key')),
};

module.exports = { FIELDS, get, set, fromEnv, mask, connected };
