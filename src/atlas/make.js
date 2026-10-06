// Make (make.com) API: list scenarios and run one on demand.
const settings = require('./settings');

function config() {
  const token = settings.get('make_api_token');
  const zone = (settings.get('make_zone') || 'eu1.make.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const teamId = settings.get('make_team_id');
  return { token, zone, teamId, ready: Boolean(token && teamId) };
}

async function call(path, options = {}) {
  const { token, zone } = config();
  const res = await fetch(`https://${zone}/api/v2${path}`, {
    ...options,
    headers: { authorization: `Token ${token}`, 'content-type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.detail || `Make API HTTP ${res.status}`);
  return json;
}

async function listScenarios() {
  const { teamId } = config();
  const json = await call(`/scenarios?teamId=${encodeURIComponent(teamId)}&pg[limit]=200`);
  return (json.scenarios || []).map((s) => ({
    id: s.id,
    name: s.name,
    active: Boolean(s.isActive),
    paused: Boolean(s.isPaused),
    scheduling: s.scheduling?.type || '',
    lastEdit: s.lastEdit || '',
  }));
}

async function runScenario(id, data = {}) {
  return call(`/scenarios/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    body: JSON.stringify({ data, responsive: false }),
  });
}

module.exports = { config, listScenarios, runScenario };
