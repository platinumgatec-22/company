// Deal actions shared by the sales pages. Every change is written to the client's interactions
// (so it shows on the Atlas client page) and emitted to the Atlas activity log and Make webhooks.
const db = require('../db');
const svc = require('../atlas/service');
const { emit } = require('../atlas/events');
const m = require('./model');

const q = {
  deal: db.prepare(`
    SELECT d.*, c.name AS contact_name, c.company AS company, c.email AS contact_email,
           c.phone AS contact_phone, e.full_name AS owner_name
    FROM crm_deals d
    LEFT JOIN clients c ON c.id = d.client_id
    LEFT JOIN employees e ON e.id = d.owner_id
    WHERE d.id = ?`),
  log: db.prepare('INSERT INTO interactions (client_id, deal_id, kind, body, employee_id) VALUES (?, ?, ?, ?, ?)'),
  touchClient: db.prepare("UPDATE clients SET updated_at = datetime('now') WHERE id = ?"),
};

const getDeal = (id) => q.deal.get(id) || null;
const link = (deal) => `/crm/deals/${deal.id}`;

function log(deal, kind, body, actor) {
  if (!deal.client_id) return;
  q.log.run(deal.client_id, deal.id, kind, body, actor?.id || null);
  q.touchClient.run(deal.client_id);
}

// Atlas keeps a stage per client (lead → contacted → proposal → won). Moving a deal forward
// moves its client forward too, so both pipelines tell the same story; it never moves back.
const CLIENT_ORDER = ['lead', 'contacted', 'proposal', 'won'];
const CLIENT_STAGE_FOR = { lead: 'lead', contacted: 'contacted', proposal: 'proposal', negotiation: 'proposal', won: 'won' };
function advanceClient(deal, actor) {
  const target = CLIENT_STAGE_FOR[deal.stage];
  const client = deal.client_id && svc.getClient(deal.client_id);
  if (!target || !client || client.stage === 'lost') return;
  if (CLIENT_ORDER.indexOf(target) > CLIENT_ORDER.indexOf(client.stage)) svc.updateClient(client.id, { stage: target }, actor);
}

function stageEvent(deal) {
  if (deal.stage === 'won') return 'deal.won';
  if (deal.stage === 'lost') return 'deal.lost';
  return 'deal.stage_changed';
}

function moveStage(before, stage, actor, probability = m.stageMap[stage].probability) {
  if (before.stage === stage) return before;
  const closed = stage === 'won' || stage === 'lost';
  db.prepare(`UPDATE crm_deals SET stage = ?, probability = ?, stage_changed_at = datetime('now'),
              closed_at = CASE WHEN ? THEN datetime('now') ELSE '' END WHERE id = ?`)
    .run(stage, probability, closed ? 1 : 0, before.id);
  const deal = getDeal(before.id);
  log(deal, 'stage', `«${deal.title}»: من «${m.stageMap[before.stage].label}» إلى «${m.stageMap[stage].label}»`, actor);
  emit(stageEvent(deal), {
    message: stage === 'won' ? `🎉 فاز بصفقة «${deal.title}» (${m.moneyFull(deal.value)} د.ك)`
      : `نقل صفقة «${deal.title}» إلى ${m.stageMap[stage].label}`,
    actor, link: link(deal), data: { deal, from: before.stage, to: stage },
  });
  advanceClient(deal, actor);
  return deal;
}

const FIELDS = ['title', 'client_id', 'type', 'value', 'probability', 'close_date', 'owner_id', 'source', 'lost_reason'];

function createDeal(input, actor) {
  const closed = input.stage === 'won' || input.stage === 'lost';
  const id = Number(db.prepare(`INSERT INTO crm_deals (${FIELDS.join(', ')}, stage, closed_at)
                                VALUES (${FIELDS.map(() => '?').join(', ')}, ?, CASE WHEN ? THEN datetime('now') ELSE '' END)`)
    .run(...FIELDS.map((f) => input[f]), input.stage, closed ? 1 : 0).lastInsertRowid);
  const deal = getDeal(id);
  log(deal, 'stage', `صفقة جديدة «${deal.title}» في مرحلة «${m.stageMap[deal.stage].label}»`, actor);
  emit('deal.created', {
    message: `أضاف صفقة «${deal.title}» (${m.moneyFull(deal.value)} د.ك)`, actor, link: link(deal), data: { deal },
  });
  advanceClient(deal, actor);
  return deal;
}

function updateDeal(before, input, actor) {
  db.prepare(`UPDATE crm_deals SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...FIELDS.map((f) => input[f]), before.id);
  // The probability typed in the form wins over the new stage's default.
  if (before.stage !== input.stage) return moveStage({ ...before, ...input, stage: before.stage }, input.stage, actor, input.probability);
  const deal = getDeal(before.id);
  emit('deal.updated', { message: `عدّل صفقة «${deal.title}»`, actor, link: link(deal), data: { deal } });
  return deal;
}

function deleteDeal(deal, actor) {
  db.prepare('DELETE FROM crm_deals WHERE id = ?').run(deal.id);
  emit('deal.deleted', { message: `حذف صفقة «${deal.title}»`, actor, data: { deal, deleted: true } });
}

function addNote(deal, kind, body, actor) {
  log(deal, kind, body, actor);
  emit('interaction.created', {
    message: `سجّل ${m.kindMap[kind].label} على صفقة «${deal.title}»`, actor, link: link(deal),
    data: { deal, interaction: { kind, body } },
  });
}

module.exports = { getDeal, createDeal, updateDeal, moveStage, deleteDeal, addNote };
