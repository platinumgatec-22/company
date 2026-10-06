// Sends each workflow hand-off to an external webhook (e.g. a Make scenario) so it can be
// forwarded to the real WhatsApp/Telegram groups and scheduled on Buffer.
// Disabled unless WORKFLOW_WEBHOOK_URL is set. Failures are logged, never block the portal.
const WEBHOOK_URL = process.env.WORKFLOW_WEBHOOK_URL || '';

function notify(event, payload) {
  if (!WEBHOOK_URL) return;
  fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, sent_at: new Date().toISOString(), ...payload }),
    signal: AbortSignal.timeout(10000),
  })
    .then((res) => {
      if (!res.ok) console.error(`webhook ${event}: HTTP ${res.status}`);
    })
    .catch((err) => console.error(`webhook ${event}: ${err.message}`));
}

module.exports = { notify, webhookEnabled: Boolean(WEBHOOK_URL) };
