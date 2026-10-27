// -----------------------------------------------------------------------------
// Optional email delivery.
//
// The project has no mail provider configured. Instead of pretending to send
// messages, order notifications are always stored in-app and (when
// MAIL_WEBHOOK_URL is set) POSTed to that endpoint, which is expected to relay
// them through the business's email provider (Resend/Postmark/SES/etc).
// Set MAIL_WEBHOOK_TOKEN to add a bearer token.
// -----------------------------------------------------------------------------

const URL_ = process.env.MAIL_WEBHOOK_URL || '';
const TOKEN = process.env.MAIL_WEBHOOK_TOKEN || '';

const configured = () => !!URL_;

function send(to, subject, text, meta = {}) {
  if (!configured() || !to) return Promise.resolve({ skipped: true });
  return fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: JSON.stringify({ to, subject, text, from: process.env.MAIL_FROM || undefined, meta })
  }).then(r => ({ ok: r.ok, status: r.status })).catch(() => ({ ok: false }));
}

module.exports = { send, configured };
