// -----------------------------------------------------------------------------
// Audit trail for sensitive actions (refunds, status changes, staff, settings,
// invoice access). Records who did what, to what, and when.
// -----------------------------------------------------------------------------
const crypto = require('crypto');
const { db } = require('./db');

const MAX = 5000;

function log({ actor, actorId = '', role = '', action, target = '', targetId = '', meta = null, ip = '' }) {
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    at: new Date().toISOString(),
    actor: String(actor || 'system').slice(0, 120),
    actorId: String(actorId || '').slice(0, 40),
    role: String(role || '').slice(0, 20),
    action: String(action || '').slice(0, 60),
    target: String(target || '').slice(0, 40),
    targetId: String(targetId || '').slice(0, 60),
    ip: String(ip || '').slice(0, 60),
    meta: meta || null
  };
  db.audit.push(entry);
  if (db.audit.length > MAX) db.audit.splice(0, db.audit.length - MAX);
  return entry;
}

const list = ({ limit = 100, action = '', actor = '' } = {}) => db.audit
  .filter(e => (!action || e.action === action) && (!actor || e.actorId === actor))
  .slice(-Math.min(500, Math.max(1, Number(limit) || 100)))
  .reverse();

module.exports = { log, list };
