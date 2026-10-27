// -----------------------------------------------------------------------------
// Provider webhook processing.
//
// Guarantees:
//   * every event id is stored once -> retries and out-of-order deliveries are
//     safe and never create a second order, charge, invoice or refund;
//   * order state only moves through allowed transitions;
//   * paid status is only ever set here (or by a server-to-server provider
//     retrieval in reconcileOrder), never by a browser redirect.
// -----------------------------------------------------------------------------
const crypto = require('crypto');
const { db, save } = require('./db');
const orders = require('./orders');
const payments = require('./payments');
const invoices = require('./invoices');
const audit = require('./audit');

const byIntent = id => db.orders.find(o => o.paymentIntentId === id);

// Keep the local payment ledger in step with the provider. The admin payments
// view derives its rows from orders, but refunds, disputes and support all rely
// on this record matching what the provider actually did.
function syncPaymentRecord(intentId, status, extra = {}) {
  const rows = db.payments.filter(p => p.intentId === intentId);
  for (const r of rows) {
    r.status = status;
    r.updatedAt = new Date().toISOString();
    if (extra.lastError !== undefined && extra.lastError) r.lastError = String(extra.lastError).slice(0, 200);
    if (extra.amountCents !== undefined) r.amountCents = extra.amountCents;
    if (extra.refundedCents !== undefined) r.refundedCents = extra.refundedCents;
    if (extra.outcome !== undefined) r.outcome = extra.outcome;
  }
  return rows.length;
}

function notify(order, title, body, type = 'order') {
  const userId = order.userId;
  if (!userId) return;
  const u = db.users.find(x => x.id === userId);
  if (!u) return;
  u.notifications = u.notifications || [];
  u.notifications.unshift({ id: crypto.randomBytes(5).toString('hex'), at: new Date().toISOString(), type, title, body, orderId: order.id, read: false });
  u.notifications = u.notifications.slice(0, 100);
  db.notifications.push({ id: crypto.randomBytes(5).toString('hex'), at: new Date().toISOString(), userId, type, title, body, orderId: order.id });
}

let _sendMail = null;
const mail = (order, subject, text) => {
  try {
    _sendMail = _sendMail || require('./mail');
    _sendMail.send(order.customer?.email || order.email, subject, text);
  } catch { /* mail is optional; in-app notifications still recorded */ }
};

// Save a provider payment method to the owning account (explicit consent only)
async function saveCardFromIntent(intent, order) {
  if (!order || !order.userId || !order.savedCard) return;
  const u = db.users.find(x => x.id === order.userId);
  if (!u) return;
  let meta;
  try { meta = await payments.provider.retrievePaymentMethod(intent.payment_method); } catch { return; }
  if (!meta || !meta.id) return;
  u.paymentMethods = (u.paymentMethods || []).filter(p => p.id !== meta.id);
  u.paymentMethods.push({
    id: meta.id, brand: meta.brand, last4: meta.last4,
    expMonth: meta.expMonth, expYear: meta.expYear,
    sandbox: payments.sandboxMode, created: new Date().toISOString(),
    isDefault: u.paymentMethods.length === 0
  });
  if (!u.defaultPaymentMethodId) u.defaultPaymentMethodId = meta.id;
}

async function markPaid(order, intentId, actor = 'webhook') {
  if (['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) return false;
  order.paymentIntentId = intentId || order.paymentIntentId;
  if (!orders.canPayment(order.paymentStatus, 'paid')) {
    // e.g. an order cancelled before a late success event: record it for
    // reconciliation instead of silently flipping a cancelled order to paid
    order.reconcile = { at: new Date().toISOString(), note: `Late payment ${intentId} after status ${order.paymentStatus}` };
    audit.log({ actor, action: 'payment.late_success', target: 'order', targetId: order.id, meta: { intentId } });
    return false;
  }
  orders.applyPaymentStatus(order, 'paid', actor, `Payment confirmed by ${payments.MODE === 'stripe' ? 'Stripe' : 'sandbox provider'} (${intentId})`);
  syncPaymentRecord(intentId, 'succeeded', { amountCents: order.totalCents, outcome: 'paid' });
  order.lastPaymentError = '';
  order.requiresAction = false;
  orders.syncLegacy(order);
  const inv = await invoices.createInvoice(order, { actor });
  if (inv) {
    orders.addEvent(order, { type: 'invoice_created', label: 'Invoice ' + inv.number + ' issued', actor });
    order.invoiceNumber = inv.number;
  }
  notify(order, 'Payment received', `We received your payment for order ${order.number}.`);
  mail(order, `Payment received - ${order.number}`, `Thank you. Your payment for order ${order.number} was received. Your invoice is available in your account.`);
  audit.log({ actor, action: 'payment.paid', target: 'order', targetId: order.id, meta: { intentId, amountCents: order.totalCents } });
  return true;
}

async function applyRefundEvent(object, eventId) {
  const intentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
  const order = byIntent(intentId) || db.orders.find(o => o.paymentIntentId === object.payment_intent);
  if (!order) return;
  const refundId = String(object.id || eventId);
  const amount = Number.isFinite(object.amount) ? object.amount : Number(object.amount_refunded) || 0;

  let entry = (order.refunds || []).find(r => r.providerRefundId === refundId);
  if (!entry) {
    entry = { id: crypto.randomBytes(6).toString('hex'), providerRefundId: refundId, amountCents: amount, status: object.status || 'pending', date: new Date().toISOString(), source: 'webhook' };
    order.refunds.push(entry);
  } else {
    entry.status = object.status || entry.status;
    if (amount) entry.amountCents = amount;
  }
  const refunded = order.refunds.filter(r => r.status !== 'failed' && r.status !== 'canceled').reduce((a, r) => a + r.amountCents, 0);
  order.refundedCents = Math.min(order.totalCents, refunded);
  const intentForRefund = intentId || order.paymentIntentId;
  if (intentForRefund) syncPaymentRecord(intentForRefund, order.paymentStatus === 'refunded' ? 'refunded' : entry.status, { refundedCents: order.refundedCents });
  const target = order.refundedCents >= order.totalCents ? 'refunded' : order.refundedCents > 0 ? 'partially_refunded' : order.paymentStatus;
  if (target !== order.paymentStatus && orders.canPayment(order.paymentStatus, target)) {
    orders.applyPaymentStatus(order, target, 'webhook', `Refund ${refundId} ${entry.status}`);
    orders.syncLegacy(order);
  }
  notify(order, 'Refund update', `A refund of ${(entry.amountCents / 100).toFixed(2)} ${String(order.currency).toUpperCase()} on order ${order.number} is ${entry.status}.`);
  audit.log({ actor: 'webhook', action: 'payment.refund_event', target: 'order', targetId: order.id, meta: { refundId, amount, status: entry.status } });
}

// ---------------------------------------------------------------------------
// Main entry point. Returns { duplicate } for already-seen events.
// ---------------------------------------------------------------------------
async function processEvent(ev) {
  const id = payments.eventId(ev);
  if (db.webhookEvents.some(e => e.id === id)) return { duplicate: true, id };
  db.webhookEvents.push({ id, type: ev.type, receivedAt: new Date().toISOString(), processed: false });
  if (db.webhookEvents.length > 2000) db.webhookEvents.splice(0, db.webhookEvents.length - 2000);

  const obj = ev.data?.object || {};
  let outcome = 'ignored';

  switch (ev.type) {
    case 'payment_intent.succeeded': {
      const order = obj.metadata?.orderId ? db.orders.find(o => o.id === obj.metadata.orderId) : byIntent(obj.id);
      if (order) {
        order.paymentIntentId = obj.id;
        order.providerStatus = obj.status || 'succeeded';
        if (obj.payment_method) order.paymentMethodId = obj.payment_method;
        order.savedCard = obj.metadata?.saveCard === 'true';
        await saveCardFromIntent(obj, order);
        outcome = (await markPaid(order, obj.id)) ? 'order_paid' : 'already_paid';
      }
      break;
    }
    case 'payment_intent.processing': {
      const order = obj.metadata?.orderId ? db.orders.find(o => o.id === obj.metadata.orderId) : byIntent(obj.id);
      if (order && orders.canPayment(order.paymentStatus, 'processing')) {
        orders.applyPaymentStatus(order, 'processing', 'webhook', 'Provider is processing the payment');
        order.paymentIntentId = obj.id;
        syncPaymentRecord(obj.id, 'processing', { outcome: 'processing' });
        outcome = 'processing';
      }
      break;
    }
    case 'payment_intent.requires_action': {
      const order = obj.metadata?.orderId ? db.orders.find(o => o.id === obj.metadata.orderId) : byIntent(obj.id);
      if (order) order.requiresAction = true;
      outcome = 'requires_action';
      break;
    }
    case 'payment_intent.payment_failed': {
      const order = obj.metadata?.orderId ? db.orders.find(o => o.id === obj.metadata.orderId) : byIntent(obj.id);
      if (order) {
        order.lastPaymentError = String(obj.last_payment_error?.message || 'Payment failed').slice(0, 200);
        if (orders.canPayment(order.paymentStatus, 'failed')) {
          orders.applyPaymentStatus(order, 'failed', 'webhook', order.lastPaymentError);
        }
        syncPaymentRecord(obj.id, obj.status || 'requires_payment_method', { lastError: order.lastPaymentError, outcome: 'failed' });
        notify(order, 'Payment failed', `We could not process the payment for order ${order.number}. You can try again with another card.`);
        outcome = 'payment_failed';
      }
      break;
    }
    case 'payment_intent.canceled': {
      const order = obj.metadata?.orderId ? db.orders.find(o => o.id === obj.metadata.orderId) : byIntent(obj.id);
      if (order && orders.canPayment(order.paymentStatus, 'cancelled')) {
        orders.applyPaymentStatus(order, 'cancelled', 'webhook', 'Payment cancelled');
        if (order.fulfillmentStatus === 'unfulfilled') orders.releaseStock(order.lines.map(l => ({ id: l.id, qty: l.qty })));
        syncPaymentRecord(obj.id, obj.status || 'canceled', { outcome: 'cancelled' });
        outcome = 'cancelled';
      }
      break;
    }
    case 'refund.created':
    case 'refund.updated':
    case 'charge.refunded':
      await applyRefundEvent(obj, id);
      outcome = 'refund_updated';
      break;
    case 'setup_intent.succeeded': {
      const userId = obj.metadata?.userId;
      const u = db.users.find(x => x.id === userId);
      if (u && obj.payment_method) {
        try {
          const meta = await payments.provider.retrievePaymentMethod(obj.payment_method);
          u.paymentMethods = (u.paymentMethods || []).filter(p => p.id !== meta.id);
          u.paymentMethods.push({ id: meta.id, brand: meta.brand, last4: meta.last4, expMonth: meta.expMonth, expYear: meta.expYear, sandbox: payments.sandboxMode, created: new Date().toISOString(), isDefault: u.paymentMethods.length === 0 });
          if (!u.defaultPaymentMethodId) u.defaultPaymentMethodId = meta.id;
          outcome = 'card_saved';
        } catch { outcome = 'card_retrieval_failed'; }
      }
      break;
    }
    case 'payment_method.detached': {
      const pmId = obj.id;
      for (const u of db.users) {
        if ((u.paymentMethods || []).some(p => p.id === pmId)) {
          u.paymentMethods = u.paymentMethods.filter(p => p.id !== pmId);
          if (u.defaultPaymentMethodId === pmId) u.defaultPaymentMethodId = u.paymentMethods[0]?.id || '';
          outcome = 'card_detached';
        }
      }
      break;
    }
    default:
      break;
  }

  const rec = db.webhookEvents.find(e => e.id === id);
  if (rec) { rec.processed = true; rec.outcome = outcome; }
  save();
  return { duplicate: false, id, type: ev.type, outcome };
}

module.exports = { processEvent, notify, syncPaymentRecord };
